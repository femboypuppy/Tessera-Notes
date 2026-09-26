import { resolveViewProperties, type ResolvedRow } from '@tessera/core';
import { useAppContext } from '@tessera/core/react';
import { cn } from '@tessera/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FileText, Plus } from 'lucide-react';
import { useMemo, useRef, type KeyboardEvent } from 'react';
import { t } from '../../i18n';
import { readCell } from '../../query/cells';
import type { RowGroup } from '../../query/group';
import { CellDisplay } from '../cells/display';
import { displayTitle } from '../common';
import type { ViewBodyProps } from '../database-view';
import { GroupLabel } from '../group-label';
import { runAction } from '../hooks';
import { RowMenu } from '../row-menu';

type Item =
  | { kind: 'row'; key: string; row: ResolvedRow }
  | { kind: 'group'; key: string; group: RowGroup<ResolvedRow> };

const ROW = 40;
const GROUP = 40;

/**
 * The list: compact rows with the icon, the title and the chosen properties on the right.
 * Virtualized; arrows move between rows, Enter opens one in the side peek.
 */
export function ListView(props: ViewBodyProps) {
  const ctx = useAppContext();
  const { snapshot, view, result, readOnly, queryCtx } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleProperties = resolveViewProperties(snapshot.properties, view)
    .filter((entry) => entry.visible && entry.property.type !== 'title')
    .map((entry) => entry.property);
  const groupProperty = snapshot.properties.find(
    (property) => property.id === view.group?.propertyId,
  );
  const items = useMemo<Item[]>(() => {
    if (!result.groups) return result.rows.map((row) => ({ kind: 'row', key: row.id, row }));
    const list: Item[] = [];
    for (const group of result.groups) {
      if (group.hidden) continue;
      list.push({ kind: 'group', key: `group:${group.key}`, group });
      for (const row of group.rows) list.push({ kind: 'row', key: `${group.key}:${row.id}`, row });
    }
    return list;
  }, [result]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (items[index]?.kind === 'group' ? GROUP : ROW),
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: 10,
    initialRect: { width: 800, height: 640 },
  });

  const focusRow = (index: number) => {
    const target = Math.max(0, Math.min(items.length - 1, index));
    virtualizer.scrollToIndex(target, { align: 'auto' });
    requestAnimationFrame(() =>
      scrollRef.current?.querySelector<HTMLElement>(`[data-list-index="${target}"]`)?.focus(),
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };
    if (event.key in moves) {
      event.preventDefault();
      let next = index + (moves[event.key] ?? 0);
      while (items[next]?.kind === 'group') next += Math.sign(moves[event.key] ?? 1);
      focusRow(next);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusRow(event.key === 'Home' ? 0 : items.length - 1);
    }
  };

  return (
    <div className="flex flex-col">
      <div
        ref={scrollRef}
        role="list"
        aria-label={t('viewList')}
        className={cn(
          'overflow-y-auto',
          props.variant === 'page'
            ? 'max-h-[calc(100dvh-var(--tess-topbar-height)-9rem)]'
            : 'max-h-[34rem]',
        )}
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtual) => {
            const item = items[virtual.index];
            if (!item) return null;
            const style = { transform: `translateY(${virtual.start}px)`, height: virtual.size };
            if (item.kind === 'group') {
              return (
                <div
                  key={item.key}
                  role="presentation"
                  className="absolute inset-x-0 top-0 flex items-end gap-2 border-b border-border px-2 pb-1"
                  style={style}
                >
                  {groupProperty ? (
                    <GroupLabel group={item.group} property={groupProperty} queryCtx={queryCtx} />
                  ) : null}
                  <span className="text-xs text-fg-subtle tabular-nums">
                    {item.group.rows.length}
                  </span>
                </div>
              );
            }
            const { row } = item;
            return (
              <div
                key={item.key}
                role="listitem"
                className="absolute inset-x-0 top-0"
                style={style}
              >
                <div
                  role="button"
                  tabIndex={0}
                  data-list-index={virtual.index}
                  data-row-id={row.id}
                  onClick={() => props.onOpenRow(row.id, 'peek')}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      props.onOpenRow(row.id, event.altKey ? 'page' : 'peek');
                      return;
                    }
                    onKeyDown(event, virtual.index);
                  }}
                  className="group/list flex h-full cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                >
                  {row.icon ? (
                    <span aria-hidden="true" className="text-[15px]">
                      {row.icon}
                    </span>
                  ) : (
                    <FileText aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-sm font-medium',
                      !row.title.trim() && 'text-fg-subtle',
                    )}
                  >
                    {displayTitle(row.title)}
                  </span>
                  <span className="hidden min-w-0 items-center gap-3 sm:flex">
                    {visibleProperties.map((property) => {
                      const value = readCell(row, property);
                      if (
                        value === null ||
                        value === '' ||
                        (Array.isArray(value) && value.length === 0)
                      )
                        return null;
                      return (
                        <span
                          key={property.id}
                          className="flex max-w-56 min-w-0 items-center gap-1 text-ui text-fg-muted"
                        >
                          {view.list.showPropertyNames ? (
                            <span className="shrink-0 text-2xs text-fg-subtle">
                              {property.name}
                            </span>
                          ) : null}
                          <CellDisplay
                            row={row}
                            property={property}
                            queryCtx={queryCtx}
                            className="text-ui"
                          />
                        </span>
                      );
                    })}
                  </span>
                  <RowMenu
                    database={props.database}
                    row={row}
                    onOpen={(mode) => props.onOpenRow(row.id, mode)}
                    readOnly={readOnly}
                    className="opacity-0 group-hover/list:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {!readOnly ? (
        <button
          type="button"
          onClick={() =>
            runAction(ctx, async () => {
              const id = await props.onCreateRow({});
              if (id) props.onOpenRow(id, 'peek');
            })
          }
          className="flex h-9 items-center gap-1.5 rounded-md px-2 text-ui text-fg-subtle hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        >
          <Plus aria-hidden="true" className="size-4" />
          {t('new')}
        </button>
      ) : null}
    </div>
  );
}
