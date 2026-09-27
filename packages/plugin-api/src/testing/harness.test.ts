// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { defineBlock, definePlugin, defineRenderer, PluginError } from '../index';
import { createTestHarness, docToMarkdown, markdownToDoc } from './index';

const plugin = definePlugin({
  settings: {
    greeting: { type: 'string', label: 'Greeting', default: 'Hello' },
  },
  activate(api) {
    api.commands.register({
      id: 'greet',
      title: 'Greet',
      run: async ({ pageId }) => {
        const page = pageId ? await api.pages.get(pageId) : null;
        await api.ui.notify(`${api.settings.get('greeting')}, ${page?.title ?? 'nobody'}`);
      },
    });
    api.ui.addPanel({ id: 'info', title: 'Info', icon: 'ℹ️' });
    api.ui.addBlock({ type: 'counter', title: 'Counter', initialData: { count: 0 } });
  },
  panels: {
    info(ctx) {
      const render = async () => {
        ctx.root.textContent = ctx.pageId ? (await ctx.api.pages.get(ctx.pageId)).title : 'none';
      };
      void render();
      const stop = ctx.onPageChange(() => void render());
      return () => {
        stop();
        ctx.root.textContent = 'closed';
      };
    },
  },
  blocks: {
    counter: defineBlock<{ count: number }>((ctx) => {
      const button = document.createElement('button');
      const show = () => {
        button.textContent = String(ctx.data?.count ?? 0);
      };
      button.addEventListener('click', () => {
        ctx.setData({ count: (ctx.data?.count ?? 0) + 1 }).catch((error: unknown) => {
          button.dataset.error = error instanceof PluginError ? error.code : 'unknown';
        });
      });
      ctx.onChange(show);
      show();
      ctx.root.append(button);
    }),
  },
});

