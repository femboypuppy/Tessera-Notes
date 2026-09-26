import {
  isSafeHref,
  type JsonValue,
  type PageMeta,
  type PropertyDefinition,
  type ResolvedRow,
} from '@tessera/core';
import { sameItems, useAppContext, usePagesSelector } from '@tessera/core/react';
import { cn } from '@tessera/ui';
import { Check, FileText } from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import { t } from '../../i18n';
import { readCell, readDateValue } from '../../query/cells';
import { formatDateValue, formatInstant, formatNumber } from '../../query/format';
import type { QueryContext } from '../../query/types';
import { OptionBadge, displayTitle } from '../common';

/** A link target for what someone typed in a URL cell (`nasa.gov` becomes `https://nasa.gov`). */
export function urlHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withScheme =
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('#')
      ? trimmed
      : `https://${trimmed}`;
  return isSafeHref(withScheme) ? withScheme : null;
}

const stop = (event: MouseEvent) => event.stopPropagation();

function RelationChips({ ids, wrap }: { ids: readonly string[]; wrap: boolean }) {
  const ctx = useAppContext();
  // Only the linked pages: a cell re-renders when one of them changes, not with every page.
  const visible = usePagesSelector(
    (pages) =>
      ids.flatMap((id): PageMeta[] => {
        const page = pages.get(id);
        return page && !pages.isTrashed(id) ? [page] : [];
      }),
    sameItems,
  );
  return (
    <span className={cn('flex min-w-0 gap-1', wrap ? 'flex-wrap' : 'overflow-hidden')}>
      {visible.map((page) => (
        <a
          key={page.id}
          href={`/p/${encodeURIComponent(page.id)}`}
          tabIndex={-1}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            ctx.navigate(page.id);
          }}
          className="inline-flex max-w-full shrink-0 items-center gap-1 rounded-sm px-1 text-ui text-fg underline decoration-border-strong underline-offset-2 hover:bg-hover"
        >
          {page.icon ? (
            <span aria-hidden="true">{page.icon}</span>
          ) : (
            <FileText aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
          )}
          <span className="truncate">{displayTitle(page.title)}</span>
        </a>
      ))}
    </span>
  );
}

/** A checkbox look for cells (the grid or the row handles the toggle). */
export function CheckboxVisual({ checked }: { checked: boolean }) {
  return (
    <span className="inline-flex items-center">
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex size-4 items-center justify-center rounded-sm border',
          checked ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong bg-bg',
        )}
      >
        {checked ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
      <span className="sr-only">{checked ? t('checked') : t('unchecked')}</span>
    </span>
  );
}

export interface CellDisplayProps {
  row: ResolvedRow;
  property: PropertyDefinition;
  queryCtx: QueryContext;
  /** Let text and tags wrap onto several lines. */
  wrap?: boolean;
  className?: string;
}

/** The value of one cell, formatted with the property's config. Empty cells render nothing. */
export const CellDisplay = memo(function CellDisplay({
  row,
  property,
  queryCtx,
  wrap = false,
  className,
}: CellDisplayProps) {
  const value: JsonValue = readCell(row, property);
  const text = cn(
    'min-w-0 text-sm text-fg',
    wrap ? 'break-words whitespace-pre-wrap' : 'truncate',
    className,
  );
  switch (property.type) {
    case 'title':
      return <span className={text}>{displayTitle(row.title)}</span>;
    case 'text':
      return typeof value === 'string' && value ? <span className={text}>{value}</span> : null;
    case 'number':
      return typeof value === 'number' ? (
        <span className={cn(text, 'ml-auto text-right tabular-nums')}>
          {formatNumber(value, property.number, queryCtx.locale)}
        </span>
      ) : null;
    case 'select': {
      const option = property.options?.find((candidate) => candidate.id === value);
      return option ? <OptionBadge option={option} className={className} /> : null;
    }
    case 'multiSelect': {
      if (!Array.isArray(value)) return null;
      const byId = new Map(property.options?.map((option) => [option.id, option]));
      const options = value.flatMap((id) => {
        const option = typeof id === 'string' ? byId.get(id) : undefined;
        return option ? [option] : [];
      });
      if (options.length === 0) return null;
      return (
        <span
          className={cn('flex min-w-0 gap-1', wrap ? 'flex-wrap' : 'overflow-hidden', className)}
        >
          {options.map((option) => (
            <OptionBadge key={option.id} option={option} />
          ))}
        </span>
      );
    }
    case 'date': {
      const date = readDateValue(value);
      return date ? (
        <span className={text}>{formatDateValue(date, property.date, queryCtx)}</span>
      ) : null;
    }
    case 'checkbox':
      return <CheckboxVisual checked={value === true} />;
    case 'url': {
      if (typeof value !== 'string' || !value.trim()) return null;
      const href = urlHref(value);
      return href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={-1}
          onClick={stop}
          className={cn(text, 'text-fg underline decoration-border-strong underline-offset-2')}
        >
          {value}
        </a>
      ) : (
        <span className={text}>{value}</span>
      );
    }
    case 'email':
      return typeof value === 'string' && value.trim() ? (
        <a
          href={`mailto:${value.trim()}`}
          tabIndex={-1}
          onClick={stop}
          className={cn(text, 'text-fg underline decoration-border-strong underline-offset-2')}
        >
          {value}
        </a>
      ) : null;
    case 'relation':
      return Array.isArray(value) ? (
        <RelationChips
          ids={value.filter((id): id is string => typeof id === 'string')}
          wrap={wrap}
        />
      ) : null;
    case 'createdTime':
    case 'updatedTime':
      return typeof value === 'number' && value > 0 ? (
        <span className={cn(text, 'text-fg-muted')}>
          {formatInstant(value, property.date, queryCtx)}
        </span>
      ) : null;
    case 'formula': {
      // Results show like the cells of their kind: numbers, checkboxes, dates or text.
      if (typeof value === 'number') {
        return (
          <span className={cn(text, 'ml-auto text-right tabular-nums')}>
            {formatNumber(value, undefined, queryCtx.locale)}
          </span>
        );
      }
      if (typeof value === 'boolean') return <CheckboxVisual checked={value} />;
      if (typeof value === 'string') return value ? <span className={text}>{value}</span> : null;
      const date = readDateValue(value);
      return date ? (
        <span className={text}>{formatDateValue(date, undefined, queryCtx)}</span>
      ) : null;
    }
  }
});
