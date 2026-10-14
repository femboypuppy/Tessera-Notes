import type { SlashMenuItem } from '@tessera/core';
import type { Editor } from '@tiptap/core';
import {
  Bookmark,
  CalendarDays,
  ChevronRight,
  FileSymlink,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Lightbulb,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  MonitorPlay,
  Puzzle,
  Quote,
  SquareCode,
  Table,
  Type,
} from 'lucide-react';
import { insertBlocks, slashTarget, turnInto, type TurnIntoType } from '../actions/blocks';
import { t } from '../i18n';
import type { EditorController, PopoverRequest } from '../react/controller';
import { isValidEmbed } from '../schema/nodes/embed';
import { pushRecent, rankItems } from './fuzzy';
import type { MenuItem, MenuSection } from './types';

/** What a slash item's action receives. `at` is the caret position after the `/query` is removed. */
export interface SlashContext {
  editor: Editor;
  controller: EditorController;
  at: number;
}

/** A slash-menu row with its action. */
export interface SlashItem extends MenuItem {
  group: string;
  /** False when the item can't be used where the caret is (headings in table cells…). */
  available?(editor: Editor): boolean;
  run(context: SlashContext): void | Promise<void>;
}

/** Device setting holding the recently used slash items (most recent first). */
export const RECENT_BLOCKS_KEY = 'editor.recentBlocks';

const GROUP_ORDER = ['basic', 'media', 'advanced', 'database', 'plugins'];

function groupLabel(group: string): string {
  switch (group) {
    case 'basic':
      return t('groupBasic');
    case 'media':
      return t('groupMedia');
    case 'advanced':
      return t('groupAdvanced');
    case 'database':
      return t('groupDatabase');
    case 'plugins':
      return t('groupPlugins');
    default:
      return t('groupOther');
  }
}

/** The caret's screen rectangle (popovers opened from the slash menu anchor to it). */
export function caretRect(editor: Editor, pos: number): DOMRect {
  try {
    const coords = editor.view.coordsAtPos(Math.min(pos, editor.state.doc.content.size));
    return new DOMRect(coords.left, coords.top, 1, Math.max(coords.bottom - coords.top, 16));
  } catch {
    const rect = editor.view.dom.getBoundingClientRect();
    return new DOMRect(rect.left, rect.top, 1, 16);
  }
}

/** True when blocks can be inserted where the caret is (not inside a table cell). */
function canInsertBlocks(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === 'tableCell' || name === 'tableHeader' || name === 'codeBlock') return false;
  }
  return true;
}

function turnIntoItem(
  id: TurnIntoType,
  item: Omit<SlashItem, 'id' | 'run' | 'group' | 'available'>,
): SlashItem {
  return {
    id,
    group: id === 'codeBlock' ? 'advanced' : 'basic',
    ...item,
    available: (editor) => slashTarget(editor, id) !== null,
    run: ({ editor }) => {
      const target = slashTarget(editor, id);
      if (target !== null) turnInto(editor, target, id);
      editor.view.focus();
    },
  };
}

function popoverItem(
  id: string,
  group: string,
  item: Omit<SlashItem, 'id' | 'run' | 'group' | 'available'>,
  request: (at: number) => PopoverRequest,
): SlashItem {
  return {
    id,
    group,
    ...item,
    available: canInsertBlocks,
    run: ({ editor, controller, at }) => {
      controller.openPopover({ request: request(at), anchor: caretRect(editor, at) });
    },
  };
}

