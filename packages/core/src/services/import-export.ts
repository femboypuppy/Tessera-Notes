import { AbortError, throwIfAborted, toError } from '../errors';
import type { PageMeta } from '../model/page-meta';
import type { DocHandle } from '../runtime/doc-manager';
import type { WorkspaceApi } from '../runtime/app-context';
import type { CurrentUser } from '../runtime/user';
import type { AssetStore } from './asset-store';
import type { MarkdownCodec } from './markdown-codec';

// ---------------------------------------------------------------------------------------------
// Files and paths
// ---------------------------------------------------------------------------------------------

/**
 * A file handed to an importer: from a file picker, a dropped folder, or an unpacked zip.
 * `path` is relative, uses `/`, and has already passed {@link normalizeImportPath}.
 */
export interface ImportFile {
  path: string;
  size: number;
  mimeType?: string;
  lastModified?: number;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
}

/**
 * Normalizes a path from an archive or folder: backslashes to `/`, no leading `./` or `/`, no
 * empty segments. Returns null for anything that could escape the import (`..`, absolute or drive
 * paths, NUL bytes): never trust names from archives ("zip slip").
 *
 * @example
 * normalizeImportPath('Vault\\Notes\\a.md'); // 'Vault/Notes/a.md'
 * normalizeImportPath('../../etc/passwd'); // null
 */
export function normalizeImportPath(path: string): string | null {
  if (!path || path.includes('\0')) return null;
  const unified = path.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified) || unified.startsWith('//'))
    return null;
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
}

/** Wraps a Blob or File as an {@link ImportFile}. Throws for unsafe paths. */
export function importFileFromBlob(path: string, blob: Blob, lastModified?: number): ImportFile {
  const normalized = normalizeImportPath(path);
  if (!normalized) throw new TypeError(`Unsafe import path: ${path}`);
  const file: ImportFile = {
    path: normalized,
    size: blob.size,
    bytes: async () => new Uint8Array(await blob.arrayBuffer()),
    text: () => blob.text(),
  };
  if (blob.type) file.mimeType = blob.type;
  if (lastModified !== undefined) file.lastModified = lastModified;
  return file;
}

/** Wraps bytes (for example an entry of an unzipped archive) as an {@link ImportFile}. */
export function importFileFromBytes(
  path: string,
  bytes: Uint8Array,
  mimeType?: string,
): ImportFile {
  const normalized = normalizeImportPath(path);
  if (!normalized) throw new TypeError(`Unsafe import path: ${path}`);
  const file: ImportFile = {
    path: normalized,
    size: bytes.byteLength,
    bytes: async () => bytes,
    text: async () => new TextDecoder().decode(bytes),
  };
  if (mimeType) file.mimeType = mimeType;
  return file;
}

/** Wraps text as an {@link ImportFile} (tests and paste imports). */
export function importFileFromText(path: string, text: string): ImportFile {
  return importFileFromBytes(path, new TextEncoder().encode(text), 'text/plain');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Drops trailing dots and spaces (Windows strips them from file names). A loop from the end: the
 * regex `[. ]+$` restarted at every dot or space of a title like `. . . …x`, which took seconds.
 */
function withoutTrailingDotsAndSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '.' || value[end - 1] === ' ')) end -= 1;
  return value.slice(0, end);
}

/**
 * Makes a page title safe as a file or folder name on every OS: no `/ \ : * ? " < > |` or control
 * characters, no trailing dots or spaces, not a reserved Windows name, at most 120 characters.
 *
 * @example
 * sanitizeFileName('Q3: plan / notes?'); // 'Q3- plan - notes-'
 */
