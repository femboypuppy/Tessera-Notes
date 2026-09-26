import { describe, expect, it } from 'vitest';
import { sha256Hex } from './bundle';
import {
  downloadRegistryPlugin,
  fetchRegistry,
  hasUpdate,
  parseRegistry,
  searchRegistry,
  type RegistryEntry,
} from './registry';
import { fakeFetch, manifest, zip } from './test/fixtures';

function entry(patch: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: 'word-count',
    name: 'Word count',
    author: 'Tessera',
    description: 'Words, characters and reading time.',
    repo: 'https://github.com/example/tessera',
    version: '1.0.0',
    download: 'https://plugins.example/word-count-1.0.0.zip',
    permissions: ['pages:read', 'ui:panels'],
    ...patch,
  };
}

describe('registry files', () => {
  it('keeps valid entries and counts the invalid and duplicate ones', () => {
    const registry = parseRegistry({
      version: 1,
      name: 'Community',
      plugins: [
        entry(),
        entry(), // duplicate ID
        { ...entry({ id: 'pomodoro' }), repo: 'http://insecure.example' },
        { ...entry({ id: 'mermaid' }), permissions: ['pages:delete'] },
        entry({ id: 'daily-notes', name: 'Daily notes' }),
        'nonsense',
      ],
    });
    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(['word-count', 'daily-notes']);
    expect(registry.skipped).toBe(4);
    expect(registry.name).toBe('Community');
  });

  it('refuses files that are not registries', async () => {
    expect(() => parseRegistry({ plugins: [] })).toThrow(/isn’t a Tessera plugin registry/);
    const fetchHtml = fakeFetch({ 'https://r.example/registry.json': '<html>' });
    await expect(
      fetchRegistry('https://r.example/registry.json', { fetch: fetchHtml }),
    ).rejects.toThrow(/isn’t a Tessera plugin registry/);
    await expect(
      fetchRegistry('https://r.example/missing.json', { fetch: fakeFetch({}) }),
    ).rejects.toThrow(/404/);
  });

  it('searches by every word and ranks name matches first', () => {
    const entries = [
      entry({ id: 'word-count', name: 'Word count', description: 'Counts words.' }),
      entry({
        id: 'pomodoro',
        name: 'Pomodoro',
        description: 'Focus timer with word-free breaks.',
      }),
      entry({ id: 'mermaid', name: 'Mermaid', description: 'Diagrams', tags: ['diagram'] }),
    ];
    expect(searchRegistry(entries, 'word').map((e) => e.id)).toEqual(['word-count', 'pomodoro']);
    expect(searchRegistry(entries, 'DIAGRAM').map((e) => e.id)).toEqual(['mermaid']);
    expect(searchRegistry(entries, 'word timer').map((e) => e.id)).toEqual(['pomodoro']);
    expect(searchRegistry(entries, '').map((e) => e.id)).toEqual([
      'mermaid',
      'pomodoro',
      'word-count',
    ]);
    expect(searchRegistry(entries, 'zzz')).toEqual([]);
  });

  it('notices updates', () => {
    expect(hasUpdate(entry({ version: '1.1.0' }), '1.0.0')).toBe(true);
    expect(hasUpdate(entry({ version: '1.0.0' }), '1.0.0')).toBe(false);
  });
});

describe('registry downloads', () => {
  const archive = zip({ 'manifest.json': JSON.stringify(manifest()), 'main.js': 'code' });

  it('downloads, checks the checksum and returns the bundle', async () => {
    const sha256 = await sha256Hex(archive);
    const fetchImpl = fakeFetch({ 'https://plugins.example/word-count-1.0.0.zip': archive });
    const bundle = await downloadRegistryPlugin(entry({ sha256 }), { fetch: fetchImpl });
    expect(bundle.code).toBe('code');
  });

  it('refuses a download whose checksum, version or permissions differ from the entry', async () => {
    const fetchImpl = fakeFetch({ 'https://plugins.example/word-count-1.0.0.zip': archive });
    await expect(
      downloadRegistryPlugin(entry({ sha256: '0'.repeat(64) }), { fetch: fetchImpl }),
    ).rejects.toThrow(/checksum/);
    await expect(
      downloadRegistryPlugin(entry({ version: '2.0.0' }), { fetch: fetchImpl }),
    ).rejects.toThrow(/doesn’t match its registry entry/);
    await expect(
      downloadRegistryPlugin(entry({ permissions: ['pages:read'] }), { fetch: fetchImpl }),
    ).rejects.toThrow(/asks for permissions its registry entry doesn’t list \(ui:panels\)/);
  });

  it('refuses an entry without a checksum when one is required, before downloading', async () => {
    let requests = 0;
    const fetchImpl: typeof fetch = (input, init) => {
      requests += 1;
      return fakeFetch({ 'https://plugins.example/word-count-1.0.0.zip': archive })(input, init);
    };
    await expect(
      downloadRegistryPlugin(entry(), { fetch: fetchImpl, requireChecksum: true }),
    ).rejects.toThrow(/lists no checksum for Word count/);
    expect(requests).toBe(0);
    // Other registries may leave it out (it's recommended, not required).
    await expect(downloadRegistryPlugin(entry(), { fetch: fetchImpl })).resolves.toBeTruthy();
  });
});
