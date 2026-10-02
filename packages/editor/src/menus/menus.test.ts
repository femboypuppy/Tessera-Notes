import { build as b, type DocJSON } from '@tessera/core';
import { createTestAppContext, type TestAppContext } from '@tessera/core/testing';
import type { Editor } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { links } from '../extensions/links';
import { createEditorController, type EditorController } from '../react/controller';
import { blockTexts, createTestEditor, pressKey, typeText } from '../test-utils';
import { pageSuggestions, RECENT_PAGES_KEY } from './page-items';
import { pageLinkCommand } from './page-link-command';
import { slashCommand } from './slash-command';
import { RECENT_BLOCKS_KEY } from './slash-items';

let app: TestAppContext;
let controller: EditorController;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  app = await createTestAppContext();
  const host = app.ctx.workspace.createPage({ title: 'Host page' });
  controller = createEditorController(app.ctx, host.id);
});

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  await app.dispose();
});

function setup(content: DocJSON = b.doc(b.paragraph())): Editor {
  const result = createTestEditor({
    content,
    extra: [slashCommand(controller), pageLinkCommand(controller), links(controller)],
  });
  controller.editor = result.editor;
  result.editor.commands.focus('end');
  cleanups.push(result.destroy);
  return result.editor;
}

/** Lets the suggestion plugin fetch its items (they arrive asynchronously). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function menuTitles(): string[] {
  return controller.menu.get()?.flat.map((item) => item.title) ?? [];
}

describe('slash menu', () => {
  it('opens on "/" with every block type, grouped', async () => {
    setup();
    const editor = controller.editor as Editor;
    typeText(editor, '/');
    await settle();
    const state = controller.menu.get();
    expect(state?.kind).toBe('slash');
    expect(state?.sections.map((section) => section.id)).toEqual(['basic', 'media', 'advanced']);
    expect(menuTitles()).toEqual(
      expect.arrayContaining([
        'Text',
        'Heading 1',
        'Bulleted list',
        'To-do list',
        'Toggle',
        'Quote',
        'Callout',
        'Divider',
        'Image',
        'Embed',
        'Web bookmark',
        'Table',
        'Code',
      ]),
    );
  });

  it('filters as you type and runs the chosen item with Enter', async () => {
    const editor = setup();
    typeText(editor, '/head');
    await settle();
    expect(menuTitles()).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
    pressKey(editor, 'ArrowDown');
    await settle();
    pressKey(editor, 'Enter');
    await settle();
    expect(controller.menu.get()).toBeNull();
    expect(editor.state.doc.firstChild?.type.name).toBe('heading');
    expect(editor.state.doc.firstChild?.attrs.level).toBe(2);
    expect(editor.state.doc.textContent).toBe('');
  });

  it('inserts today’s date as localized text', async () => {
    const editor = setup();
    typeText(editor, '/date');
    await settle();
    expect(menuTitles()[0]).toBe('Date');
    pressKey(editor, 'Enter');
    await settle();
    expect(editor.state.doc.textContent).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date()),
    );
  });

  it('ranks recently used items first and shows them in "Recently used"', async () => {
    app.ctx.settings.device.set(RECENT_BLOCKS_KEY, ['callout']);
    const editor = setup();
    typeText(editor, '/');
    await settle();
    expect(controller.menu.get()?.sections[0]?.id).toBe('recent');
    expect(menuTitles()[0]).toBe('Callout');
    pressKey(editor, 'Escape');
    await settle();
    typeText(editor, ' ');
    await settle();
    typeText(editor, '/c');
    await settle();
    expect(menuTitles()[0]).toBe('Callout');
  });

  it('remembers the items you use', async () => {
    const editor = setup();
    typeText(editor, '/toggle');
    await settle();
    pressKey(editor, 'Enter');
    await settle();
    expect(app.ctx.settings.device.get(RECENT_BLOCKS_KEY)).toEqual(['toggle']);
    expect(editor.state.doc.firstChild?.type.name).toBe('toggle');
  });

  it('closes on Escape and keeps what was typed', async () => {
    const editor = setup();
    typeText(editor, '/qu');
    await settle();
    expect(controller.menu.get()).not.toBeNull();
    pressKey(editor, 'Escape');
    await settle();
    expect(controller.menu.get()).toBeNull();
    expect(editor.state.doc.textContent).toBe('/qu');
  });

  it('closes when nothing matches and you keep typing words', async () => {
    const editor = setup();
    typeText(editor, '/zzz ');
    await settle();
    await Promise.resolve();
    expect(controller.menu.get()).toBeNull();
  });

  it('lists blocks other features register and inserts their embed', async () => {
    app.ctx.blocks.register({
      kind: 'database',
      component: () => null,
      slashMenu: [
        {
          id: 'database-inline',
          title: 'Database – inline',
          group: 'database',
          create: () => ({ kind: 'database', ref: 'db-1', data: { viewId: 'v1' } }),
        },
      ],
    });
    const editor = setup();
    typeText(editor, '/datab');
    await settle();
    expect(menuTitles()[0]).toBe('Database – inline');
    pressKey(editor, 'Enter');
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const embed = editor.state.doc.firstChild;
    expect(embed?.type.name).toBe('embed');
    expect(embed?.attrs).toMatchObject({ kind: 'database', ref: 'db-1', data: { viewId: 'v1' } });
  });

  it('offers only what fits inside a table cell', async () => {
    const editor = setup(b.doc(b.table({ header: false }, ['Cell'])));
    editor.commands.setTextSelection(4);
    typeText(editor, '/');
    await settle();
    const titles = menuTitles();
    expect(titles).toContain('Text');
    expect(titles).not.toContain('Heading 1');
    expect(titles).not.toContain('Table');
  });

  it('never opens in code blocks or mid-word', async () => {
    const editor = setup(b.doc(b.codeBlock('x')));
    editor.commands.focus('end');
    typeText(editor, '/');
    await settle();
    expect(controller.menu.get()).toBeNull();
    const other = setup(b.doc(b.paragraph('and')));
    typeText(other, '/or');
    await settle();
    expect(controller.menu.get()).toBeNull();
  });
});

describe('page link autocomplete', () => {
  it('ranks pages fuzzily, recent pages first, and leaves trashed pages out', async () => {
    const apollo = app.ctx.workspace.createPage({ title: 'Apollo program' });
    const mission = app.ctx.workspace.createPage({ title: 'Mission control' });
    const old = app.ctx.workspace.createPage({ title: 'Missing parts' });
    app.ctx.workspace.trashPage(old.id);
    const index = app.ctx.workspace.pages.getSnapshot();
    const recent = [apollo.id];
    expect(pageSuggestions(index, '', recent, null)[0]?.title).toBe('Apollo program');
    const results = pageSuggestions(index, 'miss', recent, null);
    expect(results.map((item) => item.title)).toEqual(['Mission control', 'Create page “miss”']);
    expect(results[0]).toMatchObject({ kind: 'page', pageId: mission.id });
    // An exact title match offers no "Create page".
    expect(
      pageSuggestions(index, 'mission control', [], null).some((item) => item.kind === 'create'),
    ).toBe(false);
  });

  it('"[[" links the chosen page and remembers it as recent', async () => {
    const mission = app.ctx.workspace.createPage({ title: 'Mission control' });
    const editor = setup();
    typeText(editor, 'See [[Missi');
    await settle();
    expect(controller.menu.get()?.kind).toBe('page');
    expect(menuTitles()[0]).toBe('Mission control');
    pressKey(editor, 'Enter');
    await settle();
    const link = editor.state.doc.firstChild?.child(1);
    expect(link?.type.name).toBe('pageLink');
    expect(link?.attrs.pageId).toBe(mission.id);
    expect(editor.state.doc.textContent).toBe('See  ');
    expect(app.ctx.settings.device.get(RECENT_PAGES_KEY)).toEqual([mission.id]);
  });

  it('"Create page" creates the page under the current one and links to it', async () => {
    const editor = setup();
    typeText(editor, '[[Flight dynamics');
    await settle();
    const titles = menuTitles();
    expect(titles[titles.length - 1]).toBe('Create page “Flight dynamics”');
    pressKey(editor, 'ArrowUp');
    await settle();
    pressKey(editor, 'Enter');
    await settle();
    const created = app.ctx.workspace.pages
      .getSnapshot()
      .all()
      .find((page) => page.title === 'Flight dynamics');
    expect(created?.parentId).toBe(controller.pageId);
    expect(editor.state.doc.firstChild?.firstChild?.attrs.pageId).toBe(created?.id);
  });

  it('"@" works like a mention', async () => {
    const apollo = app.ctx.workspace.createPage({ title: 'Apollo' });
    const editor = setup();
    typeText(editor, 'Ask @apol');
    await settle();
    expect(menuTitles()[0]).toBe('Apollo');
    pressKey(editor, 'Tab');
    await settle();
    expect(editor.state.doc.firstChild?.child(1).attrs.pageId).toBe(apollo.id);
  });
});

describe('pasting URLs', () => {
  function paste(editor: Editor, text: string): boolean {
    const event = {
      clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') },
      preventDefault: () => undefined,
    } as unknown as ClipboardEvent;
    const view = editor.view;
    return !!view.someProp('handlePaste', (handler) => handler(view, event, Slice.empty));
  }

  it('links the selected text', async () => {
    const editor = setup(b.doc(b.paragraph('Read the docs')));
    editor.commands.setTextSelection({ from: 10, to: 14 });
    expect(paste(editor, 'https://tessera.dev/docs')).toBe(true);
    let href: unknown = null;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text === 'docs') href = node.marks[0]?.attrs.href;
    });
    expect(href).toBe('https://tessera.dev/docs');
    expect(editor.state.doc.textContent).toBe('Read the docs');
  });

  it('offers link, embed and bookmark for a bare URL, and embeds it on request', async () => {
    const editor = setup();
    expect(paste(editor, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(controller.menu.get()?.kind).toBe('paste');
    expect(menuTitles()).toEqual(['Link', 'Embed', 'Bookmark']);
    pressKey(editor, 'ArrowDown');
    await settle();
    pressKey(editor, 'Enter');
    await settle();
    const embed = blockTexts(editor)[0];
    expect(embed).toBe('embed:');
    expect(editor.state.doc.firstChild?.attrs).toMatchObject({
      kind: 'web',
      ref: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      data: { display: 'embed' },
    });
  });

  it('keeps the link when you just keep typing', async () => {
    const editor = setup();
    paste(editor, 'https://example.com/page');
    typeText(editor, ' ok');
    await settle();
    expect(controller.menu.get()).toBeNull();
    expect(editor.state.doc.textContent).toBe('https://example.com/page ok');
  });

  it('offers no embed for sites outside the allowlist', async () => {
    const editor = setup();
    paste(editor, 'https://example.com/page');
    expect(menuTitles()).toEqual(['Link', 'Bookmark']);
  });
});
