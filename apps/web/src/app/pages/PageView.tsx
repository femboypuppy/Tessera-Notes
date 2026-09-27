import { getPageProps, observePageProps, type PageMeta } from '@tessera/core';
import {
  useAncestors,
  useAppContext,
  useContributions,
  usePage,
  usePageDoc,
  usePagesSelector,
} from '@tessera/core/react';
import { Button, cn, EmptyState, FeatureBoundary, Skeleton } from '@tessera/ui';
import { Blocks, FileQuestion, RotateCcw, Trash2 } from 'lucide-react';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { t } from '../../i18n';
import { targetFromHash, type NavigationTarget } from '../bridge';
import { displayTitle, useViewOnly } from '../page-helpers';
import { PageCoverBand, PageHeader, focusPageTitle } from './PageHeader';

export { focusPageTitle };

/**
 * Display props (`fullWidth`, `smallText`) from the page doc; the editor toggles them.
 * `fullWidth` is null while the page hasn't chosen.
 */
function useDisplayProps(pageId: string): { fullWidth: boolean | null; smallText: boolean } {
  const { handle, loaded } = usePageDoc(pageId);
  const [props, setProps] = useState<{ fullWidth: boolean | null; smallText: boolean }>({
    fullWidth: null,
    smallText: false,
  });
  useEffect(() => {
    if (!handle || !loaded) return undefined;
    const read = () => {
      const current = getPageProps(handle.doc);
      setProps({
        fullWidth: typeof current.fullWidth === 'boolean' ? current.fullWidth : null,
        smallText: current.smallText === true,
      });
    };
    read();
    return observePageProps(handle.doc, read);
  }, [handle, loaded]);
  return props;
}

function TrashBanner({ page }: { page: PageMeta }) {
  const ctx = useAppContext();
  const navigate = useNavigate();
  const ancestors = useAncestors(page.id);
  // The page may be in the trash through an ancestor; restore the page that was trashed.
  const trashedRoot =
    [page, ...[...ancestors].reverse()].find((candidate) => candidate.trashedAt !== undefined) ??
    page;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-3 bg-danger px-4 py-2 text-sm text-danger-fg"
    >
      <span>{t('pageInTrash')}</span>
      <Button
        size="sm"
        variant="subtle"
        className="bg-white/15 text-danger-fg hover:bg-white/25"
        onClick={() => ctx.workspace.restorePage(trashedRoot.id)}
      >
        <RotateCcw aria-hidden="true" />
        {t('restore')}
      </Button>
      <Button
        size="sm"
        variant="subtle"
        className="bg-white/15 text-danger-fg hover:bg-white/25"
        onClick={() => {
          void ctx
            .confirm({
              title: t('deleteForeverConfirm', { title: displayTitle(trashedRoot) }),
              description: t('deleteForeverConfirmHint'),
              confirmLabel: t('deleteForever'),
              destructive: true,
            })
            .then(async (confirmed) => {
              if (!confirmed) return;
              // Leave first, so the view never renders the deleted page as "not found".
              void navigate('/trash');
              await ctx.workspace.deletePagePermanently(trashedRoot.id);
            });
        }}
      >
        <Trash2 aria-hidden="true" />
        {t('deleteForever')}
      </Button>
    </div>
  );
}

function PageBody({
  page,
  readOnly,
  target,
  registerFocusHandler,
}: {
  page: PageMeta;
  readOnly: boolean;
  target: NavigationTarget | null;
  registerFocusHandler: (handler: (position: 'start' | 'end') => void) => () => void;
}) {
  const bodies = useContributions('pageBodies');
  const body = bodies.find((candidate) => candidate.kind === page.kind);
  if (!body) {
    return (
      <EmptyState
        className="mt-8 rounded-xl border border-dashed border-border"
        icon={<Blocks />}
        title={t('noBodyTitle')}
        description={t('noBodyHint', {
          kind: page.kind === 'database' ? t('kindDatabase') : t('kindPage'),
        })}
      />
    );
  }
  const Body = body.component;
  return (
    <FeatureBoundary featureId={body.featureId} resetKeys={[page.id]} className="mt-6">
      <Suspense
        fallback={
          <div className="mt-6 flex flex-col gap-3" aria-busy="true" aria-label={t('loadingPage')}>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        }
      >
        <Body
          pageId={page.id}
          page={page}
          readOnly={readOnly}
          target={target}
          focusTitle={(position = 'end') => focusPageTitle(position)}
          registerFocusHandler={registerFocusHandler}
        />
      </Suspense>
    </FeatureBoundary>
  );
}

