/**
 * Builds the example plugins in `examples/plugins/<name>` into installable bundles:
 * `dist/manifest.json`, `dist/main.js`, `dist/README.md` and `dist/<id>-<version>.zip`, plus
 * `dist/renderer.js` for an example whose manifest names a renderer (built with `--mode renderer`).
 *
 * Each example has its own `vite.config.ts` (a single-file library build), so it also builds on its
 * own once copied out of the repository. Inside the monorepo the SDK and mermaid resolve to the
 * workspace copies.
 *
 * Usage: `pnpm --filter @tessera/plugins build:examples [name…]`
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { build } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../..');
export const EXAMPLES_DIR = join(REPO_ROOT, 'examples/plugins');
const PLUGIN_API = join(REPO_ROOT, 'packages/plugin-api/src');

/** Module aliases so examples build against the workspace SDK and dependencies. */
export const exampleAliases = [
  { find: /^@tessera\/plugin-api$/, replacement: join(PLUGIN_API, 'index.ts') },
  { find: /^@tessera\/plugin-api\/testing$/, replacement: join(PLUGIN_API, 'testing/index.ts') },
  { find: /^mermaid$/, replacement: resolve(here, '../node_modules/mermaid') },
];

/** Example folders (every folder with a manifest.json). */
export function exampleNames(): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((name) => existsSync(join(EXAMPLES_DIR, name, 'manifest.json')))
    .sort();
}

export interface BuiltExample {
  name: string;
  id: string;
  version: string;
  dist: string;
  zip: string;
  bytes: number;
}

function newest(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path)
    .filter((entry) => entry !== 'dist' && entry !== 'node_modules')
    .reduce((latest, entry) => Math.max(latest, newest(join(path, entry))), stat.mtimeMs);
}

/** Builds one example (skipped when its zip is newer than every source file, unless `force`). */
export async function buildExample(
  name: string,
  options: { force?: boolean } = {},
): Promise<BuiltExample> {
  const dir = join(EXAMPLES_DIR, name);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    id: string;
    version: string;
    entry: string;
    renderer?: string;
  };
  const dist = join(dir, 'dist');
  const zip = join(dist, `${manifest.id}-${manifest.version}.zip`);
  const fresh =
    !options.force &&
    existsSync(zip) &&
    statSync(zip).mtimeMs > Math.max(newest(dir), newest(PLUGIN_API));
  if (!fresh) {
    const modes = manifest.renderer ? ['production', 'renderer'] : ['production'];
    for (const mode of modes)
      await build({
        root: dir,
        configFile: join(dir, 'vite.config.ts'),
        mode,
        logLevel: 'warn',
        resolve: { alias: exampleAliases },
      });
    const files: Record<string, Uint8Array> = {};
    const modules = manifest.renderer ? [manifest.entry, manifest.renderer] : [manifest.entry];
    for (const file of ['manifest.json', ...modules, 'README.md']) {
      const path = join(dist, file);
      if (existsSync(path)) files[file] = readFileSync(path);
    }
    // A fixed date keeps the archive identical when the code is (reproducible checksums).
    writeFileSync(zip, zipSync(files, { mtime: new Date('2026-01-01T00:00:00Z'), level: 9 }));
  }
  return { name, id: manifest.id, version: manifest.version, dist, zip, bytes: statSync(zip).size };
}

/** Builds every example, or the named ones. */
export async function buildExamples(
  names: readonly string[] = exampleNames(),
  options: { force?: boolean } = {},
): Promise<BuiltExample[]> {
  const built: BuiltExample[] = [];
  for (const name of names) built.push(await buildExample(name, options));
  return built;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // From the command line, always rebuild (`--changed` skips examples whose zip is up to date).
  const args = process.argv.slice(2);
  const names = args.filter((arg) => !arg.startsWith('--'));
  const built = await buildExamples(names.length ? names : exampleNames(), {
    force: !args.includes('--changed'),
  });
  for (const example of built)
    console.info(
      `${example.id}@${example.version}  ${(example.bytes / 1024).toFixed(1)} KB  ${example.zip}`,
    );
}
