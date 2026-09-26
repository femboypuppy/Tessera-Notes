import type {
  Backlink,
  ExtractedLink,
  HighlightRange,
  LinkEdge,
  PageKind,
  SearchHit,
  UnlinkedMention,
} from '@tessera/core';

/**
 * What the index worker knows about a page's metadata. The main thread derives it from the pages
 * snapshot (effective parent, implicit trash, rows), so the worker never re-implements the tree.
 */
export interface PageMetaLite {
  id: string;
  title: string;
  kind: PageKind;
  /** Effective parent (orphans and broken cycles resolved), or null. */
  parentId: string | null;
  /** In the trash, itself or through an ancestor. */
  trashed: boolean;
  /** A database row. */
  isRow: boolean;
  icon: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A piece of a block's inline content, so contexts can show live titles for links. */
export type Segment =
  | { t: 'text'; v: string }
  | { t: 'link'; id: string; label: string | null }
  | { t: 'tag'; v: string }
  | { t: 'br' };

/** A text block of a page, in document order. */
export interface BlockEntry {
  /** Display text (links rendered with the target's title at indexing time). */
  text: string;
  blockId: string | null;
  /** Heading level for headings. */
  level?: 1 | 2 | 3;
  /** Code blocks are searchable but never used for mentions. */
  code?: boolean;
}

/** A link from a page, with the inline content of its block for context. */
export interface LinkEntry {
  targetPageId: string;
  label: string | null;
  heading: string | null;
  blockRef: string | null;
  path: number[];
  offset: number;
  blockId: string | null;
  segments: Segment[];
}

/** Everything the index keeps about a page's content (persisted). */
export interface ContentRecord {
  blocks: BlockEntry[];
  /** Tag names as first written, unique by key (inline and page tags). */
  tags: string[];
  aliases: string[];
  hasTasks: boolean;
  links: LinkEntry[];
  /** `PageMeta.updatedAt` when the content was read: stale when it differs. */
  fingerprint: number;
}

/** Values of a database row, as text for search (persisted). */
export interface RowValuesRecord {
  databaseId: string;
  text: string;
  /**
   * Pages the row's relation cells point to (`text` holds their titles). Indexes saved before it
   * existed lack it; their databases are read again once.
   */
  relations?: string[];
}

/**
 * A search hit with the extras the palette and the search page use (`heading` and `blockId`, the
 * scroll target, are in core's `SearchHit`).
 */
export interface RichSearchHit extends SearchHit {
  /** Tags of the page (display names). */
  tags?: string[];
}

/** Filters resolved from the query and the options. */
export interface QueryFilters {
  kinds?: PageKind[];
  /** Page IDs; a hit must be inside one of their subtrees. */
  within?: string[];
  /** Tag keys; a hit must have all of them (nested tags count for their parents). */
  tags?: string[];
  hasTasks?: boolean;
  includeRows?: boolean;
}

/** A query sent to the worker. */
export interface QueryRequest {
  text: string;
  filters: QueryFilters;
  limit: number;
  offset: number;
}

export interface QueryResponse {
  hits: RichSearchHit[];
  total: number;
  /** Time spent in the engine, in ms. */
  tookMs: number;
}

/** A backlink with the inline content of its block, so panels render live titles. */
export interface RichBacklink extends Backlink {
  segments: Segment[];
}

/** An outgoing link with its block's inline content. */
export interface RichOutgoingLink extends ExtractedLink {
  segments: Segment[];
}

/** A tag and how many pages use it. */
export interface TagCount {
  key: string;
  name: string;
  count: number;
}

/** Two tags used on the same pages. */
export interface TagPair {
  a: string;
  b: string;
  count: number;
}

/** A node of the graph snapshot. */
export interface GraphNode {
  id: string;
  title: string;
  kind: PageKind;
  icon: string | null;
  isRow: boolean;
  /** Top-level ancestor (itself for top-level pages). */
  rootId: string;
  /** Tag keys of the page. */
  tags: string[];
  updatedAt: number;
}

/** What the graph views render. Trashed pages are never included. */
export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: LinkEdge[];
  tags: TagCount[];
}

/**
 * An unlinked mention with where it sits in `blockText` (which shows links as titles, so inline
 * offsets and display offsets differ).
 */
export interface RichMention extends UnlinkedMention {
  display: HighlightRange | null;
}

/** A precise mention check for one source page. */
export interface MentionSource {
  pageId: string;
  bytes: Uint8Array | null;
}

export type { UnlinkedMention, HighlightRange };
