// Installs IDBKeyRange and friends as globals, like a browser.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { manifest } from '../test/fixtures';
import { IndexedDbPluginStore } from './idb-store';
import { MemoryPluginStore } from './memory-store';
import type { InstalledPlugin, PluginStore } from './types';

function record(id: string): InstalledPlugin {
  return {
    id,
    manifest: manifest({ id }),
    enabled: true,
    granted: ['pages:read'],
    source: { kind: 'file', name: `${id}.zip` },
    installedAt: 1,
    updatedAt: 1,
    hash: 'h',
    settings: {},
  };
}

const stores: Array<[string, () => Promise<PluginStore>]> = [
  ['memory', async () => new MemoryPluginStore()],
  ['IndexedDB', () => IndexedDbPluginStore.open(new IDBFactory(), 'test-plugins')],
];

describe.each(stores)('%s plugin store', (_name, open) => {
  it('saves, lists and deletes plugins with their code', async () => {
    const store = await open();
    await store.put(record('a'), { code: 'export default 1', readme: '# A' });
    await store.put(record('b'), { code: 'export default 2', renderer: 'export default 3' });
    expect((await store.list()).map((plugin) => plugin.id).sort()).toEqual(['a', 'b']);
    expect(await store.getCode('a')).toEqual({ code: 'export default 1', readme: '# A' });
    expect(await store.getCode('b')).toEqual({
      code: 'export default 2',
      renderer: 'export default 3',
    });
    await store.put({ ...record('a'), enabled: false });
    expect((await store.get('a'))?.enabled).toBe(false);
    expect((await store.getCode('a'))?.code).toBe('export default 1');
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
    expect(await store.getCode('a')).toBeUndefined();
    store.close();
  });

  it('keeps storage private per plugin and deletes it with the plugin', async () => {
    const store = await open();
    await store.put(record('a'));
    await store.put(record('ab'));
    await store.storageSet('a', 'count', 3);
    await store.storageSet('a', 'list', [1, 2]);
    await store.storageSet('ab', 'count', 99);
    expect(await store.storageGet('a', 'count')).toBe(3);
    expect(await store.storageGet('ab', 'count')).toBe(99);
    expect(await store.storageEntries('a')).toEqual([
      { key: 'count', size: 1 },
      { key: 'list', size: 5 },
    ]);
    await store.storageDelete('a', 'list');
    expect(await store.storageGet('a', 'list')).toBeUndefined();
    await store.delete('a');
    expect(await store.storageEntries('a')).toEqual([]);
    // A plugin whose ID starts with another's keeps its data.
    expect(await store.storageGet('ab', 'count')).toBe(99);
    await store.storageClear('ab');
    expect(await store.storageEntries('ab')).toEqual([]);
    store.close();
  });
});
