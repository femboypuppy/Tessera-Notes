import type { PageSectionProps } from '@tessera/core';
import { useAppContext, usePagesSelector } from '@tessera/core/react';
import { cn } from '@tessera/ui';
import { ChevronRight, Link2 } from 'lucide-react';
import { useId, useState } from 'react';
import { t } from '../i18n';
import { displayTitle, PageGlyph } from '../ui/common';
import { Context, groupBySource, loadBacklinks, useLinkData } from './shared';

const NO_BACKLINKS: Awaited<ReturnType<typeof loadBacklinks>> = [];

/**
 * The compact backlinks footer under a page: which pages link here, one line of context each.
 * Hidden while there are none, so pages without backlinks stay calm.
 */
export default function BacklinksFooter({ pageId }: PageSectionProps) {
  const ctx = useAppContext();
  const backlinks = useLinkData(pageId, loadBacklinks, NO_BACKLINKS);
  const [open, setOpen] = useState(true);
  const id = useId();
  const groups = groupBySource(backlinks.data);
  // The snapshot moves on only when a page listed here changes, not with every page.
  const snapshot = usePagesSelector(
    (pages) => pages,
    (a, b) =>
      groups.every(
        ({ sourcePageId }) =>
          a.get(sourcePageId) === b.get(sourcePageId) &&
          a.isRow(sourcePageId) === b.isRow(sourcePageId),
      ),
  );
  if (groups.length === 0) return null;
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-testid="backlinks-footer"
      className="mt-10 border-t border-border pt-4"
    >
      <h2 className="m-0">
        <button
          type="button"
          id={`${id}-title`}
          aria-expanded={open}
          aria-controls={`${id}-list`}
          onClick={() => setOpen((value) => !value)}
          className="duration-fast -ml-1.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm font-medium text-fg-muted transition-colors outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn('duration-fast size-3.5 transition-transform', open && 'rotate-90')}
          />
          <Link2 aria-hidden="true" className="size-3.5" />
          {t('footerTitle', { count: backlinks.data.length })}
        </button>
      </h2>
      <ul id={`${id}-list`} hidden={!open} className="mt-1 flex flex-col">
        {groups.map((group) => {
          const page = snapshot.get(group.sourcePageId);
          const first = group.items[0];
          return (
            <li key={group.sourcePageId}>
              <button
                type="button"
                onClick={() =>
                  ctx.navigate(group.sourcePageId, first?.blockId ? { blockId: first.blockId } : {})
                }
                className="duration-fast flex w-full min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 text-left transition-colors outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
              >
                <PageGlyph
                  page={page}
                  isRow={snapshot.isRow(group.sourcePageId)}
                  className="translate-y-0.5"
                />
                <span className="shrink-0 text-sm text-fg">{displayTitle(page?.title)}</span>
                {first ? (
                  <span className="min-w-0 truncate text-ui text-fg-subtle">
                    <Context segments={first.segments} text={first.blockText} targetId={pageId} />
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
