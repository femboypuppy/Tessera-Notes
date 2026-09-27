import * as Y from 'yjs';

/**
 * Persists Yjs documents as append-only update logs. Implementations: in-memory (core, priority 0),
 * IndexedDB (`@tessera/sync`, 50), SQLite through Tauri (`@tessera/desktop`, 100).
 *
 * Contract:
 * - `storeUpdate` is durable when its promise resolves (the runtime awaits pending writes on
 *   `flush()` and before closing a workspace).
 * - `load` returns every stored update merged into one (`Y.mergeUpdates`), or null for a doc that
 *   was never stored.
 * - `compact` replaces the stored updates with one equivalent update and must never lose an
 *   update stored concurrently (compare what you merged with what is stored before replacing).
 * - `watch` (optional) reports updates written by *other* instances (other tabs or windows). The
 *   runtime applies them to the open doc without storing them again. An implementation may
 *   report an update before it is durable, and must then make sure it ends up stored even if
 *   its writer never commits it (the IndexedDB store stores those itself).
 *
 * @example
 * const update = await store.load('page:abc');
 * if (update) Y.applyUpdate(doc, update);
 * doc.on('update', (u) => void store.storeUpdate('page:abc', u));
 */
export interface DocStore {
  load(docName: string): Promise<Uint8Array | null>;
  storeUpdate(docName: string, update: Uint8Array): Promise<void>;
  compact(docName: string): Promise<void>;
  delete(docName: string): Promise<void>;
  /** Doc names starting with `prefix` (all docs when omitted), sorted. */
  list(prefix?: string): Promise<string[]>;
  watch?(docName: string, onUpdate: (update: Uint8Array) => void): () => void;
  /** Resolves when every pending write is durable. */
  flush?(): Promise<void>;
  dispose?(): void | Promise<void>;
}

/** Shared storage behind one or more {@link MemoryDocStore}s (one per simulated tab). */
export class MemoryDocStoreBackend {
  readonly docs = new Map<string, Uint8Array[]>();
  private readonly watchers = new Map<
    string,
    Set<{ owner: MemoryDocStore; notify: (update: Uint8Array) => void }>
  >();

  /** @internal */
  addWatcher(
    docName: string,
    owner: MemoryDocStore,
    notify: (update: Uint8Array) => void,
  ): () => void {
    const entry = { owner, notify };
    let set = this.watchers.get(docName);
    if (!set) {
      set = new Set();
      this.watchers.set(docName, set);
    }
    set.add(entry);
    return () => set.delete(entry);
  }

  /** @internal */
  broadcast(docName: string, from: MemoryDocStore, update: Uint8Array): void {
    for (const watcher of this.watchers.get(docName) ?? []) {
      if (watcher.owner !== from) watcher.notify(update);
    }
  }
}

/**
 * In-memory {@link DocStore}. Several instances sharing one {@link MemoryDocStoreBackend} behave
 * like tabs of one browser: each sees the others' updates through `watch`.
 *
 * @example
 * const backend = new MemoryDocStoreBackend();
 * const tabA = new MemoryDocStore(backend);
 * const tabB = new MemoryDocStore(backend);
 */
export class MemoryDocStore implements DocStore {
  readonly backend: MemoryDocStoreBackend;

  constructor(backend: MemoryDocStoreBackend = new MemoryDocStoreBackend()) {
    this.backend = backend;
  }

  async load(docName: string): Promise<Uint8Array | null> {
    const updates = this.backend.docs.get(docName);
    if (!updates || updates.length === 0) return null;
    return updates.length === 1 ? (updates[0] ?? null) : Y.mergeUpdates(updates);
  }

  async storeUpdate(docName: string, update: Uint8Array): Promise<void> {
    const copy = update.slice();
    const updates = this.backend.docs.get(docName);
    if (updates) updates.push(copy);
    else this.backend.docs.set(docName, [copy]);
    this.backend.broadcast(docName, this, copy);
  }

  async compact(docName: string): Promise<void> {
    const updates = this.backend.docs.get(docName);
    if (!updates || updates.length < 2) return;
    // Apply to a doc (with GC) so deleted content is dropped, then store the resulting state.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.mergeUpdates(updates));
    const compacted = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    this.backend.docs.set(docName, [compacted]);
  }

  async delete(docName: string): Promise<void> {
    this.backend.docs.delete(docName);
  }

  async list(prefix = ''): Promise<string[]> {
    return [...this.backend.docs.keys()].filter((name) => name.startsWith(prefix)).sort();
  }

  watch(docName: string, onUpdate: (update: Uint8Array) => void): () => void {
    return this.backend.addWatcher(docName, this, onUpdate);
  }

  async flush(): Promise<void> {
    // Writes are synchronous in memory.
  }

  /** Number of stored updates for a doc (tests use it to check compaction). */
  updateCount(docName: string): number {
    return this.backend.docs.get(docName)?.length ?? 0;
  }
}
