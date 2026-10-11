import * as Y from 'yjs';
import { InvalidOperationError, NotFoundError, ValidationError } from '../errors';
import { isValidId, newId } from '../ids';
import {
  compareOrdered,
  isValidOrderKey,
  orderAfterAll,
  orderForIndex,
  ordersBetween,
  type ListPosition,
} from '../order';
import { createPageIndex, type PageIndex } from './page-index';
import {
  isValidIcon,
  normalizeTitle,
  PAGE_KINDS,
  parsePageCover,
  type PageCover,
  type PageKind,
  type PageMeta,
} from './page-meta';
import { deletedPagesMapOf, pagesMapOf } from './workspace-doc';

/** Options accepted by every mutating helper. */
export interface MutationOptions {
  /** Transaction origin, forwarded to `Y.Doc.transact` (lets observers tell who made a change). */
  origin?: unknown;
  /** Epoch milliseconds to record. Defaults to `Date.now()`. */
  now?: number;
  /** ID of the user making the change (recorded as `createdBy`/`updatedBy`/`trashedBy`). */
  userId?: string;
}

/**
 * Where to put a page among its siblings (non-trashed pages with the same parent):
 * `'end'` (the default), `'start'`, an index, or directly before/after a sibling.
 */
export type PagePosition = ListPosition;

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * @internal Reads a PageMeta out of its Y.Map, tolerating malformed fields (a bad field never
 * makes a page disappear). Returns null when the entry is not a Y.Map at all.
 */
export function readPageMeta(id: string, value: unknown): PageMeta | null {
  if (!(value instanceof Y.Map)) return null;
  const map = value as Y.Map<unknown>;
  const kind = map.get('kind') === 'database' ? 'database' : 'page';
  const parentRaw = map.get('parentId');
  const meta: PageMeta = {
    id,
    kind,
    title: str(map.get('title')) ?? '',
    parentId: typeof parentRaw === 'string' && parentRaw !== id ? parentRaw : null,
    order: str(map.get('order')) || 'a0',
    createdAt: num(map.get('createdAt')) ?? 0,
    updatedAt: num(map.get('updatedAt')) ?? num(map.get('createdAt')) ?? 0,
  };
  const icon = str(map.get('icon'));
  if (icon) meta.icon = icon;
  const cover = parsePageCover(map.get('cover'));
  if (cover) meta.cover = cover;
  const createdBy = str(map.get('createdBy'));
  if (createdBy) meta.createdBy = createdBy;
  const updatedBy = str(map.get('updatedBy'));
  if (updatedBy) meta.updatedBy = updatedBy;
  const trashedAt = num(map.get('trashedAt'));
  if (trashedAt !== undefined) meta.trashedAt = trashedAt;
  const trashedBy = str(map.get('trashedBy'));
  if (trashedBy) meta.trashedBy = trashedBy;
  if (map.get('favorite') === true) meta.favorite = true;
  return meta;
}

function pageMap(ws: Y.Doc, id: string): Y.Map<unknown> {
  const value = pagesMapOf(ws).get(id);
  if (!(value instanceof Y.Map)) throw new NotFoundError('Page', id);
  return value as Y.Map<unknown>;
}

/**
 * Returns a page's metadata, or undefined when it does not exist.
 *
 * @example
 * const page = getPage(wsDoc, pageId);
 */
export function getPage(ws: Y.Doc, id: string): PageMeta | undefined {
  return readPageMeta(id, pagesMapOf(ws).get(id)) ?? undefined;
}

/** Returns a page's metadata or throws {@link NotFoundError}. */
export function requirePage(ws: Y.Doc, id: string): PageMeta {
  const page = getPage(ws, id);
  if (!page) throw new NotFoundError('Page', id);
  return page;
}

/** Returns every page (including trashed pages and database rows), in no particular order. */
export function listPages(ws: Y.Doc): PageMeta[] {
  const result: PageMeta[] = [];
  pagesMapOf(ws).forEach((value, id) => {
    const page = readPageMeta(id, value);
    if (page) result.push(page);
  });
  return result;
}

