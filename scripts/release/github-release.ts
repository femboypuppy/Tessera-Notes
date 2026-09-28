/**
 * GitHub Release steps for `.github/workflows/release.yml`. Plain Node (no install needed).
 *
 *   node scripts/release/github-release.ts verify-version --tag v0.1.0
 *   node scripts/release/github-release.ts draft --tag v0.1.0 --notes release-notes.md
 *   node scripts/release/github-release.ts updater-json --release-id 123
 *   node scripts/release/github-release.ts checksums --release-id 123
 *   node scripts/release/github-release.ts publish --release-id 123
 *
 * The API commands read GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_API_URL (set in Actions).
 * `draft` writes `id=<release id>` to $GITHUB_OUTPUT.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { parseArgs } from 'node:util';

export const CHECKSUMS_FILE = 'SHA256SUMS.txt';

/** `v1.2.3` → `1.2.3`; throws for tags that aren't `v` + semver. */
export function versionFromTag(tag: string): string {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!match?.[1]) throw new Error(`"${tag}" is not a release tag like v1.2.3 or v1.2.3-beta.1.`);
  return match[1];
}

/** Pre-releases have a `-` suffix (`v0.2.0-beta.1`). */
export function isPrerelease(tag: string): boolean {
  return versionFromTag(tag).split('+')[0]?.includes('-') ?? false;
}

/** Versions the app reports besides the desktop's, each checked against the tag when present. */
const REPORTED_VERSIONS = [
  { file: 'apps/web/package.json', what: 'version', pattern: /"version":\s*"([^"]*)"/ },
  {
    file: 'apps/server/src/http/app.ts',
    what: 'SERVER_VERSION',
    pattern: /SERVER_VERSION = '([^']*)'/,
  },
  {
    file: 'packages/plugins/src/constants.ts',
    what: 'APP_VERSION',
    pattern: /APP_VERSION = '([^']*)'/,
  },
] as const;

/**
 * Checks that the tag matches the desktop app's version (its bundles and updater manifest use
 * it) and every other version the app reports (Settings → About, `/api/health`, plugins'
 * `minAppVersion`). Returns problems as messages; an empty list means the tag is fine.
 */
export function verifyVersion(tag: string, root: string): { errors: string[]; notes: string[] } {
  const version = versionFromTag(tag);
  const errors: string[] = [];
  const notes: string[] = [];
  const tauriConfig = path.join(root, 'apps/desktop/src-tauri/tauri.conf.json');
  if (existsSync(tauriConfig)) {
    const config = JSON.parse(readFileSync(tauriConfig, 'utf8')) as { version?: unknown };
    if (config.version !== version) {
      errors.push(
        `apps/desktop/src-tauri/tauri.conf.json has version "${String(config.version)}", but the tag is ${tag}. Update it, commit, and tag again.`,
      );
    }
  } else {
    notes.push('No apps/desktop/src-tauri/tauri.conf.json; skipped the desktop version check.');
  }
  // The other versions the app reports: a missed one ships a server whose /api/health, or an app
  // whose About and bug reports, name the previous release.
  for (const source of REPORTED_VERSIONS) {
    const file = path.join(root, source.file);
    if (!existsSync(file)) continue;
    const found = source.pattern.exec(readFileSync(file, 'utf8'))?.[1] ?? null;
    if (found !== version) {
      errors.push(
        `${source.file} has ${source.what} "${String(found)}", but the tag is ${tag}. Update it, commit, and tag again.`,
      );
    }
  }
  const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (rootPackage.version !== version) {
    notes.push(`package.json has version "${String(rootPackage.version)}" (the tag is ${tag}).`);
  }
  return { errors, notes };
}

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
}

export interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  upload_url: string;
}

