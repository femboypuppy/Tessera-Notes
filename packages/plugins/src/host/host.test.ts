import type { PluginManifest } from '@tessera/core';
import { createTestAppContext, type TestAppContext } from '@tessera/core/testing';
import {
  defineBlock,
  definePlugin,
  type BlockContext,
  type PanelContext,
  type PluginApi,
  type PluginDefinition,
  type ThemeInfo,
} from '@tessera/plugin-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginCommandId, pluginPanelId } from '../constants';
import { PluginManager } from '../manager';
import { MemoryPluginStore } from '../store/memory-store';
import { bundle } from '../test/fixtures';
import { createInProcessSandboxes } from '../test/in-process-sandbox';
import { PluginConsoleStore } from './console';
import { PluginHost } from './plugin-host';

const theme: ThemeInfo = {
  mode: 'light',
  reducedMotion: false,
  tokens: { bg: '#fff', fg: '#111' },
};

interface Setup {
  app: TestAppContext;
  manager: PluginManager;
  host: PluginHost;
  consoles: PluginConsoleStore;
  modules: Map<string, unknown>;
  sandboxes: ReturnType<typeof createInProcessSandboxes>;
  install(
    definition: PluginDefinition | unknown,
    patch?: Partial<PluginManifest>,
    options?: { granted?: PluginManifest['permissions']; version?: string },
  ): Promise<void>;
  running(id?: string): Promise<void>;
}

let current: Setup | null = null;

async function setup(): Promise<Setup> {
  const app = await createTestAppContext();
  const manager = new PluginManager(new MemoryPluginStore());
  await manager.ready;
  const modules = new Map<string, unknown>();
  const sandboxes = createInProcessSandboxes(modules);
  const consoles = new PluginConsoleStore();
  const host = new PluginHost(app.ctx, {
    manager,
    console: consoles,
    sandboxes,
    theme: { read: () => theme, watch: () => () => undefined, fonts: async () => [] },
    panelComponent: () => () => null,
    emojiIcon: () => () => null,
    container: document.createElement('div'),
  });
  await host.start();
  let counter = 0;
  const value: Setup = {
    app,
    manager,
    host,
    consoles,
    modules,
    sandboxes,
    async install(definition, patch = {}, options = {}) {
      counter += 1;
      const code = `module-${counter}`;
      modules.set(code, definition);
      const next = bundle(patch, code);
      await manager.install(next, {
        granted: options.granted ?? next.manifest.permissions,
        source: { kind: 'file', name: 'test.zip' },
      });
    },
    async running(id = 'word-count') {
      await vi.waitFor(() => {
        const instance = host.instance(id);
        if (instance?.status !== 'running')
          throw new Error(`status ${instance?.status}: ${instance?.error ?? ''}`);
      });
    },
  };
  current = value;
  return value;
}

beforeEach(() => {
  current = null;
});

afterEach(async () => {
  if (!current) return;
  await current.host.dispose();
  await current.app.dispose();
  current = null;
});

const ALL = [
  'pages:read',
  'pages:write',
  'databases:read',
  'databases:write',
  'ui:commands',
  'ui:panels',
  'ui:blocks',
  'storage',
] as const;

