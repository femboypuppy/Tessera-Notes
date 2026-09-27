import type { AppContext, IconComponent, SidePanelProps } from '@tessera/core';
import type { PageChangeEvent, ThemeInfo } from '@tessera/plugin-api';
import type { ComponentType } from 'react';
import type { PluginChange, PluginManager } from '../manager';
import type { SandboxFactory } from '../sandbox/frames';
import type { UiFont } from '../sandbox/runtime-ui';
import { t } from '../i18n';
import type { PluginConsoleStore } from './console';
import { watchDevPlugin, type DevStatus } from './dev';
import { PluginInstance, type InstanceDeps } from './instance';

/** Options of {@link PluginHost}. */
export interface PluginHostOptions {
  manager: PluginManager;
  console: PluginConsoleStore;
  sandboxes: SandboxFactory;
  theme: {
    read(): ThemeInfo;
    watch(listener: (theme: ThemeInfo) => void): () => void;
    fonts(): Promise<UiFont[]>;
  };
  panelComponent(pluginId: string, panelId: string): ComponentType<SidePanelProps>;
  emojiIcon(emoji: string): IconComponent;
  /** Where the hidden logic frames go. Default: a hidden element appended to `document.body`. */
  container?: HTMLElement;
  /** Where renderer frames go. Default: an element out of sight, appended to `document.body`. */
  rendererContainer?: HTMLElement;
  /** How long an unused renderer frame stays open (tests shorten it). */
  rendererIdleMs?: number;
  /** Dev-mode polling interval (tests shorten it). */
  devIntervalMs?: number;
}

/**
 * Runs the enabled plugins of this device inside one workspace session. It follows the plugin
 * manager (install, update, enable, disable, permission changes restart plugins), forwards app
 * events to the plugins that subscribed, and exposes status to the settings UI.
 */
export class PluginHost {
  private readonly instances = new Map<string, PluginInstance>();
  private readonly listeners = new Set<() => void>();
  private readonly offs: Array<() => void> = [];
  private version = 0;
  private theme: ThemeInfo;
  private container: HTMLElement | null = null;
  private rendererContainer: HTMLElement | null = null;
  private ownsContainer = false;
  private ownsRendererContainer = false;
  private disposed = false;
  private readonly devWatchers = new Map<string, { url: string; stop: () => void }>();
  private readonly devStatuses = new Map<string, DevStatus>();

  constructor(
    readonly ctx: AppContext,
    private readonly options: PluginHostOptions,
  ) {
    this.theme = options.theme.read();
  }

  get manager(): PluginManager {
    return this.options.manager;
  }

  get console(): PluginConsoleStore {
    return this.options.console;
  }

  /** Starts every enabled plugin and begins following changes. */
  async start(): Promise<void> {
    if (this.options.container) this.container = this.options.container;
    else {
      const container = document.createElement('div');
      container.hidden = true;
      container.setAttribute('data-tessera-plugin-sandboxes', '');
      document.body.append(container);
      this.container = container;
      this.ownsContainer = true;
    }
    if (this.options.rendererContainer) this.rendererContainer = this.options.rendererContainer;
    else {
      // Renderer frames draw for others (a diagram library measures text), so they need layout:
      // this box is laid out, but out of sight, out of the way and hidden from assistive tech.
      const box = document.createElement('div');
      box.setAttribute('data-tessera-plugin-renderers', '');
      box.setAttribute('aria-hidden', 'true');
      box.inert = true;
      box.style.cssText =
        'position:fixed;top:0;left:-10000px;width:1200px;height:900px;visibility:hidden;pointer-events:none;contain:strict';
      document.body.append(box);
      this.rendererContainer = box;
      this.ownsRendererContainer = true;
    }
    const { ctx } = this;
    const { manager } = this.options;
    this.offs.push(
      this.options.theme.watch((theme) => {
        this.theme = theme;
        for (const instance of this.instances.values()) instance.pushTheme(theme);
      }),
      manager.subscribe((change) => this.onManagerChange(change)),
      ctx.events.on('page.created', ({ page, local }) =>
        this.forward({ type: 'created', pageId: page.id, local }),
      ),
      ctx.events.on('page.updated', ({ page, fields, local }) => {
        if (!fields.includes('trashedAt'))
          this.forward({ type: 'updated', pageId: page.id, local });
      }),
      ctx.events.on('page.trashed', ({ pageId, local }) =>
        this.forward({ type: 'trashed', pageId, local }),
      ),
      ctx.events.on('page.restored', ({ pageId, local }) =>
        this.forward({ type: 'restored', pageId, local }),
      ),
      ctx.events.on('page.deleted', ({ pageId, local }) =>
        this.forward({ type: 'deleted', pageId, local }),
      ),
      ctx.events.on('doc.changed', ({ pageId, local }) =>
        this.forward({ type: 'content', pageId, local }),
      ),
    );
    await manager.ready;
    if (this.disposed) return;
    this.syncDevWatchers();
    await Promise.all(
      manager
        .getSnapshot()
        .filter((plugin) => plugin.enabled)
        .map((plugin) => this.ensure(plugin.id).start()),
    );
  }

