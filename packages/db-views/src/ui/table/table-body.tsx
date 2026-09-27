import { EMPTY_GROUP_KEY, type PropertyDefinition, type ResolvedRow } from '@tessera/core';
import { IconButton, cn } from '@tessera/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, EyeOff, Plus } from 'lucide-react';
import {
  memo,
  useCallback,
  useLayoutEffect,
  useState,
  type PointerEvent,
  type RefObject,
} from 'react';
import { t } from '../../i18n';
import type { DatabaseRef } from '../../model/operations';
import type { RowGroup } from '../../query/group';
import type { QueryContext } from '../../query/types';
import { GroupLabel, groupName } from '../group-label';
import {
  FOOTER_HEIGHT,
  GROUP_HEIGHT,
  GUTTER_WIDTH,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  STICKY,
} from './layout';
import type { GridSelection } from './navigation';
import { TableRow, type CellEvents, type TableColumn } from './table-row';

/** One line of the table body: a row, a group header or a group's "New" line. */
export type TableItem =
  | {
      kind: 'row';
      key: string;
      row: ResolvedRow;
      navIndex: number;
      group: RowGroup<ResolvedRow> | null;
    }
  | { kind: 'group'; key: string; group: RowGroup<ResolvedRow> }
  | { kind: 'add'; key: string; group: RowGroup<ResolvedRow> };

/** What the table asks of its body (the body owns the virtualizer). */
export interface TableBodyHandle {
  scrollToItem(index: number): void;
}

/** Range bounds of the selection, as `selectionRange` returns them. */
interface Range {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TableBodyProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  handle: { current: TableBodyHandle | null };
  items: readonly TableItem[];
  columns: readonly TableColumn[];
  colIndex: ReadonlyMap<string, number>;
  totalWidth: number;
  gridId: string;
  database: DatabaseRef;
  grid: GridSelection | null;
  range: Range | null;
  multiCell: boolean;
  editing: { row: string; col: string; initialText: string | null } | null;
  wrap: boolean;
  readOnly: boolean;
  queryCtx: QueryContext;
  events: CellEvents;
  groupProperty: PropertyDefinition | undefined;
  onToggleGroup: (group: RowGroup<ResolvedRow>) => void;
  onHideGroup: ((group: RowGroup<ResolvedRow>) => void) | undefined;
  onAddInGroup: (group: RowGroup<ResolvedRow>) => void;
}

/**
 * The virtualized rows of the table. It is its own component so that scrolling re-renders only
 * the body (rows are memoized, so only rows that scroll into view render), not the header, the
 * summary footer or the menus.
 */
