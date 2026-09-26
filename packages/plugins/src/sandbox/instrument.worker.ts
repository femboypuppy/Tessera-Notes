/**
 * Instruments plugin UI code off the main thread (`prepare.ts` sends the code; parsing a large
 * plugin takes seconds).
 */
import { instrumentModule } from './instrument';

export interface InstrumentRequest {
  id: number;
  code: string;
}

export type InstrumentResponse =
  | { id: number; ok: true; code: string; guard: string }
  | { id: number; ok: false; message: string };

interface WorkerScope {
  postMessage(message: InstrumentResponse): void;
  onmessage: ((event: MessageEvent<InstrumentRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, code } = event.data;
  let response: InstrumentResponse;
  try {
    response = { id, ok: true, ...instrumentModule(code) };
  } catch (error) {
    response = { id, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  scope.postMessage(response);
};
