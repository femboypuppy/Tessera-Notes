import { build as b, writeDocJSON, type AppContext } from '@tessera/core';
import { createMarkdownExporter } from '@tessera/importers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBackend } from '../runtime';
import { cleanupDesktop, desktopTestContext } from '../testing/context';
import {
  currentMirror,
  FolderExportSink,
  MarkdownMirror,
  MIRROR_SETTING,
  pickMirrorExporter,
} from './mirror';

/** The workspace's own mirror (started by the activation) would run too: tests use theirs. */
function stopActivationMirror() {
  currentMirror.get()?.stop();
}

afterEach(cleanupDesktop);

async function withContent(ctx: Awaited<ReturnType<typeof desktopTestContext>>['ctx']) {
  const page = ctx.workspace.createPage({ title: 'Launch plan' });
  const handle = await ctx.loadPageDoc(page.id);
  writeDocJSON(handle.doc, {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'T-minus ten' }] }],
  });
  handle.release();
  return page;
}

describe('the markdown mirror', () => {
  it('uses the best markdown exporter available', async () => {
    const { ctx } = await desktopTestContext();
    expect(pickMirrorExporter(ctx)?.id).toBe('markdown-basic');
  });

  it('refuses unsafe paths', async () => {
    await desktopTestContext();
    const sink = new FolderExportSink(getBackend(), 'ws');
    await expect(sink.writeFile('../outside.md', 'x')).rejects.toThrow(/Unsafe/);
  });

  it('writes the workspace as markdown when enabled, and follows edits', async () => {
    const { ctx, fake, flush } = await desktopTestContext();
    const page = await withContent(ctx);
    await flush();
    stopActivationMirror();
    const mirror = new MarkdownMirror(ctx, getBackend(), { delayMs: 10, maxWaitMs: 50 });
    mirror.start();
    expect(mirror.status.get().enabled).toBe(false);
    await mirror.setEnabled(true);
    expect(ctx.settings.device.get(MIRROR_SETTING)).toEqual([ctx.workspace.info.id]);
    await vi.waitFor(() => expect(mirror.status.get().lastRunAt).not.toBeNull());
    const files = fake.state.mirror[ctx.workspace.info.id] ?? {};
    expect(files['Launch plan.md']).toContain('T-minus ten');
    expect(mirror.status.get()).toMatchObject({ files: 1, error: null, running: false });

    // Renaming the page rewrites the file under the new name and removes the old one.
    ctx.workspace.renamePage(page.id, 'Launch day');
    await vi.waitFor(() =>
      expect(Object.keys(fake.state.mirror[ctx.workspace.info.id] ?? {})).toEqual([
        'Launch day.md',
      ]),
    );
    mirror.stop();
  });

  it('reads and writes only the pages that changed since the last run', async () => {
    const { ctx, fake, flush } = await desktopTestContext();
    // The app's markdown exporter, which keeps a session between runs.
    ctx.exporters.register(createMarkdownExporter());
    const write = async (app: AppContext, pageId: string, text: string) => {
      const handle = await app.loadPageDoc(pageId);
      writeDocJSON(handle.doc, b.doc(b.p(text)));
      handle.release();
    };
    const apollo = ctx.workspace.createPage({ title: 'Apollo' });
    const gemini = ctx.workspace.createPage({ title: 'Gemini' });
    const mercury = ctx.workspace.createPage({ title: 'Mercury' });
    for (const page of [apollo, gemini, mercury]) await write(ctx, page.id, `About ${page.title}`);
    await flush();
    stopActivationMirror();
    // Runs only when asked to, so each step below is one run.
    const mirror = new MarkdownMirror(ctx, getBackend(), { delayMs: 60_000, maxWaitMs: 60_000 });
    mirror.start();
    await mirror.setEnabled(true);
    // The first run loads the export's code.
    await vi.waitFor(() => expect(mirror.status.get().lastRunAt).not.toBeNull(), {
      timeout: 30_000,
    });
    const files = () => fake.state.mirror[ctx.workspace.info.id] ?? {};
    expect(Object.keys(files()).sort()).toEqual(['Apollo.md', 'Gemini.md', 'Mercury.md']);

    await write(ctx, gemini.id, 'Twelve missions');
    await flush();
    const reads = vi.spyOn(ctx, 'loadPageDoc');
    const writes = vi.spyOn(getBackend(), 'mirrorWrite');
    await mirror.runNow();
    expect(reads.mock.calls.map(([id]) => id)).toEqual([gemini.id]);
    expect(writes.mock.calls.map(([, path]) => path)).toEqual(['Gemini.md']);
    expect(files()['Gemini.md']).toContain('Twelve missions');
    expect(Object.keys(files()).sort()).toEqual(['Apollo.md', 'Gemini.md', 'Mercury.md']);
    expect(mirror.status.get()).toMatchObject({ files: 3, error: null });

    // A renamed page is written under its new name, and its old file goes.
    ctx.workspace.renamePage(apollo.id, 'Apollo program');
    reads.mockClear();
    writes.mockClear();
    await mirror.runNow();
    expect(reads.mock.calls.map(([id]) => id)).toEqual([apollo.id]);
    expect(Object.keys(files()).sort()).toEqual(['Apollo program.md', 'Gemini.md', 'Mercury.md']);
    mirror.stop();
  });

  it('waits for the folder to exist before mirroring', async () => {
    const { ctx, fake } = await desktopTestContext();
    stopActivationMirror();
    const mirror = new MarkdownMirror(ctx, getBackend(), { delayMs: 10 });
    mirror.start();
    await mirror.setEnabled(true);
    await mirror.runNow();
    expect(fake.state.mirror[ctx.workspace.info.id]).toBeUndefined();
    expect(mirror.status.get().error).toBeNull();
    mirror.stop();
  });
});