export function sanitizeFileName(name: string, fallback = 'Untitled'): string {
  const cleaned = withoutTrailingDotsAndSpaces(
    name
      // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, 120)
    .trim();
  if (!cleaned) return fallback;
  return WINDOWS_RESERVED.test(cleaned) ? `${cleaned}_` : cleaned;
}

/** Returns a name not in `taken` by appending ` (2)`, ` (3)`, … before the extension, and records it. */
export function uniqueName(name: string, taken: Set<string>, extension = ''): string {
  const key = (candidate: string) => `${candidate}${extension}`.toLowerCase();
  let candidate = name;
  for (let n = 2; taken.has(key(candidate)); n += 1) candidate = `${name} (${n})`;
  taken.add(key(candidate));
  return `${candidate}${extension}`;
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

/** A problem found during an import or export. */
export interface TransferIssue {
  severity: 'warning' | 'error';
  /** Stable machine code, e.g. `unresolved-link`, `unsupported-syntax`, `skipped-file`, `read-failed`. */
  code: string;
  /** Plain-language description (English; UIs may map `code` to a translated string). */
  message: string;
  file?: string;
  pageId?: string;
}

/** Progress of an import. */
export interface ImportProgress {
  phase: 'reading' | 'pages' | 'databases' | 'assets' | 'links' | 'finishing';
  done: number;
  total: number;
  currentFile?: string;
}

/** The outcome of an import, shown as the "Import report". */
export interface ImportReport {
  importerId: string;
  /** The page that holds everything imported (null when nothing was created). */
  rootPageId: string | null;
  counts: {
    pages: number;
    databases: number;
    rows: number;
    assets: number;
    links: number;
    skippedFiles: number;
  };
  issues: TransferIssue[];
  durationMs: number;
  cancelled: boolean;
}

/** What importers get to write with. */
export interface ImportContext {
  workspace: WorkspaceApi;
  loadPageDoc(pageId: string): Promise<DocHandle>;
  loadDatabaseDoc(databaseId: string): Promise<DocHandle>;
  assets: AssetStore;
  codec: MarkdownCodec;
  /** Where to create the import's root page (null = top level). Nothing existing is modified. */
  parentId: string | null;
  /** Title of the root page, already translated by the caller (for example "Obsidian import"). */
  rootTitle: string;
  currentUser: CurrentUser;
}

/**
 * Imports files into the workspace, under a new root page. Implementations: a basic markdown
 * importer (core) and Notion, Obsidian and markdown-folder importers (`@tessera/importers`).
 * Importers stream: report progress, check `signal` between files, and throw nothing for bad
 * files (record an issue and continue).
 *
 * @example
 * const [best] = await ctx.importers.detect(files);
 * const report = await best.importer.run(files, context, setProgress, controller.signal);
 */
export interface Importer {
  id: string;
  label: string;
  description?: string;
  /** For file pickers: extensions (with the dot) or MIME types. */
  accept?: string[];
  /** True when the importer expects a folder (or a zip of one). */
  acceptsDirectories?: boolean;
  /** Confidence from 0 (not this format) to 1 (certainly this format). */
  detect(files: readonly ImportFile[]): number | Promise<number>;
  run(
    files: readonly ImportFile[],
    context: ImportContext,
    onProgress: (progress: ImportProgress) => void,
    signal: AbortSignal,
  ): Promise<ImportReport>;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

/** Where exporters write files: a zip, a folder on disk (desktop mirror), or memory (tests). */
export interface ExportSink {
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
}

/** An {@link ExportSink} that keeps files in memory. */
export class MemoryExportSink implements ExportSink {
  readonly files = new Map<string, Uint8Array | string>();

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const normalized = normalizeImportPath(path);
    if (!normalized) throw new TypeError(`Unsafe export path: ${path}`);
    this.files.set(normalized, data);
  }
}

/** What to export. */
export type ExportScope =
  { kind: 'workspace' } | { kind: 'subtree'; pageId: string } | { kind: 'page'; pageId: string };

/** What exporters get to read with. */
export interface ExportContext {
  workspace: WorkspaceApi;
  loadPageDoc(pageId: string): Promise<DocHandle>;
  loadDatabaseDoc(databaseId: string): Promise<DocHandle>;
  assets: AssetStore;
  codec: MarkdownCodec;
}

export interface ExportProgress {
  done: number;
  total: number;
  currentPage?: string;
}

export interface ExportResult {
  exporterId: string;
  files: number;
  issues: TransferIssue[];
  durationMs: number;
}

/** Result of an {@link ExportSession} run. */
export interface ExportSessionResult extends ExportResult {
  /** Every file of the export after the run: written by it or by an earlier run. */
  paths: string[];
}

/**
 * An export kept up to date in place (the desktop mirror): each run writes only the files that
 * changed since the previous one, where a full export would read and write every page. The first
 * run writes everything.
 */
export interface ExportSession {
  /**
   * `changed` names the pages and databases whose docs changed since the previous run; renames,
   * moves, deletions and what links show of other pages the session works out itself.
   */
  run(
    changed: ReadonlySet<string>,
    sink: ExportSink,
    onProgress: (progress: ExportProgress) => void,
    signal: AbortSignal,
  ): Promise<ExportSessionResult>;
}

/**
 * Writes pages to files. Implementations: a basic markdown exporter (core) and the markdown zip,
 * JSON backup, HTML and PDF exporters (`@tessera/importers`). The desktop app's markdown mirror
 * runs an exporter into a folder sink.
 */
export interface Exporter {
  id: string;
  label: string;
  description?: string;
  scopes: ReadonlyArray<ExportScope['kind']>;
  /** Extension of a single-file result, when the exporter produces one file (`.html`, `.json`). */
  fileExtension?: string;
  run(
    scope: ExportScope,
    context: ExportContext,
    sink: ExportSink,
    onProgress: (progress: ExportProgress) => void,
    signal: AbortSignal,
  ): Promise<ExportResult>;
  /** Opens an export that later runs update in place (optional; the desktop mirror uses it). */
  session?(scope: ExportScope, context: ExportContext): ExportSession;
}

// ---------------------------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------------------------

/** A list of items with unique IDs, subscribable. */
export interface ListRegistry<T extends { id: string }> {
  /**
   * Adds an item; a later item with the same ID replaces it (with a warning, unless the earlier
   * one was registered as `replaceable`, like core's stubs). Returns a function that removes it;
   * removing a replacement brings back the replaceable item it replaced.
   */
  register(item: T, options?: { replaceable?: boolean }): () => void;
  get(id: string): T | undefined;
  list(): T[];
  subscribe(listener: () => void): () => void;
}

/** Creates a {@link ListRegistry}. A later registration with the same ID replaces the earlier one. */
export function createListRegistry<T extends { id: string }>(): ListRegistry<T> {
  const items = new Map<string, T>();
  const replaceable = new Map<string, T>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    register(item, options = {}) {
      const previous = items.get(item.id);
      if (previous && replaceable.get(item.id) !== previous)
        console.warn(`[registry] "${item.id}" was registered twice; the last one wins`);
      if (options.replaceable) replaceable.set(item.id, item);
      items.set(item.id, item);
      notify();
      return () => {
        if (items.get(item.id) !== item) {
          if (replaceable.get(item.id) === item) replaceable.delete(item.id);
          return;
        }
        const fallback = replaceable.get(item.id);
        if (fallback && fallback !== item) items.set(item.id, fallback);
        else {
          items.delete(item.id);
          replaceable.delete(item.id);
        }
        notify();
      };
    },
    get: (id) => items.get(id),
    list: () => [...items.values()],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Registered importers, plus format detection. */
export interface ImporterRegistry extends ListRegistry<Importer> {
  /** Importers that recognize the files, most confident first (confidence > 0 only). */
  detect(files: readonly ImportFile[]): Promise<Array<{ importer: Importer; confidence: number }>>;
}

export type ExporterRegistry = ListRegistry<Exporter>;

/** Creates an {@link ImporterRegistry}. */
export function createImporterRegistry(): ImporterRegistry {
  const base = createListRegistry<Importer>();
  return {
    ...base,
    async detect(files) {
      const scored = await Promise.all(
        base.list().map(async (importer) => {
          try {
            return { importer, confidence: Math.max(0, Math.min(1, await importer.detect(files))) };
          } catch {
            return { importer, confidence: 0 };
          }
        }),
      );
      return scored
        .filter((entry) => entry.confidence > 0)
        .sort((a, b) => b.confidence - a.confidence);
    },
  };
}

/** Creates an {@link ExporterRegistry}. */
export function createExporterRegistry(): ExporterRegistry {
  return createListRegistry<Exporter>();
}

// ---------------------------------------------------------------------------------------------
// Stub importer and exporter
// ---------------------------------------------------------------------------------------------

const MARKDOWN_FILE = /\.(md|markdown|txt)$/i;

/**
 * Basic markdown importer (the stub `@tessera/importers` replaces): every `.md`, `.markdown` and
 * `.txt` file becomes a page (through the `MarkdownCodec`), folders become parent pages, and a
 * `Folder.md` next to `Folder/` becomes that folder's page. Other files are skipped and reported.
 */
export function createBasicMarkdownImporter(): Importer {
  const id = 'markdown-basic';
  return {
    id,
    label: 'Markdown files',
    description: 'Markdown and text files; folders become pages.',
    accept: ['.md', '.markdown', '.txt'],
    acceptsDirectories: true,
    detect(files) {
      if (!files.length) return 0;
      return (files.filter((file) => MARKDOWN_FILE.test(file.path)).length / files.length) * 0.5;
    },
    async run(files, context, onProgress, signal) {
      const started = Date.now();
      // Loaded on demand: keeps ProseMirror out of the shell bundle.
      const { writeDocJSON } = await import('../schema/ydoc');
      const report: ImportReport = {
        importerId: id,
        rootPageId: null,
        counts: { pages: 0, databases: 0, rows: 0, assets: 0, links: 0, skippedFiles: 0 },
        issues: [],
        durationMs: 0,
        cancelled: false,
      };
      const { workspace } = context;
      const root = workspace.createPage({ title: context.rootTitle, parentId: context.parentId });
      report.rootPageId = root.id;
      report.counts.pages += 1;
      const folders = new Map<string, PageMeta>([['', root]]);
      const folderPage = (folderPath: string): PageMeta => {
        const existing = folders.get(folderPath);
        if (existing) return existing;
        const slash = folderPath.lastIndexOf('/');
        const parent = folderPage(slash < 0 ? '' : folderPath.slice(0, slash));
        const page = workspace.createPage({
          title: folderPath.slice(slash + 1),
          parentId: parent.id,
        });
        report.counts.pages += 1;
        folders.set(folderPath, page);
        return page;
      };
      const markdown = [...files]
        .filter((file) => MARKDOWN_FILE.test(file.path))
        .sort((a, b) => a.path.localeCompare(b.path));
      for (const file of files) {
        if (!MARKDOWN_FILE.test(file.path)) {
          report.counts.skippedFiles += 1;
          report.issues.push({
            severity: 'warning',
            code: 'skipped-file',
            message: 'Not a markdown file',
            file: file.path,
          });
        }
      }
      try {
        for (const [index, file] of markdown.entries()) {
          throwIfAborted(signal);
          onProgress({
            phase: 'pages',
            done: index,
            total: markdown.length,
            currentFile: file.path,
          });
          const withoutExt = file.path.replace(MARKDOWN_FILE, '');
          const slash = withoutExt.lastIndexOf('/');
          const title = withoutExt.slice(slash + 1);
          try {
            const { doc, warnings } = context.codec.parse(await file.text());
            const page =
              folders.get(withoutExt) ??
              workspace.createPage({
                title,
                parentId: folderPage(slash < 0 ? '' : withoutExt.slice(0, slash)).id,
              });
            if (!folders.has(withoutExt)) {
              folders.set(withoutExt, page);
              report.counts.pages += 1;
            }
            const handle = await context.loadPageDoc(page.id);
            try {
              writeDocJSON(handle.doc, doc, { origin: 'import' });
            } finally {
              handle.release();
            }
            for (const warning of warnings) {
              report.issues.push({
                severity: 'warning',
                code: 'unsupported-syntax',
                message: warning,
                file: file.path,
                pageId: page.id,
              });
            }
          } catch (error) {
            if (error instanceof AbortError) throw error;
            report.issues.push({
              severity: 'error',
              code: 'read-failed',
              message: toError(error).message,
              file: file.path,
            });
          }
        }
        onProgress({ phase: 'finishing', done: markdown.length, total: markdown.length });
      } catch (error) {
        if (!(error instanceof AbortError)) throw error;
        report.cancelled = true;
      }
      report.durationMs = Date.now() - started;
      return report;
    },
  };
}

/**
 * Basic markdown exporter (the stub `@tessera/importers` replaces): one `.md` file per page,
 * nested in folders that mirror the page tree, through the `MarkdownCodec`.
 */
export function createBasicMarkdownExporter(): Exporter {
  const id = 'markdown-basic';
  return {
    id,
    label: 'Markdown files',
    scopes: ['workspace', 'subtree', 'page'],
    async run(scope, context, sink, onProgress, signal) {
      const started = Date.now();
      const { readDocJSON } = await import('../schema/ydoc');
      const snapshot = context.workspace.pages.getSnapshot();
      const roots: PageMeta[] =
        scope.kind === 'workspace'
          ? [...snapshot.children(null)]
          : [snapshot.get(scope.pageId)].filter((page): page is PageMeta => page !== undefined);
      const jobs: Array<{ page: PageMeta; folder: string }> = [];
      const collect = (pages: readonly PageMeta[], folder: string, taken: Set<string>) => {
        for (const page of pages) {
          const base = sanitizeFileName(page.title);
          const name = uniqueName(base, taken, '');
          jobs.push({ page, folder: folder ? `${folder}/${name}` : name });
          if (scope.kind !== 'page')
            collect(snapshot.children(page.id), folder ? `${folder}/${name}` : name, new Set());
        }
      };
      collect(roots, '', new Set());
      const issues: TransferIssue[] = [];
      const resolvePage = (pageId: string) => {
        const page = snapshot.get(pageId);
        return page ? { title: page.title } : null;
      };
      for (const [index, job] of jobs.entries()) {
        throwIfAborted(signal);
        onProgress({ done: index, total: jobs.length, currentPage: job.page.title });
        const path = `${job.folder}.md`;
        if (job.page.kind !== 'page') {
          await sink.writeFile(path, `# ${job.page.title}\n`);
          issues.push({
            severity: 'warning',
            code: 'database-as-title',
            message: 'Databases are exported as their title only',
            pageId: job.page.id,
          });
          continue;
        }
        const handle = await context.loadPageDoc(job.page.id);
        try {
          await sink.writeFile(
            path,
            context.codec.serialize(readDocJSON(handle.doc), { resolvePage }),
          );
        } finally {
          handle.release();
        }
      }
      onProgress({ done: jobs.length, total: jobs.length });
      return { exporterId: id, files: jobs.length, issues, durationMs: Date.now() - started };
    },
  };
}
