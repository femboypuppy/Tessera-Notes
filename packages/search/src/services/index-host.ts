import {
  createBatchDebouncer,
  databaseDocName,
  pageDocName,
  tagKey,
  type BatchDebouncer,
  type DocHandle,
  type DocStore,
  type EventBus,
  type PageKind,
  type PageMeta,
  type PagesSnapshot,
  type PagesStore,
  type SearchOptions,
  type WorkspaceInfo,
} from '@tessera/core';
import * as Y from 'yjs';
import type { ChangeSummary, StaleSet } from '../engine/index-core';
import type { ContentItem, DatabaseItem } from '../engine/protocol';
import { parseQuery } from '../engine/query';
import type { IndexTransport } from '../engine/transport';
import type {
  GraphSnapshot,
  MentionSource,
  PageMetaLite,
  QueryFilters,
  QueryResponse,
  RichBacklink,
  RichMention,
  RichOutgoingLink,
  TagCount,
  TagPair,
} from '../engine/types';

/** What the host needs from the session (a subset of `IndexServiceContext`). */
export interface IndexHostContext {
  workspace: Pick<WorkspaceInfo, 'id'>;
  workspaceDoc: Y.Doc;
  pages: PagesStore;
  events: EventBus;
  loadPageDoc(pageId: string): Promise<DocHandle>;
  loadDatabaseDoc(databaseId: string): Promise<DocHandle>;
  storage: { docStore: DocStore };
}

export interface IndexHostOptions {
  /** Creates the transport (called once per host). */
  transport: () => IndexTransport | Promise<IndexTransport>;
  /** Persist the index between sessions (default true). */
  persist?: boolean;
  /** Docs read per batch sent to the worker. Default 24. */
  batchSize?: number;
  /** Parallel doc reads. Default 6. */
  concurrency?: number;
  /** Delay before listeners hear about index changes. Default 120 ms. */
  notifyDelayMs?: number;
  /**
   * Delay before the pages that show a changed title are read again (a title typed letter by
   * letter changes with every key). Default 1000 ms, at most 5 s while titles keep changing.
   */
  retitleDelayMs?: number;
}

/** Progress of the index, for "Indexing…" hints. */
export interface IndexStatus {
  state: 'starting' | 'indexing' | 'ready' | 'failed';
  /** Docs read in the current pass. */
  done: number;
  /** Docs to read in the current pass. */
  total: number;
  /** Where the index runs. */
  transport: IndexTransport['kind'];
  /** True when the index was restored from IndexedDB. */
  restored: boolean;
}

/** Results of {@link IndexHost.query}. */
export type HostQueryResults = QueryResponse;

type QueueKey = `p:${string}` | `d:${string}`;

interface Deferred {
  resolve(): void;
}

const hosts = new WeakMap<Y.Doc, Promise<IndexHost>>();

/** Yields to the event loop so input and rendering run between batches. */
function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The main-thread half of the search and link indexes, shared by `MiniSearchIndex` and
 * `GraphLinkIndex` in one workspace session. It follows the session's events, reads page and
 * database docs (from the `DocStore`, or the open doc when it changed in this session), and sends
 * them to the index (a worker) as Yjs updates. Parsing, indexing and queries happen there.
 */
export class IndexHost {
  /**
   * Returns the session's host (one per workspace doc, shared by the search and link indexes),
   * creating it on first use. Call {@link release} once per acquire.
   */
  static async acquire(context: IndexHostContext, options: IndexHostOptions): Promise<IndexHost> {
    let pending = hosts.get(context.workspaceDoc);
    if (!pending) {
      pending = Promise.resolve(options.transport()).then(
        (transport) => new IndexHost(context, options, transport),
      );
      hosts.set(context.workspaceDoc, pending);
      // A failed start must not poison the next attempt.
      pending.catch(() => hosts.delete(context.workspaceDoc));
    }
    const host = await pending;
    host.refs += 1;
    return host;
  }