describe('createTestHarness', () => {
  it('runs activate and commands against the in-memory workspace', async () => {
    const harness = createTestHarness(plugin, {
      pages: [{ id: 'apollo', title: 'Apollo', content: '# Apollo\n\nOne small step' }],
      currentPageId: 'apollo',
    });
    await harness.activate();
    expect(harness.commands.map((command) => command.id)).toEqual(['greet']);
    expect(harness.panels).toEqual([{ id: 'info', title: 'Info', icon: 'ℹ️' }]);
    expect(harness.blocks.map((block) => block.type)).toEqual(['counter']);
    await harness.runCommand('greet');
    harness.setSetting('greeting', 'Hi');
    await harness.runCommand('greet', { pageId: null });
    expect(harness.notifications).toEqual([{ title: 'Hello, Apollo' }, { title: 'Hi, nobody' }]);
    await harness.deactivate();
    expect(harness.commands).toEqual([]);
  });

  it('enforces permissions like the host', async () => {
    const harness = createTestHarness(plugin, { permissions: ['ui:panels', 'ui:blocks'] });
    await expect(harness.activate()).rejects.toMatchObject({
      name: 'PluginError',
      code: 'permission_denied',
      permission: 'ui:commands',
    });
    await expect(harness.api.pages.list()).rejects.toBeInstanceOf(PluginError);
    await expect(harness.api.storage.set('a', 1)).rejects.toThrow(/store data/);
  });

  it('only allows registrations in activate, not in panels and blocks', async () => {
    let error: unknown;
    const broken = definePlugin({
      panels: {
        p(ctx) {
          try {
            ctx.api.commands.register({ id: 'x', title: 'X', run: () => undefined });
          } catch (caught) {
            error = caught;
          }
        },
      },
    });
    await createTestHarness(broken).renderPanel('p');
    expect(error).toMatchObject({ code: 'invalid_operation' });
  });

  it('renders panels, follows the current page and runs cleanups', async () => {
    const harness = createTestHarness(plugin, {
      pages: [
        { id: 'a', title: 'Alpha' },
        { id: 'b', title: 'Beta' },
      ],
      currentPageId: 'a',
    });
    const panel = await harness.renderPanel('info');
    expect(panel.root.textContent).toBe('Alpha');
    harness.setCurrentPage('b');
    await harness.flush();
    expect(panel.root.textContent).toBe('Beta');
    await panel.close();
    expect(panel.root.textContent).toBe('closed');
  });

  it('renders blocks whose data changes through setData and from outside', async () => {
    const harness = createTestHarness(plugin);
    const block = await harness.renderBlock<{ count: number }>('counter', { data: { count: 2 } });
    const button = block.root.querySelector('button');
    expect(button?.textContent).toBe('2');
    button?.click();
    await harness.flush();
    expect(block.data).toEqual({ count: 3 });
    expect(button?.textContent).toBe('3');
    block.update({ data: { count: 10 } });
    expect(button?.textContent).toBe('10');
    block.update({ readOnly: true });
    button?.click();
    await harness.flush();
    expect(block.data).toEqual({ count: 10 });
    expect(button?.dataset.error).toBe('invalid_operation');
  });

  it('keeps storage private per harness and notifies listeners', async () => {
    const harness = createTestHarness(plugin, { storage: { seeded: true } });
    const changes: Array<[string, unknown]> = [];
    harness.api.storage.onChange((key, value) => changes.push([key, value]));
    await harness.api.storage.set('count', 3);
    await harness.api.storage.delete('seeded');
    expect(await harness.api.storage.keys()).toEqual(['count']);
    expect(changes).toEqual([
      ['count', 3],
      ['seeded', undefined],
    ]);
    expect(createTestHarness(plugin).storage.size).toBe(0);
  });

  it('reads and writes pages in markdown or as documents and reports changes', async () => {
    const harness = createTestHarness(plugin, { pages: [{ id: 'log', title: 'Log' }] });
    const events: string[] = [];
    harness.api.pages.onChange((event) => events.push(`${event.type}:${event.local}`));
    const created = await harness.api.pages.create({
      title: 'Today',
      parentId: 'log',
      content: markdownToDoc('# Plan\n\nShip it'),
    });
    expect((await harness.api.pages.get(created.id)).content).toBe('# Plan\n\nShip it');
    const doc = await harness.api.pages.get(created.id, { format: 'doc' });
    expect(doc.content.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    await harness.api.pages.update(created.id, { title: 'Tomorrow', content: 'Rest' });
    harness.workspace.setContent('log', 'Entry');
    expect(events).toEqual(['created:true', 'updated:true', 'content:true', 'content:false']);
    expect((await harness.api.pages.list({ parentId: 'log' })).map((p) => p.title)).toEqual([
      'Tomorrow',
    ]);
    await expect(harness.api.pages.get('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('queries and writes databases by names', async () => {
    const harness = createTestHarness(plugin, {
      databases: [
        {
          id: 'books',
          title: 'Books',
          properties: [
            { name: 'Status', type: 'select', options: [{ name: 'To read' }, { name: 'Done' }] },
            { name: 'Pages', type: 'number' },
          ],
          rows: [
            { title: 'Dune', values: { Status: 'Done', Pages: 412 } },
            { title: 'Hyperion', values: { Status: 'To read', Pages: 482 } },
          ],
        },
      ],
    });
    const { rows } = await harness.api.databases.query('books', {
      filters: [{ property: 'Status', operator: 'equals', value: 'To read' }],
    });
    expect(rows.map((row) => row.title)).toEqual(['Hyperion']);
    const added = await harness.api.databases.addRow('books', {
      title: 'Solaris',
      values: { Pages: 204 },
    });
    await harness.api.databases.updateRow('books', added.id, { values: { Status: 'Done' } });
    const done = await harness.api.databases.query('books', {
      filters: [{ property: 'Status', operator: 'equals', value: 'Done' }],
      sorts: [{ property: 'Pages' }],
    });
    expect(done.rows.map((row) => row.title)).toEqual(['Solaris', 'Dune']);
    await expect(
      harness.api.databases.addRow('books', { values: { Pages: 'many' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(harness.workspace.rows('books')).toHaveLength(3);
  });

  it('runs render functions with JSON in and out, from activate, panels and blocks', async () => {
    const renderer = defineRenderer({
      shout: (input: { text: string }) => ({
        text: input.text.toUpperCase(),
        at: new Date(0) as never,
      }),
    });
    const harness = createTestHarness(plugin, { renderer });
    await expect(harness.api.ui.render('shout', { text: 'hi' })).resolves.toEqual({
      text: 'HI',
      at: '1970-01-01T00:00:00.000Z',
    });
    await expect(harness.api.ui.render('whisper')).rejects.toThrow(
      'The renderer has no function "whisper".',
    );
    const withoutRenderer = createTestHarness(plugin);
    await expect(withoutRenderer.api.ui.render('shout', { text: 'hi' })).rejects.toMatchObject({
      code: 'not_found',
      message: 'Test plugin has no renderer: its manifest names none.',
    });
  });

  it('converts simple markdown both ways', () => {
    const markdown = '# Title\n\nFirst paragraph\n\n## Section\n\nMore';
    expect(docToMarkdown(markdownToDoc(markdown))).toBe(markdown);
    expect(markdownToDoc('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });
});
