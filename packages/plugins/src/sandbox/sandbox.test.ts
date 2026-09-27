import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { uiInnerBootstrap, uiOuterBootstrap, workerFrameBootstrap } from './bootstraps';
import { createRuntimeKit, type RuntimeInit, type RuntimeKit } from './runtime-kit';
import { LOCKED_SCRIPTS_CSP, runUi, type UiEnv } from './runtime-ui';
import { runWorker } from './runtime-worker';
import {
  appCspNonce,
  buildCsp,
  createNonce,
  sandboxDocument,
  uiInnerDocument,
  uiOuterDocument,
  uiRuntimeModuleSource,
  workerFrameDocument,
  workerScriptSource,
} from './sources';

const init: RuntimeInit = {
  plugin: { id: 'p', name: 'P', version: '1.0.0', apiVersion: 1, permissions: [] },
  settings: {},
  theme: { mode: 'dark', reducedMotion: false, tokens: { bg: '#000' } },
};

/** A fresh JavaScript realm with only the globals a sandbox has (no module scope of this file). */
function realm(globals: Record<string, unknown> = {}) {
  const context = vm.createContext({
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout,
    clearTimeout,
    ...globals,
  });
  return context;
}

function evaluate<T>(source: string, context: vm.Context): T {
  return vm.runInContext(`(${source})`, context) as T;
}

function messages(port: MessagePort) {
  const received: Array<Record<string, unknown>> = [];
  port.onmessage = (event: MessageEvent) => received.push(event.data as Record<string, unknown>);
  return received;
}

describe('sandbox sources are self-contained', () => {
  it.each([
    ['createRuntimeKit', createRuntimeKit],
    ['runWorker', runWorker],
    ['runUi', runUi],
    ['workerFrameBootstrap', workerFrameBootstrap],
    ['uiOuterBootstrap', uiOuterBootstrap],
    ['uiInnerBootstrap', uiInnerBootstrap],
  ])('%s has no import or bundler references', (_name, fn) => {
    const source = fn.toString();
    expect(source).not.toMatch(/__vite|__vi_|require\(|import\(|import\.meta/);
    expect(() => evaluate(source, realm())).not.toThrow();
  });

  it('runs the worker script in a fresh realm: it answers pings and reports a failed load', async () => {
    const context = realm({
      URL: { createObjectURL: () => 'blob:null/1', revokeObjectURL: () => undefined },
      Blob: class {},
    });
    context.self = context;
    context.addEventListener = () => undefined;
    vm.runInContext(workerScriptSource(), context);
    const channel = new MessageChannel();
    const received = messages(channel.port1);
    (context.onmessage as (event: { data: unknown }) => void)({
      data: { port: channel.port2, code: 'export default {}', init },
    });
    expect(context.onmessage).toBeNull();
    // A vm realm can't import(), so loading fails: the runtime says so instead of crashing.
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({
          type: 'notify',
          method: 'error',
          params: expect.objectContaining({ fatal: true }),
        }),
      ),
    );
    channel.port1.postMessage({ v: 1, type: 'request', id: 1, method: 'ping' });
    await vi.waitFor(() =>
      expect(received).toContainEqual({ v: 1, type: 'response', id: 1, ok: true, result: 'pong' }),
    );
    channel.port1.close();
  });

  it('runs the worker runtime from a fresh realm through a whole lifecycle', async () => {
    const context = realm();
    const kit = evaluate<() => RuntimeKit>(createRuntimeKit.toString(), context)();
    const run = evaluate<typeof runWorker>(runWorker.toString(), context);
    const channel = new MessageChannel();
    const received = messages(channel.port1);
    const activate = vi.fn();
    const hello = vi.fn();
    void run(
      {
        port: channel.port2,
        code: '',
        init,
        importPlugin: async () => ({
          default: {
            __tesseraPlugin: 1,
            settings: { n: { type: 'number', label: 'N', default: 1 } },
            activate() {
              activate();
            },
            panels: { side: () => undefined },
          },
        }),
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        global: { addEventListener: () => undefined },
      },
      kit,
    );
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({
          method: 'ready',
          params: {
            panels: ['side'],
            blocks: [],
            activate: true,
            settings: { n: { type: 'number', label: 'N', default: 1 } },
          },
        }),
      ),
    );
    channel.port1.postMessage({ v: 1, type: 'request', id: 2, method: 'activate' });
    await vi.waitFor(() => expect(activate).toHaveBeenCalled());
    channel.port1.postMessage({
      v: 1,
      type: 'request',
      id: 3,
      method: 'command.run',
      params: { id: 'nope' },
    });
    await vi.waitFor(() =>
      expect(received).toContainEqual(expect.objectContaining({ id: 3, ok: false })),
    );
    expect(hello).not.toHaveBeenCalled();
    channel.port1.close();
  });

  it('runs the UI runtime from a fresh realm and renders with the theme', async () => {
    const context = realm();
    const kit = evaluate<() => RuntimeKit>(createRuntimeKit.toString(), context)();
    const run = evaluate<typeof runUi>(runUi.toString(), context);
    const channel = new MessageChannel();
    const received = messages(channel.port1);
    const doc = document.implementation.createHTMLDocument('frame');
    const env: UiEnv = {
      port: channel.port2,
      code: '',
      init: { ...init, surface: { kind: 'panel', id: 'side', pageId: 'page-1' }, fonts: [] },
      importPlugin: async () => ({
        default: {
          __tesseraPlugin: 1,
          panels: {
            side(ctx: { root: HTMLElement; pageId: string | null }) {
              ctx.root.textContent = `Page ${ctx.pageId}`;
            },
          },
        },
      }),
      window: { addEventListener: () => undefined },
      document: doc,
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      ResizeObserver: globalThis.ResizeObserver,
      FontFace: class {} as unknown as typeof FontFace,
      performance: globalThis.performance,
      MessageChannel: globalThis.MessageChannel,
    };
    await run(env, kit);
    expect(doc.getElementById('root')?.textContent).toBe('Page page-1');
    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(doc.documentElement.getAttribute('data-surface')).toBe('panel');
    expect(doc.documentElement.style.getPropertyValue('--tess-bg')).toBe('#000');
    expect(doc.head.querySelector('style')?.textContent).toContain(':where(button)');
    await vi.waitFor(() =>
      expect(received).toContainEqual(expect.objectContaining({ method: 'rendered' })),
    );
    channel.port1.close();
  });
});

