import {
  BLOCK_COLORS,
  isSafeHref,
  isSafeImageSrc,
  isValidBlockId,
  isValidTagName,
  normalizeTagName,
  type AnyNodeJSON,
  type BlockColor,
} from '@tessera/core';
import type {
  Blockquote,
  Code,
  Heading,
  Html,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
} from 'mdast';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { toString } from 'mdast-util-to-string';
import { CALLOUT_TYPES, parseCalloutMarker } from './callouts';
import {
  ASSET_URL_PREFIX,
  EMBED_FENCE_LANGUAGE,
  isEmbeddableUrl,
  isImagePath,
  parseEmbedFence,
} from './embeds';
import { decodeEntities, tokenizeHtml, type HtmlToken } from './html/tokenize';
import type { WikiLink } from './syntax/nodes';
import { parseWikiLink } from './wikilinks';

type Mark = { type: string; attrs?: Record<string, unknown> };
type Attrs = Record<string, unknown>;

/** Options of the mdast → DocJSON conversion. */
export interface ToDocOptions {
  resolvePageLink?: ((target: string) => string | null | undefined) | undefined;
  resolveAsset?: ((path: string) => string | null | undefined) | undefined;
  /** Tells database pages apart, so `![[Database]]` becomes an inline database. */
  isDatabase?: ((pageId: string) => boolean) | undefined;
}

interface Context {
  options: ToDocOptions;
  warnings: string[];
  warned: Set<string>;
  definitions: Map<string, { url: string; title: string | null }>;
  /** Parses nested markdown (toggle summaries and bodies stored in HTML). */
  parseMarkdown: (markdown: string) => Root;
  /** The markdown being converted (node positions point into it). */
  source: string;
  depth: number;
}

/** An inline node, a block that splits the paragraph, or a block appended after it. */
type Item =
  | { kind: 'inline'; node: AnyNodeJSON }
  | { kind: 'block'; node: AnyNodeJSON }
  | { kind: 'after'; node: AnyNodeJSON };

/** HTML tags that map to marks, and the attributes comments may carry. */
const HTML_MARK_TAGS: Readonly<Record<string, string>> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
  code: 'code',
  kbd: 'code',
  mark: 'highlight',
};

const ATTRIBUTE_COMMENT = /^<!--\s*(color|item-color|quote-color)\s*:\s*([a-z-]+)\s*-->$/;
const LANGUAGE_PATTERN = /^[a-z0-9_+#.-]{1,64}$/;
const PAGE_EXTENSIONS = new Set(['md', 'markdown', 'csv']);

function warn(ctx: Context, message: string, once?: string): void {
  if (once) {
    if (ctx.warned.has(once)) return;
    ctx.warned.add(once);
  }
  if (ctx.warnings.length < 200) ctx.warnings.push(message);
}

function isBlockColor(value: unknown): value is BlockColor {
  return typeof value === 'string' && (BLOCK_COLORS as readonly string[]).includes(value);
}

function extensionOf(path: string): string {
  return /\.([A-Za-z0-9]{1,10})$/.exec(path)?.[1]?.toLowerCase() ?? '';
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasScheme(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

function text(value: string, marks: readonly Mark[]): AnyNodeJSON {
  return marks.length
    ? { type: 'text', text: value, marks: [...marks] }
    : { type: 'text', text: value };
}

function paragraph(content: AnyNodeJSON[], attrs?: Attrs): AnyNodeJSON {
  const node: AnyNodeJSON = { type: 'paragraph' };
  if (attrs) node.attrs = attrs;
  if (content.length) node.content = content;
  return node;
}

// ---------------------------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------------------------

interface InlineState {
  /** Marks opened by inline HTML tags (`<u>`, `<mark>`), shared across one paragraph. */
  html: Array<{ tag: string; mark: Mark }>;
  inTableCell: boolean;
  /** Inside <script>, <style> and similar inline HTML: their content is dropped. */
  skip: string | null;
}

function inlineState(inTableCell: boolean): InlineState {
  return { html: [], inTableCell, skip: null };
}

const SKIPPED_TAGS = /^<(\/?)(script|style|template|noscript|iframe|object|textarea)\b[^>]*>$/i;

function withHtmlMarks(marks: readonly Mark[], state: InlineState): Mark[] {
  return state.html.length ? [...marks, ...state.html.map((frame) => frame.mark)] : [...marks];
}

function pushText(items: Item[], value: string, marks: readonly Mark[]): void {
  const lines = value.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) items.push({ kind: 'inline', node: { type: 'hardBreak' } });
    if (line) items.push({ kind: 'inline', node: text(line, marks) });
  });
}

const autolinkTransforms = gfmAutolinkLiteralFromMarkdown().transforms ?? [];

/**
 * Splits text into text and autolinked URLs and emails, exactly as GFM does for markdown text.
 * Text that does not come from markdown text (raw HTML, unresolved links kept as literals) goes
 * through it too, so parsing what we serialize finds the same links.
 */
export function autolinkText(value: string): Array<{ text: string; href: string | null }> {
  if (!/[:@.]/.test(value)) return [{ text: value, href: null }];
  const tree: Root = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
  };
  for (const transform of autolinkTransforms) transform(tree);
  const paragraphNode = tree.children[0];
  if (paragraphNode?.type !== 'paragraph') return [{ text: value, href: null }];
  return paragraphNode.children.map((child) =>
    child.type === 'link'
      ? { text: toString(child), href: child.url }
      : { text: toString(child), href: null },
  );
}

/** Pushes text that did not come from a markdown text node (see {@link autolinkText}). */
function pushLiteral(items: Item[], value: string, marks: readonly Mark[]): void {
  if (marks.some((mark) => mark.type === 'link' || mark.type === 'code')) {
    pushText(items, value, marks);
    return;
  }
  for (const part of autolinkText(value)) {
    pushText(
      items,
      part.text,
      part.href && isSafeHref(part.href)
        ? [...marks, { type: 'link', attrs: { href: part.href, title: null } }]
        : marks,
    );
  }
}