/** `<sha256>  <name>` lines, sorted by name, like `sha256sum`. */
export function formatChecksums(entries: ReadonlyArray<{ name: string; sha256: string }>): string {
  return `${[...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.sha256}  ${entry.name}`)
    .join('\n')}\n`;
}

export const UPDATER_MANIFEST = 'latest.json';

/**
 * The platforms each updater must find in `latest.json`: the Tauri updater looks up
 * `{os}-{arch}-{installer}` first (the way the app was installed), then `{os}-{arch}`.
 */
export const REQUIRED_UPDATER_PLATFORMS = [
  'darwin-aarch64',
  'darwin-x86_64',
  'windows-x86_64',
  'linux-x86_64',
] as const;

interface UpdaterBundle {
  os: 'darwin' | 'windows' | 'linux';
  installer: 'app' | 'nsis' | 'msi' | 'appimage' | 'deb' | 'rpm';
  /** Whether the bundle also serves `{os}-{arch}` (the setup .exe over the .msi on Windows). */
  generic: boolean;
}

const UPDATER_BUNDLES: ReadonlyArray<{ suffix: string; bundle: UpdaterBundle }> = [
  { suffix: '.app.tar.gz', bundle: { os: 'darwin', installer: 'app', generic: true } },
  { suffix: '-setup.exe', bundle: { os: 'windows', installer: 'nsis', generic: true } },
  { suffix: '.msi', bundle: { os: 'windows', installer: 'msi', generic: false } },
  { suffix: '.AppImage', bundle: { os: 'linux', installer: 'appimage', generic: true } },
  { suffix: '.deb', bundle: { os: 'linux', installer: 'deb', generic: false } },
  { suffix: '.rpm', bundle: { os: 'linux', installer: 'rpm', generic: false } },
];

/**
 * The updater keys a signed bundle serves, from its release file name (`Tessera_0.1.2_x64-setup.exe`,
 * `Tessera_0.1.2_aarch64.app.tar.gz`, `Tessera-0.1.2-1.x86_64.rpm`…), or [] for other files.
 */
export function updaterPlatforms(fileName: string): string[] {
  const entry = UPDATER_BUNDLES.find(({ suffix }) => fileName.endsWith(suffix));
  if (!entry) return [];
  const stem = fileName.slice(0, -entry.suffix.length);
  const arch = /(?:^|[_.-])(aarch64|arm64)(?:$|[_.-])/.test(stem)
    ? 'aarch64'
    : /(?:^|[_.-])(x64|x86_64|amd64)(?:$|[_.-])/.test(stem)
      ? 'x86_64'
      : null;
  if (!arch) return [];
  const { os, installer, generic } = entry.bundle;
  return generic ? [`${os}-${arch}`, `${os}-${arch}-${installer}`] : [`${os}-${arch}-${installer}`];
}

export interface UpdaterManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

/**
 * The updater's `latest.json` for one release, from the signatures of its updater bundles
 * (`<bundle>.sig`, which the Tauri CLI writes when it has the signing key). `missing` lists the
 * required platforms no bundle serves.
 */
export function buildUpdaterManifest(options: {
  tag: string;
  repo: string;
  pubDate: string;
  signatures: ReadonlyArray<{ file: string; signature: string }>;
}): { manifest: UpdaterManifest; missing: string[] } {
  const version = versionFromTag(options.tag);
  const platforms: UpdaterManifest['platforms'] = {};
  for (const { file, signature } of options.signatures) {
    const url = `https://github.com/${options.repo}/releases/download/${encodeURIComponent(options.tag)}/${encodeURIComponent(file)}`;
    for (const platform of updaterPlatforms(file)) {
      if (platforms[platform]) {
        throw new Error(`Two updater bundles serve ${platform}: ${file} and another one.`);
      }
      platforms[platform] = { signature: signature.trim(), url };
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(platforms).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    manifest: {
      version,
      notes: `Tessera Notes ${version}: https://github.com/${options.repo}/releases/tag/${options.tag}`,
      pub_date: options.pubDate,
      platforms: sorted,
    },
    missing: REQUIRED_UPDATER_PLATFORMS.filter((platform) => !platforms[platform]),
  };
}

type Fetch = typeof fetch;

