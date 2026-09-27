import type { HighlightRange, PageMeta } from '@tessera/core';
import { usePagesSelector } from '@tessera/core/react';
import { cn, getLocale } from '@tessera/ui';
import { Database, FileText, Rows3 } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { t } from '../i18n';

/** A page's title, or "Untitled". */
export function displayTitle(title: string | undefined | null): string {
  return title?.trim() ? title : t('untitled');
}

/** Text with highlighted ranges (search matches). Ranges must be sorted and not overlap. */
export function Highlighted({
  text,
  ranges,
  className,
}: {
  text: string;
  ranges: readonly HighlightRange[] | undefined;
  className?: string;
}) {
  if (!ranges?.length) return <span className={className}>{text}</span>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach((range, index) => {
    const start = Math.max(at, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > at) parts.push(<Fragment key={`t${index}`}>{text.slice(at, start)}</Fragment>);
    if (end > start)
      parts.push(
        <mark
          key={`m${index}`}
          className="rounded-[3px] bg-accent-subtle px-px [font-weight:inherit] text-accent-text"
        >
          {text.slice(start, end)}
        </mark>,
      );
    at = end;
  });
  if (at < text.length) parts.push(<Fragment key="rest">{text.slice(at)}</Fragment>);
  return <span className={className}>{parts}</span>;
}

/** A page's emoji, or an icon for its kind (rows get the row icon). */
export function PageGlyph({
  page,
  isRow = false,
  className,
}: {
  page: Pick<PageMeta, 'icon' | 'kind'> | undefined;
  isRow?: boolean;
  className?: string;
}) {
  if (page?.icon) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center text-[15px] leading-none',
          className,
        )}
      >
        {page.icon}
      </span>
    );
  }
  const Icon = page?.kind === 'database' ? Database : isRow ? Rows3 : FileText;
  return <Icon aria-hidden="true" className={cn('size-4 shrink-0 text-fg-subtle', className)} />;
}

/** "Parent / Child" path of a page's ancestors (empty for top-level pages). */
export function usePagePath(pageId: string | null | undefined): string {
  return usePagesSelector((pages) =>
    pageId
      ? pages
          .ancestors(pageId)
          .map((page) => displayTitle(page.title))
          .join(' / ')
      : '',
  );
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "3 days ago", "just now" (locale-aware). */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = timestamp - now;
  const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return format.format(Math.round(diff / ms), unit);
  }
  return t('justNow');
}

/**
 * Moves a snippet's window so its first highlight sits near the start (for one-line rows, where
 * the end is cut off), with an ellipsis where text was dropped.
 */
export function focusSnippet(
  snippet: { text: string; highlights: HighlightRange[] },
  lead = 28,
): { text: string; highlights: HighlightRange[] } {
  const first = snippet.highlights[0];
  if (!first || first.start <= lead) return snippet;
  let start = first.start - lead;
  const space = snippet.text.indexOf(' ', start);
  if (space >= 0 && space < first.start) start = space + 1;
  const prefix = '…';
  const shift = prefix.length - start;
  return {
    text: `${prefix}${snippet.text.slice(start)}`,
    highlights: snippet.highlights
      .filter((range) => range.start >= start)
      .map((range) => ({ start: range.start + shift, end: range.end + shift })),
  };
}