describe('the renderer frame', () => {
  it('runs from a fresh realm: loads the renderer module and answers render requests with JSON', async () => {
    const context = realm();
    const kit = evaluate<() => RuntimeKit>(createRuntimeKit.toString(), context)();
    const run = evaluate<typeof runUi>(runUi.toString(), context);
    const channel = new MessageChannel();
    const received = messages(channel.port1);
    const env: UiEnv = {
      port: channel.port2,
      code: '',
      init: { ...init, surface: { kind: 'renderer' }, fonts: [] },
      importPlugin: async () => ({
        default: {
          __tesseraRenderer: 1,
          renderers: {
            size: (input: { text: string }) => ({ width: input.text.length * 7 }),
            later: async () => ({ at: new Date(0) }),
            broken: () => () => undefined,
          },
        },
      }),
      window: { addEventListener: () => undefined },
      document: document.implementation.createHTMLDocument('renderer'),
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      ResizeObserver: globalThis.ResizeObserver,
      FontFace: class {} as unknown as typeof FontFace,
      performance: globalThis.performance,
      MessageChannel: globalThis.MessageChannel,
    };
    await run(env, kit);
    await vi.waitFor(() =>
      expect(received).toContainEqual(expect.objectContaining({ method: 'rendered' })),
    );
    const ask = (id: number, params: unknown) =>
      channel.port1.postMessage({ v: 1, type: 'request', id, method: 'render', params });
    ask(1, { name: 'size', input: { text: 'abc' } });
    ask(2, { name: 'later' });
    ask(3, { name: 'broken' });
    ask(4, { name: 'toString' });
    await vi.waitFor(() =>
      expect(received.filter((message) => message.type === 'response')).toHaveLength(4),
    );
    expect(received).toContainEqual({
      v: 1,
      type: 'response',
      id: 1,
      ok: true,
      result: { width: 21 },
    });
    // Results go back as JSON, like everything else that leaves the sandbox.
    expect(received).toContainEqual({
      v: 1,
      type: 'response',
      id: 2,
      ok: true,
      result: { at: '1970-01-01T00:00:00.000Z' },
    });
    expect(received).toContainEqual(
      expect.objectContaining({
        id: 3,
        ok: false,
        error: expect.objectContaining({
          message: 'Render function "broken" must return JSON.',
        }) as unknown,
      }),
    );
    // Only its own functions: nothing inherited from Object.prototype.
    expect(received).toContainEqual(
      expect.objectContaining({
        id: 4,
        ok: false,
        error: expect.objectContaining({
          message: 'The renderer has no function "toString".',
        }) as unknown,
      }),
    );
    channel.port1.close();
  });

  it('says what is wrong with a module that isn’t a renderer', async () => {
    const kit = createRuntimeKit();
    expect(() => kit.readRenderer({ default: { renderers: { a: () => 1 } } })).toThrow(
      "The renderer's code doesn't export a renderer. Its default export should be defineRenderer({ … }).",
    );
    expect(() =>
      kit.readRenderer({ default: { __tesseraRenderer: 1, renderers: { a: 1 } } }),
    ).toThrow();
    expect(
      Object.keys(
        kit.readRenderer({ default: { __tesseraRenderer: 1, renderers: { a: () => 1 } } }),
      ),
    ).toEqual(['a']);
  });
});

