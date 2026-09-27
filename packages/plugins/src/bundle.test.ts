import { PLUGIN_API_VERSION } from '@tessera/core';
import { describe, expect, it } from 'vitest';
import {
  bundleFromFiles,
  bundleFromUrl,
  bundleFromZip,
  hashBundle,
  normalizeBundlePath,
  PluginBundleError,
} from './bundle';
import { PLUGIN_LIMITS } from './constants';
import {
  compareVersions,
  describePermission,
  networkSources,
  parsePluginManifest,
  sortPermissionsByRisk,
} from './manifest';
import { fakeFetch, manifest, zip } from './test/fixtures';

const encoder = new TextEncoder();
const files = (map: Record<string, string>) =>
  Object.entries(map).map(([path, text]) => ({ path, data: encoder.encode(text) }));

describe('manifests', () => {
  it('accepts a valid manifest and explains invalid ones', () => {
    expect(parsePluginManifest(manifest())).toMatchObject({ ok: true });
    const invalid = parsePluginManifest({ ...manifest(), id: 'Word Count' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toMatch(/isn’t a valid Tessera plugin: id/);
  });

  it('refuses plugins for a newer API or a newer Tessera', () => {
    const next = PLUGIN_API_VERSION + 1;
    const newer = parsePluginManifest(manifest({ apiVersion: next }));
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.error).toMatch(new RegExp(`plugin API ${next}`));
    const app = parsePluginManifest(manifest({ minAppVersion: '9.0.0' }));
    expect(app.ok).toBe(false);
    if (!app.ok) expect(app.error).toMatch(/needs Tessera 9\.0\.0/);
    expect(parsePluginManifest(manifest({ minAppVersion: '0.1.0' })).ok).toBe(true);
  });

  it('accepts a renderer only from plugins built for API 2 (Tessera 0.1 would ignore it)', () => {
    const old = parsePluginManifest(manifest({ renderer: 'renderer.js' }));
    expect(old).toEqual({
      ok: false,
      error:
        'Word count has a renderer, which needs "apiVersion": 2 in its manifest (older Tessera versions can’t run it).',
    });
    expect(parsePluginManifest(manifest({ apiVersion: 2, renderer: 'renderer.js' }))).toMatchObject(
      { ok: true, manifest: { renderer: 'renderer.js' } },
    );
  });

  it('compares semantic versions, pre-releases first', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
  });

  it('describes permissions in plain language, riskiest first', () => {
    expect(describePermission('pages:read')).toMatchObject({
      title: 'Read your pages',
      action: 'read your pages',
      risk: 'low',
    });
    expect(describePermission('network:*.example.com').title).toBe(
      'Connect to example.com and its subdomains',
    );
    expect(sortPermissionsByRisk(['storage', 'pages:write', 'network:api.example.com'])).toEqual([
      'network:api.example.com',
      'pages:write',
      'storage',
    ]);
  });

  it('turns network permissions into CSP sources', () => {
    expect(
      networkSources(['pages:read', 'network:api.example.com', 'network:*.cdn.example.org:8443']),
    ).toEqual([
      'https://api.example.com',
      'wss://api.example.com',
      'https://*.cdn.example.org:8443',
      'wss://*.cdn.example.org:8443',
    ]);
  });
});

describe('bundle paths', () => {
  it.each([
    ['../evil.js'],
    ['a/../../evil.js'],
    ['/etc/passwd'],
    ['C:/Windows/evil.js'],
    ['https://evil.example/x.js'],
    ['a\0b'],
  ])('rejects %s', (path) => {
    expect(() => normalizeBundlePath(path)).toThrow(PluginBundleError);
  });

  it('normalizes separators and skips folders and metadata', () => {
    expect(normalizeBundlePath('dist\\main.js')).toBe('dist/main.js');
    expect(normalizeBundlePath('./a//b.js')).toBe('a/b.js');
    expect(normalizeBundlePath('folder/')).toBeNull();
    expect(normalizeBundlePath('__MACOSX/x')).toBeNull();
    expect(normalizeBundlePath('a/.DS_Store')).toBeNull();
  });
});

