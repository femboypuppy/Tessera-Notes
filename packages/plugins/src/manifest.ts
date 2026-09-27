import {
  PLUGIN_API_VERSION,
  pluginManifestSchema,
  type PluginManifest,
  type PluginPermission,
  type StaticPluginPermission,
} from '@tessera/core';
import { APP_VERSION } from './constants';
import { t } from './i18n';

/** The result of {@link parsePluginManifest}. */
export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

/**
 * Compares two semantic versions. Returns a negative number when `a < b`, 0 when equal, and a
 * positive number when `a > b`. Pre-releases sort before their release (`1.0.0-beta < 1.0.0`).
 */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [core = '', pre] = version.split('+')[0]?.split(/-(.*)/s) ?? [];
    return { parts: core.split('.').map((part) => Number(part) || 0), pre: pre ?? '' };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  const leftIds = left.pre.split('.');
  const rightIds = right.pre.split('.');
  for (let i = 0; i < Math.max(leftIds.length, rightIds.length); i += 1) {
    const l = leftIds[i];
    const r = rightIds[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null && ln !== rn) return ln - rn;
    if (ln !== null && rn === null) return -1;
    if (ln === null && rn !== null) return 1;
    const order = l.localeCompare(r);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Validates an untrusted manifest with the core schema, then checks that this version of Tessera
 * can run it (API version and `minAppVersion`). Errors are written for people.
 */
export function parsePluginManifest(input: unknown): ManifestResult {
  const result = pluginManifestSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 5)
      .map((issue) =>
        issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      )
      .join('; ');
    return { ok: false, error: t('errInvalidManifest', { details }) };
  }
  const manifest = result.data;
  if (manifest.apiVersion > PLUGIN_API_VERSION) {
    return {
      ok: false,
      error: t('errApiTooNew', { plugin: manifest.name, version: manifest.apiVersion }),
    };
  }
  // Tessera 0.1 (API 1) ignores `renderer`: a plugin that needs one must say it needs API 2.
  if (manifest.renderer && manifest.apiVersion < 2) {
    return { ok: false, error: t('errRendererNeedsApi2', { plugin: manifest.name }) };
  }
  if (manifest.minAppVersion && compareVersions(APP_VERSION, manifest.minAppVersion) < 0) {
    return {
      ok: false,
      error: t('errAppTooOld', { plugin: manifest.name, version: manifest.minAppVersion }),
    };
  }
  return { ok: true, manifest };
}

/** How much a permission can affect the user's data. */
export type PermissionRisk = 'low' | 'medium' | 'high';

/** A permission explained for people. */
export interface PermissionDescription {
  permission: PluginPermission;
  title: string;
  text: string;
  /** What the plugin can't do without it, for error messages ("read your pages"). */
  action: string;
  risk: PermissionRisk;
}

const STATIC_DESCRIPTIONS: Record<
  StaticPluginPermission,
  { title: () => string; text: () => string; action: () => string; risk: PermissionRisk }
> = {
  'pages:read': {
    title: () => t('permPagesReadTitle'),
    text: () => t('permPagesReadText'),
    action: () => t('permPagesReadAction'),
    risk: 'low',
  },
  'pages:write': {
    title: () => t('permPagesWriteTitle'),
    text: () => t('permPagesWriteText'),
    action: () => t('permPagesWriteAction'),
    risk: 'medium',
  },
  'databases:read': {
    title: () => t('permDatabasesReadTitle'),
    text: () => t('permDatabasesReadText'),
    action: () => t('permDatabasesReadAction'),
    risk: 'low',
  },
  'databases:write': {
    title: () => t('permDatabasesWriteTitle'),
    text: () => t('permDatabasesWriteText'),
    action: () => t('permDatabasesWriteAction'),
    risk: 'medium',
  },
  'ui:commands': {
    title: () => t('permUiCommandsTitle'),
    text: () => t('permUiCommandsText'),
    action: () => t('permUiCommandsAction'),
    risk: 'low',
  },
  'ui:panels': {
    title: () => t('permUiPanelsTitle'),
    text: () => t('permUiPanelsText'),
    action: () => t('permUiPanelsAction'),
    risk: 'low',
  },
  'ui:blocks': {
    title: () => t('permUiBlocksTitle'),
    text: () => t('permUiBlocksText'),
    action: () => t('permUiBlocksAction'),
    risk: 'low',
  },
  storage: {
    title: () => t('permStorageTitle'),
    text: () => t('permStorageText'),
    action: () => t('permStorageAction'),
    risk: 'low',
  },
};

/** Describes a permission in plain language (the install prompt, the details view, errors). */
export function describePermission(permission: PluginPermission): PermissionDescription {
  if (permission.startsWith('network:')) {
    const target = permission.slice('network:'.length);
    const wildcard = target.startsWith('*.');
    const domain = wildcard ? target.slice(2) : target;
    return {
      permission,
      title: wildcard
        ? t('permNetworkWildcardTitle', { domain })
        : t('permNetworkTitle', { domain }),
      text: t('permNetworkText'),
      action: t('permNetworkAction', { domain: target }),
      risk: 'high',
    };
  }
  const entry = STATIC_DESCRIPTIONS[permission as StaticPluginPermission];
  return {
    permission,
    title: entry.title(),
    text: entry.text(),
    action: entry.action(),
    risk: entry.risk,
  };
}

/** Sorts permissions for display: riskiest first, then in the manifest's order. */
export function sortPermissionsByRisk(
  permissions: readonly PluginPermission[],
): PluginPermission[] {
  const weight: Record<PermissionRisk, number> = { high: 0, medium: 1, low: 2 };
  return permissions
    .map((permission, index) => ({ permission, index, risk: describePermission(permission).risk }))
    .sort((a, b) => weight[a.risk] - weight[b.risk] || a.index - b.index)
    .map(({ permission }) => permission);
}

/** Network hosts granted by `network:` permissions, as CSP host sources (`https://api.example.com`). */
export function networkSources(granted: readonly PluginPermission[]): string[] {
  const sources = new Set<string>();
  for (const permission of granted) {
    if (!permission.startsWith('network:')) continue;
    const host = permission.slice('network:'.length);
    // The core schema only accepts `[*.]domain[:port]`, so the host is safe to put in a CSP.
    if (!/^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/.test(host)) continue;
    sources.add(`https://${host}`);
    sources.add(`wss://${host}`);
  }
  return [...sources];
}
