import type { Link, Parents, PhrasingContent } from 'mdast';
import type {
  CompileContext,
  Extension as FromMarkdownExtension,
  Token,
} from 'mdast-util-from-markdown';
import {
  defaultHandlers,
  type ConstructName,
  type Handle,
  type Info,
  type Options as ToMarkdownExtension,
  type State,
  type Unsafe,
} from 'mdast-util-to-markdown';
import { toString } from 'mdast-util-to-string';
import { classifyCharacter } from 'micromark-util-classify-character';
import type {
  BlockIdMarker,
  CalloutMarker,
  Highlight,
  TagNode,
  ToggleNode,
  WikiLink,
} from './nodes';

/** Constructs in which phrasing markers mean nothing (as in mdast-util-to-markdown). */
const fullPhrasingSpans: ConstructName[] = [
  'autolink',
  'destinationLiteral',
  'destinationRaw',
  'reference',
  'titleQuote',
  'titleApostrophe',
];

function top<T>(context: CompileContext): T {
  return context.stack[context.stack.length - 1] as T;
}

/** mdast-util-from-markdown extension turning the Tessera tokens into mdast nodes. */
export function tesseraFromMarkdown(): FromMarkdownExtension {
  return {
    canContainEols: ['highlight'],
    enter: {
      wikiLink(this: CompileContext, token: Token) {
        const node: WikiLink = { type: 'wikiLink', value: '', embed: false };
        this.enter(node, token);
      },
      wikiLinkEmbedMarker(this: CompileContext) {
        top<WikiLink>(this).embed = true;
      },
      tag(this: CompileContext, token: Token) {
        const node: TagNode = { type: 'tag', value: '' };
        this.enter(node, token);
      },
      highlight(this: CompileContext, token: Token) {
        const node: Highlight = { type: 'highlight', children: [] };
        this.enter(node, token);
      },
      blockId(this: CompileContext, token: Token) {
        const node: BlockIdMarker = { type: 'blockId', value: '' };
        this.enter(node, token);
      },
    },
    exit: {
      wikiLinkValue(this: CompileContext, token: Token) {
        top<WikiLink>(this).value = this.sliceSerialize(token);
      },
      wikiLink(this: CompileContext, token: Token) {
        this.exit(token);
      },
      tagName(this: CompileContext, token: Token) {
        top<TagNode>(this).value = this.sliceSerialize(token);
      },
      tag(this: CompileContext, token: Token) {
        this.exit(token);
      },
      highlight(this: CompileContext, token: Token) {
        this.exit(token);
      },
      blockIdValue(this: CompileContext, token: Token) {
        top<BlockIdMarker>(this).value = this.sliceSerialize(token);
      },
      blockId(this: CompileContext, token: Token) {
        this.exit(token);
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------

/** Encodes a character as a hexadecimal character reference. */
function characterReference(code: number): string {
  return `&#x${code.toString(16).toUpperCase()};`;
}

/**
 * Whether the characters around an attention-like run (`==`) must be encoded for the run to
 * open or close, with the same rules as `*` (see mdast-util-to-markdown's `encodeInfo`).
 */
function encodeSides(outside: number, inside: number): { inside: boolean; outside: boolean } {
  const outsideKind = classifyCharacter(outside);
  const insideKind = classifyCharacter(inside);
  if (outsideKind === undefined) {
    if (insideKind === undefined) return { inside: false, outside: false };
    return insideKind === 1 ? { inside: true, outside: true } : { inside: false, outside: true };
  }
  if (outsideKind === 1) {
    return insideKind === 1 ? { inside: true, outside: true } : { inside: false, outside: false };
  }
  return insideKind === 1 ? { inside: true, outside: false } : { inside: false, outside: false };
}

/** A handler with a `peek` (the first character it writes, used to escape the text before it). */
function withPeek(handle: Handle, peek: Handle): Handle {
  return Object.assign(handle, { peek });
}

function inScope(state: State, name: ConstructName): boolean {
  return state.stack.includes(name);
}

/** A CommonMark email autolink's address: each domain label starts and ends with a letter or digit. */
const AUTOLINK_EMAIL =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
/** A CommonMark URI autolink: a scheme of 2 to 32 characters, then no space, `<` or `>`. */
const AUTOLINK_URI = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*$/;

/**
 * Whether the default handler would write this link as `<…>` although CommonMark wouldn't read it
 * back as a link. GFM links a looser text such as `a@.b` or `-@.a`; written as `<a@.b>`, it came
 * back as text around a new link, one more pair of brackets on every save.
 */
function autolinkWouldBreak(node: Link): boolean {
  const text = toString(node);
  const email = node.url.startsWith('mailto:') && `mailto:${text}` === node.url;
  if (node.title || !(email || text === node.url)) return false;
  return email ? !AUTOLINK_EMAIL.test(text) : !AUTOLINK_URI.test(node.url);
}

/** Links; `[text](url)` where the `<url>` shortcut wouldn't survive a round trip. */
const handleLink = withPeek(
  (node: Link, parent, state, info) => {
    if (!autolinkWouldBreak(node)) return defaultHandlers.link(node, parent, state, info);
    const resourceLink = state.options.resourceLink;
    state.options.resourceLink = true;
    try {
      return defaultHandlers.link(node, parent, state, info);
    } finally {
      state.options.resourceLink = resourceLink;
    }
  },
  (node: Link, parent, state) =>
    autolinkWouldBreak(node) ? '[' : (defaultHandlers.link.peek?.(node, parent, state) ?? '['),
);

const handleWikiLink = withPeek(
  (node: WikiLink, _parent, state) => {
    // Inside a table cell, a `|` would end the cell: Obsidian writes `\|` there, and so do we.
    const value = inScope(state, 'tableCell') ? node.value.replace(/\|/g, '\\|') : node.value;
    return `${node.embed ? '!' : ''}[[${value}]]`;
  },
  (node: WikiLink) => (node.embed ? '!' : '['),
);

const handleTag = withPeek(
  (node: TagNode) => `#${node.value}`,
  () => '#',
);

const handleBlockId = withPeek(
  (node: BlockIdMarker) => `^${node.value}`,
  () => '^',
);

const handleCalloutMarker = withPeek(
  (node: CalloutMarker) => node.value,
  () => '[',
);

/**
 * A handler for a `==`-style run (highlight, and strikethrough, whose GFM handler does not
 * encode whitespace at its edges): the content's edge characters, and the ones around the run,
 * are encoded when the run would not open or close otherwise.
 */
function attentionHandler(marker: '==' | '~~', construct: ConstructName): Handle {
  return withPeek(
    (node: Highlight, _parent, state, info) => {
      const exit = state.enter(construct);
      const tracker = state.createTracker(info);
      const before = tracker.move(marker);
      let between = tracker.move(
        state.containerPhrasing(node, { after: marker.charAt(0), before, ...tracker.current() }),
      );
      // A marker character at an edge would lengthen the run (`===` never opens), unless it is
      // already escaped.
      const markerCode = marker.charCodeAt(0);
      if (between.charCodeAt(0) === markerCode)
        between = characterReference(markerCode) + between.slice(1);
      const trailingBackslashes = /\\*$/.exec(between.slice(0, -1))?.[0].length ?? 0;
      if (
        between.length > 1 &&
        between.charCodeAt(between.length - 1) === markerCode &&
        trailingBackslashes % 2 === 0
      ) {
        between = between.slice(0, -1) + characterReference(markerCode);
      }
      const head = between.charCodeAt(0);
      const open = encodeSides(info.before.charCodeAt(info.before.length - 1), head);
      if (open.inside) between = characterReference(head) + between.slice(1);
      const tail = between.charCodeAt(between.length - 1);
      const close = encodeSides(info.after.charCodeAt(0), tail);
      if (close.inside) between = between.slice(0, -1) + characterReference(tail);
      const after = tracker.move(marker);
      exit();
      state.attentionEncodeSurroundingInfo = { after: close.outside, before: open.outside };
      return before + between + after;
    },
    () => marker.charAt(0),
  );
}

const handleHighlight = attentionHandler('==', 'highlight');
const handleDelete = attentionHandler('~~', 'strikethrough');

function isAsteriskRun(node: unknown): boolean {
  const type = (node as { type?: string } | undefined)?.type;
  return type === 'emphasis' || type === 'strong';
}

/**
 * Emphasis right next to strong emphasis would merge into one `***` run that cannot close, so
 * such emphasis uses `_` instead of `*`.
 */
function emphasisMarker(node: unknown, parent: Parents | undefined): '*' | '_' {
  if (!parent || !('children' in parent)) return '*';
  const siblings = parent.children as unknown[];
  const index = siblings.indexOf(node);
  return isAsteriskRun(siblings[index - 1]) || isAsteriskRun(siblings[index + 1]) ? '_' : '*';
}

const handleEmphasis = withPeek(
  (node, parent, state, info) => {
    const marker = emphasisMarker(node, parent);
    const previous = state.options.emphasis;
    state.options.emphasis = marker;
    try {
      return defaultHandlers.emphasis(node, parent, state, info);
    } finally {
      state.options.emphasis = previous;
    }
  },
  (node, parent) => emphasisMarker(node, parent),
);

/** A rare punctuation character standing in for a backslash during escaping (see below). */
const BACKSLASH_SENTINEL = '⸮';

/**
 * Text, with one extra escape: a literal backslash before whitespace or before the last
 * character. Attention runs may encode that character later (`&#x20;`), and an unescaped
 * backslash would then escape the `&`. The sentinel is punctuation, like `\`, so the attention
 * encoding decisions stay the same. It isn't ASCII punctuation, though, so `safe` leaves a
 * backslash right before it unescaped; that one is escaped here too, or with the sentinel's `\\`
 * after it, it would escape a backslash instead of being one (`\\@` came back as `\@`).
 */
const handleText: Handle = (node: { value: string }, _parent, state, info) => {
  const value = node.value;
  if (!value.includes('\\') || value.includes(BACKSLASH_SENTINEL)) return state.safe(value, info);
  const marked = value.replace(/\\(?=[ \t]|[^]$)/g, BACKSLASH_SENTINEL);
  return state
    .safe(marked, info)
    .replace(new RegExp(`\\\\(?=${BACKSLASH_SENTINEL})`, 'g'), '\\\\')
    .split(BACKSLASH_SENTINEL)
    .join('\\\\');
};

/**
 * Hard breaks: a plain line ending (Obsidian renders single line breaks), or `<br>` where a line
 * ending is not allowed (table cells, headings, toggle summaries).
 */
const handleBreak: Handle = (_node, _parent, state) => {
  if (
    inScope(state, 'tableCell') ||
    inScope(state, 'headingAtx') ||
    inScope(state, 'toggleSummary')
  ) {
    return '<br>';
  }
  return '\n';
};

const handleToggle: Handle = (node: ToggleNode, _parent: Parents | undefined, state, info) => {
  const exitSummary = state.enter('toggleSummary');
  const exitPhrasing = state.enter('phrasing');
  // The summary is parsed as a paragraph of its own: escape it as if it started a line.
  const summary = state.containerPhrasing(
    { type: 'paragraph', children: node.summary as PhrasingContent[] },
    { ...info, before: '\n', after: '\n' },
  );
  exitPhrasing();
  exitSummary();
  const open = `<details${node.attributes}>\n<summary>${summary}</summary>`;
  if (node.children.length === 0) return `${open}\n\n</details>`;
  const body = state.containerFlow(node, info);
  return `${open}\n\n${body}\n\n</details>`;
};

/** Extra escapes for the Tessera syntax. */
const unsafe: Unsafe[] = [
  // `==` could start a highlight.
  { character: '=', after: '=', inConstruct: 'phrasing', notInConstruct: fullPhrasingSpans },
  { character: '=', before: '=', inConstruct: 'phrasing', notInConstruct: fullPhrasingSpans },
  // `#` followed by a word character could start a tag.
  {
    character: '#',
    after: '[^\\s#]',
    inConstruct: 'phrasing',
    notInConstruct: fullPhrasingSpans,
  },
  // `^` after whitespace (or at a line start) could be a block ID.
  { character: '^', before: '[ \\t]', inConstruct: 'phrasing', notInConstruct: fullPhrasingSpans },
  { character: '^', atBreak: true },
];

/** mdast-util-to-markdown extension that writes the Tessera nodes. */
export function tesseraToMarkdown(): ToMarkdownExtension {
  return {
    unsafe,
    handlers: {
      link: handleLink,
      wikiLink: handleWikiLink,
      tag: handleTag,
      blockId: handleBlockId,
      calloutMarker: handleCalloutMarker,
      highlight: handleHighlight,
      delete: handleDelete,
      text: handleText,
      emphasis: handleEmphasis,
      break: handleBreak,
      toggle: handleToggle,
    },
  };
}

export type { Info };