describe('the guard of instrumented UI code', () => {
  it('locks scripts on its first call, stops a run that takes too long, and stays stopped', () => {
    const kit = evaluate<() => RuntimeKit>(createRuntimeKit.toString(), realm())();
    const target = {};
    let time = 0;
    const turns: Array<() => void> = [];
    const onFirstRun = vi.fn();
    const onStall = vi.fn();
    kit.installGuard({
      target,
      name: 'guard',
      limitMs: 100,
      now: () => time,
      afterTask: (callback) => turns.push(callback),
      onFirstRun,
      onStall,
    });
    expect(Object.getOwnPropertyDescriptor(target, 'guard')).toMatchObject({
      writable: false,
      configurable: false,
      enumerable: false,
    });
    const guard = (target as { guard: () => void }).guard;
    guard();
    expect(onFirstRun).toHaveBeenCalledOnce();
    // 90 ms of work, then the event loop turns: a new run starts from zero.
    for (let call = 0; call < 90; call += 1) {
      time += 1;
      guard();
    }
    turns.splice(0).forEach((turn) => turn());
    guard();
    for (let call = 0; call < 90; call += 1) {
      time += 1;
      guard();
    }
    expect(onStall).not.toHaveBeenCalled();
    // This run goes on past 100 ms.
    expect(() => {
      for (let call = 0; call < 100; call += 1) {
        time += 1;
        guard();
      }
    }).toThrow('ran for more than 0.1 seconds without a break');
    expect(onStall).toHaveBeenCalledOnce();
    // Stopped for good: every later call throws, even after the event loop turns.
    turns.splice(0).forEach((turn) => turn());
    expect(() => guard()).toThrow('ran for more than 0.1 seconds');
    expect(onStall).toHaveBeenCalledOnce();
    expect(onFirstRun).toHaveBeenCalledOnce();
  });

  it('the UI runtime installs it before the plugin loads, locks scripts and reports a stall', async () => {
    const context = realm();
    const kit = evaluate<() => RuntimeKit>(createRuntimeKit.toString(), context)();
    const run = evaluate<typeof runUi>(runUi.toString(), context);
    // The lock is written into the runtime's source (it can't import the constant).
    expect(runUi.toString()).toContain(LOCKED_SCRIPTS_CSP);
    const channel = new MessageChannel();
    const received = messages(channel.port1);
    const doc = document.implementation.createHTMLDocument('frame');
    const policies: string[] = [];
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLMetaElement && node.httpEquiv === 'Content-Security-Policy')
            policies.push(node.content);
    }).observe(doc.head, { childList: true });
    const window = { addEventListener: () => undefined } as UiEnv['window'] & {
      $$tg?: () => void;
    };
    /** Stands in for a MessageChannel, whose port would keep the test process alive. */
    class Channel {
      port1: { onmessage: (() => void) | null } = { onmessage: null };
      port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
    }
    const env: UiEnv = {
      port: channel.port2,
      code: '',
      init: {
        ...init,
        surface: { kind: 'panel', id: 'side', pageId: null },
        fonts: [],
        guard: { name: '$$tg', limitMs: 50 },
      },
      importPlugin: async () => {
        // Scripts load until the top of the instrumented module runs.
        await Promise.resolve();
        expect(policies).toEqual([]);
        window.$$tg?.();
        return {
          default: {
            __tesseraPlugin: 1,
            panels: {
              side() {
                // An instrumented `for (;;) {}`.
                for (;;) window.$$tg?.();
              },
            },
          },
        };
      },
      window,
      document: doc,
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      ResizeObserver: globalThis.ResizeObserver,
      FontFace: class {} as unknown as typeof FontFace,
      performance: globalThis.performance,
      MessageChannel: Channel as unknown as typeof MessageChannel,
    };
    await run(env, kit);
    // The policy was added once, and its element removed: plugin code finds nothing to read.
    expect(policies).toEqual([LOCKED_SCRIPTS_CSP]);
    expect(doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]')).toBeNull();
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({
          method: 'unresponsive',
          params: { ms: expect.any(Number) as number },
        }),
      ),
    );
    expect(received).toContainEqual(
      expect.objectContaining({
        method: 'error',
        params: expect.objectContaining({
          message: expect.stringMatching(/ran for more than 0.05 seconds/) as string,
          fatal: true,
        }) as unknown,
      }),
    );
    expect(received.some((message) => message.method === 'rendered')).toBe(false);
    channel.port1.close();
  });
});

