import {
  updateView,
  type FilterCondition,
  type PropertyDefinition,
  type ViewConfig,
} from '@tessera/core';
import { sameItems, useAppContext, usePagesSelector } from '@tessera/core/react';
import { cn } from '@tessera/ui';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Layers, X } from 'lucide-react';
import { t } from '../../i18n';
import type { DatabaseRef } from '../../model/operations';
import { formatDay } from '../../query/format';
import { countConditions, removeNode, VALUELESS_OPERATORS } from '../../query/filter-edit';
import { isConditionActive } from '../../query/filter';
import { resolveDateOperand, todayKey } from '../../query/dates';
import type { QueryContext } from '../../query/types';
import { PropertyIcon, displayTitle } from '../common';
import { runAction } from '../hooks';

/** A condition as a short sentence: "Status is Done", "Due is within This week". */
export function describeCondition(
  condition: FilterCondition,
  property: PropertyDefinition,
  queryCtx: QueryContext,
  titleOf: (pageId: string) => string | undefined,
): string {
  const operator = t(`op_${condition.operator}`);
  if (VALUELESS_OPERATORS.includes(condition.operator)) return operator;
  const { value } = condition;
  const optionName = (id: unknown) =>
    property.options?.find((option) => option.id === id)?.name ?? '';
  let text = '';
  if (Array.isArray(value)) {
    text = value
      .map((id) =>
        property.type === 'relation' ? displayTitle(titleOf(String(id))) : optionName(id),
      )
      .filter(Boolean)
      .join(', ');
  } else if (typeof value === 'boolean') {
    text = value ? t('checked') : t('unchecked');
  } else if (typeof value === 'number') {
    text = String(property.number?.format === 'percent' ? `${value * 100}%` : value);
  } else if (typeof value === 'string') {
    text =
      property.type === 'select' || property.type === 'multiSelect'
        ? optionName(value)
        : property.type === 'relation'
          ? displayTitle(titleOf(value))
          : `“${value}”`;
  } else if (value && typeof value === 'object') {
    if (value.kind === 'range') text = t(`range_${value.range}`);
    else if (value.kind === 'between')
      text = `${formatDay(value.start, undefined, queryCtx)} → ${formatDay(value.end, undefined, queryCtx)}`;
    else {
      const day = resolveDateOperand(value, todayKey(queryCtx.now, queryCtx.timeZone));
      text = day ? formatDay(day, { format: 'relative', timeFormat: 'locale' }, queryCtx) : '';
    }
  }
  return text ? `${operator} ${text}` : operator;
}

/**
 * The view's active sorts and filters as chips under the toolbar: each shows its rule, opens the
 * builder when clicked, and has a remove button.
 */
export function FilterChips({
  database,
  view,
  properties,
  queryCtx,
  readOnly,
  onOpenFilters,
  onOpenSorts,
}: {
  database: DatabaseRef;
  view: ViewConfig;
  properties: readonly PropertyDefinition[];
  queryCtx: QueryContext;
  readOnly: boolean;
  onOpenFilters: () => void;
  onOpenSorts: () => void;
}) {
  const ctx = useAppContext();
  const filter = view.filter;
  const byId = new Map(properties.map((property) => [property.id, property]));
  const sorts = view.sorts.filter((rule) => byId.has(rule.propertyId));
  const chips = filter?.children ?? [];
  // Relation filters name pages (maybe in no row): the chips follow those pages' titles only.
  const pageIds = chips.flatMap((node) => {
    if (node.type !== 'condition' || byId.get(node.propertyId)?.type !== 'relation') return [];
    const { value } = node;
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  });
  const titles = usePagesSelector((pages) => pageIds.map((id) => pages.get(id)?.title), sameItems);
  if (chips.length === 0 && sorts.length === 0) return null;
  const titleById = new Map(pageIds.map((id, index) => [id, titles[index]]));
  const titleOf = (id: string) => titleById.get(id);
  const chipClass =
    'inline-flex h-7 max-w-72 items-center gap-1 rounded-full border px-2.5 text-ui transition-colors';
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={t('filterBuilder')}>
      {sorts.map((rule) => {
        const property = byId.get(rule.propertyId);
        if (!property) return null;
        const Icon = rule.direction === 'asc' ? ArrowUpNarrowWide : ArrowDownWideNarrow;
        return (
          <button
            key={`sort-${rule.propertyId}`}
            type="button"
            onClick={onOpenSorts}
            className={cn(chipClass, 'border-border bg-bg text-fg-muted hover:bg-hover')}
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{property.name || t('untitled')}</span>
          </button>
        );
      })}
      {sorts.length > 0 && chips.length > 0 ? <span className="mx-0.5 h-4 w-px bg-border" /> : null}
      {chips.map((node) => {
        if (node.type === 'group') {
          return (
            <button
              key={node.id}
              type="button"
              onClick={onOpenFilters}
              className={cn(
                chipClass,
                'border-accent/40 bg-accent-subtle text-accent-text hover:bg-hover',
              )}
            >
              <Layers aria-hidden="true" className="size-3.5 shrink-0" />
              {t('filters', { count: countConditions(node) })}
            </button>
          );
        }
        const property = byId.get(node.propertyId);
        if (!property) return null;
        const active = isConditionActive(node, properties, queryCtx);
        const sentence = describeCondition(node, property, queryCtx, titleOf);
        return (
          <span
            key={node.id}
            className={cn(
              chipClass,
              'pr-1',
              active
                ? 'border-accent/40 bg-accent-subtle text-accent-text'
                : 'border-dashed border-border-strong text-fg-muted',
            )}
          >
            <button
              type="button"
              onClick={onOpenFilters}
              title={active ? undefined : t('filterInactive')}
              className="flex min-w-0 items-center gap-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <PropertyIcon type={property.type} className="text-current" />
              <span className="shrink-0 font-medium">{property.name || t('untitled')}</span>
              <span className="truncate">{sentence}</span>
            </button>
            {!readOnly ? (
              <button
                type="button"
                aria-label={t('removeFilter')}
                onClick={() =>
                  runAction(ctx, () => {
                    if (!filter) return;
                    const next = removeNode(filter, node.id);
                    updateView(database.doc, view.id, {
                      filter: next.children.length ? next : null,
                    });
                  })
                }
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