/** The editor's own slash-menu items, in display order. */
export function builtInSlashItems(): SlashItem[] {
  return [
    turnIntoItem('paragraph', {
      title: t('blockText'),
      description: t('blockTextHint'),
      icon: Type,
      keywords: ['text', 'plain', 'paragraph', 'p'],
    }),
    turnIntoItem('heading1', {
      title: t('blockHeading1'),
      description: t('blockHeading1Hint'),
      icon: Heading1,
      hint: '#',
      keywords: ['h1', 'title', 'heading', 'big'],
    }),
    turnIntoItem('heading2', {
      title: t('blockHeading2'),
      description: t('blockHeading2Hint'),
      icon: Heading2,
      hint: '##',
      keywords: ['h2', 'subtitle', 'heading', 'medium'],
    }),
    turnIntoItem('heading3', {
      title: t('blockHeading3'),
      description: t('blockHeading3Hint'),
      icon: Heading3,
      hint: '###',
      keywords: ['h3', 'heading', 'small'],
    }),
    turnIntoItem('bulletList', {
      title: t('blockBulletList'),
      description: t('blockBulletListHint'),
      icon: List,
      hint: '-',
      keywords: ['bullet', 'unordered', 'ul', 'list'],
    }),
    turnIntoItem('orderedList', {
      title: t('blockOrderedList'),
      description: t('blockOrderedListHint'),
      icon: ListOrdered,
      hint: '1.',
      keywords: ['numbered', 'ordered', 'ol', 'list'],
    }),
    turnIntoItem('taskList', {
      title: t('blockTaskList'),
      description: t('blockTaskListHint'),
      icon: ListTodo,
      hint: '[]',
      keywords: ['todo', 'task', 'checkbox', 'checklist'],
    }),
    turnIntoItem('toggle', {
      title: t('blockToggle'),
      description: t('blockToggleHint'),
      icon: ChevronRight,
      keywords: ['collapse', 'details', 'fold', 'accordion', 'expand'],
    }),
    turnIntoItem('blockquote', {
      title: t('blockQuote'),
      description: t('blockQuoteHint'),
      icon: Quote,
      hint: '>',
      keywords: ['quote', 'citation', 'blockquote'],
    }),
    turnIntoItem('callout', {
      title: t('blockCallout'),
      description: t('blockCalloutHint'),
      icon: Lightbulb,
      keywords: ['note', 'info', 'warning', 'tip', 'admonition', 'highlight'],
    }),
    {
      id: 'date',
      group: 'basic',
      title: t('blockDate'),
      description: t('blockDateHint'),
      icon: CalendarDays,
      keywords: ['date', 'today', 'now'],
      run: ({ editor }) => {
        const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date());
        editor.chain().focus().insertContent(date).run();
      },
    },
    {
      id: 'divider',
      group: 'basic',
      title: t('blockDivider'),
      description: t('blockDividerHint'),
      icon: Minus,
      hint: '---',
      keywords: ['hr', 'line', 'separator', 'rule', 'divider'],
      available: canInsertBlocks,
      run: ({ editor, at }) => {
        const hr = editor.schema.nodes.horizontalRule?.create();
        if (hr) insertBlocks(editor, at, [hr]);
        editor.view.focus();
      },
    },
    {
      id: 'pageLink',
      group: 'basic',
      title: t('blockPageLink'),
      description: t('blockPageLinkHint'),
      icon: FileSymlink,
      hint: '[[',
      keywords: ['link', 'page', 'mention', 'wikilink', 'reference'],
      run: ({ editor }) => {
        // Typing `[[` opens the page autocomplete.
        editor.chain().focus().insertContent('[[').run();
      },
    },
    popoverItem(
      'image',
      'media',
      {
        title: t('blockImage'),
        description: t('blockImageHint'),
        icon: Image,
        keywords: ['picture', 'photo', 'upload', 'img', 'screenshot'],
      },
      (at) => ({ kind: 'image', insertAt: at }),
    ),
    popoverItem(
      'embed',
      'media',
      {
        title: t('blockEmbed'),
        description: t('blockEmbedHint'),
        icon: MonitorPlay,
        keywords: ['youtube', 'vimeo', 'loom', 'figma', 'codepen', 'video', 'iframe', 'embed'],
      },
      (at) => ({ kind: 'webEmbed', insertAt: at, display: 'embed' }),
    ),
    popoverItem(
      'bookmark',
      'media',
      {
        title: t('blockBookmark'),
        description: t('blockBookmarkHint'),
        icon: Bookmark,
        keywords: ['link', 'url', 'card', 'web', 'bookmark'],
      },
      (at) => ({ kind: 'webEmbed', insertAt: at, display: 'bookmark' }),
    ),
    popoverItem(
      'table',
      'advanced',
      {
        title: t('blockTable'),
        description: t('blockTableHint'),
        icon: Table,
        keywords: ['grid', 'spreadsheet', 'rows', 'columns', 'table'],
      },
      (at) => ({ kind: 'table', insertAt: at }),
    ),
    turnIntoItem('codeBlock', {
      title: t('blockCode'),
      description: t('blockCodeHint'),
      icon: SquareCode,
      hint: '```',
      keywords: ['code', 'snippet', 'pre', 'programming', 'syntax'],
    }),
  ];
}

