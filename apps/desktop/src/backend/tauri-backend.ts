import { convertFileSrc, invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { z } from 'zod';
import { currentWindowLabel, EVENTS } from '../constants';
import type { DesktopBackend } from './backend';
import { isNotFound, toDesktopError } from './errors';
import {
  appInfoSchema,
  assetRowSchema,
  decodeUpdateFrame,
  deepLinkSchema,
  docUpdateEventSchema,
  folderInfoSchema,
  mergeReportSchema,
  mirrorReportSchema,
  originEventSchema,
  prefsSchema,
  registryEntrySchema,
  registryItemSchema,
  serverEntrySchema,
  updateInfoSchema,
  updateProgressSchema,
  workspaceStatusSchema,
  type MenuSpec,
} from './protocol';

/** The URL scheme that serves attachments (`src-tauri/src/protocol.rs`). */
export const ASSET_SCHEME = 'tessera-asset';

async function call<T>(command: string, args?: InvokeArgs, schema?: z.ZodType<T>): Promise<T> {
  let result: unknown;
  try {
    result = await invoke(command, args);
  } catch (error) {
    throw toDesktopError(error, command);
  }
  if (!schema) return result as T;
  const parsed = schema.safeParse(result);
  if (!parsed.success)
    throw toDesktopError(
      { code: 'internal', message: `Unexpected reply from ${command}: ${parsed.error.message}` },
      command,
    );
  return parsed.data;
}

/** Sends bytes as the raw request body, with string arguments in (percent-encoded) headers. */
async function callBinary(
  command: string,
  bytes: Uint8Array,
  headers: Record<string, string>,
): Promise<unknown> {
  const encoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) encoded[key] = encodeURIComponent(value);
  try {
    return await invoke(command, bytes, { headers: encoded });
  } catch (error) {
    throw toDesktopError(error, command);
  }
}

function toBytes(result: unknown): Uint8Array<ArrayBuffer> {
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof Uint8Array) return new Uint8Array(result);
  if (Array.isArray(result)) return Uint8Array.from(result as number[]);
  throw toDesktopError({ code: 'internal', message: 'Expected binary data' }, 'binary');
}

/**
 * Subscribes to a Tauri event and returns a synchronous unsubscribe (Tauri's is async). Events
 * whose payload doesn't match `schema` are dropped.
 */
function subscribe<T>(
  event: string,
  schema: z.ZodType<T> | null,
  listener: (payload: T) => void,
): () => void {
  let active = true;
  let unlisten: (() => void) | null = null;
  // Tauri's unlisten is async. If the IPC bridge is gone (the page is unloading), there is
  // nothing left to unsubscribe from.
  const warn = (error: unknown) =>
    console.warn(`[desktop] could not stop listening to ${event}`, error);
  const stop = (off: () => unknown) => {
    try {
      void Promise.resolve(off()).catch(warn);
    } catch (error) {
      warn(error);
    }
  };
  void listen<unknown>(event, ({ payload }) => {
    if (!active) return;
    if (!schema) {
      listener(payload as T);
      return;
    }
    const parsed = schema.safeParse(payload);
    if (parsed.success) listener(parsed.data);
    else console.warn(`[desktop] ignored malformed ${event} event`, parsed.error.message);
  })
    .then((off) => {
      if (active) unlisten = off;
      else stop(off);
    })
    .catch((error: unknown) => console.warn(`[desktop] could not listen to ${event}`, error));
  return () => {
    active = false;
    if (unlisten) stop(unlisten);
  };
}

/** {@link DesktopBackend} over Tauri IPC. */
export class TauriBackend implements DesktopBackend {
  readonly windowLabel = currentWindowLabel();

  appInfo() {
    return call('app_info', undefined, appInfoSchema);
  }

  quit() {
    return call<void>('app_quit');
  }

  flushDone() {
    return call<void>('flush_done');
  }

  openExternal(url: string) {
    return call<void>('open_external', { url });
  }

  async takeLinks() {
    return call('links_take', undefined, deepLinkSchema.array());
  }

  setMenu(spec: MenuSpec) {
    return call<void>('menu_set', { spec } as unknown as InvokeArgs);
  }

  setWindowTitle(title: string) {
    return call<void>('window_set_title', { title });
  }

  async zoom(delta: -1 | 0 | 1) {
    return Number(await call<number>('window_zoom', { delta }));
  }

  toggleFullscreen() {
    return call<void>('window_toggle_fullscreen');
  }

  showMainWindow() {
    return call<void>('window_show_main');
  }

  getPrefs() {
    return call('prefs_get', undefined, prefsSchema);
  }

  setPrefs(patch: Parameters<DesktopBackend['setPrefs']>[0]) {
    return call('prefs_set', { patch }, prefsSchema);
  }

  markUpdatesChecked() {
    return call<void>('updates_mark_checked');
  }

  showCapture() {
    return call<void>('capture_show');
  }

  captureReady() {
    return call<void>('capture_ready');
  }

  hideCapture() {
    return call<void>('capture_hide');
  }

  listRegistry() {
    return call('registry_list', undefined, registryItemSchema.array());
  }

  upsertRegistry(entry: Parameters<DesktopBackend['upsertRegistry']>[0]) {
    return call<void>('registry_upsert', { entry });
  }

  removeRegistry(id: string) {
    return call<void>('registry_remove', { id });
  }

  touchRegistry(id: string) {
    return call('registry_touch', { id }, registryEntrySchema);
  }

  inspectFolder(path: string) {
    return call('folder_inspect', { path }, folderInfoSchema);
  }

  suggestFolder(parent: string, name: string) {
    return call<string>('folder_suggest', { parent, name });
  }

