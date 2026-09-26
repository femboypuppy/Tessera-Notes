/** Constants shared by the plugin host, its UI and the feature registration. Keep this module light. */

/** The feature ID (`apps/web/src/features/plugins`). */
export const PLUGINS_FEATURE_ID = 'plugins';

/** Settings → Plugins lives at `/settings/plugins`. */
export const PLUGINS_SETTINGS_PANEL_ID = 'plugins';

/** The Tessera version plugins compare `minAppVersion` against. */
export const APP_VERSION = '0.1.1';

/**
 * Where the default registry is published: the `plugins/` folder of the docs site (GitHub Pages,
 * which serves every file with `Access-Control-Allow-Origin: *`). The docs workflow builds the
 * example plugins and writes `registry.json`, `registry.schema.json` and the zips there
 * (`pnpm --filter @tessera/plugins build:registry`). A test keeps it in step with the docs base
 * path in `docs/.vitepress/config.mts`.
 */
export const DEFAULT_REGISTRY_BASE = 'https://femboypuppy.github.io/Tessera-Notes/plugins/';

/**
 * The registry read by Settings → Plugins → Browse, unless the user sets another one (device
 * setting {@link PLUGIN_SETTING_KEYS.registryUrl}).
 */
export const DEFAULT_REGISTRY_URL = `${DEFAULT_REGISTRY_BASE}registry.json`;

/** Device settings owned by the plugins feature. */
export const PLUGIN_SETTING_KEYS = {
  /** URL of the `registry.json` the Browse tab reads. */
  registryUrl: 'plugins.registryUrl',
} as const;

/** ID of a plugin command in the command registry: `plugins.<pluginId>/<commandId>`. */
export function pluginCommandId(pluginId: string, commandId: string): string {
  return `${PLUGINS_FEATURE_ID}.${pluginId}/${commandId}`;
}

/** ID of a plugin side panel: `plugin:<pluginId>/<panelId>` (SPEC 6.3). */
export function pluginPanelId(pluginId: string, panelId: string): string {
  return `plugin:${pluginId}/${panelId}`;
}

/** Parses {@link pluginPanelId}. */
export function parsePluginPanelId(id: string): { pluginId: string; panelId: string } | null {
  if (!id.startsWith('plugin:')) return null;
  const rest = id.slice('plugin:'.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0) return null;
  return { pluginId: rest.slice(0, slash), panelId: rest.slice(slash + 1) };
}

/** Limits the host enforces. Plugins are untrusted: every limit is checked on the host side. */
export const PLUGIN_LIMITS = {
  /** A plugin zip download or file. */
  zipBytes: 32 * 1024 * 1024,
  /** All files of a bundle, uncompressed. */
  bundleBytes: 64 * 1024 * 1024,
  bundleFiles: 500,
  /** The JavaScript entry. */
  entryBytes: 24 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  readmeBytes: 256 * 1024,
  /** One RPC message: nesting depth, values, and characters of all strings together. */
  messageDepth: 48,
  messageNodes: 100_000,
  messageChars: 4_000_000,
  /** Requests one context may have in flight. */
  inFlightRequests: 64,
  /** Storage: key length, one value (JSON characters), everything. */
  storageKeyLength: 200,
  storageValueChars: 1_000_000,
  storageTotalChars: 10_000_000,
  storageKeys: 10_000,
  /** Notifications per plugin within {@link PLUGIN_LIMITS.notifyWindowMs}. */
  notifyCount: 5,
  notifyWindowMs: 10_000,
  /** Console entries kept per plugin, and characters per entry. */
  consoleEntries: 500,
  consoleChars: 4_000,
  /** Registrations per plugin. */
  commands: 100,
  panels: 20,
  blocks: 20,
  /** A block frame's height in pixels. */
  blockMinHeight: 24,
  blockMaxHeight: 4_000,
} as const;

/** Timings of the sandbox lifecycle. */
export const PLUGIN_TIMINGS = {
  /** How often the host pings a running plugin. */
  heartbeatIntervalMs: 1_000,
  /** A plugin that hasn't answered a ping for this long is stopped. */
  heartbeatTimeoutMs: 4_000,
  /**
   * How long code in a panel or block frame may run without a break. Those frames share the app's
   * main thread in some browsers, so their code is stopped after this (`sandbox/instrument.ts`).
   */
  frameRunLimitMs: 2_000,
  /** How long a sandbox may take to load the plugin and say it's ready. */
  startTimeoutMs: 20_000,
  /** How long `activate` and `deactivate` may take. */
  activateTimeoutMs: 20_000,
  deactivateTimeoutMs: 2_000,
  /** How long a command may run before the host stops waiting (the plugin keeps running). */
  commandTimeoutMs: 60_000,
} as const;