/** Adapts an item another feature registered (`ctx.blocks`) into a slash item. */
export function registrySlashItem(item: SlashMenuItem): SlashItem {
  return {
    id: `registry:${item.id}`,
    group: item.group ?? 'other',
    title: item.title,
    description: item.description,
    keywords: item.keywords,
    icon: item.icon ?? Puzzle,
    available: canInsertBlocks,
    run: async ({ editor, controller }) => {
      try {
        const embed = await item.create({ app: controller.ctx, pageId: controller.pageId });
        if (!embed || editor.isDestroyed) return;
        if (!isValidEmbed(embed)) throw new Error(`Invalid embed from "${item.id}"`);
        const node = editor.schema.nodes.embed?.create({
          kind: embed.kind,
          ref: embed.ref ?? null,
          data: embed.data ?? null,
        });
        if (node) insertBlocks(editor, editor.state.selection.from, [node]);
        editor.view.focus();
      } catch (error) {
        console.error('[editor] Slash menu item failed', error);
        controller.toast({ title: t('insertFailed'), variant: 'error' });
      }
    },
  };
}

/** Every slash item available right now: built-ins plus other features' registrations. */
export function allSlashItems(controller: EditorController): SlashItem[] {
  return [...builtInSlashItems(), ...controller.ctx.blocks.slashMenuItems().map(registrySlashItem)];
}

/** Recently used slash item IDs (device setting). */
export function recentSlashItems(controller: EditorController): string[] {
  const value = controller.ctx.settings.device.get(RECENT_BLOCKS_KEY);
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string').slice(0, 8)
    : [];
}

/** Remembers that an item was used, so it ranks first next time. */
export function rememberSlashItem(controller: EditorController, id: string): void {
  controller.ctx.settings.device.set(
    RECENT_BLOCKS_KEY,
    pushRecent(recentSlashItems(controller), id),
  );
}

/** Filters the available items for a query (recently used first on ties). */
export function filterSlashItems(
  editor: Editor,
  controller: EditorController,
  query: string,
): SlashItem[] {
  const items = allSlashItems(controller).filter((item) => item.available?.(editor) ?? true);
  // Without a query the groups keep their order; the "Recently used" section shows recency.
  return rankItems(items, query, query.trim() ? recentSlashItems(controller) : []);
}

/**
 * Groups items for display. Without a query: a "Recently used" section, then each group in order;
 * with a query: one ranked list.
 */
export function slashSections(
  items: SlashItem[],
  query: string,
  recent: readonly string[],
): MenuSection<SlashItem>[] {
  if (query.trim()) return [{ id: 'results', label: '', items }];
  const sections: MenuSection<SlashItem>[] = [];
  const recentItems = recent
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is SlashItem => !!item)
    .slice(0, 3);
  if (recentItems.length)
    sections.push({ id: 'recent', label: t('groupRecent'), items: recentItems });
  const groups = [...new Set(items.map((item) => item.group))].sort((a, b) => {
    const indexA = GROUP_ORDER.indexOf(a);
    const indexB = GROUP_ORDER.indexOf(b);
    return (indexA < 0 ? 99 : indexA) - (indexB < 0 ? 99 : indexB);
  });
  for (const group of groups) {
    sections.push({
      id: group,
      label: groupLabel(group),
      items: items.filter((item) => item.group === group),
    });
  }
  return sections;
}
