import {
  addProperty,
  build as b,
  defineFeature,
  defineService,
  replaceTextWithPageLink,
  SERVICE_PRIORITY,
  setPageProp,
  updateDocJSON,
  writeDocJSON,
  type DocJSON,
  type JsonValue,
} from '@tessera/core';
import {
  createRecordingShell,
  createTestAppContext,
  type TestAppContext,
} from '@tessera/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdbPersistence, MemoryPersistence, type IndexPersistence } from '../engine/persistence';
import type { IndexRequest, IndexRequestType, IndexResults } from '../engine/protocol';
import { InProcessTransport } from '../engine/transport';
import { GraphLinkIndex } from './graph-link-index';
import { createLinkIndex, createSearchIndex } from './index';
import { MiniSearchIndex } from './minisearch-index';

/**
 * The in-process index behind a worker's message boundary: every request is cloned with its
 * transfer list, as `postMessage` does, so transferred buffers are detached on the sending side.
 */
class PostMessageTransport extends InProcessTransport {
  override request<T extends IndexRequestType>(
    request: Extract<IndexRequest, { type: T }>,
    transfer: Transferable[] = [],
  ): Promise<IndexResults[T]> {
    return super.request(structuredClone(request, { transfer }));
  }
}

function indexFeature(persistence: IndexPersistence, options: { retitleDelayMs?: number } = {}) {
  const transport = () => new PostMessageTransport({ persistence, saveDelayMs: 5 });
  return defineFeature({
    id: 'search',
    services: [
      defineService({
        provides: 'searchIndex',
        id: 'minisearch',
        priority: SERVICE_PRIORITY.browser,
        create: (context) => createSearchIndex(context, { transport, ...options }),
      }),
      defineService({
        provides: 'linkIndex',
        id: 'graph',
        priority: SERVICE_PRIORITY.browser,
        create: (context) => createLinkIndex(context, { transport, ...options }),
      }),
    ],
  });
}

const open: TestAppContext[] = [];

async function setup(
  persistence: IndexPersistence = new MemoryPersistence(),
  options: { retitleDelayMs?: number } = {},
) {
  const test = await createTestAppContext({ features: [indexFeature(persistence, options)] });
  open.push(test);
  const search = test.ctx.services.searchIndex;
  const links = test.ctx.services.linkIndex;
  if (!(search instanceof MiniSearchIndex) || !(links instanceof GraphLinkIndex))
    throw new Error('expected our indexes to win');
  return { test, search, links, ctx: test.ctx };
}

afterEach(async () => {
  for (const test of open.splice(0)) await test.dispose();
});

async function write(
  test: TestAppContext,
  pageId: string,
  doc: DocJSON,
  props: Record<string, JsonValue> = {},
) {
  const handle = await test.ctx.loadPageDoc(pageId);
  writeDocJSON(handle.doc, doc);
  for (const [key, value] of Object.entries(props)) setPageProp(handle.doc, key, value);
  handle.release();
  await test.flush();
}

const ids = (result: { hits: Array<{ pageId: string }> }) => result.hits.map((hit) => hit.pageId);

