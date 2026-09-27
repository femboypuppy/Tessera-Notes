import type {
  BlockContext,
  BlockState,
  JsonValue,
  PanelContext,
  ThemeInfo,
} from '@tessera/plugin-api';
import type { RuntimeInit, RuntimeKit, RuntimePort } from './runtime-kit';

/** The surface a UI frame renders. */
export type UiSurfaceInit =
  | { kind: 'panel'; id: string; pageId: string | null }
  | {
      kind: 'block';
      type: string;
      pageId: string;
      blockId: string | null;
      data: JsonValue | null;
      readOnly: boolean;
      selected: boolean;
    };

/** A font the host passes to the frame (the sandbox can't load the app's font files itself). */
export interface UiFont {
  family: string;
  data: ArrayBuffer;
  descriptors: FontFaceDescriptors;
}

/** The guard instrumented code calls (`instrument.ts`), and how long code may run without a break. */
export interface UiGuardInit {
  name: string;
  limitMs: number;
}

/** What the host sends to a panel or block frame. */
export interface UiInit extends RuntimeInit {
  surface: UiSurfaceInit;
  fonts: UiFont[];
  /** Set when the code was instrumented (always in real frames). */
  guard?: UiGuardInit;
}

/**
 * The policy a frame adds once the plugin module starts: no script of any kind loads after it, so
 * the only code that runs is the instrumented module. Workers may still start (off this thread).
 */
export const LOCKED_SCRIPTS_CSP = "script-src 'none'; worker-src blob:";

/** What the UI runtime needs from its environment (the inner frame's window). */
export interface UiEnv {
  port: RuntimePort;
  code: string;
  init: UiInit;
  importPlugin(code: string): Promise<unknown>;
  window: {
    addEventListener(type: string, listener: (event: unknown) => void): void;
  };
  document: Document;
  console: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>;
  ResizeObserver: typeof ResizeObserver;
  FontFace: typeof FontFace;
  performance: { now(): number };
  MessageChannel: typeof MessageChannel;
}

/**
 * Renders one panel or block inside its frame: applies the app's theme (CSS variables and base
 * styles, so plugin UIs match Tessera), installs the guard of instrumented code, loads the plugin
 * module, calls the renderer, and keeps the host informed (content height for blocks, rendered,
 * errors, a stall). Self-contained: shipped into the sandbox as source text.
 */
