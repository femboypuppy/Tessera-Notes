import 'fake-indexeddb/auto';
import {
  build,
  DocManager,
  getPageContent,
  LocalSyncProvider,
  readDocJSON,
  writeDocJSON,
} from '@tessera/core';
import { kitchenSinkDoc } from '@tessera/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { ChannelLike } from '../idb/channel';
import { createChannelHub } from '../testing/channels';
import { IndexedDbDocStore } from './doc-store';
import type { StorageErrorInfo } from './storage-errors';

const stores: IndexedDbDocStore[] = [];

async function openStore(
  factory: IDBFactory,
  options: Parameters<typeof IndexedDbDocStore.open>[1] = {},
): Promise<IndexedDbDocStore> {
  const store = await IndexedDbDocStore.open('ws1', {
    indexedDB: factory,
    channel: null,
    ...options,
  });
  stores.push(store);
  return store;
}

function textUpdate(doc: Y.Doc, text: string, index = 0): Uint8Array {
  let captured: Uint8Array | null = null;
  const capture = (update: Uint8Array) => {
    captured = update;
  };
  doc.on('update', capture);
  doc.getText('t').insert(Math.min(index, doc.getText('t').length), text);
  doc.off('update', capture);
  if (!captured) throw new Error('no update');
  return captured;
}

function docFrom(update: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc();
  if (update) Y.applyUpdate(doc, update);
  return doc;
}

/**
 * Slow disks: readwrite transactions commit, but their `complete` event (what makes a write
 * durable for the store) waits until `release()`.
 */
function slowCommits(): { release(): void } {
  const held: Array<() => void> = [];
  let holding = true;
  const transaction = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase['transaction']>
  ) {
    const created = transaction.apply(this, args);
    if (args[1] !== 'readwrite') return created;
    let oncomplete: IDBTransaction['oncomplete'] = null;
    Object.defineProperty(created, 'oncomplete', {
      configurable: true,
      get: () => null,
      set: (handler: IDBTransaction['oncomplete']) => {
        oncomplete = handler;
      },
    });
    created.addEventListener('complete', (event) => {
      const fire = () => oncomplete?.call(created, event);
      if (holding) held.push(fire);
      else fire();
    });
    return created;
  });
  return {
    release() {
      holding = false;
      for (const fire of held.splice(0)) fire();
    },
  };
}

/** The workspace channel of a tab the test plays itself. */
function otherTab(channels: ReturnType<typeof createChannelHub>): ChannelLike {
  const channel = channels('tessera:docs:ws1');
  if (!channel) throw new Error('no channel');
  return channel;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
  vi.restoreAllMocks();
});