describe('MiniSearchIndex in a workspace session', () => {
  it('wins over the stubs and indexes what is already there', async () => {
    const { test, search, ctx } = await setup();
    expect(ctx.serviceSources).toMatchObject({ searchIndex: 'minisearch', linkIndex: 'graph' });
    const page = ctx.workspace.createPage({ title: 'Launch checklist' });
    await write(test, page.id, b.doc(b.paragraph('Fuel the booster')));
    await search.whenIdle();
    expect(ids(await search.query('booster'))).toEqual([page.id]);
    expect(search.status).toMatchObject({ state: 'ready', transport: 'in-process' });
  });

  it('follows adds, edits, renames, moves, trash, restore and delete', async () => {
    const { test, search, ctx } = await setup();
    const { workspace } = ctx;
    const apollo = workspace.createPage({ title: 'Apollo program' });
    const gemini = workspace.createPage({ title: 'Gemini' });
    const notes = workspace.createPage({ title: 'Mission notes', parentId: gemini.id });
    await write(test, apollo.id, b.doc(b.paragraph('The moon landing')));
    await write(test, notes.id, b.doc(b.paragraph('Docking practice')));
    await search.whenIdle();
    expect(ids(await search.query('moon'))).toEqual([apollo.id]);

    // Edit
    await write(test, apollo.id, b.doc(b.paragraph('The Saturn rocket')));
    await search.whenIdle();
    expect(ids(await search.query('saturn'))).toEqual([apollo.id]);
    expect((await search.query('moon')).total).toBe(0);

    // Rename (titles are searchable at once: no doc to read)
    workspace.renamePage(gemini.id, 'Gemini 4');
    expect((await search.query('gemini 4')).hits[0]).toMatchObject({
      pageId: gemini.id,
      title: 'Gemini 4',
    });

    // Move
    expect(ids(await search.query('docking in:"Apollo program"'))).toEqual([]);
    workspace.movePage(notes.id, { parentId: apollo.id });
    expect(ids(await search.query('docking in:"Apollo program"'))).toEqual([notes.id]);

    // Trash: gone immediately, descendants too
    workspace.trashPage(apollo.id);
    expect((await search.query('saturn')).total).toBe(0);
    expect((await search.query('docking')).total).toBe(0);

    // Restore
    workspace.restorePage(apollo.id);
    expect(ids(await search.query('saturn'))).toEqual([apollo.id]);
    expect(ids(await search.query('docking'))).toEqual([notes.id]);

    // Delete
    workspace.trashPage(apollo.id);
    await workspace.deletePagePermanently(apollo.id);
    await search.whenIdle();
    expect((await search.query('saturn')).total).toBe(0);
    expect((await search.query('')).hits.map((hit) => hit.pageId)).toEqual([gemini.id]);
  });

  it('finds pages and rows by the new title of a page they link to', async () => {
    const { test, search, ctx } = await setup();
    const apollo = ctx.workspace.createPage({ title: 'Apollo' });
    const notes = ctx.workspace.createPage({ title: 'Mission notes' });
    await write(test, notes.id, b.doc(b.paragraph('Read ', b.pageLink(apollo.id), ' first')));
    const { page: missions } = await ctx.workspace.createDatabase({
      title: 'Missions',
      titlePropertyName: 'Name',
      viewName: 'Table',
    });
    const handle = await ctx.loadDatabaseDoc(missions.id);
    const program = addProperty(handle.doc, {
      name: 'Program',
      type: 'relation',
      relation: { targetDatabaseId: null, limit: 'many' },
    });
    handle.release();
    const crew = await ctx.workspace.addDatabaseRow(missions.id, {
      title: 'Crew selection',
      values: { [program.id]: [apollo.id] },
    });
    await search.whenIdle();
    const linking = [apollo.id, notes.id, crew.id].sort();
    expect(ids(await search.query('apollo')).sort()).toEqual(linking);

    // Neither the notes nor the row changes: the text they show does.
    ctx.workspace.renamePage(apollo.id, 'Artemis');
    await search.whenIdle();
    expect(ids(await search.query('artemis')).sort()).toEqual(linking);
    expect(ids(await search.query('apollo'))).toEqual([]);
  });

  it('reads the pages that show a title again once it settles, not after every letter', async () => {
    const { test, search, ctx } = await setup(new MemoryPersistence(), { retitleDelayMs: 60_000 });
    const apollo = ctx.workspace.createPage({ title: 'A' });
    const notes = ctx.workspace.createPage({ title: 'Mission notes' });
    await write(test, notes.id, b.doc(b.paragraph('Read ', b.pageLink(apollo.id), ' first')));
    await search.whenIdle();
    const read = search.host.docsRead;

    // Typed letter by letter, each title reaches the index (a query waits for it).
    for (const title of ['Ar', 'Art', 'Arte', 'Artemis']) {
      ctx.workspace.renamePage(apollo.id, title);
      expect(ids(await search.query(title))).toContain(apollo.id);
    }
    expect(search.host.docsRead).toBe(read);
    expect(ids(await search.query('artemis'))).toEqual([apollo.id]);

    await search.whenIdle();
    expect(search.host.docsRead).toBe(read + 1);
    expect(ids(await search.query('artemis')).sort()).toEqual([apollo.id, notes.id].sort());
  });

  it('parses filters and combines them with options', async () => {
    const { test, search, ctx } = await setup();
    const space = ctx.workspace.createPage({ title: 'Space' });
    const tasks = ctx.workspace.createPage({ title: 'Launch tasks', parentId: space.id });
    const other = ctx.workspace.createPage({ title: 'Recipes' });
    await write(
      test,
      tasks.id,
      b.doc(b.taskList(b.taskItem(false, 'Fuel')), b.paragraph(b.tag('ops'))),
    );
    await write(
      test,
      other.id,
      b.doc(b.paragraph('Launch party snacks'), b.paragraph(b.tag('Ops'))),
    );
    await search.whenIdle();
    expect(ids(await search.query('launch is:task'))).toEqual([tasks.id]);
    expect(ids(await search.query('launch', { tags: ['#OPS'] })).sort()).toEqual(
      [other.id, tasks.id].sort(),
    );
    expect(ids(await search.query('#ops in:Space'))).toEqual([tasks.id]);
    expect(ids(await search.query('in:Nowhere'))).toEqual([]);
    expect(ids(await search.query('launch type:database'))).toEqual([]);
    expect(ids(await search.query('launch', { kinds: ['page'], withinPageId: space.id }))).toEqual([
      tasks.id,
    ]);
    const controller = new AbortController();
    controller.abort();
    await expect(search.query('launch', { signal: controller.signal })).rejects.toThrow(/aborted/);
  });

  it('indexes database row values', async () => {
    const { ctx, search } = await setup();
    const { page, titlePropertyId } = await ctx.workspace.createDatabase({
      title: 'Reading list',
      titlePropertyName: 'Name',
      viewName: 'Table',
    });
    expect(titlePropertyId).toBeTruthy();
    const handle = await ctx.loadDatabaseDoc(page.id);
    const { addProperty } = await import('@tessera/core');
    const author = addProperty(handle.doc, { name: 'Author', type: 'text' });
    handle.release();
    const row = await ctx.workspace.addDatabaseRow(page.id, {
      title: 'Dune',
      values: { [author.id]: 'Frank Herbert' },
    });
    await search.whenIdle();
    expect((await search.query('herbert')).hits[0]).toMatchObject({
      pageId: row.id,
      matchedIn: 'property',
    });
    expect(ids(await search.query('herbert', { includeRows: false }))).toEqual([]);
    expect(ids(await search.query('dune'))).toEqual([row.id]);
  });

  it('persists the index and only re-reads changed docs on the next start', async () => {
    const persistence = new MemoryPersistence();
    const { test, search, ctx } = await setup(persistence);
    const pages = Array.from({ length: 6 }, (_, i) =>
      ctx.workspace.createPage({ title: `Chapter ${i + 1}` }),
    );
    for (const [i, page] of pages.entries())
      await write(test, page.id, b.doc(b.paragraph(`Verse number ${i + 1} about comets`)));
    await search.whenIdle();
    const first = pages[0];
    if (!first) throw new Error('no pages');
    // Closing flushes the index to the persistence.
    await test.session.close();
    expect(persistence.entries.has(test.workspace.id)).toBe(true);

    // The workspace changes while closed only through its docs; reopen it.
    const shell = createRecordingShell();
    const reopened = await test.runtime.openWorkspace(test.workspace, shell);
    const again = reopened.ctx.services.searchIndex;
    if (!(again instanceof MiniSearchIndex)) throw new Error('expected MiniSearchIndex');
    await again.whenIdle();
    expect(again.status.restored).toBe(true);
    expect(again.host.docsRead).toBe(0);
    expect((await again.query('comets')).total).toBe(6);

    // Edit one page: only it is read again.
    const handle = await reopened.ctx.loadPageDoc(first.id);
    writeDocJSON(handle.doc, b.doc(b.paragraph('Now about asteroids')));
    handle.release();
    await reopened.flush();
    await again.whenIdle();
    expect(again.host.docsRead).toBe(1);
    expect(ids(await again.query('asteroids'))).toEqual([first.id]);
    await reopened.close();
  });

  it('rebuilds everything on request', async () => {
    const { test, search, ctx } = await setup();
    const page = ctx.workspace.createPage({ title: 'Nebula' });
    await write(test, page.id, b.doc(b.paragraph('Gas clouds')));
    await search.whenIdle();
    const before = search.host.docsRead;
    await search.rebuild();
    expect(search.host.docsRead).toBeGreaterThan(before);
    expect(ids(await search.query('clouds'))).toEqual([page.id]);
  });

  it('indexes pages and databases read in the same batch', async () => {
    const { test, search, ctx } = await setup();
    const page = ctx.workspace.createPage({ title: 'Nebula' });
    await write(test, page.id, b.doc(b.paragraph('Gas clouds')));
    const { page: database } = await ctx.workspace.createDatabase({
      title: 'Reading list',
      titlePropertyName: 'Name',
      viewName: 'Table',
    });
    const handle = await ctx.loadDatabaseDoc(database.id);
    const { addProperty } = await import('@tessera/core');
    const author = addProperty(handle.doc, { name: 'Author', type: 'text' });
    handle.release();
    const row = await ctx.workspace.addDatabaseRow(database.id, {
      title: 'Dune',
      values: { [author.id]: 'Frank Herbert' },
    });
    await search.whenIdle();
    const warnings: unknown[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => warnings.push(args));
    try {
      // A rebuild reads every doc again, so pages and databases share batches.
      await search.rebuild();
    } finally {
      warn.mockRestore();
    }
    expect(warnings).toEqual([]);
    expect(ids(await search.query('clouds'))).toEqual([page.id]);
    expect((await search.query('herbert')).hits[0]).toMatchObject({ pageId: row.id });
  });
});

