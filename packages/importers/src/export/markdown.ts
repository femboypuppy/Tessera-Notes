import {
  AbortError,
  extractAssetIds,
  extractLinks,
  getPageProps,
  listProperties,
  listRows,
  readDocJSON,
  resolveRows,
  throwIfAborted,
  toError,
  type DocHandle,
  type DocJSON,
  type ExportContext,
  type ExportProgress,
  type ExportResult,
  type ExportScope,
  type ExportSession,
  type ExportSessionResult,
  type ExportSink,
  type JsonValue,
  type PageMeta,
  type PageProps,
  type PagesSnapshot,
  type TransferIssue,
} from '@tessera/core';
import { createMarkdownCodec, encodePath } from '@tessera/markdown';
import { writeCsv } from '../csv';
import { formatCell } from './csv-values';
import { fileNameFor, NameAllocator, relativePath, splitExtension } from './names';

/** Options of the markdown export. */
export interface MarkdownExportOptions {
  /** `wikilink` (Obsidian, the default) or `markdown` (relative `[text](path.md)` links). */
  linkStyle?: 'wikilink' | 'markdown';
  /** Folder for attachments, relative to the export root. */
  attachmentsFolder?: string;
}

interface Item {
  page: PageMeta;
  /** Path without extension, relative to the export root. */
  path: string;
  /** File written for the page: `path.md`, or `path.csv` for databases. */
  file: string;
}

interface PageContent {
  doc: DocJSON;
  props: PageProps;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** Where the pages in scope go, and how links name them. */
interface Layout {
  items: Item[];
  byId: Map<string, Item>;
  /** A page's name in wikilinks: its name when unique in the export, else its path. */
  wikiTarget(item: Item): string;
}

function layoutOf(scope: ExportScope, snapshot: PagesSnapshot): Layout {
  // Every page in scope gets a path. Rows live in their database's folder.
  const items: Item[] = [];
  const byId = new Map<string, Item>();
  const assign = (pages: readonly PageMeta[], folder: string, recurse: boolean) => {
    const names = new NameAllocator();
    for (const page of pages) {
      const name = names.take(fileNameFor(page.title));
      const path = folder ? `${folder}/${name}` : name;
      const item: Item = { page, path, file: `${path}.${page.kind === 'database' ? 'csv' : 'md'}` };
      items.push(item);
      byId.set(page.id, item);
      if (page.kind === 'database') {
        const rows = snapshot
          .children(page.id, { includeRows: true })
          .filter((child) => snapshot.isRow(child.id));
        assign(rows, path, true);
      } else if (recurse) {
        assign(snapshot.children(page.id), path, true);
      }
    }
  };
  if (scope.kind === 'workspace') assign(snapshot.children(null), '', true);
  else {
    const page = snapshot.get(scope.pageId);
    if (page) assign([page], '', scope.kind === 'subtree');
  }

  // Link targets: a page's name when it is unique in the export, else its path (Obsidian's
  // "shortest path when possible").
  const stemCounts = new Map<string, number>();
  for (const item of items) {
    const stem = item.file
      .slice(item.file.lastIndexOf('/') + 1)
      .replace(/\.md$/, '')
      .toLowerCase();
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }
  const wikiTarget = (item: Item) => {
    const stem = item.file.slice(item.file.lastIndexOf('/') + 1).replace(/\.md$/, '');
    return (stemCounts.get(stem.toLowerCase()) ?? 0) > 1
      ? item.file
      : `${stem}${item.file.endsWith('.md') ? '.md' : ''}`;
  };
  return { items, byId, wikiTarget };
}

/** Attachments, named after their original files in the order pages first use them. */
class Attachments {
  readonly paths = new Map<string, string>();
  private readonly names = new NameAllocator();

  constructor(
    private readonly folder: string,
    private readonly context: ExportContext,
  ) {}

