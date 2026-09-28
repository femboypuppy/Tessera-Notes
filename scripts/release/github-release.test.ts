import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUpdaterManifest,
  formatChecksums,
  GitHubReleases,
  updaterPlatforms,
  isPrerelease,
  verifyVersion,
  versionFromTag,
  type Release,
} from './github-release.ts';

describe('tags and versions', () => {
  it('reads the version from release tags', () => {
    expect(versionFromTag('v0.1.0')).toBe('0.1.0');
    expect(versionFromTag('v1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(() => versionFromTag('0.1.0')).toThrow(/not a release tag/);
    expect(() => versionFromTag('v1.2')).toThrow(/not a release tag/);
  });

  it('treats tags with a pre-release suffix as pre-releases', () => {
    expect(isPrerelease('v0.2.0-rc.1')).toBe(true);
    expect(isPrerelease('v0.2.0')).toBe(false);
    expect(isPrerelease('v0.2.0+build.5')).toBe(false);
  });
});

describe('this repository', () => {
  it('reports one version everywhere, the one of its next or latest tag', () => {
    const repo = path.resolve(import.meta.dirname, '..', '..');
    const web = JSON.parse(readFileSync(path.join(repo, 'apps/web/package.json'), 'utf8')) as {
      version: string;
    };
    expect(verifyVersion(`v${web.version}`, repo)).toEqual({ errors: [], notes: [] });
  });
});

describe('verifyVersion', () => {
  let root = '';
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const setup = (desktopVersion: string | null, rootVersion: string) => {
    root = mkdtempSync(path.join(tmpdir(), 'tessera-release-'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: rootVersion }));
    if (desktopVersion !== null) {
      mkdirSync(path.join(root, 'apps/desktop/src-tauri'), { recursive: true });
      writeFileSync(
        path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'),
        JSON.stringify({ version: desktopVersion }),
      );
    }
  };

  it('passes when the desktop version matches the tag', () => {
    setup('0.1.0', '0.1.0');
    expect(verifyVersion('v0.1.0', root)).toEqual({ errors: [], notes: [] });
  });

  it('fails when the desktop version differs, and notes a different root version', () => {
    setup('0.1.0', '0.0.0');
    const result = verifyVersion('v0.2.0', root);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/has version "0.1.0", but the tag is v0.2.0/);
    expect(result.notes).toEqual(['package.json has version "0.0.0" (the tag is v0.2.0).']);
  });

  it('fails when a version the app reports was not bumped', () => {
    setup('0.2.0', '0.2.0');
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    };
    write('apps/web/package.json', JSON.stringify({ name: '@tessera/web', version: '0.2.0' }));
    write('apps/server/src/http/app.ts', "export const SERVER_VERSION = '0.1.0';\n");
    write('packages/plugins/src/constants.ts', "export const APP_VERSION = '0.2.0';\n");
    expect(verifyVersion('v0.2.0', root).errors).toEqual([
      'apps/server/src/http/app.ts has SERVER_VERSION "0.1.0", but the tag is v0.2.0. Update it, commit, and tag again.',
    ]);
  });

  it('skips the desktop check when there is no desktop app', () => {
    setup(null, '0.3.0');
    expect(verifyVersion('v0.3.0', root).errors).toEqual([]);
  });
});

describe('formatChecksums', () => {
  it('writes sha256sum-compatible lines sorted by file name', () => {
    expect(
      formatChecksums([
        { name: 'b.dmg', sha256: 'bb' },
        { name: 'a.msi', sha256: 'aa' },
      ]),
    ).toBe('aa  a.msi\nbb  b.dmg\n');
  });
});

/** The signed updater bundles of a full release, as tauri-action names them. */
const SIGNED_BUNDLES = [
  'Tessera_0.1.2_aarch64.app.tar.gz',
  'Tessera_0.1.2_x64.app.tar.gz',
  'Tessera_0.1.2_x64-setup.exe',
  'Tessera_0.1.2_x64_en-US.msi',
  'Tessera_0.1.2_amd64.AppImage',
  'Tessera_0.1.2_amd64.deb',
  'Tessera-0.1.2-1.x86_64.rpm',
];

