import type { PagesSnapshot } from '@tessera/core';
import { useAppContext, usePagesSelector } from '@tessera/core/react';
import { ArrowUpRight } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { t } from '../i18n';
import { backReferenceIndexFor } from '../model/back-references';
import { displayTitle } from './common';

/**
 * "Linked from databases": rows of other databases whose one-way relations point at this page,
 * so relations to any page are visible from both sides. Renders nothing when there are none.
 */
export function LinkedFrom({ pageId }: { pageId: string }) {
  const ctx = useAppContext();
  const index = backReferenceIndexFor(ctx);
  useEffect(() => {
    void index.ensureBuilt().catch(() => undefined);
  }, [index]);
  useSyncExternalStore(index.subscribe, index.getVersion, index.getVersion);
  const all = index.refsTo(pageId);
  // The snapshot moves on only when a row or database named here changes, not with every page.
  const pages = usePagesSelector(
    (snapshot) => snapshot,
    (a: PagesSnapshot, b: PagesSnapshot) =>
      all.every(
        (ref) =>
          a.get(ref.rowId) === b.get(ref.rowId) &&
          a.isTrashed(ref.rowId) === b.isTrashed(ref.rowId) &&
          a.get(ref.databaseId) === b.get(ref.databaseId),
      ),
  );
  const refs = all.filter(
    (ref) => pages.has(ref.rowId) && !pages.isTrashed(ref.rowId) && ref.rowId !== pageId,
  );
  if (refs.length === 0) return null;
  return (
    <section aria-label={t('linkedFrom')} className="mt-4 flex flex-col gap-1">
      <h2 className="text-xs font-medium text-fg-subtle">{t('linkedFrom')}</h2>
      <ul className="flex flex-wrap gap-1.5">
        {refs.map((ref) => {
          const row = pages.get(ref.rowId);
          const database = pages.get(ref.databaseId);
          return (
            <li key={`${ref.databaseId}:${ref.propertyId}:${ref.rowId}`}>
              <a
                href={`/p/${encodeURIComponent(ref.rowId)}`}
                onClick={(event) => {
                  event.preventDefault();
                  ctx.navigate(ref.rowId);
                }}
                className="inline-flex h-7 max-w-80 items-center gap-1 rounded-md border border-border px-2 text-ui text-fg hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
                <span className="truncate">
                  {t('linkedFromVia', {
                    row: displayTitle(row?.title),
                    database: displayTitle(database?.title),
                    property: ref.propertyName || t('untitled'),
                  })}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
