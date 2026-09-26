import type { PluginManifest } from '@tessera/core';
import { z } from 'zod';
import { sha256Hex } from './bundle';
import { parseRegistry, registryEntrySchema, type RegistryEntry } from './registry';

/**
 * Publishing the default registry. The repository lists its plugins in
 * `examples/plugins/registry.source.json` (the registry's name, each example's tags, and entries
 * for plugins published elsewhere); {@link createRegistry} turns that and the built example zips
 * into `registry.json`. No URL of an example is written by hand: downloads and the schema come
 * from the base URL the registry is published at, source links from the repository URL.
 */

/** `examples/plugins/registry.source.json`. */
export const registrySourceSchema = z
  .object({
    $comment: z.string().optional(),
    name: z.string().trim().min(1).max(100),
    /** Every example plugin, in the order the registry lists them. */
    examples: z.array(
      z.object({ id: z.string().min(1), tags: z.array(z.string()).max(10).optional() }).strict(),
    ),
    /** Plugins published elsewhere, as complete registry entries (with their own URLs). */
    community: z.array(registryEntrySchema).default([]),
  })
  .strict();

export type RegistrySource = z.infer<typeof registrySourceSchema>;

/** A built example plugin. */
export interface PublishedPlugin {
  /** Its folder in `examples/plugins`. */
  folder: string;
  manifest: PluginManifest;
  /** The zip published next to `registry.json`. */
  zip: Uint8Array;
}

/** The registry document written to `registry.json`. */
export interface RegistryDocument {
  $schema: string;
  version: 1;
  name: string;
  updatedAt: string;
  plugins: RegistryEntry[];
}

/** The file name of a plugin's zip: `<id>-<version>.zip`. */
export function zipFileName(manifest: Pick<PluginManifest, 'id' | 'version'>): string {
  return `${manifest.id}-${manifest.version}.zip`;
}

function httpsUrl(value: string, what: string): URL {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || url.protocol !== 'https:') throw new Error(`${what} must be an https URL: ${value}`);
  return url;
}

/**
 * Builds `registry.json`: one entry per example (from its manifest, its tags and its zip, with
 * the zip's SHA-256), then the community entries. Throws when the source and the built examples
 * don't match, or when the result isn't a registry the app accepts in full.
 *
 * @param baseUrl Where `registry.json` and the zips are published, like
 *   `https://you.github.io/Tessera-Notes/plugins/`.
 * @param repoUrl The source repository, like `https://github.com/you/Tessera-Notes`.
 */
export async function createRegistry(options: {
  source: RegistrySource;
  plugins: readonly PublishedPlugin[];
  baseUrl: string;
  repoUrl: string;
  updatedAt: string;
}): Promise<RegistryDocument> {
  const base = httpsUrl(
    options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`,
    'The base URL',
  );
  const repo = httpsUrl(options.repoUrl, 'The repository URL').href.replace(/(\.git)?\/?$/, '');
  const built = new Map(options.plugins.map((plugin) => [plugin.manifest.id, plugin]));
  const listed = new Set(options.source.examples.map((example) => example.id));
  const unlisted = [...built.keys()].filter((id) => !listed.has(id));
  const missing = [...listed].filter((id) => !built.has(id));
  if (unlisted.length || missing.length) {
    throw new Error(
      [
        unlisted.length ? `not in registry.source.json: ${unlisted.join(', ')}` : '',
        missing.length ? `listed but not built: ${missing.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    );
  }
  const plugins: RegistryEntry[] = [];
  for (const example of options.source.examples) {
    const plugin = built.get(example.id);
    if (!plugin) continue;
    const { manifest } = plugin;
    const entry: RegistryEntry = {
      id: manifest.id,
      name: manifest.name,
      author: manifest.author,
      description: manifest.description,
      repo: `${repo}/tree/main/examples/plugins/${plugin.folder}`,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      download: new URL(zipFileName(manifest), base).href,
      sha256: await sha256Hex(plugin.zip),
      permissions: [...manifest.permissions],
    };
    if (manifest.icon) entry.icon = manifest.icon;
    if (manifest.minAppVersion) entry.minAppVersion = manifest.minAppVersion;
    if (manifest.homepage) entry.homepage = manifest.homepage;
    if (example.tags?.length) entry.tags = example.tags;
    plugins.push(entry);
  }
  for (const entry of options.source.community) {
    if (plugins.some((listedEntry) => listedEntry.id === entry.id))
      throw new Error(`Two registry entries have the ID ${entry.id}`);
    plugins.push(entry);
  }
  const document: RegistryDocument = {
    $schema: new URL('registry.schema.json', base).href,
    version: 1,
    name: options.source.name,
    updatedAt: options.updatedAt,
    plugins,
  };
  const parsed = parseRegistry(document);
  if (parsed.skipped) throw new Error(`The app would skip ${parsed.skipped} registry entries`);
  return document;
}
