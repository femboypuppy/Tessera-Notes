import {
  COMMANDS,
  listProperties,
  listRows,
  listViews,
  permanentlyDeletedPageIds,
  resolveRows,
  type AppContext,
} from '@tessera/core';
import { t } from '../i18n';
import { csvFileName, rowsToCsv } from '../csv/csv';
import { createDatabase, viewTypeName } from '../model/operations';
import { sweepDeletedFromRelations } from '../model/relations';
import { existingBackReferenceIndex } from '../model/back-references';
import { runQuery } from '../query/run';
import { createQueryContext } from '../query/types';
import { displayLocale } from '../ui/common';
import { exportColumns, saveText } from '../ui/csv/export-item';
import { activeViewKey } from '../view-setting';

/**
 * What the feature's commands and buttons run, loaded on first use so none of it weighs on the
 * startup bundle.
 */

/** Creates a full-width database, opens it and focuses its title. */
export async function newDatabaseAndOpen(
  ctx: AppContext,
  parentId: string | null = null,
): Promise<void> {
  const { page } = await createDatabase(ctx, { parentId, fullWidth: true });
  const focusTitle = () =>
    requestAnimationFrame(() => {
      void ctx.commands.execute(COMMANDS.focusTitle, { args: { position: 'end' } });
    });
  // Already showing it: an empty workspace's home view opens the first page as soon as it exists,
  // which can happen while the database doc loads (IndexedDB), before this subscribes below.
  if (ctx.getCurrentPageId() === page.id) {
    focusTitle();
    return;
  }
  // Focus the title once the page is showing (the navigation renders it).
  const stop = ctx.events.on('navigation.changed', ({ pageId }) => {
    if (pageId !== page.id) return;
    stop();
    focusTitle();
  });
  setTimeout(stop, 5000);
  ctx.navigate(page.id);
}

/** Exports the active view of a database page as CSV (the command-palette path). */
export async function exportDatabaseCsv(ctx: AppContext, databaseId: string): Promise<void> {
  const handle = await ctx.loadDatabaseDoc(databaseId);
  try {
    const views = listViews(handle.doc);
    const stored = ctx.settings.device.get(activeViewKey(databaseId));
    const view = views.find((candidate) => candidate.id === stored) ?? views[0];
    if (!view) return;
    const properties = listProperties(handle.doc);
    const pages = ctx.workspace.pages.getSnapshot();
    const queryCtx = createQueryContext({
      locale: displayLocale(),
      weekStartsOn: view.calendar.weekStartsOn,
      titleOf: (id) => pages.get(id)?.title,
      isPageVisible: (id) => pages.has(id) && !pages.isTrashed(id),
    });
    const { rows } = runQuery(
      resolveRows(listRows(handle.doc), pages),
      properties,
      view,
      queryCtx,
      { group: false },
    );
    if (rows.length === 0) {
      ctx.toast({ title: t('exportCsvEmpty') });
      return;
    }
    const title = pages.get(databaseId)?.title.trim() || t('untitledDatabase');
    const saved = await saveText(
      ctx,
      rowsToCsv(rows, exportColumns(properties, view), queryCtx),
      csvFileName(title, view.name || viewTypeName(view.type)),
    );
    if (!saved) return;
    ctx.toast({ variant: 'success', title: t('exportCsvDone', { count: rows.length }) });
  } finally {
    handle.release();
  }
}

/** Device setting: how many permanent deletions this device's last sweep of a workspace covered. */
export function relationSweepKey(workspaceId: string): string {
  return `databases.relationSweep.${workspaceId}`;
}

/**
 * Removes references to permanently deleted pages from every relation and from the "Linked from"
 * index (see `sweepDeletedFromRelations`), unless this device already swept every deletion the
 * workspace records. Returns how many references it removed.
 */
export async function sweepAfterDeletions(ctx: AppContext): Promise<number> {
  const deleted = permanentlyDeletedPageIds(ctx.workspace.doc);
  const key = relationSweepKey(ctx.workspace.info.id);
  if (ctx.settings.device.get(key) === deleted.size) return 0;
  const removed = await sweepDeletedFromRelations(ctx);
  const index = existingBackReferenceIndex(ctx);
  for (const id of deleted) index?.remove(id);
  ctx.settings.device.set(key, deleted.size);
  return removed;
}

/** Keeps the "Linked from" index current when a database changes (only once it was built). */
export async function refreshBackReferences(ctx: AppContext, databaseId: string): Promise<void> {
  const index = existingBackReferenceIndex(ctx);
  if (index?.built) await index.refresh(databaseId);
}
