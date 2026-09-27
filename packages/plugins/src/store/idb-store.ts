import { isJsonValue, type JsonValue } from '@tessera/core';
import type { InstalledPlugin, InstalledPluginCode, PluginStore } from './types';

/** The IndexedDB database holding installed plugins on this device. */
export const PLUGIN_DB_NAME = 'tessera-plugins';
const DB_VERSION = 1;
const PLUGINS = 'plugins';
const CODE = 'code';
const STORAGE = 'storage';
const BY_PLUGIN = 'byPlugin';

interface StorageRecord {
  pluginId: string;
  key: string;
  value: JsonValue;
  size: number;
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

/** Opens the plugins database, creating its stores on first use. */
function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PLUGINS)) db.createObjectStore(PLUGINS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CODE)) db.createObjectStore(CODE);
      if (!db.objectStoreNames.contains(STORAGE)) {
        const store = db.createObjectStore(STORAGE, { keyPath: ['pluginId', 'key'] });
        store.createIndex(BY_PLUGIN, 'pluginId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the plugins database'));
    req.onblocked = () => reject(new Error('The plugins database is blocked by another tab'));
  });
}

/** Reads a stored record defensively: data on disk may come from an older version. */
function readPlugin(value: unknown): InstalledPlugin | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<InstalledPlugin>;
  if (typeof record.id !== 'string' || typeof record.manifest !== 'object' || !record.manifest)
    return undefined;
  return {
    ...(record as InstalledPlugin),
    granted: Array.isArray(record.granted) ? record.granted : [],
    settings: typeof record.settings === 'object' && record.settings ? record.settings : {},
    enabled: record.enabled === true,
  };
}

/** A {@link PluginStore} in IndexedDB. */
export class IndexedDbPluginStore implements PluginStore {
  private constructor(private readonly db: IDBDatabase) {
    // Another tab upgrading the schema: close so it isn't blocked.
    db.onversionchange = () => db.close();
  }

  /** Opens (or creates) the store. */
  static async open(
    factory: IDBFactory = indexedDB,
    name: string = PLUGIN_DB_NAME,
  ): Promise<IndexedDbPluginStore> {
    return new IndexedDbPluginStore(await openDatabase(factory, name));
  }

  async list(): Promise<InstalledPlugin[]> {
    const tx = this.db.transaction(PLUGINS, 'readonly');
    const values = await request(tx.objectStore(PLUGINS).getAll());
    return values.map(readPlugin).filter((plugin): plugin is InstalledPlugin => !!plugin);
  }

  async get(id: string): Promise<InstalledPlugin | undefined> {
    const tx = this.db.transaction(PLUGINS, 'readonly');
    return readPlugin(await request(tx.objectStore(PLUGINS).get(id)));
  }

  async put(plugin: InstalledPlugin, code?: InstalledPluginCode): Promise<void> {
    const tx = this.db.transaction([PLUGINS, CODE], 'readwrite');
    tx.objectStore(PLUGINS).put(plugin);
    if (code) tx.objectStore(CODE).put(code, plugin.id);
    await done(tx);
  }

  async getCode(id: string): Promise<InstalledPluginCode | undefined> {
    const tx = this.db.transaction(CODE, 'readonly');
    const value: unknown = await request(tx.objectStore(CODE).get(id));
    if (typeof value !== 'object' || value === null) return undefined;
    const code = value as Partial<InstalledPluginCode>;
    if (typeof code.code !== 'string') return undefined;
    const result: InstalledPluginCode = { code: code.code };
    if (typeof code.renderer === 'string') result.renderer = code.renderer;
    if (typeof code.readme === 'string') result.readme = code.readme;
    return result;
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction([PLUGINS, CODE, STORAGE], 'readwrite');
    tx.objectStore(PLUGINS).delete(id);
    tx.objectStore(CODE).delete(id);
    tx.objectStore(STORAGE).delete(IDBKeyRange.bound([id, ''], [id, []]));
    await done(tx);
  }

  async storageGet(id: string, key: string): Promise<JsonValue | undefined> {
    const tx = this.db.transaction(STORAGE, 'readonly');
    const value: unknown = await request(tx.objectStore(STORAGE).get([id, key]));
    if (typeof value !== 'object' || value === null) return undefined;
    const stored = (value as StorageRecord).value;
    return isJsonValue(stored) ? stored : undefined;
  }

  async storageSet(id: string, key: string, value: JsonValue): Promise<void> {
    const tx = this.db.transaction(STORAGE, 'readwrite');
    const record: StorageRecord = { pluginId: id, key, value, size: JSON.stringify(value).length };
    tx.objectStore(STORAGE).put(record);
    await done(tx);
  }

  async storageDelete(id: string, key: string): Promise<void> {
    const tx = this.db.transaction(STORAGE, 'readwrite');
    tx.objectStore(STORAGE).delete([id, key]);
    await done(tx);
  }

  async storageEntries(id: string): Promise<Array<{ key: string; size: number }>> {
    const tx = this.db.transaction(STORAGE, 'readonly');
    const records = (await request(
      tx.objectStore(STORAGE).index(BY_PLUGIN).getAll(IDBKeyRange.only(id)),
    )) as StorageRecord[];
    return records
      .map((record) => ({ key: record.key, size: record.size }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async storageClear(id: string): Promise<void> {
    const tx = this.db.transaction(STORAGE, 'readwrite');
    tx.objectStore(STORAGE).delete(IDBKeyRange.bound([id, ''], [id, []]));
    await done(tx);
  }

  close(): void {
    this.db.close();
  }
}
