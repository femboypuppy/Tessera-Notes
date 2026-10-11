import {
  addProperty,
  getProperty,
  getRow,
  isValidId,
  listProperties,
  listRows,
  permanentlyDeletedPageIds,
  setRowValue,
  updateProperty,
  type AppContext,
  type JsonValue,
  type PropertyDefinition,
} from '@tessera/core';
import type * as Y from 'yjs';

/*
 * Two-way relations: property P in database A targets database B, and its back property Q in B
 * targets A (each names the other in `relation.backPropertyId`). Whenever a row a adds or removes
 * a row b in P, b's Q gains or loses a, and the other way round. Trashing either side changes no
 * data (views hide relations to trashed pages, so restoring brings the link back); deleting a page
 * permanently removes it from every relation that points to it.
 */

/** The page IDs stored in a relation value (empty for anything else). */
export function relationIds(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => isValidId(id)) : [];
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function writeIds(db: Y.Doc, rowId: string, propertyId: string, ids: readonly string[]): void {
  setRowValue(db, rowId, propertyId, ids.length > 0 ? [...ids] : null);
}

/**
 * Sets a relation cell and keeps its back property in the target database in step. A relation
 * limited to one page keeps the last one given.
 *
 * @example
 * await setRelationValue(ctx, dbDoc, databaseId, rowId, projectProperty, [projectRowId]);
 */
export async function setRelationValue(
  ctx: Pick<AppContext, 'loadDatabaseDoc'>,
  db: Y.Doc,
  rowId: string,
  property: PropertyDefinition,
  next: readonly string[],
): Promise<void> {
  const before = relationIds(getRow(db, rowId)?.values[property.id]);
  const wanted = unique(next.filter((id) => isValidId(id) && id !== rowId));
  const limited = property.relation?.limit === 'one' ? wanted.slice(-1) : wanted;
  writeIds(db, rowId, property.id, limited);
  const added = limited.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !limited.includes(id));
  await updateBackLinks(ctx, db, rowId, property, added, removed);
}

/** Adds `rowId` to the back property of `added` rows and removes it from `removed` rows. */
async function updateBackLinks(
  ctx: Pick<AppContext, 'loadDatabaseDoc'>,
  sourceDb: Y.Doc,
  rowId: string,
  property: PropertyDefinition,
  added: readonly string[],
  removed: readonly string[],
): Promise<void> {
  const config = property.relation;
  if (!config?.backPropertyId || !config.targetDatabaseId) return;
  if (added.length === 0 && removed.length === 0) return;
  const handle = await ctx.loadDatabaseDoc(config.targetDatabaseId);
  try {
    const target = handle.doc;
    const back = getProperty(target, config.backPropertyId);
    if (back?.type !== 'relation') return;
    // Sources that lose their link because the back property holds only one page.
    const displaced: string[] = [];
    target.transact(() => {
      for (const targetRowId of added) {
        const row = getRow(target, targetRowId);
        if (!row) continue;
        const current = relationIds(row.values[back.id]);
        if (current.includes(rowId)) continue;
        if (back.relation?.limit === 'one') {
          displaced.push(...current);
          writeIds(target, targetRowId, back.id, [rowId]);
        } else {
          writeIds(target, targetRowId, back.id, [...current, rowId]);
        }
      }
      for (const targetRowId of removed) {
        const row = getRow(target, targetRowId);
        if (!row) continue;
        const current = relationIds(row.values[back.id]);
        if (!current.includes(rowId)) continue;
        writeIds(
          target,
          targetRowId,
          back.id,
          current.filter((id) => id !== rowId),
        );
      }
    });
    if (displaced.length > 0) {
      sourceDb.transact(() => {
        for (const sourceRowId of displaced) {
          if (sourceRowId === rowId) continue;
          const row = getRow(sourceDb, sourceRowId);
          if (!row) continue;
          const current = relationIds(row.values[property.id]);
          writeIds(
            sourceDb,
            sourceRowId,
            property.id,
            current.filter((id) => !added.includes(id)),
          );
        }
      });
    }
  } finally {
    handle.release();
  }
}

/**
 * Turns a relation into a two-way relation: creates the back property in the target database
 * (named `backName`), links both, and fills the back property from the existing values.
 * Returns the back property.
 */
