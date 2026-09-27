import {
  DATA_MODEL_VERSION,
  DOC_SCHEMA_VERSION,
  findTextOccurrences,
  inlineText,
  nodeAtPath,
  readDocJSON,
  tagHierarchy,
  tagKey,
  type AnyNodeJSON,
  type HighlightRange,
  type LinkEdge,
  type PageKind,
} from '@tessera/core';
import MiniSearch, { type AsPlainObject, type SearchResult } from 'minisearch';
import { docFromBytes, readContent, readRowValues, segmentsText, type RowValues } from './extract';
import { escapeRegExp, highlightTerms, normalizeTerm, snippetAround, tokenSpans } from './text';
import type {
  BlockEntry,
  ContentRecord,
  GraphNode,
  GraphSnapshot,
  MentionSource,
  PageMetaLite,
  QueryFilters,
  QueryRequest,
  QueryResponse,
  RichBacklink,
  RichMention,
  RichOutgoingLink,
  RichSearchHit,
  RowValuesRecord,
  TagCount,
  TagPair,
} from './types';

/** Bump when the persisted layout or the indexing rules change: persisted indexes rebuild. */
export const INDEX_FORMAT_VERSION = 1;

/** The persisted form of an index (IndexedDB, one entry per workspace). */
export interface PersistedIndex {
  format: number;
  docSchema: number;
  dataModel: number;
  savedAt: number;
  contents: Array<[string, ContentRecord]>;
  rows: Array<[string, RowValuesRecord]>;
  databases: Array<[string, number]>;
  titles: Array<[string, string]>;
  mini: AsPlainObject;
}

interface IndexedDoc {
  id: string;
  title: string;
  aliases: string;
  headings: string;
  tags: string;
  props: string;
  body: string;
}

const FIELDS = ['title', 'aliases', 'tags', 'headings', 'props', 'body'] as const;
type Field = (typeof FIELDS)[number];
const BOOST: Record<Field, number> = {
  title: 6,
  aliases: 4,
  tags: 3,
  headings: 2.5,
  props: 1.5,
  body: 1,
};

const DAY_MS = 86_400_000;

function miniOptions() {
  return {
    idField: 'id',
    fields: [...FIELDS],
    storeFields: [],
    processTerm: (term: string) => normalizeTerm(term) || null,
    searchOptions: {
      boost: BOOST,
      combineWith: 'AND' as const,
      prefix: (term: string) => term.length >= 2,
      fuzzy: (term: string) => (term.length > 3 ? (term.length >= 9 ? 2 : 1) : false),
      maxFuzzy: 2,
      weights: { fuzzy: 0.4, prefix: 0.6 },
    },
    autoVacuum: { minDirtCount: 200, minDirtFactor: 0.2, batchSize: 1000, batchWait: 10 },
  };
}

const FIELD_ORDER: Array<[Field, RichSearchHit['matchedIn']]> = [
  ['title', 'title'],
  ['aliases', 'title'],
  ['tags', 'tag'],
  ['headings', 'heading'],
  ['body', 'body'],
  ['props', 'property'],
];

/**
 * Maps an inline range (text characters count 1, inline atoms count 1) to the same range in the
 * block's display text, where links show as titles and tags as `#name`.
 */
export function displayRange(
  block: AnyNodeJSON | undefined,
  from: number,
  to: number,
  resolveTitle: (pageId: string) => string | undefined,
): HighlightRange | null {
  let inline = 0;
  let shown = 0;
  let start = -1;
  let end = -1;
  for (const child of block?.content ?? []) {
    if (child.type === 'text') {
      const length = child.text?.length ?? 0;
      if (start < 0 && from >= inline && from < inline + length) start = shown + (from - inline);
      if (end < 0 && to > inline && to <= inline + length) end = shown + (to - inline);
      inline += length;
      shown += length;
    } else {
      inline += 1;
      shown += inlineText([child], { resolveTitle }).length;
    }
  }
  return start >= 0 && end > start ? { start, end } : null;
}

