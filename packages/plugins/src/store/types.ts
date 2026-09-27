import type { JsonValue, PluginManifest, PluginPermission } from '@tessera/core';
import type { SettingPrimitive } from '@tessera/plugin-api/settings';
import type { SettingsSchema } from '@tessera/plugin-api';

/** Where an installed plugin came from. */
export interface PluginSource {
  kind: 'file' | 'folder' | 'url' | 'registry' | 'dev';
  /** The download or dev-server URL. */
  url?: string;
  /** A file or folder name. */
  name?: string;
  /** The registry the plugin was installed from. */
  registryUrl?: string;
}

/**
 * An installed plugin, per device. Plugins are code, so they never sync between devices or
 * collaborators: each person installs and approves them.
 */
export interface InstalledPlugin {
  id: string;
  manifest: PluginManifest;
  enabled: boolean;
  /** Permissions the user granted: a subset of `manifest.permissions`. */
  granted: PluginPermission[];
  source: PluginSource;
  installedAt: number;
  updatedAt: number;
  /** SHA-256 of the manifest and code. */
  hash: string;
  /** The settings the plugin declared the last time it ran (the settings form uses it). */
  settingsSchema?: SettingsSchema;
  /** Values the user changed (defaults are not stored). */
  settings: Record<string, SettingPrimitive>;
}

/** The code of an installed plugin. */
export interface InstalledPluginCode {
  code: string;
  /** The renderer module, when the manifest names one. */
  renderer?: string;
  readme?: string;
}

/**
 * Persists installed plugins, their code and their private storage. The IndexedDB store is used in
 * browsers and the desktop app; the memory store in tests and when IndexedDB is unavailable.
 */
export interface PluginStore {
  list(): Promise<InstalledPlugin[]>;
  get(id: string): Promise<InstalledPlugin | undefined>;
  /** Saves a record, and its code when given (installs and updates). */
  put(plugin: InstalledPlugin, code?: InstalledPluginCode): Promise<void>;
  getCode(id: string): Promise<InstalledPluginCode | undefined>;
  /** Deletes the record, its code and all of its storage. */
  delete(id: string): Promise<void>;
  storageGet(id: string, key: string): Promise<JsonValue | undefined>;
  storageSet(id: string, key: string, value: JsonValue): Promise<void>;
  storageDelete(id: string, key: string): Promise<void>;
  /** Keys with the size of each value (characters of JSON). */
  storageEntries(id: string): Promise<Array<{ key: string; size: number }>>;
  storageClear(id: string): Promise<void>;
  close(): void;
}
