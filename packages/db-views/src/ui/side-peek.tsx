import { useAppContext, useContributions, usePage, usePagesSelector } from '@tessera/core/react';
import {
  EmptyState,
  FeatureBoundary,
  IconButton,
  Sheet,
  SheetContent,
  Skeleton,
} from '@tessera/ui';
import { FileText, Maximize2, X } from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { displayTitle } from './common';
import { RowPropertiesPanel } from './row-properties';

function PeekTitle({
  pageId,
  title,
  readOnly,
}: {
  pageId: string;
  title: string;
  readOnly: boolean;
}) {
  const ctx = useAppContext();
  const [draft, setDraft] = useState(title);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(title);
  }, [title]);
  return (
    <textarea
      aria-label={t('rowTitle')}
      rows={1}
      value={draft}
      readOnly={readOnly}
      placeholder={t('untitled')}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
      }}
      onChange={(event) => {
        const next = event.target.value.replace(/[\r\n]+/g, ' ');
        setDraft(next);
        ctx.workspace.renamePage(pageId, next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.preventDefault();
      }}
      className="field-sizing-content w-full resize-none bg-transparent text-3xl leading-tight font-bold text-fg outline-none placeholder:text-fg-subtle"
    />
  );
}

/**
 * The side peek: a row opened in a sheet on the right, over the database, with its title,
 * properties and page content (from the editor when it is installed). Escape or the close button
 * returns to the view; "Open as full page" navigates to the row.
 */
export function SidePeek({ rowId, onClose }: { rowId: string; onClose: () => void }) {
  const ctx = useAppContext();
  const page = usePage(rowId);
  const trashed = usePagesSelector((pages) => pages.isTrashed(rowId));
  const bodies = useContributions('pageBodies');
  const body = bodies.find((candidate) => candidate.kind === 'page');
  const readOnly = page ? trashed : true;
  useEffect(() => {
    if (!page) onClose();
  }, [page, onClose]);
  if (!page) return null;
  const Body = body?.component;
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="right"
        title={displayTitle(page.title)}
        className="w-[min(100vw,44rem)] max-w-none overflow-y-auto"
        onOpenAutoFocus={(event) => {
          // Start in the title (new rows get named first), not on the close button.
          const title = (
            event.currentTarget as HTMLElement | null
          )?.querySelector<HTMLTextAreaElement>('textarea');
          if (!title) return;
          event.preventDefault();
          title.focus();
          title.setSelectionRange(title.value.length, title.value.length);
        }}
      >
        <div className="sticky top-0 z-10 flex h-11 items-center gap-1 border-b border-border bg-surface px-3">
          <IconButton label={t('closePeek')} icon={<X />} onClick={onClose} />
          <IconButton
            label={t('openRowFull')}
            icon={<Maximize2 />}
            onClick={() => {
              onClose();
              ctx.navigate(rowId);
            }}
          />
          <span className="ml-1 truncate text-ui text-fg-muted">{t('sidePeek')}</span>
        </div>
        <article
          className="flex flex-col gap-4 px-6 pt-8 pb-24 sm:px-12"
          aria-label={displayTitle(page.title)}
        >
          {page.icon ? (
            <span aria-hidden="true" className="text-5xl leading-none">
              {page.icon}
            </span>
          ) : null}
          <PeekTitle pageId={rowId} title={page.title} readOnly={readOnly} />
          <RowPropertiesPanel pageId={rowId} readOnly={readOnly} />
          {Body && body ? (
            <FeatureBoundary featureId={body.featureId} resetKeys={[rowId]}>
              <Suspense
                fallback={
                  <div className="flex flex-col gap-2" aria-busy="true">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                }
              >
                <Body
                  pageId={rowId}
                  page={page}
                  readOnly={readOnly}
                  target={null}
                  focusTitle={() => undefined}
                  registerFocusHandler={() => () => undefined}
                />
              </Suspense>
            </FeatureBoundary>
          ) : (
            <EmptyState icon={<FileText />} title={t('noBody')} className="py-6" />
          )}
        </article>
      </SheetContent>
    </Sheet>
  );
}
