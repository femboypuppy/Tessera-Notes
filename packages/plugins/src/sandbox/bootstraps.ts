/**
 * Scripts that run as the first (and only trusted) code of each sandbox frame. Like the runtime,
 * they are shipped as source text, so each function is self-contained.
 *
 * A bootstrap accepts exactly one init message, and only from its parent window (the host):
 * plugin frames can reach sibling frames through `top.frames`, so `event.source` is checked.
 */

/** Init message of the worker frame. */
export interface WorkerFrameInit {
  type: 'tessera:init';
  /** The classic worker script (runtime included). */
  workerSource: string;
  name: string;
  code: string;
  init: unknown;
}

/**
 * The logic frame: starts the plugin's worker (a classic worker, because Chromium doesn't start
 * module workers from blob URLs in opaque origins) and reports worker errors on the control port.
 * Plugin code never runs on this frame's main thread.
 */
export function workerFrameBootstrap(): void {
  const onInit = (event: MessageEvent) => {
    const data = event.data as Partial<WorkerFrameInit> | null;
    if (event.source !== parent || !data || data.type !== 'tessera:init') return;
    const [rpcPort, controlPort] = event.ports;
    if (!rpcPort || !controlPort) return;
    removeEventListener('message', onInit);
    try {
      const url = URL.createObjectURL(
        new Blob([String(data.workerSource)], { type: 'text/javascript' }),
      );
      const worker = new Worker(url, { name: String(data.name || 'plugin') });
      worker.onerror = (error) => {
        error.preventDefault();
        controlPort.postMessage({
          type: 'worker-error',
          message: String(error.message || 'Worker error'),
        });
      };
      worker.postMessage({ port: rpcPort, code: data.code, init: data.init }, [rpcPort]);
      controlPort.postMessage({ type: 'started' });
    } catch (error) {
      controlPort.postMessage({ type: 'boot-error', message: String(error) });
    }
  };
  addEventListener('message', onInit);
}

/** Init message of a UI frame (panel or block). */
export interface UiFrameInit {
  type: 'tessera:init';
  /** The inner frame's document (its bootstrap carries the same CSP nonce). */
  innerHtml: string;
  title: string;
  runtimeSource: string;
  code: string;
  init: unknown;
}

/**
 * The outer UI frame. It runs no plugin code: it creates the inner frame that does, and its CSP
 * (`frame-src 'none'`) blocks every navigation of that inner frame, so plugin code can't leak data
 * by navigating away. A second load of the inner frame (a blocked navigation) is reported.
 */
export function uiOuterBootstrap(): void {
  const onInit = (event: MessageEvent) => {
    const data = event.data as Partial<UiFrameInit> | null;
    if (event.source !== parent || !data || data.type !== 'tessera:init') return;
    const [rpcPort, controlPort] = event.ports;
    if (!rpcPort || !controlPort) return;
    removeEventListener('message', onInit);
    // Follow the app's color scheme. Browsers paint an opaque backdrop behind a frame whose color
    // scheme differs from its embedder's, which would show at the rounded corners of a block.
    const setColorScheme = (mode: unknown) => {
      if (mode === 'light' || mode === 'dark') document.documentElement.style.colorScheme = mode;
    };
    setColorScheme((data.init as { theme?: { mode?: unknown } } | null | undefined)?.theme?.mode);
    controlPort.onmessage = (message: MessageEvent) => {
      const control = message.data as { type?: unknown; mode?: unknown } | null;
      if (control?.type === 'color-scheme') setColorScheme(control.mode);
    };
    const inner = document.createElement('iframe');
    inner.setAttribute('sandbox', 'allow-scripts');
    inner.setAttribute('title', String(data.title || 'Plugin'));
    inner.setAttribute('referrerpolicy', 'no-referrer');
    inner.style.cssText = 'display:block;border:0;width:100%;height:100%;background:transparent';
    let loads = 0;
    inner.addEventListener('load', () => {
      loads += 1;
      if (loads === 1) {
        inner.contentWindow?.postMessage(
          {
            type: 'tessera:init',
            runtimeSource: data.runtimeSource,
            code: data.code,
            init: data.init,
          },
          '*',
          [rpcPort],
        );
        controlPort.postMessage({ type: 'started' });
      } else {
        controlPort.postMessage({ type: 'navigation' });
      }
    });
    inner.srcdoc = String(data.innerHtml);
    document.body.append(inner);
  };
  addEventListener('message', onInit);
}

/** Loads an ES module from source text (a blob URL). */
export type ModuleLoader = (source: string) => Promise<unknown>;

/**
 * The inner UI frame: loads the UI runtime module, which loads the plugin and renders. `load` is
 * passed in as source text by `sources.ts` (Vite rewrites `import(variable)` in dev, which would
 * break this self-contained function).
 */
export function uiInnerBootstrap(load: ModuleLoader): void {
  // Plugin code runs in this document. The bootstrap and the policy's text carry the app's CSP
  // nonce, so they go before it loads (a removed policy stays in force).
  document.currentScript?.remove();
  document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove();
  const onInit = (event: MessageEvent) => {
    const data = event.data as Partial<UiFrameInit> | null;
    if (event.source !== parent || !data || data.type !== 'tessera:init') return;
    const [port] = event.ports;
    if (!port) return;
    removeEventListener('message', onInit);
    load(String(data.runtimeSource)).then(
      (module) =>
        (module as { default: (env: unknown) => unknown }).default({
          port,
          code: data.code,
          init: data.init,
          importPlugin: load,
          window: self,
          document,
          console: self.console,
          ResizeObserver: self.ResizeObserver,
          FontFace: self.FontFace,
          performance: self.performance,
          MessageChannel: self.MessageChannel,
        }),
      (error: unknown) =>
        port.postMessage({
          v: 1,
          type: 'notify',
          method: 'error',
          params: { message: String(error), fatal: true },
        }),
    );
  };
  addEventListener('message', onInit);
}
