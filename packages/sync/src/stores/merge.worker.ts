import { handleMergeRequest, type MergeRequest, type MergeResponse } from './merge-protocol';

/** Merges a doc's stored updates off the main thread (see `merger.ts`). */
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MergeRequest>) => void) | null;
  postMessage(message: MergeResponse, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const response = handleMergeRequest(event.data);
  // The merged bytes move to the main thread instead of being copied.
  if (response.ok) scope.postMessage(response, [response.update.buffer]);
  else scope.postMessage(response);
};