/**
 * Builds a {@link PageIndex} over the workspace's current pages, for repeated queries.
 * The React layer keeps one up to date for you (`usePages()`); use this in non-UI code.
 */
export function indexPages(ws: Y.Doc): PageIndex {
  return createPageIndex(listPages(ws));
}

/**
 * Returns the sorted children of a page (or of the top level when `parentId` is null).
 * Trashed pages and database rows are excluded unless requested.
 *
 * @example
 * getChildren(wsDoc, null); // top-level pages in sidebar order
 */
export function getChildren(
  ws: Y.Doc,
  parentId: string | null,
  options?: { includeTrashed?: boolean; includeRows?: boolean },
): readonly PageMeta[] {
  return indexPages(ws).children(parentId, options);
}

/**
 * Returns the ancestors of a page, root first (the breadcrumb trail, without the page itself).
 * Safe against cycles and missing parents.
 */
export function getAncestors(ws: Y.Doc, id: string): readonly PageMeta[] {
  return indexPages(ws).ancestors(id);
}

/** Returns every descendant of a page (including trashed pages and rows), depth-first. */
export function getDescendants(ws: Y.Doc, id: string): readonly PageMeta[] {
  return indexPages(ws).descendants(id);
}

/** True when the page, or one of its ancestors, is in the trash. */
export function isPageTrashed(ws: Y.Doc, id: string): boolean {
  return indexPages(ws).isTrashed(id);
}

/** True when the page is a database row (its parent is a database page). */
export function isDatabaseRow(ws: Y.Doc, id: string): boolean {
  return indexPages(ws).isRow(id);
}