interface ClientOptions {
  token: string;
  /** `owner/name`. */
  repo: string;
  apiUrl?: string;
  fetch?: Fetch;
}

/** The few GitHub REST calls a release needs. */
export class GitHubReleases {
  // A plain field, not a parameter property: Node's type stripping doesn't support those.
  private readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  private get fetchImpl(): Fetch {
    return this.options.fetch ?? fetch;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const full =
      url.startsWith('https://') || url.startsWith('http://')
        ? url
        : `${this.options.apiUrl ?? 'https://api.github.com'}${url}`;
    const response = await this.fetchImpl(full, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `${init.method ?? 'GET'} ${full}: ${response.status} ${detail.slice(0, 500)}`,
      );
    }
    return response;
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await (await this.request(url, init)).json()) as T;
  }

  /** Every release (drafts included, which the "by tag" endpoint doesn't return). */
  async listReleases(): Promise<Release[]> {
    const releases: Release[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.json<Release[]>(
        `/repos/${this.options.repo}/releases?per_page=100&page=${page}`,
      );
      releases.push(...batch);
      if (batch.length < 100) return releases;
    }
  }

  /** Creates the draft for `tag`, or updates the notes of an existing draft. */
  async draft(tag: string, notes: string): Promise<Release> {
    const existing = (await this.listReleases()).find((release) => release.tag_name === tag);
    if (existing && !existing.draft) {
      throw new Error(`The release for ${tag} is already published; delete it or use a new tag.`);
    }
    if (existing) {
      return this.json<Release>(`/repos/${this.options.repo}/releases/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: notes }),
      });
    }
    return this.json<Release>(`/repos/${this.options.repo}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag,
        name: `Tessera ${tag}`,
        body: notes,
        draft: true,
        prerelease: isPrerelease(tag),
      }),
    });
  }

  async getRelease(id: string): Promise<Release> {
    return this.json<Release>(`/repos/${this.options.repo}/releases/${id}`);
  }

  async listAssets(id: string): Promise<ReleaseAsset[]> {
    const assets: ReleaseAsset[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.json<ReleaseAsset[]>(
        `/repos/${this.options.repo}/releases/${id}/assets?per_page=100&page=${page}`,
      );
      assets.push(...batch);
      if (batch.length < 100) return assets;
    }
  }

  /** Streams an asset through SHA-256 (assets can be hundreds of megabytes). */
  async sha256(asset: ReleaseAsset): Promise<string> {
    const response = await this.request(`/repos/${this.options.repo}/releases/assets/${asset.id}`, {
      headers: { accept: 'application/octet-stream' },
    });
    if (!response.body) throw new Error(`Empty download for ${asset.name}`);
    const hash = createHash('sha256');
    for await (const chunk of Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)) {
      hash.update(chunk as Uint8Array);
    }
    return hash.digest('hex');
  }

  private async text(asset: ReleaseAsset): Promise<string> {
    const response = await this.request(`/repos/${this.options.repo}/releases/assets/${asset.id}`, {
      headers: { accept: 'application/octet-stream' },
    });
    return response.text();
  }

  /** Replaces the asset `name` of release `release` with `body`. */
  private async replaceAsset(
    release: Release,
    assets: ReleaseAsset[],
    name: string,
    body: string,
    contentType: string,
  ): Promise<void> {
    const previous = assets.find((asset) => asset.name === name);
    if (previous) {
      await this.request(`/repos/${this.options.repo}/releases/assets/${previous.id}`, {
        method: 'DELETE',
      });
    }
    const uploadUrl = release.upload_url.replace(/\{.*\}$/, '');
    await this.request(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
  }

  /**
   * Writes the updater's `latest.json` from the release's signed bundles, once every desktop build
   * has uploaded (the builds run in parallel, so they can't each update one shared file). Returns
   * null when the release has no signatures: the signing key isn't configured, and the app from
   * this release doesn't update itself. Throws when a required platform has no signed bundle.
   */
  async uploadUpdaterManifest(id: string, pubDate: string): Promise<UpdaterManifest | null> {
    const release = await this.getRelease(id);
    const assets = await this.listAssets(id);
    const signatureAssets = assets.filter((asset) => asset.name.endsWith('.sig'));
    if (!signatureAssets.length) return null;
    const signatures: Array<{ file: string; signature: string }> = [];
    for (const asset of signatureAssets) {
      const file = asset.name.slice(0, -'.sig'.length);
      if (!assets.some((candidate) => candidate.name === file)) {
        throw new Error(`${asset.name} has no ${file} next to it in the release.`);
      }
      signatures.push({ file, signature: await this.text(asset) });
    }
    const { manifest, missing } = buildUpdaterManifest({
      tag: release.tag_name,
      repo: this.options.repo,
      pubDate,
      signatures,
    });
    if (missing.length) {
      throw new Error(
        `No signed updater bundle for ${missing.join(', ')}; the updater would skip those systems.`,
      );
    }
    await this.replaceAsset(
      release,
      assets,
      UPDATER_MANIFEST,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'application/json',
    );
    return manifest;
  }

  /** Computes SHA256SUMS.txt over every other asset and (re)uploads it. Returns its contents. */
  async uploadChecksums(id: string): Promise<string> {
    const release = await this.getRelease(id);
    const assets = await this.listAssets(id);
    const entries: Array<{ name: string; sha256: string }> = [];
    for (const asset of assets) {
      if (asset.name === CHECKSUMS_FILE) continue;
      entries.push({ name: asset.name, sha256: await this.sha256(asset) });
    }
    const text = formatChecksums(entries);
    await this.replaceAsset(release, assets, CHECKSUMS_FILE, text, 'text/plain; charset=utf-8');
    return text;
  }

  /** Publishes a draft; stable releases become "latest". */
  async publish(id: string): Promise<Release> {
    const release = await this.getRelease(id);
    return this.json<Release>(`/repos/${this.options.repo}/releases/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ draft: false, make_latest: release.prerelease ? 'false' : 'true' }),
    });
  }
}

function client(): GitHubReleases {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY must be set.');
  return new GitHubReleases({ token, repo, apiUrl: process.env.GITHUB_API_URL });
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      tag: { type: 'string' },
      notes: { type: 'string' },
      'release-id': { type: 'string' },
    },
  });
  const root = path.resolve(import.meta.dirname, '..', '..');
  switch (command) {
    case 'verify-version': {
      const { errors, notes } = verifyVersion(values.tag ?? '', root);
      for (const note of notes) console.info(note);
      for (const error of errors) console.error(`error: ${error}`);
      if (!errors.length) console.info(`${values.tag} matches the app version.`);
      return errors.length ? 1 : 0;
    }
    case 'draft': {
      const tag = values.tag ?? '';
      versionFromTag(tag);
      const notes = values.notes ? readFileSync(values.notes, 'utf8') : '';
      const release = await client().draft(tag, notes);
      console.info(`Draft release ${release.id} for ${tag}.`);
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `id=${release.id}\n`);
      return 0;
    }
    case 'updater-json': {
      const manifest = await client().uploadUpdaterManifest(
        values['release-id'] ?? '',
        new Date().toISOString(),
      );
      if (manifest) {
        console.info(`${UPDATER_MANIFEST}: ${Object.keys(manifest.platforms).join(', ')}`);
      } else {
        console.info(
          `No signed updater bundles (TAURI_SIGNING_PRIVATE_KEY isn't set); no ${UPDATER_MANIFEST}, so this release doesn't update installed apps.`,
        );
      }
      return 0;
    }
    case 'checksums': {
      const text = await client().uploadChecksums(values['release-id'] ?? '');
      process.stdout.write(text);
      return 0;
    }
    case 'publish': {
      const release = await client().publish(values['release-id'] ?? '');
      console.info(`Published ${release.tag_name}.`);
      return 0;
    }
    default:
      console.error(
        'Usage: github-release.ts verify-version|draft|updater-json|checksums|publish [options]',
      );
      return 2;
  }
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
