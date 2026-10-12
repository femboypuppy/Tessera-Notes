import {
  resolveViewProperties,
  type AppContext,
  type PropertyDefinition,
  type ResolvedRow,
  type ViewConfig,
} from '@tessera/core';
import { useAppContext } from '@tessera/core/react';
import { DropdownMenuItem } from '@tessera/ui';
import { Download } from 'lucide-react';
import { t } from '../../i18n';
import { csvFileName, rowsToCsv } from '../../csv/csv';
import { viewTypeName } from '../../model/operations';
import type { DatabaseSnapshot } from '../../model/store';
import type { QueryResult } from '../../query/run';
import type { QueryContext } from '../../query/types';
import { runAction } from '../hooks';

/**
 * Saves text as a file through the platform's file saver: a download in browsers, the native save
 * dialog in the desktop app (whose webview ignores download links). False when the user cancelled.
 */
export async function saveText(
  ctx: Pick<AppContext, 'services'>,
  text: string,
  fileName: string,
  type = 'text/csv;charset=utf-8',
): Promise<boolean> {
  const saved = await ctx.services.fileSaver.save({
    name: fileName,
    data: new Blob([text], { type }),
  });
  return saved !== null;
}

/**
 * The columns a view exports: the table's visible columns in order, or every property (in the
 * view's order) for card layouts, whose visibility is about what fits on a card.
 */
export function exportColumns(
  properties: readonly PropertyDefinition[],
  view: Pick<ViewConfig, 'type' | 'properties'>,
): PropertyDefinition[] {
  const entries = resolveViewProperties(properties, view);
  return (view.type === 'table' ? entries.filter((entry) => entry.visible) : entries).map(
    (entry) => entry.property,
  );
}

/** "Export view as CSV": the rows the view shows, in its order, as a CSV download. */
export function ExportCsvItem({
  databaseTitle,
  snapshot,
  view,
  result,
  queryCtx,
}: {
  databaseTitle: string;
  snapshot: DatabaseSnapshot;
  view: ViewConfig;
  result: QueryResult<ResolvedRow>;
  queryCtx: QueryContext;
}) {
  const ctx = useAppContext();
  return (
    <DropdownMenuItem
      icon={<Download />}
      onSelect={() =>
        runAction(ctx, async () => {
          if (result.rows.length === 0) {
            ctx.toast({ title: t('exportCsvEmpty') });
            return;
          }
          const csv = rowsToCsv(result.rows, exportColumns(snapshot.properties, view), queryCtx);
          const name = csvFileName(databaseTitle, view.name || viewTypeName(view.type));
          if (!(await saveText(ctx, csv, name))) return;
          ctx.toast({
            variant: 'success',
            title: t('exportCsvDone', { count: result.rows.length }),
          });
        })
      }
    >
      {t('exportCsv')}
    </DropdownMenuItem>
  );
}
