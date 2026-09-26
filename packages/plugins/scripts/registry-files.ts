/**
 * The default registry on disk: the source listing, the built example plugins, and a published
 * folder (`registry.json`, `registry.schema.json` and the zips). Used by `build-registry.ts` and the
 * e2e specs, which serve the same files the docs site publishes.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePluginManifest } from '../src/manifest';
import {
  createRegistry,
  registrySourceSchema,
  zipFileName,
  type PublishedPlugin,
  type RegistryDocument,
  type RegistrySource,
} from '../src/registry-publish';
import { buildExamples, EXAMPLES_DIR, type BuiltExample } from './build-examples';

export const REGISTRY_SOURCE = join(EXAMPLES_DIR, 'registry.source.json');
export const REGISTRY_SCHEMA = join(EXAMPLES_DIR, 'registry.schema.json');

/** `examples/plugins/registry.source.json`, validated. */
export function readRegistrySource(): RegistrySource {
  return registrySourceSchema.parse(JSON.parse(readFileSync(REGISTRY_SOURCE, 'utf8')));
}

/** A built example as the registry publishes it (its manifest, validated, and its zip). */
export function publishedPlugin(example: BuiltExample): PublishedPlugin {
  const result = parsePluginManifest(
    JSON.parse(readFileSync(join(example.dist, 'manifest.json'), 'utf8')),
  );
  if (!result.ok) throw new Error(`${example.name}: ${result.error}`);
  return { folder: example.name, manifest: result.manifest, zip: readFileSync(example.zip) };
}

/** The repository the examples come from: `GITHUB_REPOSITORY` in CI, else their manifests. */
export function defaultRepoUrl(plugins: readonly PublishedPlugin[]): string {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository } = process.env;
  if (server && repository) return `${server}/${repository}`;
  const repositories = new Set(plugins.map((plugin) => plugin.manifest.repository));
  const [only] = repositories;
  if (repositories.size !== 1 || !only)
    throw new Error('The examples name different repositories; pass --repo-url');
  return only;
}

/** Builds the examples (up-to-date ones are reused) and creates the registry for `baseUrl`. */
export async function buildRegistry(options: {
  baseUrl: string;
  repoUrl?: string;
  updatedAt?: string;
}): Promise<{ registry: RegistryDocument; plugins: PublishedPlugin[]; built: BuiltExample[] }> {
  const built = await buildExamples(undefined, { force: false });
  const plugins = built.map(publishedPlugin);
  const registry = await createRegistry({
    source: readRegistrySource(),
    plugins,
    baseUrl: options.baseUrl,
    repoUrl: options.repoUrl ?? defaultRepoUrl(plugins),
    updatedAt: options.updatedAt ?? new Date().toISOString().slice(0, 10),
  });
  return { registry, plugins, built };
}

/** Writes `registry.json`, `registry.schema.json` and every zip into `out`. */
export function writeRegistryFolder(
  out: string,
  registry: RegistryDocument,
  plugins: readonly PublishedPlugin[],
): string[] {
  mkdirSync(out, { recursive: true });
  const written: string[] = [];
  for (const plugin of plugins) {
    const name = zipFileName(plugin.manifest);
    writeFileSync(join(out, name), plugin.zip);
    written.push(name);
  }
  copyFileSync(REGISTRY_SCHEMA, join(out, 'registry.schema.json'));
  writeFileSync(join(out, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`);
  written.push('registry.schema.json', 'registry.json');
  return written;
}