/** Pages trashed directly (not through an ancestor), newest first. */
export function listTrash(ws: Y.Doc): readonly PageMeta[] {
  return indexPages(ws).trash();
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

function resolveIndex(
  index: PageIndex,
  siblings: readonly PageMeta[],
  position: PagePosition,
): number {
  if (position === 'start') return 0;
  if (position === 'end') return siblings.length;
  if ('index' in position) return position.index;
  const anchorId = 'before' in position ? position.before : position.after;
  const at = siblings.findIndex((page) => page.id === anchorId);
  if (at < 0) {
    if (!index.has(anchorId)) throw new NotFoundError('Page', anchorId);
    throw new InvalidOperationError(`Page "${anchorId}" is not a sibling at the target position`);
  }
  return 'before' in position ? at : at + 1;
}

/** Computes the order key for `pageId` (which may be new) under `parentId` at `position`. */
function placeAmongSiblings(
  ws: Y.Doc,
  index: PageIndex,
  parentId: string | null,
  position: PagePosition,
  movingId: string | null,
): string {
  const includeRows = parentId !== null && index.get(parentId)?.kind === 'database';
  const siblings = index.children(parentId, { includeRows }).filter((page) => page.id !== movingId);
  if (position === 'end') {
    // After every sibling, trashed ones included, so a restore never jumps ahead of it.
    const all = index.children(parentId, { includeRows: true, includeTrashed: true });
    return orderAfterAll(all.filter((page) => page.id !== movingId));
  }
  const { order, rekeyed } = orderForIndex(siblings, resolveIndex(index, siblings, position));
  const pages = pagesMapOf(ws);
  for (const { id, order: newOrder } of rekeyed) {
    const map = pages.get(id);
    if (map instanceof Y.Map) map.set('order', newOrder);
  }
  return order;
}

function assertParentUsable(index: PageIndex, parentId: string | null): void {
  if (parentId === null) return;
  if (!index.has(parentId)) throw new NotFoundError('Page', parentId);
  if (index.isTrashed(parentId)) {
    throw new InvalidOperationError('Cannot put a page inside a page that is in the trash', {
      parentId,
    });
  }
}

/** Input for {@link createPage}. */
export interface CreatePageInput {
  /** Defaults to a new nanoid. */
  id?: string;
  /** Defaults to `'page'`. Prefer `AppContext.workspace.createDatabase` for databases (it also creates the database doc). */
  kind?: PageKind;
  title?: string;
  icon?: string;
  cover?: PageCover;
  /** Defaults to null (top level). A database page as parent makes this page a row of that database. */
  parentId?: string | null;
  /** Defaults to `'end'`. */
  position?: PagePosition;
  favorite?: boolean;
  /** Override timestamps (importers preserving the source's dates). */
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Creates a page in the workspace doc and returns its metadata. Does not create the page doc:
 * page docs are created lazily the first time something writes to them.
 *
 * @example
 * const page = createPage(wsDoc, { title: 'Meeting notes', parentId: projectId }, { userId });
 */
export function createPage(
  ws: Y.Doc,
  input: CreatePageInput = {},
  options: MutationOptions = {},
): PageMeta {
  const id = input.id ?? newId();
  const kind = validateNewPage(id, input);
  const parentId = input.parentId ?? null;

  let created: PageMeta | undefined;
  ws.transact(() => {
    const pages = pagesMapOf(ws);
    if (pages.has(id)) throw new InvalidOperationError(`Page "${id}" already exists`, { id });
    const index = indexPages(ws);
    assertParentUsable(index, parentId);
    const order = placeAmongSiblings(ws, index, parentId, input.position ?? 'end', null);
    const map = newPageMap(kind, parentId, order, input, options);
    pages.set(id, map);
    created = readPageMeta(id, map) ?? undefined;
  }, options.origin);
  if (!created) throw new InvalidOperationError('Failed to create page');
  return created;
}

/** Input for {@link createPages}: a {@link CreatePageInput} without `position`. */
export type CreatePagesInput = Omit<CreatePageInput, 'position'>;

/**
 * Creates many pages in one transaction and indexes the workspace once, so n pages cost O(n)
 * where n {@link createPage} calls cost O(n²) (each one re-indexes every page). Importers and bulk
 * database rows use it. Pages are created in input order, each after its parent's existing
 * children (trashed pages and rows included), so an input can be the parent of a later one.
 * Every input is validated before the first write: on an error nothing is created.
 *
 * @example
 * const [folder, note] = createPages(wsDoc, [
 *   { id: folderId, title: 'Vault' },
 *   { title: 'First note', parentId: folderId },
 * ], { userId });
 */
export function createPages(
  ws: Y.Doc,
  inputs: readonly CreatePagesInput[],
  options: MutationOptions = {},
): PageMeta[] {
  if (inputs.length === 0) return [];
  const created: PageMeta[] = [];
  ws.transact(() => {
    const pages = pagesMapOf(ws);
    const index = indexPages(ws);
    // Validate everything first: Yjs cannot roll back a half-applied transaction.
    const planned: Array<{
      id: string;
      kind: PageKind;
      parentId: string | null;
      input: CreatePagesInput;
    }> = [];
    const batch = new Set<string>();
    const counts = new Map<string | null, number>();
    for (const input of inputs) {
      const id = input.id ?? newId();
      const kind = validateNewPage(id, input);
      const parentId = input.parentId ?? null;
      if (pages.has(id) || batch.has(id))
        throw new InvalidOperationError(`Page "${id}" already exists`, { id });
      // A parent is an existing page, or an input earlier in the list (so no cycles can form).
      if (parentId === null || !batch.has(parentId)) assertParentUsable(index, parentId);
      batch.add(id);
      counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
      planned.push({ id, kind, parentId, input });
    }
    const orders = new Map<string | null, string[]>();
    for (const [parentId, count] of counts) {
      const last =
        parentId !== null && batch.has(parentId)
          ? null
          : lastOrderAmong(index.children(parentId, { includeRows: true, includeTrashed: true }));
      orders.set(parentId, ordersBetween(last, null, count));
    }
    const used = new Map<string | null, number>();
    for (const { id, kind, parentId, input } of planned) {
      const at = used.get(parentId) ?? 0;
      used.set(parentId, at + 1);
      const order = orders.get(parentId)?.[at];
      if (order === undefined) throw new InvalidOperationError('Failed to order the new pages');
      const map = newPageMap(kind, parentId, order, input, options);
      pages.set(id, map);
      const meta = readPageMeta(id, map);
      if (meta) created.push(meta);
    }
  }, options.origin);
  return created;
}

/** Checks a new page's input (not its parent) and returns its kind. */
function validateNewPage(id: string, input: CreatePagesInput): PageKind {
  if (!isValidId(id)) throw new ValidationError('Invalid page ID', [id]);
  const kind = input.kind ?? 'page';
  if (!PAGE_KINDS.includes(kind)) throw new ValidationError('Invalid page kind', [String(kind)]);
  if (input.icon !== undefined && !isValidIcon(input.icon)) {
    throw new ValidationError('Page icons must be a single emoji', [input.icon]);
  }
  if (input.cover !== undefined && !parsePageCover(input.cover)) {
    throw new ValidationError('Invalid page cover');
  }
  if ((input.parentId ?? null) === id)
    throw new InvalidOperationError('A page cannot be its own parent');
  return kind;
}

/** The Y.Map of a new page (validated input). */
function newPageMap(
  kind: PageKind,
  parentId: string | null,
  order: string,
  input: CreatePagesInput,
  options: MutationOptions,
): Y.Map<unknown> {
  const now = options.now ?? Date.now();
  const map = new Y.Map<unknown>();
  map.set('kind', kind);
  map.set('title', normalizeTitle(input.title ?? ''));
  map.set('parentId', parentId);
  map.set('order', order);
  map.set('createdAt', input.createdAt ?? now);
  map.set('updatedAt', input.updatedAt ?? input.createdAt ?? now);
  if (options.userId) {
    map.set('createdBy', options.userId);
    map.set('updatedBy', options.userId);
  }
  if (input.icon) map.set('icon', input.icon);
  if (input.cover) map.set('cover', { ...input.cover });
  if (input.favorite) map.set('favorite', true);
  return map;
}

/** The largest valid order key among siblings, or null when there is none. */
function lastOrderAmong(siblings: readonly PageMeta[]): string | null {
  let last: string | null = null;
  for (const sibling of siblings) {
    if (isValidOrderKey(sibling.order) && (last === null || sibling.order > last))
      last = sibling.order;
  }
  return last;
}

function touch(map: Y.Map<unknown>, options: MutationOptions): void {
  map.set('updatedAt', options.now ?? Date.now());
  if (options.userId) map.set('updatedBy', options.userId);
}

/**
 * Renames a page. The title is normalized (no line breaks, bounded length).
 *
 * @example
 * renamePage(wsDoc, pageId, 'Q3 roadmap', { userId });
 */
export function renamePage(
  ws: Y.Doc,
  id: string,
  title: string,
  options: MutationOptions = {},
): void {
  ws.transact(() => {
    const map = pageMap(ws, id);
    const next = normalizeTitle(title);
    if (map.get('title') === next) return;
    map.set('title', next);
    touch(map, options);
  }, options.origin);
}

/** Target of {@link movePage}. */
export interface MoveTarget {
  /** New parent, or null for the top level. */
  parentId: string | null;
  /** Defaults to `'end'`. */
  position?: PagePosition;
}

/**
 * Moves a page (with its subtree) under a new parent and/or to a new position among siblings.
 * Throws {@link InvalidOperationError} for moves into itself or a descendant, into a trashed
 * page, and for database rows (rows are ordered inside their database doc instead).
 *
 * @example
 * movePage(wsDoc, pageId, { parentId: otherId, position: { index: 0 } });
 */
export function movePage(
  ws: Y.Doc,
  id: string,
  target: MoveTarget,
  options: MutationOptions = {},
): void {
  ws.transact(() => {
    const map = pageMap(ws, id);
    const index = indexPages(ws);
    const parentId = target.parentId;
    if (parentId === id) throw new InvalidOperationError('A page cannot be moved into itself');
    assertParentUsable(index, parentId);
    if (parentId !== null && index.ancestors(parentId).some((page) => page.id === id)) {
      throw new InvalidOperationError('A page cannot be moved into one of its own subpages');
    }
    if (index.isRow(id)) {
      throw new InvalidOperationError(
        'Database rows are ordered in their database, not in the page tree',
      );
    }
    if (parentId !== null && index.get(parentId)?.kind === 'database') {
      throw new InvalidOperationError('Pages cannot be moved into a database; add a row instead');
    }
    if (index.isTrashed(id)) throw new InvalidOperationError('Restore the page before moving it');
    const order = placeAmongSiblings(ws, index, parentId, target.position ?? 'end', id);
    if (map.get('parentId') !== parentId) map.set('parentId', parentId);
    if (map.get('order') !== order) map.set('order', order);
  }, options.origin);
}

/** Sets (or, with null, removes) a page's emoji icon. */
export function setIcon(
  ws: Y.Doc,
  id: string,
  icon: string | null,
  options: MutationOptions = {},
): void {
  if (icon !== null && !isValidIcon(icon))
    throw new ValidationError('Page icons must be a single emoji', [icon]);
  ws.transact(() => {
    const map = pageMap(ws, id);
    if (icon === null) map.delete('icon');
    else map.set('icon', icon);
    touch(map, options);
  }, options.origin);
}

/** Sets (or, with null, removes) a page's cover. */
export function setCover(
  ws: Y.Doc,
  id: string,
  cover: PageCover | null,
  options: MutationOptions = {},
): void {
  if (cover !== null && !parsePageCover(cover)) throw new ValidationError('Invalid page cover');
  ws.transact(() => {
    const map = pageMap(ws, id);
    if (cover === null) map.delete('cover');
    else map.set('cover', { ...cover });
    touch(map, options);
  }, options.origin);
}

/** Adds a page to, or removes it from, the favorites. */
export function setFavorite(
  ws: Y.Doc,
  id: string,
  favorite: boolean,
  options: MutationOptions = {},
): void {
  ws.transact(() => {
    const map = pageMap(ws, id);
    if (favorite) map.set('favorite', true);
    else map.delete('favorite');
  }, options.origin);
}

/**
 * Records that a page was edited (bumps `updatedAt`/`updatedBy`). The runtime calls this,
 * debounced, whenever a page doc changes locally; features rarely need it.
 */
export function touchPage(ws: Y.Doc, id: string, options: MutationOptions = {}): void {
  ws.transact(() => touch(pageMap(ws, id), options), options.origin);
}

/** Result of {@link trashPage} and {@link restorePage}. */
export interface TrashChange {
  pageId: string;
  /** The page and every descendant whose effective trash state changed. */
  affectedIds: string[];
}

/**
 * Moves a page (and implicitly its subtree) to the trash. No-op when it is already trashed.
 *
 * @example
 * const { affectedIds } = trashPage(wsDoc, pageId, { userId });
 */
export function trashPage(ws: Y.Doc, id: string, options: MutationOptions = {}): TrashChange {
  let affectedIds: string[] = [];
  ws.transact(() => {
    const map = pageMap(ws, id);
    const index = indexPages(ws);
    if (index.isTrashed(id)) return;
    map.set('trashedAt', options.now ?? Date.now());
    if (options.userId) map.set('trashedBy', options.userId);
    else map.delete('trashedBy');
    affectedIds = [
      id,
      ...index
        .descendants(id)
        .filter((page) => !index.isTrashed(page.id))
        .map((page) => page.id),
    ];
  }, options.origin);
  return { pageId: id, affectedIds };
}

/**
 * Restores a page from the trash. When its parent no longer exists or is itself in the trash,
 * the page is restored to the top level instead. Descendants that were trashed on their own
 * stay in the trash.
 */
export function restorePage(ws: Y.Doc, id: string, options: MutationOptions = {}): TrashChange {
  let affectedIds: string[] = [];
  ws.transact(() => {
    const map = pageMap(ws, id);
    if (!map.has('trashedAt')) return;
    map.delete('trashedAt');
    map.delete('trashedBy');
    let index = indexPages(ws);
    const parentId = index.get(id)?.parentId ?? null;
    if (parentId !== null && (!index.has(parentId) || index.isTrashed(parentId))) {
      map.set('parentId', null);
      index = indexPages(ws);
      map.set('order', placeAmongSiblings(ws, index, null, 'end', id));
      index = indexPages(ws);
    }
    if (index.isTrashed(id)) return;
    affectedIds = [
      id,
      ...index
        .descendants(id)
        .filter((page) => !index.isTrashed(page.id))
        .map((page) => page.id),
    ];
  }, options.origin);
  return { pageId: id, affectedIds };
}

/**
 * Permanently deletes a page and its whole subtree from the workspace doc and returns the removed
 * metadata (parents before children). The caller must also delete their page and database docs;
 * `AppContext.workspace.deletePagePermanently` does both.
 */
export function deletePagePermanently(
  ws: Y.Doc,
  id: string,
  options: MutationOptions = {},
): PageMeta[] {
  let removed: PageMeta[] = [];
  ws.transact(() => {
    const index = indexPages(ws);
    const page = index.get(id);
    if (!page) throw new NotFoundError('Page', id);
    removed = [page, ...index.descendants(id)];
    const pages = pagesMapOf(ws);
    const deleted = deletedPagesMapOf(ws);
    const now = options.now ?? Date.now();
    for (const entry of removed) {
      pages.delete(entry.id);
      deleted.set(entry.id, now);
    }
  }, options.origin);
  return removed;
}

/** Permanently deletes everything in the trash. Returns the removed metadata. */
export function emptyTrash(ws: Y.Doc, options: MutationOptions = {}): PageMeta[] {
  const removed: PageMeta[] = [];
  ws.transact(() => {
    const index = indexPages(ws);
    const roots = index.trash().filter((page) => {
      const parentId = index.effectiveParentId(page.id);
      return parentId === null || !index.isTrashed(parentId);
    });
    const seen = new Set<string>();
    const pages = pagesMapOf(ws);
    const deleted = deletedPagesMapOf(ws);
    const now = options.now ?? Date.now();
    for (const root of roots) {
      for (const entry of [root, ...index.descendants(root.id)]) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        removed.push(entry);
        pages.delete(entry.id);
        deleted.set(entry.id, now);
      }
    }
  }, options.origin);
  return removed;
}

/**
 * The IDs of every page deleted permanently in this workspace, and not created again since. A
 * page that is merely missing (not synced to this device yet) is never in it, so references to
 * these IDs are safe to remove on any client.
 *
 * Deletions are read from the `deletedPages` record, and from the tombstones Yjs keeps for each
 * key removed from `pages`, which also covers deletions made before that record existed.
 */
export function permanentlyDeletedPageIds(ws: Y.Doc): Set<string> {
  const pages = pagesMapOf(ws);
  const ids = new Set<string>();
  for (const id of deletedPagesMapOf(ws).keys()) {
    if (!pages.has(id)) ids.add(id);
  }
  // `_map` holds the last item written under each key; it stays (deleted) after `delete(key)`.
  for (const [id, item] of pages._map) {
    if (item.deleted && !pages.has(id) && isValidId(id)) ids.add(id);
  }
  return ids;
}

/** Sorts pages the way siblings are displayed. */
export function sortPages(pages: Iterable<PageMeta>): PageMeta[] {
  return [...pages].sort(compareOrdered);
}
