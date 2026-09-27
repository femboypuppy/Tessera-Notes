// Installs IDBKeyRange and friends as globals, like a browser.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { UiCodePreparer, workerInstrument, type Instrument } from './prepare';

/** Stands in for the instrumenter: records what it was asked, and fails on "broken". */
function fakeInstrument() {
  const calls: string[] = [];
  const instrument: Instrument = async (code) => {
    calls.push(code);
    if (code === 'broken') throw new Error('Unexpected token (1:3)');
    return { code: `guarded(${code})`, guard: '$$tg' };
  };
  return { calls, instrument };
}

describe('UiCodePreparer', () => {
  it('prepares each version once, and remembers it across sessions', async () => {
    const indexedDB = new IDBFactory();
    const first = fakeInstrument();
    const preparer = new UiCodePreparer({ instrument: first.instrument, indexedDB });
    const key = { slot: 'mermaid', hash: 'v1' };
    const [a, b] = await Promise.all([
      preparer.prepare('code', key),
      preparer.prepare('code', key),
    ]);
    expect(a).toEqual({ code: 'guarded(code)', guard: '$$tg' });
    expect(b).toBe(a);
    expect(first.calls).toEqual(['code']);

    // The next session reads it back instead of parsing again.
    const second = fakeInstrument();
    const later = new UiCodePreparer({ instrument: second.instrument, indexedDB });
    await expect(later.prepare('code', key)).resolves.toEqual(a);
    expect(second.calls).toEqual([]);
  });

  it('replaces the prepared code of an older version, and forgets a plugin', async () => {
    const indexedDB = new IDBFactory();
    const { calls, instrument } = fakeInstrument();
    const preparer = new UiCodePreparer({ instrument, indexedDB });
    await preparer.prepare('one', { slot: 'p', hash: 'v1' });
    await preparer.prepare('two', { slot: 'p', hash: 'v2' });
    await preparer.prepare('other', { slot: 'q', hash: 'v1' });
    const fresh = fakeInstrument();
    const later = new UiCodePreparer({ instrument: fresh.instrument, indexedDB });
    // v1 of "p" was replaced by v2, so it's prepared again; "q" is still there.
    await later.prepare('one', { slot: 'p', hash: 'v1' });
    await later.prepare('other', { slot: 'q', hash: 'v1' });
    expect(fresh.calls).toEqual(['one']);
    await later.forget('q');
    await later.prepare('other', { slot: 'q', hash: 'v1' });
    expect(fresh.calls).toEqual(['one', 'other']);
    expect(calls).toEqual(['one', 'two', 'other']);
  });

  it('says why code can’t be read, and tries again next time', async () => {
    const { calls, instrument } = fakeInstrument();
    const preparer = new UiCodePreparer({ instrument, indexedDB: new IDBFactory() });
    const key = { slot: 'p', hash: 'v1' };
    await expect(preparer.prepare('broken', key)).rejects.toThrow(
      'Tessera couldn’t read the plugin’s code: Unexpected token (1:3)',
    );
    await expect(preparer.prepare('broken', key)).rejects.toThrow();
    expect(calls).toEqual(['broken', 'broken']);
  });

  it('warms only what isn’t ready, without loading what was stored', async () => {
    const indexedDB = new IDBFactory();
    const { calls, instrument } = fakeInstrument();
    const preparer = new UiCodePreparer({ instrument, indexedDB });
    const key = { slot: 'p', hash: 'v1' };
    await preparer.warm('code', key);
    await preparer.warm('code', key);
    expect(calls).toEqual(['code']);
    const later = new UiCodePreparer({ instrument, indexedDB });
    const prepare = vi.spyOn(later, 'prepare');
    await later.warm('code', key);
    expect(prepare).not.toHaveBeenCalled();
    // A failure waits for the frame that needs the code, which shows it.
    await expect(later.warm('broken', { slot: 'b', hash: 'v1' })).resolves.toBeUndefined();
  });

  it('works without IndexedDB, and without a key (nothing is kept)', async () => {
    const { calls, instrument } = fakeInstrument();
    const preparer = new UiCodePreparer({ instrument, indexedDB: null });
    await preparer.prepare('code', { slot: 'p', hash: 'v1' });
    await preparer.prepare('code', { slot: 'p', hash: 'v1' });
    await preparer.prepare('loose');
    await preparer.prepare('loose');
    expect(calls).toEqual(['code', 'loose', 'loose']);
  });

  it('keeps a few plugins in memory, most recently used last', async () => {
    const { calls, instrument } = fakeInstrument();
    const preparer = new UiCodePreparer({ instrument, indexedDB: null, memoryEntries: 2 });
    await preparer.prepare('a', { slot: 'a', hash: '1' });
    await preparer.prepare('b', { slot: 'b', hash: '1' });
    await preparer.prepare('a', { slot: 'a', hash: '1' });
    await preparer.prepare('c', { slot: 'c', hash: '1' });
    // "b" was the least recently used.
    await preparer.prepare('a', { slot: 'a', hash: '1' });
    await preparer.prepare('b', { slot: 'b', hash: '1' });
    expect(calls).toEqual(['a', 'b', 'c', 'b']);
  });
});

describe('workerInstrument', () => {
  it('instruments on this thread where there are no workers', async () => {
    expect(typeof Worker).toBe('undefined');
    const result = await workerInstrument()('while (true) {}');
    expect(result).toEqual({ code: '$$tg();while (true) {$$tg();}', guard: '$$tg' });
  });
});