export function runUi(env: UiEnv, kit: RuntimeKit): Promise<void> {
  // Duplicated from LOCKED_SCRIPTS_CSP: this function can't reference anything outside itself.
  const LOCKED_CSP = "script-src 'none'; worker-src blob:";
  const BASE_CSS = [
    '*,*::before,*::after{box-sizing:border-box}',
    'html{color-scheme:light}html[data-theme=dark]{color-scheme:dark}',
    "html,body{margin:0;padding:0;background:transparent;color:var(--tess-fg);font-family:var(--tess-font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:'cv11','ss01'}",
    'html[data-surface=panel],html[data-surface=panel] body{height:100%}',
    'html[data-surface=panel] #root{min-height:100%;padding:12px}',
    'html[data-surface=block] body{overflow:hidden}',
    '::selection{background:var(--tess-selection)}',
    ':focus-visible{outline:2px solid var(--tess-focus);outline-offset:2px}:focus:not(:focus-visible){outline:none}',
    'a{color:var(--tess-accent-text);text-decoration:none}a:hover{text-decoration:underline}',
    'code,kbd,pre,samp{font-family:var(--tess-font-mono);font-size:.9em}',
    'h1,h2,h3,h4{margin:0 0 .5em;line-height:1.25;font-weight:600}p{margin:0 0 .75em}',
    ':where(button){display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:var(--tess-radius-md);border:1px solid var(--tess-border);background:var(--tess-surface);color:var(--tess-fg);font:inherit;font-size:14px;font-weight:500;box-shadow:var(--tess-shadow-sm);transition:background-color var(--tess-duration-fast) var(--tess-ease-out),color var(--tess-duration-fast) var(--tess-ease-out)}',
    ':where(button:hover){background:var(--tess-hover)}:where(button:disabled){opacity:.5;pointer-events:none}',
    ':where(button.primary){background:var(--tess-accent);border-color:transparent;color:var(--tess-accent-fg)}:where(button.primary:hover){background:var(--tess-accent-hover)}',
    ':where(button.ghost){background:transparent;border-color:transparent;box-shadow:none;color:var(--tess-fg-muted)}:where(button.ghost:hover){background:var(--tess-hover);color:var(--tess-fg)}',
    ':where(input,select,textarea){width:100%;border-radius:var(--tess-radius-md);border:1px solid var(--tess-border);background:var(--tess-bg);color:var(--tess-fg);font:inherit;font-size:14px;padding:6px 10px}',
    ':where(input,select){height:32px;padding-block:0}',
    ':where(input,select,textarea):focus-visible{border-color:var(--tess-accent);outline:2px solid var(--tess-focus);outline-offset:0}',
    '.muted{color:var(--tess-fg-muted)}.subtle{color:var(--tess-fg-subtle)}',
    // Transitions are switched off (0s), not shortened: with `transition-property: all` as the
    // default, any non-zero duration turns every style change into a transition, and code that
    // measures right after changing styles (Mermaid's layout, for one) reads the old values.
    '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important}}',
    'html[data-reduced-motion] *,html[data-reduced-motion] *::before,html[data-reduced-motion] *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important}',
  ].join('\n');

  const { document, init } = env;
  const surface = init.surface;
  const rpc = kit.createRpc(env.port);
  kit.captureConsole(env.console, rpc);
  kit.captureErrors(env.window, rpc);
  rpc.onRequest((method) => {
    if (method === 'ping') return 'pong';
    throw new Error(`Unknown request "${method}".`);
  });

  const html = document.documentElement;
  const applyTheme = (theme: ThemeInfo) => {
    for (const [name, value] of Object.entries(theme.tokens))
      html.style.setProperty(`--tess-${name}`, value);
    html.setAttribute('data-theme', theme.mode);
    if (theme.reducedMotion) html.setAttribute('data-reduced-motion', '');
    else html.removeAttribute('data-reduced-motion');
  };
  applyTheme(init.theme);
  rpc.onEvent('theme.changed', (payload) => {
    const theme = (payload as { theme?: ThemeInfo } | null)?.theme;
    if (theme) applyTheme(theme);
  });
  html.setAttribute('data-surface', surface.kind);
  html.setAttribute('lang', 'en');
  const style = document.createElement('style');
  style.textContent = BASE_CSS;
  document.head.append(style);
  for (const font of init.fonts) {
    try {
      const face = new env.FontFace(font.family, font.data, font.descriptors);
      document.fonts.add(face);
      void face.load().catch(() => undefined);
    } catch {
      // A font that can't be decoded falls back to the system font stack.
    }
  }

  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);

  if (surface.kind === 'block') {
    let last = -1;
    const report = () => {
      const height = Math.ceil(Math.max(root.scrollHeight, root.getBoundingClientRect().height));
      if (height === last) return;
      last = height;
      rpc.notify('resize', { height });
    };
    new env.ResizeObserver(report).observe(root);
    report();
  }

  const fail = (error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    const params: Record<string, unknown> = { message: failure.message, fatal: true };
    if (failure.stack) params.stack = failure.stack;
    rpc.notify('error', params);
  };

  // Instrumented code calls the guard; set it up before the module loads. Everything it uses is
  // captured here, before any plugin code runs.
  let nextTask = (): Promise<void> => Promise.resolve();
  if (init.guard) {
    const channel = new env.MessageChannel();
    const waiting: Array<() => void> = [];
    channel.port1.onmessage = () => waiting.shift()?.();
    const post = channel.port2.postMessage.bind(channel.port2);
    const afterTask = (callback: () => void) => {
      waiting.push(callback);
      post(null);
    };
    const head = document.head;
    kit.installGuard({
      target: env.window,
      name: init.guard.name,
      limitMs: init.guard.limitMs,
      now: env.performance.now.bind(env.performance),
      afterTask,
      onFirstRun: () => {
        // The policy applies once the element is in the document, and stays in force after it's
        // removed (plugin code has nothing to read).
        const lock = document.createElement('meta');
        lock.httpEquiv = 'Content-Security-Policy';
        lock.content = LOCKED_CSP;
        head.append(lock);
        lock.remove();
      },
      onStall: (elapsedMs) => rpc.notify('unresponsive', { ms: Math.round(elapsedMs) }),
    });
    nextTask = () => new Promise((resolve) => afterTask(resolve));
  }

  return env
    .importPlugin(env.code)
    .then(async (module) => {
      // Loading a large module takes a while: let the app run before rendering starts.
      await nextTask();
      const definition = kit.readDefinition(module);
      const { api } = kit.createApi({ rpc, surface: surface.kind, init, definition });
      let result: unknown;
      if (surface.kind === 'panel') {
        const render = definition.panels?.[surface.id];
        if (typeof render !== 'function')
          throw kit.makeError('not_found', `The plugin has no renderer for panel "${surface.id}".`);
        let pageId = surface.pageId;
        const listeners = new Set<(pageId: string | null) => void>();
        rpc.onEvent('panel.page', (payload) => {
          const next = (payload as { pageId?: string | null } | null)?.pageId ?? null;
          if (next === pageId) return;
          pageId = next;
          for (const listener of [...listeners]) listener(pageId);
        });
        const ctx: PanelContext = {
          root,
          api,
          panelId: surface.id,
          get pageId() {
            return pageId;
          },
          onPageChange(listener) {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          close() {
            rpc.call('panel.close').catch(() => undefined);
          },
        };
        result = await render(ctx);
      } else {
        const render = definition.blocks?.[surface.type];
        if (typeof render !== 'function')
          throw kit.makeError(
            'not_found',
            `The plugin has no renderer for block "${surface.type}".`,
          );
        let state: BlockState = {
          data: surface.data,
          readOnly: surface.readOnly,
          selected: surface.selected,
        };
        const listeners = new Set<(state: BlockState) => void>();
        const emit = () => {
          for (const listener of [...listeners]) listener({ ...state });
        };
        rpc.onEvent('block.state', (payload) => {
          const patch = (payload || {}) as Partial<BlockState>;
          const next: BlockState = { ...state, ...patch };
          if (JSON.stringify(next) === JSON.stringify(state)) return;
          state = next;
          emit();
        });
        const ctx: BlockContext = {
          root,
          api,
          blockType: surface.type,
          pageId: surface.pageId,
          blockId: surface.blockId,
          get data() {
            return state.data;
          },
          get readOnly() {
            return state.readOnly;
          },
          get selected() {
            return state.selected;
          },
          async setData(data) {
            if (state.readOnly)
              throw kit.makeError('invalid_operation', 'This block is read-only.');
            await rpc.call('block.setData', { data });
            const copy = JSON.parse(JSON.stringify(data)) as JsonValue;
            if (JSON.stringify(copy) === JSON.stringify(state.data)) return;
            state = { ...state, data: copy };
            emit();
          },
          onChange(listener) {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          async remove() {
            await rpc.call('block.remove');
          },
        };
        result = await render(ctx);
      }
      if (typeof result === 'function') {
        const cleanup = result as () => void;
        env.window.addEventListener('pagehide', () => {
          try {
            cleanup();
          } catch {
            // The frame is going away.
          }
        });
      }
      rpc.notify('rendered', {});
    })
    .catch(fail);
}