describe('plugin lifecycle', () => {
  it('installs, activates and registers commands, panels and blocks', async () => {
    const s = await setup();
    await s.install(
      definePlugin({
        activate(api) {
          api.commands.register({
            id: 'hello',
            title: 'Say hello',
            shortcut: 'Mod+Shift+H',
            run: () => undefined,
          });
          api.ui.addPanel({ id: 'count', title: 'Word count', icon: '🔢' });
          api.ui.addBlock({ type: 'diagram', title: 'Diagram', initialData: { code: 'A-->B' } });
        },
        panels: { count: () => undefined },
        blocks: { diagram: () => undefined },
      }),
      { permissions: ['ui:commands', 'ui:panels', 'ui:blocks'] },
    );
    await s.running();
    await vi.waitFor(() => expect(s.host.instance('word-count')?.registeredBlocks).toHaveLength(1));
    const command = s.app.ctx.commands.get(pluginCommandId('word-count', 'hello'));
    expect(command).toMatchObject({
      title: 'Word count: Say hello',
      shortcut: 'Mod+Shift+H',
      group: 'plugins',
    });
    expect(s.app.ctx.contributions.list('pageSidePanels').map((panel) => panel.id)).toContain(
      pluginPanelId('word-count', 'count'),
    );
    const item = s.app.ctx.blocks
      .slashMenuItems()
      .find((entry) => entry.id === 'plugin:word-count/diagram');
    expect(item).toMatchObject({ title: 'Diagram', group: 'plugins', icon: '🧩' });
    await expect(Promise.resolve(item?.create({ app: s.app.ctx, pageId: 'p' }))).resolves.toEqual({
      kind: 'plugin:word-count/diagram',
      data: { code: 'A-->B' },
    });
  });

  it('runs commands inside the plugin, which calls back into the API', async () => {
    const s = await setup();
    await s.install(
      definePlugin({
        activate(api) {
          api.commands.register({
            id: 'greet',
            title: 'Greet',
            run: ({ pageId }) =>
              api.ui.notify({ title: `Hello ${pageId ?? 'nobody'}`, variant: 'success' }),
          });
        },
      }),
      { permissions: ['ui:commands'] },
    );
    await s.running();
    await vi.waitFor(() =>
      expect(s.app.ctx.commands.has(pluginCommandId('word-count', 'greet'))).toBe(true),
    );
    s.app.shell.currentPageId = 'page-7';
    await s.app.ctx.commands.execute(pluginCommandId('word-count', 'greet'));
    expect(s.app.shell.toasts.at(-1)).toEqual({
      title: 'Hello page-7',
      description: 'From Word count',
      variant: 'success',
    });
  });

  it('disables and enables: registrations go and come back, deactivate runs', async () => {
    const s = await setup();
    const deactivated = vi.fn();
    await s.install(
      definePlugin({
        activate(api) {
          api.commands.register({ id: 'a', title: 'A', run: () => undefined });
        },
        deactivate: deactivated,
      }),
      { permissions: ['ui:commands'] },
    );
    await s.running();
    await vi.waitFor(() => expect(s.app.ctx.commands.has('plugins.word-count/a')).toBe(true));
    await s.manager.setEnabled('word-count', false);
    await vi.waitFor(() => expect(s.host.instance('word-count')?.status).toBe('stopped'));
    expect(deactivated).toHaveBeenCalledTimes(1);
    expect(s.app.ctx.commands.has('plugins.word-count/a')).toBe(false);
    expect(s.sandboxes.sandboxes.every((sandbox) => sandbox.destroyed)).toBe(true);
    await s.manager.setEnabled('word-count', true);
    await s.running();
    await vi.waitFor(() => expect(s.app.ctx.commands.has('plugins.word-count/a')).toBe(true));
  });

  it('updates: restarts with the new code and keeps storage', async () => {
    const s = await setup();
    await s.install(
      definePlugin({
        async activate(api) {
          await api.storage.set('visits', 1);
        },
      }),
      { permissions: ['storage', 'ui:commands'] },
    );
    await s.running();
    await vi.waitFor(async () =>
      expect(await s.manager.storageGet('word-count', 'visits')).toBe(1),
    );
    await s.install(
      definePlugin({
        async activate(api) {
          const visits = (await api.storage.get<number>('visits')) ?? 0;
          await api.storage.set('visits', visits + 1);
        },
      }),
      { version: '1.1.0', permissions: ['storage', 'ui:commands'] },
    );
    await s.running();
    await vi.waitFor(async () =>
      expect(await s.manager.storageGet('word-count', 'visits')).toBe(2),
    );
    expect(s.manager.get('word-count')?.manifest.version).toBe('1.1.0');
  });

  it('uninstalls: stops the plugin and clears its storage', async () => {
    const s = await setup();
    await s.install(
      definePlugin({
        async activate(api) {
          await api.storage.set('secret', 'kept on this device');
          api.commands.register({ id: 'a', title: 'A', run: () => undefined });
        },
      }),
      { permissions: ['storage', 'ui:commands'] },
    );
    await s.running();
    await vi.waitFor(() => expect(s.app.ctx.commands.has('plugins.word-count/a')).toBe(true));
    await s.manager.uninstall('word-count');
    await vi.waitFor(() => expect(s.app.ctx.commands.has('plugins.word-count/a')).toBe(false));
    expect(s.host.instance('word-count')).toBeUndefined();
    expect(await s.manager.storageKeys('word-count')).toEqual([]);
  });

  it('revoking a permission restarts the plugin; calls needing it get a friendly error', async () => {
    const s = await setup();
    let api: PluginApi | null = null;
    await s.install(
      definePlugin({
        activate(value) {
          api = value;
        },
      }),
      { permissions: ['pages:read', 'ui:panels'] },
    );
    await s.running();
    s.app.ctx.workspace.createPage({ title: 'Apollo' });
    const first = api as PluginApi | null;
    await expect(first?.pages.list()).resolves.toHaveLength(1);
    await s.manager.setPermission('word-count', 'pages:read', false);
    await vi.waitFor(() => expect(api).not.toBe(first));
    await s.running();
    const second = api as PluginApi | null;
    await expect(second?.pages.list()).rejects.toMatchObject({
      name: 'PluginError',
      code: 'permission_denied',
      message:
        'Word count doesn’t have permission to read your pages. You can allow it in Settings → Plugins.',
    });
    const toast = s.app.shell.toasts.at(-1);
    expect(toast).toMatchObject({
      title: 'Word count needs permission to read your pages',
      variant: 'warning',
    });
    toast?.action?.onClick();
    expect(s.app.shell.navigations.at(-1)).toEqual({ path: '/settings/plugins?plugin=word-count' });
  });

  it('the host refuses calls without permission even when the runtime is bypassed', async () => {
    const s = await setup();
    await s.install(definePlugin({}), { permissions: [] });
    await s.running();
    const worker = s.sandboxes.sandboxes.find((sandbox) => sandbox.kind === 'worker');
    worker?.send({ v: 1, type: 'request', id: 4242, method: 'pages.list' });
    worker?.send({
      v: 1,
      type: 'request',
      id: 4243,
      method: 'storage.set',
      params: { key: 'x', value: 1 },
    });
    await vi.waitFor(() => {
      const answers = (worker?.received ?? []).filter(
        (message) => (message as { type?: string }).type === 'response',
      ) as Array<{ id: number; error?: { code: string } }>;
      expect(
        answers.filter((answer) => answer.id >= 4242).map((answer) => answer.error?.code),
      ).toEqual(['permission_denied', 'permission_denied']);
    });
    expect(await s.manager.storageKeys('word-count')).toEqual([]);
  });

  it('stops a plugin that stops answering, and the app keeps working', async () => {
    const s = await setup();
    await s.install(
      definePlugin({
        activate(api) {
          api.commands.register({ id: 'spin', title: 'Spin forever', run: () => undefined });
        },
      }),
      { permissions: ['ui:commands'] },
    );
    await s.install(
      definePlugin({
        activate(api) {
          api.commands.register({ id: 'fine', title: 'Still fine', run: () => undefined });
        },
      }),
      { id: 'other', name: 'Other', permissions: ['ui:commands'] },
    );
    await s.running('word-count');
    await s.running('other');
    const worker = s.sandboxes.sandboxes.find((sandbox) => sandbox.code === 'module-1');
    if (!worker) throw new Error('no worker');
    worker.frozen = true;
    await vi.waitFor(() => expect(s.host.instance('word-count')?.status).toBe('crashed'), {
      timeout: 10_000,
      interval: 100,
    });
    expect(s.host.instance('word-count')?.error).toBe(
      'Word count stopped responding and was stopped.',
    );
    expect(worker.destroyed).toBe(true);
    expect(s.app.ctx.commands.has('plugins.word-count/spin')).toBe(false);
    expect(s.app.ctx.commands.has('plugins.other/fine')).toBe(true);
    expect(s.host.instance('other')?.status).toBe('running');
    const toast = s.app.shell.toasts.at(-1);
    expect(toast).toMatchObject({ variant: 'error', action: { label: 'Restart' } });
    expect(s.consoles.entries('word-count').at(-1)?.message).toMatch(/stopped responding/);
    // It can be restarted from the notification.
    worker.frozen = false;
    toast?.action?.onClick();
    await s.running();
  }, 20_000);

  it('contains failures: a throwing activate or a module that is not a plugin', async () => {
    const s = await setup();
    await s.install(
      definePlugin({
        activate() {
          throw new Error('kaboom');
        },
      }),
    );
    await s.install({ notAPlugin: true }, { id: 'broken', name: 'Broken' });
    await vi.waitFor(() => expect(s.host.instance('word-count')?.status).toBe('error'));
    await vi.waitFor(() => expect(s.host.instance('broken')?.status).toBe('error'));
    expect(s.host.instance('word-count')?.error).toMatch(/kaboom/);
    expect(s.host.instance('broken')?.error).toMatch(/doesn't export a plugin/);
  });

  it('keeps shortcuts that collide with other commands out, and says so', async () => {
    const s = await setup();
    await s.install(
      definePlugin({
        activate(api) {
          api.commands.register({
            id: 'search',
            title: 'Search',
            shortcut: 'Mod+K',
            run: () => undefined,
          });
          api.commands.register({
            id: 'single',
            title: 'Single',
            shortcut: 'X',
            run: () => undefined,
          });
        },
      }),
      { permissions: ['ui:commands'] },
    );
    await s.running();
    await vi.waitFor(() => expect(s.app.ctx.commands.has('plugins.word-count/single')).toBe(true));
    expect(s.app.ctx.commands.get('plugins.word-count/search')?.shortcut).toBeUndefined();
    expect(s.app.ctx.commands.get('plugins.word-count/single')?.shortcut).toBeUndefined();
    const messages = s.consoles.entries('word-count').map((entry) => entry.message);
    expect(messages.some((message) => message.includes('Mod+K'))).toBe(true);
  });
});

describe('plugin API through the sandbox runtime', () => {
  async function withApi(permissions: PluginManifest['permissions'] = [...ALL]) {
    const s = await setup();
    let api: PluginApi | null = null;
    await s.install(
      definePlugin({
        settings: {
          goal: { type: 'number', label: 'Goal', default: 500, min: 1 },
        },
        activate(value) {
          api = value;
        },
      }),
      { permissions },
    );
    await s.running();
    if (!api) throw new Error('not activated');
    return { s, api: api as PluginApi };
  }

  it('creates, reads, updates and lists pages in markdown and as documents', async () => {
    const { s, api } = await withApi();
    const parent = s.app.ctx.workspace.createPage({ title: 'Journal' });
    const page = await api.pages.create({
      title: 'Today',
      parentId: parent.id,
      icon: '📅',
      content: '# Plan\n\nShip it',
    });
    expect(page).toMatchObject({
      title: 'Today',
      icon: '📅',
      parentId: parent.id,
      kind: 'page',
      isRow: false,
    });
    const markdown = await api.pages.get(page.id);
    expect(markdown.content).toContain('Ship it');
    const doc = await api.pages.get(page.id, { format: 'doc' });
    expect(doc.content.content?.[0]).toMatchObject({ type: 'heading' });
    await api.pages.update(page.id, {
      title: 'Tomorrow',
      icon: null,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rest' }] }],
      },
    });
    expect(s.app.ctx.workspace.getPage(page.id)).toMatchObject({ title: 'Tomorrow' });
    expect((await api.pages.get(page.id)).content).toContain('Rest');
    expect((await api.pages.list({ parentId: parent.id })).map((p) => p.title)).toEqual([
      'Tomorrow',
    ]);
    await expect(
      api.pages.update(page.id, { content: { type: 'doc', content: [{ type: 'nope' }] } }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.pages.get('missing')).rejects.toMatchObject({ code: 'not_found' });
    await api.pages.open(page.id);
    expect(s.app.shell.navigations.at(-1)).toEqual({ pageId: page.id });
    expect(await api.pages.current()).toBe(page.id);
  });

  it('keeps only the block IDs that links point at in page markdown', async () => {
    const { s, api } = await withApi();
    const para = (text: string, blockId: string) => ({
      type: 'paragraph',
      attrs: { blockId },
      content: [{ type: 'text', text }],
    });
    const page = await api.pages.create({
      title: 'Checklist',
      content: { type: 'doc', content: [para('Linked step', 'step-1'), para('Plain', 'step-2')] },
    });
    await api.pages.create({
      title: 'Notes',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'pageLink', attrs: { pageId: page.id, blockRef: 'step-1' } }],
          },
        ],
      },
    });
    const serialize = vi.spyOn(s.app.ctx.services.markdownCodec, 'serialize');
    await api.pages.get(page.id);
    const keep = serialize.mock.calls.at(-1)?.[1]?.keepBlockId;
    expect(keep?.('step-1')).toBe(true);
    expect(keep?.('step-2')).toBe(false);
  });

  it('reports page changes to subscribers only', async () => {
    const { s, api } = await withApi();
    const events: string[] = [];
    const stop = api.pages.onChange((event) => events.push(`${event.type}:${event.local}`));
    // Requests are handled in order, so once this answers the subscription is in place.
    await api.pages.current();
    const page = s.app.ctx.workspace.createPage({ title: 'Watched' });
    s.app.ctx.workspace.renamePage(page.id, 'Renamed');
    s.app.ctx.workspace.trashPage(page.id);
    await vi.waitFor(() =>
      expect(events).toEqual(['created:true', 'updated:true', 'trashed:true']),
    );
    stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    s.app.ctx.workspace.createPage({ title: 'Unwatched' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toHaveLength(3);
  });

  it('queries and writes databases by property and option names', async () => {
    const { s, api } = await withApi();
    const { page } = await s.app.ctx.workspace.createDatabase({
      title: 'Books',
      titlePropertyName: 'Name',
      viewName: 'Table',
    });
    const { addProperty } = await import('@tessera/core');
    const handle = await s.app.ctx.loadDatabaseDoc(page.id);
    addProperty(handle.doc, { name: 'Pages', type: 'number' });
    addProperty(handle.doc, {
      name: 'Status',
      type: 'select',
      options: [{ name: 'To read' }, { name: 'Done' }],
    });
    handle.release();
    expect((await api.databases.list()).map((db) => db.title)).toEqual(['Books']);
    const schema = await api.databases.get(page.id);
    expect(schema.properties.map((property) => property.name)).toEqual(['Name', 'Pages', 'Status']);
    const dune = await api.databases.addRow(page.id, {
      values: { Name: 'Dune', Pages: 412, Status: 'Done' },
    });
    await api.databases.addRow(page.id, {
      title: 'Hyperion',
      values: { Pages: 482, Status: 'to read' },
    });
    const { rows, total } = await api.databases.query(page.id, {
      filters: [{ property: 'Status', operator: 'equals', value: 'Done' }],
    });
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ id: dune.id, title: 'Dune' });
    await api.databases.updateRow(page.id, dune.id, { values: { Pages: 500 } });
    const sorted = await api.databases.query(page.id, {
      sorts: [{ property: 'Pages', direction: 'descending' }],
    });
    expect(sorted.rows.map((row) => row.title)).toEqual(['Dune', 'Hyperion']);
    await expect(
      api.databases.addRow(page.id, { values: { Pages: 'many' } }),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(api.databases.query('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('shares storage changes between the worker and a block frame', async () => {
    const s = await setup();
    let workerApi: PluginApi | null = null;
    let blockContext: BlockContext | null = null;
    const seen: Array<[string, unknown]> = [];
    await s.install(
      definePlugin({
        activate(api) {
          workerApi = api;
          api.ui.addBlock({ type: 'counter', title: 'Counter' });
        },
        blocks: {
          counter: defineBlock<{ count: number }>((ctx) => {
            blockContext = ctx as unknown as BlockContext;
            ctx.api.storage.onChange((key, value) => seen.push([key, value]));
            const label = ctx.root.ownerDocument.createElement('span');
            label.textContent = `Count: ${ctx.data?.count ?? 0}`;
            ctx.root.append(label);
            ctx.onChange((state) => {
              label.textContent = `Count: ${state.data?.count ?? 0}`;
            });
          }),
        },
      }),
      { permissions: ['storage', 'ui:blocks'] },
    );
    await s.running();
    const instance = s.host.instance('word-count');
    await vi.waitFor(() => expect(instance?.hasBlock('counter')).toBe(true));
    const setBlockData = vi.fn();
    const onReady = vi.fn();
    let readOnly = false;
    const container = document.createElement('div');
    const controller = instance?.mountSurface({
      container,
      title: 'Counter',
      surface: {
        kind: 'block',
        type: 'counter',
        pageId: 'p',
        blockId: 'b1',
        data: { count: 1 },
        readOnly: false,
        selected: false,
      },
      callbacks: {
        onReady,
        onError: (message) => {
          throw new Error(message);
        },
        setBlockData,
        isReadOnly: () => readOnly,
      },
    });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
    const frame = s.sandboxes.sandboxes.find((sandbox) => sandbox.kind === 'ui');
    expect(frame?.document?.getElementById('root')?.textContent).toBe('Count: 1');
    expect(frame?.document?.documentElement.style.getPropertyValue('--tess-bg')).toBe('#fff');
    // Plugin → host: data changes go through the editor's updateData.
    const block = blockContext as BlockContext | null;
    await block?.setData({ count: 2 });
    expect(setBlockData).toHaveBeenCalledWith({ count: 2 });
    expect(frame?.document?.getElementById('root')?.textContent).toBe('Count: 2');
    // Host → plugin: undo or a collaborator changes the data.
    controller?.update({ data: { count: 7 } });
    await vi.waitFor(() =>
      expect(frame?.document?.getElementById('root')?.textContent).toBe('Count: 7'),
    );
    // Read-only blocks are enforced by the host too.
    readOnly = true;
    controller?.update({ readOnly: true });
    await vi.waitFor(() => expect(block?.readOnly).toBe(true));
    const raw = frame;
    raw?.send({
      v: 1,
      type: 'request',
      id: 999,
      method: 'block.setData',
      params: { data: { count: 99 } },
    });
    await vi.waitFor(() =>
      expect(
        raw?.received.some(
          (message) =>
            (message as { id?: number; error?: { code: string } }).id === 999 &&
            (message as { error?: { code: string } }).error?.code === 'invalid_operation',
        ),
      ).toBe(true),
    );
    // Storage written by the worker reaches the block.
    await vi.waitFor(() => expect(frame?.received.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await (workerApi as PluginApi | null)?.storage.set('total', 42);
    await vi.waitFor(() => expect(seen).toContainEqual(['total', 42]));
    controller?.destroy();
    expect(frame?.destroyed).toBe(true);
  });

  it('renders panels and follows the open page and the theme', async () => {
    const s = await setup();
    let panelContext: PanelContext | null = null;
    const pages: Array<string | null> = [];
    await s.install(
      definePlugin({
        activate(api) {
          api.ui.addPanel({ id: 'info', title: 'Info' });
        },
        panels: {
          info(ctx) {
            panelContext = ctx;
            ctx.onPageChange((pageId) => pages.push(pageId));
          },
        },
      }),
      { permissions: ['ui:panels'] },
    );
    await s.running();
    const instance = s.host.instance('word-count');
    await vi.waitFor(() => expect(instance?.registeredPanels).toHaveLength(1));
    const onReady = vi.fn();
    const closePanel = vi.fn();
    const controller = instance?.mountSurface({
      container: document.createElement('div'),
      title: 'Info',
      surface: { kind: 'panel', id: 'info', pageId: 'a' },
      callbacks: {
        onReady,
        onError: (message) => {
          throw new Error(message);
        },
        closePanel,
      },
    });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
    const ctx = panelContext as PanelContext | null;
    expect(ctx?.pageId).toBe('a');
    controller?.update({ pageId: 'b' });
    await vi.waitFor(() => expect(pages).toEqual(['b']));
    // A theme change reaches the plugin, and the frame's color scheme follows it.
    instance?.pushTheme({ ...theme, mode: 'dark' });
    expect(s.sandboxes.sandboxes.find((sandbox) => sandbox.kind === 'ui')?.colorScheme).toBe(
      'dark',
    );
    await vi.waitFor(() => expect(ctx?.api.theme.get().mode).toBe('dark'));
    ctx?.close();
    await vi.waitFor(() => expect(closePanel).toHaveBeenCalled());
    controller?.destroy();
  });

  it('closes a panel whose code ran too long without a break, and says so in its place', async () => {
    const s = await setup();
    await s.install(
      definePlugin({
        activate(api) {
          api.ui.addPanel({ id: 'info', title: 'Info' });
        },
        panels: { info: () => undefined },
      }),
      { permissions: ['ui:panels'] },
    );
    await s.running();
    const instance = s.host.instance('word-count');
    await vi.waitFor(() => expect(instance?.registeredPanels).toHaveLength(1));
    const onReady = vi.fn();
    const onError = vi.fn();
    instance?.mountSurface({
      container: document.createElement('div'),
      title: 'Info',
      surface: { kind: 'panel', id: 'info', pageId: null },
      callbacks: { onReady, onError },
    });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
    const frame = s.sandboxes.sandboxes.find((sandbox) => sandbox.kind === 'ui');
    // What the frame's guard sends when it stops the plugin's code (sandbox/instrument.ts).
    frame?.send({ v: 1, type: 'notify', method: 'unresponsive', params: { ms: 2_140 } });
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Word count stopped responding and was stopped.'),
    );
    expect(frame?.destroyed).toBe(true);
    expect(s.consoles.entries('word-count').at(-1)?.message).toBe(
      'A panel ran without a break for 2.1 s and was closed.',
    );
    // Only the panel closed: the plugin keeps running.
    expect(instance?.status).toBe('running');
  });

  it('gets panel and block code ready as the plugin starts, and forgets it on uninstall', async () => {
    const s = await setup();
    const prepareUi = vi.fn();
    const forget = vi.fn();
    Object.assign(s.sandboxes, { prepareUi, forget });
    const createUi = vi.spyOn(s.sandboxes, 'createUi');
    await s.install(definePlugin({ activate: () => undefined }));
    await s.running();
    // Nothing to show, nothing to prepare.
    expect(prepareUi).not.toHaveBeenCalled();
    await s.install(
      definePlugin({
        activate(api) {
          api.ui.addBlock({ type: 'counter', title: 'Counter' });
        },
        blocks: { counter: () => undefined },
      }),
      { version: '1.1.0', permissions: ['ui:blocks'] },
    );
    await vi.waitFor(() => expect(prepareUi).toHaveBeenCalledOnce());
    const plugin = s.manager.get('word-count');
    const key = { slot: 'word-count', hash: plugin?.hash };
    expect(prepareUi).toHaveBeenCalledWith(s.sandboxes.sandboxes.at(-1)?.code, key);
    await vi.waitFor(() => expect(s.host.instance('word-count')?.hasBlock('counter')).toBe(true));
    const onReady = vi.fn();
    s.host.instance('word-count')?.mountSurface({
      container: document.createElement('div'),
      title: 'Counter',
      surface: {
        kind: 'block',
        type: 'counter',
        pageId: 'p',
        blockId: 'b',
        data: null,
        readOnly: false,
        selected: false,
      },
      callbacks: { onReady, onError: vi.fn() },
    });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(createUi).toHaveBeenCalledWith(expect.objectContaining({ cacheKey: key }));
    await s.manager.uninstall('word-count');
    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith('word-count'));
  });

  it('records the declared settings, validates changes and pushes them to the plugin', async () => {
    const { s, api } = await withApi();
    await vi.waitFor(() => expect(s.manager.get('word-count')?.settingsSchema).toBeDefined());
    expect(api.settings.get('goal')).toBe(500);
    const changes: unknown[] = [];
    api.settings.onChange((values, key) => changes.push([key, values.goal]));
    await api.settings.set('goal', 750);
    await vi.waitFor(() => expect(api.settings.get('goal')).toBe(750));
    expect(changes).toContainEqual(['goal', 750]);
    await expect(api.settings.set('goal', 0)).rejects.toThrow(/at least 1/);
    await s.manager.setSetting('word-count', 'goal', 1000);
    await vi.waitFor(() => expect(api.settings.get('goal')).toBe(1000));
  });

  it('limits notifications and never lets one plugin impersonate the app', async () => {
    const { s, api } = await withApi();
    for (let i = 0; i < 5; i += 1) await api.ui.notify(`Note ${i}`);
    await expect(api.ui.notify('One too many')).rejects.toMatchObject({ code: 'unavailable' });
    expect(
      s.app.shell.toasts.filter((toast) => toast.description === 'From Word count'),
    ).toHaveLength(5);
  });
});
