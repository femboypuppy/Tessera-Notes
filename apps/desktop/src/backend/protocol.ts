import { z } from 'zod';

/**
 * The shapes the Rust side (`src-tauri/src/commands.rs`) returns, validated at the boundary. The
 * Rust side validates everything it reads from disk too; this catches version skew between the
 * two halves of the app and bugs, before bad data reaches the UI.
 */

export const cloudProviderSchema = z.enum([
  'dropbox',
  'icloud',
  'onedrive',
  'google-drive',
  'box',
  'syncthing',
  'nextcloud',
  'pcloud',
  'mega',
  'cloud-storage',
]);
export type CloudProvider = z.infer<typeof cloudProviderSchema>;

export const cloudInfoSchema = z.object({ provider: cloudProviderSchema, root: z.string() });
export type CloudInfo = z.infer<typeof cloudInfoSchema>;

export const manifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  formatVersion: z.number(),
});
export type WorkspaceManifest = z.infer<typeof manifestSchema>;

export const registryEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().optional(),
  serverUrl: z.string().optional(),
  path: z.string(),
  createdAt: z.number(),
  lastOpenedAt: z.number().optional(),
  initializedAt: z.number().optional(),
});
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

/** `ready`: the folder holds the workspace. `new`: not written to yet. `missing`: it's gone. */
export const folderStatusSchema = z.enum(['ready', 'new', 'missing']);
export type FolderStatus = z.infer<typeof folderStatusSchema>;

export const registryItemSchema = registryEntrySchema.extend({ status: folderStatusSchema });
export type RegistryItem = z.infer<typeof registryItemSchema>;

export const workspaceStatusSchema = z.object({
  id: z.string(),
  path: z.string(),
  exists: z.boolean(),
  journal: z.enum(['wal', 'delete']),
  cloud: cloudInfoSchema.nullable(),
  conflicts: z.array(z.string()),
  manifest: manifestSchema.nullable(),
});
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

export const folderInfoSchema = z.object({
  path: z.string(),
  name: z.string(),
  exists: z.boolean(),
  workspace: manifestSchema.nullable(),
  entries: z.number(),
  cloud: cloudInfoSchema.nullable(),
  conflicts: z.array(z.string()),
});
export type FolderInfo = z.infer<typeof folderInfoSchema>;

export const assetRowSchema = z.object({
  assetId: z.string(),
  name: z.string().nullable(),
  mimeType: z.string(),
  size: z.number(),
  createdAt: z.number(),
});
export type AssetRow = z.infer<typeof assetRowSchema>;

export const mergeReportSchema = z.object({
  docs: z.number(),
  updates: z.number(),
  assets: z.number(),
});
export type MergeReport = z.infer<typeof mergeReportSchema>;

export const mirrorReportSchema = z.object({ files: z.number(), removed: z.number() });
export type MirrorReport = z.infer<typeof mirrorReportSchema>;

export const prefsSchema = z.object({
  closeToTray: z.boolean(),
  captureEnabled: z.boolean(),
  captureShortcut: z.string(),
  zoom: z.number(),
  checkUpdates: z.boolean(),
  lastUpdateCheck: z.number().nullable().optional(),
  shortcutError: z.string().nullable(),
});
export type Prefs = z.infer<typeof prefsSchema>;
export type PrefsPatch = Partial<
  Pick<Prefs, 'closeToTray' | 'captureEnabled' | 'captureShortcut' | 'checkUpdates'>
>;

export const appInfoSchema = z.object({
  version: z.string(),
  windowLabel: z.string(),
  os: z.string(),
  arch: z.string(),
  debug: z.boolean(),
  defaultRoot: z.string().nullable(),
  updatesConfigured: z.boolean(),
});
export type AppInfo = z.infer<typeof appInfoSchema>;

export const deepLinkSchema = z.object({
  pageId: z.string(),
  workspaceId: z.string().nullable(),
  heading: z.string().nullable(),
  blockId: z.string().nullable(),
});
export type DeepLink = z.infer<typeof deepLinkSchema>;

/** A file written through the native save dialog (`file_save`). */
export const savedFileSchema = z.object({ name: z.string(), path: z.string() });
export type SavedFileInfo = z.infer<typeof savedFileSchema>;

export const serverEntrySchema = z.object({ server: z.string(), savedAt: z.number() });
export type ServerEntry = z.infer<typeof serverEntrySchema>;

export const updateInfoSchema = z.object({
  configured: z.boolean(),
  available: z.boolean(),
  currentVersion: z.string(),
  version: z.string().nullable(),
  notes: z.string().nullable(),
  date: z.string().nullable(),
});
export type UpdateInfo = z.infer<typeof updateInfoSchema>;

export const docUpdateEventSchema = z.object({
  workspaceId: z.string(),
  docName: z.string(),
  update: z.string(),
  origin: z.string(),
});
export type DocUpdateEvent = z.infer<typeof docUpdateEventSchema>;

export const originEventSchema = z.object({ origin: z.string() });

export const updateProgressSchema = z.object({
  downloaded: z.number(),
  total: z.number().nullable(),
});
export type UpdateProgress = z.infer<typeof updateProgressSchema>;

/** A node of a native menu (`menu_set`; `src-tauri/src/menu.rs`). */
export type MenuNode =
  | { type: 'item'; id: string; label: string; accelerator?: string | null; enabled?: boolean }
  | { type: 'separator' }
  | { type: 'predefined'; item: PredefinedMenuItem; label?: string }
  | { type: 'submenu'; label: string; role?: 'window' | 'help'; items: MenuNode[] };

export type PredefinedMenuItem =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'minimize'
  | 'maximize'
  | 'fullscreen'
  | 'hide'
  | 'hideOthers'
  | 'showAll'
  | 'closeWindow'
  | 'quit'
  | 'about'
  | 'services'
  | 'bringAllToFront';

export interface MenuSpec {
  menu: MenuNode[];
  tray: MenuNode[];
}

export { EVENTS, WINDOWS } from '../constants';

/**
 * Encodes and decodes the `doc_load` frame: `[u64 maxSeq][u32 count]` then `count` times
 * `[u32 length][bytes]`, little-endian.
 */
export function decodeUpdateFrame(buffer: ArrayBuffer | Uint8Array): {
  maxSeq: number;
  updates: Uint8Array[];
} {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) throw new Error('Truncated update frame');
  const maxSeq = Number(view.getBigUint64(0, true));
  const count = view.getUint32(8, true);
  const updates: Uint8Array[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset + 4 > bytes.byteLength) throw new Error('Truncated update frame');
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > bytes.byteLength) throw new Error('Truncated update frame');
    updates.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return { maxSeq, updates };
}

export function encodeUpdateFrame(maxSeq: number, updates: readonly Uint8Array[]): Uint8Array {
  const size = 12 + updates.reduce((sum, update) => sum + 4 + update.byteLength, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(Math.max(0, maxSeq)), true);
  view.setUint32(8, updates.length, true);
  let offset = 12;
  for (const update of updates) {
    view.setUint32(offset, update.byteLength, true);
    offset += 4;
    bytes.set(update, offset);
    offset += update.byteLength;
  }
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
