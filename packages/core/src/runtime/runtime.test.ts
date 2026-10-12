import { describe, expect, it, vi } from 'vitest';
import { getRow, listProperties, listRows, listViews } from '../database/database-doc';
import { InvalidOperationError, NotFoundError, ValidationError } from '../errors';
import { getPageProps, setPageProp } from '../model/page-doc';
import { build as b } from '../schema/builders';
import { readDocJSON, writeDocJSON } from '../schema/ydoc';
import { MemoryDocStore } from '../services/doc-store';
import { defineService, SERVICE_PRIORITY, type AnyServiceRegistration } from '../services/registry';
import { createTestAppContext } from '../testing/index';
import type { TesseraEvents } from './events';
import { defineFeature } from './feature';
import { SETTING_KEYS } from './settings';

type Recorded = { [K in keyof TesseraEvents]: [K, TesseraEvents[K]] }[keyof TesseraEvents];

function record(ctx: {
  events: {
    on: <K extends keyof TesseraEvents>(
      type: K,
      handler: (payload: TesseraEvents[K]) => void,
    ) => () => void;
  };
}) {
  const seen: Recorded[] = [];
  const types: Array<keyof TesseraEvents> = [
    'page.created',
    'page.renamed',
    'page.moved',
    'page.trashed',
    'page.restored',
    'page.deleted',
    'doc.changed',
    'database.changed',
    'settings.changed',
    'user.changed',
  ];
  for (const type of types)
    ctx.events.on(type, (payload) => seen.push([type, payload] as Recorded));
  return seen;
}

