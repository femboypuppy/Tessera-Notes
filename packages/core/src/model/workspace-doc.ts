import type * as Y from 'yjs';
import { isJsonValue, type JsonValue } from '../json';

/**
 * Version of the Y.Doc data model (workspace, page and database doc structure plus the document
 * schema). Stored in the workspace doc's and each database doc's `meta` map when they are created.
 */
export const DATA_MODEL_VERSION = 1;

/** Top-level shared types of the workspace doc (`ws:<workspaceId>`). Internal to core. */
export const WORKSPACE_DOC_KEYS = {
  /** `Y.Map<pageId, Y.Map<PageMeta field, value>>` */
  pages: 'pages',
  /** `Y.Map<settingKey, JsonValue>`: workspace-wide settings shared with collaborators. */
  settings: 'settings',
  /** `Y.Map`: `schemaVersion`, `createdAt`. */
  meta: 'meta',
  /**
   * `Y.Map<pageId, deletedAt>`: every page deleted permanently, so that any client can tell a
   * deleted page from one it hasn't received yet (and clean up references to it safely).
   */
  deletedPages: 'deletedPages',
} as const;

/** @internal Raw access for core helpers. Other packages must use the typed helpers. */
export function pagesMapOf(ws: Y.Doc): Y.Map<unknown> {
  return ws.getMap<unknown>(WORKSPACE_DOC_KEYS.pages);
}

/** @internal */
export function settingsMapOf(ws: Y.Doc): Y.Map<unknown> {
  return ws.getMap<unknown>(WORKSPACE_DOC_KEYS.settings);
}

/** @internal */
export function deletedPagesMapOf(ws: Y.Doc): Y.Map<unknown> {
  return ws.getMap<unknown>(WORKSPACE_DOC_KEYS.deletedPages);
}

/** @internal */
export function metaMapOf(ws: Y.Doc): Y.Map<unknown> {
  return ws.getMap<unknown>(WORKSPACE_DOC_KEYS.meta);
}

/**
 * Stamps a new workspace doc with the data-model version. Call it once, right after creating a
 * workspace (never on every open, so read-only viewers never write). Idempotent.
 *
 * @example
 * initWorkspaceDoc(wsDoc, { now: Date.now() });
 */
export function initWorkspaceDoc(
  ws: Y.Doc,
  options: { now?: number; origin?: unknown } = {},
): void {
  const meta = metaMapOf(ws);
  if (meta.has('schemaVersion')) return;
  ws.transact(() => {
    meta.set('schemaVersion', DATA_MODEL_VERSION);
    meta.set('createdAt', options.now ?? Date.now());
  }, options.origin);
}

/** Returns the data-model version stamped on a workspace doc, or null for an unstamped doc. */
export function getWorkspaceSchemaVersion(ws: Y.Doc): number | null {
  const version = metaMapOf(ws).get('schemaVersion');
  return typeof version === 'number' ? version : null;
}

/**
 * Reads a workspace-wide setting (shared with collaborators and synced).
 * Keys are namespaced by feature: `<featureId>.<name>`.
 *
 * @example
 * getWorkspaceSetting(wsDoc, 'backlinks.showFooter'); // true | undefined
 */
export function getWorkspaceSetting(ws: Y.Doc, key: string): JsonValue | undefined {
  const value = settingsMapOf(ws).get(key);
  return isJsonValue(value) ? value : undefined;
}

/** Writes (or, with `undefined`, deletes) a workspace-wide setting. */
export function setWorkspaceSetting(
  ws: Y.Doc,
  key: string,
  value: JsonValue | undefined,
  options: { origin?: unknown } = {},
): void {
  if (value !== undefined && !isJsonValue(value)) {
    throw new TypeError(`Setting "${key}" must be a JSON value`);
  }
  ws.transact(() => {
    const settings = settingsMapOf(ws);
    if (value === undefined) settings.delete(key);
    else settings.set(key, value);
  }, options.origin);
}

/** Lists workspace setting keys, optionally filtered by prefix. */
export function listWorkspaceSettingKeys(ws: Y.Doc, prefix = ''): string[] {
  return [...settingsMapOf(ws).keys()].filter((key) => key.startsWith(prefix)).sort();
}

/** Observes workspace settings. The listener receives the changed keys. */
export function observeWorkspaceSettings(
  ws: Y.Doc,
  listener: (keys: string[], transaction: Y.Transaction) => void,
): () => void {
  const settings = settingsMapOf(ws);
  const handler = (event: Y.YMapEvent<unknown>, transaction: Y.Transaction) => {
    listener([...event.keysChanged], transaction);
  };
  settings.observe(handler);
  return () => settings.unobserve(handler);
}