  private refs = 0;
  private disposed = false;
  private readonly offs: Array<() => void> = [];
  private readonly lastSent = new Map<string, PageMetaLite>();
  private readonly pendingMeta = new Set<string>();
  private readonly pendingRemovals = new Set<string>();
  private metaScheduled = false;
  /** Settles once the index applied the last metadata update and answered with its stale docs. */
  private metaApplied: Promise<void> = Promise.resolve();
  /** Docs that show a title that changed, read again once titles settle. */
  private readonly retitled: BatchDebouncer;
  private readonly high = new Set<QueueKey>();
  private readonly low = new Set<QueueKey>();
  private readonly waiters = new Map<QueueKey, Deferred[]>();
  /** Docs that changed in this session: read them from the live doc, not the store. */
  private readonly live = new Set<QueueKey>();
  private pumping: Promise<void> | null = null;
  private readonly listeners = new Set<(change: ChangeSummary) => void>();
  private readonly statusListeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChange: ChangeSummary = { search: false, links: false };
  private statusValue: IndexStatus;
  /** Docs read and sent to the index since the host started (diagnostics and tests). */
  docsRead = 0;
  /** Resolves once every page's metadata is in the index (titles are searchable). */
  readonly ready: Promise<void>;

  private constructor(
    private readonly context: IndexHostContext,
    private readonly options: IndexHostOptions,
    private readonly transport: IndexTransport,
  ) {
    this.statusValue = {
      state: 'starting',
      done: 0,
      total: 0,
      transport: this.transport.kind,
      restored: false,
    };
    this.retitled = createBatchDebouncer(
      (keys) => {
        for (const key of keys) if (isQueueKey(key)) void this.enqueue(key, 'low');
      },
      { delayMs: options.retitleDelayMs ?? 1000, maxWaitMs: 5000 },
    );
    const { events } = context;
    this.offs.push(
      events.on('page.created', ({ page }) => this.metaChanged([page.id])),
      events.on('page.updated', ({ page, fields, local }) => {
        this.metaChanged([page.id]);
        // A collaborator edited content we may not have open: re-read what we can.
        if (!local && fields.includes('updatedAt')) {
          void this.enqueue(page.kind === 'database' ? `d:${page.id}` : `p:${page.id}`, 'low');
        }
      }),
      events.on('page.moved', ({ pageId }) => this.subtreeChanged(pageId)),
      events.on('page.trashed', ({ affectedPageIds }) => this.metaChanged(affectedPageIds, true)),
      events.on('page.restored', ({ affectedPageIds }) => this.metaChanged(affectedPageIds, true)),
      events.on('page.deleted', ({ pageId }) => this.removed(pageId)),
      events.on('doc.changed', ({ pageId }) => {
        this.live.add(`p:${pageId}`);
        void this.enqueue(`p:${pageId}`, 'high');
      }),
      events.on('database.changed', ({ databaseId }) => {
        this.live.add(`d:${databaseId}`);
        void this.enqueue(`d:${databaseId}`, 'high');
      }),
      this.transport.onChange((change) => this.changed(change)),
    );
    if (typeof document !== 'undefined') {
      // Save the index when the tab goes to the background: it may never come back.
      const onVisibility = () => {
        if (document.visibilityState !== 'hidden' || this.disposed) return;
        this.transport.request({ type: 'flush' }).catch(() => undefined);
      };
      document.addEventListener('visibilitychange', onVisibility);
      this.offs.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }
    this.ready = this.start();
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  private async start(): Promise<void> {
    const init = this.transport.request({
      type: 'init',
      workspaceId: this.context.workspace.id,
      persist: this.options.persist ?? true,
    });
    const snapshot = this.context.pages.getSnapshot();
    const upserts = snapshot.all().map((page) => this.lite(page, snapshot));
    for (const page of upserts) this.lastSent.set(page.id, page);
    const meta = this.transport.request({ type: 'meta', upserts, removes: [], full: true });
    try {
      const { restored } = await init;
      const stale = await meta;
      this.setStatus({ restored });
      this.readAgain(stale);
      if (this.high.size + this.low.size === 0) this.setStatus({ state: 'ready' });
    } catch (error) {
      // Queries fail on their own (the transport is broken); `ready` itself never rejects.
      console.warn('[search] the index could not start', error);
      this.setStatus({ state: 'failed' });
    }
  }

  /** Releases one reference; the last one flushes the index to storage and stops the worker. */
  async release(): Promise<void> {
    this.refs -= 1;
    if (this.refs > 0 || this.disposed) return;
    this.disposed = true;
    hosts.delete(this.context.workspaceDoc);
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.retitled.cancel();
    this.high.clear();
    this.low.clear();
    for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.resolve();
    this.waiters.clear();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    try {
      await this.pumping;
      await Promise.race([
        this.transport.request({ type: 'flush' }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      // The index is a cache: failing to save it only costs a re-index next time.
    } finally {
      this.transport.terminate();
      this.listeners.clear();
      this.statusListeners.clear();
    }
  }

  /** Waits until every queued doc is indexed and the index answered. */
  async whenIdle(): Promise<void> {
    await this.ready;
    for (;;) {
      this.flushMeta();
      // Its answer may name docs to read again: read them now rather than once titles settle.
      await this.metaApplied;
      this.retitled.flush();
      if (this.pumping) await this.pumping;
      else if (this.high.size + this.low.size > 0) await this.pump();
      else break;
    }
    await this.transport.request({ type: 'ping' });
  }

  get status(): IndexStatus {
    // The transport may fall back to in-process after the host started.
    if (this.statusValue.transport !== this.transport.kind)
      this.statusValue = { ...this.statusValue, transport: this.transport.kind };
    return this.statusValue;
  }

  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(patch: Partial<IndexStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    for (const listener of [...this.statusListeners]) listener();
  }

  /** Listens for index changes (throttled). */
  subscribe(listener: (change: ChangeSummary) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(change: ChangeSummary): void {
    this.pendingChange = {
      search: this.pendingChange.search || change.search,
      links: this.pendingChange.links || change.links,
    };
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const pending = this.pendingChange;
      this.pendingChange = { search: false, links: false };
      for (const listener of [...this.listeners]) listener(pending);
    }, this.options.notifyDelayMs ?? 120);
  }

  // ---------------------------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------------------------

  private lite(page: PageMeta, snapshot: PagesSnapshot): PageMetaLite {
    return {
      id: page.id,
      title: page.title,
      kind: page.kind,
      parentId: snapshot.effectiveParentId(page.id),
      trashed: snapshot.isTrashed(page.id),
      isRow: snapshot.isRow(page.id),
      icon: page.icon ?? null,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    };
  }

  private metaChanged(ids: readonly string[], urgent = false): void {
    for (const id of ids) this.pendingMeta.add(id);
    if (urgent) this.flushMeta();
    else if (!this.metaScheduled) {
      this.metaScheduled = true;
      queueMicrotask(() => this.flushMeta());
    }
  }

  private subtreeChanged(pageId: string): void {
    const snapshot = this.context.pages.getSnapshot();
    this.metaChanged([pageId, ...snapshot.descendants(pageId).map((page) => page.id)]);
  }

  private removed(pageId: string): void {
    this.pendingMeta.delete(pageId);
    this.pendingRemovals.add(pageId);
    this.lastSent.delete(pageId);
    this.high.delete(`p:${pageId}`);
    this.low.delete(`p:${pageId}`);
    this.high.delete(`d:${pageId}`);
    this.low.delete(`d:${pageId}`);
    this.live.delete(`p:${pageId}`);
    this.live.delete(`d:${pageId}`);
    this.flushMeta();
  }

  /** Sends pending metadata changes now (queries call this so they see every change). */
  flushMeta(): void {
    this.metaScheduled = false;
    if (this.disposed || (this.pendingMeta.size === 0 && this.pendingRemovals.size === 0)) return;
    const snapshot = this.context.pages.getSnapshot();
    const upserts: PageMetaLite[] = [];
    const removes = [...this.pendingRemovals];
    for (const id of this.pendingMeta) {
      const page = snapshot.get(id);
      if (!page) {
        if (this.lastSent.delete(id)) removes.push(id);
        continue;
      }
      const next = this.lite(page, snapshot);
      const previous = this.lastSent.get(id);
      if (previous && sameMeta(previous, next)) continue;
      this.lastSent.set(id, next);
      upserts.push(next);
    }
    this.pendingMeta.clear();
    this.pendingRemovals.clear();
    if (upserts.length === 0 && removes.length === 0) return;
    this.metaApplied = this.transport.request({ type: 'meta', upserts, removes, full: false }).then(
      // After a title changed, the pages that link to it and the rows that relate to it show the
      // old title in their text.
      (stale) => {
        for (const key of staleKeys(stale)) this.retitled.call(key);
      },
      (error: unknown) => console.warn('[search] metadata update failed', error),
    );
  }

  /** Queues the pages and databases the index reports as stale. */
  private readAgain(stale: StaleSet): void {
    for (const key of staleKeys(stale)) void this.enqueue(key, 'low');
  }

  // ---------------------------------------------------------------------------------------------
  // Content
  // ---------------------------------------------------------------------------------------------

  private enqueue(key: QueueKey, priority: 'high' | 'low'): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const promise = new Promise<void>((resolve) => {
      const list = this.waiters.get(key) ?? [];
      list.push({ resolve });
      this.waiters.set(key, list);
    });
    if (priority === 'high') {
      this.low.delete(key);
      this.high.add(key);
    } else if (!this.high.has(key)) {
      this.low.add(key);
    }
    if (!this.pumping) void this.pump();
    return promise;
  }

  private take(): QueueKey | undefined {
    for (const queue of [this.high, this.low]) {
      const first = queue.values().next();
      if (!first.done) {
        queue.delete(first.value);
        return first.value;
      }
    }
    return undefined;
  }

  private pump(): Promise<void> {
    this.pumping ??= this.runPump().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async runPump(): Promise<void> {
    await this.ready;
    const batchSize = this.options.batchSize ?? 24;
    const concurrency = this.options.concurrency ?? 6;
    let done = 0;
    this.setStatus({ state: 'indexing', done: 0, total: this.high.size + this.low.size });
    while (!this.disposed && this.high.size + this.low.size > 0) {
      const keys: QueueKey[] = [];
      // Waiters registered from here on wait for the next read of their doc, not this one.
      const settled: Deferred[] = [];
      while (keys.length < batchSize) {
        const key = this.take();
        if (!key) break;
        keys.push(key);
        settled.push(...(this.waiters.get(key) ?? []));
        this.waiters.delete(key);
      }
      const contents: ContentItem[] = [];
      const databases: DatabaseItem[] = [];
      for (let i = 0; i < keys.length; i += concurrency) {
        const slice = keys.slice(i, i + concurrency);
        const items = await Promise.all(slice.map((key) => this.read(key)));
        for (const item of items) {
          if (!item) continue;
          if ('pageId' in item) contents.push(item);
          else databases.push(item);
        }
      }
      this.flushMeta();
      // Each request transfers only its own buffers: a buffer transferred with the first one is
      // detached, and the second could no longer be sent (its databases went unindexed).
      const buffers = (items: ReadonlyArray<{ bytes: Uint8Array | null }>) =>
        items
          .map((item) => item.bytes?.buffer)
          .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
      try {
        if (contents.length)
          await this.transport.request({ type: 'content', items: contents }, buffers(contents));
        if (databases.length)
          await this.transport.request({ type: 'database', items: databases }, buffers(databases));
      } catch (error) {
        console.warn('[search] indexing a batch failed', error);
      }
      for (const waiter of settled) waiter.resolve();
      done += keys.length;
      this.setStatus({ done, total: done + this.high.size + this.low.size });
      await yieldToMain();
    }
    if (!this.disposed) this.setStatus({ state: 'ready', done, total: done });
  }

  /** Reads one queued doc as bytes the worker owns (copied, so transferring never detaches ours). */
  private async read(key: QueueKey): Promise<ContentItem | DatabaseItem | null> {
    const id = key.slice(2);
    const page = this.context.pages.getSnapshot().get(id);
    if (!page) return null;
    try {
      if (key.startsWith('p:')) {
        if (page.kind !== 'page') return null;
        this.docsRead += 1;
        const bytes = await this.readBytes(key);
        return { pageId: id, bytes, fingerprint: page.updatedAt };
      }
      if (page.kind !== 'database') return null;
      this.docsRead += 1;
      const bytes = await this.readBytes(key);
      return { databaseId: id, bytes, fingerprint: page.updatedAt };
    } catch (error) {
      console.warn(`[search] cannot read ${key}`, error);
      return null;
    }
  }

  private async readBytes(key: QueueKey): Promise<Uint8Array | null> {
    const id = key.slice(2);
    const isPage = key.startsWith('p:');
    if (this.live.has(key)) {
      const handle = isPage
        ? await this.context.loadPageDoc(id)
        : await this.context.loadDatabaseDoc(id);
      try {
        return Y.encodeStateAsUpdate(handle.doc);
      } finally {
        handle.release();
      }
    }
    const stored = await this.context.storage.docStore.load(
      isPage ? pageDocName(id) : databaseDocName(id),
    );
    return stored ? stored.slice() : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Public operations
  // ---------------------------------------------------------------------------------------------

  /** Re-reads a page (and its database's rows for database pages), resolving once indexed. */
  async upsert(pageId: string): Promise<void> {
    await this.ready;
    const page = this.context.pages.getSnapshot().get(pageId);
    if (!page) {
      this.removed(pageId);
      await this.transport.request({ type: 'ping' });
      return;
    }
    this.metaChanged([pageId], true);
    await this.enqueue(page.kind === 'database' ? `d:${pageId}` : `p:${pageId}`, 'high');
  }

  /** Drops a page from the index until it changes again. */
  async remove(pageId: string): Promise<void> {
    await this.ready;
    this.removed(pageId);
    await this.transport.request({ type: 'ping' });
  }

  /** Forgets everything and re-reads every page and database. */
  async rebuild(): Promise<void> {
    await this.ready;
    this.high.clear();
    this.low.clear();
    this.pendingMeta.clear();
    this.pendingRemovals.clear();
    this.lastSent.clear();
    await this.transport.request({ type: 'clear' });
    const snapshot = this.context.pages.getSnapshot();
    const upserts = snapshot.all().map((page) => this.lite(page, snapshot));
    for (const page of upserts) this.lastSent.set(page.id, page);
    await this.transport.request({ type: 'meta', upserts, removes: [], full: true });
    const waits = upserts.map((page) =>
      this.enqueue(page.kind === 'database' ? `d:${page.id}` : `p:${page.id}`, 'low'),
    );
    await Promise.all(waits);
    await this.whenIdle();
  }

  /** Resolves `in:` titles to page IDs (exact title first, then prefix; trash excluded). */
  resolveTitles(titles: readonly string[]): string[] {
    const snapshot = this.context.pages.getSnapshot();
    const pages = snapshot.all().filter((page) => !snapshot.isTrashed(page.id));
    const ids = new Set<string>();
    for (const raw of titles) {
      const wanted = raw.trim().toLocaleLowerCase();
      if (!wanted) continue;
      let matches = pages.filter((page) => page.title.trim().toLocaleLowerCase() === wanted);
      if (matches.length === 0)
        matches = pages.filter((page) => page.title.toLocaleLowerCase().startsWith(wanted));
      for (const page of matches) ids.add(page.id);
    }
    return [...ids];
  }

  /**
   * Runs a query with the filter syntax of `parseQuery` plus explicit options. Hits for pages
   * trashed or deleted since the index answered are dropped here, so results never show them.
   */
  async query(text: string, options: SearchOptions = {}): Promise<HostQueryResults> {
    if (options.signal?.aborted) throw abortError();
    await this.ready;
    const parsed = parseQuery(text);
    const filters: QueryFilters = {};
    let kinds: PageKind[] | undefined = parsed.kinds.length ? parsed.kinds : undefined;
    if (options.kinds)
      kinds = kinds ? kinds.filter((kind) => options.kinds?.includes(kind)) : options.kinds;
    if (kinds) {
      if (kinds.length === 0) return { hits: [], total: 0, tookMs: 0 };
      filters.kinds = kinds;
    }
    const within = [...(options.withinPageId ? [options.withinPageId] : [])];
    if (parsed.within.length) {
      const resolved = this.resolveTitles(parsed.within);
      if (resolved.length === 0) return { hits: [], total: 0, tookMs: 0 };
      within.push(...resolved);
    }
    if (within.length) filters.within = within;
    const tags = [...parsed.tags, ...(options.tags ?? [])].map((tag) =>
      tagKey(tag.replace(/^#/, '')),
    );
    if (tags.length) filters.tags = [...new Set(tags)];
    if (parsed.hasTasks || options.hasTasks) filters.hasTasks = true;
    if (options.includeRows === false) filters.includeRows = false;
    this.flushMeta();
    const response = await this.transport.request({
      type: 'query',
      request: {
        text: parsed.text,
        filters,
        limit: Math.max(0, options.limit ?? 20),
        offset: Math.max(0, options.offset ?? 0),
      },
    });
    if (options.signal?.aborted) throw abortError();
    const snapshot = this.context.pages.getSnapshot();
    const hits = response.hits.filter(
      (hit) => snapshot.has(hit.pageId) && !snapshot.isTrashed(hit.pageId),
    );
    return {
      hits,
      total: Math.max(hits.length, response.total - (response.hits.length - hits.length)),
      tookMs: response.tookMs,
    };
  }

  async backlinks(pageId: string): Promise<RichBacklink[]> {
    await this.ready;
    this.flushMeta();
    return this.transport.request({ type: 'backlinks', pageId });
  }

  async outgoing(pageId: string): Promise<RichOutgoingLink[]> {
    await this.ready;
    this.flushMeta();
    return this.transport.request({ type: 'outgoing', pageId });
  }

  async edges() {
    await this.ready;
    this.flushMeta();
    return this.transport.request({ type: 'edges' });
  }

  /**
   * Unlinked mentions of a page: the index finds candidate pages, then their current content is
   * checked precisely (so positions match the doc a Link button will change).
   */
  async unlinkedMentions(pageId: string): Promise<RichMention[]> {
    await this.ready;
    this.flushMeta();
    const candidates = await this.transport.request({ type: 'mentionCandidates', pageId });
    if (candidates.length === 0) return [];
    const sources: MentionSource[] = [];
    for (const candidate of candidates) {
      try {
        sources.push({ pageId: candidate, bytes: await this.readBytes(`p:${candidate}`) });
      } catch (error) {
        console.warn(`[search] cannot read ${candidate}`, error);
      }
    }
    const transfer = sources
      .map((source) => source.bytes?.buffer)
      .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
    return this.transport.request({ type: 'mentions', pageId, sources }, transfer);
  }

  async orphans(): Promise<string[]> {
    await this.ready;
    this.flushMeta();
    return this.transport.request({ type: 'orphans' });
  }

  async tags(): Promise<TagCount[]> {
    await this.ready;
    this.flushMeta();
    return this.transport.request({ type: 'tags' });
  }

  async tagCooccurrence(): Promise<TagPair[]> {
    await this.ready;
    this.flushMeta();
    return this.transport.request({ type: 'tagCooccurrence' });
  }

  async graph(): Promise<GraphSnapshot> {
    await this.ready;
    this.flushMeta();
    return this.transport.request({ type: 'graph' });
  }

  async neighborhood(pageId: string, depth: number): Promise<GraphSnapshot> {
    await this.ready;
    this.flushMeta();
    return this.transport.request({ type: 'neighborhood', pageId, depth });
  }
}

function staleKeys(stale: StaleSet): QueueKey[] {
  return [
    ...stale.pages.map((id): QueueKey => `p:${id}`),
    ...stale.databases.map((id): QueueKey => `d:${id}`),
  ];
}

function isQueueKey(key: string): key is QueueKey {
  return key.startsWith('p:') || key.startsWith('d:');
}

function sameMeta(a: PageMetaLite, b: PageMetaLite): boolean {
  return (
    a.title === b.title &&
    a.kind === b.kind &&
    a.parentId === b.parentId &&
    a.trashed === b.trashed &&
    a.isRow === b.isRow &&
    a.icon === b.icon &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt
  );
}

function abortError(): Error {
  const error = new Error('The search was aborted');
  error.name = 'AbortError';
  return error;
}