describe('updater manifest', () => {
  it('maps every bundle to the keys the Tauri updater looks up', () => {
    expect(
      Object.fromEntries(SIGNED_BUNDLES.map((file) => [file, updaterPlatforms(file)])),
    ).toEqual({
      'Tessera_0.1.2_aarch64.app.tar.gz': ['darwin-aarch64', 'darwin-aarch64-app'],
      'Tessera_0.1.2_x64.app.tar.gz': ['darwin-x86_64', 'darwin-x86_64-app'],
      // The setup .exe the release notes recommend serves plain `windows-x86_64` too.
      'Tessera_0.1.2_x64-setup.exe': ['windows-x86_64', 'windows-x86_64-nsis'],
      'Tessera_0.1.2_x64_en-US.msi': ['windows-x86_64-msi'],
      'Tessera_0.1.2_amd64.AppImage': ['linux-x86_64', 'linux-x86_64-appimage'],
      'Tessera_0.1.2_amd64.deb': ['linux-x86_64-deb'],
      'Tessera-0.1.2-1.x86_64.rpm': ['linux-x86_64-rpm'],
    });
    expect(updaterPlatforms('Tessera_0.1.2_aarch64.dmg')).toEqual([]);
    expect(updaterPlatforms('SHA256SUMS.txt')).toEqual([]);
  });

  it('points every platform at its bundle in the release, with its signature', () => {
    const { manifest, missing } = buildUpdaterManifest({
      tag: 'v0.1.2',
      repo: 'o/r',
      pubDate: '2026-09-28T10:00:00.000Z',
      signatures: SIGNED_BUNDLES.map((file) => ({ file, signature: `sig of ${file}\n` })),
    });
    expect(missing).toEqual([]);
    expect(manifest).toMatchObject({
      version: '0.1.2',
      notes: 'Tessera Notes 0.1.2: https://github.com/o/r/releases/tag/v0.1.2',
      pub_date: '2026-09-28T10:00:00.000Z',
    });
    expect(Object.keys(manifest.platforms)).toHaveLength(11);
    expect(manifest.platforms['windows-x86_64']).toEqual({
      signature: 'sig of Tessera_0.1.2_x64-setup.exe',
      url: 'https://github.com/o/r/releases/download/v0.1.2/Tessera_0.1.2_x64-setup.exe',
    });
  });

  it('reports the required platforms no signed bundle serves', () => {
    const { missing } = buildUpdaterManifest({
      tag: 'v0.1.2',
      repo: 'o/r',
      pubDate: '2026-09-28T10:00:00.000Z',
      signatures: [{ file: 'Tessera_0.1.2_x64_en-US.msi', signature: 's' }],
    });
    expect(missing).toEqual(['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64']);
  });
});

