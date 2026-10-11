import type {
  AnyNodeJSON,
  BlockJSON,
  CalloutTone,
  DocJSON,
  InlineJSON,
  JsonValue,
  MarkdownSerializeOptions,
  MarkJSON,
} from '@tessera/core';
import type {
  BlockContent,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from 'mdast';
import { formatCalloutMarker } from './callouts';
import {
  ASSET_URL_PREFIX,
  EMBED_FENCE_LANGUAGE,
  formatEmbedFence,
  isEmbeddableUrl,
} from './embeds';
import { stringifyFrontmatter } from './frontmatter';
import type { ToggleNode } from './syntax/nodes';
import { formatWikiLink } from './wikilinks';

type Flow = RootContent;
type Attrs = Record<string, unknown>;

interface Context {
  options: MarkdownSerializeOptions;
}

const MARK_RANK: Readonly<Record<string, number>> = {
  link: 0,
  bold: 1,
  italic: 2,
  underline: 3,
  strike: 4,
  code: 5,
  highlight: 6,
};

function attrsOf(node: { attrs?: object | undefined }): Attrs {
  return (node.attrs ?? {}) as Attrs;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Percent-encodes a relative path for a link destination, keeping `/`. */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.(md|markdown)$/i, '');
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

// ---------------------------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------------------------

function markKey(mark: MarkJSON): string {
  if (mark.type === 'link') return `link:${mark.attrs.href}\u0000${mark.attrs.title ?? ''}`;
  if (mark.type === 'highlight') return `highlight:${mark.attrs?.color ?? ''}`;
  return mark.type;
}

/** Marks that decide nesting; atoms and code text fit inside whatever is open. */
function structuralMarks(node: InlineJSON): MarkJSON[] | null {
  if (node.type !== 'text') return null;
  const marks = node.marks ?? [];
  if (marks.some((mark) => mark.type === 'code')) return null;
  return marks;
}

function pageLinkNode(
  node: Extract<InlineJSON, { type: 'pageLink' }>,
  ctx: Context,
): PhrasingContent {
  const { pageId, label, heading, blockRef } = node.attrs;
  const resolved = ctx.options.resolvePage?.(pageId) ?? null;
  if (ctx.options.linkStyle === 'markdown' && resolved?.path) {
    const fragment = blockRef ? `#^${blockRef}` : heading ? `#${encodeURIComponent(heading)}` : '';
    return {
      type: 'link',
      url: `${encodePath(resolved.path)}${fragment}`,
      children: [{ type: 'text', value: label ?? resolved.title ?? '' }],
    };
  }
  const target = resolved
    ? stripMarkdownExtension(resolved.path ?? resolved.title)
    : (label ?? pageId);
  const alias =
    label ??
    (resolved?.path && baseName(target) !== resolved.title && resolved.title
      ? resolved.title
      : null);
  return {
    type: 'wikiLink',
    embed: false,
    value: formatWikiLink({ target, heading: heading ?? null, blockRef: blockRef ?? null, alias }),
  };
}

interface Frame {
  key: string;
  children: PhrasingContent[];
  close?: string;
}

/** Converts inline DocJSON into nested mdast phrasing (marks become emphasis, strong, links…). */
export function inlineToMdast(content: readonly InlineJSON[], ctx: Context): PhrasingContent[] {
  const root: PhrasingContent[] = [];
  const stack: Frame[] = [];
  const current = (): PhrasingContent[] => stack[stack.length - 1]?.children ?? root;
  const closeTo = (depth: number) => {
    while (stack.length > depth) {
      const frame = stack.pop();
      if (frame?.close) current().push({ type: 'html', value: frame.close });
    }
  };
  const structural = content.map(structuralMarks);
  const extent = (from: number, key: string): number => {
    let count = 0;
    for (let i = from; i < content.length; i += 1) {
      const marks = structural[i];
      if (marks === null || marks === undefined) {
        count += 1;
        continue;
      }
      if (!marks.some((mark) => markKey(mark) === key)) break;
      count += 1;
    }
    return count;
  };
  const open = (mark: MarkJSON) => {
    const key = markKey(mark);
    const parent = current();
    switch (mark.type) {
      case 'bold':
      case 'italic':
      case 'strike': {
        const type =
          mark.type === 'bold' ? 'strong' : mark.type === 'italic' ? 'emphasis' : 'delete';
        const node = { type, children: [] as PhrasingContent[] } as PhrasingContent & {
          children: PhrasingContent[];
        };
        parent.push(node);
        stack.push({ key, children: node.children });
        return;
      }
      case 'link': {
        const node: PhrasingContent = {
          type: 'link',
          url: mark.attrs.href,
          title: mark.attrs.title ?? null,
          children: [],
        };
        parent.push(node);
        stack.push({ key, children: node.children });
        return;
      }
      case 'highlight': {
        const color = mark.attrs?.color ?? null;
        if (!color) {
          const node: PhrasingContent = { type: 'highlight', children: [] };
          parent.push(node);
          stack.push({ key, children: node.children });
          return;
        }
        parent.push({ type: 'html', value: `<mark data-color="${color}">` });
        stack.push({ key, children: parent, close: '</mark>' });
        return;
      }
      case 'underline':
        parent.push({ type: 'html', value: '<u>' });
        stack.push({ key, children: parent, close: '</u>' });
        return;
      default:
    }
  };
  content.forEach((node, index) => {
    const wanted = structural[index];
    if (wanted) {
      const wantedKeys = new Set(wanted.map(markKey));
      let keep = 0;
      while (keep < stack.length && wantedKeys.has((stack[keep] as Frame).key)) keep += 1;
      closeTo(keep);
      const openKeys = new Set(stack.map((frame) => frame.key));
      const toOpen = wanted
        .filter((mark) => !openKeys.has(markKey(mark)))
        .sort(
          (a, b) =>
            extent(index, markKey(b)) - extent(index, markKey(a)) ||
            (MARK_RANK[a.type] ?? 0) - (MARK_RANK[b.type] ?? 0),
        );
      for (const mark of toOpen) open(mark);
    }
    const target = current();
    switch (node.type) {
      case 'text':
        if ((node.marks ?? []).some((mark) => mark.type === 'code'))
          target.push({ type: 'inlineCode', value: node.text });
        else target.push({ type: 'text', value: node.text });
        break;
      case 'hardBreak':
        target.push({ type: 'break' });
        break;
      case 'tag':
        target.push({ type: 'tag', value: node.attrs.name });
        break;
      case 'pageLink':
        target.push(pageLinkNode(node, ctx));
        break;
    }
  });
  closeTo(0);
  finalizeBreaks(root);
  return root;
}

/**
 * Table cells and toggle summaries are trimmed when parsed: whitespace at their edges is written
 * as a character reference so it survives.
 */
function encodeEdgeWhitespace(children: PhrasingContent[]): PhrasingContent[] {
  const result = [...children];
  const reference = (character: string): PhrasingContent => ({
    type: 'html',
    value: `&#x${character.charCodeAt(0).toString(16).toUpperCase()};`,
  });
  const first = result[0];
  if (first?.type === 'text' && /^[ \t]/.test(first.value)) {
    const rest = first.value.slice(1);
    result.splice(
      0,
      1,
      reference(first.value.charAt(0)),
      ...(rest ? [{ ...first, value: rest }] : []),
    );
  }
  const last = result[result.length - 1];
  if (last?.type === 'text' && /[ \t]$/.test(last.value)) {
    const rest = last.value.slice(0, -1);
    result.splice(
      result.length - 1,
      1,
      ...(rest ? [{ ...last, value: rest }] : []),
      reference(last.value.slice(-1)),
    );
  }
  return result;
}

function isBreakLike(node: PhrasingContent | undefined): boolean {
  return node?.type === 'break' || (node?.type === 'html' && node.value === '<br>');
}

/**
 * A hard break is a plain line ending only between two pieces of content. At the start or end of
 * a span, next to another break, or before inline HTML (which markdown would read as a block
 * after a line ending), it is written as `<br>` so it survives.
 */
function finalizeBreaks(children: PhrasingContent[]): void {
  children.forEach((node, index) => {
    if ('children' in node) finalizeBreaks(node.children as PhrasingContent[]);
    if (node.type !== 'break') return;
    const previous = children[index - 1];
    const next = children[index + 1];
    if (!previous || !next || isBreakLike(previous) || isBreakLike(next) || next.type === 'html') {
      children[index] = { type: 'html', value: '<br>' };
    }
  });
}

/** Every hard break as `<br>`, for spans that must stay on one line (callout titles). */
function breaksAsHtml(children: PhrasingContent[]): PhrasingContent[] {
  children.forEach((node, index) => {
    if ('children' in node) breaksAsHtml(node.children as PhrasingContent[]);
    if (node.type === 'break') children[index] = { type: 'html', value: '<br>' };
  });
  return children;
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

interface TrailingAttrs {
  color?: string | null;
  itemColor?: string | null;
  quoteColor?: string | null;
  blockId?: string | null;
}

/** Appends `<!--color:…-->` comments and a ` ^block-id` to a textblock's content. */
function appendTrailing(children: PhrasingContent[], attrs: TrailingAttrs): PhrasingContent[] {
  const result = [...children];
  const separate = () => {
    const last = result[result.length - 1];
    if (!last) return;
    if (last.type === 'text') result[result.length - 1] = { ...last, value: `${last.value} ` };
    else result.push({ type: 'text', value: ' ' });
  };
  const comments: Array<[string, string | null | undefined]> = [
    ['color', attrs.color],
    ['item-color', attrs.itemColor],
    ['quote-color', attrs.quoteColor],
  ];
  for (const [name, value] of comments) {
    if (!value) continue;
    separate();
    result.push({ type: 'html', value: `<!--${name}:${value}-->` });
  }
  if (attrs.blockId) {
    separate();
    result.push({ type: 'blockId', value: attrs.blockId });
  }
  return result;
}

const NBSP: PhrasingContent = { type: 'html', value: '&nbsp;' };

function paragraphNode(
  node: AnyNodeJSON,
  ctx: Context,
  extra: TrailingAttrs = {},
  allowEmpty = false,
): Paragraph {
  const attrs = attrsOf(node);
  let children = inlineToMdast((node.content ?? []) as InlineJSON[], ctx);
  const trailing: TrailingAttrs = {
    color: str(attrs.color),
    blockId: str(attrs.blockId),
    ...extra,
  };
  const hasTrailing = Boolean(
    trailing.color || trailing.itemColor || trailing.quoteColor || trailing.blockId,
  );
  if (children.length === 0 && (!allowEmpty || hasTrailing)) children = [NBSP];
  return { type: 'paragraph', children: appendTrailing(children, trailing) };
}

function standaloneBlockId(blockId: unknown): Paragraph[] {
  const id = str(blockId);
  return id ? [{ type: 'paragraph', children: [{ type: 'blockId', value: id }] }] : [];
}

function isAllBold(node: AnyNodeJSON): boolean {
  if (node.type !== 'paragraph') return false;
  const attrs = attrsOf(node);
  if (attrs.color || attrs.blockId) return false;
  const content = node.content ?? [];
  const texts = content.filter((child) => child.type === 'text');
  return (
    texts.length > 0 &&
    texts.every(
      (child) =>
        child.marks?.some((mark) => mark.type === 'bold') &&
        !child.marks.some((mark) => mark.type === 'code'),
    )
  );
}

function withoutBold(content: readonly AnyNodeJSON[]): InlineJSON[] {
  return content.map((child) =>
    child.type === 'text'
      ? ({
          ...child,
          marks: (child.marks ?? []).filter((mark) => mark.type !== 'bold'),
        } as InlineJSON)
      : (child as InlineJSON),
  );
}

function isEmptyParagraph(node: AnyNodeJSON | undefined): boolean {
  if (!node || node.type !== 'paragraph' || node.content?.length) return false;
  const attrs = attrsOf(node);
  return !attrs.color && !attrs.blockId;
}

function calloutNode(node: AnyNodeJSON, ctx: Context): Flow[] {
  const attrs = attrsOf(node);
  const tone = (typeof attrs.tone === 'string' ? attrs.tone : 'default') as CalloutTone;
  const emoji = typeof attrs.emoji === 'string' ? attrs.emoji : null;
  const content = node.content ?? [];
  const only = content.length === 1 ? content[0] : undefined;
  let marker: string;
  let title: InlineJSON[] = [];
  let body: AnyNodeJSON[];
  const toggleAttrs = only?.type === 'toggle' ? attrsOf(only) : null;
  if (only?.type === 'toggle' && toggleAttrs && !toggleAttrs.color && !toggleAttrs.blockId) {
    marker = formatCalloutMarker(tone, emoji, toggleAttrs.open === true);
    const [summary, ...rest] = only.content ?? [];
    title = (summary?.content ?? []) as InlineJSON[];
    body = rest;
  } else {
    marker = formatCalloutMarker(tone, emoji, null);
    const first = content[0];
    if (first && isAllBold(first)) {
      title = withoutBold(first.content ?? []);
      body = content.slice(1);
    } else {
      body = content;
    }
  }
  if (body.length === 1 && isEmptyParagraph(body[0])) body = [];
  // The title is the marker's line: a line ending would end it, so breaks are written as `<br>`.
  const header: Paragraph = {
    type: 'paragraph',
    children: [
      { type: 'calloutMarker', value: marker },
      ...(title.length
        ? [
            { type: 'text', value: ' ' } as PhrasingContent,
            ...breaksAsHtml(inlineToMdast(title, ctx)),
          ]
        : []),
    ],
  };
  const quote: Flow = {
    type: 'blockquote',
    children: [header, ...(blocksToMdast(body, ctx) as BlockContent[])],
  };
  return [quote, ...standaloneBlockId(attrs.blockId)];
}

function listItemNode(node: AnyNodeJSON, ctx: Context, checked: boolean | null): ListItem {
  const attrs = attrsOf(node);
  const [first, ...rest] = node.content ?? [];
  const children: Flow[] = [];
  if (first?.type === 'paragraph') {
    // The item's own attributes ride on its first line; the paragraph's block ID is not written.
    const firstAttrs = attrsOf(first);
    // An empty item line is written as `&nbsp;`: an empty item cannot interrupt a paragraph (it
    // would turn it into a heading) and a blank line after it would end the item.
    children.push(
      paragraphNode({ ...first, attrs: { ...firstAttrs, blockId: null } }, ctx, {
        itemColor: str(attrs.color),
        blockId: str(attrs.blockId),
      }),
    );
    children.push(...blocksToMdast(rest, ctx));
  } else {
    children.push(...blocksToMdast(node.content ?? [], ctx));
  }
  return {
    type: 'listItem',
    spread: false,
    checked,
    children: children as ListItem['children'],
  };
}

function listNode(node: AnyNodeJSON, ctx: Context): List {
  const attrs = attrsOf(node);
  const task = node.type === 'taskList';
  const list: List = {
    type: 'list',
    ordered: node.type === 'orderedList',
    spread: false,
    children: (node.content ?? []).map((item) =>
      listItemNode(item, ctx, task ? attrsOf(item).checked === true : null),
    ),
  };
  if (node.type === 'orderedList') list.start = typeof attrs.start === 'number' ? attrs.start : 1;
  return list;
}

/**
 * In a table cell, `` `\|` `` cannot be written as a code span: the table reads `\|` as an
 * escaped pipe first. Such code is written as `<code>` with escaped text instead.
 */
function cellSafeCode(children: PhrasingContent[]): PhrasingContent[] {
  return children.flatMap((node): PhrasingContent[] => {
    if (node.type === 'inlineCode' && node.value.includes('\\|')) {
      return [
        { type: 'html', value: '<code>' },
        { type: 'text', value: node.value },
        { type: 'html', value: '</code>' },
      ];
    }
    if ('children' in node) {
      return [
        { ...node, children: cellSafeCode(node.children as PhrasingContent[]) } as PhrasingContent,
      ];
    }
    return [node];
  });
}

function cellNode(cell: AnyNodeJSON, ctx: Context): TableCell {
  const children: PhrasingContent[] = [];
  (cell.content ?? []).forEach((paragraph, index) => {
    if (index > 0) children.push({ type: 'html', value: '<br><br>' });
    children.push(
      ...encodeEdgeWhitespace(
        cellSafeCode(inlineToMdast((paragraph.content ?? []) as InlineJSON[], ctx)),
      ),
    );
  });
  return { type: 'tableCell', children };
}

function tableNode(node: AnyNodeJSON, ctx: Context): Flow[] {
  const rows = node.content ?? [];
  const width = Math.max(
    1,
    ...rows.map((row) =>
      (row.content ?? []).reduce((sum, cell) => {
        const colspan = attrsOf(cell).colspan;
        return sum + (typeof colspan === 'number' && colspan > 1 ? colspan : 1);
      }, 0),
    ),
  );
  const toRow = (row: AnyNodeJSON): TableRow => {
    const cells: TableCell[] = [];
    for (const cell of row.content ?? []) {
      cells.push(cellNode(cell, ctx));
      const colspan = attrsOf(cell).colspan;
      for (let extra = 1; typeof colspan === 'number' && extra < colspan; extra += 1)
        cells.push({ type: 'tableCell', children: [] });
    }
    while (cells.length < width) cells.push({ type: 'tableCell', children: [] });
    return { type: 'tableRow', children: cells };
  };
  const firstRow = rows[0];
  const hasHeader =
    firstRow !== undefined &&
    (firstRow.content ?? []).length > 0 &&
    (firstRow.content ?? []).every((cell) => cell.type === 'tableHeader');
  const tableRows: TableRow[] = hasHeader
    ? rows.map(toRow)
    : [toRow({ type: 'tableRow', content: [] }), ...rows.map(toRow)];
  // An empty header row means "no header" when parsing, so a real but empty header is `&nbsp;`.
  const header = tableRows[0];
  if (hasHeader && header && header.children.every((cell) => cell.children.length === 0)) {
    header.children = header.children.map((cell) => ({ ...cell, children: [NBSP] }));
  }
  const table: Table = {
    type: 'table',
    align: Array.from({ length: width }, () => null),
    children: tableRows,
  };
  return [table, ...standaloneBlockId(attrsOf(node).blockId)];
}

function toggleNode(node: AnyNodeJSON, ctx: Context): ToggleNode {
  const attrs = attrsOf(node);
  const [summary, ...rest] = node.content ?? [];
  let attributes = attrs.open === true ? ' open' : '';
  const color = str(attrs.color);
  if (color) attributes += ` data-color="${color}"`;
  const blockId = str(attrs.blockId);
  if (blockId) attributes += ` data-block-id="${blockId}"`;
  return {
    type: 'toggle',
    attributes,
    summary: encodeEdgeWhitespace(inlineToMdast((summary?.content ?? []) as InlineJSON[], ctx)),
    children: blocksToMdast(rest, ctx) as BlockContent[],
  };
}

function imageNode(node: AnyNodeJSON, ctx: Context): Flow[] {
  const attrs = attrsOf(node);
  const assetId = str(attrs.assetId);
  let url = str(attrs.src) ?? '';
  if (assetId) {
    const path = ctx.options.resolveAssetPath?.(assetId);
    url = path ? encodePath(path) : `${ASSET_URL_PREFIX}${assetId}`;
  }
  const width = typeof attrs.width === 'number' ? `|${attrs.width}%` : '';
  const image: PhrasingContent = {
    type: 'image',
    url,
    alt: `${str(attrs.alt) ?? ''}${width}`,
    title: str(attrs.title),
  };
  return [
    { type: 'paragraph', children: appendTrailing([image], { blockId: str(attrs.blockId) }) },
  ];
}

function fencedEmbed(attrs: Attrs): Flow {
  return {
    type: 'code',
    lang: EMBED_FENCE_LANGUAGE,
    value: formatEmbedFence({
      kind: String(attrs.kind),
      ref: str(attrs.ref),
      data: (attrs.data ?? null) as JsonValue | null,
      blockId: str(attrs.blockId),
    }),
  };
}

function embedNode(node: AnyNodeJSON, ctx: Context): Flow[] {
  const attrs = attrsOf(node);
  const kind = attrs.kind;
  const ref = str(attrs.ref);
  const data =
    attrs.data && typeof attrs.data === 'object' && !Array.isArray(attrs.data)
      ? (attrs.data as Record<string, unknown>)
      : null;
  const blockId = str(attrs.blockId);
  const inParagraph = (child: PhrasingContent): Flow[] => [
    { type: 'paragraph', children: appendTrailing([child], { blockId }) },
  ];
  if (kind === 'web' && ref && isEmbeddableUrl(ref) && data?.display === 'embed') {
    const keys = Object.keys(data).filter((key) => data[key] !== undefined);
    const title = typeof data.title === 'string' ? data.title : '';
    if (keys.every((key) => key === 'display' || (key === 'title' && title))) {
      return inParagraph({ type: 'image', url: ref, alt: title, title: null });
    }
  }
  if (kind === 'file' && ref) {
    const path = ctx.options.resolveAssetPath?.(ref);
    if (path)
      return inParagraph({
        type: 'wikiLink',
        embed: true,
        value: formatWikiLink({ target: path, heading: null, blockRef: null, alias: null }),
      });
  }
  if (kind === 'database' && ref && (data?.viewId ?? null) === null) {
    const resolved = ctx.options.resolvePage?.(ref);
    if (resolved) {
      const target = resolved.path ?? resolved.title;
      return inParagraph({
        type: 'wikiLink',
        embed: true,
        value: formatWikiLink({ target, heading: null, blockRef: null, alias: null }),
      });
    }
  }
  return [fencedEmbed(attrs)];
}

/** Converts blocks to mdast flow content. */
export function blocksToMdast(blocks: readonly AnyNodeJSON[], ctx: Context): Flow[] {
  const out: Flow[] = [];
  for (const block of blocks) {
    const attrs = attrsOf(block);
    switch (block.type) {
      case 'paragraph':
        out.push(paragraphNode(block, ctx));
        break;
      case 'heading': {
        const level = typeof attrs.level === 'number' ? attrs.level : 1;
        out.push({
          type: 'heading',
          depth: Math.min(3, Math.max(1, level)) as 1 | 2 | 3,
          children: appendTrailing(inlineToMdast((block.content ?? []) as InlineJSON[], ctx), {
            color: str(attrs.color),
            blockId: str(attrs.blockId),
          }),
        });
        break;
      }
      case 'blockquote': {
        const content = block.content ?? [];
        const children = blocksToMdast(content, ctx);
        const color = str(attrs.color);
        if (color) {
          const first = content[0];
          if (first?.type === 'paragraph') {
            children[0] = paragraphNode(first, ctx, { quoteColor: color });
          } else {
            // No first line to carry it: the comment stands alone.
            children.unshift({ type: 'html', value: `<!--quote-color:${color}-->` });
          }
        }
        const onlyEmpty = content.length === 1 && isEmptyParagraph(content[0]) && !color;
        out.push({ type: 'blockquote', children: (onlyEmpty ? [] : children) as BlockContent[] });
        out.push(...standaloneBlockId(attrs.blockId));
        break;
      }
      case 'callout':
        out.push(...calloutNode(block, ctx));
        break;
      case 'codeBlock':
        out.push({
          type: 'code',
          lang: str(attrs.language),
          value: (block.content ?? []).map((child) => child.text ?? '').join(''),
        });
        out.push(...standaloneBlockId(attrs.blockId));
        break;
      case 'horizontalRule':
        out.push({ type: 'thematicBreak' });
        break;
      case 'image':
        out.push(...imageNode(block, ctx));
        break;
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        out.push(listNode(block, ctx));
        break;
      case 'table':
        out.push(...tableNode(block, ctx));
        break;
      case 'toggle':
        out.push(toggleNode(block, ctx));
        break;
      case 'embed':
        out.push(...embedNode(block, ctx));
        break;
    }
  }
  return out;
}

/** Converts a document (and optional frontmatter) into an mdast root. */
export function docToMdast(doc: DocJSON, options: MarkdownSerializeOptions): Root {
  const ctx: Context = { options };
  const blocks = [...(doc.content as BlockJSON[] as AnyNodeJSON[])];
  // The editor keeps an empty paragraph at the end for the caret: it is not content.
  while (blocks.length && isEmptyParagraph(blocks[blocks.length - 1])) blocks.pop();
  const children: RootContent[] = [];
  const frontmatter = options.frontmatter ?? {};
  if (Object.keys(frontmatter).length)
    children.push({ type: 'yaml', value: stringifyFrontmatter(frontmatter) });
  children.push(...blocksToMdast(blocks, ctx));
  return { type: 'root', children };
}