/** What changed after an update (so the host can notify listeners). */
export interface ChangeSummary {
  search: boolean;
  links: boolean;
}

/** Pages and databases whose content must be read (after a full metadata sync). */
export interface StaleSet {
  pages: string[];
  databases: string[];
}

/**
 * The index itself: MiniSearch over titles, aliases, tags, headings, row values and body text,
 * plus the link graph (outgoing links, backlinks, mentions, tags). It runs inside the index
 * worker (or in-process in tests) and never touches the DOM or the main thread's docs: content
 * arrives as Yjs updates, metadata as {@link PageMetaLite}.
 */
export class IndexCore {
  private readonly meta = new Map<string, PageMetaLite>();
  private readonly contents = new Map<string, ContentRecord>();
  private readonly rows = new Map<string, RowValuesRecord>();
  private readonly dbFingerprints = new Map<string, number>();
  private readonly indexedTitles = new Map<string, string>();
  private readonly backrefs = new Map<string, Set<string>>();
  /** Databases whose rows relate to a page (their text holds its title), by page. */
  private readonly relationRefs = new Map<string, Set<string>>();
  /** The pages each database's relation cells point to. */
  private readonly dbRelations = new Map<string, Set<string>>();
  private readonly tagKeyCache = new Map<string, Set<string>>();
  /** Titles folded like search terms, for the exact and prefix title bonus. */
  private readonly foldedTitles = new Map<string, string>();
  private mini: MiniSearch<IndexedDoc>;
  private readonly now: () => number;

  constructor(options: { now?: () => number; persisted?: PersistedIndex | null } = {}) {
    this.now = options.now ?? Date.now;
    const persisted = options.persisted;
    if (persisted && IndexCore.isCompatible(persisted)) {
      this.mini = MiniSearch.loadJS<IndexedDoc>(persisted.mini, miniOptions());
      for (const [id, record] of persisted.contents) {
        this.contents.set(id, record);
        this.addBackrefs(id, record);
      }
      const relations = new Map<string, Set<string>>();
      const unknownRelations = new Set<string>();
      for (const [id, record] of persisted.rows) {
        this.rows.set(id, record);
        if (!record.relations) unknownRelations.add(record.databaseId);
        const targets = relations.get(record.databaseId) ?? new Set<string>();
        for (const target of record.relations ?? []) targets.add(target);
        relations.set(record.databaseId, targets);
      }
      for (const [id, targets] of relations) this.setRelations(id, targets);
      for (const [id, fingerprint] of persisted.databases) this.dbFingerprints.set(id, fingerprint);
      // Saved before rows kept their relation targets: those databases are read again, once.
      for (const id of unknownRelations) this.dbFingerprints.delete(id);
      for (const [id, title] of persisted.titles) this.indexedTitles.set(id, title);
      this.restored = true;
    } else {
      this.mini = new MiniSearch<IndexedDoc>(miniOptions());
    }
  }

  /** True when this index was restored from a persisted state. */
  readonly restored: boolean = false;

  /** True when a persisted index can be reused (same format and schema versions). */
  static isCompatible(persisted: PersistedIndex): boolean {
    return (
      persisted.format === INDEX_FORMAT_VERSION &&
      persisted.docSchema === DOC_SCHEMA_VERSION &&
      persisted.dataModel === DATA_MODEL_VERSION
    );
  }

  get documentCount(): number {
    return this.mini.documentCount;
  }

  // ---------------------------------------------------------------------------------------------
  // Updates
  // ---------------------------------------------------------------------------------------------

