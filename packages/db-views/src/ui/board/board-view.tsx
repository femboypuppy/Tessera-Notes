import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  BOARD_GROUPABLE_TYPES,
  EMPTY_GROUP_KEY,
  moveRow,
  resolveViewProperties,
  updateView,
  type PropertyDefinition,
  type ResolvedRow,
  type TagColor,
} from '@tessera/core';
import { useAppContext } from '@tessera/core/react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  cn,
} from '@tessera/ui';
import {
  ArrowLeft,
  ArrowRight,
  ChevronsLeftRight,
  EyeOff,
  MoreHorizontal,
  MoveRight,
  Plus,
  SquareKanban,
} from 'lucide-react';
import { memo, useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { t } from '../../i18n';
import { setCell, viewSetup } from '../../model/operations';
import type { RowGroup } from '../../query/group';
import { Card } from '../cards/card';
import { displayTitle } from '../common';
import type { ViewBodyProps } from '../database-view';
import { useDragAccessibility } from '../dnd';
import { GroupLabel, groupName } from '../group-label';
import { runAction } from '../hooks';
import { RowMenu } from '../row-menu';
import { cardId, columnId, moveGroupKey, parseDragId, valueForGroupMove } from './board-logic';

const COLUMN_TINT: Readonly<Record<TagColor, string>> = {
  default: 'bg-tag-default-bg/40',
  gray: 'bg-tag-gray-bg/40',
  brown: 'bg-tag-brown-bg/40',
  orange: 'bg-tag-orange-bg/40',
  yellow: 'bg-tag-yellow-bg/40',
  green: 'bg-tag-green-bg/40',
  blue: 'bg-tag-blue-bg/40',
  purple: 'bg-tag-purple-bg/40',
  pink: 'bg-tag-pink-bg/40',
  red: 'bg-tag-red-bg/40',
};

const COLUMN_WIDTH = { small: 'w-56', medium: 'w-64', large: 'w-80' } as const;
const PAGE_SIZE = 50;

interface SortableCardProps {
  id: string;
  row: ResolvedRow;
  groupKey: string;
  view: ViewBodyProps['view'];
  cardProperties: readonly PropertyDefinition[];
  props: ViewBodyProps;
  groups: readonly RowGroup<ResolvedRow>[];
  groupProperty: PropertyDefinition;
  onMove: (row: ResolvedRow, fromKey: string, toKey: string) => void;
}

const SortableCard = memo(function SortableCard({
  id,
  row,
  groupKey,
  view,
  cardProperties,
  props,
  groups,
  groupProperty,
  onMove,
}: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: props.readOnly,
  });
  const open = (mode: 'page' | 'peek') => props.onOpenRow(row.id, mode);
  return (
    <Card
      ref={setNodeRef}
      row={row}
      properties={cardProperties}
      allProperties={props.snapshot.properties}
      options={view.board}
      queryCtx={props.queryCtx}
      dragging={isDragging}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      surface={{
        ...attributes,
        ...listeners,
        'data-card-id': row.id,
        'aria-roledescription': undefined,
        role: 'button',
        'aria-label': displayTitle(row.title),
        onClick: () => open('peek'),
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Enter' && event.target === event.currentTarget) {
            event.preventDefault();
            open('peek');
            return;
          }
          listeners?.onKeyDown?.(event);
        },
        className: 'cursor-pointer',
      }}
      actions={
        <RowMenu
          database={props.database}
          row={row}
          onOpen={open}
          readOnly={props.readOnly}
          className="absolute top-1.5 right-1.5 opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          extra={
            <DropdownMenuSub>
              <DropdownMenuSubTrigger icon={<MoveRight />}>{t('moveTo')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {groups
                  .filter((group) => group.key !== groupKey)
                  .map((group) => (
                    <DropdownMenuItem
                      key={group.key}
                      onSelect={() => onMove(row, groupKey, group.key)}
                    >
                      {groupName(group, groupProperty, props.queryCtx)}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          }
        />
      }
    />
  );
});

