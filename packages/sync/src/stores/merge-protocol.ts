import * as Y from 'yjs';
import { compactUpdates } from './updates';

/** `merge`: `Y.mergeUpdates` (for loading). `compact`: through a scratch doc, which drops deleted content. */
export type MergeKind = 'merge' | 'compact';

export interface MergeRequest {
  id: number;
  kind: MergeKind;
  updates: Uint8Array[];
}

export type MergeResponse =
  { id: number; ok: true; update: Uint8Array } | { id: number; ok: false; message: string };

/** What the merge worker does with one request; the main-thread merger runs the same. */
export function runMerge(kind: MergeKind, updates: readonly Uint8Array[]): Uint8Array {
  return kind === 'compact' ? compactUpdates(updates) : Y.mergeUpdates([...updates]);
}

export function handleMergeRequest(request: MergeRequest): MergeResponse {
  try {
    return { id: request.id, ok: true, update: runMerge(request.kind, request.updates) };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