describe('bootstraps', () => {
  it('the logic frame starts a classic worker for its parent only', () => {
    const listeners: Array<(event: unknown) => void> = [];
    const workers: Array<{ url: string; options: unknown; posted: unknown[] }> = [];
    const parentWindow = {};
    const context = realm({
      parent: parentWindow,
      addEventListener: (_type: string, listener: (event: unknown) => void) =>
        listeners.push(listener),
      removeEventListener: (_type: string, listener: (event: unknown) => void) =>
        listeners.splice(listeners.indexOf(listener), 1),
      URL: { createObjectURL: () => 'blob:null/worker' },
      Blob: class {},
      Worker: class {
        onerror: unknown = null;
        posted: unknown[] = [];
        constructor(url: string, options: unknown) {
          workers.push({ url, options, posted: this.posted });
        }
        postMessage(message: unknown) {
          this.posted.push(message);
        }
      },
    });
    evaluate<() => void>(workerFrameBootstrap.toString(), context)();
    const rpc = new MessageChannel();
    const control = new MessageChannel();
    const controlMessages = messages(control.port1);
    const init = {
      type: 'tessera:init',
      workerSource: 'code',
      name: 'P',
      code: 'plugin',
      init: {},
    };
    // Another frame (a plugin reaching `top.frames`) can't start it.
    listeners[0]?.({ source: {}, data: init, ports: [rpc.port2, control.port2] });
    expect(workers).toHaveLength(0);
    listeners[0]?.({ source: parentWindow, data: init, ports: [rpc.port2, control.port2] });
    expect(workers).toEqual([
      {
        url: 'blob:null/worker',
        options: { name: 'P' },
        posted: [{ port: rpc.port2, code: 'plugin', init: {} }],
      },
    ]);
    expect(listeners).toHaveLength(0);
    return vi
      .waitFor(() => expect(controlMessages).toEqual([{ type: 'started' }]))
      .finally(() => {
        rpc.port1.close();
        control.port1.close();
      });
  });

  it('the outer UI frame nests a sandboxed frame, follows the color scheme and reports navigations', async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const created: HTMLIFrameElement[] = [];
    const parentWindow = {};
    const root = document.createElement('html');
    const context = realm({
      parent: parentWindow,
      addEventListener: (_type: string, listener: (event: unknown) => void) =>
        listeners.push(listener),
      removeEventListener: () => undefined,
      document: {
        body: document.body,
        documentElement: root,
        createElement: (tag: string) => {
          const element = document.createElement(tag) as HTMLIFrameElement;
          Object.defineProperty(element, 'contentWindow', { value: { postMessage: vi.fn() } });
          created.push(element);
          return element;
        },
      },
    });
    evaluate<() => void>(uiOuterBootstrap.toString(), context)();
    const rpc = new MessageChannel();
    const control = new MessageChannel();
    const controlMessages = messages(control.port1);
    listeners[0]?.({
      source: parentWindow,
      data: {
        type: 'tessera:init',
        innerHtml: '<p>inner</p>',
        title: 'Mermaid diagram',
        runtimeSource: 'rt',
        code: 'c',
        init: { theme: { mode: 'dark' } },
      },
      ports: [rpc.port2, control.port2],
    });
    expect(root.style.colorScheme).toBe('dark');
    const inner = created[0];
    expect(inner?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(inner?.getAttribute('title')).toBe('Mermaid diagram');
    expect(inner?.srcdoc).toBe('<p>inner</p>');
    // The first load (jsdom loads the srcdoc itself) hands the port to the inner frame.
    const post = (inner?.contentWindow as unknown as { postMessage: ReturnType<typeof vi.fn> })
      .postMessage;
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(
      { type: 'tessera:init', runtimeSource: 'rt', code: 'c', init: { theme: { mode: 'dark' } } },
      '*',
      [rpc.port2],
    );
    control.port1.postMessage({ type: 'color-scheme', mode: 'red' });
    control.port1.postMessage({ type: 'color-scheme', mode: 'light' });
    await vi.waitFor(() => expect(root.style.colorScheme).toBe('light'));
    inner?.dispatchEvent(new Event('load'));
    await vi.waitFor(() =>
      expect(controlMessages).toEqual([{ type: 'started' }, { type: 'navigation' }]),
    );
    inner?.remove();
    rpc.port1.close();
    control.port1.close();
  });
});