function Column({
  group,
  groupProperty,
  props,
  cardProperties,
  groups,
  onMove,
  onAdd,
  onToggleCollapse,
  onHide,
  onMoveColumn,
  index,
  count,
}: {
  group: RowGroup<ResolvedRow>;
  groupProperty: PropertyDefinition;
  props: ViewBodyProps;
  cardProperties: readonly PropertyDefinition[];
  groups: readonly RowGroup<ResolvedRow>[];
  onMove: (row: ResolvedRow, fromKey: string, toKey: string) => void;
  onAdd: () => void;
  onToggleCollapse: () => void;
  onHide: () => void;
  onMoveColumn: (offset: number) => void;
  index: number;
  count: number;
}) {
  const { view, readOnly, queryCtx } = props;
  const { setNodeRef, isOver } = useDroppable({ id: columnId(group.key) });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const name = groupName(group, groupProperty, queryCtx);
  const ids = useMemo(() => group.rows.map((row) => cardId(group.key, row.id)), [group]);
  const shown = group.rows.slice(0, limit);
  const tint =
    view.board.colorColumns && group.option ? COLUMN_TINT[group.option.color] : 'bg-bg-subtle';

  if (group.collapsed) {
    return (
      <section aria-label={name} className="shrink-0">
        <button
          ref={setNodeRef}
          type="button"
          aria-expanded={false}
          aria-label={t('expandGroup', { name })}
          onClick={onToggleCollapse}
          className={cn(
            'flex h-full min-h-40 w-11 flex-col items-center gap-2 rounded-lg py-3 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none',
            tint,
            isOver && 'ring-2 ring-accent',
          )}
        >
          <ChevronsLeftRight aria-hidden="true" className="size-4 text-fg-muted" />
          <span className="text-xs text-fg-muted tabular-nums">{group.rows.length}</span>
          <span className="[writing-mode:vertical-rl]">
            <GroupLabel group={group} property={groupProperty} queryCtx={queryCtx} />
          </span>
        </button>
      </section>
    );
  }
  return (
    <section
      aria-label={name}
      data-group-key={group.key}
      className={cn('flex shrink-0 flex-col rounded-lg', COLUMN_WIDTH[view.board.size], tint)}
    >
      <header className="flex h-10 items-center gap-1.5 px-2">
        <GroupLabel group={group} property={groupProperty} queryCtx={queryCtx} />
        <span className="text-xs text-fg-muted tabular-nums">{group.rows.length}</span>
        <span className="flex-1" />
        {!readOnly ? (
          <>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <IconButton size="sm" label={`${t('more')}: ${name}`} icon={<MoreHorizontal />} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem icon={<ChevronsLeftRight />} onSelect={onToggleCollapse}>
                  {t('collapseGroup', { name })}
                </DropdownMenuItem>
                {group.key !== EMPTY_GROUP_KEY || group.rows.length === 0 ? (
                  <DropdownMenuItem icon={<EyeOff />} onSelect={onHide}>
                    {t('hideGroup')}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  icon={<ArrowLeft />}
                  disabled={index === 0}
                  onSelect={() => onMoveColumn(-1)}
                >
                  {t('moveColumnLeft')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={<ArrowRight />}
                  disabled={index === count - 1}
                  onSelect={() => onMoveColumn(1)}
                >
                  {t('moveColumnRight')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <IconButton
              size="sm"
              label={`${t('addCard')}: ${name}`}
              icon={<Plus />}
              onClick={onAdd}
            />
          </>
        ) : null}
      </header>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            'duration-fast flex min-h-16 flex-1 flex-col gap-2 rounded-b-lg px-2 pb-2 transition-colors',
            isOver && 'bg-accent-subtle',
          )}
        >
          {shown.map((row) => (
            <SortableCard
              key={row.id}
              id={cardId(group.key, row.id)}
              row={row}
              groupKey={group.key}
              view={view}
              cardProperties={cardProperties}
              props={props}
              groups={groups}
              groupProperty={groupProperty}
              onMove={onMove}
            />
          ))}
          {group.rows.length > limit ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLimit((value) => value + PAGE_SIZE)}
            >
              {t('showMore', { count: Math.min(PAGE_SIZE, group.rows.length - limit) })}
            </Button>
          ) : null}
          {!readOnly ? (
            <button
              type="button"
              onClick={onAdd}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-ui text-fg-muted hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            >
              <Plus aria-hidden="true" className="size-4" />
              {t('addCard')}
            </button>
          ) : null}
        </div>
      </SortableContext>
    </section>
  );
}

/**
 * The board: a column per option (or checked state), cards showing the chosen properties. Drag a
 * card to another column to change its value, or within a column to reorder (without sorts);
 * the keyboard picks up with Space and moves with the arrows, and each card's menu has "Move to".
 * Columns collapse, hide and reorder from their menus.
 */