describe('IndexedDbDocStore', () => {
  it('stores updates and loads them merged, and null for unknown docs', async () => {
    const store = await openStore(new IDBFactory());
    const source = new Y.Doc();
    await store.storeUpdate('page:a', textUpdate(source, 'Hello'));
    await store.storeUpdate('page:a', textUpdate(source, ' world', 5));
    expect(await store.load('page:missing')).toBeNull();
    const loaded = docFrom(await store.load('page:a'));
    expect(loaded.getText('t').toString()).toBe('Hello world');
    expect(await store.updateCount('page:a')).toBe(2);
  });

  it('survives a reload and a crash (a second instance sees every resolved write)', async () => {
    const factory = new IDBFactory();
    const first = await openStore(factory);
    const source = new Y.Doc();
    for (const word of ['one ', 'two ', 'three']) {
      await first.storeUpdate('page:a', textUpdate(source, word, source.getText('t').length));
    }
    // No dispose: the "tab" crashed. A new tab opens the same database.
    const second = await openStore(factory);
    expect(
      docFrom(await second.load('page:a'))
        .getText('t')
        .toString(),
    ).toBe('one two three');
    await first.dispose();
    const third = await openStore(factory);
    expect(
      docFrom(await third.load('page:a'))
        .getText('t')
        .toString(),
    ).toBe('one two three');
  });

  it('group-commits updates stored in the same tick', async () => {
    const store = await openStore(new IDBFactory());
    const source = new Y.Doc();
    const writes = Array.from({ length: 50 }, (_, i) =>
      store.storeUpdate('page:a', textUpdate(source, `${i},`, source.getText('t').length)),
    );
    await Promise.all(writes);
    const expected = source.getText('t').toString();
    expect(
      docFrom(await store.load('page:a'))
        .getText('t')
        .toString(),
    ).toBe(expected);
  });

  it('compaction preserves content exactly', async () => {
    const store = await openStore(new IDBFactory());
    const source = new Y.Doc();
    source.on('update', (update: Uint8Array) => void store.storeUpdate('page:k', update));
    writeDocJSON(source, kitchenSinkDoc());
    source.getMap('props').set('tags', ['space', 'moon']);
    source.getText('t').insert(0, 'abcdef');
    source.getText('t').delete(1, 3);
    writeDocJSON(source, build.doc(build.p('Replaced'), build.heading(2, 'Heading')));
    writeDocJSON(source, kitchenSinkDoc());
    await store.flush();
    const before = await store.updateCount('page:k');
    expect(before).toBeGreaterThan(3);

    await store.compact('page:k');
    expect(await store.updateCount('page:k')).toBe(1);
    const compacted = docFrom(await store.load('page:k'));
    expect(readDocJSON(compacted)).toEqual(readDocJSON(source));
    expect(compacted.getText('t').toString()).toBe('aef');
    expect(compacted.getMap('props').toJSON()).toEqual({ tags: ['space', 'moon'] });
    expect(Y.encodeStateVector(compacted)).toEqual(Y.encodeStateVector(source));
    // Further edits on top of the compacted state still merge.
    const next = textUpdate(source, 'Z', 0);
    await store.storeUpdate('page:k', next);
    expect(
      docFrom(await store.load('page:k'))
        .getText('t')
        .toString(),
    ).toBe('Zaef');
  });

  it('compaction never loses updates written concurrently from two tabs', async () => {
    const factory = new IDBFactory();
    const tabA = await openStore(factory);
    const tabB = await openStore(factory);
    const reference = new Y.Doc();
    const clients = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    const pending: Promise<void>[] = [];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 300; round += 1) {
      const client = clients[round % clients.length];
      if (!client) continue;
      const update = textUpdate(client, `${round};`, Math.floor(random() * 5));
      Y.applyUpdate(reference, update);
      const tab = random() < 0.5 ? tabA : tabB;
      pending.push(tab.storeUpdate('page:race', update));
      if (round % 17 === 0) pending.push(tabA.compact('page:race'));
      if (round % 23 === 0) pending.push(tabB.compact('page:race'));
      if (round % 40 === 0) await Promise.resolve();
    }
    await Promise.all(pending);
    await tabA.compact('page:race');
    const loaded = docFrom(await tabB.load('page:race'));
    expect(loaded.getText('t').toString()).toBe(reference.getText('t').toString());
    expect(Y.encodeStateVector(loaded)).toEqual(Y.encodeStateVector(reference));
  });

  it('compacts busy docs in the background past a threshold', async () => {
    const store = await openStore(new IDBFactory(), { compactThreshold: 10, compactDelayMs: 5 });
    const source = new Y.Doc();
    for (let i = 0; i < 12; i += 1) {
      await store.storeUpdate('page:busy', textUpdate(source, 'x'));
    }
    await vi.waitFor(async () => expect(await store.updateCount('page:busy')).toBe(1));
    expect(
      docFrom(await store.load('page:busy'))
        .getText('t')
        .toString(),
    ).toBe('x'.repeat(12));
  });

  it('deletes docs and lists them by prefix', async () => {
    const store = await openStore(new IDBFactory());
    const source = new Y.Doc();
    await store.storeUpdate('page:b', textUpdate(source, 'b'));
    await store.storeUpdate('page:a', textUpdate(source, 'a'));
    await store.storeUpdate('db:c', textUpdate(source, 'c'));
    await store.storeUpdate('ws:w', textUpdate(source, 'w'));
    expect(await store.list()).toEqual(['db:c', 'page:a', 'page:b', 'ws:w']);
    expect(await store.list('page:')).toEqual(['page:a', 'page:b']);
    await store.delete('page:a');
    expect(await store.list('page:')).toEqual(['page:b']);
    expect(await store.load('page:a')).toBeNull();
  });

  it('lands queued writes before a delete, so nothing resurrects the doc', async () => {
    const store = await openStore(new IDBFactory());
    const source = new Y.Doc();
    void store.storeUpdate('page:gone', textUpdate(source, 'late'));
    await store.delete('page:gone');
    expect(await store.load('page:gone')).toBeNull();
  });

  it('dispose waits for pending writes', async () => {
    const factory = new IDBFactory();
    const store = await IndexedDbDocStore.open('ws1', { indexedDB: factory, channel: null });
    const source = new Y.Doc();
    const write = store.storeUpdate('page:a', textUpdate(source, 'kept'));
    await store.dispose();
    await write;
    const reopened = await openStore(factory);
    expect(
      docFrom(await reopened.load('page:a'))
        .getText('t')
        .toString(),
    ).toBe('kept');
    await expect(store.storeUpdate('page:a', new Uint8Array())).rejects.toThrow(/closed/);
  });

  it('reports a full disk, rejects the write and keeps working once space frees up', async () => {
    const store = await openStore(new IDBFactory());
    const errors: StorageErrorInfo[] = [];
    store.onStorageError((info) => errors.push(info));
    const original = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const source = new Y.Doc();
    await expect(store.storeUpdate('page:a', textUpdate(source, 'first'))).rejects.toThrow(
      /quota/i,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('quota');
    expect(store.storageError()?.kind).toBe('quota');
    spy.mockImplementation(original);
    await store.storeUpdate('page:a', Y.encodeStateAsUpdate(source));
    expect(store.storageError()).toBeNull();
    expect(
      docFrom(await store.load('page:a'))
        .getText('t')
        .toString(),
    ).toBe('first');
  });

  it('with the runtime DocManager, a failed write is retried until it is durable', async () => {
    const factory = new IDBFactory();
    const store = await openStore(factory);
    const manager = new DocManager({
      docStore: store,
      syncProvider: new LocalSyncProvider(),
      releaseDelayMs: 0,
      onError: () => undefined,
    });
    const handle = await manager.load('page:retry');
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    handle.doc.getText('t').insert(0, 'precious');
    await vi.waitFor(() => expect(store.storageError()?.kind).toBe('quota'));
    spy.mockRestore();
    handle.doc.getText('t').insert(8, '!');
    await manager.flush();
    handle.release();
    await manager.dispose();
    const reopened = await openStore(factory);
    expect(
      docFrom(await reopened.load('page:retry'))
        .getText('t')
        .toString(),
    ).toBe('precious!');
  });
});