  pickFolder(title: string, defaultPath?: string) {
    return call<string | null>('folder_pick', { title, defaultPath: defaultPath ?? null });
  }

  revealFolder(path: string) {
    return call<void>('folder_reveal', { path });
  }

  attachWorkspace(workspaceId: string, path: string, name: string) {
    return call('workspace_attach', { workspaceId, path, name }, workspaceStatusSchema);
  }

  detachWorkspace(workspaceId: string) {
    return call<void>('workspace_detach', { workspaceId });
  }

  workspaceStatus(workspaceId: string) {
    return call('workspace_status', { workspaceId }, workspaceStatusSchema);
  }

  setWorkspaceName(workspaceId: string, name: string) {
    return call<void>('workspace_set_name', { workspaceId, name });
  }

  mergeConflict(workspaceId: string, fileName: string) {
    return call('workspace_merge_conflict', { workspaceId, fileName }, mergeReportSchema);
  }

  async loadDoc(workspaceId: string, docName: string) {
    let result: unknown;
    try {
      result = await invoke('doc_load', { workspaceId, docName });
    } catch (error) {
      throw toDesktopError(error, 'doc_load');
    }
    return decodeUpdateFrame(toBytes(result));
  }

  async storeUpdate(workspaceId: string, docName: string, update: Uint8Array) {
    await callBinary('doc_store', update, {
      'x-tessera-workspace': workspaceId,
      'x-tessera-doc': docName,
    });
  }

  async compactDoc(workspaceId: string, docName: string, upto: number, merged: Uint8Array) {
    await callBinary('doc_compact', merged, {
      'x-tessera-workspace': workspaceId,
      'x-tessera-doc': docName,
      'x-tessera-upto': String(upto),
    });
  }

  deleteDoc(workspaceId: string, docName: string) {
    return call<void>('doc_delete', { workspaceId, docName });
  }

  listDocs(workspaceId: string, prefix: string) {
    return call<string[]>('doc_list', { workspaceId, prefix });
  }

  async putAsset(
    workspaceId: string,
    bytes: Uint8Array,
    options: { name?: string | null; mimeType?: string | null },
  ) {
    const headers: Record<string, string> = { 'x-tessera-workspace': workspaceId };
    if (options.name) headers['x-tessera-name'] = options.name;
    if (options.mimeType) headers['x-tessera-mime'] = options.mimeType;
    const result = await callBinary('asset_put', bytes, headers);
    const parsed = assetRowSchema.safeParse(result);
    if (!parsed.success)
      throw toDesktopError({ code: 'internal', message: parsed.error.message }, 'asset_put');
    return parsed.data;
  }

  async getAsset(workspaceId: string, assetId: string) {
    try {
      return toBytes(await invoke('asset_get', { workspaceId, assetId }));
    } catch (error) {
      const mapped = toDesktopError(error, 'asset_get');
      if (isNotFound(mapped)) return null;
      throw mapped;
    }
  }

  assetInfo(workspaceId: string, assetId: string) {
    return call('asset_info', { workspaceId, assetId }, assetRowSchema.nullable());
  }

  listAssets(workspaceId: string) {
    return call('asset_list', { workspaceId }, assetRowSchema.array());
  }

  deleteAsset(workspaceId: string, assetId: string) {
    return call<void>('asset_delete', { workspaceId, assetId });
  }

  assetUrl(workspaceId: string, assetId: string) {
    return convertFileSrc(`${workspaceId}/${assetId}`, ASSET_SCHEME);
  }

  mirrorBegin(workspaceId: string) {
    return call<void>('mirror_begin', { workspaceId });
  }

  async mirrorWrite(workspaceId: string, path: string, bytes: Uint8Array) {
    const result = await callBinary('mirror_write', bytes, {
      'x-tessera-workspace': workspaceId,
      'x-tessera-path': path,
    });
    return result === true;
  }

  mirrorFinish(workspaceId: string, keep?: readonly string[]) {
    return call(
      'mirror_finish',
      { workspaceId, keep: keep ? [...keep] : null },
      mirrorReportSchema,
    );
  }

  getSecret(server: string) {
    return call<string | null>('secret_get', { server });
  }

  setSecret(server: string, token: string) {
    return call<void>('secret_set', { server, token });
  }

  deleteSecret(server: string) {
    return call<void>('secret_delete', { server });
  }

  listServers() {
    return call('secret_servers', undefined, serverEntrySchema.array());
  }

  checkForUpdate() {
    return call('updater_check', undefined, updateInfoSchema);
  }

  installUpdate() {
    return call<void>('updater_install');
  }

  onDocUpdate(listener: Parameters<DesktopBackend['onDocUpdate']>[0]) {
    return subscribe(EVENTS.docUpdate, docUpdateEventSchema, listener);
  }

  onRegistryChanged(listener: (origin: string) => void) {
    return subscribe(EVENTS.registryChanged, originEventSchema, ({ origin }) => listener(origin));
  }

  onFlushRequest(listener: () => void) {
    return subscribe(EVENTS.flushRequest, null, () => listener());
  }

  onMenu(listener: (id: string) => void) {
    return subscribe<unknown>(EVENTS.menu, null, (id) => {
      if (typeof id === 'string') listener(id);
    });
  }

  onDeepLink(listener: () => void) {
    return subscribe(EVENTS.deepLink, null, () => listener());
  }

  onCaptureShown(listener: () => void) {
    return subscribe(EVENTS.captureShown, null, () => listener());
  }

  onUpdateProgress(listener: Parameters<DesktopBackend['onUpdateProgress']>[0]) {
    return subscribe(EVENTS.updateProgress, updateProgressSchema, listener);
  }
}