  private forward(event: PageChangeEvent): void {
    for (const instance of this.instances.values()) instance.forwardPageEvent(event);
  }

  private ensure(id: string): PluginInstance {
    let instance = this.instances.get(id);
    if (!instance) {
      const container = this.container ?? document.body;
      const deps: InstanceDeps = {
        ctx: this.ctx,
        manager: this.options.manager,
        console: this.options.console,
        sandboxes: this.options.sandboxes,
        container,
        rendererContainer: this.rendererContainer ?? container,
        theme: () => this.theme,
        fonts: () => this.options.theme.fonts(),
        panelComponent: this.options.panelComponent,
        emojiIcon: this.options.emojiIcon,
        onChange: () => this.changed(),
      };
      if (this.options.rendererIdleMs !== undefined)
        deps.rendererIdleMs = this.options.rendererIdleMs;
      instance = new PluginInstance(id, deps);
      this.instances.set(id, instance);
      this.changed();
    }
    return instance;
  }

  private onManagerChange(change: PluginChange): void {
    if (this.disposed) return;
    const plugin = this.options.manager.get(change.id);
    const instance = this.instances.get(change.id);
    switch (change.type) {
      case 'installed':
        if (plugin?.enabled) void this.ensure(change.id).start();
        break;
      case 'updated':
      case 'permissions':
        if (plugin?.enabled) void this.ensure(change.id).restart();
        else if (instance) void instance.stop();
        break;
      case 'enabled':
        void this.ensure(change.id).start();
        break;
      case 'disabled':
        if (instance) void instance.stop();
        break;
      case 'uninstalled':
        if (instance) {
          void instance.stop();
          this.instances.delete(change.id);
        }
        this.options.console.clear(change.id);
        this.options.sandboxes.forget?.(change.id);
        break;
      case 'settings':
        instance?.pushSettings();
        break;
      case 'storage':
        void instance?.forwardStorage(change.key);
        break;
      case 'schema':
        break;
    }
    if (change.type !== 'storage' && change.type !== 'settings') this.syncDevWatchers();
    this.changed();
  }

  /** Watches the dev server of every enabled dev-mode plugin, and nothing else. */
  private syncDevWatchers(): void {
    const { manager } = this.options;
    const wanted = new Map<string, string>();
    for (const plugin of manager.getSnapshot()) {
      if (plugin.enabled && plugin.source.kind === 'dev' && plugin.source.url)
        wanted.set(plugin.id, plugin.source.url);
    }
    for (const [id, watcher] of this.devWatchers) {
      if (wanted.get(id) === watcher.url) continue;
      watcher.stop();
      this.devWatchers.delete(id);
      this.devStatuses.delete(id);
    }
    for (const [id, url] of wanted) {
      if (this.devWatchers.has(id)) continue;
      const options: Parameters<typeof watchDevPlugin>[0] = {
        manager,
        pluginId: id,
        url,
        onStatus: (status) => {
          this.devStatuses.set(id, status);
          this.changed();
        },
        onNewPermissions: () => {
          const name = manager.get(id)?.manifest.name ?? id;
          this.ctx.toast({
            title: t('devNewPermissions', { plugin: name }),
            variant: 'warning',
            action: {
              label: t('review'),
              onClick: () =>
                this.ctx.navigateTo(`/settings/plugins?plugin=${encodeURIComponent(id)}`),
            },
          });
        },
      };
      if (this.options.devIntervalMs) options.intervalMs = this.options.devIntervalMs;
      this.devWatchers.set(id, { url, stop: watchDevPlugin(options) });
    }
  }

  /** Live-reload status of a dev-mode plugin. */
  devStatus(id: string): DevStatus | undefined {
    return this.devStatuses.get(id);
  }

  instance(id: string): PluginInstance | undefined {
    return this.instances.get(id);
  }

  /** Restarts a plugin (after a crash, or from the settings UI). */
  restart(id: string): Promise<void> {
    return this.ensure(id).restart();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  /** Stops every plugin and removes their frames. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
    for (const watcher of this.devWatchers.values()) watcher.stop();
    this.devWatchers.clear();
    await Promise.all([...this.instances.values()].map((instance) => instance.stop()));
    this.instances.clear();
    if (this.ownsContainer) this.container?.remove();
    if (this.ownsRendererContainer) this.rendererContainer?.remove();
    this.container = null;
    this.rendererContainer = null;
    this.listeners.clear();
  }
}