  /**
   * Applies metadata. With `full`, `upserts` is every page: anything else is removed. The result
   * lists the pages and databases to read again: with `full`, those whose stored content is
   * missing or stale; and whenever a title changes, appears or goes, the pages that link to it
   * and the databases whose rows relate to it, since their text holds the title they were read
   * with.
   */
  setMeta(upserts: readonly PageMetaLite[], removes: readonly string[], full = false): StaleSet {
    const pages = new Set<string>();
    const databases = new Set<string>();
    const retitled = new Set<string>();
    const remove = (ids: readonly string[]) => {
      for (const id of ids) if (this.knownTitle(id) !== undefined) retitled.add(id);
      this.removePages(ids);
    };
    if (full) {
      const keep = new Set(upserts.map((page) => page.id));
      const gone = new Set<string>();
      for (const id of this.meta.keys()) if (!keep.has(id)) gone.add(id);
      for (const id of this.contents.keys()) if (!keep.has(id)) gone.add(id);
      for (const id of this.indexedTitles.keys()) if (!keep.has(id)) gone.add(id);
      for (const id of this.dbFingerprints.keys()) if (!keep.has(id)) gone.add(id);
      remove([...gone]);
    }
    remove(removes);
    for (const page of upserts) {
      if (this.knownTitle(page.id) !== page.title) retitled.add(page.id);
      this.meta.set(page.id, page);
      this.foldedTitles.set(page.id, normalizeTerm(page.title.trim()));
      if (!this.mini.has(page.id) || this.indexedTitles.get(page.id) !== page.title) {
        this.reindex(page.id);
      }
    }
    if (full) {
      for (const page of upserts) {
        if (page.kind === 'page') {
          if (this.contents.get(page.id)?.fingerprint !== page.updatedAt) pages.add(page.id);
        } else if (this.dbFingerprints.get(page.id) !== page.updatedAt) {
          databases.add(page.id);
        }
      }
    }
    for (const id of retitled) {
      for (const source of this.backrefs.get(id) ?? []) pages.add(source);
      for (const database of this.relationRefs.get(id) ?? []) databases.add(database);
    }
    const byRecency = (a: string, b: string) =>
      (this.meta.get(b)?.updatedAt ?? 0) - (this.meta.get(a)?.updatedAt ?? 0);
    const ofKind = (kind: PageKind) => (id: string) => this.meta.get(id)?.kind === kind;
    return {
      pages: [...pages].filter(ofKind('page')).sort(byRecency),
      databases: [...databases].filter(ofKind('database')).sort(byRecency),
    };
  }

  /** The title the index knows a page by: its metadata, or the title it was indexed with. */
  private knownTitle(id: string): string | undefined {
    return this.meta.get(id)?.title ?? this.indexedTitles.get(id);
  }

  /** Removes pages from the index (their content, row values and links). */
  removePages(ids: readonly string[]): void {
    for (const id of ids) {
      const previous = this.contents.get(id);
      if (previous) this.removeBackrefs(id, previous);
      this.contents.delete(id);
      this.rows.delete(id);
      this.meta.delete(id);
      this.foldedTitles.delete(id);
      this.dbFingerprints.delete(id);
      if (this.dbRelations.has(id)) this.setRelations(id, new Set());
      this.indexedTitles.delete(id);
      this.tagKeyCache.delete(id);
      if (this.mini.has(id)) this.mini.discard(id);
    }
  }

  /** Stores a page's content read from `bytes` (a Yjs update of the page doc). */
  setContentFromBytes(pageId: string, bytes: Uint8Array | null, fingerprint: number): void {
    const doc = docFromBytes(bytes);
    try {
      this.setContent(
        pageId,
        readContent(doc, fingerprint, (id) => this.meta.get(id)?.title),
      );
    } finally {
      doc.destroy();
    }
  }

  /** Stores a page's content record. */
  setContent(pageId: string, record: ContentRecord): void {
    const previous = this.contents.get(pageId);
    if (previous) this.removeBackrefs(pageId, previous);
    this.contents.set(pageId, record);
    this.addBackrefs(pageId, record);
    this.tagKeyCache.delete(pageId);
    this.reindex(pageId);
  }

  /** Stores the row values of a database read from `bytes` (a Yjs update of the database doc). */
  setDatabaseFromBytes(databaseId: string, bytes: Uint8Array | null, fingerprint: number): void {
    const doc = docFromBytes(bytes);
    try {
      const values = readRowValues(doc, (id) => this.meta.get(id)?.title);
      this.setRowValues(databaseId, values, fingerprint);
    } finally {
      doc.destroy();
    }
  }

