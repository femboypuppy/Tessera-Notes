import {
  PLUGIN_ID_PATTERN,
  pluginPermissionSchema,
  SEMVER_PATTERN,
  type PluginPermission,
} from '@tessera/core';
import { z } from 'zod';
import {
  bundleFromUrl,
  bundleFromZip,
  isZip,
  PluginBundleError,
  sha256Hex,
  type PluginBundle,
} from './bundle';
import { PLUGIN_LIMITS } from './constants';
import { t } from './i18n';
import { compareVersions } from './manifest';

/**
 * The community registry: a `registry.json` file anyone can host (a GitHub repository works).
 * Settings → Plugins → Browse reads it from a configurable URL.
 *
 * ```json
 * {
 *   "version": 1,
 *   "name": "Tessera community plugins",
 *   "plugins": [{
 *     "id": "word-count", "name": "Word count", "author": "Tessera",
 *     "description": "Words, characters and reading time of the current page.",
 *     "repo": "https://github.com/…", "version": "1.0.0",
 *     "download": "https://…/word-count-1.0.0.zip",
 *     "permissions": ["pages:read", "ui:panels"],
 *     "icon": "🔢", "tags": ["writing"], "sha256": "…"
 *   }]
 * }
 * ```
 */

/** One plugin listed in a registry. */
export const registryEntrySchema = z.object({
  id: z.string().min(2).max(64).regex(PLUGIN_ID_PATTERN),
  name: z.string().trim().min(1).max(60),
  author: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500),
  /** The source repository (https). */
  repo: z.url({ protocol: /^https$/ }),
  version: z.string().regex(SEMVER_PATTERN),
  /** A `.zip` of the plugin, or its `manifest.json` (with the entry next to it). */
  download: z.url({ protocol: /^https?$/ }),
  /** The permissions the plugin asks for (its manifest must not ask for more). */
  permissions: z.array(pluginPermissionSchema).max(32),
  icon: z.string().min(1).max(16).optional(),
  apiVersion: z.number().int().min(1).optional(),
  minAppVersion: z.string().regex(SEMVER_PATTERN).optional(),
  homepage: z.url({ protocol: /^https$/ }).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  /** SHA-256 of the zip at `download`; checked before installing. */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export type RegistryEntry = z.infer<typeof registryEntrySchema>;

const registryShape = z.object({
  version: z.literal(1),
  name: z.string().max(100).optional(),
  updatedAt: z.string().max(40).optional(),
  plugins: z.array(z.unknown()).max(5_000),
});

/** A loaded registry. Invalid entries are skipped, not fatal. */
export interface Registry {
  name?: string;
  updatedAt?: string;
  plugins: RegistryEntry[];
  /** How many entries were invalid and left out. */
  skipped: number;
}

/** Parses a registry document. Throws a readable error when the file itself is not a registry. */
export function parseRegistry(input: unknown): Registry {
  const shape = registryShape.safeParse(input);
  if (!shape.success) throw new PluginBundleError(t('errRegistryFormat'));
  const plugins: RegistryEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of shape.data.plugins) {
    const entry = registryEntrySchema.safeParse(item);
    if (!entry.success || seen.has(entry.data.id)) {
      skipped += 1;
      continue;
    }
    seen.add(entry.data.id);
    plugins.push(entry.data);
  }
  const registry: Registry = { plugins, skipped };
  if (shape.data.name) registry.name = shape.data.name;
  if (shape.data.updatedAt) registry.updatedAt = shape.data.updatedAt;
  return registry;
}

/** Downloads and parses a registry. */
export async function fetchRegistry(
  url: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Registry> {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: options.signal ?? null,
      cache: 'no-cache',
      credentials: 'omit',
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new PluginBundleError(t('errNetwork', { url }));
  }
  if (!response.ok) throw new PluginBundleError(t('errDownload', { status: response.status }));
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new PluginBundleError(t('errRegistryFormat'));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PluginBundleError(t('errRegistryFormat'));
  }
  return parseRegistry(json);
}

/**
 * Filters and ranks registry entries for a search. Every word must match the name, ID, author,
 * description or tags; name matches rank first.
 */
export function searchRegistry(entries: readonly RegistryEntry[], query: string): RegistryEntry[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const scored = entries.flatMap((entry) => {
    const name = entry.name.toLocaleLowerCase();
    const haystack = [entry.id, entry.author, entry.description, ...(entry.tags ?? [])]
      .join(' ')
      .toLocaleLowerCase();
    let score = 0;
    for (const word of words) {
      if (name.startsWith(word)) score += 4;
      else if (name.includes(word)) score += 3;
      else if (haystack.includes(word)) score += 1;
      else return [];
    }
    return [{ entry, score }];
  });
  return scored
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .map(({ entry }) => entry);
}

/** True when the registry lists a newer version than the installed one. */
export function hasUpdate(entry: RegistryEntry, installedVersion: string): boolean {
  return compareVersions(entry.version, installedVersion) > 0;
}

/**
 * Downloads a plugin listed in a registry and checks it against its entry: same ID and version,
 * no permissions beyond the listed ones, and the SHA-256 when the entry has one. With
 * `requireChecksum` (the default registry, which always publishes one), an entry without a
 * SHA-256 is refused before anything is downloaded.
 */
export async function downloadRegistryPlugin(
  entry: RegistryEntry,
  options: { fetch?: typeof fetch; signal?: AbortSignal; requireChecksum?: boolean } = {},
): Promise<PluginBundle> {
  if (options.requireChecksum && !entry.sha256)
    throw new PluginBundleError(t('errChecksumMissing', { plugin: entry.name }));
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  let bundle: PluginBundle;
  if (entry.sha256 || /\.zip($|\?)/i.test(entry.download)) {
    let response: Response;
    try {
      response = await fetchImpl(entry.download, {
        signal: options.signal ?? null,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new PluginBundleError(t('errNetwork', { url: entry.download }));
    }
    if (!response.ok) throw new PluginBundleError(t('errDownload', { status: response.status }));
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > PLUGIN_LIMITS.zipBytes) throw new PluginBundleError(t('errNotPlugin'));
    if (entry.sha256 && (await sha256Hex(bytes)) !== entry.sha256)
      throw new PluginBundleError(t('errChecksum', { plugin: entry.name }));
    if (!isZip(bytes)) throw new PluginBundleError(t('errNotPlugin'));
    bundle = bundleFromZip(bytes);
  } else {
    bundle = await bundleFromUrl(entry.download, options);
  }
  const { manifest } = bundle;
  if (manifest.id !== entry.id || manifest.version !== entry.version)
    throw new PluginBundleError(t('errRegistryMismatch', { plugin: entry.name }));
  const listed = new Set<PluginPermission>(entry.permissions);
  const extra = manifest.permissions.filter((permission) => !listed.has(permission));
  if (extra.length)
    throw new PluginBundleError(
      t('errRegistryPermissions', { plugin: entry.name, permissions: extra.join(', ') }),
    );
  return bundle;
}