describe('IndexedDbDocStore across tabs', () => {
  async function twoTabs() {
    const factory = new IDBFactory();
    const channels = createChannelHub();
    const tabA = await openStore(factory, { channel: channels });
    const tabB = await openStore(factory, { channel: channels });
    return { factory, channels, tabA, tabB };
  }

  it('delivers committed writes to watchers in other tabs, never to the writer', async () => {
    const { channels, tabA, tabB } = await twoTabs();
    const seenByA: Uint8Array[] = [];
    const seenByB: Uint8Array[] = [];
    tabA.watch('page:a', (update) => seenByA.push(update));
    tabB.watch('page:a', (update) => seenByB.push(update));
    const source = new Y.Doc();
    await tabA.storeUpdate('page:a', textUpdate(source, 'hi'));
    await channels.pending();
    expect(seenByA).toHaveLength(0);
    expect(seenByB).toHaveLength(1);
    expect(
      docFrom(seenByB[0] ?? null)
        .getText('t')
        .toString(),
    ).toBe('hi');
  });

  it('keeps two tabs of a workspace in sync through the DocManager with no duplicate writes', async () => {
    const { channels, tabA, tabB } = await twoTabs();
    const managerA = new DocManager({ docStore: tabA, syncProvider: new LocalSyncProvider() });
    const managerB = new DocManager({ docStore: tabB, syncProvider: new LocalSyncProvider() });
    const a = await managerA.load('page:shared');
    const b = await managerB.load('page:shared');
    writeDocJSON(a.doc, build.doc(build.p('Written in tab A')));
    await managerA.flush();
    await channels.pending();
    expect(readDocJSON(b.doc)).toEqual(readDocJSON(a.doc));
    getPageContent(b.doc).insert(0, [new Y.XmlElement('paragraph')]);
    await managerB.flush();
    await channels.pending();
    expect(readDocJSON(a.doc)).toEqual(readDocJSON(b.doc));
    await managerA.flush();
    await managerB.flush();
    // One stored update per edit: tab B never re-stored tab A's update and vice versa.
    expect(await tabA.updateCount('page:shared')).toBe(2);
    a.release();
    b.release();
    await managerA.dispose();
    await managerB.dispose();
  });

  it('replays updates that arrive between load and watch', async () => {
    const { channels, tabA, tabB } = await twoTabs();
    const source = new Y.Doc();
    await tabA.storeUpdate('page:a', textUpdate(source, 'base'));
    const loaded = docFrom(await tabB.load('page:a'));
    // Another tab writes after tab B read the doc but before it started watching.
    await tabA.storeUpdate('page:a', textUpdate(source, '+more', 4));
    await channels.pending();
    tabB.watch('page:a', (update) => Y.applyUpdate(loaded, update));
    expect(loaded.getText('t').toString()).toBe('base+more');
  });

  it('delivers a write to other tabs before it is durable', async () => {
    const { tabA, tabB } = await twoTabs();
    const seenByB: Uint8Array[] = [];
    tabB.watch('page:a', (update) => seenByB.push(update));
    const commits = slowCommits();
    let durable = false;
    const write = tabA.storeUpdate('page:a', textUpdate(new Y.Doc(), 'hi')).then(() => {
      durable = true;
    });
    try {
      await vi.waitFor(() => expect(seenByB).toHaveLength(1));
      expect(durable).toBe(false);
    } finally {
      commits.release();
    }
    await write;
    expect(await tabB.updateCount('page:a')).toBe(1);
  });

  it('stores a write that another tab announced but closed before storing', async () => {
    const factory = new IDBFactory();
    const channels = createChannelHub();
    const tabB = await openStore(factory, { channel: channels, adoptAfterMs: 20 });
    const seen: Uint8Array[] = [];
    tabB.watch('page:a', (update) => seen.push(update));
    otherTab(channels).postMessage({
      v: 1,
      type: 'updates',
      source: 'closed-tab',
      seq: 1,
      items: [{ doc: 'page:a', update: textUpdate(new Y.Doc(), 'last words') }],
    });
    await channels.pending();
    expect(seen).toHaveLength(1);
    await vi.waitFor(async () => expect(await tabB.updateCount('page:a')).toBe(1));
    const reopened = await openStore(factory);
    expect(
      docFrom(await reopened.load('page:a'))
        .getText('t')
        .toString(),
    ).toBe('last words');
  });

  it('stores the writes its own edits build on while their tab has not', async () => {
    const factory = new IDBFactory();
    const channels = createChannelHub();
    const tabB = await openStore(factory, { channel: channels, adoptAfterMs: 60_000 });
    const source = new Y.Doc();
    otherTab(channels).postMessage({
      v: 1,
      type: 'updates',
      source: 'closed-tab',
      seq: 1,
      items: [{ doc: 'page:a', update: textUpdate(source, 'Hello') }],
    });
    await channels.pending();
    // Tab B's edit only makes sense after the one it saw.
    await tabB.storeUpdate('page:a', textUpdate(source, ' world', 5));
    const reopened = await openStore(factory);
    expect(
      docFrom(await reopened.load('page:a'))
        .getText('t')
        .toString(),
    ).toBe('Hello world');
  });

  it('never stores a write twice once the tab that wrote it confirms it', async () => {
    const factory = new IDBFactory();
    const channels = createChannelHub();
    const tabA = await openStore(factory, { channel: channels });
    const tabB = await openStore(factory, { channel: channels, adoptAfterMs: 300 });
    tabB.watch('page:a', () => undefined);
    const source = new Y.Doc();
    await tabA.storeUpdate('page:a', textUpdate(source, 'once'));
    await channels.pending();
    // Tab B edits the same doc once the write is confirmed, and waits past its patience.
    await tabB.storeUpdate('page:a', textUpdate(source, '!', 4));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await tabB.flush();
    expect(await tabA.updateCount('page:a')).toBe(2);
  });

  it('loads the writes another tab announced and has not stored yet', async () => {
    const factory = new IDBFactory();
    const channels = createChannelHub();
    const tabB = await openStore(factory, { channel: channels, adoptAfterMs: 60_000 });
    otherTab(channels).postMessage({
      v: 1,
      type: 'updates',
      source: 'busy-tab',
      seq: 1,
      items: [{ doc: 'page:a', update: textUpdate(new Y.Doc(), 'in flight') }],
    });
    await channels.pending();
    // Nothing watched the doc when the write arrived, and the store doesn't have it yet.
    const loaded = docFrom(await tabB.load('page:a'));
    tabB.watch('page:a', (update) => Y.applyUpdate(loaded, update));
    expect(loaded.getText('t').toString()).toBe('in flight');
  });

  it('applies writes from tabs of earlier versions, which announce them once durable', async () => {
    const factory = new IDBFactory();
    const channels = createChannelHub();
    const tabB = await openStore(factory, { channel: channels, adoptAfterMs: 10 });
    const seen: Uint8Array[] = [];
    tabB.watch('page:a', (update) => seen.push(update));
    otherTab(channels).postMessage({
      v: 1,
      type: 'updates',
      source: 'older-tab',
      items: [{ doc: 'page:a', update: textUpdate(new Y.Doc(), 'stored') }],
    });
    await channels.pending();
    expect(seen).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await tabB.updateCount('page:a')).toBe(0);
  });
});