  async allocate(assetIds: readonly string[]): Promise<void> {
    for (const assetId of assetIds) {
      if (this.paths.has(assetId)) continue;
      const info = await this.context.assets.getInfo?.(assetId);
      const { stem, extension } = splitExtension(fileNameFor(info?.name ?? assetId, assetId));
      this.paths.set(assetId, `${this.folder}/${this.names.take(stem)}${extension}`);
    }
  }
}

/** What rendering a page reads besides the page itself. */
interface RenderEnv {
  snapshot: PagesSnapshot;
  layout: Layout;
  codec: ReturnType<typeof createMarkdownCodec>;
  linkStyle: 'wikilink' | 'markdown';
  attachments: Attachments;
  /** Block IDs that links in the export point at: only those are written. */
  linkedBlocks: ReadonlySet<string>;
}

/** What a page's file shows of other pages (the session writes it again when that changes). */
interface Shown {
  /** How each page it links to was named. */
  targets: Map<string, string>;
  /** Its blocks' IDs, and the ones written, in order. */
  blocks: string[];
  kept: string[];
}

function titleOf(snapshot: PagesSnapshot, pageId: string): string {
  return snapshot.get(pageId)?.title ?? '';
}

function resolverFor(item: Item, env: RenderEnv, shown?: Shown) {
  return {
    resolvePage: (pageId: string) => {
      const target = env.layout.byId.get(pageId);
      const title = titleOf(env.snapshot, pageId) || 'Untitled';
      const resolved = target
        ? {
            title,
            path:
              env.linkStyle === 'markdown'
                ? relativePath(folderOf(item.file), target.file)
                : env.layout.wikiTarget(target),
          }
        : env.snapshot.get(pageId)
          ? { title }
          : null;
      shown?.targets.set(pageId, JSON.stringify(resolved));
      return resolved;
    },
    resolveAssetPath: (assetId: string) => {
      const path = env.attachments.paths.get(assetId);
      if (!path) return null;
      // Wikilink embeds are vault paths; markdown images are relative to the note.
      return env.linkStyle === 'markdown' ? relativePath(folderOf(item.file), path) : path;
    },
  };
}

function pageMarkdown(item: Item, content: PageContent, env: RenderEnv, shown?: Shown): string {
  const frontmatter: Record<string, JsonValue> = {};
  const name = item.file.slice(item.file.lastIndexOf('/') + 1, -'.md'.length);
  // The title only goes into the frontmatter when the file name could not hold it (including an
  // empty title, written `Untitled.md`).
  if (name !== item.page.title) frontmatter.title = item.page.title;
  if (item.page.icon) frontmatter.icon = item.page.icon;
  for (const [key, value] of Object.entries(content.props)) {
    if (value !== undefined) frontmatter[key] = value;
  }
  return env.codec.serialize(content.doc, {
    linkStyle: env.linkStyle,
    frontmatter,
    keepBlockId: (blockId) => {
      const keep = env.linkedBlocks.has(blockId);
      shown?.blocks.push(blockId);
      if (keep) shown?.kept.push(blockId);
      return keep;
    },
    ...resolverFor(item, env, shown),
  });
}

/** How a relation cell of a database names a page (null when the page isn't exported). */
function relationLink(item: Item, pageId: string, env: RenderEnv): string | null {
  const target = env.layout.byId.get(pageId);
  if (!target) return null;
  const title = titleOf(env.snapshot, pageId);
  return `${title.replace(/[,()]/g, ' ').trim() || 'Untitled'} (${encodePath(relativePath(folderOf(item.file), target.file))})`;
}

/** What a database's CSV shows of other pages. */
interface ShownRows {
  /** Its rows' pages as they were (titles, dates, trash). */
  rows: Map<string, PageMeta | undefined>;
  /** How each page its relation cells point to was named. */
  targets: Map<string, string | null>;
}

function databaseCsv(item: Item, handle: DocHandle, env: RenderEnv, shown?: ShownRows): string {
  const properties = listProperties(handle.doc).filter((property) => property.type !== 'formula');
  const raw = listRows(handle.doc);
  for (const row of raw) shown?.rows.set(row.id, env.snapshot.get(row.id));
  const rows = resolveRows(raw, env.snapshot).filter((row) => !row.trashed && !row.missingPage);
  const link = (pageId: string) => {
    const named = relationLink(item, pageId, env);
    shown?.targets.set(pageId, named);
    return named;
  };
  return writeCsv(
    properties.map((property) => property.name),
    rows.map((row) => properties.map((property) => formatCell(row, property, link))),
  );
}

async function readContent(context: ExportContext, pageId: string): Promise<PageContent> {
  const handle = await context.loadPageDoc(pageId);
  try {
    return { doc: readDocJSON(handle.doc), props: getPageProps(handle.doc) };
  } finally {
    handle.release();
  }
}

async function withDatabase<T>(
  context: ExportContext,
  databaseId: string,
  read: (handle: DocHandle) => T,
): Promise<T> {
  const handle = await context.loadDatabaseDoc(databaseId);
  try {
    return read(handle);
  } finally {
    handle.release();
  }
}

/** Writes attachment files; returns how many were written. */
async function writeAttachments(
  attachments: Iterable<[assetId: string, path: string]>,
  context: ExportContext,
  sink: ExportSink,
  issues: TransferIssue[],
  signal: AbortSignal,
  onWritten: (assetId: string) => void = () => undefined,
): Promise<number> {
  let written = 0;
  for (const [assetId, path] of attachments) {
    throwIfAborted(signal);
    const blob = await context.assets.get(assetId);
    if (!blob) {
      issues.push({
        severity: 'warning',
        code: 'missing-attachment',
        message: 'An attachment is missing from this workspace',
        file: path,
      });
      continue;
    }
    await sink.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    onWritten(assetId);
    written += 1;
  }
  return written;
}

function exportFailed(pageId: string, error: unknown): TransferIssue {
  return { severity: 'error', code: 'export-failed', message: toError(error).message, pageId };
}

const CANCELLED: TransferIssue = {
  severity: 'warning',
  code: 'cancelled',
  message: 'The export was cancelled',
};

/**
 * Exports pages as an Obsidian-compatible folder of markdown: one `.md` per page (children in a
 * folder named like it), frontmatter for properties, attachments in one folder, links as
 * `[[wikilinks]]` (or relative markdown links), and databases as CSV next to a folder of row
 * pages. Written to any `ExportSink`: a zip, a folder or memory. {@link MarkdownExportSession}
 * keeps such an export up to date.
 */
export async function exportMarkdown(
  scope: ExportScope,
  context: ExportContext,
  sink: ExportSink,
  onProgress: (progress: ExportProgress) => void,
  signal: AbortSignal,
  exporterId: string,
  options: MarkdownExportOptions = {},
): Promise<ExportResult> {
  const started = Date.now();
  const issues: TransferIssue[] = [];
  const snapshot = context.workspace.pages.getSnapshot();
  const layout = layoutOf(scope, snapshot);
  const attachments = new Attachments(options.attachmentsFolder ?? 'attachments', context);

  // Page contents, read once up front: a block ID is only written where a link in the export
  // points at it (the editor gives most blocks an ID; ` ^id` on every line would clutter the files).
  const contents = new Map<string, PageContent>();
  const linkedBlocks = new Set<string>();
  for (const item of layout.items) {
    if (item.page.kind === 'database') continue;
    throwIfAborted(signal);
    try {
      const content = await readContent(context, item.page.id);
      contents.set(item.page.id, content);
      for (const link of extractLinks(content.doc))
        if (link.blockRef) linkedBlocks.add(link.blockRef);
    } catch (error) {
      // Reported when the page is written (it loads again there).
      if (error instanceof AbortError) throw error;
    }
  }
  // The codec is synchronous and deterministic; its own instance keeps exports independent of
  // whichever codec the app resolved.
  const env: RenderEnv = {
    snapshot,
    layout,
    codec: createMarkdownCodec(),
    linkStyle: options.linkStyle ?? 'wikilink',
    attachments,
    linkedBlocks,
  };

  let written = 0;
  const total = layout.items.length;
  try {
    for (const [index, item] of layout.items.entries()) {
      throwIfAborted(signal);
      onProgress({ done: index, total, currentPage: item.page.title });
      try {
        if (item.page.kind === 'database') {
          const csv = await withDatabase(context, item.page.id, (handle) =>
            databaseCsv(item, handle, env),
          );
          await sink.writeFile(item.file, csv);
        } else {
          const content = contents.get(item.page.id) ?? (await readContent(context, item.page.id));
          contents.delete(item.page.id);
          await attachments.allocate(extractAssetIds(content.doc));
          await sink.writeFile(item.file, pageMarkdown(item, content, env));
        }
        written += 1;
      } catch (error) {
        if (error instanceof AbortError) throw error;
        issues.push(exportFailed(item.page.id, error));
      }
    }
    written += await writeAttachments(attachments.paths, context, sink, issues, signal);
  } catch (error) {
    if (!(error instanceof AbortError)) throw error;
    issues.push(CANCELLED);
  }
  onProgress({ done: total, total });
  return { exporterId, files: written, issues, durationMs: Date.now() - started };
}

/** What a session knows about a page's file from the run that wrote it. */
interface PageRecord extends Shown {
  kind: 'page';
  file: string;
  meta: PageMeta;
  /** Blocks its links point at: other files keep those blocks' IDs. */
  refs: string[];
  assets: string[];
}

interface DatabaseRecord extends ShownRows {
  kind: 'database';
  file: string;
  meta: PageMeta;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The markdown export kept up to date (`ExportSession`, the desktop mirror): each run reads and
 * writes only the pages whose files would change, and names every file the export has now. A page
 * is written again when its doc changed (`changed`, or its `updatedAt`), when it was renamed or
 * moved, when a page it links to shows under another title or path, and when links elsewhere
 * start or stop pointing at one of its blocks. The result matches a full export, except that
 * attachments keep the names they got first.
 */
export class MarkdownExportSession implements ExportSession {
  private readonly records = new Map<string, PageRecord | DatabaseRecord>();
  private readonly attachments: Attachments;
  /** Attachments written by an earlier run (an asset's bytes never change). */
  private readonly writtenAssets = new Set<string>();
  private readonly codec = createMarkdownCodec();

