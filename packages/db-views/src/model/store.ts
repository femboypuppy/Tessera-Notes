import {
  getDatabaseMeta,
  getRow,
  listProperties,
  listRows,
  listViews,
  observeDatabase,
  sortOrdered,
  type DatabaseChange,
  type DatabaseMeta,
  type DatabaseRow,
  type PageMeta,
  type PagesStore,
  type PropertyDefinition,
  type ResolvedRow,
  type ViewConfig,
} from '@tessera/core';
import type * as Y from 'yjs';

/** Everything a view needs from a database doc, joined with page metadata. Immutable. */
export interface DatabaseSnapshot {
  /** Increments on every change. */
  readonly version: number;
  readonly properties: readonly PropertyDefinition[];
  readonly titleProperty: PropertyDefinition | undefined;
  readonly views: readonly ViewConfig[];
  /**
   * Every row in manual order, joined with its page (title, icon, timestamps, trash). Row objects
   * keep their identity until the row or its page changes, so per-row caches stay warm.
   */
  readonly rows: readonly ResolvedRow[];
  readonly meta: DatabaseMeta;
  /** True once the doc has a title property (it may be empty right after creation elsewhere). */
  readonly initialized: boolean;
}

/**
 * A subscribable, incrementally updated view of one database doc, for `useSyncExternalStore`.
 * It re-reads only the rows a transaction touched and re-joins rows whose page changed, so a
 * database with 10,000 rows updates in well under a frame. Nothing is mirrored into React state.
 *
 * Get one with {@link acquireDatabaseStore}, which shares a store between every view of a doc.
 */
export class DatabaseStore {
  private snapshot: DatabaseSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly raw = new Map<string, DatabaseRow>();
  private orderedIds: string[] = [];
  private readonly resolved = new Map<
    string,
    { row: ResolvedRow; raw: DatabaseRow; page: PageMeta | undefined; trashed: boolean }
  >();
  private readonly stops: Array<() => void> = [];

  constructor(
    readonly doc: Y.Doc,
    private readonly pages: PagesStore,
  ) {
    for (const row of listRows(doc)) this.raw.set(row.id, row);
    this.orderedIds = [...this.raw.keys()];
    this.snapshot = this.build(0, true, true, true);
    this.stops.push(observeDatabase(doc, (change) => this.onDatabaseChange(change)));
    this.stops.push(pages.subscribe(() => this.onPagesChange()));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): DatabaseSnapshot => this.snapshot;

  dispose(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.listeners.clear();
  }

  private onDatabaseChange(change: DatabaseChange): void {
    const rowsChanged =
      change.rows.added.length + change.rows.updated.length + change.rows.removed.length > 0;
    if (rowsChanged) {
      let reorder = change.rows.added.length > 0 || change.rows.removed.length > 0;
      for (const id of change.rows.removed) this.raw.delete(id);
      for (const id of [...change.rows.added, ...change.rows.updated]) {
        const row = getRow(this.doc, id);
        const previous = this.raw.get(id);
        if (row) {
          if (previous && previous.order !== row.order) reorder = true;
          this.raw.set(id, row);
        } else {
          this.raw.delete(id);
          reorder = true;
        }
      }
      if (reorder) this.orderedIds = sortOrdered(this.raw.values()).map((row) => row.id);
    }
    this.publish(change.schema, change.views.length > 0, change.meta || change.schema);
  }

  private onPagesChange(): void {
    // Most page changes happen elsewhere in the workspace (an import creates thousands of pages):
    // publish only when one of the rows changed with its page.
    const rows = this.resolveRows();
    const previous = this.snapshot.rows;
    if (rows.length === previous.length && rows.every((row, index) => row === previous[index]))
      return;
    this.publish(false, false, false, rows);
  }

  private publish(schema: boolean, views: boolean, meta: boolean, rows?: ResolvedRow[]): void {
    this.snapshot = this.build(this.snapshot.version + 1, schema, views, meta, rows);
    for (const listener of [...this.listeners]) listener();
  }

  private resolveRows(): ResolvedRow[] {
    const pages = this.pages.getSnapshot();
    const rows: ResolvedRow[] = [];
    const alive = new Set<string>();
    for (const id of this.orderedIds) {
      const raw = this.raw.get(id);
      if (!raw) continue;
      alive.add(id);
      const page = pages.get(id);
      const trashed = page ? pages.isTrashed(id) : false;
      const cached = this.resolved.get(id);
      if (cached && cached.raw === raw && cached.page === page && cached.trashed === trashed) {
        rows.push(cached.row);
        continue;
      }
      const row: ResolvedRow = {
        ...raw,
        title: page?.title ?? '',
        createdAt: page?.createdAt ?? raw.valuesUpdatedAt ?? 0,
        updatedAt: Math.max(page?.updatedAt ?? 0, raw.valuesUpdatedAt ?? 0),
        trashed,
        missingPage: !page,
      };
      if (page?.icon) row.icon = page.icon;
      if (page?.createdBy) row.createdBy = page.createdBy;
      const updatedBy =
        (raw.valuesUpdatedAt ?? 0) > (page?.updatedAt ?? 0) ? raw.valuesUpdatedBy : page?.updatedBy;
      if (updatedBy) row.updatedBy = updatedBy;
      this.resolved.set(id, { row, raw, page, trashed });
      rows.push(row);
    }
    if (this.resolved.size > alive.size) {
      for (const id of this.resolved.keys()) if (!alive.has(id)) this.resolved.delete(id);
    }
    return rows;
  }

  private build(
    version: number,
    schema: boolean,
    views: boolean,
    meta: boolean,
    rows = this.resolveRows(),
  ): DatabaseSnapshot {
    const previous = this.snapshot as DatabaseSnapshot | undefined;
    const properties = schema || !previous ? listProperties(this.doc) : previous.properties;
    return {
      version,
      properties,
      titleProperty: properties.find((property) => property.type === 'title'),
      views: views || !previous ? listViews(this.doc) : previous.views,
      rows,
      meta: meta || !previous ? getDatabaseMeta(this.doc) : previous.meta,
      initialized: properties.some((property) => property.type === 'title'),
    };
  }
}

const stores = new WeakMap<Y.Doc, { store: DatabaseStore; refs: number }>();

/**
 * A shared store for a database doc. Release it when done; the last release disposes it.
 *
 * @example
 * const { store, release } = acquireDatabaseStore(handle.doc, ctx.workspace.pages);
 */
export function acquireDatabaseStore(
  doc: Y.Doc,
  pages: PagesStore,
): { store: DatabaseStore; release: () => void } {
  let entry = stores.get(doc);
  if (!entry) {
    entry = { store: new DatabaseStore(doc, pages), refs: 0 };
    stores.set(doc, entry);
  }
  entry.refs += 1;
  const current = entry;
  let released = false;
  return {
    store: current.store,
    release: () => {
      if (released) return;
      released = true;
      current.refs -= 1;
      if (current.refs === 0) {
        current.store.dispose();
        if (stores.get(doc) === current) stores.delete(doc);
      }
    },
  };
}
