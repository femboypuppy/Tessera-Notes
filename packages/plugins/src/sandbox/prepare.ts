import { t } from '../i18n';
import type { InstrumentedCode } from './instrument';
import type { InstrumentRequest, InstrumentResponse } from './instrument.worker';

/**
 * Gets plugin UI code ready to run in a frame: instrumented (`instrument.ts`) in a worker, and
 * kept, in memory and in IndexedDB, per plugin and version. Parsing a large plugin takes seconds,
 * so it happens once per install or update, never once per frame.
 */

/** Bump when `instrument.ts` changes its output: code prepared by an older version is redone. */
export const PREPARED_CODE_VERSION = 1;

/** The IndexedDB database of prepared code (a cache: deleting it only costs time). */
export const PREPARED_CODE_DB_NAME = 'tessera-plugin-prepared-code';
const STORE = 'code';

/**
 * Which code this is: `slot` is stable for a plugin's file (its ID), so a new version replaces the
 * old one; `hash` identifies the version.
 */
export interface PrepareKey {
  slot: string;
  hash: string;
}

/** Instruments code. The default runs in a worker. */
export type Instrument = (code: string) => Promise<InstrumentedCode>;

/** How long the worker stays around after its last job. */
const WORKER_IDLE_MS = 30_000;

/** The in-thread fallback, for environments without module workers (unit tests). */
const instrumentHere: Instrument = async (code) =>
  (await import('./instrument')).instrumentModule(code);