describe('workspace session', () => {
  it('runs page operations and emits page events', async () => {
    const { ctx, dispose } = await createTestAppContext();
    const seen = record(ctx);
    const parent = ctx.workspace.createPage({ title: 'Parent' });
    const child = ctx.workspace.createPage({ title: 'Child', parentId: parent.id });
    ctx.workspace.renamePage(child.id, 'Renamed child');
    ctx.workspace.movePage(child.id, { parentId: null });
    ctx.workspace.movePage(child.id, { parentId: parent.id });
    ctx.workspace.setIcon(parent.id, '🪐');
    ctx.workspace.setFavorite(parent.id, true);
    ctx.workspace.trashPage(parent.id);
    ctx.workspace.restorePage(parent.id);
    const types = seen.map(([type]) => type);
    expect(types).toEqual([
      'page.created',
      'page.created',
      'page.renamed',
      'page.moved',
      'page.moved',
      'page.trashed',
      'page.restored',
    ]);
    const trashed = seen.find(([type]) => type === 'page.trashed');
    expect(trashed?.[1]).toMatchObject({
      pageId: parent.id,
      affectedPageIds: [parent.id, child.id],
      local: true,
    });
    expect(ctx.workspace.getPage(parent.id)).toMatchObject({
      icon: '🪐',
      favorite: true,
      createdBy: ctx.currentUser.id,
    });
    expect(
      ctx.workspace.pages
        .getSnapshot()
        .children(parent.id)
        .map((p) => p.title),
    ).toEqual(['Renamed child']);
    await dispose();
  });

  it('emits doc.changed and bumps updatedAt when page content changes', async () => {
    const { ctx, flush, dispose } = await createTestAppContext();
    const seen = record(ctx);
    const page = ctx.workspace.createPage({ title: 'Notes' });
    const before = ctx.workspace.getPage(page.id)?.updatedAt ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const handle = await ctx.loadPageDoc(page.id);
    writeDocJSON(handle.doc, b.doc('Hello'));
    handle.release();
    await flush();
    expect(seen.filter(([type]) => type === 'doc.changed').map(([, payload]) => payload)).toEqual([
      { pageId: page.id, docName: `page:${page.id}`, local: true },
    ]);
    expect(ctx.workspace.getPage(page.id)?.updatedAt).toBeGreaterThan(before);
    await dispose();
  });

  it('touches every page edited in a burst in one workspace change', async () => {
    // A real delay, as in the app (test contexts touch at once); `flush` runs the batch.
    const { ctx, flush, dispose } = await createTestAppContext({
      runtime: { touchDebounceMs: 1_000 },
    });
    const pages = Array.from({ length: 50 }, (_, i) =>
      ctx.workspace.createPage({ title: `Note ${i}` }),
    );
    await flush();
    const before = new Map(
      pages.map((page) => [page.id, ctx.workspace.getPage(page.id)?.updatedAt]),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    let notifications = 0;
    const stop = ctx.workspace.pages.subscribe(() => (notifications += 1));
    for (const page of pages) {
      const handle = await ctx.loadPageDoc(page.id);
      writeDocJSON(handle.doc, b.doc(`Content of ${page.title}`));
      handle.release();
    }
    await flush();
    stop();
    // Every page got a new updatedAt, and the page index was rebuilt once, not 50 times.
    for (const page of pages)
      expect(ctx.workspace.getPage(page.id)?.updatedAt).toBeGreaterThan(before.get(page.id) ?? 0);
    expect(notifications).toBe(1);
    await dispose();
  });

  it('creates databases and rows, and rolls back rows with invalid values', async () => {
    const { ctx, dispose } = await createTestAppContext();
    const { page, titlePropertyId, viewId } = await ctx.workspace.createDatabase({
      title: 'Tasks',
      titlePropertyName: 'Name',
      viewName: 'Table',
    });
    expect(page.kind).toBe('database');
    const db = await ctx.loadDatabaseDoc(page.id);
    expect(listProperties(db.doc).map((p) => p.id)).toEqual([titlePropertyId]);
    expect(listViews(db.doc).map((v) => v.id)).toEqual([viewId]);
    const row = await ctx.workspace.addDatabaseRow(page.id, { title: 'Write the spec' });
    expect(ctx.workspace.pages.getSnapshot().isRow(row.id)).toBe(true);
    expect(getRow(db.doc, row.id)).toBeDefined();
    await expect(
      ctx.workspace.addDatabaseRow(page.id, { title: 'Bad', values: { missing: 1 } }),
    ).rejects.toThrow(NotFoundError);
    expect(
      ctx.workspace.pages
        .getSnapshot()
        .children(page.id, { includeRows: true })
        .map((p) => p.title),
    ).toEqual(['Write the spec']);
    await expect(ctx.workspace.addDatabaseRow(row.id)).rejects.toThrow(NotFoundError);
    db.release();
    await dispose();
  });

  it('creates many rows at once, in order, and leaves nothing behind on invalid values', async () => {
    const { ctx, dispose } = await createTestAppContext();
    const seen = record(ctx);
    const { page } = await ctx.workspace.createDatabase({
      title: 'Reading list',
      titlePropertyName: 'Name',
      viewName: 'Table',
    });
    const db = await ctx.loadDatabaseDoc(page.id);
    const first = await ctx.workspace.addDatabaseRow(page.id, { title: 'First' });
    const last = await ctx.workspace.addDatabaseRow(page.id, { title: 'Last' });
    const rows = await ctx.workspace.addDatabaseRows(
      page.id,
      [{ title: 'Dune', icon: '📙' }, { title: 'Emma' }],
      { after: first.id },
    );
    expect(rows.map((row) => [row.title, row.parentId])).toEqual([
      ['Dune', page.id],
      ['Emma', page.id],
    ]);
    expect(rows[0]?.icon).toBe('📙');
    const snapshot = ctx.workspace.pages.getSnapshot();
    expect(rows.every((row) => snapshot.isRow(row.id))).toBe(true);
    expect(listRows(db.doc).map((row) => row.id)).toEqual([
      first.id,
      rows[0]?.id,
      rows[1]?.id,
      last.id,
    ]);
    expect(seen.filter(([type]) => type === 'page.created')).toHaveLength(5);

    const before = ctx.workspace.pages.getSnapshot().children(page.id, { includeRows: true });
    await expect(
      ctx.workspace.addDatabaseRows(page.id, [{ title: 'Fine' }, { values: { missing: 1 } }]),
    ).rejects.toThrow(NotFoundError);
    expect(ctx.workspace.pages.getSnapshot().children(page.id, { includeRows: true })).toEqual(
      before,
    );
    expect(listRows(db.doc)).toHaveLength(4);
    await expect(ctx.workspace.addDatabaseRows(first.id, [{ title: 'x' }])).rejects.toThrow(
      NotFoundError,
    );
    expect(await ctx.workspace.addDatabaseRows(page.id, [])).toEqual([]);
    db.release();
    await dispose();
  });

  it('resolves the credential store like any app service', async () => {
    const { ctx, runtime, dispose } = await createTestAppContext();
    expect(ctx.serviceSources.credentialStore).toBe('memory');
    await ctx.services.credentialStore.set('https://notes.example.com/sync', 'secret');
    expect(await ctx.services.credentialStore.get('https://notes.example.com')).toBe('secret');
    expect((await ctx.services.credentialStore.list()).map((entry) => entry.server)).toEqual([
      'https://notes.example.com',
    ]);
    await ctx.services.credentialStore.delete('https://notes.example.com/');
    expect(await ctx.services.credentialStore.list()).toEqual([]);
    expect(runtime.credentialStore).toBe(ctx.services.credentialStore);
    await dispose();

    const keychain = {
      get: vi.fn(async () => 'from-keychain'),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
    };
    const desktop = await createTestAppContext({
      features: [
        defineFeature({
          id: 'desktop',
          services: [
            defineService({
              provides: 'credentialStore',
              id: 'keychain',
              priority: SERVICE_PRIORITY.desktop,
              create: () => keychain,
            }) as AnyServiceRegistration,
          ],
        }),
      ],
    });
    expect(desktop.ctx.serviceSources.credentialStore).toBe('keychain');
    expect(await desktop.ctx.services.credentialStore.get('https://a.example')).toBe(
      'from-keychain',
    );
    await desktop.dispose();
  });

  it('saves files through a download link unless a platform provides a file saver', async () => {
    const { ctx, runtime, dispose } = await createTestAppContext();
    expect(ctx.serviceSources.fileSaver).toBe('download');
    expect(runtime.fileSaver).toBe(ctx.services.fileSaver);
    expect(ctx.services.fileSaver.mode).toBe('download');
    // Outside a browser there is nowhere to download to.
    await expect(
      ctx.services.fileSaver.save({ name: 'Notes.md', data: new Blob(['x']) }),
    ).rejects.toThrow(/browser/);
    await dispose();

    const native = {
      mode: 'dialog' as const,
      save: vi.fn(async () => ({ name: 'Notes.md', path: '/home/ada/Notes.md' })),
      print: vi.fn(async () => undefined),
    };
    const desktop = await createTestAppContext({
      features: [
        defineFeature({
          id: 'desktop',
          services: [
            defineService({
              provides: 'fileSaver',
              id: 'native-dialog',
              priority: SERVICE_PRIORITY.desktop,
              create: () => native,
            }) as AnyServiceRegistration,
          ],
        }),
      ],
    });
    expect(desktop.ctx.serviceSources.fileSaver).toBe('native-dialog');
    expect(desktop.ctx.services.fileSaver).toBe(native);
    await desktop.dispose();
  });

  it('deletes pages permanently with their docs and row entries', async () => {
    const { ctx, flush, runtime, dispose } = await createTestAppContext();
    const seen = record(ctx);
    const page = ctx.workspace.createPage({ title: 'Doomed' });
    const sub = ctx.workspace.createPage({ title: 'Sub', parentId: page.id });
    for (const id of [page.id, sub.id]) {
      const handle = await ctx.loadPageDoc(id);
      writeDocJSON(handle.doc, b.doc('content'));
      handle.release();
    }
    const { page: database } = await ctx.workspace.createDatabase({
      title: 'DB',
      titlePropertyName: 'Name',
      viewName: 'Table',
    });
    const row = await ctx.workspace.addDatabaseRow(database.id, { title: 'Row' });
    await flush();
    const store = ctx.services.docStore as MemoryDocStore;
    expect(await store.list('page:')).toEqual(
      expect.arrayContaining([`page:${page.id}`, `page:${sub.id}`]),
    );
    ctx.workspace.trashPage(page.id);
    const removed = await ctx.workspace.emptyTrash();
    expect(removed.map((p) => p.id).sort()).toEqual([page.id, sub.id].sort());
    expect(await store.list('page:')).not.toEqual(expect.arrayContaining([`page:${page.id}`]));
    expect(seen.filter(([type]) => type === 'page.deleted')).toHaveLength(2);
    await ctx.workspace.deletePagePermanently(row.id);
    const db = await ctx.loadDatabaseDoc(database.id);
    expect(listRows(db.doc)).toEqual([]);
    db.release();
    await ctx.workspace.deletePagePermanently(database.id);
    await flush();
    expect(await store.list('db:')).toEqual([]);
    expect(runtime.appServiceSources).toEqual({
      workspaceRegistry: 'memory',
      markdownCodec: 'basic',
      credentialStore: 'memory',
      fileSaver: 'download',
    });
    await dispose();
  });

  it('duplicates a page with its content and props', async () => {
    const { ctx, dispose } = await createTestAppContext();
    const page = ctx.workspace.createPage({ title: 'Original', icon: '📄' });
    const after = ctx.workspace.createPage({ title: 'After' });
    const handle = await ctx.loadPageDoc(page.id);
    writeDocJSON(handle.doc, b.doc(b.heading(1, 'Copied'), 'body'));
    setPageProp(handle.doc, 'aliases', ['Orig']);
    handle.release();
    const copy = await ctx.workspace.duplicatePage(page.id);
    expect(copy).toMatchObject({ title: 'Original', icon: '📄' });
    expect(
      ctx.workspace.pages
        .getSnapshot()
        .children(null)
        .map((p) => p.id),
    ).toEqual([page.id, copy.id, after.id]);
    const copied = await ctx.loadPageDoc(copy.id);
    expect(readDocJSON(copied.doc)).toEqual(readDocJSON((await ctx.loadPageDoc(page.id)).doc));
    expect(getPageProps(copied.doc).aliases).toEqual(['Orig']);
    copied.release();
    const { page: database } = await ctx.workspace.createDatabase({
      title: 'DB',
      titlePropertyName: 'Name',
      viewName: 'Table',
    });
    await expect(ctx.workspace.duplicatePage(database.id)).rejects.toThrow(InvalidOperationError);
    await dispose();
  });

  it('exposes settings and the current user with change events', async () => {
    const { ctx, runtime, dispose } = await createTestAppContext();
    const seen = record(ctx);
    ctx.settings.workspace.set('backlinks.showFooter', true);
    ctx.settings.device.set('editor.spellcheck', false);
    runtime.updateCurrentUser({ name: 'Grace Hopper', color: '#46a758' });
    expect(ctx.currentUser).toMatchObject({ name: 'Grace Hopper', color: '#46a758' });
    expect(seen).toEqual(
      expect.arrayContaining([
        ['settings.changed', { scope: 'workspace', key: 'backlinks.showFooter' }],
        ['settings.changed', { scope: 'device', key: 'editor.spellcheck' }],
        ['user.changed', { user: expect.objectContaining({ name: 'Grace Hopper' }) }],
      ]),
    );
    const handle = await ctx.loadPageDoc(ctx.workspace.createPage().id);
    expect(handle.sync?.awareness.getLocalState()?.user).toMatchObject({ name: 'Grace Hopper' });
    handle.release();
    await dispose();
  });

  it('switches the user ID when the device setting changes (sign-in)', async () => {
    const { ctx, runtime, dispose } = await createTestAppContext();
    const deviceId = ctx.currentUser.id;
    expect(ctx.settings.device.get(SETTING_KEYS.userId)).toBe(deviceId);
    const seen = record(ctx);
    ctx.settings.device.set(SETTING_KEYS.userId, 'account-42');
    expect(ctx.currentUser.id).toBe('account-42');
    expect(runtime.getCurrentUser().id).toBe('account-42');
    expect(seen).toEqual(
      expect.arrayContaining([
        ['user.changed', { user: expect.objectContaining({ id: 'account-42' }) }],
      ]),
    );
    const page = ctx.workspace.createPage({ title: 'Signed in' });
    expect(page.createdBy).toBe('account-42');
    // An invalid value falls back to the device ID instead of breaking authorship.
    ctx.settings.device.set(SETTING_KEYS.userId, '');
    expect(ctx.currentUser.id).toBe(deviceId);
    await dispose();
  });

  it('delegates UI calls to the shell bridge', async () => {
    const { ctx, shell, dispose } = await createTestAppContext();
    ctx.navigate('abc', { heading: 'Intro' });
    expect(ctx.getCurrentPageId()).toBe('abc');
    ctx.navigateTo('/graph');
    ctx.openSidePanel('backlinks');
    ctx.closeSidePanel();
    ctx.toast('Saved');
    ctx.switchWorkspace('workspace-2');
    shell.confirmAnswer = false;
    expect(await ctx.confirm({ title: 'Delete?', destructive: true })).toBe(false);
    expect(shell.navigations).toEqual([
      { pageId: 'abc', options: { heading: 'Intro' } },
      { path: '/graph' },
    ]);
    expect(shell.panels).toEqual(['backlinks', null]);
    expect(shell.toasts).toEqual([{ title: 'Saved' }]);
    expect(shell.workspaceSwitches).toEqual(['workspace-2']);
    await dispose();
  });
});

describe('features', () => {
  it('registers static contributions, activates, runs commands and cleans up on close', async () => {
    const cleanup = vi.fn();
    const Body = () => null;
    const run = vi.fn();
    const feature = defineFeature({
      id: 'demo',
      routes: [
        { path: '/demo', component: Body },
        { path: '/capture', component: Body, layout: 'bare' },
      ],
      pageBodies: { page: Body },
      pageFooterSections: [{ id: 'demo-footer', component: Body }],
      overlays: [{ id: 'demo-overlay', component: Body }],
      workspaceMenuItems: [{ id: 'demo-open', title: 'Open folder', run }],
      pageSidePanels: [
        { id: 'demo-panel', title: 'Demo', order: 2, component: Body },
        { id: 'first', title: 'First', order: 1, component: Body },
      ],
      commands: [{ id: 'demo.hello', title: 'Hello', run }],
      blockRenderers: [{ kind: 'plugin:', component: Body }],
      activate: (ctx) => {
        ctx.commands.register({ id: 'demo.dynamic', title: 'Dynamic', run: () => undefined });
        return cleanup;
      },
    });
    const { ctx, shell, session, dispose } = await createTestAppContext({ features: [feature] });
    expect(ctx.contributions.list('routes').map((r) => [r.path, r.featureId, r.layout])).toEqual([
      ['/demo', 'demo', undefined],
      ['/capture', 'demo', 'bare'],
    ]);
    expect(ctx.contributions.list('pageFooterSections').map((c) => c.id)).toEqual(['demo-footer']);
    expect(ctx.contributions.list('overlays').map((c) => c.id)).toEqual(['demo-overlay']);
    expect(ctx.contributions.list('workspaceMenuItems').map((c) => [c.id, c.featureId])).toEqual([
      ['demo-open', 'demo'],
    ]);
    expect(ctx.contributions.list('pageBodies').map((r) => r.kind)).toEqual(['page']);
    expect(ctx.contributions.list('pageSidePanels').map((p) => p.id)).toEqual([
      'first',
      'demo-panel',
    ]);
    expect(ctx.commands.has('demo.dynamic')).toBe(true);
    expect(ctx.blocks.resolve('plugin:x/y')).toBeDefined();
    expect(ctx.importers.get('markdown-basic')).toBeDefined();
    shell.currentPageId = 'page-7';
    expect(await ctx.commands.execute('demo.hello', { args: 42 })).toBe(true);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'page-7', args: 42, source: 'api', app: ctx }),
    );
    expect(session.featureErrors.size).toBe(0);
    await dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('isolates a feature whose activate throws, including what it registered before failing', async () => {
    const onError = vi.fn();
    const Body = () => null;
    const onPageCreated = vi.fn();
    const broken = defineFeature({
      id: 'broken',
      pageSidePanels: [{ id: 'broken-panel', title: 'Broken', component: Body }],
      commands: [{ id: 'broken.cmd', title: 'Broken', run: () => undefined }],
      activate: (ctx) => {
        ctx.commands.register({ id: 'broken.dynamic', title: 'Dynamic', run: () => undefined });
        ctx.contributions.register('overlays', { id: 'broken-overlay', component: Body }, 'broken');
        ctx.blocks.register({ kind: 'broken-kind', component: Body });
        ctx.events.on('page.created', onPageCreated);
        throw new Error('activation failed');
      },
    });
    const healthy = defineFeature({
      id: 'healthy',
      commands: [{ id: 'healthy.cmd', title: 'Healthy', run: () => undefined }],
    });
    const { ctx, session, dispose } = await createTestAppContext({
      features: [broken, healthy],
      runtime: { onError },
    });
    expect(session.featureErrors.get('broken')?.message).toBe('activation failed');
    expect(ctx.contributions.list('pageSidePanels')).toEqual([]);
    expect(ctx.commands.has('broken.cmd')).toBe(false);
    expect(ctx.commands.has('broken.dynamic')).toBe(false);
    expect(ctx.contributions.list('overlays')).toEqual([]);
    expect(ctx.blocks.resolve('broken-kind')).toBeUndefined();
    ctx.workspace.createPage({ title: 'After the failure' });
    expect(onPageCreated).not.toHaveBeenCalled();
    expect(ctx.commands.has('healthy.cmd')).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { area: 'feature', source: 'broken' });
    await dispose();
  });

  it('drops duplicate feature IDs', async () => {
    const onError = vi.fn();
    const { runtime, dispose } = await createTestAppContext({
      features: [defineFeature({ id: 'same' }), defineFeature({ id: 'same' })],
      runtime: { onError },
    });
    expect(runtime.features).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await dispose();
  });

  it('uses feature services by priority and falls back when they fail', async () => {
    const onError = vi.fn();
    const created: string[] = [];
    const store = new MemoryDocStore();
    const services: AnyServiceRegistration[] = [
      defineService({
        provides: 'docStore',
        id: 'browser-store',
        priority: SERVICE_PRIORITY.browser,
        create: ({ workspace }) => {
          created.push(workspace.name);
          return store;
        },
      }) as AnyServiceRegistration,
      defineService({
        provides: 'docStore',
        id: 'desktop-store',
        priority: SERVICE_PRIORITY.desktop,
        isAvailable: () => false,
        create: () => store,
      }) as AnyServiceRegistration,
      defineService({
        provides: 'searchIndex',
        id: 'failing-search',
        priority: SERVICE_PRIORITY.browser,
        create: () => {
          throw new Error('worker blocked');
        },
      }) as AnyServiceRegistration,
    ];
    const { ctx, dispose } = await createTestAppContext({
      features: [defineFeature({ id: 'storage', services })],
      runtime: { onError },
      workspaceName: 'Research',
    });
    expect(created).toEqual(['Research']);
    expect(ctx.services.docStore).toBe(store);
    expect(ctx.serviceSources).toMatchObject({
      docStore: 'browser-store',
      searchIndex: 'naive',
      linkIndex: 'naive',
      syncProvider: 'local',
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      area: 'service',
      source: 'failing-search',
    });
    await dispose();
  });

  it('keeps in-memory data across closing and reopening a workspace', async () => {
    const { ctx, runtime, session, shell, workspace } = await createTestAppContext();
    const page = ctx.workspace.createPage({ title: 'Survivor' });
    const handle = await ctx.loadPageDoc(page.id);
    writeDocJSON(handle.doc, b.doc('still here'));
    handle.release();
    await session.close();
    const reopened = await runtime.openWorkspace(workspace, shell);
    expect(reopened.ctx.workspace.getPage(page.id)?.title).toBe('Survivor');
    const again = await reopened.ctx.loadPageDoc(page.id);
    expect(readDocJSON(again.doc).content[0]).toMatchObject({ content: [{ text: 'still here' }] });
    again.release();
    await reopened.close();
    await runtime.workspaceRegistry.remove(workspace.id);
    await runtime.dispose();
  });

  it('rejects invalid workspace operations with typed errors', async () => {
    const { ctx, dispose } = await createTestAppContext();
    expect(() => ctx.workspace.createPage({ icon: 'not an emoji' })).toThrow(ValidationError);
    expect(() => ctx.workspace.renamePage('missing', 'x')).toThrow(NotFoundError);
    await dispose();
  });
});