function imageItem(
  url: string,
  rawAlt: string | null | undefined,
  title: string | null | undefined,
  ctx: Context,
): Item | null {
  let alt = rawAlt ?? '';
  let width: number | null = null;
  const sized = /^(.*)\|\s*(\d{1,3})%\s*$/s.exec(alt);
  if (sized) {
    alt = sized[1] ?? '';
    width = Number(sized[2]);
  } else {
    // Obsidian pixel sizes (`alt|300`, `alt|300x200`) have no equivalent: drop them.
    alt = alt.replace(/\|\s*\d+(x\d+)?\s*$/, '');
  }
  const attrs: Attrs = { alt: alt || null, title: title || null };
  if (width !== null) attrs.width = width;
  if (url.startsWith(ASSET_URL_PREFIX)) {
    return {
      kind: 'block',
      node: { type: 'image', attrs: { ...attrs, assetId: url.slice(ASSET_URL_PREFIX.length) } },
    };
  }
  if (isEmbeddableUrl(url)) {
    const data: Record<string, string> = { display: 'embed' };
    if (alt) data.title = alt;
    return { kind: 'block', node: { type: 'embed', attrs: { kind: 'web', ref: url, data } } };
  }
  if (hasScheme(url)) {
    const shown = url.slice(0, 80);
    if (isSafeImageSrc(url))
      return { kind: 'block', node: { type: 'image', attrs: { ...attrs, src: url } } };
    warn(ctx, `Unsafe image source removed: ${shown}`);
    return null;
  }
  const path = safeDecode(url.split(/[?#]/)[0] ?? '');
  const assetId = path ? ctx.options.resolveAsset?.(path) : null;
  if (assetId) return { kind: 'block', node: { type: 'image', attrs: { ...attrs, assetId } } };
  if (ctx.options.resolveAsset) warn(ctx, `Image not found: ${path}`);
  if (!url || !isSafeImageSrc(url)) return null;
  return { kind: 'block', node: { type: 'image', attrs: { ...attrs, src: url } } };
}

function fileEmbed(assetId: string, name: string): AnyNodeJSON {
  return { type: 'embed', attrs: { kind: 'file', ref: assetId, data: { name } } };
}

function convertWikiLink(
  node: WikiLink,
  marks: readonly Mark[],
  state: InlineState,
  ctx: Context,
  items: Item[],
): void {
  const parts = parseWikiLink(node.value, state.inTableCell);
  const literal = `${node.embed ? '!' : ''}[[${node.value}]]`;
  const extension = extensionOf(parts.target);
  const looksLikeFile = extension !== '' && !PAGE_EXTENSIONS.has(extension);
  const resolvePage = () => ctx.options.resolvePageLink?.(parts.target) ?? null;
  const resolveAsset = () =>
    parts.target ? (ctx.options.resolveAsset?.(parts.target) ?? null) : null;
  const assetBlock = (assetId: string): AnyNodeJSON => {
    if (isImagePath(parts.target)) {
      const alt = parts.alias && !/^\d+(x\d+)?$/.test(parts.alias) ? parts.alias : null;
      return { type: 'image', attrs: { assetId, alt } };
    }
    return fileEmbed(assetId, basename(parts.target));
  };
  if (node.embed) {
    const assetId = looksLikeFile ? resolveAsset() : null;
    if (assetId) {
      items.push({ kind: 'block', node: assetBlock(assetId) });
      return;
    }
    const pageId = resolvePage();
    if (pageId) {
      if (ctx.options.isDatabase?.(pageId)) {
        items.push({
          kind: 'block',
          node: { type: 'embed', attrs: { kind: 'database', ref: pageId, data: { viewId: null } } },
        });
        return;
      }
      warn(ctx, 'Embedded notes (![[Note]]) were imported as links', 'note-embed');
      items.push({
        kind: 'inline',
        node: {
          type: 'pageLink',
          attrs: { pageId, label: parts.alias, heading: parts.heading, blockRef: parts.blockRef },
        },
      });
      return;
    }
    const lateAsset = looksLikeFile ? null : resolveAsset();
    if (lateAsset) {
      items.push({ kind: 'block', node: assetBlock(lateAsset) });
      return;
    }
    warn(ctx, `Unresolved embed: ${literal}`);
    pushLiteral(items, literal, withHtmlMarks(marks, state));
    return;
  }
  const pageId = resolvePage();
  if (pageId) {
    items.push({
      kind: 'inline',
      node: {
        type: 'pageLink',
        attrs: {
          pageId,
          label: parts.alias,
          heading: parts.heading,
          blockRef: parts.blockRef && isValidBlockId(parts.blockRef) ? parts.blockRef : null,
        },
      },
    });
    return;
  }
  const assetId = looksLikeFile ? resolveAsset() : null;
  if (assetId) {
    pushLiteral(items, parts.alias ?? basename(parts.target), withHtmlMarks(marks, state));
    items.push({ kind: 'after', node: assetBlock(assetId) });
    return;
  }
  warn(ctx, `Unresolved link: ${literal}`);
  pushLiteral(items, literal, withHtmlMarks(marks, state));
}

function convertLink(
  url: string,
  title: string | null | undefined,
  children: PhrasingContent[],
  marks: readonly Mark[],
  state: InlineState,
  ctx: Context,
  items: Item[],
): void {
  const label = toString({ type: 'paragraph', children });
  if (!hasScheme(url) && !url.startsWith('//')) {
    const hashIndex = url.indexOf('#');
    const pathPart = safeDecode(
      (hashIndex >= 0 ? url.slice(0, hashIndex) : url).split('?')[0] ?? '',
    );
    const fragment = hashIndex >= 0 ? safeDecode(url.slice(hashIndex + 1)) : '';
    const extension = extensionOf(pathPart);
    const pageLike =
      pathPart === '' ? fragment !== '' : extension === '' || PAGE_EXTENSIONS.has(extension);
    if (pageLike && ctx.options.resolvePageLink) {
      const pageId = ctx.options.resolvePageLink(pathPart);
      if (pageId) {
        const blockRef = fragment.startsWith('^') ? fragment.slice(1) : null;
        items.push({
          kind: 'inline',
          node: {
            type: 'pageLink',
            attrs: {
              pageId,
              label: label || null,
              heading: fragment && !blockRef ? fragment : null,
              blockRef: blockRef && isValidBlockId(blockRef) ? blockRef : null,
            },
          },
        });
        return;
      }
      if (pathPart) warn(ctx, `Unresolved link: ${url}`);
    } else if (
      pathPart &&
      extension &&
      !PAGE_EXTENSIONS.has(extension) &&
      ctx.options.resolveAsset
    ) {
      const assetId = ctx.options.resolveAsset(pathPart);
      if (assetId) {
        if (label && label !== basename(pathPart))
          pushLiteral(items, label, withHtmlMarks(marks, state));
        items.push({
          kind: label && label !== basename(pathPart) ? 'after' : 'block',
          node: isImagePath(pathPart)
            ? { type: 'image', attrs: { assetId, alt: label || null } }
            : fileEmbed(assetId, basename(pathPart)),
        });
        return;
      }
      warn(ctx, `Attachment not found: ${pathPart}`);
    }
  }
  const shownUrl = url.slice(0, 80);
  if (!isSafeHref(url)) {
    if (shownUrl) warn(ctx, `Unsafe link removed: ${shownUrl}`);
    convertPhrasing(children, marks, state, ctx, items);
    return;
  }
  const link: Mark = { type: 'link', attrs: { href: url, title: title || null } };
  convertPhrasing(children, [...marks, link], state, ctx, items);
}

function convertInlineHtml(
  value: string,
  marks: readonly Mark[],
  state: InlineState,
  ctx: Context,
  items: Item[],
): void {
  const skipped = SKIPPED_TAGS.exec(value.trim());
  if (skipped?.[2]) {
    const name = skipped[2].toLowerCase();
    if (skipped[1]) {
      if (state.skip === name) state.skip = null;
    } else if (!/\/>$/.test(value.trim())) {
      state.skip = name;
    }
    return;
  }
  if (state.skip) return;
  for (const token of tokenizeHtml(value)) {
    applyHtmlToken(token, marks, state, ctx, items);
  }
}

function applyHtmlToken(
  token: HtmlToken,
  marks: readonly Mark[],
  state: InlineState,
  ctx: Context,
  items: Item[],
): void {
  switch (token.type) {
    case 'text':
      pushLiteral(items, token.value.replace(/\s+/g, ' '), withHtmlMarks(marks, state));
      return;
    case 'comment':
      return;
    case 'close': {
      const index = state.html.map((frame) => frame.tag).lastIndexOf(token.name);
      if (index >= 0) state.html.splice(index, 1);
      return;
    }
    case 'open': {
      const { name, attrs } = token;
      if (name === 'br') {
        items.push({ kind: 'inline', node: { type: 'hardBreak' } });
        return;
      }
      if (name === 'img') {
        const item = attrs.src
          ? imageItem(attrs.src, attrs.alt ?? null, attrs.title ?? null, ctx)
          : null;
        if (item) items.push(item);
        return;
      }
      if (name === 'a') {
        if (attrs.href && isSafeHref(attrs.href) && !token.selfClosing)
          state.html.push({
            tag: 'a',
            mark: { type: 'link', attrs: { href: attrs.href, title: attrs.title ?? null } },
          });
        return;
      }
      const markType = HTML_MARK_TAGS[name];
      if (markType && !token.selfClosing) {
        const color = markType === 'highlight' ? attrs['data-color'] : undefined;
        state.html.push({
          tag: name,
          mark:
            markType === 'highlight'
              ? { type: 'highlight', attrs: { color: color ?? null } }
              : { type: markType },
        });
        return;
      }
      if (
        !['span', 'sup', 'sub', 'small', 'font', 'abbr', 'cite', 'q', 'time', 'wbr'].includes(name)
      )
        warn(ctx, 'Some HTML was simplified to text', 'html-simplified');
    }
  }
}

function convertPhrasing(
  nodes: readonly PhrasingContent[],
  marks: readonly Mark[],
  state: InlineState,
  ctx: Context,
  items: Item[],
): void {
  for (const node of nodes) {
    if (state.skip && node.type !== 'html') continue;
    switch (node.type) {
      case 'text':
        pushText(items, node.value, withHtmlMarks(marks, state));
        break;
      case 'strong':
        convertPhrasing(node.children, [...marks, { type: 'bold' }], state, ctx, items);
        break;
      case 'emphasis':
        convertPhrasing(node.children, [...marks, { type: 'italic' }], state, ctx, items);
        break;
      case 'delete':
        convertPhrasing(node.children, [...marks, { type: 'strike' }], state, ctx, items);
        break;
      case 'highlight':
        convertPhrasing(
          node.children,
          [...marks, { type: 'highlight', attrs: { color: null } }],
          state,
          ctx,
          items,
        );
        break;
      case 'inlineCode':
        // CommonMark turns the line endings of a code span into spaces (mdast keeps them).
        if (node.value)
          items.push({
            kind: 'inline',
            node: text(node.value.replace(/\r\n|\r|\n/g, ' '), [
              ...withHtmlMarks(marks, state),
              { type: 'code' },
            ]),
          });
        break;
      case 'break':
        items.push({ kind: 'inline', node: { type: 'hardBreak' } });
        break;
      case 'link':
        convertLink(node.url, node.title, node.children, marks, state, ctx, items);
        break;
      case 'linkReference': {
        const definition = ctx.definitions.get(node.identifier.toLowerCase());
        if (definition)
          convertLink(definition.url, definition.title, node.children, marks, state, ctx, items);
        else convertPhrasing(node.children, marks, state, ctx, items);
        break;
      }
      case 'image': {
        const item = imageItem(node.url, node.alt, node.title, ctx);
        if (item) items.push(item);
        else if (node.alt) pushLiteral(items, node.alt, withHtmlMarks(marks, state));
        break;
      }
      case 'imageReference': {
        const definition = ctx.definitions.get(node.identifier.toLowerCase());
        const item = definition ? imageItem(definition.url, node.alt, definition.title, ctx) : null;
        if (item) items.push(item);
        else if (node.alt) pushLiteral(items, node.alt, withHtmlMarks(marks, state));
        break;
      }
      case 'html':
        convertInlineHtml(node.value, marks, state, ctx, items);
        break;
      case 'wikiLink':
        convertWikiLink(node, marks, state, ctx, items);
        break;
      case 'tag': {
        const name = normalizeTagName(node.value);
        if (name && isValidTagName(name))
          items.push({ kind: 'inline', node: { type: 'tag', attrs: { name } } });
        else pushLiteral(items, `#${node.value}`, withHtmlMarks(marks, state));
        break;
      }
      case 'blockId':
        pushLiteral(items, `^${node.value}`, withHtmlMarks(marks, state));
        break;
      case 'footnoteReference':
        warn(ctx, 'Footnotes were imported as plain text', 'footnotes');
        pushLiteral(items, `[^${node.label ?? node.identifier}]`, withHtmlMarks(marks, state));
        break;
      default:
        pushLiteral(items, toString(node), withHtmlMarks(marks, state));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Paragraph-like blocks
// ---------------------------------------------------------------------------------------------

/** Attributes found at the end of a textblock: `<!--color:red-->`, ` ^block-id`. */
interface TrailingAttrs {
  blockId: string | null;
  color: BlockColor | null;
  itemColor: BlockColor | null;
  quoteColor: BlockColor | null;
}

function trimTrailingSpace(children: PhrasingContent[]): void {
  const last = children[children.length - 1];
  if (last?.type !== 'text') return;
  const trimmed = last.value.replace(/[ \t]$/, '');
  if (trimmed) children[children.length - 1] = { ...last, value: trimmed };
  else children.pop();
}

function takeTrailingAttrs(source: readonly PhrasingContent[]): {
  children: PhrasingContent[];
  attrs: TrailingAttrs;
} {
  const children = [...source];
  const attrs: TrailingAttrs = { blockId: null, color: null, itemColor: null, quoteColor: null };
  const last = children[children.length - 1];
  if (last?.type === 'blockId') {
    attrs.blockId = last.value;
    children.pop();
    // `text ^id`, or `^id` alone on the paragraph's last line.
    const previous = children[children.length - 1];
    if (previous?.type === 'text' && previous.value.endsWith('\n')) {
      const trimmed = previous.value.slice(0, -1);
      if (trimmed) children[children.length - 1] = { ...previous, value: trimmed };
      else children.pop();
    } else {
      trimTrailingSpace(children);
    }
  }
  for (;;) {
    const tail = children[children.length - 1];
    const match = tail?.type === 'html' ? ATTRIBUTE_COMMENT.exec(tail.value.trim()) : null;
    if (!match?.[2] || !isBlockColor(match[2])) break;
    if (match[1] === 'color') attrs.color = match[2];
    else if (match[1] === 'item-color') attrs.itemColor = match[2];
    else attrs.quoteColor = match[2];
    children.pop();
    trimTrailingSpace(children);
  }
  return { children, attrs };
}

function isBlank(node: AnyNodeJSON): boolean {
  return node.type === 'text' && !(node.text ?? '').trim();
}

function trimRun(run: AnyNodeJSON[]): AnyNodeJSON[] {
  const result = [...run];
  while (result.length && isBlank(result[0] as AnyNodeJSON)) result.shift();
  while (result.length && isBlank(result[result.length - 1] as AnyNodeJSON)) result.pop();
  const first = result[0];
  if (first?.type === 'text')
    result[0] = { ...first, text: (first.text ?? '').replace(/^\s+/, '') };
  const lastIndex = result.length - 1;
  const last = result[lastIndex];
  if (last?.type === 'text')
    result[lastIndex] = { ...last, text: (last.text ?? '').replace(/\s+$/, '') };
  return result.filter((node) => node.type !== 'text' || node.text);
}

/** Splits items into blocks: inline runs become textblocks (`makeBlock`), breakouts stay blocks. */
function itemsToBlocks(
  items: Item[],
  makeBlock: (content: AnyNodeJSON[], first: boolean) => AnyNodeJSON,
): AnyNodeJSON[] {
  const blocks: AnyNodeJSON[] = [];
  const after: AnyNodeJSON[] = [];
  let run: AnyNodeJSON[] = [];
  let textblocks = 0;
  const hasBlocks = items.some((item) => item.kind === 'block');
  const flush = (force: boolean) => {
    const content = hasBlocks ? trimRun(run) : run;
    if (content.length || force) {
      blocks.push(makeBlock(content, textblocks === 0));
      textblocks += 1;
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'inline') run.push(item.node);
    else if (item.kind === 'after') after.push(item.node);
    else {
      flush(false);
      blocks.push(item.node);
    }
  }
  flush(blocks.length === 0);
  return [...blocks, ...after];
}

/**
 * An empty paragraph is written `&nbsp;` (markdown has no empty paragraphs). Only that exact
 * spelling counts: a paragraph holding a real no-break space keeps it.
 */
function isEmptyMarker(node: PhrasingContent | undefined, ctx: Context): boolean {
  if (node?.type !== 'text' || node.value.replace(/[ \t]+$/, '') !== '\u00a0') return false;
  const offset = node.position?.start.offset;
  return offset !== undefined && ctx.source.startsWith('&nbsp;', offset);
}

/** Converts a paragraph (or heading) and its trailing attributes. */
function convertTextblock(
  node: Paragraph | Heading,
  ctx: Context,
  inTableCell = false,
): { blocks: AnyNodeJSON[]; attrs: TrailingAttrs; standaloneBlockId: string | null } {
  const { children, attrs } = takeTrailingAttrs(node.children);
  if (
    node.type === 'paragraph' &&
    children.length === 0 &&
    attrs.blockId &&
    !attrs.color &&
    !attrs.itemColor &&
    !attrs.quoteColor
  ) {
    return { blocks: [], attrs, standaloneBlockId: attrs.blockId };
  }
  const items: Item[] = [];
  const content = children.length === 1 && isEmptyMarker(children[0], ctx) ? [] : children;
  convertPhrasing(content, [], inlineState(inTableCell), ctx, items);
  let level = 1;
  if (node.type === 'heading') {
    if (node.depth > 3)
      warn(ctx, `Level ${node.depth} headings were imported as level 3`, 'heading-depth');
    level = Math.min(3, node.depth);
  }
  const blocks = itemsToBlocks(items, (inline) => {
    if (node.type === 'heading') {
      const heading: AnyNodeJSON = { type: 'heading', attrs: { level } };
      if (inline.length) heading.content = inline;
      return heading;
    }
    return paragraph(inline);
  });
  const firstText = blocks.find((block) => block.type === 'paragraph' || block.type === 'heading');
  if (firstText && attrs.color) firstText.attrs = { ...firstText.attrs, color: attrs.color };
  return { blocks, attrs, standaloneBlockId: null };
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

const BLOCK_ID_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'callout',
  'codeBlock',
  'image',
  'table',
  'toggle',
  'embed',
]);

function assignBlockId(block: AnyNodeJSON | undefined, blockId: string): boolean {
  if (!block || !isValidBlockId(blockId)) return false;
  if (BLOCK_ID_TYPES.has(block.type)) {
    if (block.attrs?.blockId) return false;
    block.attrs = { ...block.attrs, blockId };
    return true;
  }
  if (block.type === 'bulletList' || block.type === 'orderedList' || block.type === 'taskList') {
    return assignBlockId(block.content?.[block.content.length - 1], blockId);
  }
  if (block.type === 'listItem' || block.type === 'taskItem') {
    if (block.attrs?.blockId) return false;
    block.attrs = { ...block.attrs, blockId };
    return true;
  }
  return false;
}

/** Container attributes found on the first paragraph of a list item or blockquote. */
interface FlowResult {
  blocks: AnyNodeJSON[];
  blockId: string | null;
  itemColor: BlockColor | null;
  quoteColor: BlockColor | null;
}

function convertFlow(
  nodes: readonly RootContent[],
  ctx: Context,
  container: 'doc' | 'listItem' | 'blockquote' | 'other',
): FlowResult {
  const result: FlowResult = { blocks: [], blockId: null, itemColor: null, quoteColor: null };
  const out = result.blocks;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    switch (node.type) {
      case 'paragraph':
      case 'heading': {
        const converted = convertTextblock(node, ctx);
        if (converted.standaloneBlockId) {
          if (!assignBlockId(out[out.length - 1], converted.standaloneBlockId))
            out.push(paragraph([text(`^${converted.standaloneBlockId}`, [])]));
          break;
        }
        const firstInContainer = index === 0 && node.type === 'paragraph';
        const { attrs } = converted;
        let blockIdTarget: AnyNodeJSON | undefined = converted.blocks[converted.blocks.length - 1];
        if (firstInContainer && container === 'listItem') {
          result.blockId = attrs.blockId;
          result.itemColor = attrs.itemColor;
          blockIdTarget = undefined;
        }
        if (firstInContainer && container === 'blockquote') result.quoteColor = attrs.quoteColor;
        if (attrs.blockId && blockIdTarget) assignBlockId(blockIdTarget, attrs.blockId);
        out.push(...converted.blocks);
        break;
      }
      case 'blockquote':
        out.push(convertBlockquote(node, ctx));
        break;
      case 'list':
        out.push(...convertList(node, ctx));
        break;
      case 'code':
        out.push(convertCode(node));
        break;
      case 'thematicBreak':
        out.push({ type: 'horizontalRule' });
        break;
      case 'table':
        out.push(convertTable(node, ctx));
        break;
      case 'html': {
        if (/^<aside[\s>]/i.test(node.value.trim())) {
          const { callout, consumed } = convertAside(nodes, index, ctx);
          out.push(callout);
          index += consumed - 1;
          break;
        }
        if (/^<details[\s>]/i.test(node.value.trim())) {
          const { toggle, consumed } = convertToggle(nodes, index, ctx);
          out.push(toggle);
          index += consumed - 1;
          break;
        }
        const comment = ATTRIBUTE_COMMENT.exec(node.value.trim());
        if (comment?.[1] === 'color' && isBlockColor(comment[2])) {
          out.push(paragraph([], { color: comment[2] }));
          break;
        }
        if (
          comment?.[1] === 'quote-color' &&
          isBlockColor(comment[2]) &&
          index === 0 &&
          container === 'blockquote'
        ) {
          result.quoteColor = comment[2];
          break;
        }
        out.push(...htmlToBlocks(node.value, ctx));
        break;
      }
      case 'footnoteDefinition': {
        warn(ctx, 'Footnotes were imported as plain text', 'footnotes');
        const inner = convertFlow(node.children, ctx, 'other').blocks;
        const label = `[^${node.label ?? node.identifier}]: `;
        const first = inner[0];
        if (first?.type === 'paragraph')
          first.content = [text(label, []), ...(first.content ?? [])];
        else inner.unshift(paragraph([text(label.trim(), [])]));
        out.push(...inner);
        break;
      }
      case 'definition':
      case 'yaml':
        break;
      default: {
        const value = toString(node);
        if (value) out.push(paragraph([text(value, [])]));
      }
    }
  }
  return result;
}

function convertCode(node: Code): AnyNodeJSON {
  const language = node.lang?.trim().toLowerCase() ?? null;
  if (language === EMBED_FENCE_LANGUAGE) {
    const embed = parseEmbedFence(node.value);
    if (embed) {
      return {
        type: 'embed',
        attrs: { kind: embed.kind, ref: embed.ref, data: embed.data, blockId: embed.blockId },
      };
    }
  }
  const block: AnyNodeJSON = {
    type: 'codeBlock',
    attrs: { language: language && LANGUAGE_PATTERN.test(language) ? language : null },
  };
  if (node.value) block.content = [{ type: 'text', text: node.value }];
  return block;
}

/** Splits phrasing at the first line break: the rest of the line, then the remainder. */
function splitFirstLine(children: readonly PhrasingContent[]): {
  line: PhrasingContent[];
  rest: PhrasingContent[];
} {
  const line: PhrasingContent[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child) continue;
    if (child.type === 'break') return { line, rest: children.slice(index + 1) };
    if (child.type === 'text' && child.value.includes('\n')) {
      const newline = child.value.indexOf('\n');
      const before = child.value.slice(0, newline);
      const after = child.value.slice(newline + 1);
      if (before) line.push({ type: 'text', value: before });
      const rest = children.slice(index + 1);
      return { line, rest: after ? [{ type: 'text', value: after }, ...rest] : rest };
    }
    line.push(child);
  }
  return { line, rest: [] };
}

function inlineOf(children: readonly PhrasingContent[], ctx: Context): AnyNodeJSON[] {
  const items: Item[] = [];
  convertPhrasing(children, [], inlineState(false), ctx, items);
  return items.filter((item) => item.kind === 'inline').map((item) => item.node);
}

function convertBlockquote(node: Blockquote, ctx: Context): AnyNodeJSON {
  const [first, ...others] = node.children;
  const firstChild = first?.type === 'paragraph' ? first.children[0] : undefined;
  const header = firstChild?.type === 'text' ? parseCalloutMarker(firstChild.value) : null;
  if (!header || first?.type !== 'paragraph' || firstChild?.type !== 'text') {
    const flow = convertFlow(node.children, ctx, 'blockquote');
    const quote: AnyNodeJSON = { type: 'blockquote', content: flow.blocks };
    if (flow.quoteColor) quote.attrs = { color: flow.quoteColor };
    return quote;
  }
  const remainder = firstChild.value.slice(header.length).replace(/^[ \t]/, '');
  const firstChildren: PhrasingContent[] = remainder
    ? [{ type: 'text', value: remainder }, ...first.children.slice(1)]
    : first.children.slice(1);
  const { line, rest } = splitFirstLine(firstChildren);
  const titleInline = inlineOf(line, ctx);
  const bodyNodes: RootContent[] = [];
  if (rest.length) bodyNodes.push({ type: 'paragraph', children: rest });
  bodyNodes.push(...others);
  const body = convertFlow(bodyNodes, ctx, 'other').blocks;
  const attrs = { emoji: header.emoji, tone: header.tone };
  if (header.foldOpen !== null) {
    const summary: AnyNodeJSON = { type: 'toggleSummary' };
    if (titleInline.length) summary.content = titleInline;
    return {
      type: 'callout',
      attrs,
      content: [{ type: 'toggle', attrs: { open: header.foldOpen }, content: [summary, ...body] }],
    };
  }
  const content: AnyNodeJSON[] = [];
  if (titleInline.length) {
    content.push(
      paragraph(
        titleInline.map((inline) =>
          inline.type === 'text'
            ? {
                ...inline,
                marks: [
                  ...(inline.marks ?? []).filter((mark) => mark.type !== 'bold'),
                  { type: 'bold' },
                ],
              }
            : inline,
        ),
      ),
    );
  }
  content.push(...body);
  return { type: 'callout', attrs, content: content.length ? content : [paragraph([])] };
}

function convertListItem(item: ListItem, ctx: Context, task: boolean): AnyNodeJSON {
  const flow = convertFlow(item.children, ctx, 'listItem');
  const attrs: Attrs = {};
  if (task) attrs.checked = item.checked === true;
  if (flow.itemColor) attrs.color = flow.itemColor;
  if (flow.blockId && isValidBlockId(flow.blockId)) attrs.blockId = flow.blockId;
  return {
    type: task ? 'taskItem' : 'listItem',
    attrs,
    content: flow.blocks.length ? flow.blocks : [paragraph([])],
  };
}

function convertList(node: List, ctx: Context): AnyNodeJSON[] {
  const lists: AnyNodeJSON[] = [];
  let group: { task: boolean; items: AnyNodeJSON[]; start: number } | null = null;
  const start = node.start ?? 1;
  node.children.forEach((item, index) => {
    const task = typeof item.checked === 'boolean';
    if (!group || group.task !== task) {
      group = { task, items: [], start: start + index };
      const list: AnyNodeJSON = {
        type: task ? 'taskList' : node.ordered ? 'orderedList' : 'bulletList',
        content: group.items,
      };
      if (!task && node.ordered) list.attrs = { start: group.start };
      lists.push(list);
    }
    group.items.push(convertListItem(item, ctx, task));
  });
  return lists;
}

function isEmptyCell(cell: TableCell): boolean {
  return cell.children.every((child) => child.type === 'text' && !/[^ \t]/.test(child.value));
}

function convertCell(cell: TableCell, header: boolean, ctx: Context): AnyNodeJSON {
  const items: Item[] = [];
  const children = cell.children.filter((child) => !isEmptyMarker(child, ctx));
  convertPhrasing(children, [], inlineState(true), ctx, items);
  const paragraphs: AnyNodeJSON[][] = [[]];
  let previousBreak = false;
  for (const item of items) {
    if (item.kind !== 'inline') {
      // Table cells hold text only: images and embeds keep their text.
      const attrs = item.node.attrs ?? {};
      const label = typeof attrs.alt === 'string' ? attrs.alt : '';
      if (label) paragraphs[paragraphs.length - 1]?.push(text(label, []));
      warn(ctx, 'Images and embeds inside table cells were imported as text', 'cell-blocks');
      continue;
    }
    const current = paragraphs[paragraphs.length - 1] as AnyNodeJSON[];
    if (item.node.type === 'hardBreak') {
      if (previousBreak) {
        current.pop();
        paragraphs.push([]);
        previousBreak = false;
        continue;
      }
      previousBreak = true;
    } else {
      previousBreak = false;
    }
    current.push(item.node);
  }
  return {
    type: header ? 'tableHeader' : 'tableCell',
    content: paragraphs.map((content) => paragraph(content)),
  };
}

function convertTable(node: Table, ctx: Context): AnyNodeJSON {
  let rows = node.children;
  const [headerRow, ...bodyRows] = rows;
  const dropHeader =
    headerRow !== undefined && bodyRows.length > 0 && headerRow.children.every(isEmptyCell);
  if (dropHeader) rows = bodyRows;
  const width = Math.max(1, ...rows.map((row) => row.children.length));
  return {
    type: 'table',
    content: rows.map((row, rowIndex) => {
      const header = !dropHeader && rowIndex === 0;
      const cells = row.children.map((cell) => convertCell(cell, header, ctx));
      while (cells.length < width)
        cells.push({ type: header ? 'tableHeader' : 'tableCell', content: [paragraph([])] });
      return { type: 'tableRow', content: cells };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Toggles (`<details>`) and other HTML
// ---------------------------------------------------------------------------------------------

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

/**
 * Collects an HTML container written around markdown (`<details>…</details>`,
 * `<aside>…</aside>`): the markdown after the opening tag in the first HTML block (`rest`),
 * the blocks up to the matching closing tag, and markdown before that tag. Nested containers of
 * the same kind are matched by depth; without a closing tag the container runs to the end of its
 * parent.
 */
function collectContainer(
  nodes: readonly RootContent[],
  start: number,
  tag: string,
  rest: string,
  ctx: Context,
): { body: AnyNodeJSON[]; consumed: number } {
  const open = new RegExp(`<${tag}(?=[\\s>])`, 'gi');
  const close = new RegExp(`</${tag}\\s*>`, 'gi');
  const trailingClose = new RegExp(`</${tag}\\s*>\\s*$`, 'i');
  const body: AnyNodeJSON[] = [];
  const parseNested = (markdown: string) => {
    if (/[^ \t\r\n]/.test(markdown) && ctx.depth < 20) {
      ctx.depth += 1;
      body.push(
        ...withSource(
          ctx,
          markdown,
          () => convertFlow(ctx.parseMarkdown(markdown).children, ctx, 'other').blocks,
        ),
      );
      ctx.depth -= 1;
    }
  };
  // Everything in one HTML block: `<details><summary>A</summary>Body</details>`.
  let depth = 1 + countMatches(rest, open) - countMatches(rest, close);
  if (depth <= 0) {
    parseNested(rest.replace(trailingClose, ''));
    return { body, consumed: 1 };
  }
  parseNested(rest);
  const inner: RootContent[] = [];
  let index = start + 1;
  for (; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    if (node.type === 'html') {
      const opens = countMatches(node.value, open);
      const closes = countMatches(node.value, close);
      if (depth + opens - closes <= 0 && closes > 0) {
        body.push(...convertFlow(inner, ctx, 'other').blocks);
        parseNested(node.value.replace(trailingClose, ''));
        return { body, consumed: index - start + 1 };
      }
      depth += opens - closes;
    }
    inner.push(node);
  }
  body.push(...convertFlow(inner, ctx, 'other').blocks);
  return { body, consumed: index - start };
}

function convertToggle(
  nodes: readonly RootContent[],
  start: number,
  ctx: Context,
): { toggle: AnyNodeJSON; consumed: number } {
  const openNode = nodes[start] as Html;
  const source = openNode.value.trim();
  const tag = /^<details([^>]*)>/i.exec(source);
  const tagAttrs = tokenizeHtml(`<x${tag?.[1] ?? ''}>`)[0];
  const attrs: Attrs = { open: false };
  if (tagAttrs?.type === 'open') {
    attrs.open = Object.hasOwn(tagAttrs.attrs, 'open');
    const color = tagAttrs.attrs['data-color'];
    if (isBlockColor(color)) attrs.color = color;
    const blockId = tagAttrs.attrs['data-block-id'];
    if (isValidBlockId(blockId)) attrs.blockId = blockId;
  }
  let rest = source.slice(tag?.[0].length ?? 0);
  let summaryMarkdown = '';
  let nodesForBody: readonly RootContent[] = nodes;
  let bodyStart = start;
  const summary = /^\s*<summary[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(rest);
  if (summary) {
    summaryMarkdown = summary[1] ?? '';
    rest = rest.slice(summary[0].length);
  } else {
    // `<details>` and `<summary>` in separate HTML blocks.
    const next = nodes[start + 1];
    const nextSummary =
      next?.type === 'html'
        ? /^\s*<summary[^>]*>([\s\S]*?)<\/summary\s*>([\s\S]*)$/i.exec(next.value)
        : null;
    if (nextSummary) {
      summaryMarkdown = nextSummary[1] ?? '';
      rest = `${rest}\n${nextSummary[2] ?? ''}`;
      nodesForBody = [...nodes.slice(0, start + 1), ...nodes.slice(start + 2)];
      bodyStart = start;
    }
  }
  const summaryInline = /[^ \t\r\n]/.test(summaryMarkdown)
    ? inlineOfMarkdown(summaryMarkdown, ctx)
    : [];
  const summaryNode: AnyNodeJSON = { type: 'toggleSummary' };
  if (summaryInline.length) summaryNode.content = summaryInline;
  const { body, consumed } = collectContainer(nodesForBody, bodyStart, 'details', rest, ctx);
  return {
    toggle: { type: 'toggle', attrs, content: [summaryNode, ...body] },
    consumed: consumed + (nodesForBody === nodes ? 0 : 1),
  };
}

/** Notion exports callouts as `<aside>` with the icon first: they become callouts again. */
function convertAside(
  nodes: readonly RootContent[],
  start: number,
  ctx: Context,
): { callout: AnyNodeJSON; consumed: number } {
  const source = (nodes[start] as Html).value.trim();
  const tag = /^<aside[^>]*>/i.exec(source);
  let rest = source.slice(tag?.[0].length ?? 0).replace(/^\s+/, '');
  let emoji: string | null = '💡';
  const first = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u.exec(
    rest,
  );
  if (first?.[1]) {
    emoji = first[1];
    rest = rest.slice(first[0].length);
  }
  const { body, consumed } = collectContainer(nodes, start, 'aside', rest, ctx);
  const tone = CALLOUT_TYPES.find((entry) => entry.emoji === emoji)?.tone ?? 'default';
  return {
    callout: {
      type: 'callout',
      attrs: { emoji, tone },
      content: body.length ? body : [paragraph([])],
    },
    consumed,
  };
}

/** Runs a conversion of nested markdown, whose node positions point into `source`. */
function withSource<T>(ctx: Context, source: string, run: () => T): T {
  const previous = ctx.source;
  ctx.source = source;
  try {
    return run();
  } finally {
    ctx.source = previous;
  }
}

function inlineOfMarkdown(markdown: string, ctx: Context): AnyNodeJSON[] {
  return withSource(ctx, markdown, () => inlineOfTree(ctx.parseMarkdown(markdown), ctx));
}

function inlineOfTree(root: Root, ctx: Context): AnyNodeJSON[] {
  const children: PhrasingContent[] = [];
  root.children.forEach((node, index) => {
    if (index > 0) children.push({ type: 'break' });
    if (node.type === 'paragraph' || node.type === 'heading') children.push(...node.children);
    else children.push({ type: 'text', value: toString(node) });
  });
  return inlineOf(children, ctx);
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'li',
  'tr',
  'section',
  'article',
  'header',
  'footer',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'table',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'dd',
  'center',
  'details',
  'summary',
  'aside',
  'nav',
  'main',
]);

/**
 * Converts a block of raw HTML (from markdown, or `parseHTML` without a DOM) into blocks through
 * the whitelist tokenizer: headings and paragraphs keep their text and inline formatting, images
 * stay images, everything else becomes plain text.
 */
export function htmlToBlocksWith(html: string, ctx: Context): AnyNodeJSON[] {
  const blocks: AnyNodeJSON[] = [];
  let items: Item[] = [];
  let heading: number | null = null;
  const state: InlineState = inlineState(false);
  const flush = () => {
    const level = heading;
    const converted = itemsToBlocks(items, (content) => {
      const trimmed = trimRun(content);
      if (level) {
        const node: AnyNodeJSON = { type: 'heading', attrs: { level: Math.min(3, level) } };
        if (trimmed.length) node.content = trimmed;
        return node;
      }
      return paragraph(trimmed);
    });
    for (const block of converted) {
      if (
        (block.type === 'paragraph' || block.type === 'heading') &&
        !block.content?.length &&
        !level
      )
        continue;
      blocks.push(block);
    }
    items = [];
  };
  for (const token of tokenizeHtml(html)) {
    if ((token.type === 'open' || token.type === 'close') && BLOCK_TAGS.has(token.name)) {
      flush();
      heading = token.type === 'open' && /^h[1-6]$/.test(token.name) ? Number(token.name[1]) : null;
      if (token.type === 'open' && token.name === 'hr') blocks.push({ type: 'horizontalRule' });
      continue;
    }
    applyHtmlToken(token, [], state, ctx, items);
  }
  flush();
  if (blocks.length) warn(ctx, 'Some HTML was simplified to text', 'html-simplified');
  return blocks;
}

function htmlToBlocks(html: string, ctx: Context): AnyNodeJSON[] {
  return htmlToBlocksWith(html, ctx);
}

/** {@link htmlToBlocksWith} without a conversion context (warnings are dropped). */
export function htmlToBlocksStandalone(html: string): AnyNodeJSON[] {
  return htmlToBlocksWith(
    html,
    createContext({}, () => ({ type: 'root', children: [] })),
  );
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

function collectDefinitions(
  tree: Nodes,
  into: Map<string, { url: string; title: string | null }>,
): void {
  if (tree.type === 'definition') {
    if (!into.has(tree.identifier.toLowerCase()))
      into.set(tree.identifier.toLowerCase(), { url: tree.url, title: tree.title ?? null });
    return;
  }
  if ('children' in tree)
    for (const child of tree.children) collectDefinitions(child as Nodes, into);
}

/** Creates a conversion context. */
export function createContext(
  options: ToDocOptions,
  parseMarkdown: (markdown: string) => Root,
  source = '',
): Context {
  return {
    options,
    warnings: [],
    warned: new Set(),
    definitions: new Map(),
    parseMarkdown,
    source,
    depth: 0,
  };
}

/**
 * Converts a markdown syntax tree into DocJSON content (not yet normalized: the codec runs
 * `normalizeDocJSON` last).
 */
export function mdastToDoc(tree: Root, ctx: Context): AnyNodeJSON {
  collectDefinitions(tree, ctx.definitions);
  const { blocks } = convertFlow(tree.children, ctx, 'doc');
  return { type: 'doc', content: blocks };
}

/** Decodes entities in plain text (for callers outside the tree conversion). */
export { decodeEntities };
