/**
 * Publishes the default plugin registry into a folder: builds the example plugins and writes their
 * zips, `registry.json` (every download URL made from `--base-url`, every zip's SHA-256) and
 * `registry.schema.json`. The docs workflow runs it into the site's `plugins/` folder.
 *
 * Usage: `pnpm --filter @tessera/plugins build:registry --out <dir> [--base-url <url>]
 * [--repo-url <url>]`. The base URL defaults to the app's DEFAULT_REGISTRY_BASE; the repository
 * URL to GITHUB_REPOSITORY in CI, else the examples' manifests.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_REGISTRY_BASE } from '../src/constants';
import { validateRegistrySchema } from './registry-schema';
import { buildRegistry, writeRegistryFolder } from './registry-files';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'base-url': { type: 'string', default: DEFAULT_REGISTRY_BASE },
    'repo-url': { type: 'string' },
  },
});
if (!values.out) {
  console.error('Usage: build-registry.ts --out <dir> [--base-url <url>] [--repo-url <url>]');
  process.exit(2);
}

const { registry, plugins } = await buildRegistry({
  baseUrl: values['base-url'],
  ...(values['repo-url'] ? { repoUrl: values['repo-url'] } : {}),
});
const problems = validateRegistrySchema(registry);
if (problems.length) {
  console.error(`registry.json doesn't match registry.schema.json:\n${problems.join('\n')}`);
  process.exit(1);
}
// pnpm runs package scripts in the package folder; resolve --out against where it was called.
const out = resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
const written = writeRegistryFolder(out, registry, plugins);
console.info(`Wrote ${written.length} files to ${out}:`);
for (const entry of registry.plugins)
  console.info(`  ${entry.id}@${entry.version}  ${entry.download}  sha256 ${entry.sha256 ?? '-'}`);
