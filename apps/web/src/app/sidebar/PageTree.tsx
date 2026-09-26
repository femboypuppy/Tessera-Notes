import type { AppContext, MoveTarget, PageMeta, PagesSnapshot } from '@tessera/core';
import { useAppContext, usePages, usePagesSelector } from '@tessera/core/react';
import {
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  sidebarItemClass,
} from '@tessera/ui';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  CornerDownRight,
  CornerLeftUp,
  Link2,
  MoreHorizontal,
  Plus,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router';
import { t } from '../../i18n';
import {
  attempt,
  displayTitle,
  PageIcon,
  pageUrl,
  trashWithUndo,
  createPageAndOpen,
  useViewOnly,
} from '../page-helpers';
import { useUiStore } from '../ui-store';

/** A visible row of the tree. */
interface Row {
  page: PageMeta;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
  /** Position among its siblings (1-based) and sibling count, for aria-posinset/setsize. */
  position: number;
  siblings: number;
}

type DropZone = 'before' | 'inside' | 'after';

const DRAG_TYPE = 'application/x-tessera-page';
const INDENT = 14;

function useExpanded(ctx: AppContext) {
  const key = `shell.expanded.${ctx.workspace.info.id}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const saved = ctx.settings.device.get(key);
    return new Set(
      Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [],
    );
  });
  const update = useCallback(
    (mutate: (next: Set<string>) => void) => {
      setExpanded((current) => {
        const next = new Set(current);
        mutate(next);
        ctx.settings.device.set(key, [...next]);
        return next;
      });
    },
    [ctx, key],
  );
  return [expanded, update] as const;
}

/**
 * The rows the tree shows: the top-level pages and the children of expanded ones. Collapsed
 * branches are not walked, so pages added inside them (an import adds thousands) cost nothing.
 */
function visibleRows(pages: PagesSnapshot, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    const siblings = pages.children(parentId).filter((page) => !seen.has(page.id));
    siblings.forEach((page, index) => {
      seen.add(page.id);
      const hasChildren = pages.children(page.id).length > 0;
      const isExpanded = hasChildren && expanded.has(page.id);
      rows.push({
        page,
        depth,
        parentId,
        hasChildren,
        expanded: isExpanded,
        position: index + 1,
        siblings: siblings.length,
      });
      if (isExpanded) visit(page.id, depth + 1);
    });
  };
  visit(null, 0);
  return rows;
}

/** Rows show the same thing (page objects are kept while unchanged). */
function sameRowData(a: Row, b: Row): boolean {
  return (
    a.page === b.page &&
    a.depth === b.depth &&
    a.parentId === b.parentId &&
    a.hasChildren === b.hasChildren &&
    a.expanded === b.expanded &&
    a.position === b.position &&
    a.siblings === b.siblings
  );
}

function sameRows(a: readonly Row[], b: readonly Row[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, index) => {
      const other = b[index];
      return other !== undefined && sameRowData(row, other);
    })
  );
}

/**
 * Actions shared by the row's "…" menu and its context menu. They don't read the page index, so a
 * row doesn't re-render when other pages change (an import adds thousands); the moves, which need
 * the siblings, are worked out by {@link useMoves} while a menu is open.
 */
function usePageActions(page: PageMeta, onExpand: (id: string) => void) {
  const ctx = useAppContext();
  const navigate = useNavigate();
  const viewOnly = useViewOnly();
  const copyLink = () => {
    void navigator.clipboard
      ?.writeText(pageUrl(page.id))
      .then(() => ctx.toast({ title: t('linkCopied') }));
  };
  // A viewer's changes would never reach the server: only reading actions remain.
  if (viewOnly) return { viewOnly, copyLink } as const;
  return {
    viewOnly,
    copyLink,
    addChild: () => {
      onExpand(page.id);
      createPageAndOpen(ctx, navigate, page.id);
    },
    toggleFavorite: () => ctx.workspace.setFavorite(page.id, !page.favorite),
    duplicate:
      page.kind === 'page'
        ? () => {
            void ctx.workspace.duplicatePage(page.id).then((copy) => ctx.navigate(copy.id));
          }
        : null,
    trash: () => trashWithUndo(ctx, page.id),
  };
}

/** Move up, down, in and out, from the page's place among its siblings (menus only). */
function useMoves(page: PageMeta, parentId: string | null, onExpand: (id: string) => void) {
  const ctx = useAppContext();
  const snapshot = usePages();
  const siblings = snapshot.children(parentId);
  const index = siblings.findIndex((sibling) => sibling.id === page.id);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const move = (target: MoveTarget) => attempt(() => ctx.workspace.movePage(page.id, target));
  return {
    moveUp: index > 0 ? () => move({ parentId, position: { index: index - 1 } }) : null,
    moveDown:
      index >= 0 && index < siblings.length - 1
        ? () => move({ parentId, position: { index: index + 1 } })
        : null,
    indent: previous
      ? () => {
          if (move({ parentId: previous.id, position: 'end' })) onExpand(previous.id);
        }
      : null,
    outdent:
      parentId !== null
        ? () =>
            move({ parentId: snapshot.effectiveParentId(parentId), position: { after: parentId } })
        : null,
  };
}

function MenuItems({
  page,
  parentId,
  onExpand,
  actions,
  Item,
  Separator,
}: {
  page: PageMeta;
  parentId: string | null;
  onExpand: (id: string) => void;
  actions: ReturnType<typeof usePageActions>;
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
}) {
  const moves = useMoves(page, parentId, onExpand);
  if (actions.viewOnly) {
    return (
      <Item icon={<Link2 />} onSelect={actions.copyLink}>
        {t('copyLink')}
      </Item>
    );
  }
  return (
    <>
      <Item icon={<Plus />} onSelect={actions.addChild}>
        {t('newSubpage')}
      </Item>
      <Item icon={page.favorite ? <StarOff /> : <Star />} onSelect={actions.toggleFavorite}>
        {page.favorite ? t('removeFromFavorites') : t('addToFavorites')}
      </Item>
      {actions.duplicate ? (
        <Item icon={<Copy />} onSelect={actions.duplicate}>
          {t('duplicate')}
        </Item>
      ) : null}
      <Item icon={<Link2 />} onSelect={actions.copyLink}>
        {t('copyLink')}
      </Item>
      <Separator />
      <Item
        icon={<ArrowUp />}
        disabled={!moves.moveUp}
        onSelect={() => moves.moveUp?.()}
        shortcut={['Alt', 'Shift', '↑']}
      >
        {t('moveUp')}
      </Item>
      <Item
        icon={<ArrowDown />}
        disabled={!moves.moveDown}
        onSelect={() => moves.moveDown?.()}
        shortcut={['Alt', 'Shift', '↓']}
      >
        {t('moveDown')}
      </Item>
      <Item
        icon={<CornerDownRight />}
        disabled={!moves.indent}
        onSelect={() => moves.indent?.()}
        shortcut={['Alt', 'Shift', '→']}
      >
        {t('indent')}
      </Item>
      <Item
        icon={<CornerLeftUp />}
        disabled={!moves.outdent}
        onSelect={() => moves.outdent?.()}
        shortcut={['Alt', 'Shift', '←']}
      >
        {t('outdent')}
      </Item>
      <Separator />
      <Item icon={<Trash2 />} destructive onSelect={actions.trash}>
        {t('moveToTrash')}
      </Item>
    </>
  );
}

interface TreeRowProps {
  row: Row;
  active: boolean;
  focused: boolean;
  dropZone: DropZone | null;
  dragging: boolean;
  onFocusRow: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onToggle: (id: string) => void;
  onExpand: (id: string) => void;
  dragHandlers: {
    onDragStart: (event: DragEvent<HTMLDivElement>, row: Row) => void;
    onDragOver: (event: DragEvent<HTMLDivElement>, row: Row) => void;
    onDrop: (event: DragEvent<HTMLDivElement>, row: Row) => void;
    onDragEnd: () => void;
  };
}

const TreeRow = memo(function TreeRow({
  row,
  active,
  focused,
  dropZone,
  dragging,
  onFocusRow,
  onToggle,
  onExpand,
  onKeyDown,
  dragHandlers,
}: TreeRowProps) {
  const ctx = useAppContext();
  const { page } = row;
  const actions = usePageActions(page, onExpand);
  const title = displayTitle(page);
  const indicator: ReactNode =
    dropZone === 'before' || dropZone === 'after' ? (
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute right-1 h-0.5 rounded-full bg-accent',
          dropZone === 'before' ? '-top-px' : '-bottom-px',
        )}
        style={{ left: 8 + row.depth * INDENT }}
      />
    ) : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="treeitem"
          aria-level={row.depth + 1}
          aria-setsize={row.siblings}
          aria-posinset={row.position}
          aria-expanded={row.hasChildren ? row.expanded : undefined}
          aria-selected={active}
          aria-label={title}
          tabIndex={focused ? 0 : -1}
          data-page-id={page.id}
          data-active={active || undefined}
          draggable={!actions.viewOnly}
          onDragStart={(event) => dragHandlers.onDragStart(event, row)}
          onDragOver={(event) => dragHandlers.onDragOver(event, row)}
          onDrop={(event) => dragHandlers.onDrop(event, row)}
          onDragEnd={dragHandlers.onDragEnd}
          onFocus={() => onFocusRow(page.id)}
          onKeyDown={onKeyDown}
          onClick={() => ctx.navigate(page.id)}
          className={cn(
            sidebarItemClass,
            'cursor-default gap-1 pr-1',
            dropZone === 'inside' && 'bg-accent-subtle text-fg ring-1 ring-accent',
            dragging && 'opacity-50',
          )}
          style={{ paddingLeft: 4 + row.depth * INDENT }}
        >
          {indicator}
          <button
            type="button"
            tabIndex={-1}
            aria-label={row.expanded ? t('collapse') : t('expand')}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(page.id);
            }}
            className={cn(
              'inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-subtle hover:bg-active hover:text-fg',
              !row.hasChildren && 'invisible',
            )}
          >
            <ChevronRight
              className={cn(
                'duration-fast size-3.5 transition-transform',
                row.expanded && 'rotate-90',
              )}
              aria-hidden="true"
            />
          </button>
          <PageIcon page={page} />
          <span className={cn('min-w-0 flex-1 truncate', !page.title.trim() && 'text-fg-subtle')}>
            {title}
          </span>
          <span className="duration-fast flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/item:opacity-100 group-hover/item:opacity-100 has-[[data-state=open]]:opacity-100">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t('moreActions')}
                  onClick={(event) => event.stopPropagation()}
                  className="inline-flex size-5 items-center justify-center rounded-sm text-fg-subtle hover:bg-active hover:text-fg data-[state=open]:bg-active"
                >
                  <MoreHorizontal className="size-3.5" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" onClick={(event) => event.stopPropagation()}>
                <MenuItems
                  page={page}
                  parentId={row.parentId}
                  onExpand={onExpand}
                  actions={actions}
                  Item={DropdownMenuItem}
                  Separator={DropdownMenuSeparator}
                />
              </DropdownMenuContent>
            </DropdownMenu>
            {actions.viewOnly ? null : (
              <button
                type="button"
                tabIndex={-1}
                aria-label={t('newSubpage')}
                onClick={(event) => {
                  event.stopPropagation();
                  actions.addChild();
                }}
                className="inline-flex size-5 items-center justify-center rounded-sm text-fg-subtle hover:bg-active hover:text-fg"
              >
                <Plus className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <MenuItems
          page={page}
          parentId={row.parentId}
          onExpand={onExpand}
          actions={actions}
          Item={ContextMenuItem}
          Separator={ContextMenuSeparator}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}, sameRow);

/** A row re-renders only when what it shows changed (page objects are kept while unchanged). */
function sameRow(before: TreeRowProps, after: TreeRowProps): boolean {
  return (
    sameRowData(before.row, after.row) &&
    before.active === after.active &&
    before.focused === after.focused &&
    before.dropZone === after.dropZone &&
    before.dragging === after.dragging &&
    before.onFocusRow === after.onFocusRow &&
    before.onToggle === after.onToggle &&
    before.onExpand === after.onExpand &&
    before.onKeyDown === after.onKeyDown &&
    before.dragHandlers === after.dragHandlers
  );
}

/**
 * The sidebar page tree: an ARIA tree with roving focus. Keyboard: arrows move and expand,
 * Enter opens, Alt+Shift+arrows reorder, nest and un-nest. Mouse: drag a page onto the top or
 * bottom edge of another to place it before or after, or onto its middle to nest it inside.
 */
export function PageTree() {
  const ctx = useAppContext();
  const currentPageId = useUiStore((state) => state.currentPageId);
  const [expanded, updateExpanded] = useExpanded(ctx);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; overId: string | null; zone: DropZone } | null>(
    null,
  );
  const [rootDropActive, setRootDropActive] = useState(false);
  const refocus = useRef(false);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const viewOnly = useViewOnly();

  // Handlers read the pages as they are when they run; rendering follows the visible rows only.
  const pages = () => ctx.workspace.pages.getSnapshot();
  const rows = usePagesSelector((snapshot) => visibleRows(snapshot, expanded), sameRows);

  // Reveal the open page: expand its ancestors.
  useEffect(() => {
    if (!currentPageId) return;
    const ancestors = pages().ancestors(currentPageId);
    if (ancestors.some((page) => !expanded.has(page.id))) {
      updateExpanded((next) => {
        for (const page of ancestors) next.add(page.id);
      });
    }
    // Only when the open page changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacting to snapshot changes would undo manual collapsing
  }, [currentPageId]);

  const tabbableId = rows.some((row) => row.page.id === focusedId)
    ? focusedId
    : (rows.find((row) => row.page.id === currentPageId)?.page.id ?? rows[0]?.page.id ?? null);

  useLayoutEffect(() => {
    if (!refocus.current || !focusedId) return;
    refocus.current = false;
    treeRef.current
      ?.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(focusedId)}"]`)
      ?.focus();
  });

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    refocus.current = true;
    setFocusedId(id);
  };
  const expand = useCallback(
    (id: string) => updateExpanded((next) => next.add(id)),
    [updateExpanded],
  );
  const toggle = useCallback(
    (id: string) =>
      updateExpanded((next) => {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }),
    [updateExpanded],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex(
      (row) => row.page.id === event.currentTarget.getAttribute('data-page-id'),
    );
    const row = rows[index];
    if (!row) return;
    const move = (target: MoveTarget) => {
      if (attempt(() => ctx.workspace.movePage(row.page.id, target))) focusRow(row.page.id);
    };
    if (event.altKey && event.shiftKey && !viewOnly) {
      const siblings = pages().children(row.parentId);
      const at = siblings.findIndex((page) => page.id === row.page.id);
      const handled: Record<string, (() => void) | undefined> = {
        ArrowUp:
          at > 0 ? () => move({ parentId: row.parentId, position: { index: at - 1 } }) : undefined,
        ArrowDown:
          at < siblings.length - 1
            ? () => move({ parentId: row.parentId, position: { index: at + 1 } })
            : undefined,
        ArrowRight:
          at > 0
            ? () => {
                const previous = siblings[at - 1];
                if (!previous) return;
                expand(previous.id);
                move({ parentId: previous.id, position: 'end' });
              }
            : undefined,
        ArrowLeft:
          row.parentId !== null
            ? () =>
                move({
                  parentId: pages().effectiveParentId(row.parentId ?? ''),
                  position: { after: row.parentId ?? '' },
                })
            : undefined,
      };
      if (event.key in handled) {
        event.preventDefault();
        handled[event.key]?.();
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(rows[index + 1]?.page.id);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(rows[index - 1]?.page.id);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(rows[0]?.page.id);
        break;
      case 'End':
        event.preventDefault();
        focusRow(rows[rows.length - 1]?.page.id);
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (row.hasChildren && !row.expanded) expand(row.page.id);
        else if (row.expanded) focusRow(rows[index + 1]?.page.id);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (row.expanded) toggle(row.page.id);
        else focusRow(row.parentId ?? undefined);
        break;
      case 'Enter':
      case ' ':
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        ctx.navigate(row.page.id);
        break;
      default:
        break;
    }
  };

  const isInvalidTarget = (draggedId: string, target: Row) =>
    target.page.id === draggedId ||
    pages()
      .ancestors(target.page.id)
      .some((page) => page.id === draggedId);

  const dragHandlers = {
    onDragStart: (event: DragEvent<HTMLDivElement>, row: Row) => {
      event.dataTransfer.setData(DRAG_TYPE, row.page.id);
      event.dataTransfer.setData('text/plain', displayTitle(row.page));
      event.dataTransfer.setData('text/uri-list', `/p/${row.page.id}`);
      event.dataTransfer.effectAllowed = 'move';
      setDrag({ id: row.page.id, overId: null, zone: 'inside' });
    },
    onDragOver: (event: DragEvent<HTMLDivElement>, row: Row) => {
      if (!drag || isInvalidTarget(drag.id, row)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = event.currentTarget.getBoundingClientRect();
      const offset = (event.clientY - rect.top) / Math.max(1, rect.height);
      const zone: DropZone = offset < 0.25 ? 'before' : offset > 0.75 ? 'after' : 'inside';
      if (drag.overId !== row.page.id || drag.zone !== zone) {
        setDrag({ ...drag, overId: row.page.id, zone });
        if (expandTimer.current) clearTimeout(expandTimer.current);
        if (zone === 'inside' && row.hasChildren && !row.expanded) {
          expandTimer.current = setTimeout(() => expand(row.page.id), 600);
        }
      }
    },
    onDrop: (event: DragEvent<HTMLDivElement>, row: Row) => {
      event.preventDefault();
      const draggedId = drag?.id ?? event.dataTransfer.getData(DRAG_TYPE);
      const zone = drag?.zone ?? 'inside';
      setDrag(null);
      if (!draggedId || isInvalidTarget(draggedId, row)) return;
      const target: MoveTarget =
        zone === 'inside'
          ? { parentId: row.page.id, position: 'end' }
          : {
              parentId: row.parentId,
              position: zone === 'before' ? { before: row.page.id } : { after: row.page.id },
            };
      if (attempt(() => ctx.workspace.movePage(draggedId, target)) && zone === 'inside')
        expand(row.page.id);
    },
    onDragEnd: () => {
      if (expandTimer.current) clearTimeout(expandTimer.current);
      setDrag(null);
      setRootDropActive(false);
    },
  };

  // Rows are memoized: they get handlers that never change and call the latest ones.
  const latest = useRef({ onKeyDown, dragHandlers });
  useLayoutEffect(() => {
    latest.current = { onKeyDown, dragHandlers };
  });
  const stableKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => latest.current.onKeyDown(event),
    [],
  );
  const stableDragHandlers = useMemo<typeof dragHandlers>(
    () => ({
      onDragStart: (event, row) => latest.current.dragHandlers.onDragStart(event, row),
      onDragOver: (event, row) => latest.current.dragHandlers.onDragOver(event, row),
      onDrop: (event, row) => latest.current.dragHandlers.onDrop(event, row),
      onDragEnd: () => latest.current.dragHandlers.onDragEnd(),
    }),
    [],
  );

  if (rows.length === 0) {
    return <p className="px-2 py-1 text-ui text-fg-subtle">{t('noPagesYet')}</p>;
  }

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label={t('pageTree')}
      aria-describedby="page-tree-hint"
      className="flex flex-col gap-px"
    >
      <span id="page-tree-hint" className="sr-only">
        {t('pageTreeHint')}
      </span>
      {rows.map((row) => (
        <TreeRow
          key={row.page.id}
          row={row}
          active={row.page.id === currentPageId}
          focused={row.page.id === tabbableId}
          dropZone={drag?.overId === row.page.id ? drag.zone : null}
          dragging={drag?.id === row.page.id}
          onFocusRow={setFocusedId}
          onToggle={toggle}
          onExpand={expand}
          onKeyDown={stableKeyDown}
          dragHandlers={stableDragHandlers}
        />
      ))}
      {/* Dropping below the last page moves the dragged page to the end of the top level. */}
      <div
        aria-hidden="true"
        data-testid="page-tree-root-drop"
        onDragOver={(event) => {
          if (!drag) return;
          event.preventDefault();
          setRootDropActive(true);
          setDrag({ ...drag, overId: null });
        }}
        onDragLeave={() => setRootDropActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          const draggedId = drag?.id ?? event.dataTransfer.getData(DRAG_TYPE);
          setDrag(null);
          setRootDropActive(false);
          if (draggedId)
            attempt(() => ctx.workspace.movePage(draggedId, { parentId: null, position: 'end' }));
        }}
        className={cn(
          'duration-fast h-6 rounded-md transition-colors',
          rootDropActive && 'bg-accent-subtle',
        )}
      />
    </div>
  );
}