/** A fake GitHub API: records requests and answers from a route table. */
function fakeGitHub(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: typeof init.body === 'string' ? init.body : undefined });
    const handler = routes[`${method} ${url}`];
    if (!handler) return new Response('not found', { status: 404 });
    return handler(init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const release = (patch: Partial<Release>): Release => ({
  id: 7,
  tag_name: 'v0.1.0',
  draft: true,
  prerelease: false,
  upload_url: 'https://uploads.example/repos/o/r/releases/7/assets{?name,label}',
  ...patch,
});

describe('GitHubReleases', () => {
  const api = 'https://api.example';

  it('creates a draft, marking pre-releases', async () => {
    const { calls, fetchImpl } = fakeGitHub({
      [`GET ${api}/repos/o/r/releases?per_page=100&page=1`]: () => Response.json([]),
      [`POST ${api}/repos/o/r/releases`]: () => Response.json(release({ id: 9 })),
    });
    const client = new GitHubReleases({ token: 't', repo: 'o/r', apiUrl: api, fetch: fetchImpl });
    expect((await client.draft('v0.2.0-rc.1', 'notes')).id).toBe(9);
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual({
      tag_name: 'v0.2.0-rc.1',
      name: 'Tessera v0.2.0-rc.1',
      body: 'notes',
      draft: true,
      prerelease: true,
    });
  });

  it('updates an existing draft, and refuses to touch a published release', async () => {
    const { calls, fetchImpl } = fakeGitHub({
      [`GET ${api}/repos/o/r/releases?per_page=100&page=1`]: () =>
        Response.json([
          release({ id: 3, tag_name: 'v0.1.0' }),
          release({ id: 4, tag_name: 'v0.0.9', draft: false }),
        ]),
      [`PATCH ${api}/repos/o/r/releases/3`]: () => Response.json(release({ id: 3 })),
    });
    const client = new GitHubReleases({ token: 't', repo: 'o/r', apiUrl: api, fetch: fetchImpl });
    expect((await client.draft('v0.1.0', 'new notes')).id).toBe(3);
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: '{"body":"new notes"}' });
    await expect(client.draft('v0.0.9', 'x')).rejects.toThrow(/already published/);
  });

  it('hashes every asset, replaces an old SHA256SUMS.txt and uploads the new one', async () => {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const { calls, fetchImpl } = fakeGitHub({
      [`GET ${api}/repos/o/r/releases/7`]: () => Response.json(release({})),
      [`GET ${api}/repos/o/r/releases/7/assets?per_page=100&page=1`]: () =>
        Response.json([
          { id: 1, name: 'Tessera.dmg', size: 3 },
          { id: 2, name: 'Tessera.msi', size: 3 },
          { id: 3, name: 'SHA256SUMS.txt', size: 10 },
        ]),
      [`GET ${api}/repos/o/r/releases/assets/1`]: () => new Response('dmg'),
      [`GET ${api}/repos/o/r/releases/assets/2`]: () => new Response('msi'),
      [`DELETE ${api}/repos/o/r/releases/assets/3`]: () => new Response(null, { status: 204 }),
      ['POST https://uploads.example/repos/o/r/releases/7/assets?name=SHA256SUMS.txt']: () =>
        Response.json({ id: 4 }),
    });
    const client = new GitHubReleases({ token: 't', repo: 'o/r', apiUrl: api, fetch: fetchImpl });
    const text = await client.uploadChecksums('7');
    expect(text).toBe(`${sha('dmg')}  Tessera.dmg\n${sha('msi')}  Tessera.msi\n`);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toContain(
      `DELETE ${api}/repos/o/r/releases/assets/3`,
    );
    expect(calls.at(-1)?.body).toBe(text);
  });

  it('writes latest.json from the signatures once, replacing a partial one', async () => {
    const assets = [
      ...SIGNED_BUNDLES.flatMap((name) => [name, `${name}.sig`]),
      'Tessera_0.1.2_aarch64.dmg',
      'latest.json',
    ].map((name, index) => ({ id: index + 1, name, size: 1 }));
    const routes: Record<string, (init: RequestInit) => Response> = {
      [`GET ${api}/repos/o/r/releases/7`]: () => Response.json(release({ tag_name: 'v0.1.2' })),
      [`GET ${api}/repos/o/r/releases/7/assets?per_page=100&page=1`]: () => Response.json(assets),
      [`DELETE ${api}/repos/o/r/releases/assets/${assets.length}`]: () =>
        new Response(null, { status: 204 }),
      ['POST https://uploads.example/repos/o/r/releases/7/assets?name=latest.json']: () =>
        Response.json({ id: 99 }),
    };
    for (const asset of assets.filter((a) => a.name.endsWith('.sig'))) {
      routes[`GET ${api}/repos/o/r/releases/assets/${asset.id}`] = () =>
        new Response(`sig:${asset.name}`);
    }
    const { calls, fetchImpl } = fakeGitHub(routes);
    const client = new GitHubReleases({ token: 't', repo: 'o/r', apiUrl: api, fetch: fetchImpl });
    const manifest = await client.uploadUpdaterManifest('7', '2026-09-28T10:00:00.000Z');
    expect(manifest?.platforms['darwin-aarch64']?.signature).toBe(
      'sig:Tessera_0.1.2_aarch64.app.tar.gz.sig',
    );
    expect(calls.map((call) => `${call.method} ${call.url}`)).toContain(
      `DELETE ${api}/repos/o/r/releases/assets/${assets.length}`,
    );
    expect(JSON.parse(calls.at(-1)?.body ?? '')).toEqual(manifest);
  });

  it('skips latest.json without signatures, and refuses one that leaves a system out', async () => {
    const unsigned = fakeGitHub({
      [`GET ${api}/repos/o/r/releases/7`]: () => Response.json(release({ tag_name: 'v0.1.2' })),
      [`GET ${api}/repos/o/r/releases/7/assets?per_page=100&page=1`]: () =>
        Response.json([{ id: 1, name: 'Tessera_0.1.2_x64-setup.exe', size: 1 }]),
    });
    const client = new GitHubReleases({
      token: 't',
      repo: 'o/r',
      apiUrl: api,
      fetch: unsigned.fetchImpl,
    });
    expect(await client.uploadUpdaterManifest('7', '2026-09-28T10:00:00.000Z')).toBeNull();
    expect(unsigned.calls.every((call) => call.method === 'GET')).toBe(true);

    const partial = fakeGitHub({
      [`GET ${api}/repos/o/r/releases/7`]: () => Response.json(release({ tag_name: 'v0.1.2' })),
      [`GET ${api}/repos/o/r/releases/7/assets?per_page=100&page=1`]: () =>
        Response.json([
          { id: 1, name: 'Tessera_0.1.2_x64-setup.exe', size: 1 },
          { id: 2, name: 'Tessera_0.1.2_x64-setup.exe.sig', size: 1 },
        ]),
      [`GET ${api}/repos/o/r/releases/assets/2`]: () => new Response('sig'),
    });
    const partialClient = new GitHubReleases({
      token: 't',
      repo: 'o/r',
      apiUrl: api,
      fetch: partial.fetchImpl,
    });
    await expect(
      partialClient.uploadUpdaterManifest('7', '2026-09-28T10:00:00.000Z'),
    ).rejects.toThrow(/darwin-aarch64, darwin-x86_64, linux-x86_64/);
    expect(partial.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('publishes drafts, making stable releases the latest', async () => {
    const { calls, fetchImpl } = fakeGitHub({
      [`GET ${api}/repos/o/r/releases/7`]: () => Response.json(release({ prerelease: true })),
      [`PATCH ${api}/repos/o/r/releases/7`]: () => Response.json(release({ draft: false })),
    });
    const client = new GitHubReleases({ token: 't', repo: 'o/r', apiUrl: api, fetch: fetchImpl });
    await client.publish('7');
    expect(JSON.parse(calls.at(-1)?.body ?? '')).toEqual({ draft: false, make_latest: 'false' });
  });

  it('reports API errors with the status', async () => {
    const { fetchImpl } = fakeGitHub({});
    const client = new GitHubReleases({ token: 't', repo: 'o/r', apiUrl: api, fetch: fetchImpl });
    await expect(client.publish('7')).rejects.toThrow(/404 not found/);
  });
});
