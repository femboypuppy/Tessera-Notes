import type { PluginDefinition } from '@tessera/plugin-api';
import type { RpcPort } from '../rpc/endpoint';
import type {
  Sandbox,
  SandboxFactory,
  UiSandboxOptions,
  WorkerSandboxOptions,
} from '../sandbox/frames';
import { createRuntimeKit, type RuntimePort } from '../sandbox/runtime-kit';
import { runUi } from '../sandbox/runtime-ui';
import { runWorker } from '../sandbox/runtime-worker';

/** A sandbox created by {@link createInProcessSandboxes}, for assertions. */
export interface FakeSandbox {
  kind: 'worker' | 'ui' | 'renderer';
  code: string;
  network: string[];
  destroyed: boolean;
  /** Stops delivering messages both ways, like a thread stuck in `while (true) {}`. */
  frozen: boolean;
  /** Sends a raw message to the host as the plugin (bypassing the runtime). */
  send(message: unknown): void;
  /** Raw messages the host sent to the plugin. */
  received: unknown[];
  logs: string[];
  /** The UI frame's document (UI sandboxes only). */
  document?: Document;
  /** The last color scheme the host sent to the frame. */
  colorScheme?: 'light' | 'dark';
}

class FakeFontFace {
  constructor(
    readonly family: string,
    readonly source: unknown,
  ) {}
  load() {
    return Promise.resolve(this);
  }
}

function quietConsole(logs: string[]) {
  const record =
    (level: string) =>
    (...values: unknown[]) =>
      logs.push(`${level}: ${values.map(String).join(' ')}`);
  return {
    log: record('log'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  };
}

/**
 * Runs the real sandbox runtime (`runWorker`, `runUi`) in this process over real MessageChannels,
 * with plugin modules looked up by their "code" string. Everything between the host and the plugin
 * is the production path, except the iframes and the blob URL import.
 */
export function createInProcessSandboxes(modules: Map<string, PluginDefinition | unknown>) {
  const sandboxes: FakeSandbox[] = [];
  const load = async (code: string) => {
    if (!modules.has(code)) throw new Error(`Unknown module ${code}`);
    const value = modules.get(code);
    return value && typeof value === 'object' && 'default' in value ? value : { default: value };
  };

  const connect = (kind: FakeSandbox['kind'], options: WorkerSandboxOptions | UiSandboxOptions) => {
    const channel = new MessageChannel();
    const record: FakeSandbox = {
      kind,
      code: options.code,
      network: [...options.network],
      destroyed: false,
      frozen: false,
      received: [],
      logs: [],
      send: (message) => channel.port2.postMessage(message),
    };
    sandboxes.push(record);
    let handler: ((event: { data: unknown }) => void) | null = null;
    channel.port2.onmessage = (event: MessageEvent) => {
      record.received.push(event.data);
      if (!record.frozen) handler?.(event);
    };
    const runtimePort: RuntimePort = {
      postMessage: (message) => {
        if (!record.frozen) channel.port2.postMessage(message);
      },
      get onmessage() {
        return handler;
      },
      set onmessage(value) {
        handler = value;
      },
    };
    const sandbox: Sandbox = {
      port: channel.port1 as unknown as RpcPort,
      frame: document.createElement('iframe'),
      setColorScheme(mode) {
        record.colorScheme = mode;
      },
      destroy() {
        record.destroyed = true;
        handler = null;
        channel.port1.close();
        channel.port2.close();
        sandbox.frame.remove();
      },
    };
    return { record, runtimePort, sandbox };
  };

  const factory: SandboxFactory & { sandboxes: FakeSandbox[] } = {
    sandboxes,
    async createWorker(options) {
      const { record, runtimePort, sandbox } = connect('worker', options);
      void runWorker(
        {
          port: runtimePort,
          code: options.code,
          init: options.init,
          importPlugin: load,
          console: quietConsole(record.logs),
          global: new EventTarget() as unknown as { addEventListener(): void },
        },
        createRuntimeKit(),
      );
      return sandbox;
    },
    async createUi(options) {
      const { record, runtimePort, sandbox } = connect(options.kind ?? 'ui', options);
      const doc = document.implementation.createHTMLDocument('plugin frame');
      record.document = doc;
      options.container.append(sandbox.frame);
      void runUi(
        {
          port: runtimePort,
          code: options.code,
          init: options.init,
          importPlugin: load,
          window: new EventTarget() as unknown as { addEventListener(): void },
          document: doc,
          console: quietConsole(record.logs),
          ResizeObserver: globalThis.ResizeObserver,
          FontFace: FakeFontFace as unknown as typeof FontFace,
          performance: globalThis.performance,
          MessageChannel: globalThis.MessageChannel,
        },
        createRuntimeKit(),
      );
      return sandbox;
    },
  };
  return factory;
}