export async function makeTwoWay(
  ctx: Pick<AppContext, 'loadDatabaseDoc'>,
  db: Y.Doc,
  databaseId: string,
  propertyId: string,
  backName: string,
): Promise<PropertyDefinition | null> {
  const property = getProperty(db, propertyId);
  const targetId = property?.relation?.targetDatabaseId;
  if (!property || property.type !== 'relation' || !targetId) return null;
  const handle = await ctx.loadDatabaseDoc(targetId);
  try {
    const target = handle.doc;
    const existing = property.relation?.backPropertyId;
    if (existing) return getProperty(target, existing) ?? null;
    const back = addProperty(target, {
      name: backName,
      type: 'relation',
      relation: { targetDatabaseId: databaseId, backPropertyId: propertyId, limit: 'many' },
    });
    updateProperty(db, propertyId, { relation: { backPropertyId: back.id } });
    const links = new Map<string, string[]>();
    for (const row of listRows(db)) {
      for (const targetRowId of relationIds(row.values[propertyId])) {
        links.set(targetRowId, [...(links.get(targetRowId) ?? []), row.id]);
      }
    }
    target.transact(() => {
      for (const [targetRowId, sources] of links) {
        if (!getRow(target, targetRowId)) continue;
        const current = relationIds(getRow(target, targetRowId)?.values[back.id]);
        writeIds(target, targetRowId, back.id, unique([...current, ...sources]));
      }
    });
    return getProperty(target, back.id) ?? back;
  } finally {
    handle.release();
  }
}

/** Makes a two-way relation one-way again on both sides (values stay). */
export async function unlinkTwoWay(
  ctx: Pick<AppContext, 'loadDatabaseDoc'>,
  db: Y.Doc,
  property: PropertyDefinition,
): Promise<void> {
  const config = property.relation;
  if (property.type !== 'relation' || !config?.backPropertyId) return;
  if (getProperty(db, property.id))
    updateProperty(db, property.id, { relation: { backPropertyId: null } });
  if (!config.targetDatabaseId) return;
  const handle = await ctx.loadDatabaseDoc(config.targetDatabaseId);
  try {
    const back = getProperty(handle.doc, config.backPropertyId);
    if (back?.type === 'relation' && back.relation?.backPropertyId === property.id) {
      updateProperty(handle.doc, back.id, { relation: { backPropertyId: null } });
    }
  } finally {
    handle.release();
  }
}

/**
 * Removes permanently deleted pages from every relation in the workspace and turns relations to a
 * deleted database into one-way relations. Returns how many references it removed.
 */
export async function removeDeletedFromRelations(
  ctx: Pick<AppContext, 'loadDatabaseDoc' | 'workspace'>,
  deleted: ReadonlySet<string>,
  deletedDatabases: ReadonlySet<string>,
): Promise<number> {
  let removed = 0;
  const databases = ctx.workspace.pages
    .getSnapshot()
    .all()
    .filter((page) => page.kind === 'database' && !deleted.has(page.id));
  for (const database of databases) {
    const handle = await ctx.loadDatabaseDoc(database.id);
    try {
      const doc = handle.doc;
      const relations = listProperties(doc).filter((property) => property.type === 'relation');
      if (relations.length === 0) continue;
      doc.transact(() => {
        for (const property of relations) {
          const target = property.relation?.targetDatabaseId;
          if (target && deletedDatabases.has(target) && property.relation?.backPropertyId) {
            updateProperty(doc, property.id, { relation: { backPropertyId: null } });
          }
        }
        for (const row of listRows(doc)) {
          for (const property of relations) {
            const ids = relationIds(row.values[property.id]);
            if (!ids.some((id) => deleted.has(id))) continue;
            removed += ids.filter((id) => deleted.has(id)).length;
            writeIds(
              doc,
              row.id,
              property.id,
              ids.filter((id) => !deleted.has(id)),
            );
          }
        }
      });
    } finally {
      handle.release();
    }
  }
  return removed;
}

/**
 * Removes every page the workspace records as permanently deleted from every relation: the
 * deleting client's cleanup may never have finished (the tab closed), and any client can finish it,
 * because a page that is merely missing here is never counted as deleted. Writes nothing when
 * nothing dangles. Returns how many references it removed.
 */
export async function sweepDeletedFromRelations(
  ctx: Pick<AppContext, 'loadDatabaseDoc' | 'workspace'>,
): Promise<number> {
  const deleted = permanentlyDeletedPageIds(ctx.workspace.doc);
  if (deleted.size === 0) return 0;
  // A relation whose target database is in the set points at a deleted database.
  return removeDeletedFromRelations(ctx, deleted, deleted);
}
