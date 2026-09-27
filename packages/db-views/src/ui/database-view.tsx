import {
  initDatabaseDoc,
  updateView,
  type JsonValue,
  type ResolvedRow,
  type ViewConfig,
} from '@tessera/core';
import { useAppContext, usePage, useSetting } from '@tessera/core/react';
import { Button, EmptyState, IconButton, Skeleton, cn, useIsCompact } from '@tessera/ui';
import { AlertTriangle, Database, Maximize2, SearchX } from 'lucide-react';
import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { addRow, templatePageOf, type DatabaseRef } from '../model/operations';
import type { DatabaseSnapshot } from '../model/store';
import { newRowDefaults } from '../query/defaults';
import { addNode, newCondition } from '../query/filter-edit';
import type { QueryResult } from '../query/run';
import type { QueryContext } from '../query/types';
import { overlays } from '../overlay-store';
import { activeViewKey } from '../view-setting';
import { displayTitle } from './common';
import { runAction, useDatabase, useQueryContext, useViewQuery } from './hooks';
import { MoreMenuItems } from './more-menu';
import { RenameInput } from './table/header-cell';
import { TableView, type NewRowRequest } from './table/table-view';
import { FilterChips } from './toolbar/filter-chips';
import { Toolbar, type ToolbarPanel } from './toolbar/toolbar';
import { ViewTabs } from './view-tabs';
import { ViewBody } from './view-body';

export interface DatabaseViewProps {
  databaseId: string;
  /** `page`: the body of a database page. `inline`: an embed inside another page. */
  variant: 'page' | 'inline';
  /** The view an inline embed shows; pages remember the last view per device. */
  viewId?: string | null;
  onViewChange?: (viewId: string) => void;
  readOnly: boolean;
}

/** What every view layout receives. */
export interface ViewBodyProps {
  database: DatabaseRef;
  databaseTitle: string;
  snapshot: DatabaseSnapshot;
  view: ViewConfig;
  result: QueryResult<ResolvedRow>;
  queryCtx: QueryContext;
  readOnly: boolean;
  variant: 'page' | 'inline';
  onOpenRow: (rowId: string, mode: 'page' | 'peek') => void;
  onCreateRow: (
    request: NewRowRequest & { values?: Record<string, JsonValue> },
  ) => Promise<string | null>;
  onFilterBy: (propertyId: string) => void;
  onSortBy: (propertyId: string, direction: 'asc' | 'desc') => void;
  onGroupBy: (propertyId: string) => void;
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-2 py-2" aria-busy="true" aria-label={t('loading')}>
      <div className="flex gap-2">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-16" />
      </div>
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-8 w-full" />
      ))}
    </div>
  );
}

/**
 * A database with its views: loading, error, missing and not-yet-synced states, then the view
 * tabs, the toolbar, the active filters and the active view (table, board, calendar, gallery or
 * list). Used for database pages and inline databases.
 */
export function DatabaseView(props: DatabaseViewProps) {
  const ctx = useAppContext();
  const [attempt, setAttempt] = useState(0);
  const state = useDatabase(props.databaseId);
  const page = usePage(props.databaseId);
  if (state.error) {
    return (
      <EmptyState
        tone="danger"
        icon={<AlertTriangle />}
        title={t('loadFailed')}
        description={t('loadFailedHint')}
        actions={
          <Button key={attempt} onClick={() => setAttempt((value) => value + 1)}>
            {t('retry')}
          </Button>
        }
      />
    );
  }
  if (!page && !state.loading) {
    return (
      <EmptyState
        icon={<Database />}
        title={t('missingDatabase')}
        description={t('missingDatabaseHint')}
      />
    );
  }
  if (state.loading || !state.ref || !state.snapshot) return <LoadingState />;
  if (!state.snapshot.initialized || state.snapshot.views.length === 0) {
    const ref = state.ref;
    return (
      <EmptyState
        icon={<Database />}
        title={t('notInitialized')}
        description={t('notInitializedHint')}
        actions={
          props.readOnly ? null : (
            <Button
              onClick={() =>
                runAction(ctx, () =>
                  initDatabaseDoc(ref.doc, {
                    titlePropertyName: t('defaultTitleProperty'),
                    viewName: t('viewTable'),
                  }),
                )
              }
            >
              {t('setUpDatabase')}
            </Button>
          )
        }
      />
    );
  }
  return (
    <LoadedDatabaseView
      {...props}
      database={state.ref}
      snapshot={state.snapshot}
      title={page?.title ?? ''}
    />
  );
}

