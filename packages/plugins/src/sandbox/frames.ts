import { PLUGIN_TIMINGS } from '../constants';
import type { RpcPort } from '../rpc/endpoint';
import { uiCodePreparer, type PrepareKey } from './prepare';
import type { UiInit } from './runtime-ui';
import type { RuntimeInit } from './runtime-kit';
import {
  createNonce,
  uiInnerDocument,
  uiOuterDocument,
  uiRuntimeModuleSource,
  workerFrameDocument,
  workerScriptSource,
} from './sources';

/** Control messages a sandbox frame's bootstrap sends. */
export type ControlMessage =
  | { type: 'started' }
  | { type: 'worker-error'; message: string }
  | { type: 'boot-error'; message: string }
  | { type: 'navigation' };

/** A running sandbox. */
export interface Sandbox {
  /** The RPC port (to the plugin's worker, or to the UI frame's runtime). */
  port: RpcPort;
  frame: HTMLIFrameElement;
  /** Tells a UI frame the app's color scheme (its outer frame's backdrop has to match it). */
  setColorScheme(mode: 'light' | 'dark'): void;
  /** Removes the frame, which terminates its worker and everything in it. */
  destroy(): void;
}

/** Creates sandboxes. The DOM implementation is the only one; tests use an in-process fake. */
export interface SandboxFactory {
  createWorker(options: WorkerSandboxOptions): Promise<Sandbox>;
  createUi(options: UiSandboxOptions): Promise<Sandbox>;
  /** Gets a plugin's UI code ready ahead of time, so its first panel or block opens sooner. */
  prepareUi?(code: string, key: PrepareKey): void;
  /** Drops what was prepared for a plugin (it was uninstalled). */
  forget?(pluginId: string): void;
}

interface CommonOptions {
  code: string;
  /** Allowed network sources (`https://api.example.com`). */
  network: readonly string[];
  onControl(message: ControlMessage): void;
}

export interface WorkerSandboxOptions extends CommonOptions {
  /** Where the hidden frame goes. */
  container: HTMLElement;
  name: string;
  init: RuntimeInit;
}

export interface UiSandboxOptions extends CommonOptions {
  /** Where the frame goes. */
  container: HTMLElement;
  /** A panel or block (`ui`, the default), or the plugin's hidden renderer. */
  kind?: 'ui' | 'renderer';
  /** Accessible name of the frame. */
  title: string;
  init: UiInit;
  /** Identifies the code, so it's prepared once per plugin version rather than once per frame. */
  cacheKey?: PrepareKey;
}

function readControl(data: unknown): ControlMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as { type?: unknown; message?: unknown };
  switch (message.type) {
    case 'started':
    case 'navigation':
      return { type: message.type };
    case 'worker-error':
    case 'boot-error':
      return { type: message.type, message: String(message.message ?? '').slice(0, 2_000) };
    default:
      return null;
  }
}

function newFrame(title: string, kind: 'worker' | 'ui' | 'renderer'): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.setAttribute('data-plugin-frame', kind);
  // Scripts only: no same-origin (opaque origin, no access to the app's storage or DOM), no
  // popups, no forms, no top navigation, no modals.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', title);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  // Powerful features are off for cross-origin frames by default; say so explicitly for the ones
  // every browser knows (unknown names only produce console warnings).
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'");
  return frame;
}

async function start(
  frame: HTMLIFrameElement,
  container: HTMLElement,
  html: string,
  message: Record<string, unknown>,
  onControl: (message: ControlMessage) => void,
): Promise<Sandbox> {
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener('load', () => resolve(), { once: true }),
  );
  frame.srcdoc = html;
  container.append(frame);
  await loaded;
  const rpc = new MessageChannel();
  const control = new MessageChannel();
  control.port1.onmessage = (event) => {
    const parsed = readControl(event.data);
    if (parsed) onControl(parsed);
  };
  // The frame's origin is opaque, so '*' is the only target origin that reaches it; the bootstrap
  // checks that the message comes from this window.
  frame.contentWindow?.postMessage({ type: 'tessera:init', ...message }, '*', [
    rpc.port2,
    control.port2,
  ]);
  let destroyed = false;
  return {
    port: rpc.port1,
    frame,
    setColorScheme(mode) {
      if (!destroyed) control.port1.postMessage({ type: 'color-scheme', mode });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      rpc.port1.close();
      control.port1.close();
      frame.remove();
    },
  };
}

/** Sandboxes as real iframes (browsers and the desktop app). */
export const domSandboxFactory: SandboxFactory = {
  createWorker(options) {
    const nonce = createNonce();
    const frame = newFrame(options.name, 'worker');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'display:none';
    return start(
      frame,
      options.container,
      workerFrameDocument({ nonce, network: options.network }),
      {
        workerSource: workerScriptSource(),
        name: options.name,
        code: options.code,
        init: options.init,
      },
      options.onControl,
    );
  },
  async createUi(options) {
    // UI frames may share the app's thread: their code is instrumented so it can be stopped.
    const prepared = await uiCodePreparer.prepare(options.code, options.cacheKey);
    const nonce = createNonce();
    const kind = options.kind ?? 'ui';
    const frame = newFrame(options.title, kind);
    if (kind === 'renderer') {
      // Out of sight and out of reach (its container keeps it laid out, so text measures).
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
    }
    frame.style.cssText = 'display:block;border:0;width:100%;height:100%;background:transparent';
    const init: UiInit = {
      ...options.init,
      guard: { name: prepared.guard, limitMs: PLUGIN_TIMINGS.frameRunLimitMs },
    };
    return start(
      frame,
      options.container,
      uiOuterDocument({ nonce, network: options.network }),
      {
        innerHtml: uiInnerDocument({ nonce, network: options.network }),
        title: options.title,
        runtimeSource: uiRuntimeModuleSource(),
        code: prepared.code,
        init,
      },
      options.onControl,
    );
  },
  prepareUi(code, key) {
    void uiCodePreparer.warm(code, key);
  },
  forget(pluginId) {
    void uiCodePreparer.forget(pluginId);
    void uiCodePreparer.forget(`${pluginId}/renderer`);
  },
};