/**
 * A page: cover, icon, title, top sections (such as database row properties) and the body the
 * feature for its kind provides (the editor for pages, the databases feature for databases).
 */
export function PageView() {
  const { pageId = '' } = useParams();
  const ctx = useAppContext();
  const location = useLocation();
  const page = usePage(pageId);
  const trashed = usePagesSelector((pages) => pages.isTrashed(pageId));
  const topSections = useContributions('pageTopSections');
  const footerSections = useContributions('pageFooterSections');
  const display = useDisplayProps(pageId);
  const bodyFocus = useRef<((position: 'start' | 'end') => void) | null>(null);
  const state = location.state as { focusTitle?: boolean; target?: NavigationTarget } | null;
  const viewOnly = useViewOnly();
  // "Copy link" on a block makes `/p/<pageId>#block-<blockId>`; navigations pass a state target.
  const target = state?.target ?? targetFromHash(location.hash);

  const registerFocusHandler = useCallback((handler: (position: 'start' | 'end') => void) => {
    bodyFocus.current = handler;
    return () => {
      if (bodyFocus.current === handler) bodyFocus.current = null;
    };
  }, []);
  const focusBody = useCallback((position: 'start' | 'end') => {
    if (!bodyFocus.current) return false;
    bodyFocus.current(position);
    return true;
  }, []);

  useEffect(() => {
    document.title = page ? `${displayTitle(page)} · ${t('appName')}` : t('appName');
  }, [page]);

  if (!page) {
    return (
      <EmptyState
        className="mt-24"
        icon={<FileQuestion />}
        title={t('pageNotFound')}
        description={t('pageNotFoundHint')}
        actions={<Button onClick={() => ctx.navigateTo('/')}>{t('goHome')}</Button>}
      />
    );
  }

  const readOnly = trashed || viewOnly;
  // Tables, boards and calendars need the room, so database pages are wide unless they say not.
  const fullWidth = display.fullWidth ?? page.kind === 'database';
  const sections = topSections.filter((section) => !section.when || section.when(page, ctx));
  const footers = footerSections.filter((section) => !section.when || section.when(page, ctx));

  return (
    <article
      aria-label={displayTitle(page)}
      data-full-width={fullWidth || undefined}
      data-small-text={display.smallText || undefined}
      className="group/page pb-[40vh]"
    >
      {trashed ? <TrashBanner page={page} /> : null}
      <PageCoverBand page={page} readOnly={readOnly} />
      <div
        className={cn(
          'mx-auto w-full px-4 md:px-[var(--tess-page-padding)]',
          fullWidth
            ? 'max-w-none'
            : 'max-w-[calc(var(--tess-page-width)+2*var(--tess-page-padding))]',
        )}
      >
        <PageHeader
          page={page}
          readOnly={readOnly}
          onFocusBody={focusBody}
          autoFocusTitle={state?.focusTitle === true}
        />
        {sections.map((section) => {
          const Section = section.component;
          return (
            <FeatureBoundary
              key={`${section.featureId}:${section.id}`}
              featureId={section.featureId}
              resetKeys={[page.id]}
              className="mt-4"
            >
              <Suspense fallback={null}>
                <Section pageId={page.id} page={page} readOnly={readOnly} />
              </Suspense>
            </FeatureBoundary>
          );
        })}
        <PageBody
          page={page}
          readOnly={readOnly}
          target={target}
          registerFocusHandler={registerFocusHandler}
        />
        {footers.map((section) => {
          const Section = section.component;
          return (
            <FeatureBoundary
              key={`${section.featureId}:${section.id}`}
              featureId={section.featureId}
              resetKeys={[page.id]}
              className="mt-10"
            >
              <Suspense fallback={null}>
                <Section pageId={page.id} page={page} readOnly={readOnly} />
              </Suspense>
            </FeatureBoundary>
          );
        })}
      </div>
    </article>
  );
}