  /** Replaces the row values of a database (rows missing from `values` lose theirs). */
  setRowValues(
    databaseId: string,
    values: ReadonlyMap<string, RowValues>,
    fingerprint: number,
  ): void {
    for (const [rowId, record] of [...this.rows]) {
      if (record.databaseId === databaseId && !values.has(rowId)) {
        this.rows.delete(rowId);
        this.reindex(rowId);
      }
    }
    const targets = new Set<string>();
    for (const [rowId, { text, relations }] of values) {
      for (const target of relations) targets.add(target);
      const previous = this.rows.get(rowId);
      this.rows.set(rowId, { databaseId, text, relations });
      if (previous?.text === text && previous.databaseId === databaseId) continue;
      this.reindex(rowId);
    }
    this.setRelations(databaseId, targets);
    this.dbFingerprints.set(databaseId, fingerprint);
  }

  /** Records the pages a database's relation cells point to. */
  private setRelations(databaseId: string, targets: ReadonlySet<string>): void {
    for (const target of this.dbRelations.get(databaseId) ?? []) {
      if (targets.has(target)) continue;
      const databases = this.relationRefs.get(target);
      databases?.delete(databaseId);
      if (databases?.size === 0) this.relationRefs.delete(target);
    }
    for (const target of targets) {
      let databases = this.relationRefs.get(target);
      if (!databases) {
        databases = new Set();
        this.relationRefs.set(target, databases);
      }
      databases.add(databaseId);
    }
    if (targets.size > 0) this.dbRelations.set(databaseId, new Set(targets));
    else this.dbRelations.delete(databaseId);
  }

  /** Forgets everything (before a rebuild). */
  clear(): void {
    this.meta.clear();
    this.foldedTitles.clear();
    this.contents.clear();
    this.rows.clear();
    this.dbFingerprints.clear();
    this.indexedTitles.clear();
    this.backrefs.clear();
    this.relationRefs.clear();
    this.dbRelations.clear();
    this.tagKeyCache.clear();
    this.mini = new MiniSearch<IndexedDoc>(miniOptions());
  }

  private reindex(id: string): void {
    const doc = this.buildDoc(id);
    if (!doc) {
      if (this.mini.has(id)) this.mini.discard(id);
      this.indexedTitles.delete(id);
      return;
    }
    if (this.mini.has(id)) this.mini.replace(doc);
    else this.mini.add(doc);
    this.indexedTitles.set(id, doc.title);
  }

  private buildDoc(id: string): IndexedDoc | null {
    const meta = this.meta.get(id);
    if (!meta) return null;
    const content = this.contents.get(id);
    const headings: string[] = [];
    const body: string[] = [];
    for (const block of content?.blocks ?? []) (block.level ? headings : body).push(block.text);
    return {
      id,
      title: meta.title,
      aliases: content?.aliases.join('\n') ?? '',
      headings: headings.join('\n'),
      tags: content?.tags.join(' ') ?? '',
      props: this.rows.get(id)?.text ?? '',
      body: body.join('\n'),
    };
  }

  private addBackrefs(sourceId: string, record: ContentRecord): void {
    for (const link of record.links) {
      let sources = this.backrefs.get(link.targetPageId);
      if (!sources) {
        sources = new Set();
        this.backrefs.set(link.targetPageId, sources);
      }
      sources.add(sourceId);
    }
  }