describe('bundles', () => {
  const manifestText = JSON.stringify(manifest({ entry: 'dist/main.js' }));

  it('reads a folder with the manifest at the top or in one subfolder', () => {
    const top = bundleFromFiles(
      files({
        'manifest.json': manifestText,
        'dist/main.js': 'export default 1',
        'README.md': '# Hi',
      }),
    );
    expect(top).toMatchObject({ code: 'export default 1', readme: '# Hi' });
    expect(top.manifest.id).toBe('word-count');
    const nested = bundleFromFiles(
      files({ 'word-count/manifest.json': manifestText, 'word-count/dist/main.js': 'x' }),
    );
    expect(nested.code).toBe('x');
  });

  it('explains missing manifests, broken JSON and missing entries', () => {
    expect(() => bundleFromFiles(files({ 'main.js': 'x' }))).toThrow(/No manifest\.json/);
    expect(() => bundleFromFiles(files({ 'manifest.json': '{' }))).toThrow(/isn’t valid JSON/);
    expect(() => bundleFromFiles(files({ 'manifest.json': manifestText }))).toThrow(
      /dist\/main\.js\) is missing/,
    );
    expect(() =>
      bundleFromFiles(files({ 'a/manifest.json': manifestText, 'b/manifest.json': manifestText })),
    ).toThrow(/No manifest\.json/);
  });

  it('reads the renderer module the manifest names, and explains a missing one', () => {
    const withRenderer = JSON.stringify(
      manifest({ entry: 'dist/main.js', apiVersion: 2, renderer: 'dist/renderer.js' }),
    );
    const bundle = bundleFromZip(
      zip({
        'manifest.json': withRenderer,
        'dist/main.js': 'main',
        'dist/renderer.js': 'renderer',
      }),
    );
    expect(bundle).toMatchObject({ code: 'main', renderer: 'renderer' });
    expect(
      bundleFromFiles(files({ 'manifest.json': manifestText, 'dist/main.js': 'x' })),
    ).not.toHaveProperty('renderer');
    expect(() =>
      bundleFromFiles(files({ 'manifest.json': withRenderer, 'dist/main.js': 'main' })),
    ).toThrow(/dist\/renderer\.js\) is missing/);
  });

  it('reads zips, including a BOM before the manifest', () => {
    const bytes = zip({ 'manifest.json': `\uFEFF${manifestText}`, 'dist/main.js': 'code' });
    expect(bundleFromZip(bytes).code).toBe('code');
  });

  it('refuses unreadable zips, traversal paths and oversized contents', () => {
    expect(() => bundleFromZip(encoder.encode('not a zip'))).toThrow(/couldn’t be read/);
    expect(() =>
      bundleFromZip(
        zip({ 'manifest.json': manifestText, '../escape.js': 'x', 'dist/main.js': 'x' }),
      ),
    ).toThrow(/unsafe file path/);
    const many: Record<string, string> = { 'manifest.json': manifestText, 'dist/main.js': 'x' };
    for (let i = 0; i <= PLUGIN_LIMITS.bundleFiles; i += 1) many[`f${i}.txt`] = '';
    expect(() => bundleFromZip(zip(many))).toThrow(/too many files/);
    const huge = new Uint8Array(PLUGIN_LIMITS.entryBytes + 1);
    expect(() =>
      bundleFromZip(zip({ 'manifest.json': manifestText, 'dist/main.js': huge })),
    ).toThrow(/too large/);
  });

  it('downloads a zip, or a manifest with its entry and README next to it', async () => {
    const zipped = zip({ 'manifest.json': manifestText, 'dist/main.js': 'from zip' });
    const fetchZip = fakeFetch({ 'https://plugins.example/wc.zip': zipped });
    expect((await bundleFromUrl('https://plugins.example/wc.zip', { fetch: fetchZip })).code).toBe(
      'from zip',
    );
    const fetchFolder = fakeFetch({
      'https://dev.example/manifest.json': manifestText,
      'https://dev.example/dist/main.js': 'from folder',
      'https://dev.example/README.md': 'Read me',
    });
    const fromFolder = await bundleFromUrl('https://dev.example/', { fetch: fetchFolder });
    expect(fromFolder).toMatchObject({ code: 'from folder', readme: 'Read me' });
    const withRenderer = fakeFetch({
      'https://dev.example/manifest.json': JSON.stringify(
        manifest({ entry: 'main.js', apiVersion: 2, renderer: 'renderer.js' }),
      ),
      'https://dev.example/main.js': 'main',
      'https://dev.example/renderer.js': 'renderer',
    });
    expect(await bundleFromUrl('https://dev.example/', { fetch: withRenderer })).toMatchObject({
      code: 'main',
      renderer: 'renderer',
    });
  });

  it('explains failed downloads and non-plugins', async () => {
    await expect(bundleFromUrl('ftp://x.example/a', { fetch: fakeFetch({}) })).rejects.toThrow(
      /didn’t return a plugin/,
    );
    await expect(
      bundleFromUrl('https://x.example/missing.zip', { fetch: fakeFetch({}) }),
    ).rejects.toThrow(/download failed \(404\)/);
    await expect(
      bundleFromUrl('https://x.example/page', {
        fetch: fakeFetch({ 'https://x.example/page': '<html>' }),
      }),
    ).rejects.toThrow(/didn’t return a plugin/);
    const offline = Object.assign(
      async () => Promise.reject(new TypeError('offline')),
      {},
    ) as typeof fetch;
    await expect(bundleFromUrl('https://x.example/a.zip', { fetch: offline })).rejects.toThrow(
      /couldn’t reach/,
    );
  });

  it('hashes bundles by manifest and code', async () => {
    const a = await hashBundle({ manifest: manifest(), code: 'a' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashBundle({ manifest: manifest(), code: 'a' })).toBe(a);
    expect(await hashBundle({ manifest: manifest(), code: 'b' })).not.toBe(a);
    // The renderer counts too (dev mode reloads when only it changed).
    const withRenderer = await hashBundle({ manifest: manifest(), code: 'a', renderer: 'r' });
    expect(withRenderer).not.toBe(a);
    expect(await hashBundle({ manifest: manifest(), code: 'a', renderer: 's' })).not.toBe(
      withRenderer,
    );
  });
});