export function TableBody({
  scrollRef,
  handle,
  items,
  columns,
  colIndex,
  totalWidth,
  gridId,
  database,
  grid,
  range,
  multiCell,
  editing,
  wrap,
  readOnly,
  queryCtx,
  events,
  groupProperty,
  onToggleGroup,
  onHideGroup,
  onAddInGroup,
}: TableBodyProps) {
  // Stable per item list: the virtualizer recomputes every item's position when these change.
  const estimateSize = useCallback(
    (index: number) => (items[index]?.kind === 'group' ? GROUP_HEIGHT : ROW_HEIGHT),
    [items],
  );
  const getItemKey = useCallback((index: number) => items[index]?.key ?? index, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: 12,
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    scrollPaddingEnd: FOOTER_HEIGHT + 8,
    initialRect: { width: 1200, height: 720 },
  });

  // The row under the pointer shows its buttons (row actions, "Open").
  const [hovered, setHovered] = useState<string | null>(null);
  const onPointerOver = (event: PointerEvent<HTMLDivElement>) => {
    const element = (event.target as Element).closest('[role="row"][data-index]');
    const key = element ? (items[Number(element.getAttribute('data-index'))]?.key ?? null) : null;
    if (key !== hovered) setHovered(key);
  };

  useLayoutEffect(() => {
    handle.current = {
      scrollToItem: (index) => virtualizer.scrollToIndex(index, { align: 'auto' }),
    };
    return () => {
      handle.current = null;
    };
  }, [handle, virtualizer]);

  return (
    <div
      role="rowgroup"
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
      onPointerOver={onPointerOver}
      onPointerLeave={() => setHovered(null)}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const item = items[virtualItem.index];
        if (!item) return null;
        const top = virtualItem.start - HEADER_HEIGHT;
        if (item.kind === 'group') {
          return groupProperty ? (
            <GroupHeader
              key={item.key}
              group={item.group}
              property={groupProperty}
              queryCtx={queryCtx}
              top={top}
              width={totalWidth}
              ariaRowIndex={virtualItem.index + 2}
              colSpan={columns.length + 1}
              onToggle={onToggleGroup}
              onHide={onHideGroup}
            />
          ) : null;
        }
        if (item.kind === 'add') {
          return (
            // Rows of the grid like the others (a grid holds rows, rows hold cells).
            <div
              key={item.key}
              role="row"
              aria-rowindex={virtualItem.index + 2}
              className="absolute top-0 left-0 flex items-center border-b border-border"
              style={{ width: totalWidth, height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
            >
              <div role="gridcell" aria-colspan={columns.length + 1} className="contents">
                <button
                  type="button"
                  onClick={() => onAddInGroup(item.group)}
                  className={cn(
                    'left-0 flex h-full items-center gap-1.5 px-2 text-ui text-fg-muted hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none',
                    STICKY,
                  )}
                  style={{ paddingLeft: GUTTER_WIDTH }}
                >
                  <Plus aria-hidden="true" className="size-4" />
                  {t('new')}
                </button>
              </div>
            </div>
          );
        }
        const active = grid && grid.active.row === item.navIndex ? grid.active.col : null;
        const rowInRange =
          multiCell &&
          range !== null &&
          range.top >= 0 &&
          item.navIndex >= range.top &&
          item.navIndex <= range.bottom;
        const editingCol = editing?.row === item.key ? colIndex.get(editing.col) : undefined;
        return (
          <TableRow
            key={item.key}
            gridId={gridId}
            database={database}
            row={item.row}
            rowIndex={item.navIndex}
            ariaRowIndex={virtualItem.index + 2}
            columns={columns}
            totalWidth={totalWidth}
            top={top}
            height={wrap ? null : ROW_HEIGHT}
            measure={wrap ? virtualizer.measureElement : undefined}
            itemIndex={virtualItem.index}
            activeCol={active}
            rangeLeft={rowInRange ? range.left : null}
            rangeRight={rowInRange ? range.right : null}
            editingCol={editingCol ?? null}
            editingText={editingCol !== undefined ? (editing?.initialText ?? null) : null}
            hovered={hovered === item.key}
            wrap={wrap}
            readOnly={readOnly}
            queryCtx={queryCtx}
            events={events}
          />
        );
      })}
    </div>
  );
}

const GroupHeader = memo(function GroupHeader({
  group,
  property,
  queryCtx,
  top,
  width,
  ariaRowIndex,
  colSpan,
  onToggle,
  onHide,
}: {
  group: RowGroup<ResolvedRow>;
  property: PropertyDefinition;
  queryCtx: QueryContext;
  top: number;
  width: number;
  ariaRowIndex: number;
  colSpan: number;
  onToggle: (group: RowGroup<ResolvedRow>) => void;
  onHide: ((group: RowGroup<ResolvedRow>) => void) | undefined;
}) {
  const collapsed = group.collapsed;
  const name = groupName(group, property, queryCtx);
  return (
    <div
      role="row"
      aria-rowindex={ariaRowIndex}
      className="absolute top-0 left-0 flex items-end border-b border-border bg-bg"
      style={{ width, height: GROUP_HEIGHT, transform: `translateY(${top}px)` }}
    >
      <div
        role="gridcell"
        aria-colspan={colSpan}
        className={cn('left-0 flex h-9 items-center gap-1.5 px-2', STICKY)}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('expandGroup', { name }) : t('collapseGroup', { name })}
          onClick={() => onToggle(group)}
          className="inline-flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn('duration-fast size-4 transition-transform', !collapsed && 'rotate-90')}
          />
        </button>
        <GroupLabel group={group} property={property} queryCtx={queryCtx} />
        <span className="text-xs text-fg-muted tabular-nums">{group.rows.length}</span>
        {onHide && group.key !== EMPTY_GROUP_KEY ? (
          <IconButton
            size="sm"
            label={t('hideGroup')}
            icon={<EyeOff />}
            onClick={() => onHide(group)}
          />
        ) : null}
      </div>
    </div>
  );
});