  constructor(
    private readonly scope: ExportScope,
    private readonly context: ExportContext,
    private readonly exporterId: string,
    private readonly options: MarkdownExportOptions = {},
  ) {
    this.attachments = new Attachments(options.attachmentsFolder ?? 'attachments', context);
  }

  async run(
    changed: ReadonlySet<string>,
    sink: ExportSink,
    onProgress: (progress: ExportProgress) => void,
    signal: AbortSignal,
  ): Promise<ExportSessionResult> {
    const started = Date.now();
    const issues: TransferIssue[] = [];
    const snapshot = this.context.workspace.pages.getSnapshot();
    const layout = layoutOf(this.scope, snapshot);
    for (const id of [...this.records.keys()]) if (!layout.byId.has(id)) this.records.delete(id);
    const env: RenderEnv = {
      snapshot,
      layout,
      codec: this.codec,
      linkStyle: this.options.linkStyle ?? 'wikilink',
      attachments: this.attachments,
      linkedBlocks: new Set(),
    };

    // 1. Pages whose files would change, and their contents.
    const dirty = new Set<string>();
    for (const item of layout.items) if (this.isStale(item, changed, env)) dirty.add(item.page.id);
    const contents = new Map<string, PageContent>();
    const read = async (item: Item) => {
      if (item.page.kind === 'database') return;
      throwIfAborted(signal);
      try {
        contents.set(item.page.id, await readContent(this.context, item.page.id));
      } catch (error) {
        // Reported when the page is written (it loads again there).
        if (error instanceof AbortError) throw error;
      }
    };
    let written = 0;
    let done = 0;
    try {
      for (const item of layout.items) if (dirty.has(item.page.id)) await read(item);
      // Links decide which blocks keep their IDs: pages whose share of those changed are written
      // again too.
      const linkedBlocks = new Set<string>();
      for (const [id, record] of this.records)
        if (record.kind === 'page' && !contents.has(id))
          for (const ref of record.refs) linkedBlocks.add(ref);
      for (const content of contents.values())
        for (const link of extractLinks(content.doc))
          if (link.blockRef) linkedBlocks.add(link.blockRef);
      env.linkedBlocks = linkedBlocks;
      for (const item of layout.items) {
        const record = this.records.get(item.page.id);
        if (dirty.has(item.page.id) || record?.kind !== 'page') continue;
        const kept = record.blocks.filter((id) => linkedBlocks.has(id));
        if (sameList(kept, record.kept)) continue;
        dirty.add(item.page.id);
        await read(item);
      }

      // 2. Write them, in export order.
      for (const item of layout.items) {
        if (!dirty.has(item.page.id)) continue;
        throwIfAborted(signal);
        onProgress({ done, total: dirty.size, currentPage: item.page.title });
        done += 1;
        try {
          await this.write(item, contents.get(item.page.id), env, sink);
          written += 1;
        } catch (error) {
          if (error instanceof AbortError) throw error;
          // Written again by the next run.
          this.records.delete(item.page.id);
          issues.push(exportFailed(item.page.id, error));
        }
      }

      // 3. Attachments the files use now; ones no file uses anymore leave the export.
      const used = new Set<string>();
      for (const record of this.records.values())
        if (record.kind === 'page') for (const id of record.assets) used.add(id);
      for (const id of this.writtenAssets) if (!used.has(id)) this.writtenAssets.delete(id);
      const fresh: Array<[string, string]> = [];
      for (const [id, path] of this.attachments.paths)
        if (used.has(id) && !this.writtenAssets.has(id)) fresh.push([id, path]);
      written += await writeAttachments(fresh, this.context, sink, issues, signal, (id) =>
        this.writtenAssets.add(id),
      );
    } catch (error) {
      if (!(error instanceof AbortError)) throw error;
      issues.push(CANCELLED);
    }
    onProgress({ done: dirty.size, total: dirty.size });
    const paths = layout.items.map((item) => item.file);
    for (const [id, path] of this.attachments.paths)
      if (this.writtenAssets.has(id)) paths.push(path);
    return {
      exporterId: this.exporterId,
      files: written,
      issues,
      durationMs: Date.now() - started,
      paths,
    };
  }

