/**
 * Checks a published registry the way the app will use it, from outside: the docs workflow runs it
 * after every deploy.
 *
 * - `registry.json` answers 200 and lets any origin read it (the web app, the desktop app and
 *   self-hosted servers all fetch it cross-origin).
 * - It matches `registry.schema.json`, and the app's parser keeps every entry.
 * - Every entry has a SHA-256, and its zip answers 200 with the same CORS header, matches that
 *   SHA-256, and passes the app's own install checks (ID, version, permissions).
 * - With `--site <page_url>`, the app's DEFAULT_REGISTRY_URL points into that site.
 *
 * Usage: `pnpm --filter @tessera/plugins check:registry [--url <registry.json>] [--site <url>]`
 * (the URL defaults to DEFAULT_REGISTRY_URL). Retries for a while: a fresh Pages deployment can
 * take a minute to reach every edge.
 */
import { parseArgs } from 'node:util';
import { DEFAULT_REGISTRY_URL } from '../src/constants';
import { downloadRegistryPlugin, parseRegistry } from '../src/registry';
import { validateRegistrySchema } from './registry-schema';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: DEFAULT_REGISTRY_URL },
    site: { type: 'string' },
    attempts: { type: 'string', default: '10' },
  },
});

/** An origin that is neither the site's nor the app's, like a self-hosted server's. */
const ORIGIN = 'https://tessera.example';

const problems: string[] = [];

/** Fetches with an Origin header and records a problem unless CORS lets that origin read it. */
const corsFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('Origin', ORIGIN);
  const response = await fetch(input, { ...init, headers });
  const allowed = response.headers.get('access-control-allow-origin');
  if (response.ok && allowed !== '*' && allowed !== ORIGIN)
    problems.push(`${String(input)}: no Access-Control-Allow-Origin for other sites (${allowed})`);
  return response;
};

async function check(): Promise<string[]> {
  problems.length = 0;
  if (values.site) {
    const site = values.site.endsWith('/') ? values.site : `${values.site}/`;
    if (!DEFAULT_REGISTRY_URL.startsWith(site))
      problems.push(`The app reads ${DEFAULT_REGISTRY_URL}, outside the deployed site ${site}`);
  }
  const response = await corsFetch(values.url, { cache: 'no-store' });
  if (!response.ok) return [...problems, `${values.url}: HTTP ${response.status}`];
  const document: unknown = await response.json();
  problems.push(...validateRegistrySchema(document).map((line) => `registry.json ${line}`));
  const registry = parseRegistry(document);
  if (registry.skipped) problems.push(`The app skips ${registry.skipped} entries`);
  if (!registry.plugins.length) problems.push('The registry lists no plugins');
  for (const entry of registry.plugins) {
    try {
      await downloadRegistryPlugin(entry, { fetch: corsFetch, requireChecksum: true });
      console.info(`ok  ${entry.id}@${entry.version}  ${entry.download}`);
    } catch (error) {
      problems.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...problems];
}

const attempts = Math.max(1, Number(values.attempts));
let found: string[] = [];
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  found = await check();
  if (!found.length) break;
  if (attempt < attempts) {
    console.warn(`Attempt ${attempt}/${attempts}: ${found.length} problems; retrying in 30 s`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}
if (found.length) {
  console.error(`The registry at ${values.url} has problems:\n- ${found.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.info(`The registry at ${values.url} is published correctly.`);
}
