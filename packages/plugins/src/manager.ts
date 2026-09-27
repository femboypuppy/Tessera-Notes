import { isJsonValue, jsonEqual, type JsonValue, type PluginPermission } from '@tessera/core';
import type { SettingsSchema } from '@tessera/plugin-api';
import { validateSettingValue, type SettingPrimitive } from '@tessera/plugin-api/settings';
import { hashBundle, type PluginBundle } from './bundle';
import { PLUGIN_LIMITS } from './constants';
import { PluginCallError } from './errors';
import { t } from './i18n';
import { compareVersions } from './manifest';
import type {
  InstalledPlugin,
  InstalledPluginCode,
  PluginSource,
  PluginStore,
} from './store/types';

/** A change to the installed plugins. */
export type PluginChange =
  | {
      type:
        | 'installed'
        | 'updated'
        | 'uninstalled'
        | 'enabled'
        | 'disabled'
        | 'permissions'
        | 'settings'
        | 'schema';
      id: string;
    }
  | { type: 'storage'; id: string; key: string };

/** What installing a bundle would do (shown in the permission prompt). */
export interface InstallPlan {
  bundle: PluginBundle;
  existing?: InstalledPlugin;
  kind: 'install' | 'update' | 'reinstall' | 'downgrade';
  /** Permissions the prompt lists: every permission for a new plugin. */
  requested: PluginPermission[];
  /** Permissions the installed version didn't ask for (updates only). */
  added: PluginPermission[];
}

/** Options of {@link PluginManager.install}. */
export interface InstallOptions {
  /** Permissions the user approved (anything not in the manifest is dropped). */
  granted: readonly PluginPermission[];
  source: PluginSource;
  /** Default: true for new plugins, unchanged for updates. */
  enabled?: boolean;
}

/** A channel to other tabs (BroadcastChannel in browsers). */
export interface ChangeChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

const encoder = new TextEncoder();
const jsonSize = (value: JsonValue) => JSON.stringify(value).length;

/**
 * Installed plugins on this device: install, update, uninstall, enable, grants, settings and
 * private storage with quotas. One per app (the host of each workspace session uses it). Changes
 * reach other tabs through a BroadcastChannel.
 */
export class PluginManager {
  private plugins = new Map<string, InstalledPlugin>();
  private snapshot: readonly InstalledPlugin[] = [];
  private readonly listeners = new Set<(change: PluginChange) => void>();
  private readonly snapshotListeners = new Set<() => void>();
  private readonly storageSizes = new Map<string, Map<string, number>>();
  private readonly queue = new Map<string, Promise<unknown>>();
  private disposed = false;
  /** Resolves once the installed plugins are loaded. */
  readonly ready: Promise<void>;

  constructor(
    private readonly store: PluginStore,
    private readonly options: { now?: () => number; channel?: ChangeChannel | null } = {},
  ) {
    this.ready = this.reload();
    options.channel?.addEventListener('message', (event) => {
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const change = data as Partial<PluginChange>;
      if (typeof change.type !== 'string' || typeof change.id !== 'string') return;
      void this.onRemoteChange(change as PluginChange);
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async reload(id?: string): Promise<void> {
    if (id) {
      const plugin = await this.store.get(id);
      if (plugin) this.plugins.set(id, plugin);
      else this.plugins.delete(id);
    } else {
      const list = await this.store.list();
      this.plugins = new Map(list.map((plugin) => [plugin.id, plugin]));
    }
    this.snapshot = [...this.plugins.values()].sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
    );
    for (const listener of [...this.snapshotListeners]) listener();
  }

  private async onRemoteChange(change: PluginChange): Promise<void> {
    if (this.disposed) return;
    if (change.type === 'storage') {
      this.storageSizes.delete(change.id);
    } else {
      if (change.type === 'uninstalled') this.storageSizes.delete(change.id);
      await this.reload(change.id);
    }
    this.emit(change, false);
  }

  private emit(change: PluginChange, broadcast = true): void {
    if (broadcast) this.options.channel?.postMessage(change);
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error('[plugins] change listener failed', error);
      }
    }
  }

