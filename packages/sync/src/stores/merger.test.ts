import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { handleMergeRequest, type MergeRequest, type MergeResponse } from './merge-protocol';
import { WorkerMerger, type MergeWorkerLike } from './merger';

function textUpdates(...words: string[]): Uint8Array[] {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  for (const word of words) doc.getText('t').insert(doc.getText('t').length, word);
  return updates;
}

function textOf(update: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc.getText('t').toString();
}

/** A worker that answers with the real merge handler a tick later, or fails to load. */
function fakeWorker(behavior: 'answer' | 'fail' = 'answer') {
  const created: Array<MergeWorkerLike & { received: MergeRequest[]; terminated: boolean }> = [];
  const createWorker = () => {
    const worker = {
      onmessage: null as MergeWorkerLike['onmessage'],
      onerror: null as MergeWorkerLike['onerror'],
      received: [] as MergeRequest[],
      terminated: false,
      postMessage(message: MergeRequest) {
        worker.received.push(message);
        setTimeout(() => {
          if (worker.terminated) return;
          if (behavior === 'fail') {
            worker.onerror?.({ preventDefault() {}, message: 'failed to load' } as ErrorEvent);
            return;
          }
          const response: MergeResponse = handleMergeRequest(message);
          worker.onmessage?.({ data: response } as MessageEvent<MergeResponse>);
        }, 0);
      },
      terminate() {
        worker.terminated = true;
      },
    };
    created.push(worker);
    return worker;
  };
  return { created, createWorker };
}

afterEach(() => vi.useRealTimers());

describe('WorkerMerger', () => {
  it('merges and compacts in the worker, and stops it when idle', async () => {
    vi.useFakeTimers();
    const { created, createWorker } = fakeWorker();
    const merger = new WorkerMerger({ createWorker, idleMs: 1000 });
    const updates = textUpdates('Launch ', 'plan');
    const merged = merger.merge(updates);
    const compacted = merger.compact(updates);
    await vi.advanceTimersByTimeAsync(1);
    expect(textOf(await merged)).toBe('Launch plan');
    expect(textOf(await compacted)).toBe('Launch plan');
    expect(created).toHaveLength(1);
    expect(created[0]?.received.map((request) => request.kind)).toEqual(['merge', 'compact']);
    expect(created[0]?.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(created[0]?.terminated).toBe(true);
    // The next request starts a new worker.
    const again = merger.merge(updates);
    await vi.advanceTimersByTimeAsync(1);
    expect(textOf(await again)).toBe('Launch plan');
    expect(created).toHaveLength(2);
    merger.dispose();
  });

  it('rejects a corrupt update from the worker', async () => {
    const { createWorker } = fakeWorker();
    const merger = new WorkerMerger({ createWorker });
    // Two updates: `Y.mergeUpdates` returns a single one as it is, without reading it (the store
    // only merges two or more).
    const corrupt = [...textUpdates('fine'), new Uint8Array([0xff, 0xff, 0xff, 0xff])];
    await expect(merger.merge(corrupt)).rejects.toThrow();
    merger.dispose();
  });

  it('merges on the main thread when the worker cannot load, then and afterwards', async () => {
    const { created, createWorker } = fakeWorker('fail');
    const merger = new WorkerMerger({ createWorker });
    const updates = textUpdates('Count', 'down');
    expect(textOf(await merger.merge(updates))).toBe('Countdown');
    expect(created[0]?.terminated).toBe(true);
    expect(textOf(await merger.compact(updates))).toBe('Countdown');
    expect(created).toHaveLength(1);
    merger.dispose();
  });

  it('merges on the main thread where no worker can start', async () => {
    const merger = new WorkerMerger({ createWorker: () => null });
    expect(textOf(await merger.merge(textUpdates('a', 'b')))).toBe('ab');
    merger.dispose();
  });

  it('rejects what is still waiting when disposed, and everything after', async () => {
    const { createWorker } = fakeWorker();
    const merger = new WorkerMerger({ createWorker });
    const waiting = merger.merge(textUpdates('x', 'y'));
    merger.dispose();
    await expect(waiting).rejects.toThrow(/closed/);
    await expect(merger.compact(textUpdates('z'))).rejects.toThrow(/closed/);
  });
});
