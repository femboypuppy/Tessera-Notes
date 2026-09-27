import {
  commandShortcuts,
  hasPluginPermission,
  normalizeShortcut,
  parseShortcut,
  pluginBlockKind,
  RESERVED_SHORTCUTS,
  type AppContext,
  type Command,
  type IconComponent,
  type JsonValue,
  type PluginPermission,
  type SidePanelProps,
  type SlashMenuItem,
} from '@tessera/core';
import type { PageChangeEvent, ThemeInfo } from '@tessera/plugin-api';
import { resolveSettingsValues, type SettingPrimitive } from '@tessera/plugin-api/settings';
import type { ComponentType } from 'react';
import {
  PLUGIN_LIMITS,
  PLUGIN_TIMINGS,
  PLUGINS_FEATURE_ID,
  pluginCommandId,
  pluginPanelId,
} from '../constants';
import { PluginCallError } from '../errors';
import { t } from '../i18n';
import type { PluginManager } from '../manager';
import { describePermission, networkSources } from '../manifest';
import { HostEndpoint, type RpcPort } from '../rpc/endpoint';
import {
  errorSchema,
  logSchema,
  resizeSchema,
  unresponsiveSchema,
  workerReadySchema,
  type ApiParams,
  type ConnectionSurface,
  type NotifyMethod,
} from '../rpc/protocol';
import type { Sandbox, SandboxFactory } from '../sandbox/frames';
import type { RuntimeInit } from '../sandbox/runtime-kit';
import type { UiFont, UiSurfaceInit } from '../sandbox/runtime-ui';
import type { InstalledPlugin } from '../store/types';
import { createApiHandlers, type SurfaceApi } from './api';
import type { ConsoleEntry, PluginConsoleStore } from './console';

/** Where a plugin is in its lifecycle in this session. */
export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'crashed' | 'error';

/** What the instance needs from the session. */
export interface InstanceDeps {
  ctx: AppContext;
  manager: PluginManager;
  console: PluginConsoleStore;
  sandboxes: SandboxFactory;
  /** Holds the hidden logic frames. */
  container: HTMLElement;
  /** Holds the renderer frames: out of sight, but laid out (render functions measure text). */
  rendererContainer: HTMLElement;
  /** How long an unused renderer frame stays open (default `PLUGIN_TIMINGS.rendererIdleMs`). */
  rendererIdleMs?: number;
  theme(): ThemeInfo;
  fonts(): Promise<UiFont[]>;
  /** The side-panel component for one plugin panel (React lives outside the instance). */
  panelComponent(pluginId: string, panelId: string): ComponentType<SidePanelProps>;
  /** An icon component showing an emoji. */
  emojiIcon(emoji: string): IconComponent;
  /** Something observable changed (status, registrations). */
  onChange(): void;
}

/** A registered panel. */
export interface PanelRegistration {
  id: string;
  title: string;
  icon?: string;
}

/** A registered custom block. */
export interface BlockRegistration {
  type: string;
  title: string;
  description?: string;
  icon?: string;
  initialData?: JsonValue;
}

/** A panel or block frame, as its React host drives it. */
export interface SurfaceController {
  /** New surface state: the page open (panels); data, read-only and selection (blocks). */
  update(patch: {
    pageId?: string | null;
    data?: JsonValue | null;
    readOnly?: boolean;
    selected?: boolean;
  }): void;
  destroy(): void;
}

/** Callbacks of a surface's React host. */
export interface SurfaceCallbacks extends SurfaceApi {
  onReady(): void;
  onResize?(height: number): void;
  onError(message: string): void;
}

interface Connection {
  surface: ConnectionSurface;
  endpoint: HostEndpoint;
  topics: Set<'pages' | 'storage'>;
}

/** The plugin's shared renderer frame (`manifest.renderer`), while it's open. */
interface RendererFrame {
  sandbox: Sandbox;
  connection: Connection;
  /** Render calls in flight. */
  calls: number;
  idle: ReturnType<typeof setTimeout> | null;
  heartbeat: ReturnType<typeof setTimeout> | null;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One plugin running in one workspace session: its sandboxed worker, heartbeat watchdog,
 * registrations (commands, panels, slash-menu blocks), panel and block frames, and the events it
 * subscribed to. Every failure is contained here and reported in the plugin's console.
 */
export class PluginInstance {
  status: InstanceStatus = 'stopped';
  error: string | null = null;
  /** Increments on every start; async work from an older run is ignored. */
  generation = 0;
  declared: { panels: string[]; blocks: string[] } = { panels: [], blocks: [] };

