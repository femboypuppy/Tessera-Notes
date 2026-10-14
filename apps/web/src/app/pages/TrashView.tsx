import type { PageMeta } from '@tessera/core';
import { useAppContext, usePages } from '@tessera/core/react';
import { Button, EmptyState, Input, Select } from '@tessera/ui';
import { RotateCcw, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { t } from '../../i18n';
import { displayTitle, PageIcon } from '../page-helpers';

function relativeTime(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(seconds, 'second');
}

function TrashRow({ page }: { page: PageMeta }) {
  const ctx = useAppContext();
  const snapshot = usePages();
  const parentId = snapshot.effectiveParentId(page.id);
  const parent = parentId ? snapshot.get(parentId) : undefined;
  const remove = async () => {
    const confirmed = await ctx.confirm({
      title: t('deleteForeverConfirm', { title: displayTitle(page) }),
      description: t('deleteForeverConfirmHint'),
      confirmLabel: t('deleteForever'),
      destructive: true,
    });
    if (confirmed) await ctx.workspace.deletePagePermanently(page.id);
  };
  return (
    <li className="group/row duration-fast flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-hover">
      <PageIcon page={page} />
      <button
        type="button"
        onClick={() => ctx.navigate(page.id)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-sm text-fg">{displayTitle(page)}</span>
        <span className="block truncate text-xs text-fg-muted">
          {t('trashedAgo', { when: relativeTime(page.trashedAt ?? Date.now()) })}
          {parent ? ` · ${t('inside', { parent: displayTitle(parent) })}` : ''}
        </span>
      </button>
      <Button size="sm" onClick={() => ctx.workspace.restorePage(page.id)}>
        <RotateCcw aria-hidden="true" />
        {t('restore')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-danger-text hover:bg-danger-subtle hover:text-danger-text"
        onClick={() => void remove()}
      >
        <Trash2 aria-hidden="true" />
        {t('deleteForever')}
      </Button>
    </li>
  );
}

/** `/trash`: restore pages or delete them for good. */
export function TrashView() {
  const ctx = useAppContext();
  const snapshot = usePages();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'title'>('newest');
  const trash = snapshot.trash();
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matching = needle
      ? trash.filter((page) => displayTitle(page).toLocaleLowerCase().includes(needle))
      : trash;
    return [...matching].sort((a, b) => {
      if (sort === 'title') return displayTitle(a).localeCompare(displayTitle(b));
      const difference = (a.trashedAt ?? 0) - (b.trashedAt ?? 0);
      return (sort === 'newest' ? -difference : difference) || a.id.localeCompare(b.id);
    });
  }, [trash, query, sort]);

  const emptyAll = async () => {
    const confirmed = await ctx.confirm({
      title: t('emptyTrashConfirm'),
      description: t('emptyTrashConfirmHint', { count: trash.length }),
      confirmLabel: t('emptyTrash'),
      destructive: true,
    });
    if (confirmed) await ctx.workspace.emptyTrash();
  };

  return (
    <section aria-labelledby="trash-title" className="mx-auto w-full max-w-3xl px-4 py-10 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 id="trash-title" className="text-2xl font-semibold tracking-tight">
            {t('trashTitle')}
          </h1>
          <p className="mt-1 text-ui text-fg-muted">{t('trashHint')}</p>
        </div>
        {trash.length > 0 ? (
          <Button variant="danger" onClick={() => void emptyAll()}>
            <Trash2 aria-hidden="true" />
            {t('emptyTrash')}
          </Button>
        ) : null}
      </div>
      {trash.length === 0 ? (
        <EmptyState
          className="mt-12"
          icon={<Trash2 />}
          title={t('trashEmpty')}
          description={t('trashEmptyHint')}
        />
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <div className="relative min-w-48 flex-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('filterTrash')}
                aria-label={t('filterTrash')}
                className="pl-8"
              />
            </div>
            <Select
              aria-label={t('sortTrash')}
              value={sort}
              onValueChange={(value) => setSort(value as typeof sort)}
              options={[
                { value: 'newest', label: t('trashNewestFirst') },
                { value: 'oldest', label: t('trashOldestFirst') },
                { value: 'title', label: t('trashTitleSort') },
              ]}
              className="w-44"
            />
          </div>
          {filtered.length === 0 ? (
            <p className="mt-8 text-center text-ui text-fg-muted">
              {t('noTrashMatches', { query })}
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-0.5" aria-label={t('trashTitle')}>
              {filtered.map((page) => (
                <TrashRow key={page.id} page={page} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
