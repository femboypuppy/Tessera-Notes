import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRegistrySource } from '../scripts/registry-files';
import { validateRegistrySchema } from '../scripts/registry-schema';
import { sha256Hex } from './bundle';
import { DEFAULT_REGISTRY_BASE, DEFAULT_REGISTRY_URL } from './constants';
import { parsePluginManifest } from './manifest';
import { parseRegistry } from './registry';
import { createRegistry } from './registry-publish';

const examples = `${resolve(import.meta.dirname, '../../../examples/plugins')}/`;
const read = (path: string): unknown => JSON.parse(readFileSync(examples + path, 'utf8'));
const names = readdirSync(examples).filter((name) =>
  existsSync(`${examples}${name}/manifest.json`),
);

describe('example plugins', () => {
  it('are the five from the brief', () => {
    expect(names.sort()).toEqual([
      'daily-notes',
      'mermaid',
      'pomodoro',
      'random-page',
      'word-count',
    ]);
  });

  it.each(names)('%s has a valid manifest, a README and tests', (name) => {
    const result = parsePluginManifest(read(`${name}/manifest.json`));
    expect(result.ok ? null : result.error).toBeNull();
    expect(existsSync(`${examples}${name}/README.md`)).toBe(true);
    expect(readdirSync(`${examples}${name}/src`).some((file) => file.endsWith('.test.ts'))).toBe(
      true,
    );
  });

  it('make a registry whose every URL comes from where it is published', async () => {
    const plugins = names.map((name) => {
      const result = parsePluginManifest(read(`${name}/manifest.json`));
      if (!result.ok) throw new Error(result.error);
      // Stand-in zips: the docs workflow publishes the built ones.
      return { folder: name, manifest: result.manifest, zip: new TextEncoder().encode(name) };
    });
    const baseUrl = 'https://docs.example/Tessera-Notes/plugins/';
    const registry = await createRegistry({
      source: readRegistrySource(),
      plugins,
      baseUrl,
      repoUrl: 'https://github.com/example/Tessera-Notes.git',
      updatedAt: '2026-09-26',
    });
    expect(validateRegistrySchema(registry)).toEqual([]);
    expect(parseRegistry(registry)).toMatchObject({ skipped: 0 });
    expect(registry.$schema).toBe(`${baseUrl}registry.schema.json`);
    expect(registry.plugins.map((entry) => entry.id).sort()).toEqual(
      plugins.map((plugin) => plugin.manifest.id).sort(),
    );
    for (const entry of registry.plugins) {
      const plugin = plugins.find((candidate) => candidate.manifest.id === entry.id);
      expect(entry).toMatchObject({
        name: plugin?.manifest.name,
        version: plugin?.manifest.version,
        permissions: plugin?.manifest.permissions,
        download: `${baseUrl}${entry.id}-${plugin?.manifest.version}.zip`,
        repo: `https://github.com/example/Tessera-Notes/tree/main/examples/plugins/${plugin?.folder}`,
        sha256: await sha256Hex(plugin?.zip ?? new Uint8Array()),
      });
      expect(entry.tags?.length).toBeGreaterThan(0);
    }
  });

  it('refuse to publish an example missing from the listing, or a listed one that is missing', async () => {
    const source = readRegistrySource();
    const plugin = (id: string) => {
      const result = parsePluginManifest(read(`${id}/manifest.json`));
      if (!result.ok) throw new Error(result.error);
      return { folder: id, manifest: result.manifest, zip: new Uint8Array([1]) };
    };
    const options = {
      baseUrl: 'https://docs.example/plugins/',
      repoUrl: 'https://github.com/example/repo',
      updatedAt: '2026-09-26',
    };
    await expect(
      createRegistry({ ...options, source, plugins: [plugin('word-count')] }),
    ).rejects.toThrow(/listed but not built: daily-notes/);
    await expect(
      createRegistry({
        ...options,
        source: { ...source, examples: source.examples.filter((e) => e.id !== 'mermaid') },
        plugins: names.map(plugin),
      }),
    ).rejects.toThrow(/not in registry.source.json: mermaid/);
    await expect(
      createRegistry({
        ...options,
        baseUrl: 'http://docs.example/',
        source,
        plugins: names.map(plugin),
      }),
    ).rejects.toThrow(/https URL/);
  });
});

describe('the default registry', () => {
  it('is published under the docs site, at the base path the docs are built with', () => {
    const config = readFileSync(
      resolve(import.meta.dirname, '../../../docs/.vitepress/config.mts'),
      'utf8',
    );
    const base = /process\.env\.DOCS_BASE \?\? '([^']+)'/.exec(config)?.[1];
    expect(base).toMatch(/^\/.*\/$/);
    expect(DEFAULT_REGISTRY_BASE).toBe(`https://femboypuppy.github.io${base}plugins/`);
    expect(DEFAULT_REGISTRY_URL).toBe(`${DEFAULT_REGISTRY_BASE}registry.json`);
  });

  it('can be fetched from self-hosted servers and the desktop app (their CSP allows it)', () => {
    const repo = resolve(import.meta.dirname, '../../..');
    const origin = new URL(DEFAULT_REGISTRY_URL).origin;
    /** Whether a CSP `connect-src` source list lets pages fetch from `origin`. */
    const allows = (sources: string) =>
      sources
        .split(/\s+/)
        .some((source) => source === '*' || source === 'https:' || source === origin);
    const server = readFileSync(`${repo}/apps/server/src/http/static.ts`, 'utf8');
    const serverConnect = /"connect-src ([^"]+)"/.exec(server)?.[1];
    expect(serverConnect, 'connect-src in apps/server/src/http/static.ts').toBeDefined();
    expect(allows(serverConnect ?? '')).toBe(true);
    const desktop = JSON.parse(
      readFileSync(`${repo}/apps/desktop/src-tauri/tauri.conf.json`, 'utf8'),
    ) as { app: { security: { csp: Record<string, string> } } };
    expect(allows(desktop.app.security.csp['connect-src'] ?? '')).toBe(true);
  });
});
