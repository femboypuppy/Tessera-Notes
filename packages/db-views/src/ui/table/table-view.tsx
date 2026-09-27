import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import {
  listProperties,
  resolveViewProperties,
  updateView,
  type JsonValue,
  type PropertyType,
  type ResolvedRow,
  type ViewConfig,
} from '@tessera/core';
import { useAppContext } from '@tessera/core/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  cn,
} from '@tessera/ui';
import { Copy, FileText, PanelRightOpen, Plus, Trash2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { t } from '../../i18n';
import {
  addDatabaseProperty,
  duplicateRows,
  materializeViewProperties,
  movePropertyInView,
  setCell,
  setCellsFromText,
  setColumnWidth,
  setPropertyVisible,
  trashRows,
  type DatabaseRef,
  type TextCell,
} from '../../model/operations';
import { addRowsInBulk } from '../../model/bulk';
import type { DatabaseSnapshot } from '../../model/store';
import { readCell } from '../../query/cells';
import { cellToText } from '../../query/format';
import type { RowGroup } from '../../query/group';
import type { QueryResult } from '../../query/run';
import type { QueryContext } from '../../query/types';
import { PICKABLE_TYPES, PropertyIcon, typeLabel } from '../common';
import { POPOVER_EDITOR_TYPES, TEXT_EDITOR_TYPES, type EditMove } from '../cells/editors';
import { useDragAccessibility, useDragSensors } from '../dnd';
import { runAction, useAfterMenuClose } from '../hooks';
import { FormulaDialog } from '../formula-dialog';
import { OptionsDialog } from '../options-dialog';
import { fromTsv, toHtmlTable, toTsv } from './clipboard';
import { HeaderCell } from './header-cell';
import {
  ADD_COLUMN_WIDTH,
  GUTTER_WIDTH,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  STICKY,
  defaultColumnWidth,
} from './layout';
import {
  navigate,
  rangeSize,
  selectionRange,
  type GridPos,
  type GridSelection,
} from './navigation';
import { SummaryRow } from './summary-row';
import { TableBody, type TableBodyHandle, type TableItem } from './table-body';
import { cellElementId, type CellEvents, type TableColumn } from './table-row';

type Item = TableItem;

const HEADER_KEY = '__header__';
/** The row key of an edit that waits for its row to be created. */
const PENDING_KEY = '__pending__';
const FOOTER_KEY = '__footer__';

interface KeyPos {
  row: string;
  col: string;
}

interface KeySelection {
  active: KeyPos;
  anchor: KeyPos;
}

/** Options for creating a row from the table. */
export interface NewRowRequest {
  after?: string | null;
  group?: { propertyId: string; key: string } | null;
}

export interface TableViewProps {
  database: DatabaseRef;
  databaseTitle: string;
  snapshot: DatabaseSnapshot;
  view: ViewConfig;
  result: QueryResult<ResolvedRow>;
  queryCtx: QueryContext;
  readOnly: boolean;
  /** Tailwind classes limiting the scroll area's height. */
  heightClassName: string;
  onOpenRow: (rowId: string, mode: 'page' | 'peek') => void;
  onFilterBy: (propertyId: string) => void;
  onSortBy: (propertyId: string, direction: 'asc' | 'desc') => void;
  onGroupBy: (propertyId: string) => void;
  onCreateRow: (request: NewRowRequest) => Promise<string | null>;
}

/**
 * The table view: a virtualized ARIA grid with spreadsheet keyboard navigation, range selection,
 * copy and paste, in-place editing with the right editor for each type, a column menu, resizing
 * and reordering columns, row actions, grouping and a summary footer.
 */
export function TableView({
  database,
  databaseTitle,
  snapshot,
  view,
  result,
  queryCtx,
  readOnly,
  heightClassName,
  onOpenRow,
  onFilterBy,
  onSortBy,
  onGroupBy,
  onCreateRow,
}: TableViewProps) {
  const ctx = useAppContext();
  const gridId = `db-grid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [liveWidth, setLiveWidth] = useState<{ id: string; width: number } | null>(null);
  const [selection, setSelection] = useState<KeySelection | null>(null);
  const [editing, setEditing] = useState<{
    row: string;
    col: string;
    initialText: string | null;
  } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [footerMenu, setFooterMenu] = useState<number | null>(null);
  const [rowMenu, setRowMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [formulaFor, setFormulaFor] = useState<string | null>(null);
  const lastGrid = useRef<GridSelection | null>(null);
  const afterMenu = useAfterMenuClose();
  const dragging = useRef(false);
  const wrap = view.table.wrapCells;

  // Columns -------------------------------------------------------------------------------------
  const columns = useMemo<TableColumn[]>(() => {
    const visible = resolveViewProperties(snapshot.properties, view).filter(
      (entry) => entry.visible,
    );
    const frozen = Math.max(0, view.table.frozenColumns);
    let left = 0;
    return visible.map((entry, index) => {
      const width =
        liveWidth?.id === entry.property.id
          ? liveWidth.width
          : (entry.width ?? defaultColumnWidth(entry.property.type));
      const column: TableColumn = {
        property: entry.property,
        width,
        left,
        stickyLeft: index < frozen ? GUTTER_WIDTH + left : null,
      };
      left += width;
      return column;
    });
  }, [snapshot.properties, view, liveWidth]);
  const totalWidth =
    GUTTER_WIDTH + columns.reduce((sum, column) => sum + column.width, 0) + ADD_COLUMN_WIDTH;
  const colIndex = useMemo(
    () => new Map(columns.map((column, index) => [column.property.id, index])),
    [columns],
  );
  // Whether the table is wider than its scroller: only then do frozen columns stick (`STICKY`).
  const [scrollsX, setScrollsX] = useState(true);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const measure = () =>
      setScrollsX(element.clientWidth === 0 || totalWidth > element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [totalWidth]);

  // Rows and groups -----------------------------------------------------------------------------
  const groupProperty = result.groups
    ? snapshot.properties.find((property) => property.id === view.group?.propertyId)
    : undefined;
  const items = useMemo<Item[]>(() => {
    if (!result.groups) {
      return result.rows.map((row, navIndex) => ({
        kind: 'row',
        key: row.id,
        row,
        navIndex,
        group: null,
      }));
    }
    const list: Item[] = [];
    let navIndex = 0;
    for (const group of result.groups) {
      if (group.hidden) continue;
      list.push({ kind: 'group', key: `group:${group.key}`, group });
      if (group.collapsed) continue;
      for (const row of group.rows) {
        list.push({ kind: 'row', key: `${group.key}:${row.id}`, row, navIndex, group });
        navIndex += 1;
      }
      if (!readOnly) list.push({ kind: 'add', key: `add:${group.key}`, group });
    }
    return list;
  }, [result, readOnly]);
  const navRows = useMemo(
    () => items.filter((item): item is Extract<Item, { kind: 'row' }> => item.kind === 'row'),
    [items],
  );
  const rowIndexByKey = useMemo(
    () => new Map(navRows.map((item, index) => [item.key, index])),
    [navRows],
  );
  const itemIndexByNav = useMemo(() => {
    const map = new Map<number, number>();
    items.forEach((item, index) => {
      if (item.kind === 'row') map.set(item.navIndex, index);
    });
    return map;
  }, [items]);

  // Selection -----------------------------------------------------------------------------------
  const rowCount = navRows.length;
  // Ungrouped, editable tables end with a "New" row (grouped ones add rows per group). ARIA
  // counts every row of the grid: the header, data rows, group headers, "New" rows, summaries.
  const hasNewRow = !readOnly && !result.groups;
  const newRowIndex = items.length + 2;
  const summaryRowIndex = newRowIndex + (hasNewRow ? 1 : 0);
  const colCount = columns.length;
  const toIndex = (key: string): number | null => {
    if (key === HEADER_KEY) return -1;
    if (key === FOOTER_KEY) return rowCount;
    return rowIndexByKey.get(key) ?? null;
  };
  const toKey = (row: number): string =>
    row < 0 ? HEADER_KEY : row >= rowCount ? FOOTER_KEY : (navRows[row]?.key ?? FOOTER_KEY);
  const colKey = (col: number): string => columns[col]?.property.id ?? '';

  const grid: GridSelection | null = (() => {
    if (!selection || colCount === 0) return null;
    const activeRow = toIndex(selection.active.row);
    const anchorRow = toIndex(selection.anchor.row);
    const activeCol = colIndex.get(selection.active.col);
    const anchorCol = colIndex.get(selection.anchor.col);
    if (activeRow === null || activeCol === undefined) {
      // The row or column went away (filtered out, deleted): stay near where it was.
      const last = lastGrid.current;
      if (!last) return null;
      const pos = {
        row: Math.min(last.active.row, rowCount - 1),
        col: Math.min(last.active.col, colCount - 1),
      };
      return pos.row < -1 ? null : { active: pos, anchor: pos };
    }
    return {
      active: { row: activeRow, col: activeCol },
      anchor: {
        row: anchorRow ?? activeRow,
        col: anchorCol ?? activeCol,
      },
    };
  })();
  useEffect(() => {
    lastGrid.current = grid;
  });
  const range = grid ? selectionRange(grid) : null;
  const toKeySelection = (next: GridSelection): KeySelection => ({
    active: { row: toKey(next.active.row), col: colKey(next.active.col) },
    anchor: { row: toKey(next.anchor.row), col: colKey(next.anchor.col) },
  });

  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true });

  const body = useRef<TableBodyHandle | null>(null);

  const scrollIntoView = useCallback(
    (pos: GridPos) => {
      const element = scrollRef.current;
      if (!element) return;
      if (pos.row >= 0 && pos.row < rowCount) {
        const itemIndex = itemIndexByNav.get(pos.row);
        if (itemIndex !== undefined) body.current?.scrollToItem(itemIndex);
      }
      const column = columns[pos.col];
      if (!column) return;
      const frozenWidth = columns
        .filter((candidate) => candidate.stickyLeft !== null)
        .reduce((sum, candidate) => sum + candidate.width, GUTTER_WIDTH);
      if (column.stickyLeft !== null) return;
      const left = GUTTER_WIDTH + column.left;
      const right = left + column.width;
      if (left < element.scrollLeft + frozenWidth) element.scrollLeft = left - frozenWidth;
      else if (right > element.scrollLeft + element.clientWidth)
        element.scrollLeft = right - element.clientWidth;
    },
    [columns, itemIndexByNav, rowCount],
  );

  const select = (next: GridSelection, scroll = true) => {
    setSelection(toKeySelection(next));
    if (scroll) scrollIntoView(next.active);
  };

  // Editing -------------------------------------------------------------------------------------
  const startEditing = (pos: GridPos, initialText: string | null) => {
    const item = navRows[pos.row];
    const column = columns[pos.col];
    if (!item || !column || readOnly) return;
    const type = column.property.type;
    if (type === 'formula') {
      // Formula cells are computed: "editing" one edits its formula.
      setFormulaFor(column.property.id);
      return;
    }
    if (type === 'checkbox') {
      toggleCheckbox(item.row, pos.col);
      return;
    }
    if (!TEXT_EDITOR_TYPES.has(type) && !POPOVER_EDITOR_TYPES.has(type)) return;
    setEditing({ row: item.key, col: column.property.id, initialText });
  };

  const toggleCheckbox = (row: ResolvedRow, col: number) => {
    const column = columns[col];
    if (!column || readOnly) return;
    const checked = readCell(row, column.property) === true;
    runAction(ctx, () => setCell(ctx, database, row.id, column.property, checked ? null : true));
  };

  const onEditDone = useCallback(
    (move?: EditMove) => {
      setEditing(null);
      focusGrid();
      if (!move) return;
      const current = lastGrid.current;
      if (!current) return;
      const key = move === 'down' ? 'ArrowDown' : move === 'up' ? 'ArrowUp' : 'Tab';
      const next = navigate(
        current,
        { key, shiftKey: move === 'left', modKey: false },
        { rowCount, colCount, pageSize: 10, header: false, footer: false },
      );
      if (next) {
        setSelection({
          active: {
            row: toKeyRef.current(next.active.row),
            col: colKeyRef.current(next.active.col),
          },
          anchor: {
            row: toKeyRef.current(next.anchor.row),
            col: colKeyRef.current(next.anchor.col),
          },
        });
      }
    },
    [rowCount, colCount],
  );
  // Stable callbacks read the latest key helpers through refs.
  const toKeyRef = useRef(toKey);
  const colKeyRef = useRef(colKey);
  toKeyRef.current = toKey;
  colKeyRef.current = colKey;

  // Rows ----------------------------------------------------------------------------------------
  const createRow = async (request: NewRowRequest, editTitle = true) => {
    const titleColumn = columns.find((column) => column.property.type === 'title');
    const col = titleColumn?.property.id ?? '';
    // Start "editing" right away, so what is typed while the row is created is kept.
    if (editTitle && titleColumn) setEditing({ row: PENDING_KEY, col, initialText: null });
    const id = await onCreateRow(request);
    if (!id || !titleColumn) {
      setEditing((current) => (current?.row === PENDING_KEY ? null : current));
      return;
    }
    const key = request.group ? `${request.group.key}:${id}` : id;
    setSelection({ active: { row: key, col }, anchor: { row: key, col } });
    if (editTitle)
      setEditing((current) => ({
        row: key,
        col,
        initialText: current?.row === PENDING_KEY ? current.initialText : null,
      }));
  };

  const deleteRowsAt = (rowIndexes: readonly number[]) => {
    const ids = [
      ...new Set(
        rowIndexes.map((index) => navRows[index]?.row.id).filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) return;
    runAction(ctx, () => {
      const undo = trashRows(ctx, ids);
      ctx.toast({
        title: t('rowDeleted', { count: ids.length }),
        action: { label: t('undo'), onClick: undo },
      });
    });
  };

  // Clipboard -----------------------------------------------------------------------------------
  const rangeText = (): string[][] => {
    if (!range || range.top < 0 || range.bottom >= rowCount) return [];
    const block: string[][] = [];
    for (let row = range.top; row <= range.bottom; row += 1) {
      const item = navRows[row];
      if (!item) continue;
      const line: string[] = [];
      for (let col = range.left; col <= range.right; col += 1) {
        const column = columns[col];
        if (!column) continue;
        line.push(
          column.property.type === 'title'
            ? item.row.title
            : cellToText(readCell(item.row, column.property), column.property, queryCtx),
        );
      }
      block.push(line);
    }
    return block;
  };

  const clearRange = () => {
    if (!range || readOnly || range.top < 0 || range.bottom >= rowCount) return;
    const cells: TextCell[] = [];
    for (let row = range.top; row <= range.bottom; row += 1) {
      for (let col = range.left; col <= range.right; col += 1) {
        const item = navRows[row];
        const column = columns[col];
        if (
          !item ||
          !column ||
          column.property.type === 'createdTime' ||
          column.property.type === 'updatedTime'
        )
          continue;
        if (column.property.type === 'checkbox') {
          cells.push({ rowId: item.row.id, property: column.property, text: 'false' });
          continue;
        }
        cells.push({ rowId: item.row.id, property: column.property, text: '' });
      }
    }
    runAction(ctx, async () => {
      await setCellsFromText(ctx, database, cells, queryCtx);
      if (cells.length > 1) ctx.toast({ title: t('cellsCleared', { count: cells.length }) });
    });
  };

  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (editing || event.target !== scrollRef.current) return;
    const block = rangeText();
    if (block.length === 0) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', toTsv(block));
    event.clipboardData.setData('text/html', toHtmlTable(block));
  };

  const onCut = (event: ClipboardEvent<HTMLDivElement>) => {
    if (editing || readOnly || event.target !== scrollRef.current) return;
    onCopy(event);
    clearRange();
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (editing || readOnly || !grid || !range || event.target !== scrollRef.current) return;
    if (range.top < 0 || range.top >= rowCount + (result.groups ? 0 : 1)) return;
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const block = fromTsv(text);
    if (block.length === 0) return;
    const fill = block.length === 1 && block[0]?.length === 1 && rangeSize(range) > 1;
    const height = fill ? range.bottom - range.top + 1 : block.length;
    const width = fill
      ? range.right - range.left + 1
      : Math.max(...block.map((line) => line.length));
    runAction(ctx, async () => {
      const rowIds = navRows.slice(range.top, range.top + height).map((item) => item.row.id);
      const missing = range.top + height - rowCount;
      if (missing > 0 && !result.groups) {
        const last = navRows[rowCount - 1]?.row.id ?? null;
        rowIds.push(
          ...addRowsInBulk(
            ctx,
            database.doc,
            database.id,
            Array.from({ length: missing }, () => ({})),
            { after: last },
          ),
        );
      }
      const cells: TextCell[] = [];
      for (let r = 0; r < height; r += 1) {
        for (let c = 0; c < width; c += 1) {
          const column = columns[range.left + c];
          const rowId = rowIds[r];
          const value = fill ? block[0]?.[0] : block[r]?.[c];
          if (!column || !rowId || value === undefined) continue;
          if (column.property.type === 'createdTime' || column.property.type === 'updatedTime')
            continue;
          cells.push({ rowId, property: column.property, text: value });
        }
      }
      const { skipped } = await setCellsFromText(ctx, database, cells, queryCtx);
      if (skipped > 0)
        ctx.toast({ variant: 'warning', title: t('pasteSkipped', { count: skipped }) });
      if (!fill) {
        select(
          {
            active: grid.active,
            anchor: {
              row: Math.min(range.top + height - 1, rowCount + Math.max(0, missing) - 1),
              col: Math.min(range.left + width - 1, colCount - 1),
            },
          },
          false,
        );
      }
    });
  };

  // Keyboard ------------------------------------------------------------------------------------
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== scrollRef.current) return;
    const mod = ctx.platform.isApple ? event.metaKey : event.ctrlKey;
    if (editing) {
      // The editor mounts once its row exists (a new row arrives a moment later): keep what is
      // typed meanwhile so the first letters are not lost.
      if (event.key.length === 1 && !mod && !event.altKey) {
        event.preventDefault();
        setEditing((current) =>
          current ? { ...current, initialText: (current.initialText ?? '') + event.key } : current,
        );
      }
      return;
    }
    if (!grid) {
      if (
        ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(
          event.key,
        ) &&
        colCount > 0
      ) {
        event.preventDefault();
        const start = { row: rowCount > 0 ? 0 : -1, col: 0 };
        select({ active: start, anchor: start });
      }
      if (event.key === 'Enter' && mod && !readOnly) {
        event.preventDefault();
        void createRow({});
      }
      return;
    }
    const { active } = grid;
    const onHeader = active.row === -1;
    const onFooter = active.row === rowCount;
    const column = columns[active.col];
    if (onHeader && column && !readOnly) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setHeaderMenu(column.property.id);
        return;
      }
      if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        const step = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 48 : 16);
        runAction(ctx, () =>
          setColumnWidth(database, view.id, column.property.id, column.width + step),
        );
        return;
      }
      if (mod && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        moveColumn(column.property.id, event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
    }
    if (onFooter && (event.key === 'Enter' || event.key === ' ') && !readOnly) {
      event.preventDefault();
      setFooterMenu(active.col);
      return;
    }
    if (event.key === 'Enter' && mod) {
      event.preventDefault();
      if (readOnly) return;
      const item = navRows[active.row];
      void createRow({
        after: item?.row.id ?? null,
        group:
          item?.group && view.group
            ? { propertyId: view.group.propertyId, key: item.group.key }
            : null,
      });
      return;
    }
    if ((event.key === 'Enter' || event.key === 'F2') && !onHeader && !onFooter) {
      event.preventDefault();
      if (event.altKey) {
        const item = navRows[active.row];
        if (item) onOpenRow(item.row.id, 'peek');
        return;
      }
      startEditing(active, null);
      return;
    }
    if (event.key === 'Escape') {
      if (active.row !== grid.anchor.row || active.col !== grid.anchor.col) {
        event.preventDefault();
        select({ active, anchor: active }, false);
      }
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !onHeader && !onFooter) {
      event.preventDefault();
      if (mod) {
        if (range)
          deleteRowsAt(
            Array.from({ length: range.bottom - range.top + 1 }, (_, i) => range.top + i),
          );
      } else {
        clearRange();
      }
      return;
    }
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      if (rowCount > 0)
        select(
          { active: { row: 0, col: 0 }, anchor: { row: rowCount - 1, col: colCount - 1 } },
          false,
        );
      return;
    }
    if (
      (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) &&
      !onHeader &&
      !onFooter
    ) {
      event.preventDefault();
      const element = document.getElementById(cellElementId(gridId, active.row, active.col));
      const rect = element?.getBoundingClientRect();
      const item = navRows[active.row];
      if (item && rect) setRowMenu({ key: item.key, x: rect.left, y: rect.bottom });
      return;
    }
    if (event.key === ' ' && column?.property.type === 'checkbox' && !onHeader && !onFooter) {
      event.preventDefault();
      const item = navRows[active.row];
      if (item) toggleCheckbox(item.row, active.col);
      return;
    }
    const next = navigate(
      grid,
      { key: event.key, shiftKey: event.shiftKey, modKey: mod },
      {
        rowCount,
        colCount,
        pageSize: Math.max(
          1,
          Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_HEIGHT) - 2,
        ),
        header: true,
        footer: true,
      },
    );
    if (next) {
      event.preventDefault();
      select(next);
      return;
    }
    const printable = event.key.length === 1 && !mod && !event.altKey;
    if (printable && !onHeader && !onFooter && column && !readOnly) {
      if (
        TEXT_EDITOR_TYPES.has(column.property.type) ||
        POPOVER_EDITOR_TYPES.has(column.property.type)
      ) {
        event.preventDefault();
        startEditing(active, TEXT_EDITOR_TYPES.has(column.property.type) ? event.key : null);
      }
    }
  };

  // Pointer -------------------------------------------------------------------------------------
  const wasActive = useRef(false);
  const events = useMemo<CellEvents>(
    () => ({
      onCellPointerDown: (rowIndex: number, col: number, event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        const current = lastGrid.current;
        wasActive.current =
          !!current &&
          current.active.row === rowIndex &&
          current.active.col === col &&
          !event.shiftKey;
        const pos = { row: rowIndex, col };
        if (event.shiftKey && current && current.anchor.row >= 0) {
          setSelectionRef.current({ active: pos, anchor: current.anchor });
        } else {
          setSelectionRef.current({ active: pos, anchor: pos });
          dragging.current = true;
        }
      },
      onCellPointerEnter: (rowIndex: number, col: number) => {
        const current = lastGrid.current;
        if (!dragging.current || !current) return;
        setSelectionRef.current({ active: { row: rowIndex, col }, anchor: current.anchor });
      },
      onCellClick: (rowIndex: number, col: number, event: MouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        const isCheckbox = columnsRef.current[col]?.property.type === 'checkbox';
        if (isCheckbox && target.closest('[aria-hidden="true"]')) {
          const item = navRowsRef.current[rowIndex];
          if (item) toggleRef.current(item.row, col);
          return;
        }
        if (wasActive.current && !isCheckbox) startEditingRef.current({ row: rowIndex, col }, null);
      },
      onCellDoubleClick: (rowIndex: number, col: number) => {
        if (columnsRef.current[col]?.property.type === 'checkbox') return;
        startEditingRef.current({ row: rowIndex, col }, null);
      },
      onEditDone,
      onOpenPeek: (rowId: string) => onOpenRowRef.current(rowId, 'peek'),
      onRowMenu: (rowIndex: number, x: number, y: number) => {
        const item = navRowsRef.current[rowIndex];
        if (item) setRowMenu({ key: item.key, x, y });
      },
    }),
    [onEditDone],
  );
  const setSelectionRef = useRef((next: GridSelection) => select(next, false));
  setSelectionRef.current = (next: GridSelection) => select(next, false);
  const startEditingRef = useRef(startEditing);
  startEditingRef.current = startEditing;
  const toggleRef = useRef(toggleCheckbox);
  toggleRef.current = toggleCheckbox;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const navRowsRef = useRef(navRows);
  navRowsRef.current = navRows;
  const onOpenRowRef = useRef(onOpenRow);
  onOpenRowRef.current = onOpenRow;

  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, []);

  // Columns: order and actions ------------------------------------------------------------------
  const moveColumn = (propertyId: string, offset: number) => {
    const list = materializeViewProperties(listProperties(database.doc), view);
    const visibleIds = list.filter((entry) => entry.visible).map((entry) => entry.propertyId);
    const at = visibleIds.indexOf(propertyId);
    const neighbor = visibleIds[at + offset];
    if (at < 0 || !neighbor) return;
    const target = list.findIndex((entry) => entry.propertyId === neighbor);
    runAction(ctx, () => movePropertyInView(database, view.id, propertyId, target));
  };

  const sensors = useDragSensors();
  const nameOf = useCallback(
    (id: string | number) =>
      snapshot.properties.find((property) => property.id === id)?.name || t('untitled'),
    [snapshot.properties],
  );
  const accessibility = useDragAccessibility(nameOf);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const list = materializeViewProperties(listProperties(database.doc), view);
    const target = list.findIndex((entry) => entry.propertyId === over.id);
    if (target >= 0)
      runAction(ctx, () => movePropertyInView(database, view.id, String(active.id), target));
  };

  const insertColumn = (propertyId: string, side: 'left' | 'right') =>
    runAction(ctx, () => {
      const list = materializeViewProperties(listProperties(database.doc), view);
      const at = list.findIndex((entry) => entry.propertyId === propertyId);
      const property = addDatabaseProperty(database, {
        type: 'text',
        view: { id: view.id, index: side === 'left' ? at : at + 1 },
      });
      afterMenu.schedule(() => setRenaming(property.id));
    });

  // Groups --------------------------------------------------------------------------------------
  const toggleGroup = (group: RowGroup<ResolvedRow>) =>
    runAction(ctx, () => {
      const config = view.group;
      if (!config) return;
      const collapsed = config.collapsed.includes(group.key)
        ? config.collapsed.filter((key) => key !== group.key)
        : [...config.collapsed, group.key];
      updateView(database.doc, view.id, { group: { ...config, collapsed } });
    });
  const hideGroup = (group: RowGroup<ResolvedRow>) =>
    runAction(ctx, () => {
      const config = view.group;
      if (!config) return;
      updateView(database.doc, view.id, {
        group: { ...config, hidden: [...config.hidden, group.key] },
      });
    });
  const addInGroup = (group: RowGroup<ResolvedRow>) =>
    void createRow({
      group: view.group ? { propertyId: view.group.propertyId, key: group.key } : null,
    });

  // Rendering -----------------------------------------------------------------------------------
  const activeDescendant = (() => {
    if (!grid || editing) return undefined;
    if (grid.active.row === -1) return `${gridId}-header-${grid.active.col}`;
    if (grid.active.row === rowCount) return `${gridId}-footer-${grid.active.col}`;
    return cellElementId(gridId, grid.active.row, grid.active.col);
  })();
  const rowMenuItem = rowMenu ? navRows.find((item) => item.key === rowMenu.key) : undefined;
  const optionsProperty = optionsFor
    ? snapshot.properties.find((property) => property.id === optionsFor)
    : undefined;
  const formulaProperty = formulaFor
    ? snapshot.properties.find((property) => property.id === formulaFor)
    : undefined;

  return (
    <div className="relative">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={onDragEnd}
        accessibility={accessibility}
      >
        {/* The grid owns focus and keyboard handling; its cells are ARIA gridcells. */}
        <div
          ref={scrollRef}
          role="grid"
          tabIndex={0}
          aria-label={t('tableGrid', { name: databaseTitle })}
          aria-rowcount={summaryRowIndex}
          aria-colcount={colCount + (readOnly ? 1 : 2)}
          aria-multiselectable="true"
          aria-readonly={readOnly || undefined}
          aria-activedescendant={activeDescendant}
          aria-describedby={`${gridId}-hint`}
          data-scrolls-x={scrollsX || undefined}
          onKeyDown={onKeyDown}
          onCopy={onCopy}
          onCut={onCut}
          onPaste={onPaste}
          onFocus={(event) => {
            if (event.target === scrollRef.current && !selection && colCount > 0) {
              const start = { row: rowCount > 0 ? 0 : -1, col: 0 };
              select({ active: start, anchor: start }, false);
            }
          }}
          className={cn(
            // The active cell's outline shows while focus is in the grid.
            'group/grid relative overflow-auto border-t border-border bg-bg outline-none',
            heightClassName,
          )}
        >
          <div style={{ width: totalWidth, minWidth: '100%' }} className="relative">
            {/* Header */}
            <div
              role="row"
              aria-rowindex={1}
              className="sticky top-0 z-[5] flex bg-bg"
              style={{ width: totalWidth, height: HEADER_HEIGHT }}
            >
              <div
                className={cn('left-0 z-[4] shrink-0 border-b border-border bg-bg', STICKY)}
                style={{ width: GUTTER_WIDTH }}
              />
              <SortableContext
                items={columns.map((column) => column.property.id)}
                strategy={horizontalListSortingStrategy}
              >
                {columns.map((column, col) => (
                  <HeaderCell
                    key={column.property.id}
                    id={`${gridId}-header-${col}`}
                    database={database}
                    property={column.property}
                    rows={snapshot.rows}
                    queryCtx={queryCtx}
                    width={column.width}
                    stickyLeft={column.stickyLeft}
                    colIndex={col}
                    active={grid?.active.row === -1 && grid.active.col === col}
                    menuOpen={headerMenu === column.property.id}
                    onMenuOpenChange={(open) => {
                      setHeaderMenu(open ? column.property.id : null);
                      if (!open) focusGrid();
                    }}
                    renaming={renaming === column.property.id}
                    onRenameEnd={() => {
                      setRenaming(null);
                      focusGrid();
                    }}
                    onResizeLive={(width) =>
                      setLiveWidth(width === null ? null : { id: column.property.id, width })
                    }
                    onResizeEnd={(width) =>
                      runAction(ctx, () =>
                        setColumnWidth(database, view.id, column.property.id, width),
                      )
                    }
                    onPointerDownCell={() =>
                      select({ active: { row: -1, col }, anchor: { row: -1, col } }, false)
                    }
                    onMenuCloseAutoFocus={afterMenu.onCloseAutoFocus}
                    readOnly={readOnly}
                    actions={{
                      rename: () => afterMenu.schedule(() => setRenaming(column.property.id)),
                      editOptions: () => setOptionsFor(column.property.id),
                      editFormula: () =>
                        afterMenu.schedule(() => setFormulaFor(column.property.id)),
                      sort: (direction) => onSortBy(column.property.id, direction),
                      filter: () => onFilterBy(column.property.id),
                      groupBy: () => onGroupBy(column.property.id),
                      hide: () =>
                        runAction(ctx, () =>
                          setPropertyVisible(database, view.id, column.property.id, false),
                        ),
                      insert: (side) => insertColumn(column.property.id, side),
                      move: (side) => moveColumn(column.property.id, side === 'left' ? -1 : 1),
                    }}
                  />
                ))}
              </SortableContext>
              {!readOnly ? (
                // A header cell of its own (a row holds only cells), after the property columns.
                <div
                  role="columnheader"
                  aria-colindex={colCount + 2}
                  aria-label={t('addProperty')}
                  className="flex shrink-0 items-center justify-center border-b border-border"
                  style={{ width: ADD_COLUMN_WIDTH }}
                >
                  <AddPropertyButton
                    onCloseAutoFocus={afterMenu.onCloseAutoFocus}
                    onAdd={(type) =>
                      runAction(ctx, () => {
                        const property = addDatabaseProperty(database, {
                          type,
                          view: { id: view.id, index: Number.MAX_SAFE_INTEGER },
                        });
                        // A new formula starts in the formula editor; other types start renamed.
                        afterMenu.schedule(() =>
                          type === 'formula'
                            ? setFormulaFor(property.id)
                            : setRenaming(property.id),
                        );
                      })
                    }
                  />
                </div>
              ) : null}
            </div>

            {/* Body */}
            <TableBody
              scrollRef={scrollRef}
              handle={body}
              items={items}
              columns={columns}
              colIndex={colIndex}
              totalWidth={totalWidth}
              gridId={gridId}
              database={database}
              grid={grid}
              range={range}
              multiCell={range !== null && rangeSize(range) > 1}
              editing={editing}
              wrap={wrap}
              readOnly={readOnly}
              queryCtx={queryCtx}
              events={events}
              groupProperty={groupProperty}
              onToggleGroup={toggleGroup}
              onHideGroup={readOnly ? undefined : hideGroup}
              onAddInGroup={addInGroup}
            />

            {/* New row: a row of its own, so the grid holds only rows. */}
            {hasNewRow ? (
              <div
                role="row"
                aria-rowindex={newRowIndex}
                className="flex border-b border-border"
                style={{ width: totalWidth, height: ROW_HEIGHT }}
              >
                <div role="gridcell" aria-colspan={colCount + 1} className="contents">
                  <button
                    type="button"
                    onClick={() => void createRow({ after: navRows[rowCount - 1]?.row.id ?? null })}
                    className={cn(
                      'left-0 flex h-full items-center gap-1.5 pr-3 text-ui text-fg-subtle hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none',
                      STICKY,
                    )}
                    style={{ paddingLeft: GUTTER_WIDTH + 8 }}
                  >
                    <Plus aria-hidden="true" className="size-4" />
                    {t('new')}
                  </button>
                </div>
              </div>
            ) : null}

            <SummaryRow
              gridId={gridId}
              database={database}
              view={view}
              columns={columns}
              totalWidth={totalWidth}
              rows={result.rows}
              queryCtx={queryCtx}
              activeCol={grid?.active.row === rowCount ? grid.active.col : null}
              menuCol={footerMenu}
              onMenuChange={(col) => {
                setFooterMenu(col);
                if (col === null) focusGrid();
              }}
              ariaRowIndex={summaryRowIndex}
              readOnly={readOnly}
            />
          </div>
        </div>
      </DndContext>
      <p id={`${gridId}-hint`} className="sr-only">
        {t('keyboardHint')}
      </p>
      {rowMenu && rowMenuItem ? (
        <DropdownMenu
          open
          onOpenChange={(open) => {
            if (!open) {
              setRowMenu(null);
              focusGrid();
            }
          }}
          modal={false}
        >
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden="true"
              className="fixed size-0"
              style={{ left: rowMenu.x, top: rowMenu.y }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
            <DropdownMenuItem
              icon={<FileText />}
              onSelect={() => onOpenRow(rowMenuItem.row.id, 'page')}
            >
              {t('openRowFull')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<PanelRightOpen />}
              shortcut={ctx.platform.isApple ? ['⌥', '↵'] : ['Alt', 'Enter']}
              onSelect={() => onOpenRow(rowMenuItem.row.id, 'peek')}
            >
              {t('openInSidePeek')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Plus />}
              shortcut={ctx.platform.isApple ? ['⌘', '↵'] : ['Ctrl', 'Enter']}
              onSelect={() =>
                void createRow({
                  after: rowMenuItem.row.id,
                  group:
                    rowMenuItem.group && view.group
                      ? { propertyId: view.group.propertyId, key: rowMenuItem.group.key }
                      : null,
                })
              }
            >
              {t('addRowBelow')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Copy />}
              onSelect={() =>
                runAction(ctx, () => duplicateRows(ctx, database, [rowMenuItem.row.id]))
              }
            >
              {t('duplicateRow')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={<Trash2 />}
              destructive
              shortcut={ctx.platform.isApple ? ['⌘', '⌫'] : ['Ctrl', 'Del']}
              onSelect={() => deleteRowsAt([rowMenuItem.navIndex])}
            >
              {t('deleteRow')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {optionsProperty ? (
        <OptionsDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setOptionsFor(null);
              focusGrid();
            }
          }}
          database={database}
          property={optionsProperty}
        />
      ) : null}
      {formulaProperty ? (
        <FormulaDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setFormulaFor(null);
              focusGrid();
            }
          }}
          database={database}
          property={formulaProperty}
          properties={snapshot.properties}
          rows={result.rows}
          queryCtx={queryCtx}
        />
      ) : null}
    </div>
  );
}

/** The "+" at the end of the header: pick a type to add a property. */
function AddPropertyButton({
  onAdd,
  onCloseAutoFocus,
}: {
  onAdd: (type: PropertyType) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" label={t('addProperty')} icon={<Plus />} tooltip={false} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-80 overflow-y-auto"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {PICKABLE_TYPES.map((type) => (
          <DropdownMenuItem
            key={type}
            icon={<PropertyIcon type={type} />}
            onSelect={() => onAdd(type)}
          >
            {typeLabel(type)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Values for a new row in a group (exported for the board and list views). */
export type GroupValues = Record<string, JsonValue>;