  private worker: { sandbox: Sandbox; connection: Connection } | null = null;
  private readonly connections = new Set<Connection>();
  private readonly commands = new Map<string, () => void>();
  private readonly panels = new Map<string, { registration: PanelRegistration; off: () => void }>();
  private readonly blocks = new Map<string, { registration: BlockRegistration; off: () => void }>();
  private readonly surfaces = new Set<SurfaceController>();
  /** The frames of the open panels and blocks. */
  private readonly uiSandboxes = new Set<Sandbox>();
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private renderer: RendererFrame | null = null;
  private rendererStart: Promise<RendererFrame> | null = null;
  private notifications: number[] = [];
  private readonly deniedToasts = new Set<string>();
  private lastSettings: Record<string, SettingPrimitive> = {};

  constructor(
    readonly id: string,
    private readonly deps: InstanceDeps,
  ) {}

  /** The installed record (throws once uninstalled). */
  plugin(): InstalledPlugin {
    const plugin = this.deps.manager.get(this.id);
    if (!plugin) throw new PluginCallError('unavailable', t('errStopped'));
    return plugin;
  }

  get registeredPanels(): PanelRegistration[] {
    return [...this.panels.values()].map((entry) => entry.registration);
  }

  get registeredBlocks(): BlockRegistration[] {
    return [...this.blocks.values()].map((entry) => entry.registration);
  }

  get registeredCommands(): string[] {
    return [...this.commands.keys()];
  }

  hasBlock(type: string): boolean {
    return this.blocks.has(type);
  }

  log(
    level: ConsoleEntry['level'],
    message: string,
    options: { surface?: string; source?: ConsoleEntry['source'] } = {},
  ): void {
    const entry: Omit<ConsoleEntry, 'id' | 'time'> = {
      level,
      message,
      source: options.source ?? 'host',
    };
    if (options.surface) entry.surface = options.surface;
    this.deps.console.add(this.id, entry);
  }

  private isStarting(): boolean {
    return this.status === 'starting';
  }

  private setStatus(status: InstanceStatus, error: string | null = null): void {
    this.status = status;
    this.error = error;
    this.deps.onChange();
  }

  private settingsValues(): Record<string, SettingPrimitive> {
    const plugin = this.plugin();
    return resolveSettingsValues(plugin.settingsSchema ?? {}, plugin.settings);
  }