  /** Runs operations on one plugin one at a time, so storage quotas and records stay consistent. */
  private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(id) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.catch(() => undefined);
    this.queue.set(id, settled);
    void settled.then(() => {
      if (this.queue.get(id) === settled) this.queue.delete(id);
    });
    return next;
  }

  private async save(plugin: InstalledPlugin, change: PluginChange): Promise<InstalledPlugin> {
    await this.store.put(plugin);
    await this.reload(plugin.id);
    this.emit(change);
    return this.require(plugin.id);
  }

  private require(id: string): InstalledPlugin {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new PluginCallError('not_found', `Plugin "${id}" isn't installed`);
    return plugin;
  }

  /** Installed plugins, sorted by name (a stable snapshot for `useSyncExternalStore`). */
  getSnapshot = (): readonly InstalledPlugin[] => this.snapshot;

  /** Re-renders on any change of the snapshot. */
  subscribeSnapshot = (listener: () => void): (() => void) => {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  };

  /** Detailed changes (the host restarts plugins from them). */
  subscribe(listener: (change: PluginChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(id: string): InstalledPlugin | undefined {
    return this.plugins.get(id);
  }

  /** What installing this bundle would do, for the permission prompt. */
  plan(bundle: PluginBundle): InstallPlan {
    const existing = this.plugins.get(bundle.manifest.id);
    const requested = [...bundle.manifest.permissions];
    if (!existing) return { bundle, kind: 'install', requested, added: requested };
    const order = compareVersions(bundle.manifest.version, existing.manifest.version);
    const known = new Set(existing.manifest.permissions);
    const added = requested.filter((permission) => !known.has(permission));
    return {
      bundle,
      existing,
      kind: order > 0 ? 'update' : order < 0 ? 'downgrade' : 'reinstall',
      requested,
      added,
    };
  }

  /**
   * Installs or updates a plugin. Updates keep the plugin's storage, settings and enabled state;
   * permissions the user revoked stay revoked unless `granted` includes them again.
   */
  install(bundle: PluginBundle, options: InstallOptions): Promise<InstalledPlugin> {
    const { manifest } = bundle;
    return this.serial(manifest.id, async () => {
      const existing = this.plugins.get(manifest.id);
      const allowed = new Set(manifest.permissions);
      const granted = [...new Set(options.granted)].filter((permission) => allowed.has(permission));
      const now = this.now();
      const plugin: InstalledPlugin = {
        id: manifest.id,
        manifest,
        enabled: options.enabled ?? existing?.enabled ?? true,
        granted,
        source: options.source,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        hash: await hashBundle(bundle),
        settings: existing?.settings ?? {},
      };
      if (existing?.settingsSchema) plugin.settingsSchema = existing.settingsSchema;
      const code: InstalledPluginCode = { code: bundle.code };
      if (bundle.renderer !== undefined) code.renderer = bundle.renderer;
      if (bundle.readme !== undefined) code.readme = bundle.readme;
      await this.store.put(plugin, code);
      await this.reload(manifest.id);
      this.emit({ type: existing ? 'updated' : 'installed', id: manifest.id });
      return this.require(manifest.id);
    });
  }

  /** Removes a plugin, its code and everything it stored. */
  uninstall(id: string): Promise<void> {
    return this.serial(id, async () => {
      this.require(id);
      await this.store.delete(id);
      this.storageSizes.delete(id);
      await this.reload(id);
      this.emit({ type: 'uninstalled', id });
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<InstalledPlugin> {
    return this.serial(id, async () => {
      const plugin = this.require(id);
      if (plugin.enabled === enabled) return plugin;
      return this.save(
        { ...plugin, enabled, updatedAt: this.now() },
        { type: enabled ? 'enabled' : 'disabled', id },
      );
    });
  }

  /** Replaces the granted permissions (only ones the manifest asks for are kept). */
  setGranted(id: string, granted: readonly PluginPermission[]): Promise<InstalledPlugin> {
    return this.serial(id, async () => {
      const plugin = this.require(id);
      const allowed = new Set(plugin.manifest.permissions);
      const next = plugin.manifest.permissions.filter(
        (permission) => allowed.has(permission) && granted.includes(permission),
      );
      if (next.length === plugin.granted.length && next.every((p) => plugin.granted.includes(p)))
        return plugin;
      return this.save({ ...plugin, granted: next }, { type: 'permissions', id });
    });
  }

  /** Grants or revokes one permission. */
  async setPermission(id: string, permission: PluginPermission, granted: boolean) {
    const plugin = this.require(id);
    const next = granted
      ? [...plugin.granted, permission]
      : plugin.granted.filter((item) => item !== permission);
    return this.setGranted(id, next);
  }

  /** Records the settings a plugin declared when it started. */
  setSettingsSchema(id: string, schema: SettingsSchema | undefined): Promise<void> {
    return this.serial(id, async () => {
      const plugin = this.plugins.get(id);
      if (!plugin) return;
      const current = plugin.settingsSchema as JsonValue | undefined;
      if (jsonEqual(current, schema as JsonValue | undefined)) return;
      const next: InstalledPlugin = { ...plugin };
      if (schema && Object.keys(schema).length) next.settingsSchema = schema;
      else delete next.settingsSchema;
      await this.save(next, { type: 'schema', id });
    });
  }

  /** Changes one setting (validated against the declared schema). */
  setSetting(id: string, key: string, value: unknown): Promise<InstalledPlugin> {
    return this.serial(id, async () => {
      const plugin = this.require(id);
      const definition = plugin.settingsSchema?.[key];
      if (!definition) throw new PluginCallError('invalid', `Unknown setting "${key}"`);
      const result = validateSettingValue(definition, value);
      if (!result.ok) throw new PluginCallError('invalid', result.error);
      const settings: Record<string, SettingPrimitive> = { ...plugin.settings };
      if (result.value === definition.default) delete settings[key];
      else settings[key] = result.value;
      return this.save({ ...plugin, settings }, { type: 'settings', id });
    });
  }

  /** Puts every setting back to its default. */
  resetSettings(id: string): Promise<InstalledPlugin> {
    return this.serial(id, async () => {
      const plugin = this.require(id);
      return this.save({ ...plugin, settings: {} }, { type: 'settings', id });
    });
  }

  async getCode(id: string): Promise<InstalledPluginCode | undefined> {
    return this.store.getCode(id);
  }

  // -------------------------------------------------------------------------------------------
  // Storage (the `storage` permission is checked by the RPC layer before these run)
  // -------------------------------------------------------------------------------------------

  private async sizes(id: string): Promise<Map<string, number>> {
    let sizes = this.storageSizes.get(id);
    if (!sizes) {
      const entries = await this.store.storageEntries(id);
      sizes = new Map(entries.map((entry) => [entry.key, entry.size]));
      this.storageSizes.set(id, sizes);
    }
    return sizes;
  }

  private checkKey(key: string): void {
    if (key.length === 0 || key.length > PLUGIN_LIMITS.storageKeyLength)
      throw new PluginCallError(
        'invalid',
        `Storage keys are 1 to ${PLUGIN_LIMITS.storageKeyLength} characters`,
      );
  }

  async storageGet(id: string, key: string): Promise<JsonValue | undefined> {
    this.checkKey(key);
    return this.store.storageGet(id, key);
  }

  async storageSet(id: string, key: string, value: JsonValue): Promise<void> {
    this.checkKey(key);
    if (!isJsonValue(value)) throw new PluginCallError('invalid', 'Stored values must be JSON');
    const size = jsonSize(value);
    if (size > PLUGIN_LIMITS.storageValueChars)
      throw new PluginCallError('invalid', t('errStorageValue', { limit: '1 MB' }));
    return this.serial(id, async () => {
      this.require(id);
      const sizes = await this.sizes(id);
      let total = size;
      for (const [existing, existingSize] of sizes) if (existing !== key) total += existingSize;
      const keys = sizes.has(key) ? sizes.size : sizes.size + 1;
      if (total > PLUGIN_LIMITS.storageTotalChars || keys > PLUGIN_LIMITS.storageKeys)
        throw new PluginCallError('unavailable', t('errStorageFull', { limit: '10 MB' }));
      await this.store.storageSet(id, key, value);
      sizes.set(key, size);
      this.emit({ type: 'storage', id, key });
    });
  }

  async storageDelete(id: string, key: string): Promise<void> {
    this.checkKey(key);
    return this.serial(id, async () => {
      const sizes = await this.sizes(id);
      if (!sizes.has(key)) return;
      await this.store.storageDelete(id, key);
      sizes.delete(key);
      this.emit({ type: 'storage', id, key });
    });
  }

  async storageKeys(id: string): Promise<string[]> {
    return [...(await this.sizes(id)).keys()].sort();
  }

  /** Bytes of storage a plugin uses (UTF-8 of the JSON), for the details view. */
  async storageUsage(id: string): Promise<{ keys: number; bytes: number }> {
    const entries = await this.store.storageEntries(id);
    let bytes = 0;
    for (const entry of entries) bytes += entry.size + encoder.encode(entry.key).length;
    return { keys: entries.length, bytes };
  }

  /** Deletes everything a plugin stored. */
  storageClear(id: string): Promise<void> {
    return this.serial(id, async () => {
      const keys = [...(await this.sizes(id)).keys()];
      await this.store.storageClear(id);
      this.storageSizes.delete(id);
      for (const key of keys) this.emit({ type: 'storage', id, key });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.snapshotListeners.clear();
    this.options.channel?.close();
    this.store.close();
  }
}