describe('sandbox documents', () => {
  it('builds a strict CSP with only the granted network sources', () => {
    const csp = buildCsp({
      nonce: 'abc',
      network: ['https://api.example.com', 'wss://api.example.com'],
    });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc' blob:");
    expect(csp).toContain('connect-src https://api.example.com wss://api.example.com');
    expect(csp).toContain('img-src data: blob: https://api.example.com');
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(buildCsp({ nonce: 'abc', network: [] })).toContain("connect-src 'none'");
    expect(csp).not.toContain('unsafe-eval');
  });

  it('puts the CSP and a nonce on every document and refuses closing script tags', () => {
    const nonce = createNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9]{16,}$/);
    for (const html of [
      workerFrameDocument({ nonce, network: [] }),
      uiOuterDocument({ nonce, network: [] }),
      uiInnerDocument({ nonce, network: [] }),
    ]) {
      expect(html).toContain('http-equiv="Content-Security-Policy"');
      expect(html).toContain(`<script nonce="${nonce}">`);
      expect(html.match(/<script/g)).toHaveLength(1);
    }
    expect(() => sandboxDocument({ csp: '', nonce: 'n', script: 'x("</script>")' })).toThrow();
    expect(uiRuntimeModuleSource()).toMatch(/^export default function start\(env\)/);
  });

  it("uses the nonce the app's own policy trusts (srcdoc frames inherit it)", () => {
    const page = (head: string) => {
      const doc = document.implementation.createHTMLDocument('Tessera');
      doc.head.innerHTML = head;
      return doc;
    };
    // The Tessera server writes each response's nonce into the page.
    expect(appCspNonce(page('<meta property="csp-nonce" nonce="Zm9vYmFyYmF6cXV4MTIzNA==">'))).toBe(
      'Zm9vYmFyYmF6cXV4MTIzNA==',
    );
    // The desktop app's nonces are decimal numbers; a nonce'd script works too.
    expect(appCspNonce(page('<meta property="csp-nonce" nonce="15813920557423177066">'))).toBe(
      '15813920557423177066',
    );
    expect(appCspNonce(page('<script nonce="c2NyaXB0Tm9uY2U="></script>'))).toBe(
      'c2NyaXB0Tm9uY2U=',
    );
    // No policy (the placeholder was never replaced), or something that isn't a nonce.
    expect(
      appCspNonce(page('<meta property="csp-nonce" nonce="__TAURI_SCRIPT_NONCE__">')),
    ).toBeNull();
    expect(appCspNonce(page(`<meta property="csp-nonce" nonce="x'; script-src *">`))).toBeNull();
    expect(appCspNonce(page(''))).toBeNull();
  });
});