/** Instruments in a module worker, started on demand and stopped when idle. */
export function workerInstrument(): Instrument {
  let worker: Worker | null = null;
  let failed = false;
  let nextId = 1;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<
    number,
    { code: string; resolve(value: InstrumentedCode): void; reject(error: Error): void }
  >();

  const stop = () => {
    worker?.terminate();
    worker = null;
  };
  const start = (): Worker | null => {
    if (worker || failed || typeof Worker === 'undefined') return worker;
    try {
      const created = new Worker(new URL('./instrument.worker.ts', import.meta.url), {
        type: 'module',
        name: 'tessera-plugin-instrument',
      });
      created.onmessage = (event: MessageEvent<InstrumentResponse>) => {
        const response = event.data;
        const job = pending.get(response.id);
        if (!job) return;
        pending.delete(response.id);
        if (response.ok) job.resolve({ code: response.code, guard: response.guard });
        else job.reject(new Error(response.message));
        if (pending.size === 0) idle = setTimeout(stop, WORKER_IDLE_MS);
      };
      created.onerror = (event) => {
        event.preventDefault();
        console.warn(
          '[plugins] The instrumenting worker failed; preparing code here',
          event.message,
        );
        failed = true;
        stop();
        const jobs = [...pending.values()];
        pending.clear();
        for (const job of jobs) instrumentHere(job.code).then(job.resolve, job.reject);
      };
      worker = created;
    } catch (error) {
      console.warn('[plugins] No instrumenting worker; preparing code here', error);
      failed = true;
    }
    return worker;
  };

  return (code) => {
    const target = start();
    if (!target) return instrumentHere(code);
    if (idle) clearTimeout(idle);
    idle = null;
    const id = nextId;
    nextId += 1;
    return new Promise<InstrumentedCode>((resolve, reject) => {
      pending.set(id, { code, resolve, reject });
      target.postMessage({ id, code } satisfies InstrumentRequest);
    });
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/** Every key of a slot: keys are `[slot, hash, version]`. */
const slotRange = (slot: string) => IDBKeyRange.bound([slot], [slot, []]);
const storeKey = (key: PrepareKey) => [key.slot, key.hash, PREPARED_CODE_VERSION];

/** Prepared code in IndexedDB. Every failure reads as "not cached": it's only a cache. */
class PersistentCache {
  private db: Promise<IDBDatabase | null> | null = null;

  constructor(private readonly factory: IDBFactory | null) {}

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise<IDBDatabase | null>((resolve) => {
      if (!this.factory) {
        resolve(null);
        return;
      }
      try {
        const req = this.factory.open(PREPARED_CODE_DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => {
          req.result.onversionchange = () => req.result.close();
          resolve(req.result);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.db;
  }

  async get(key: PrepareKey): Promise<InstrumentedCode | null> {
    try {
      const db = await this.open();
      if (!db) return null;
      const value: unknown = await request(
        db.transaction(STORE, 'readonly').objectStore(STORE).get(storeKey(key)),
      );
      const record = value as Partial<InstrumentedCode> | null | undefined;
      return typeof record?.code === 'string' && typeof record.guard === 'string'
        ? { code: record.code, guard: record.guard }
        : null;
    } catch {
      return null;
    }
  }

  async has(key: PrepareKey): Promise<boolean> {
    try {
      const db = await this.open();
      if (!db) return false;
      const found = await request(
        db.transaction(STORE, 'readonly').objectStore(STORE).getKey(storeKey(key)),
      );
      return found !== undefined;
    } catch {
      return false;
    }
  }

  /** Stores the code, replacing whatever the slot held (an older version). */
  async put(key: PrepareKey, value: InstrumentedCode): Promise<void> {
    try {
      const db = await this.open();
      if (!db) return;
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.delete(slotRange(key.slot));
      store.put({ code: value.code, guard: value.guard }, storeKey(key));
      await done(tx);
    } catch {
      // Out of space, or IndexedDB is unavailable: the code is prepared again next time.
    }
  }

  async delete(slot: string): Promise<void> {
    try {
      const db = await this.open();
      if (!db) return;
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(slotRange(slot));
      await done(tx);
    } catch {
      // Nothing to clean up.
    }
  }
}

/** Options of {@link UiCodePreparer}. */
export interface UiCodePreparerOptions {
  /** Default: {@link workerInstrument}. */
  instrument?: Instrument;
  /** Where prepared code is kept between sessions. Default: `indexedDB` when there is one. */
  indexedDB?: IDBFactory | null;
  /** How many prepared plugins stay in memory. */
  memoryEntries?: number;
}

/** Prepares UI code for frames, once per plugin version. */
export class UiCodePreparer {
  private readonly instrument: Instrument;
  private readonly persistent: PersistentCache;
  private readonly memoryEntries: number;
  private readonly memory = new Map<string, Promise<InstrumentedCode>>();

  constructor(options: UiCodePreparerOptions = {}) {
    this.instrument = options.instrument ?? workerInstrument();
    this.persistent = new PersistentCache(
      options.indexedDB !== undefined
        ? options.indexedDB
        : typeof indexedDB === 'undefined'
          ? null
          : indexedDB,
    );
    this.memoryEntries = options.memoryEntries ?? 4;
  }

  /**
   * The instrumented code. Without a key it isn't cached. Rejects with a message for people when
   * the code can't be parsed.
   */
  prepare(code: string, key?: PrepareKey): Promise<InstrumentedCode> {
    if (!key) return this.run(code);
    const id = `${key.slot}\n${key.hash}`;
    const known = this.memory.get(id);
    if (known) {
      // Most recently used goes last.
      this.memory.delete(id);
      this.memory.set(id, known);
      return known;
    }
    const prepared = this.persistent.get(key).then(async (cached) => {
      if (cached) return cached;
      const fresh = await this.run(code);
      await this.persistent.put(key, fresh);
      return fresh;
    });
    for (const [other] of this.memory)
      if (other.startsWith(`${key.slot}\n`)) this.memory.delete(other);
    this.memory.set(id, prepared);
    while (this.memory.size > this.memoryEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
    prepared.catch(() => {
      if (this.memory.get(id) === prepared) this.memory.delete(id);
    });
    return prepared;
  }

  /**
   * Prepares code in the background unless it's ready already (in memory, or stored from an
   * earlier session: that is only checked, not loaded). Failures show when a frame opens.
   */
  async warm(code: string, key: PrepareKey): Promise<void> {
    if (this.memory.has(`${key.slot}\n${key.hash}`) || (await this.persistent.has(key))) return;
    await this.prepare(code, key).catch(() => undefined);
  }

  /** Drops everything prepared for a slot. */
  async forget(slot: string): Promise<void> {
    for (const [id] of this.memory) if (id.startsWith(`${slot}\n`)) this.memory.delete(id);
    await this.persistent.delete(slot);
  }

  private async run(code: string): Promise<InstrumentedCode> {
    try {
      return await this.instrument(code);
    } catch (error) {
      throw new Error(
        t('errUnreadableCode', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

/** The app's preparer. */
export const uiCodePreparer = new UiCodePreparer();
