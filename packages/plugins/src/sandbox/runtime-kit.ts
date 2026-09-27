import type {
  BlockOptions,
  CommandDefinition,
  JsonValue,
  PageChangeEvent,
  PanelOptions,
  PluginApi,
  PluginDefinition,
  PluginInfo,
  PluginPermission,
  PluginSurface,
  SettingsSchema,
  ThemeInfo,
} from '@tessera/plugin-api';

/**
 * Code that runs INSIDE the sandbox (the plugin's worker and its panel and block frames).
 *
 * The functions in `sandbox/runtime-*.ts` are shipped into the sandbox as source text
 * (`Function.prototype.toString`), so each one must be self-contained: no imports (types only),
 * no references to anything outside its own body, no classes. `runtime.test.ts` runs the assembled
 * sources in a fresh `node:vm` context to prove it.
 */

/** A MessagePort as the runtime sees it. */
export interface RuntimePort {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/** State the host sends when a sandbox starts. */
export interface RuntimeInit {
  plugin: PluginInfo;
  settings: Record<string, string | number | boolean>;
  theme: ThemeInfo;
}

/** A module export the runtime accepts as a plugin. */
export type RuntimeDefinition = PluginDefinition<SettingsSchema>;

/** Host requests the runtime answers. */
export type RuntimeRequestHandler = (method: string, params: unknown) => unknown;

/** What {@link RuntimeKit.installGuard} needs. */
export interface GuardOptions {
  /** Where the global function goes (the frame's window). */
  target: object;
  /** Its name, chosen by the host (`instrument.ts`). */
  name: string;
  /** How long plugin code may run before the event loop turns. */
  limitMs: number;
  now(): number;
  /** Runs `callback` in a later task, once the event loop has turned. */
  afterTask(callback: () => void): void;
  /** The first call: the top of the plugin module, before any of its code. */
  onFirstRun(): void;
  /** The code ran too long and is being stopped. */
  onStall(elapsedMs: number): void;
}

/** What `createRuntimeKit` returns. */
export interface RuntimeKit {
  createRpc(port: RuntimePort): RuntimeRpc;
  /** The API object handed to plugin code. */
  createApi(options: {
    rpc: RuntimeRpc;
    surface: PluginSurface;
    init: RuntimeInit;
    definition: RuntimeDefinition;
    /** Worker only: command handlers by command ID. */
    commands?: Map<string, CommandDefinition['run']>;
  }): { api: PluginApi; state: RuntimeState };
  /** Validates a module's default export. Throws a readable error. */
  readDefinition(module: unknown): RuntimeDefinition;
  /** Forwards console output and uncaught errors to the host. */
  captureConsole(
    target: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>,
    rpc: RuntimeRpc,
  ): void;
  captureErrors(
    target: { addEventListener(type: string, listener: (event: unknown) => void): void },
    rpc: RuntimeRpc,
  ): void;
  /** Formats console arguments like a console would. */
  format(values: readonly unknown[]): string;
  makeError(code: string, message: string, permission?: string): Error;
  /**
   * UI frames: defines the global function instrumented plugin code calls at the start of every
   * function and loop iteration (`instrument.ts`). Once the code has run for `limitMs` without
   * letting the event loop turn, it throws, and from then on it throws on every call, so the code
   * unwinds instead of freezing the app, and the host closes the frame.
   */
  installGuard(options: GuardOptions): void;
}

/** The runtime's view of the connection. */
export interface RuntimeRpc {
  call(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onRequest(handler: RuntimeRequestHandler): void;
  onEvent(event: string, listener: (payload: unknown) => void): () => void;
}

/** Mutable state the host keeps current through events. */
export interface RuntimeState {
  settings: Record<string, string | number | boolean>;
  theme: ThemeInfo;
}

/**
 * Builds the runtime helpers. Self-contained: shipped into the sandbox as source text.
 */
export function createRuntimeKit(): RuntimeKit {
  const PROTOCOL = 1;
  const CALL_TIMEOUT_MS = 120_000;

  const makeError = (code: string, message: string, permission?: string): Error => {
    const error = new Error(message) as Error & { code: string; permission?: string };
    error.name = 'PluginError';
    error.code = code;
    if (permission) error.permission = permission;
    return error;
  };

  const format = (values: readonly unknown[]): string =>
    values
      .map((value) => {
        if (typeof value === 'string') return value;
        if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
        if (value === undefined) return 'undefined';
        if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
        if (typeof value === 'symbol' || typeof value === 'bigint') return String(value);
        try {
          return JSON.stringify(value) ?? String(value);
        } catch {
          return String(value);
        }
      })
      .join(' ')
      .slice(0, 20_000);

  const createRpc = (port: RuntimePort): RuntimeRpc => {
    let nextId = 1;
    const pending = new Map<
      number,
      {
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    let requestHandler: RuntimeRequestHandler | null = null;
    // Bound now, before plugin code runs, so patching MessagePort.prototype can't intercept it.
    const post = port.postMessage.bind(port);

    port.onmessage = (event) => {
      const message = event.data as {
        v?: unknown;
        type?: unknown;
        id?: number;
        ok?: boolean;
        result?: unknown;
        error?: { code?: string; message?: string; permission?: string };
        method?: string;
        params?: unknown;
        event?: string;
        payload?: unknown;
      } | null;
      if (!message || message.v !== PROTOCOL) return;
      if (message.type === 'response' && typeof message.id === 'number') {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else
          entry.reject(
            makeError(
              message.error?.code || 'internal',
              message.error?.message || 'The call failed',
              message.error?.permission,
            ),
          );
      } else if (message.type === 'request' && typeof message.id === 'number') {
        const id = message.id;
        const respond = (ok: boolean, value: unknown) => {
          if (ok) {
            try {
              post({ v: PROTOCOL, type: 'response', id, ok: true, result: value });
            } catch {
              // Handlers only return JSON; anything else is answered as null.
              post({ v: PROTOCOL, type: 'response', id, ok: true, result: null });
            }
            return;
          }
          post({
            v: PROTOCOL,
            type: 'response',
            id,
            ok: false,
            error: {
              code: 'internal',
              message: String(
                value instanceof Error ? value.message : value || 'The plugin failed',
              ).slice(0, 4_000),
            },
          });
        };
        if (!requestHandler) {
          respond(false, 'The plugin is not ready');
          return;
        }
        const handler = requestHandler;
        Promise.resolve()
          .then(() => handler(String(message.method), message.params))
          .then(
            (result) => respond(true, result === undefined ? null : result),
            (error: unknown) => respond(false, error),
          );
      } else if (message.type === 'event' && typeof message.event === 'string') {
        for (const listener of [...(listeners.get(message.event) || [])]) {
          try {
            listener(message.payload);
          } catch (error) {
            console.error(error);
          }
        }
      }
    };

    return {
      call(method, params) {
        const id = nextId;
        nextId = nextId >= 2 ** 31 - 1 ? 1 : nextId + 1;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(makeError('timeout', `Tessera didn't answer ${method} in time`));
          }, CALL_TIMEOUT_MS);
          pending.set(id, { resolve, reject, timer });
          try {
            post(
              params === undefined
                ? { v: PROTOCOL, type: 'request', id, method }
                : { v: PROTOCOL, type: 'request', id, method, params },
            );
          } catch (error) {
            pending.delete(id);
            clearTimeout(timer);
            reject(
              makeError(
                'invalid',
                `Arguments of ${method} can't be sent: only JSON values can cross the sandbox (${String(error)})`,
              ),
            );
          }
        });
      },
      notify(method, params) {
        try {
          post({ v: PROTOCOL, type: 'notify', method, params });
        } catch {
          // Unclonable log arguments are already formatted as strings; nothing else to do.
        }
      },
      onRequest(handler) {
        requestHandler = handler;
      },
      onEvent(event, listener) {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(listener);
        return () => {
          set.delete(listener);
        };
      },
    };
  };

  const readDefinition = (module: unknown): RuntimeDefinition => {
    const candidate =
      module && typeof module === 'object' && 'default' in module
        ? (module as { default: unknown }).default
        : undefined;
    const fail = () =>
      makeError(
        'invalid',
        "The plugin's code doesn't export a plugin. Its default export should be definePlugin({ … }).",
      );
    if (!candidate || typeof candidate !== 'object') throw fail();
    const value = candidate as Record<string, unknown>;
    // definePlugin() marks its result; a hand-written object must at least look like a plugin.
    const known = ['activate', 'deactivate', 'panels', 'blocks', 'settings'];
    if (value.__tesseraPlugin !== 1 && !known.some((key) => value[key] !== undefined)) throw fail();
    const functionOrNothing = (key: string) =>
      value[key] === undefined || typeof value[key] === 'function';
    const renderers = (key: string) =>
      value[key] === undefined ||
      (typeof value[key] === 'object' &&
        value[key] !== null &&
        Object.values(value[key] as object).every((item) => typeof item === 'function'));
    if (
      !functionOrNothing('activate') ||
      !functionOrNothing('deactivate') ||
      !renderers('panels') ||
      !renderers('blocks') ||
      (value.settings !== undefined &&
        (typeof value.settings !== 'object' || value.settings === null))
    )
      throw fail();
    return candidate as RuntimeDefinition;
  };

  const captureConsole: RuntimeKit['captureConsole'] = (target, rpc) => {
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = target[level].bind(target);
      target[level] = (...values: unknown[]) => {
        rpc.notify('log', { level, message: format(values) });
        original(...values);
      };
    }
  };

  const captureErrors: RuntimeKit['captureErrors'] = (target, rpc) => {
    target.addEventListener('error', (event) => {
      const { message, error } = event as { message?: string; error?: unknown };
      rpc.notify('error', {
        message: String(error instanceof Error ? error.message : message || 'Unknown error').slice(
          0,
          20_000,
        ),
        ...(error instanceof Error && error.stack ? { stack: error.stack.slice(0, 40_000) } : {}),
      });
    });
    target.addEventListener('unhandledrejection', (event) => {
      const reason = (event as { reason?: unknown }).reason;
      rpc.notify('error', {
        message:
          `Unhandled rejection: ${reason instanceof Error ? reason.message : format([reason])}`.slice(
            0,
            20_000,
          ),
        ...(reason instanceof Error && reason.stack
          ? { stack: reason.stack.slice(0, 40_000) }
          : {}),
      });
    });
  };

  const hasPermission = (granted: readonly string[], permission: string) => {
    if (granted.includes(permission)) return true;
    if (!permission.startsWith('network:')) return false;
    const host = permission.slice(8).replace(/:\d+$/, '');
    return granted.some(
      (entry) =>
        entry.startsWith('network:*.') && host.endsWith(`.${entry.slice(10).replace(/:\d+$/, '')}`),
    );
  };

  const createApi: RuntimeKit['createApi'] = ({ rpc, surface, init, definition, commands }) => {
    const state: RuntimeState = { settings: { ...init.settings }, theme: init.theme };
    const granted = init.plugin.permissions;
    const requirePermission = (permission: string, action: string) => {
      if (!hasPermission(granted, permission))
        throw makeError(
          'permission_denied',
          `${init.plugin.name} doesn’t have permission to ${action}. You can allow it in Settings → Plugins.`,
          permission,
        );
    };
    const onlyInWorker = (what: string) => {
      if (surface !== 'worker')
        throw makeError(
          'invalid_operation',
          `${what} is only available in activate(), not in ${surface}s.`,
        );
    };
    const report = (promise: Promise<unknown>) => {
      promise.catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
      });
    };
    /** A listener set that subscribes on the host while it has listeners. */
    const subscription = <T>(
      event: string,
      method: string,
      map: (payload: unknown) => T | null,
    ) => {
      const set = new Set<(value: T) => void>();
      rpc.onEvent(event, (payload) => {
        const value = map(payload);
        if (value === null) return;
        for (const listener of [...set]) listener(value);
      });
      return (listener: (value: T) => void) => {
        if (set.size === 0) report(rpc.call(`${method}.subscribe`));
        set.add(listener);
        return () => {
          if (set.delete(listener) && set.size === 0) report(rpc.call(`${method}.unsubscribe`));
        };
      };
    };

    const settingsListeners = new Set<
      (values: Record<string, string | number | boolean>, key: string) => void
    >();
    rpc.onEvent('settings.changed', (payload) => {
      const { values, key } = (payload || {}) as {
        values?: Record<string, string | number | boolean>;
        key?: string;
      };
      if (!values) return;
      state.settings = { ...values };
      for (const listener of [...settingsListeners]) listener({ ...state.settings }, key || '');
    });
    const themeListeners = new Set<(theme: ThemeInfo) => void>();
    rpc.onEvent('theme.changed', (payload) => {
      const theme = (payload as { theme?: ThemeInfo } | null)?.theme;
      if (!theme) return;
      state.theme = theme;
      for (const listener of [...themeListeners]) listener(theme);
    });

    const onPages = subscription<PageChangeEvent>('pages.changed', 'pages', (payload) =>
      payload && typeof payload === 'object' ? (payload as PageChangeEvent) : null,
    );
    const onStorage = subscription<{ key: string; value: JsonValue | undefined }>(
      'storage.changed',
      'storage',
      (payload) => {
        const change = payload as { key?: unknown; value?: JsonValue } | null;
        return change && typeof change.key === 'string'
          ? { key: change.key, value: change.value }
          : null;
      },
    );

    /** Registers on the host; the returned function unregisters (after the registration settles). */
    const registered = (add: () => Promise<unknown>, remove: () => Promise<unknown>) => {
      let active = true;
      const added = add();
      report(added);
      return () => {
        if (!active) return;
        active = false;
        report(added.then(remove, () => undefined));
      };
    };

    const api: PluginApi = {
      apiVersion: init.plugin.apiVersion,
      plugin: init.plugin,
      surface,
      hasPermission: (permission: PluginPermission) => hasPermission(granted, permission),
      commands: {
        register(command) {
          onlyInWorker('Registering commands');
          requirePermission('ui:commands', 'add commands');
          if (!command || typeof command.run !== 'function')
            throw makeError('invalid', 'A command needs an id, a title and a run function.');
          if (commands?.has(command.id))
            throw makeError('invalid', `A command "${command.id}" is already registered.`);
          commands?.set(command.id, command.run);
          const params: Record<string, unknown> = { id: command.id, title: command.title };
          if (command.keywords) params.keywords = [...command.keywords];
          if (command.shortcut) params.shortcut = command.shortcut;
          const off = registered(
            () => rpc.call('commands.register', params),
            () => rpc.call('commands.unregister', { id: command.id }),
          );
          return () => {
            if (commands?.get(command.id) === command.run) commands.delete(command.id);
            off();
          };
        },
      },
      ui: {
        addPanel(panel: PanelOptions) {
          onlyInWorker('Adding panels');
          requirePermission('ui:panels', 'add side panels');
          if (!definition.panels || typeof definition.panels[panel.id] !== 'function')
            throw makeError(
              'invalid',
              `There's no renderer for panel "${panel.id}" in definePlugin({ panels }).`,
            );
          const params: Record<string, unknown> = { id: panel.id, title: panel.title };
          if (panel.icon) params.icon = panel.icon;
          return registered(
            () => rpc.call('ui.addPanel', params),
            () => rpc.call('ui.removePanel', { id: panel.id }),
          );
        },
        openPanel: async (id) => {
          requirePermission('ui:panels', 'add side panels');
          await rpc.call('ui.openPanel', { id });
        },
        addBlock(block: BlockOptions) {
          onlyInWorker('Adding blocks');
          requirePermission('ui:blocks', 'add custom blocks');
          if (!definition.blocks || typeof definition.blocks[block.type] !== 'function')
            throw makeError(
              'invalid',
              `There's no renderer for block "${block.type}" in definePlugin({ blocks }).`,
            );
          const params: Record<string, unknown> = { type: block.type, title: block.title };
          if (block.description) params.description = block.description;
          if (block.icon) params.icon = block.icon;
          if (block.keywords) params.keywords = [...block.keywords];
          if (block.initialData !== undefined) params.initialData = block.initialData;
          return registered(
            () => rpc.call('ui.addBlock', params),
            () => rpc.call('ui.removeBlock', { type: block.type }),
          );
        },
        notify: async (options) => {
          await rpc.call(
            'ui.notify',
            typeof options === 'string' ? { title: options } : { ...options },
          );
        },
      },
      pages: {
        list: async (options) =>
          (await rpc.call('pages.list', options ? { ...options } : undefined)) as never,
        get: (async (id: string, options?: { format?: string }) =>
          rpc.call(
            'pages.get',
            options?.format ? { id, format: options.format } : { id },
          )) as PluginApi['pages']['get'],
        create: async (input) => (await rpc.call('pages.create', { ...input })) as never,
        update: async (id, input) => (await rpc.call('pages.update', { id, ...input })) as never,
        current: async () => (await rpc.call('pages.current')) as string | null,
        open: async (id) => {
          await rpc.call('pages.open', { id });
        },
        onChange(listener) {
          requirePermission('pages:read', 'read your pages');
          return onPages(listener);
        },
      },
      databases: {
        list: async () => (await rpc.call('databases.list')) as never,
        get: async (id) => (await rpc.call('databases.get', { id })) as never,
        query: async (id, query) =>
          (await rpc.call('databases.query', query ? { id, query } : { id })) as never,
        addRow: async (id, input) =>
          (await rpc.call('databases.addRow', input ? { id, input } : { id })) as never,
        updateRow: async (id, rowId, input) =>
          (await rpc.call('databases.updateRow', { id, rowId, input })) as never,
      },
      storage: {
        get: async (key) => {
          // The host answers `{ value }` for a stored key and `{}` for a missing one, so a stored
          // null stays null.
          const result = (await rpc.call('storage.get', { key })) as { value?: JsonValue } | null;
          return (result && 'value' in result ? result.value : undefined) as never;
        },
        set: async (key, value) => {
          await rpc.call('storage.set', { key, value });
        },
        delete: async (key) => {
          await rpc.call('storage.delete', { key });
        },
        keys: async () => (await rpc.call('storage.keys')) as string[],
        onChange(listener) {
          requirePermission('storage', 'store data');
          return onStorage(({ key, value }) => listener(key, value));
        },
      },
      settings: {
        get: (key: string) => state.settings[key] as never,
        getAll: () => ({ ...state.settings }) as never,
        set: async (key: string, value: unknown) => {
          await rpc.call('settings.set', { key, value });
        },
        onChange(listener) {
          const wrapped = listener as (
            values: Record<string, string | number | boolean>,
            key: string,
          ) => void;
          settingsListeners.add(wrapped);
          return () => {
            settingsListeners.delete(wrapped);
          };
        },
      },
      theme: {
        get: () => state.theme,
        onChange(listener) {
          themeListeners.add(listener);
          return () => {
            themeListeners.delete(listener);
          };
        },
      },
    };
    return { api, state };
  };

  const installGuard: RuntimeKit['installGuard'] = (options) => {
    const { now, afterTask, onFirstRun, onStall, limitMs } = options;
    // Captured now: plugin code may replace the global Error later.
    const Stop = Error;
    const message = `The plugin's code ran for more than ${limitMs / 1000} seconds without a break, so Tessera stopped it.`;
    /** When the current run started (the first call since the event loop last turned), or -1. */
    let started = -1;
    let calls = 0;
    let stalled = false;
    let first = true;
    const guard = () => {
      if (stalled) throw new Stop(message);
      if (started < 0) {
        started = now();
        calls = 0;
        afterTask(() => {
          started = -1;
        });
        if (first) {
          first = false;
          onFirstRun();
        }
        return;
      }
      calls += 1;
      // Reading the clock on every call would slow tight loops down; every 16th call is enough.
      if (calls % 16 !== 0) return;
      const elapsed = now() - started;
      if (elapsed <= limitMs) return;
      stalled = true;
      onStall(elapsed);
      throw new Stop(message);
    };
    // Not writable, not configurable: plugin code can't replace or remove it.
    Object.defineProperty(options.target, options.name, { value: guard });
  };

  return {
    createRpc,
    createApi,
    readDefinition,
    captureConsole,
    captureErrors,
    format,
    makeError,
    installGuard,
  };
}