  /** True when the item's file would differ from what the session wrote last. */
  private isStale(item: Item, changed: ReadonlySet<string>, env: RenderEnv): boolean {
    const record = this.records.get(item.page.id);
    if (
      !record ||
      record.file !== item.file ||
      record.meta !== item.page ||
      changed.has(item.page.id)
    )
      return true;
    if (record.kind === 'database') {
      for (const [id, meta] of record.rows) if (env.snapshot.get(id) !== meta) return true;
      for (const [id, named] of record.targets)
        if (relationLink(item, id, env) !== named) return true;
      return false;
    }
    const { resolvePage } = resolverFor(item, env);
    for (const [id, named] of record.targets)
      if (JSON.stringify(resolvePage(id)) !== named) return true;
    return false;
  }

  private async write(
    item: Item,
    read: PageContent | undefined,
    env: RenderEnv,
    sink: ExportSink,
  ): Promise<void> {
    if (item.page.kind === 'database') {
      const shown: ShownRows = { rows: new Map(), targets: new Map() };
      const csv = await withDatabase(this.context, item.page.id, (handle) =>
        databaseCsv(item, handle, env, shown),
      );
      await sink.writeFile(item.file, csv);
      this.records.set(item.page.id, {
        kind: 'database',
        file: item.file,
        meta: item.page,
        ...shown,
      });
      return;
    }
    const content = read ?? (await readContent(this.context, item.page.id));
    const assets = extractAssetIds(content.doc);
    await this.attachments.allocate(assets);
    const shown: Shown = { targets: new Map(), blocks: [], kept: [] };
    await sink.writeFile(item.file, pageMarkdown(item, content, env, shown));
    const refs = extractLinks(content.doc).flatMap((link) =>
      link.blockRef ? [link.blockRef] : [],
    );
    this.records.set(item.page.id, {
      kind: 'page',
      file: item.file,
      meta: item.page,
      refs,
      assets,
      ...shown,
    });
  }
}
