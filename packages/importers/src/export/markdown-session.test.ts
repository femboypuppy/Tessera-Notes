import {
  build as b,
  importFileFromBytes,
  MemoryExportSink,
  updateDocJSON,
  type ExportContext,
  type ExportSession,
  type ExportSink,
} from '@tessera/core';
import type { TestAppContext } from '@tessera/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMarkdownExporter } from '../exporters';
import { createNotionImporter, createObsidianImporter } from '../importers';
import {
  fixtureEntries,
  fixtureFiles,
  importWorkspace,
  pageAt,
  runImporter,
  zipEntries,
} from '../test/helpers';
import { exportMarkdown } from './markdown';

function asText(data: Uint8Array | string): string {
  return typeof data === 'string' ? data : `base64:${Buffer.from(data).toString('base64')}`;
}

/** A folder kept up to date: files stay until a run leaves them out of its paths. */
class FolderSink implements ExportSink {
  readonly files = new Map<string, string>();

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    this.files.set(path, asText(data));
  }

  keep(paths: readonly string[]): void {
    const kept = new Set(paths);
    for (const path of [...this.files.keys()]) if (!kept.has(path)) this.files.delete(path);
  }
}

describe('markdown export session', () => {
  let test: TestAppContext;
  let vault: string;
  let notion: string;
  let context: ExportContext;
  let session: ExportSession;
  const folder = new FolderSink();
  const reads: string[] = [];
  const signal = new AbortController().signal;

  beforeAll(async () => {
    test = await importWorkspace();
    const { ctx } = test;
    vault =
      (
        await runImporter(
          ctx,
          createObsidianImporter(),
          fixtureFiles('obsidian-vault'),
          'Apollo vault',
        )
      ).rootPageId ?? '';
    const zip = importFileFromBytes('Export.zip', zipEntries(fixtureEntries('notion-export')));
    notion = (await runImporter(ctx, createNotionImporter(), [zip], 'Notion')).rootPageId ?? '';
    context = {
      workspace: ctx.workspace,
      loadPageDoc: (id) => {
        reads.push(id);
        return ctx.loadPageDoc(id);
      },
      loadDatabaseDoc: (id) => ctx.loadDatabaseDoc(id),
      assets: ctx.services.assetStore,
      codec: ctx.services.markdownCodec,
    };
    const opened = createMarkdownExporter().session?.({ kind: 'workspace' }, context);
    if (!opened) throw new Error('The markdown exporter has no session');
    session = opened;
  }, 60_000);
  afterAll(() => test.dispose());

  /** A run as the desktop mirror makes one: the pages it read, and the result. */
  async function sync(changed: readonly string[] = []) {
    await test.flush();
    reads.length = 0;
    const result = await session.run(new Set(changed), folder, () => undefined, signal);
    folder.keep(result.paths);
    expect(result.issues).toEqual([]);
    return { result, reads: [...reads].sort() };
  }

  async function fullExport(): Promise<Map<string, string>> {
    const sink = new MemoryExportSink();
    const { ctx } = test;
    await exportMarkdown(
      { kind: 'workspace' },
      { ...context, loadPageDoc: (id) => ctx.loadPageDoc(id) },
      sink,
      () => undefined,
      signal,
      'markdown',
    );
    return new Map([...sink.files].map(([path, data]) => [path, asText(data)]));
  }

  const at = (root: string, path: string) => pageAt(test.ctx, root, path).id;

  async function edit(pageId: string, text: string): Promise<void> {
    const handle = await test.ctx.loadPageDoc(pageId);
    updateDocJSON(handle.doc, (doc) => ({ ...doc, content: [...doc.content, b.p(text)] }));
    handle.release();
  }

  it('writes what a full export writes, then nothing while nothing changes', async () => {
    const first = await sync();
    expect(folder.files).toEqual(await fullExport());
    expect(first.result.files).toBe(folder.files.size);
    expect(first.result.paths.sort()).toEqual([...folder.files.keys()].sort());

    const idle = await sync();
    expect(idle.result.files).toBe(0);
    expect(idle.reads).toEqual([]);
  });

  it('reads and writes only an edited page', async () => {
    const brainstorm = at(vault, 'Notes/Brainstorm');
    await edit(brainstorm, 'One more idea.');
    const run = await sync([brainstorm]);
    expect(run.reads).toEqual([brainstorm]);
    expect(run.result.files).toBe(1);
    expect(folder.files).toEqual(await fullExport());
  });

  it('writes a renamed page under its new name, and the pages that link to it', async () => {
    const apollo = at(vault, 'Projects/Apollo 11 🚀');
    const welcome = at(vault, 'Welcome');
    test.ctx.workspace.renamePage(apollo, 'Apollo 11 (1969)');
    const run = await sync();
    expect(run.reads).toContain(apollo);
    expect(run.reads).toContain(welcome);
    expect(run.reads).not.toContain(at(vault, 'Daily/2026-09-23'));
    expect(folder.files.has('Apollo vault/Projects/Apollo 11 (1969).md')).toBe(true);
    expect(folder.files.has('Apollo vault/Projects/Apollo 11 🚀.md')).toBe(false);
    expect(folder.files).toEqual(await fullExport());
  });

  it('writes the block IDs that new links point at', async () => {
    const brainstorm = at(vault, 'Notes/Brainstorm');
    const plan = at(vault, 'Projects/Launch plan');
    const handle = await test.ctx.loadPageDoc(brainstorm);
    updateDocJSON(handle.doc, (doc) => ({
      ...doc,
      content: [...doc.content, b.p('First, ', b.pageLink(plan, { blockRef: 'step-1' }))],
    }));
    handle.release();
    const run = await sync([brainstorm]);
    // The launch plan's own doc didn't change, but its file now shows `^step-1`.
    expect(run.reads).toEqual([brainstorm, plan].sort());
    expect(folder.files.get('Apollo vault/Projects/Launch plan.md')).toContain('^step-1');
    expect(folder.files).toEqual(await fullExport());
  });

  it('follows moves that make two pages share a name', async () => {
    const ideas = at(vault, 'Notes/Ideas');
    test.ctx.workspace.movePage(ideas, { parentId: at(vault, 'Projects'), position: 'end' });
    await sync();
    expect(folder.files).toEqual(await fullExport());
  });

  it('writes a database again when a page its relation cells point to is renamed', async () => {
    const neil = at(notion, 'Workspace Home/Crew/Neil Armstrong');
    test.ctx.workspace.renamePage(neil, 'Neil A. Armstrong');
    const run = await sync();
    expect(run.reads).toContain(neil);
    expect(folder.files.get('Notion/Workspace Home/Tasks.csv')).toContain(
      'Neil A. Armstrong (Crew/Neil%20A.%20Armstrong.md)',
    );
    expect(folder.files).toEqual(await fullExport());
  });

  it('removes the files of trashed pages, and the attachments only they used', async () => {
    const attachments = at(vault, 'attachments');
    test.ctx.workspace.trashPage(attachments);
    test.ctx.workspace.trashPage(at(vault, 'Daily'));
    await sync();
    expect(folder.files.has('Apollo vault/Daily.md')).toBe(false);
    expect(folder.files).toEqual(await fullExport());

    // Restored, everything comes back.
    test.ctx.workspace.restorePage(attachments);
    await sync();
    expect(folder.files).toEqual(await fullExport());
  });
});
