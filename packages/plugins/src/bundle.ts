import type { PluginManifest } from '@tessera/core';
import { unzipSync } from 'fflate';
import { PLUGIN_LIMITS } from './constants';
import { t } from './i18n';
import { parsePluginManifest } from './manifest';

/**
 * A plugin as installed: its validated manifest, the JavaScript entry, the renderer module when
 * the manifest names one, and the optional README. Other files in a bundle are ignored (the
 * sandbox only ever loads those two modules).
 */
export interface PluginBundle {
  manifest: PluginManifest;
  /** The entry module's source (an ES module whose default export is `definePlugin(…)`). */
  code: string;
  /** The renderer module's source (default export `defineRenderer(…)`), if any. */
  renderer?: string;
  readme?: string;
}

/** A bundle that failed to load, with a message written for people. */
export class PluginBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginBundleError';
  }
}

/** A file of a plugin folder (File System Access API or `<input webkitdirectory>`). */
export interface BundleFile {
  /** Path relative to the folder the user picked (the folder's own name may be the first segment). */
  path: string;
  data: Uint8Array;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function tooLarge(size: number, limit: number): PluginBundleError {
  return new PluginBundleError(
    t('errTooLarge', { size: formatBytes(size), limit: formatBytes(limit) }),
  );
}

/**
 * Normalizes a path inside a bundle. Rejects anything that could escape the bundle: `..`,
 * absolute paths, drive letters, schemes, NUL bytes. Returns null for paths to skip (folders,
 * macOS metadata).
 */
export function normalizeBundlePath(path: string): string | null {
  const unified = path.replace(/\\/g, '/');
  if (unified.endsWith('/')) return null;
  if (
    unified.startsWith('/') ||
    /^[a-zA-Z]:/.test(unified) ||
    /^[a-z][a-z0-9+.-]*:/i.test(unified) ||
    unified.includes('\0')
  ) {
    throw new PluginBundleError(t('errUnsafePath', { path: path.slice(0, 200) }));
  }
  const parts = unified.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..'))
    throw new PluginBundleError(t('errUnsafePath', { path: path.slice(0, 200) }));
  if (parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store') return null;
  return parts.join('/');
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Builds a bundle from files. The manifest may sit at the top or inside one top-level folder
 * (zips made by compressing a folder look like that).
 */
export function bundleFromFiles(files: readonly BundleFile[]): PluginBundle {
  if (files.length > PLUGIN_LIMITS.bundleFiles)
    throw new PluginBundleError(t('errTooManyFiles', { limit: PLUGIN_LIMITS.bundleFiles }));
  const byPath = new Map<string, Uint8Array>();
  let total = 0;
  for (const file of files) {
    const path = normalizeBundlePath(file.path);
    if (path === null) continue;
    total += file.data.byteLength;
    if (total > PLUGIN_LIMITS.bundleBytes) throw tooLarge(total, PLUGIN_LIMITS.bundleBytes);
    byPath.set(path, file.data);
  }
  let prefix = '';
  if (!byPath.has('manifest.json')) {
    const candidates = [...byPath.keys()].filter((path) => /^[^/]+\/manifest\.json$/.test(path));
    if (candidates.length !== 1 || !candidates[0]) throw new PluginBundleError(t('errNoManifest'));
    prefix = candidates[0].slice(0, -'manifest.json'.length);
  }
  const read = (path: string) => byPath.get(prefix + path);
  const manifestBytes = read('manifest.json');
  if (!manifestBytes) throw new PluginBundleError(t('errNoManifest'));
  if (manifestBytes.byteLength > PLUGIN_LIMITS.manifestBytes)
    throw tooLarge(manifestBytes.byteLength, PLUGIN_LIMITS.manifestBytes);
  const manifest = parseManifestText(decoder.decode(manifestBytes));
  const module = (path: string) => {
    const bytes = read(path);
    if (!bytes) throw new PluginBundleError(t('errMissingEntry', { entry: path }));
    if (bytes.byteLength > PLUGIN_LIMITS.entryBytes)
      throw tooLarge(bytes.byteLength, PLUGIN_LIMITS.entryBytes);
    return decoder.decode(bytes);
  };
  const bundle: PluginBundle = { manifest, code: module(manifest.entry) };
  if (manifest.renderer) bundle.renderer = module(manifest.renderer);
  const readme = read('README.md') ?? read('readme.md');
  if (readme && readme.byteLength <= PLUGIN_LIMITS.readmeBytes)
    bundle.readme = decoder.decode(readme);
  return bundle;
}

/** Parses and validates `manifest.json` text. */
export function parseManifestText(text: string): PluginManifest {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new PluginBundleError(t('errManifestJson'));
  }
  const result = parsePluginManifest(json);
  if (!result.ok) throw new PluginBundleError(result.error);
  return result.manifest;
}

/** True when the bytes start like a zip archive. */
export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/** Reads a plugin zip. Checks sizes before inflating, so a zip bomb fails fast. */
export function bundleFromZip(bytes: Uint8Array): PluginBundle {
  if (bytes.byteLength > PLUGIN_LIMITS.zipBytes)
    throw tooLarge(bytes.byteLength, PLUGIN_LIMITS.zipBytes);
  let declared = 0;
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter(file) {
        count += 1;
        if (count > PLUGIN_LIMITS.bundleFiles)
          throw new PluginBundleError(t('errTooManyFiles', { limit: PLUGIN_LIMITS.bundleFiles }));
        declared += file.originalSize;
        if (declared > PLUGIN_LIMITS.bundleBytes)
          throw tooLarge(declared, PLUGIN_LIMITS.bundleBytes);
        return !file.name.endsWith('/');
      },
    });
  } catch (error) {
    if (error instanceof PluginBundleError) throw error;
    throw new PluginBundleError(t('errZipUnreadable'));
  }
  return bundleFromFiles(Object.entries(entries).map(([path, data]) => ({ path, data })));
}