describe('GraphLinkIndex in a workspace session', () => {
  it('keeps backlinks current and notifies subscribers', async () => {
    const { test, links, ctx } = await setup();
    const target = ctx.workspace.createPage({ title: 'Apollo' });
    const source = ctx.workspace.createPage({ title: 'Notes' });
    let notified = 0;
    const off = links.subscribe(() => {
      notified += 1;
    });
    await write(test, source.id, b.doc(b.paragraph('See ', b.pageLink(target.id))));
    await links.whenIdle();
    const backlinks = await links.backlinks(target.id);
    expect(backlinks.map((link) => [link.sourcePageId, link.blockText])).toEqual([
      [source.id, 'See Apollo'],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(notified).toBeGreaterThan(0);
    off();
    ctx.workspace.trashPage(source.id);
    expect(await links.backlinks(target.id)).toEqual([]);
    expect(await links.edges()).toEqual([]);
  });

  it('finds unlinked mentions and turns one into a link', async () => {
    const { test, links, ctx } = await setup();
    const apollo = ctx.workspace.createPage({ title: 'Apollo' });
    const notes = ctx.workspace.createPage({ title: 'Notes' });
    await write(test, apollo.id, b.doc('About the program'), { aliases: ['Project Apollo'] });
    await write(
      test,
      notes.id,
      b.doc(b.paragraph('The apollo missions and Project Apollo; apollonian is not one.')),
    );
    await links.whenIdle();
    const mentions = await links.unlinkedMentions(apollo.id);
    expect(mentions.map((mention) => mention.text)).toEqual(['apollo', 'Project Apollo']);
    const [first] = mentions;
    if (!first) throw new Error('expected a mention');
    const handle = await ctx.loadPageDoc(notes.id);
    updateDocJSON(handle.doc, (doc) =>
      replaceTextWithPageLink(doc, first, { pageId: apollo.id }, { expectedText: first.text }),
    );
    handle.release();
    await test.flush();
    await links.whenIdle();
    expect((await links.unlinkedMentions(apollo.id)).map((mention) => mention.text)).toEqual([
      'Project Apollo',
    ]);
    expect((await links.backlinks(apollo.id)).map((link) => link.sourcePageId)).toEqual([notes.id]);
    expect(await links.orphans()).toEqual([]);
  });

  it('builds graph snapshots with tags and neighborhoods', async () => {
    const { test, links, ctx } = await setup();
    const hub = ctx.workspace.createPage({ title: 'Hub' });
    const a = ctx.workspace.createPage({ title: 'A', parentId: hub.id });
    const lonely = ctx.workspace.createPage({ title: 'Lonely' });
    await write(test, a.id, b.doc(b.paragraph(b.pageLink(hub.id), ' ', b.tag('space'))));
    await links.whenIdle();
    const graph = await links.graph();
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([a.id, hub.id, lonely.id].sort());
    expect(graph.nodes.find((node) => node.id === a.id)).toMatchObject({
      rootId: hub.id,
      tags: ['space'],
    });
    expect(graph.edges).toEqual([{ source: a.id, target: hub.id, count: 1 }]);
    expect(await links.orphans()).toEqual([lonely.id]);
    expect((await links.neighborhood(hub.id, 1)).nodes.map((node) => node.id).sort()).toEqual(
      [a.id, hub.id].sort(),
    );
  });
});

describe('IdbPersistence', () => {
  it('round-trips an index through IndexedDB', async () => {
    const persistence = new IdbPersistence(new IDBFactory());
    const { test, search, ctx } = await setup(persistence);
    const page = ctx.workspace.createPage({ title: 'Stored page' });
    await write(test, page.id, b.doc(b.paragraph('Persisted words')));
    await search.whenIdle();
    await test.session.close();
    const stored = await persistence.load(test.workspace.id);
    expect(stored?.contents.map(([id]) => id)).toEqual([page.id]);
    await persistence.delete(test.workspace.id);
    expect(await persistence.load(test.workspace.id)).toBeNull();
  });
});
