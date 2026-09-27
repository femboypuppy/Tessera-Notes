import type { BlockRendererProps, JsonValue } from '@tessera/core';
import { usePagesSelector } from '@tessera/core/react';
import { Callout, EmptyState } from '@tessera/ui';
import { Database } from 'lucide-react';
import { t } from '../i18n';
import { DatabaseView } from '../ui/database-view';

/** The `data` of a `database` embed: which view it shows. Read defensively (it comes from docs). */
export function embedViewId(data: JsonValue | null): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const viewId = data.viewId;
  return typeof viewId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(viewId) ? viewId : null;
}

/**
 * The `database` embed (inline databases and linked views): the database's views inside a page,
 * remembering the chosen view in the embed's data. Edits go to the database itself.
 */
export default function InlineDatabase({
  ref: databaseId,
  data,
  readOnly,
  updateData,
}: BlockRendererProps) {
  const trashed = usePagesSelector(
    (pages) => !!databaseId && pages.has(databaseId) && pages.isTrashed(databaseId),
  );
  if (!databaseId) {
    return (
      <EmptyState
        icon={<Database />}
        title={t('missingDatabase')}
        description={t('missingDatabaseHint')}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2" data-inline-database={databaseId}>
      {trashed ? <Callout tone="warning">{t('trashedDatabase')}</Callout> : null}
      <DatabaseView
        databaseId={databaseId}
        variant="inline"
        viewId={embedViewId(data)}
        onViewChange={(viewId) => {
          if (!readOnly) updateData({ viewId });
        }}
        readOnly={readOnly || trashed}
      />
    </div>
  );
}