  private removeBackrefs(sourceId: string, record: ContentRecord): void {
    for (const link of record.links) {
      const sources = this.backrefs.get(link.targetPageId);
      sources?.delete(sourceId);
      if (sources?.size === 0) this.backrefs.delete(link.targetPageId);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------------------------

  private tagKeys(id: string): Set<string> {
    let keys = this.tagKeyCache.get(id);
    if (!keys) {
      keys = new Set();
      for (const name of this.contents.get(id)?.tags ?? []) {
        for (const level of tagHierarchy(name)) keys.add(tagKey(level));
      }
      this.tagKeyCache.set(id, keys);
    }
    return keys;
  }

  private isInside(id: string, ancestors: ReadonlySet<string>): boolean {
    let current = this.meta.get(id)?.parentId ?? null;
    for (let guard = 0; current !== null && guard < 10_000; guard += 1) {
      if (ancestors.has(current)) return true;
      current = this.meta.get(current)?.parentId ?? null;
    }
    return false;
  }

  private filterFor(filters: QueryFilters): (id: string) => boolean {
    const within = filters.within?.length ? new Set(filters.within) : null;
    const tags = filters.tags?.length ? filters.tags.map((tag) => tagKey(tag)) : null;
    const kinds = filters.kinds?.length ? new Set(filters.kinds) : null;
    return (id) => {
      const meta = this.meta.get(id);
      if (!meta || meta.trashed) return false;
      if (filters.includeRows === false && meta.isRow) return false;
      if (kinds && !kinds.has(meta.kind)) return false;
      if (filters.hasTasks && !this.contents.get(id)?.hasTasks) return false;
      if (tags) {
        const keys = this.tagKeys(id);
        if (!tags.every((tag) => keys.has(tag))) return false;
      }
      if (within && !this.isInside(id, within)) return false;
      return true;
    };
  }

  /** Recency and link popularity, as a multiplier on the text score. */
  private rankFactor(id: string, now: number): number {
    const meta = this.meta.get(id);
    if (!meta) return 1;
    const ageDays = Math.max(0, now - meta.updatedAt) / DAY_MS;
    const recency = 2 ** (-ageDays / 30);
    const inbound = this.backrefs.get(id)?.size ?? 0;
    return (1 + 0.3 * recency) * (1 + 0.15 * Math.log2(1 + inbound)) * (meta.isRow ? 0.85 : 1);
  }

  /** Runs a query. Trashed pages never match. */
  query(request: QueryRequest): QueryResponse {
    const started = performance.now();
    const passes = this.filterFor(request.filters);
    const now = this.now();
    const text = request.text.trim();
    const hasTerms = tokenSpans(text).some((span) => normalizeTerm(span.token));
    let ranked: Array<{ id: string; score: number; result: SearchResult | null }>;
    if (!hasTerms) {
      const matching: PageMetaLite[] = [];
      for (const meta of this.meta.values()) if (passes(meta.id)) matching.push(meta);
      matching.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
      ranked = matching.map((meta) => ({ id: meta.id, score: 0, result: null }));
      for (const entry of ranked.slice(request.offset, request.offset + request.limit)) {
        entry.score = this.rankFactor(entry.id, now);
      }
    } else {
      const folded = normalizeTerm(text);
      // The rank factor is constant per page, so applying it once per result equals MiniSearch's
      // per-term `boostDocument`, at a fraction of the calls.
      const filter = (result: SearchResult) => passes(result.id as string);
      let results = this.mini.search(text, { filter, ...this.fieldsFor(folded) });
      if (folded.replace(/\s/g, '').length <= 2) {
        // One or two letters: prefixes only in titles, aliases, tags and headings (a prefix that
        // short matches most of the body text), plus exact words anywhere.
        const seen = new Set(results.map((result) => result.id as string));
        const exact = this.mini.search(text, { filter, prefix: false, fuzzy: false });
        results = [...results, ...exact.filter((result) => !seen.has(result.id as string))];
      }
      ranked = results.map((result) => {
        const id = result.id as string;
        const title = this.foldedTitles.get(id) ?? '';
        const exact = title === folded ? 3 : title.startsWith(folded) ? 1.6 : 1;
        return { id, score: result.score * exact * this.rankFactor(id, now), result };
      });
      ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    }
    const page = ranked.slice(request.offset, request.offset + request.limit);
    const hits = page.map(({ id, score, result }) => this.toHit(id, score, result));
    return { hits, total: ranked.length, tookMs: performance.now() - started };
  }

  /** Fields searched with prefix and fuzzy matching: every field, except for very short queries. */
  private fieldsFor(folded: string): { fields?: string[] } {
    return folded.replace(/\s/g, '').length <= 2
      ? { fields: ['title', 'aliases', 'tags', 'headings'] }
      : {};
  }

  private toHit(id: string, score: number, result: SearchResult | null): RichSearchHit {
    const meta = this.meta.get(id);
    const content = this.contents.get(id);
    const hit: RichSearchHit = {
      pageId: id,
      title: meta?.title ?? '',
      kind: meta?.kind ?? 'page',
      score,
      matchedIn: 'title',
      titleHighlights: [],
    };
    if (content?.tags.length) hit.tags = content.tags;
    if (!result) return hit;
    const terms = new Set(result.terms);
    const fields = new Set<string>();
    for (const matched of Object.values(result.match))
      for (const field of matched) fields.add(field);
    hit.matchedIn = FIELD_ORDER.find(([field]) => fields.has(field))?.[1] ?? 'body';
    hit.titleHighlights = highlightTerms(hit.title, terms);
    if (fields.has('body') || fields.has('headings')) {
      const block = this.bestBlock(content?.blocks ?? [], terms, fields.has('body'));
      if (block) {
        hit.snippet = snippetAround(block.text, terms);
        if (block.level) hit.heading = block.text;
        else if (block.blockId) hit.blockId = block.blockId;
      }
    } else if (fields.has('props')) {
      const values = this.rows.get(id)?.text ?? '';
      const line = values.split('\n').find((part) => highlightTerms(part, terms).length > 0);
      if (line) hit.snippet = snippetAround(line, terms);
    } else if (fields.has('aliases')) {
      const alias = content?.aliases.find((part) => highlightTerms(part, terms).length > 0);
      if (alias) hit.snippet = { text: alias, highlights: highlightTerms(alias, terms) };
    }
    return hit;
  }

  /** The block with the most distinct matched terms (body blocks win ties when the body matched). */
  private bestBlock(
    blocks: readonly BlockEntry[],
    terms: ReadonlySet<string>,
    preferBody: boolean,
  ): BlockEntry | null {
    let best: BlockEntry | null = null;
    let bestScore = 0;
    for (const block of blocks) {
      const found = new Set<string>();
      let occurrences = 0;
      for (const span of tokenSpans(block.text)) {
        const term = normalizeTerm(span.token);
        if (!terms.has(term)) continue;
        found.add(term);
        occurrences += 1;
      }
      if (found.size === 0) continue;
      // Distinct terms matter most, then body over headings, then how often they occur.
      const score =
        found.size * 10 + (preferBody && !block.level ? 5 : 0) + Math.min(occurrences, 4);
      if (score > bestScore) {
        best = block;
        bestScore = score;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------------------------
  // Links
  // ---------------------------------------------------------------------------------------------

  private title = (id: string): string | undefined => this.meta.get(id)?.title;

  private isLive(id: string): boolean {
    const meta = this.meta.get(id);
    return meta !== undefined && !meta.trashed;
  }

  private bySourceTitle<T extends { sourcePageId: string }>(items: T[]): T[] {
    return items
      .map((item, index) => ({ item, index }))
      .sort(
        (a, b) =>
          (this.title(a.item.sourcePageId) ?? '').localeCompare(
            this.title(b.item.sourcePageId) ?? '',
          ) ||
          (a.item.sourcePageId < b.item.sourcePageId
            ? -1
            : a.item.sourcePageId > b.item.sourcePageId
              ? 1
              : 0) ||
          a.index - b.index,
      )
      .map(({ item }) => item);
  }

  /** Links to `pageId` from other pages that are not in the trash. */
  backlinks(pageId: string): RichBacklink[] {
    const result: RichBacklink[] = [];
    for (const sourcePageId of this.backrefs.get(pageId) ?? []) {
      if (sourcePageId === pageId || !this.isLive(sourcePageId)) continue;
      for (const link of this.contents.get(sourcePageId)?.links ?? []) {
        if (link.targetPageId !== pageId) continue;
        result.push({
          sourcePageId,
          targetPageId: pageId,
          label: link.label,
          heading: link.heading,
          blockRef: link.blockRef,
          blockText: segmentsText(link.segments, this.title),
          path: link.path,
          offset: link.offset,
          segments: link.segments,
          blockId: link.blockId,
        });
      }
    }
    return this.bySourceTitle(result);
  }

  /** Every link in a page, in document order (targets may be missing or in the trash). */
  outgoing(pageId: string): RichOutgoingLink[] {
    return (this.contents.get(pageId)?.links ?? []).map((link) => ({
      targetPageId: link.targetPageId,
      label: link.label,
      heading: link.heading,
      blockRef: link.blockRef,
      blockText: segmentsText(link.segments, this.title),
      path: link.path,
      offset: link.offset,
      blockId: link.blockId,
      segments: link.segments,
    }));
  }

  /** Graph edges between pages that exist and are not in the trash (self-links excluded). */
  edges(): LinkEdge[] {
    const edges: LinkEdge[] = [];
    for (const [source, record] of this.contents) {
      if (!this.isLive(source)) continue;
      const counts = new Map<string, number>();
      for (const link of record.links) {
        if (link.targetPageId === source || !this.isLive(link.targetPageId)) continue;
        counts.set(link.targetPageId, (counts.get(link.targetPageId) ?? 0) + 1);
      }
      for (const [target, count] of counts) edges.push({ source, target, count });
    }
    return edges;
  }

  /** The title and aliases of a page that count as mentions (two characters or more). */
  mentionNeedles(pageId: string): string[] {
    const meta = this.meta.get(pageId);
    if (!meta) return [];
    const needles = [meta.title, ...(this.contents.get(pageId)?.aliases ?? [])]
      .map((needle) => needle.trim())
      .filter((needle) => needle.length > 1);
    return [...new Set(needles)];
  }

  /**
   * Pages whose text may mention `pageId` (a superset of the real mentions, checked precisely
   * with {@link findMentions}). Cheap: a regular expression over indexed text.
   */
  mentionCandidates(pageId: string): string[] {
    const needles = this.mentionNeedles(pageId);
    if (needles.length === 0) return [];
    const pattern = needles
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|');
    const regex = new RegExp(pattern, 'iu');
    const candidates: string[] = [];
    for (const [sourceId, record] of this.contents) {
      if (sourceId === pageId || !this.isLive(sourceId)) continue;
      if (this.meta.get(sourceId)?.kind !== 'page') continue;
      if (record.blocks.some((block) => !block.code && regex.test(block.text))) {
        candidates.push(sourceId);
      }
    }
    return candidates;
  }

  /**
   * The unlinked mentions of `pageId` in the given source pages (their current content): its
   * title or an alias as plain text, whole words, case-insensitive.
   */
  findMentions(pageId: string, sources: readonly MentionSource[]): RichMention[] {
    const needles = this.mentionNeedles(pageId);
    if (needles.length === 0) return [];
    const mentions: RichMention[] = [];
    for (const source of sources) {
      if (source.pageId === pageId || !this.isLive(source.pageId)) continue;
      const doc = docFromBytes(source.bytes);
      try {
        const json = readDocJSON(doc);
        for (const hit of findTextOccurrences(json, needles, { resolveTitle: this.title })) {
          const display = displayRange(nodeAtPath(json, hit.path), hit.from, hit.to, this.title);
          mentions.push({ sourcePageId: source.pageId, targetPageId: pageId, ...hit, display });
        }
      } finally {
        doc.destroy();
      }
    }
    return this.bySourceTitle(mentions);
  }

  /** Pages that link nowhere and that nothing links to (rows and trashed pages excluded). */
  orphans(): string[] {
    const linked = new Set<string>();
    for (const edge of this.edges()) {
      linked.add(edge.source);
      linked.add(edge.target);
    }
    return [...this.meta.values()]
      .filter((meta) => !meta.trashed && !meta.isRow && !linked.has(meta.id))
      .map((meta) => meta.id)
      .sort();
  }

  /** Every tag in use (pages not in the trash), most used first. */
  tags(): TagCount[] {
    const counts = new Map<string, TagCount>();
    for (const [id, record] of this.contents) {
      if (!this.isLive(id)) continue;
      for (const name of record.tags) {
        const key = tagKey(name);
        const entry = counts.get(key);
        if (entry) entry.count += 1;
        else counts.set(key, { key, name, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  /** How often two tags appear on the same page, most frequent pairs first. */
  tagCooccurrence(): TagPair[] {
    const counts = new Map<string, TagPair>();
    for (const [id, record] of this.contents) {
      if (!this.isLive(id)) continue;
      const keys = [...new Set(record.tags.map((name) => tagKey(name)))].sort();
      for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
          const a = keys[i] ?? '';
          const b = keys[j] ?? '';
          const key = `${a}\u0000${b}`;
          const pair = counts.get(key);
          if (pair) pair.count += 1;
          else counts.set(key, { a, b, count: 1 });
        }
      }
    }
    return [...counts.values()].sort(
      (x, y) => y.count - x.count || x.a.localeCompare(y.a) || x.b.localeCompare(y.b),
    );
  }

  private rootOf(id: string): string {
    let current = id;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const parent = this.meta.get(current)?.parentId ?? null;
      if (parent === null || !this.meta.has(parent)) return current;
      current = parent;
    }
    return current;
  }

  private nodeOf(meta: PageMetaLite): GraphNode {
    const tags = this.contents.get(meta.id)?.tags ?? [];
    return {
      id: meta.id,
      title: meta.title,
      kind: meta.kind,
      icon: meta.icon,
      isRow: meta.isRow,
      rootId: this.rootOf(meta.id),
      tags: [...new Set(tags.map((name) => tagKey(name)))],
      updatedAt: meta.updatedAt,
    };
  }

  /** Every page that is not in the trash, the links between them, and the tags in use. */
  graph(): GraphSnapshot {
    const nodes = [...this.meta.values()]
      .filter((meta) => !meta.trashed)
      .map((meta) => this.nodeOf(meta));
    return { nodes, edges: this.edges(), tags: this.tags() };
  }

  /** The pages within `depth` links of `pageId` (either direction), and the links between them. */
  neighborhood(pageId: string, depth: number): GraphSnapshot {
    const edges = this.edges();
    const adjacency = new Map<string, Set<string>>();
    const connect = (a: string, b: string) => {
      let set = adjacency.get(a);
      if (!set) {
        set = new Set();
        adjacency.set(a, set);
      }
      set.add(b);
    };
    for (const edge of edges) {
      connect(edge.source, edge.target);
      connect(edge.target, edge.source);
    }
    const included = new Set<string>();
    if (this.meta.has(pageId)) included.add(pageId);
    let frontier = [...included];
    for (let level = 0; level < depth && frontier.length > 0; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id) ?? []) {
          if (!included.has(neighbor)) {
            included.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
    const nodes = [...included]
      .map((id) => this.meta.get(id))
      .filter((meta): meta is PageMetaLite => meta !== undefined)
      .map((meta) => this.nodeOf(meta));
    return {
      nodes,
      edges: edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
      tags: [],
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------------------------

  /** A snapshot to persist (plain data, structured-clone friendly). */
  toPersisted(): PersistedIndex {
    return {
      format: INDEX_FORMAT_VERSION,
      docSchema: DOC_SCHEMA_VERSION,
      dataModel: DATA_MODEL_VERSION,
      savedAt: this.now(),
      contents: [...this.contents],
      rows: [...this.rows],
      databases: [...this.dbFingerprints],
      titles: [...this.indexedTitles],
      mini: this.mini.toJSON(),
    };
  }
}