/** Reads a response body, failing once it grows past `limit` bytes. */
async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) throw tooLarge(length, limit);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge(total, limit);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function download(
  url: string,
  limit: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: signal ?? null,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PluginBundleError(t('errNetwork', { url }));
  }
  if (!response.ok) throw new PluginBundleError(t('errDownload', { status: response.status }));
  return readLimited(response, limit);
}

/** Only http(s) URLs can be installed from. */
export function parseInstallUrl(input: string): URL | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Downloads a plugin: a `.zip`, or a `manifest.json` whose entry (and README) sit next to it. A
 * folder URL ending in `/` loads `manifest.json` from it (dev servers).
 */
export async function bundleFromUrl(
  input: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<PluginBundle> {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  const parsed = parseInstallUrl(input);
  if (!parsed) throw new PluginBundleError(t('errNotPlugin'));
  const url = parsed.pathname.endsWith('/') ? new URL('manifest.json', parsed) : parsed;
  const bytes = await download(url.href, PLUGIN_LIMITS.zipBytes, fetchImpl, options.signal);
  if (isZip(bytes)) return bundleFromZip(bytes);
  if (bytes.byteLength > PLUGIN_LIMITS.manifestBytes)
    throw new PluginBundleError(t('errNotPlugin'));
  let manifest: PluginManifest;
  try {
    manifest = parseManifestText(decoder.decode(bytes));
  } catch (error) {
    if (error instanceof PluginBundleError && error.message === t('errManifestJson'))
      throw new PluginBundleError(t('errNotPlugin'));
    throw error;
  }
  const module = async (path: string) =>
    decoder.decode(
      await download(new URL(path, url).href, PLUGIN_LIMITS.entryBytes, fetchImpl, options.signal),
    );
  const bundle: PluginBundle = { manifest, code: await module(manifest.entry) };
  if (manifest.renderer) bundle.renderer = await module(manifest.renderer);
  try {
    const readme = await download(
      new URL('README.md', url).href,
      PLUGIN_LIMITS.readmeBytes,
      fetchImpl,
      options.signal,
    );
    bundle.readme = decoder.decode(readme);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // The README is optional.
  }
  return bundle;
}

/** A SHA-256 of the manifest and code, to notice changes (dev mode) and report integrity. */
export async function hashBundle(
  bundle: Pick<PluginBundle, 'manifest' | 'code' | 'renderer'>,
): Promise<string> {
  const renderer = bundle.renderer === undefined ? '' : `\n${bundle.renderer}`;
  const data = new TextEncoder().encode(
    `${JSON.stringify(bundle.manifest)}\n${bundle.code}${renderer}`,
  );
  return sha256Hex(data);
}

/** Hex SHA-256 of some bytes (Web Crypto). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