  private runtimeInit(): RuntimeInit {
    const plugin = this.plugin();
    return {
      plugin: {
        id: plugin.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        apiVersion: plugin.manifest.apiVersion,
        permissions: [...plugin.granted],
      },
      settings: this.settingsValues(),
      theme: this.deps.theme(),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /** Starts the plugin: sandbox, load, `ready`, `activate`. Failures end in `error` or `crashed`. */
  async start(): Promise<void> {
    if (this.status === 'starting' || this.status === 'running') return;
    this.generation += 1;
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.setStatus('starting');
    let plugin: InstalledPlugin;
    try {
      plugin = this.plugin();
    } catch {
      this.setStatus('stopped');
      return;
    }
    const code = await this.deps.manager.getCode(this.id);
    if (!current()) return;
    if (!code) {
      this.fail(t('errCrashed', { plugin: plugin.manifest.name, message: 'its code is missing' }));
      return;
    }

    let resolveReady: (value: unknown) => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    const ready = new Promise<unknown>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const readyTimer = setTimeout(
      () => rejectReady(new Error(t('errStartTimeout', { plugin: plugin.manifest.name }))),
      PLUGIN_TIMINGS.startTimeoutMs,
    );

    let sandbox: Sandbox;
    try {
      sandbox = await this.deps.sandboxes.createWorker({
        container: this.deps.container,
        name: `${plugin.manifest.name} (${plugin.id})`,
        code: code.code,
        network: networkSources(plugin.granted),
        init: this.runtimeInit(),
        onControl: (message) => {
          if (message.type === 'boot-error') rejectReady(new Error(message.message));
          else if (message.type === 'worker-error') {
            this.log('error', message.message, { surface: 'worker', source: 'plugin' });
            rejectReady(new Error(message.message));
          }
        },
      });
    } catch (error) {
      clearTimeout(readyTimer);
      if (current()) this.fail(errorMessage(error));
      return;
    }
    if (!current()) {
      clearTimeout(readyTimer);
      sandbox.destroy();
      return;
    }
    const connection = this.connect(sandbox.port, 'worker', {}, (method, params) => {
      if (method === 'ready') resolveReady(params);
      else if (method === 'error') {
        const parsed = errorSchema.safeParse(params);
        if (!parsed.success) return;
        this.log('error', parsed.data.stack ?? parsed.data.message, {
          surface: 'worker',
          source: 'plugin',
        });
        if (parsed.data.fatal) rejectReady(new Error(parsed.data.message));
      }
    });
    this.worker = { sandbox, connection };

    let readyParams: unknown;
    try {
      readyParams = await ready;
    } catch (error) {
      if (current())
        this.fail(t('errCrashed', { plugin: plugin.manifest.name, message: errorMessage(error) }));
      return;
    } finally {
      clearTimeout(readyTimer);
    }
    if (!current()) return;
    const parsed = workerReadySchema.safeParse(readyParams);
    if (!parsed.success) {
      this.fail(
        t('errCrashed', {
          plugin: plugin.manifest.name,
          message: parsed.error.issues[0]?.message ?? 'invalid ready message',
        }),
      );
      return;
    }
    this.declared = { panels: parsed.data.panels, blocks: parsed.data.blocks };
    await this.deps.manager.setSettingsSchema(this.id, parsed.data.settings);
    if (!current()) return;
    this.pushSettings(true);
    this.startHeartbeat(generation);
    try {
      await connection.endpoint.request('activate', undefined, PLUGIN_TIMINGS.activateTimeoutMs);
    } catch (error) {
      if (current() && this.isStarting())
        this.fail(t('errCrashed', { plugin: plugin.manifest.name, message: errorMessage(error) }));
      return;
    }
    if (!current()) return;
    this.setStatus('running');
    this.log('info', `${plugin.manifest.name} ${plugin.manifest.version} started.`);
    // Panel, block and renderer code is instrumented before it runs, once per version: start now,
    // so the first one opens without waiting (large plugins take seconds).
    if (this.declared.panels.length || this.declared.blocks.length)
      this.deps.sandboxes.prepareUi?.(code.code, { slot: plugin.id, hash: plugin.hash });
    if (code.renderer !== undefined)
      this.deps.sandboxes.prepareUi?.(code.renderer, {
        slot: `${plugin.id}/renderer`,
        hash: plugin.hash,
      });
  }

  private startHeartbeat(generation: number): void {
    const tick = async () => {
      const worker = this.worker;
      if (generation !== this.generation || !worker) return;
      try {
        await worker.connection.endpoint.request(
          'ping',
          undefined,
          PLUGIN_TIMINGS.heartbeatTimeoutMs,
        );
      } catch {
        if (generation !== this.generation || this.worker !== worker) return;
        this.crash(
          t('errUnresponsive', {
            plugin: this.deps.manager.get(this.id)?.manifest.name ?? this.id,
          }),
        );
        return;
      }
      if (generation === this.generation)
        this.heartbeat = setTimeout(() => void tick(), PLUGIN_TIMINGS.heartbeatIntervalMs);
    };
    this.heartbeat = setTimeout(() => void tick(), PLUGIN_TIMINGS.heartbeatIntervalMs);
  }

  /** Stops the plugin: `deactivate` (briefly), then removes the sandbox and every registration. */
  async stop(): Promise<void> {
    const worker = this.worker;
    const wasRunning = this.status === 'running';
    this.generation += 1;
    if (worker && wasRunning) {
      try {
        await worker.connection.endpoint.request(
          'deactivate',
          undefined,
          PLUGIN_TIMINGS.deactivateTimeoutMs,
        );
      } catch (error) {
        this.log('warn', `deactivate() failed: ${errorMessage(error)}`);
      }
    }
    this.teardown();
    this.setStatus('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** The plugin misbehaved (unresponsive, tried to escape): stop it and say why. */
  crash(message: string): void {
    this.generation += 1;
    this.log('error', message);
    this.teardown();
    this.setStatus('crashed', message);
    this.deps.ctx.toast({
      title: message,
      variant: 'error',
      action: {
        label: t('restart'),
        onClick: () =>
          void this.restart().catch((error: unknown) => this.log('error', errorMessage(error))),
      },
    });
  }

  /** The plugin failed to load or activate. */
  private fail(message: string): void {
    this.generation += 1;
    this.log('error', message);
    this.teardown();
    this.setStatus('error', message);
  }

  private teardown(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = null;
    if (this.renderer) this.closeRenderer(this.renderer);
    this.rendererStart = null;
    for (const off of this.commands.values()) off();
    this.commands.clear();
    for (const { off } of this.panels.values()) off();
    this.panels.clear();
    for (const { off } of this.blocks.values()) off();
    this.blocks.clear();
    for (const surface of [...this.surfaces]) surface.destroy();
    for (const connection of this.connections) connection.endpoint.dispose();
    this.connections.clear();
    this.worker?.sandbox.destroy();
    this.worker = null;
    this.deniedToasts.clear();
    this.notifications = [];
  }

  // -------------------------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------------------------

  private connect(
    port: RpcPort,
    surface: ConnectionSurface,
    surfaceApi: SurfaceApi,
    onNotify: (method: Exclude<NotifyMethod, 'log'>, params: unknown) => void,
  ): Connection {
    const topics = new Set<'pages' | 'storage'>();
    const handlers = createApiHandlers({
      ctx: this.deps.ctx,
      manager: this.deps.manager,
      plugin: () => this.plugin(),
      registrations: {
        registerCommand: (params) => this.registerCommand(params),
        unregisterCommand: (id) => this.unregister(this.commands, id),
        addPanel: (params) => this.addPanel(params),
        removePanel: (id) => this.unregisterEntry(this.panels, id),
        openPanel: (id) => this.openPanel(id),
        addBlock: (params) => this.addBlock(params),
        removeBlock: (type) => this.unregisterEntry(this.blocks, type),
      },
      connection: {
        surface,
        subscribe: (topic, on) => {
          if (on) topics.add(topic);
          else topics.delete(topic);
        },
      },
      surface: surfaceApi,
      allowNotification: () => this.allowNotification(),
      render: (name, input) => this.render(name, input),
    });
    const endpoint = new HostEndpoint({
      port,
      surface,
      pluginName: () => this.deps.manager.get(this.id)?.manifest.name ?? this.id,
      granted: () => this.deps.manager.get(this.id)?.granted ?? [],
      describe: (permission) => describePermission(permission).action,
      handlers,
      onNotify: (method, params) => {
        if (method === 'log') {
          const parsed = logSchema.safeParse(params);
          if (parsed.success)
            this.log(parsed.data.level, parsed.data.message, { surface, source: 'plugin' });
          return;
        }
        onNotify(method, params);
      },
      onWarning: (message) => this.log('warn', message, { surface }),
      onInternalError: (method, error) =>
        this.log('error', `Tessera failed to handle ${method}: ${errorMessage(error)}`, {
          surface,
        }),
      onPermissionDenied: (permission, method) => this.onPermissionDenied(permission, method),
    });
    const connection: Connection = { surface, endpoint, topics };
    this.connections.add(connection);
    return connection;
  }

  private onPermissionDenied(permission: PluginPermission, method: string): void {
    const plugin = this.deps.manager.get(this.id);
    if (!plugin) return;
    const action = describePermission(permission).action;
    this.log('warn', `Refused ${method}: the "${permission}" permission isn't granted.`);
    if (this.deniedToasts.has(permission)) return;
    this.deniedToasts.add(permission);
    this.deps.ctx.toast({
      title: t('permissionDeniedToast', { plugin: plugin.manifest.name, action }),
      variant: 'warning',
      action: {
        label: t('review'),
        onClick: () =>
          this.deps.ctx.navigateTo(`/settings/plugins?plugin=${encodeURIComponent(this.id)}`),
      },
    });
  }

  private allowNotification(): boolean {
    const now = Date.now();
    this.notifications = this.notifications.filter(
      (time) => now - time < PLUGIN_LIMITS.notifyWindowMs,
    );
    if (this.notifications.length >= PLUGIN_LIMITS.notifyCount) return false;
    this.notifications.push(now);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Registrations
  // -------------------------------------------------------------------------------------------

  private unregister(map: Map<string, () => void>, id: string): void {
    map.get(id)?.();
    if (map.delete(id)) this.deps.onChange();
  }

  private unregisterEntry(map: Map<string, { off: () => void }>, id: string): void {
    map.get(id)?.off();
    if (map.delete(id)) this.deps.onChange();
  }

  private registerCommand(params: ApiParams<'commands.register'>): void {
    if (!this.commands.has(params.id) && this.commands.size >= PLUGIN_LIMITS.commands)
      throw new PluginCallError(
        'invalid',
        `A plugin can register at most ${PLUGIN_LIMITS.commands} commands`,
      );
    const plugin = this.plugin();
    const fullId = pluginCommandId(this.id, params.id);
    this.unregister(this.commands, params.id);
    const command: Command = {
      id: fullId,
      title: `${plugin.manifest.name}: ${params.title}`,
      group: 'plugins',
      keywords: [...(params.keywords ?? []), plugin.manifest.name],
      icon: this.deps.emojiIcon(plugin.manifest.icon ?? '🧩'),
      run: ({ pageId }) => this.runCommand(params.id, pageId),
    };
    const shortcut = params.shortcut ? this.acceptShortcut(params.shortcut, fullId) : null;
    if (shortcut) command.shortcut = shortcut;
    this.commands.set(params.id, this.deps.ctx.commands.register(command));
    this.deps.onChange();
  }

  /** A shortcut is kept only when it's valid, uses a modifier, and no other command has it. */
  private acceptShortcut(shortcut: string, commandId: string): string | null {
    let normalized: string;
    try {
      const parsed = parseShortcut(shortcut);
      if (![...parsed.modifiers].some((modifier) => modifier !== 'Shift')) {
        this.log(
          'warn',
          `Shortcut "${shortcut}" needs Mod, Ctrl, Alt or Meta, so it was left out.`,
        );
        return null;
      }
      normalized = normalizeShortcut(shortcut);
    } catch {
      this.log('warn', `Shortcut "${shortcut}" isn't valid, so it was left out.`);
      return null;
    }
    const taken =
      RESERVED_SHORTCUTS[normalized] !== undefined ||
      this.deps.ctx.commands
        .list()
        .some(
          (other) =>
            other.id !== commandId &&
            commandShortcuts(other).some((existing) => normalizeShortcut(existing) === normalized),
        );
    if (taken) {
      this.log('warn', t('errShortcutTaken', { shortcut: normalized }));
      return null;
    }
    return normalized;
  }

  async runCommand(commandId: string, pageId: string | null): Promise<void> {
    const worker = this.worker;
    const name = this.deps.manager.get(this.id)?.manifest.name ?? this.id;
    if (!worker || this.status !== 'running') {
      this.deps.ctx.toast({ title: t('errStopped'), variant: 'error' });
      return;
    }
    try {
      await worker.connection.endpoint.request(
        'command.run',
        { id: commandId, pageId },
        PLUGIN_TIMINGS.commandTimeoutMs,
      );
    } catch (error) {
      if (this.worker !== worker) return; // It crashed; the crash was reported.
      this.log('error', `Command "${commandId}" failed: ${errorMessage(error)}`, {
        surface: 'worker',
      });
      this.deps.ctx.toast({
        title: t('commandFailed', { plugin: name }),
        description: errorMessage(error),
        variant: 'error',
      });
    }
  }

  private addPanel(params: ApiParams<'ui.addPanel'>): void {
    if (!this.declared.panels.includes(params.id))
      throw new PluginCallError('invalid', t('errNoRenderer', { id: params.id }));
    if (!this.panels.has(params.id) && this.panels.size >= PLUGIN_LIMITS.panels)
      throw new PluginCallError(
        'invalid',
        `A plugin can add at most ${PLUGIN_LIMITS.panels} panels`,
      );
    const plugin = this.plugin();
    this.unregisterEntry(this.panels, params.id);
    const registration: PanelRegistration = { id: params.id, title: params.title };
    if (params.icon) registration.icon = params.icon;
    const off = this.deps.ctx.contributions.register(
      'pageSidePanels',
      {
        id: pluginPanelId(this.id, params.id),
        title: params.title,
        icon: this.deps.emojiIcon(params.icon ?? plugin.manifest.icon ?? '🧩'),
        order: 100,
        component: this.deps.panelComponent(this.id, params.id),
      },
      PLUGINS_FEATURE_ID,
    );
    this.panels.set(params.id, { registration, off });
    this.deps.onChange();
  }

  private openPanel(id: string): void {
    if (!this.panels.has(id))
      throw new PluginCallError(
        'not_found',
        `Panel "${id}" isn't registered. Call api.ui.addPanel first.`,
      );
    this.deps.ctx.openSidePanel(pluginPanelId(this.id, id));
  }

  private addBlock(params: ApiParams<'ui.addBlock'>): void {
    if (!this.declared.blocks.includes(params.type))
      throw new PluginCallError('invalid', t('errNoRenderer', { id: params.type }));
    if (!this.blocks.has(params.type) && this.blocks.size >= PLUGIN_LIMITS.blocks)
      throw new PluginCallError(
        'invalid',
        `A plugin can add at most ${PLUGIN_LIMITS.blocks} blocks`,
      );
    const plugin = this.plugin();
    this.unregisterEntry(this.blocks, params.type);
    const kind = pluginBlockKind(this.id, params.type);
    const initialData = params.initialData ?? null;
    const item: SlashMenuItem = {
      id: kind,
      title: params.title,
      group: 'plugins',
      icon: params.icon ?? plugin.manifest.icon ?? '🧩',
      keywords: [...(params.keywords ?? []), plugin.manifest.name],
      create: () => ({ kind, data: structuredClone(initialData) }),
    };
    if (params.description) item.description = params.description;
    const registration: BlockRegistration = { type: params.type, title: params.title };
    if (params.description) registration.description = params.description;
    if (params.icon) registration.icon = params.icon;
    if (params.initialData !== undefined) registration.initialData = params.initialData;
    const off = this.deps.ctx.blocks.registerSlashMenuItems([item]);
    this.blocks.set(params.type, { registration, off });
    this.deps.onChange();
  }

  // -------------------------------------------------------------------------------------------
  // Events from the host
  // -------------------------------------------------------------------------------------------

  /** Sends the current settings to every connection (after a change, or `force` at start). */
  pushSettings(force = false): void {
    let values: Record<string, SettingPrimitive>;
    try {
      values = this.settingsValues();
    } catch {
      return;
    }
    const changed = Object.keys(values).filter((key) => values[key] !== this.lastSettings[key]);
    this.lastSettings = values;
    if (!force && changed.length === 0) return;
    const keys = changed.length ? changed : [''];
    for (const connection of this.connections)
      for (const key of keys) connection.endpoint.emit('settings.changed', { values, key });
  }

  pushTheme(theme: ThemeInfo): void {
    for (const sandbox of this.uiSandboxes) sandbox.setColorScheme(theme.mode);
    for (const connection of this.connections) connection.endpoint.emit('theme.changed', { theme });
  }

  forwardPageEvent(event: PageChangeEvent): void {
    if (!hasPluginPermission(this.deps.manager.get(this.id)?.granted ?? [], 'pages:read')) return;
    for (const connection of this.connections)
      if (connection.topics.has('pages')) connection.endpoint.emit('pages.changed', event);
  }

  async forwardStorage(key: string): Promise<void> {
    const listening = [...this.connections].filter((connection) =>
      connection.topics.has('storage'),
    );
    if (!listening.length) return;
    const value = await this.deps.manager.storageGet(this.id, key);
    for (const connection of listening)
      connection.endpoint.emit('storage.changed', value === undefined ? { key } : { key, value });
  }

  // -------------------------------------------------------------------------------------------
  // The renderer
  // -------------------------------------------------------------------------------------------

  /**
   * Runs one of the plugin's render functions (`api.ui.render`) in its renderer frame: one hidden
   * frame per plugin, opened on the first call and shared by all its panels and blocks, so a
   * heavy library loads once. It closes when unused for a while, and opens again when needed.
   */
  async render(name: string, input: JsonValue): Promise<unknown> {
    const plugin = this.plugin();
    if (!plugin.manifest.renderer)
      throw new PluginCallError(
        'not_found',
        t('errNoRendererModule', { plugin: plugin.manifest.name }),
      );
    const frame = await this.openRenderer();
    frame.calls += 1;
    this.idleRenderer(frame);
    try {
      return await frame.connection.endpoint.request(
        'render',
        { name, input },
        PLUGIN_TIMINGS.renderTimeoutMs,
      );
    } finally {
      frame.calls -= 1;
      this.idleRenderer(frame);
    }
  }

  private openRenderer(): Promise<RendererFrame> {
    if (this.renderer) return Promise.resolve(this.renderer);
    this.rendererStart ??= this.startRenderer().finally(() => {
      this.rendererStart = null;
    });
    return this.rendererStart;
  }

  private async startRenderer(): Promise<RendererFrame> {
    const generation = this.generation;
    const plugin = this.plugin();
    const name = plugin.manifest.name;
    const stopped = () => new PluginCallError('unavailable', t('errStopped'));
    const [code, fonts] = await Promise.all([
      this.deps.manager.getCode(this.id),
      this.deps.fonts(),
    ]);
    if (generation !== this.generation) throw stopped();
    if (code?.renderer === undefined)
      throw new PluginCallError('not_found', t('errNoRendererModule', { plugin: name }));
    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const sandbox = await this.deps.sandboxes.createUi({
      container: this.deps.rendererContainer,
      kind: 'renderer',
      title: t('rendererFrameTitle', { plugin: name }),
      code: code.renderer,
      cacheKey: { slot: `${plugin.id}/renderer`, hash: plugin.hash },
      network: networkSources(plugin.granted),
      init: { ...this.runtimeInit(), surface: { kind: 'renderer' }, fonts },
      onControl: (message) => {
        if (message.type === 'navigation') {
          this.log('error', 'The renderer tried to navigate away; navigation is blocked.', {
            surface: 'renderer',
          });
          this.crash(t('errNavigation', { plugin: name }));
        } else if (message.type === 'boot-error') rejectReady(new Error(message.message));
      },
    });
    if (generation !== this.generation) {
      sandbox.destroy();
      throw stopped();
    }
    let frame: RendererFrame | null = null;
    const connection = this.connect(sandbox.port, 'renderer', {}, (method, params) => {
      if (method === 'rendered') resolveReady();
      else if (method === 'error') {
        const parsed = errorSchema.safeParse(params);
        if (!parsed.success) return;
        this.log('error', parsed.data.stack ?? parsed.data.message, {
          surface: 'renderer',
          source: 'plugin',
        });
        if (parsed.data.fatal) rejectReady(new Error(parsed.data.message));
      } else if (method === 'unresponsive') {
        // Its guard stopped code that ran too long without a break (`instrument.ts`).
        const parsed = unresponsiveSchema.safeParse(params);
        const seconds = parsed.success ? ` for ${(parsed.data.ms / 1000).toFixed(1)} s` : '';
        rejectReady(new Error(t('errRendererUnresponsive', { plugin: name })));
        if (frame) this.closeRenderer(frame, `ran without a break${seconds}`);
      }
    });
    frame = { sandbox, connection, calls: 0, idle: null, heartbeat: null };
    const timer = setTimeout(
      () => rejectReady(new Error(t('errStartTimeout', { plugin: name }))),
      PLUGIN_TIMINGS.startTimeoutMs,
    );
    try {
      await ready;
    } catch (error) {
      this.closeRenderer(frame);
      this.log('error', `The renderer couldn't start: ${errorMessage(error)}`, {
        surface: 'renderer',
      });
      throw new PluginCallError('unavailable', errorMessage(error));
    } finally {
      clearTimeout(timer);
    }
    if (generation !== this.generation) {
      this.closeRenderer(frame);
      throw stopped();
    }
    this.renderer = frame;
    this.beatRenderer(frame);
    return frame;
  }

  /** Pings the renderer like a panel: one that stops answering is closed. */
  private beatRenderer(frame: RendererFrame): void {
    const beat = async () => {
      if (this.renderer !== frame) return;
      try {
        await frame.connection.endpoint.request(
          'ping',
          undefined,
          PLUGIN_TIMINGS.heartbeatTimeoutMs,
        );
      } catch {
        if (this.renderer === frame) this.closeRenderer(frame, 'stopped responding');
        return;
      }
      this.beatRenderer(frame);
    };
    frame.heartbeat = setTimeout(() => void beat(), PLUGIN_TIMINGS.heartbeatIntervalMs * 2);
  }

  /** Closes the renderer once nothing has called it for a while. */
  private idleRenderer(frame: RendererFrame): void {
    if (frame.idle) clearTimeout(frame.idle);
    frame.idle = null;
    if (frame.calls > 0 || this.renderer !== frame) return;
    frame.idle = setTimeout(() => {
      if (this.renderer === frame && frame.calls === 0) this.closeRenderer(frame);
    }, this.deps.rendererIdleMs ?? PLUGIN_TIMINGS.rendererIdleMs);
  }

  /**
   * Removes the renderer frame. With `why` (it misbehaved), says so in the console, and calls in
   * flight fail with a message saying the renderer stopped responding.
   */
  private closeRenderer(frame: RendererFrame, why?: string): void {
    if (frame.idle) clearTimeout(frame.idle);
    if (frame.heartbeat) clearTimeout(frame.heartbeat);
    if (this.renderer === frame) this.renderer = null;
    const name = this.deps.manager.get(this.id)?.manifest.name ?? this.id;
    if (why) this.log('error', `The renderer ${why} and was closed.`, { surface: 'renderer' });
    frame.connection.endpoint.dispose(
      why
        ? new PluginCallError('unavailable', t('errRendererUnresponsive', { plugin: name }))
        : undefined,
    );
    this.connections.delete(frame.connection);
    frame.sandbox.destroy();
  }

  // -------------------------------------------------------------------------------------------
  // Panels and blocks
  // -------------------------------------------------------------------------------------------

  /**
   * Renders a panel or block in a new sandboxed frame inside `container`. The frame is removed
   * when the controller is destroyed, or when the plugin stops.
   */
  mountSurface(options: {
    container: HTMLElement;
    surface: UiSurfaceInit;
    title: string;
    callbacks: SurfaceCallbacks;
  }): SurfaceController {
    const generation = this.generation;
    const { callbacks, surface } = options;
    let destroyed = false;
    let sandbox: Sandbox | null = null;
    let connection: Connection | null = null;
    let heartbeat: ReturnType<typeof setTimeout> | null = null;
    let pending: Parameters<SurfaceController['update']>[0] = {};

    const send = (patch: Parameters<SurfaceController['update']>[0]) => {
      if (!connection) return;
      if (surface.kind === 'panel' && 'pageId' in patch)
        connection.endpoint.emit('panel.page', { pageId: patch.pageId ?? null });
      if (surface.kind === 'block') {
        const state: Record<string, unknown> = {};
        if ('data' in patch) state.data = patch.data ?? null;
        if (patch.readOnly !== undefined) state.readOnly = patch.readOnly;
        if (patch.selected !== undefined) state.selected = patch.selected;
        if (Object.keys(state).length) connection.endpoint.emit('block.state', state);
      }
    };
    const controller: SurfaceController = {
      update(patch) {
        if (connection) send(patch);
        else pending = { ...pending, ...patch };
      },
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        if (heartbeat) clearTimeout(heartbeat);
        if (connection) {
          connection.endpoint.dispose();
          this.connections.delete(connection);
        }
        if (sandbox) this.uiSandboxes.delete(sandbox);
        sandbox?.destroy();
        this.surfaces.delete(controller);
      },
    };
    this.surfaces.add(controller);

    const run = async () => {
      const plugin = this.plugin();
      const [code, fonts] = await Promise.all([
        this.deps.manager.getCode(this.id),
        this.deps.fonts(),
      ]);
      if (destroyed || generation !== this.generation) return;
      if (!code) throw new Error(t('errStopped'));
      const init = this.runtimeInit();
      const created = await this.deps.sandboxes.createUi({
        container: options.container,
        title: options.title,
        code: code.code,
        cacheKey: { slot: plugin.id, hash: plugin.hash },
        network: networkSources(plugin.granted),
        init: { ...init, surface: applyPatch(surface, pending), fonts },
        onControl: (message) => {
          if (message.type === 'navigation') {
            this.log(
              'error',
              `A ${surface.kind} frame tried to navigate away; navigation is blocked.`,
              {
                surface: surface.kind,
              },
            );
            this.crash(t('errNavigation', { plugin: plugin.manifest.name }));
          } else if (message.type === 'boot-error') callbacks.onError(message.message);
        },
      });
      if (destroyed || generation !== this.generation) {
        created.destroy();
        return;
      }
      sandbox = created;
      this.uiSandboxes.add(created);
      pending = {};
      /** Closes the frame of a surface that stopped responding, and says so in its place. */
      const close = (why: string) => {
        this.log('error', `A ${surface.kind} ${why} and was closed.`, { surface: surface.kind });
        callbacks.onError(t('errUnresponsive', { plugin: plugin.manifest.name }));
        controller.destroy();
      };
      connection = this.connect(created.port, surface.kind, callbacks, (method, params) => {
        if (method === 'rendered') callbacks.onReady();
        else if (method === 'resize') {
          const parsed = resizeSchema.safeParse(params);
          if (parsed.success) callbacks.onResize?.(parsed.data.height);
        } else if (method === 'error') {
          const parsed = errorSchema.safeParse(params);
          if (!parsed.success) return;
          this.log('error', parsed.data.stack ?? parsed.data.message, {
            surface: surface.kind,
            source: 'plugin',
          });
          if (parsed.data.fatal) callbacks.onError(parsed.data.message);
        } else if (method === 'unresponsive') {
          // The frame's guard stopped code that ran too long without a break (`instrument.ts`).
          const parsed = unresponsiveSchema.safeParse(params);
          const seconds = parsed.success ? ` for ${(parsed.data.ms / 1000).toFixed(1)} s` : '';
          close(`ran without a break${seconds}`);
        }
      });
      const beat = async () => {
        const current = connection;
        if (destroyed || !current) return;
        try {
          await current.endpoint.request('ping', undefined, PLUGIN_TIMINGS.heartbeatTimeoutMs);
        } catch {
          if (destroyed || connection !== current) return;
          close('stopped responding');
          return;
        }
        heartbeat = setTimeout(() => void beat(), PLUGIN_TIMINGS.heartbeatIntervalMs * 2);
      };
      heartbeat = setTimeout(() => void beat(), PLUGIN_TIMINGS.heartbeatIntervalMs * 2);
    };
    run().catch((error: unknown) => {
      if (!destroyed) callbacks.onError(errorMessage(error));
    });
    return controller;
  }
}

/** Applies updates that arrived before the frame existed to its initial surface state. */
function applyPatch(
  surface: UiSurfaceInit,
  patch: Parameters<SurfaceController['update']>[0],
): UiSurfaceInit {
  if (surface.kind === 'panel')
    return 'pageId' in patch ? { ...surface, pageId: patch.pageId ?? null } : surface;
  const next = { ...surface };
  if ('data' in patch) next.data = patch.data ?? null;
  if (patch.readOnly !== undefined) next.readOnly = patch.readOnly;
  if (patch.selected !== undefined) next.selected = patch.selected;
  return next;
}
