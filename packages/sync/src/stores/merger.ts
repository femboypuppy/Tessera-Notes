import { runMerge, type MergeKind, type MergeRequest, type MergeResponse } from './merge-protocol';

/**
 * Merges a doc's stored updates. A workspace doc after a large import holds hundreds of updates
 * and megabytes; merging them takes hundreds of milliseconds, which must not block the page (#66).
 */
export interface UpdateMerger {
  /** `Y.mergeUpdates`, for loading. Rejects on a corrupt update. */
  merge(updates: readonly Uint8Array[]): Promise<Uint8Array>;
  /** One equivalent update without deleted content, for compaction. Rejects on a corrupt update. */
  compact(updates: readonly Uint8Array[]): Promise<Uint8Array>;
  /** Stops the worker; requests still waiting reject. */
  dispose(): void;
}

/** Merges on the calling thread (tests, and where workers are unavailable). */
export function mainThreadMerger(): UpdateMerger {
  return {
    merge: async (updates) => runMerge('merge', updates),
    compact: async (updates) => runMerge('compact', updates),
    dispose() {},
  };
}

/** The part of `Worker` the merger uses (tests pass fakes). */
export interface MergeWorkerLike {
  onmessage: ((event: MessageEvent<MergeResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: MergeRequest): void;
  terminate(): void;
}

export interface WorkerMergerOptions {
  /** Starts a worker, or returns null where none can start. */
  createWorker?: () => MergeWorkerLike | null;
  /** The worker stops after this long without requests (it holds a copy of Yjs). Default 30 s. */
  idleMs?: number;
}

function startMergeWorker(): MergeWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./merge.worker.ts', import.meta.url), {
      type: 'module',
      name: 'tessera-merge',
    }) as unknown as MergeWorkerLike;
  } catch {
    return null;
  }
}

interface Pending {
  kind: MergeKind;
  updates: readonly Uint8Array[];
  resolve(update: Uint8Array): void;
  reject(error: Error): void;
}

/**
 * Merges in a Web Worker, started on first use and stopped when idle. Where no worker can start,
 * or one fails to load, it merges on the main thread instead, so merging never fails for that.
 */
export class WorkerMerger implements UpdateMerger {
  private worker: MergeWorkerLike | null = null;
  /** No worker can start here: everything merges on the main thread. */
  private unavailable = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly createWorker: () => MergeWorkerLike | null;
  private readonly idleMs: number;

  constructor(options: WorkerMergerOptions = {}) {
    this.createWorker = options.createWorker ?? startMergeWorker;
    this.idleMs = options.idleMs ?? 30_000;
  }

  merge(updates: readonly Uint8Array[]): Promise<Uint8Array> {
    return this.run('merge', updates);
  }

  compact(updates: readonly Uint8Array[]): Promise<Uint8Array> {
    return this.run('compact', updates);
  }

  dispose(): void {
    this.disposed = true;
    this.stopWorker();
    for (const request of this.pending.values()) request.reject(new Error('The merger was closed'));
    this.pending.clear();
  }

  private run(kind: MergeKind, updates: readonly Uint8Array[]): Promise<Uint8Array> {
    if (this.disposed) return Promise.reject(new Error('The merger was closed'));
    const worker = this.unavailable ? null : this.ensureWorker();
    if (!worker) return Promise.resolve().then(() => runMerge(kind, updates));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    return new Promise<Uint8Array>((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, { kind, updates, resolve, reject });
      // A copy goes to the worker: the caller keeps its updates.
      worker.postMessage({ id, kind, updates: [...updates] });
    });
  }

  private ensureWorker(): MergeWorkerLike | null {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    if (!worker) {
      this.unavailable = true;
      return null;
    }
    worker.onmessage = (event) => this.receive(event.data);
    worker.onerror = (event) => {
      event.preventDefault?.();
      // The worker could not load or crashed: what it held merges here, and so does the rest.
      this.unavailable = true;
      this.stopWorker();
      const waiting = [...this.pending.values()];
      this.pending.clear();
      for (const request of waiting) {
        try {
          request.resolve(runMerge(request.kind, request.updates));
        } catch (error) {
          request.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };
    this.worker = worker;
    return worker;
  }

  private receive(response: MergeResponse): void {
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    if (response.ok) request.resolve(response.update);
    else request.reject(new Error(response.message));
    if (this.pending.size === 0) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.pending.size === 0) this.stopWorker();
      }, this.idleMs);
    }
  }

  private stopWorker(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