export function BoardView(props: ViewBodyProps) {
  const ctx = useAppContext();
  const { database, snapshot, view, result, readOnly, queryCtx } = props;
  const groupProperty = snapshot.properties.find(
    (property) => property.id === view.group?.propertyId,
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );
  const rowsById = useMemo(
    () => new Map(snapshot.rows.map((row) => [row.id, row])),
    [snapshot.rows],
  );
  const nameOf = useCallback(
    (id: string | number) => {
      const { groupKey, rowId } = parseDragId(String(id));
      if (rowId) return displayTitle(rowsById.get(rowId)?.title);
      const group = result.groups?.find((candidate) => candidate.key === groupKey);
      return group && groupProperty ? groupName(group, groupProperty, queryCtx) : groupKey;
    },
    [rowsById, result.groups, groupProperty, queryCtx],
  );
  const accessibility = useDragAccessibility(nameOf);

  if (!view.group || !groupProperty || !BOARD_GROUPABLE_TYPES.includes(groupProperty.type)) {
    return (
      <EmptyState
        className="rounded-md border border-dashed border-border"
        icon={<SquareKanban />}
        title={t('boardGroupRequired')}
        actions={
          readOnly ? null : (
            <Button
              onClick={() =>
                runAction(ctx, () =>
                  updateView(
                    database.doc,
                    view.id,
                    viewSetup(database.doc, 'board', { ...view, group: null }),
                  ),
                )
              }
            >
              {t('groupBy')}
            </Button>
          )
        }
      />
    );
  }

  const groups = result.groups ?? [];
  const visible = groups.filter((group) => !group.hidden);
  const cardProperties = resolveViewProperties(snapshot.properties, view)
    .filter((entry) => entry.visible && entry.property.type !== 'title')
    .map((entry) => entry.property);
  const config = view.group;
  const writeGroup = (patch: Partial<typeof config>) =>
    runAction(ctx, () => updateView(database.doc, view.id, { group: { ...config, ...patch } }));

  const moveCard = (row: ResolvedRow, fromKey: string, toKey: string) => {
    const value = valueForGroupMove(groupProperty, row.values[groupProperty.id], fromKey, toKey);
    if (value === undefined) return;
    runAction(ctx, () => setCell(ctx, database, row.id, groupProperty, value));
  };

  const onDragStart = ({ active }: DragStartEvent) => setActiveId(String(active.id));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    if (!over || readOnly) return;
    const from = parseDragId(String(active.id));
    const to = parseDragId(String(over.id));
    const row = from.rowId ? rowsById.get(from.rowId) : undefined;
    if (!row) return;
    if (to.groupKey !== from.groupKey) moveCard(row, from.groupKey, to.groupKey);
    if (view.sorts.length > 0 || !to.rowId || to.rowId === row.id) return;
    const target = groups.find((group) => group.key === to.groupKey);
    const fromIndex = target?.rows.findIndex((candidate) => candidate.id === row.id) ?? -1;
    const toIndex = target?.rows.findIndex((candidate) => candidate.id === to.rowId) ?? -1;
    const position =
      fromIndex >= 0 && fromIndex < toIndex ? { after: to.rowId } : { before: to.rowId };
    runAction(ctx, () => moveRow(database.doc, row.id, position));
  };
  const active = activeId ? parseDragId(activeId) : null;
  const activeRow = active?.rowId ? rowsById.get(active.rowId) : undefined;
  const naturalOrder = groups.map((group) => group.key);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={onDragEnd}
      accessibility={accessibility}
    >
      <div
        className={cn(
          'flex items-start gap-3 overflow-x-auto pb-3',
          props.variant === 'page'
            ? 'min-h-[calc(100dvh-var(--tess-topbar-height)-12rem)]'
            : 'max-h-[40rem]',
        )}
      >
        {visible.map((group, index) => (
          <Column
            key={group.key}
            group={group}
            groupProperty={groupProperty}
            props={props}
            cardProperties={cardProperties}
            groups={visible}
            onMove={moveCard}
            index={index}
            count={visible.length}
            onAdd={() =>
              runAction(ctx, async () => {
                const id = await props.onCreateRow({
                  group: { propertyId: groupProperty.id, key: group.key },
                });
                if (id) props.onOpenRow(id, 'peek');
              })
            }
            onToggleCollapse={() =>
              writeGroup({
                collapsed: config.collapsed.includes(group.key)
                  ? config.collapsed.filter((key) => key !== group.key)
                  : [...config.collapsed, group.key],
              })
            }
            onHide={() => writeGroup({ hidden: [...config.hidden, group.key] })}
            onMoveColumn={(offset) =>
              writeGroup({ order: moveGroupKey(naturalOrder, group.key, offset) })
            }
          />
        ))}
        {groups.some((group) => group.hidden) ? (
          <section
            aria-label={t('hiddenGroups')}
            className="flex w-52 shrink-0 flex-col gap-1 rounded-lg p-2"
          >
            <h3 className="px-1 text-xs font-medium text-fg-subtle">{t('hiddenGroups')}</h3>
            {groups
              .filter((group) => group.hidden)
              .map((group) => (
                <button
                  key={group.key}
                  type="button"
                  disabled={readOnly}
                  onClick={() =>
                    writeGroup({ hidden: config.hidden.filter((key) => key !== group.key) })
                  }
                  className="flex h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                  aria-label={`${t('showGroup')}: ${groupName(group, groupProperty, queryCtx)}`}
                >
                  <GroupLabel group={group} property={groupProperty} queryCtx={queryCtx} />
                  <span className="ml-auto text-xs text-fg-subtle tabular-nums">
                    {group.rows.length}
                  </span>
                </button>
              ))}
          </section>
        ) : null}
      </div>
      <DragOverlay>
        {activeRow ? (
          <Card
            row={activeRow}
            properties={cardProperties}
            allProperties={snapshot.properties}
            options={view.board}
            queryCtx={queryCtx}
            className={cn('rotate-2 shadow-dialog', COLUMN_WIDTH[view.board.size])}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