function LoadedDatabaseView({
  databaseId,
  variant,
  viewId,
  onViewChange,
  readOnly,
  database,
  snapshot,
  title,
}: DatabaseViewProps & { database: DatabaseRef; snapshot: DatabaseSnapshot; title: string }) {
  const ctx = useAppContext();
  const compact = useIsCompact();
  const idPrefix = `db-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [storedView, setStoredView] = useSetting<string>(
    ctx.settings.device,
    activeViewKey(databaseId),
    '',
  );
  const wanted = variant === 'inline' ? (viewId ?? '') : storedView;
  const view = snapshot.views.find((candidate) => candidate.id === wanted) ?? snapshot.views[0];
  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<ToolbarPanel>(null);
  const [focusFilterId, setFocusFilterId] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const queryCtx = useQueryContext(view?.calendar.weekStartsOn ?? 1, snapshot);
  const emptyView = useMemo(() => ({ filter: null, sorts: [], group: null }), []);
  const result = useViewQuery(snapshot, view ?? emptyView, search, queryCtx, {
    group: view ? view.type === 'table' || view.type === 'board' || view.type === 'list' : false,
  });
  const selectView = useCallback(
    (id: string) => {
      if (variant === 'inline') onViewChange?.(id);
      else setStoredView(id);
    },
    [variant, onViewChange, setStoredView],
  );

  const onCreateRow = useCallback(
    async (request: NewRowRequest & { values?: Record<string, JsonValue> }) => {
      if (!view) return null;
      try {
        const values = {
          ...newRowDefaults(view.filter, snapshot.properties, queryCtx, request.group ?? undefined),
          ...request.values,
        };
        const row = await addRow(ctx, database, {
          values,
          ...(request.after ? { position: { after: request.after } } : {}),
        });
        return row.id;
      } catch (error) {
        runAction(ctx, () => {
          throw error;
        });
        return null;
      }
    },
    [ctx, database, view, snapshot.properties, queryCtx],
  );

  if (!view) return null;
  const panelId = `${idPrefix}-panel`;
  const hasTemplate = templatePageOf(ctx, database.doc) !== null;
  const onOpenRow = (rowId: string, mode: 'page' | 'peek') => {
    if (mode === 'page') ctx.navigate(rowId);
    else overlays.openPeek(rowId);
  };
  const bodyProps = {
    database,
    databaseTitle: displayTitle(title),
    snapshot,
    view,
    result,
    queryCtx,
    readOnly,
    variant,
    onOpenRow,
    onCreateRow,
    onFilterBy: (propertyId: string) => {
      const property = snapshot.properties.find((candidate) => candidate.id === propertyId);
      if (!property || readOnly) return;
      const condition = newCondition(property);
      runAction(ctx, () =>
        updateView(database.doc, view.id, { filter: addNode(view.filter, condition) }),
      );
      setFocusFilterId(condition.id);
      setPanel('filter');
    },
    onSortBy: (propertyId: string, direction: 'asc' | 'desc') =>
      runAction(ctx, () =>
        updateView(database.doc, view.id, {
          sorts: [
            { propertyId, direction },
            ...view.sorts.filter((rule) => rule.propertyId !== propertyId),
          ],
        }),
      ),
    onGroupBy: (propertyId: string) =>
      runAction(ctx, () =>
        updateView(database.doc, view.id, {
          group: {
            propertyId,
            order: [],
            hidden: [],
            collapsed: [],
            hideEmptyGroups: false,
            dateBucket: view.group?.dateBucket ?? 'month',
          },
        }),
      ),
  } satisfies ViewBodyProps;

  const countLabel =
    result.rows.length === result.total
      ? t('rowCount', { count: result.total })
      : t('rowCountOf', { shown: result.rows.length, total: result.total });

  let body: ReactNode;
  if (result.total > 0 && result.rows.length === 0 && (search || view.filter)) {
    body = (
      <EmptyState
        className="rounded-md border border-dashed border-border"
        icon={<SearchX />}
        title={t('noResults')}
        description={t('noResultsHint')}
        actions={
          <Button
            onClick={() => {
              setSearch('');
              if (!readOnly)
                runAction(ctx, () => updateView(database.doc, view.id, { filter: null }));
            }}
          >
            {t('clearFilters')}
          </Button>
        }
      />
    );
  } else if (view.type === 'table') {
    body = (
      <TableView
        {...bodyProps}
        heightClassName={
          variant === 'page'
            ? 'max-h-[calc(100dvh-var(--tess-topbar-height)-8rem)]'
            : 'max-h-[34rem]'
        }
      />
    );
  } else {
    body = <ViewBody {...bodyProps} />;
  }

  return (
    <section
      aria-label={displayTitle(title)}
      className={cn('flex min-w-0 flex-col gap-2', variant === 'inline' && 'my-2')}
      data-database-id={databaseId}
    >
      {variant === 'inline' ? (
        <div className="flex min-w-0 items-center gap-1">
          {renamingTitle ? (
            <RenameInput
              initial={title}
              label={t('databaseTitle')}
              className="h-8 text-lg font-semibold"
              onDone={(value) => {
                if (value !== null)
                  runAction(ctx, () => ctx.workspace.renamePage(databaseId, value));
                setRenamingTitle(false);
              }}
            />
          ) : (
            <button
              type="button"
              disabled={readOnly}
              onClick={() => setRenamingTitle(true)}
              aria-label={`${t('databaseTitle')}: ${displayTitle(title)}`}
              className={cn(
                'min-w-0 truncate rounded-md px-1 text-left text-lg font-semibold text-fg hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none',
                !title.trim() && 'text-fg-subtle',
              )}
            >
              {title.trim() ? title : t('untitledDatabase')}
            </button>
          )}
          <IconButton
            size="sm"
            label={t('openFullPage')}
            icon={<Maximize2 />}
            onClick={() => ctx.navigate(databaseId)}
          />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border">
        <ViewTabs
          database={database}
          views={snapshot.views}
          activeId={view.id}
          onSelect={selectView}
          panelId={panelId}
          idPrefix={idPrefix}
          readOnly={readOnly}
        />
        <div className="flex items-center gap-2 pb-1">
          <span className="hidden text-xs text-fg-subtle tabular-nums sm:inline" aria-live="polite">
            {countLabel}
          </span>
          <Toolbar
            database={database}
            view={view}
            properties={snapshot.properties}
            queryCtx={queryCtx}
            readOnly={readOnly}
            search={search}
            onSearch={setSearch}
            panel={panel}
            onPanel={(next) => {
              setPanel(next);
              if (next !== 'filter') setFocusFilterId(null);
            }}
            focusFilterId={focusFilterId}
            hasTemplate={hasTemplate}
            compact={compact || variant === 'inline'}
            onNewRow={(useTemplate) =>
              runAction(ctx, async () => {
                const values = newRowDefaults(view.filter, snapshot.properties, queryCtx);
                const row = await addRow(ctx, database, { values, useTemplate });
                onOpenRow(row.id, 'peek');
              })
            }
            moreMenu={
              <MoreMenuItems
                database={database}
                databaseTitle={displayTitle(title)}
                snapshot={snapshot}
                view={view}
                result={result}
                queryCtx={queryCtx}
                readOnly={readOnly}
              />
            }
          />
        </div>
      </div>
      <FilterChips
        database={database}
        view={view}
        properties={snapshot.properties}
        queryCtx={queryCtx}
        readOnly={readOnly}
        onOpenFilters={() => setPanel('filter')}
        onOpenSorts={() => setPanel('sort')}
      />
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-tab-${view.id}`}
        className="min-w-0"
      >
        {body}
      </div>
    </section>
  );
}
