import { Search, Shuffle, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { tUi } from '../i18n/index';
import { cn } from '../lib/cn';
import { Button } from './button';
import { Spinner } from './feedback';

/** One emoji of the picker's data set. */
export interface EmojiEntry {
  emoji: string;
  label: string;
  group: number;
  /** Lowercase label, tags and shortcodes, for search. */
  search: string;
}

interface EmojiData {
  emojis: EmojiEntry[];
  groups: Array<{ id: number; key: string; emojis: EmojiEntry[] }>;
}

const GROUP_KEYS: Record<number, string> = {
  0: 'smileys-emotion',
  1: 'people-body',
  3: 'animals-nature',
  4: 'food-drink',
  5: 'travel-places',
  6: 'activities',
  7: 'objects',
  8: 'symbols',
  9: 'flags',
};

const COLUMNS = 9;

/** Translated name of an emoji group (keys are the `emojiGroup.*` strings). */
const groupLabel = (key: string) => tUi(`emojiGroup.${key}` as Parameters<typeof tUi>[0]);
const RECENT_KEY = 'tessera:emoji-recent';
const MAX_RECENT = COLUMNS * 2;

let dataPromise: Promise<EmojiData> | null = null;

/** Loads (once) the emoji data set, split into its own chunk. */
export function loadEmojiData(): Promise<EmojiData> {
  dataPromise ??= import('emojibase-data/en/compact.json').then((module) => {
    const raw = (
      module as {
        default: Array<{
          unicode: string;
          label: string;
          group?: number;
          order?: number;
          tags?: string[];
          shortcodes?: string[];
        }>;
      }
    ).default;
    const emojis = raw
      .filter((entry) => entry.group !== undefined && entry.group in GROUP_KEYS)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((entry) => ({
        emoji: entry.unicode,
        label: entry.label,
        group: entry.group ?? 0,
        search: [entry.label, ...(entry.tags ?? []), ...(entry.shortcodes ?? [])]
          .join(' ')
          .toLowerCase(),
      }));
    const groups = Object.entries(GROUP_KEYS).map(([id, key]) => ({
      id: Number(id),
      key,
      emojis: emojis.filter((entry) => entry.group === Number(id)),
    }));
    return { emojis, groups };
  });
  return dataPromise;
}

function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

function rememberRecent(emoji: string): void {
  try {
    const next = [emoji, ...readRecent().filter((item) => item !== emoji)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: recents are a convenience.
  }
}

/**
 * An emoji picker: search, recent emojis, categories, full keyboard navigation (arrow keys in the
 * grid, Enter to pick, Escape handled by the surrounding popover). Put it in a `PopoverContent`.
 *
 * @example
 * <PopoverContent className="p-0"><EmojiPicker onSelect={(emoji) => setIcon(emoji)} onRemove={clearIcon} /></PopoverContent>
 */
export function EmojiPicker({
  onSelect,
  onRemove,
  autoFocus = true,
  className,
}: {
  onSelect: (emoji: string) => void;
  onRemove?: () => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const [data, setData] = useState<EmojiData | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [recent] = useState(readRecent);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    loadEmojiData().then(
      (loaded) => {
        if (active) setData(loaded);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!data || !needle) return null;
    // Exact label first, then labels starting with the query, then labels containing it, then tags.
    const rank = (entry: EmojiEntry): number => {
      const label = entry.label.toLowerCase();
      if (label === needle) return 0;
      if (label.startsWith(needle)) return 1;
      if (label.includes(needle)) return 2;
      return entry.search.includes(needle) ? 3 : -1;
    };
    return data.emojis
      .map((entry, index) => ({ entry, index, score: rank(entry) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .map((item) => item.entry);
  }, [data, query]);

  const pick = useCallback(
    (emoji: string) => {
      rememberRecent(emoji);
      onSelect(emoji);
    },
    [onSelect],
  );

  // Enter in the search box before the data has loaded picks the first result once it arrives.
  const pendingEnter = useRef(false);
  useEffect(() => {
    if (!pendingEnter.current || !results) return;
    pendingEnter.current = false;
    const first = results[0];
    if (first) pick(first.emoji);
  }, [results, pick]);

  const buttons = () => [
    ...(gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-emoji]') ?? []),
  ];

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = buttons();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: COLUMNS,
      ArrowUp: -COLUMNS,
    };
    let next: number | null = null;
    if (event.key in moves) next = index + (moves[event.key] ?? 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = all.length - 1;
    if (next === null) return;
    event.preventDefault();
    all[Math.max(0, Math.min(all.length - 1, next))]?.focus();
  };

  // Roving tab stop: the first button of the first grid is tabbable; arrow keys move from there.
  const renderGrid = (
    entries: readonly { emoji: string; label: string }[],
    firstTabbable = false,
  ) => (
    <div className="grid grid-cols-9 gap-0.5" role="presentation">
      {entries.map((entry, index) => (
        <button
          key={entry.emoji}
          type="button"
          data-emoji={entry.emoji}
          aria-label={entry.label}
          title={entry.label}
          tabIndex={firstTabbable && index === 0 ? 0 : -1}
          onClick={() => pick(entry.emoji)}
          className="duration-fast flex size-8 items-center justify-center rounded-md text-xl leading-none transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        >
          {entry.emoji}
        </button>
      ))}
    </div>
  );

  const labelFor = (emoji: string) =>
    data?.emojis.find((entry) => entry.emoji === emoji)?.label ?? emoji;

  return (
    <div className={cn('flex w-[312px] flex-col', className)}>
      <div className="flex items-center gap-1 border-b border-border p-2">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-subtle"
            aria-hidden="true"
          />
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the picker opens on request; focusing search is expected
            autoFocus={autoFocus}
            type="search"
            value={query}
            onChange={(event) => {
              pendingEnter.current = false;
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                buttons()[0]?.focus();
              } else if (event.key === 'Enter') {
                const first = results?.[0];
                if (first) {
                  event.preventDefault();
                  pick(first.emoji);
                } else if (!data && !failed && query.trim()) {
                  event.preventDefault();
                  pendingEnter.current = true;
                }
              }
            }}
            placeholder={tUi('emojiSearch')}
            aria-label={tUi('emojiSearch')}
            className="h-7 w-full rounded-md border border-border bg-bg pr-2 pl-7 text-ui outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus"
          />
        </div>
        {data ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={tUi('emojiRandom')}
            title={tUi('emojiRandom')}
            onClick={() => {
              const entry = data.emojis[Math.floor(Math.random() * data.emojis.length)];
              if (entry) pick(entry.emoji);
            }}
          >
            <Shuffle aria-hidden="true" />
          </Button>
        ) : null}
        {onRemove ? (
          <Button size="sm" variant="ghost" onClick={onRemove}>
            <Trash2 aria-hidden="true" />
            {tUi('emojiRemove')}
          </Button>
        ) : null}
      </div>
      {data && !results ? (
        <div
          className="flex gap-0.5 border-b border-border px-2 py-1"
          role="toolbar"
          aria-label={tUi('emojiSearch')}
        >
          {data.groups.map((group) => (
            <button
              key={group.id}
              type="button"
              aria-label={groupLabel(group.key)}
              title={groupLabel(group.key)}
              onClick={() =>
                gridRef.current
                  ?.querySelector(`[data-group="${group.id}"]`)
                  ?.scrollIntoView({ block: 'start' })
              }
              className="flex size-7 items-center justify-center rounded-md text-base grayscale transition hover:bg-hover hover:grayscale-0"
            >
              {group.emojis[0]?.emoji}
            </button>
          ))}
        </div>
      ) : null}
      {/* The grid container handles arrow keys for the buttons inside it. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- keyboard navigation delegate for the emoji buttons */}
      <div ref={gridRef} className="h-72 overflow-y-auto p-2" onKeyDown={onGridKeyDown}>
        {failed ? (
          <p className="p-4 text-center text-ui text-fg-muted">{tUi('emojiNoResults')}</p>
        ) : !data ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label={tUi('emojiLoading')} />
          </div>
        ) : results ? (
          results.length ? (
            renderGrid(results, true)
          ) : (
            <p className="p-4 text-center text-ui text-fg-muted">{tUi('emojiNoResults')}</p>
          )
        ) : (
          <>
            {recent.length ? (
              <section className="mb-2">
                <h3 className="px-1 pb-1 text-2xs font-medium text-fg-subtle">
                  {tUi('emojiRecent')}
                </h3>
                {renderGrid(
                  recent.map((emoji) => ({ emoji, label: labelFor(emoji) })),
                  true,
                )}
              </section>
            ) : null}
            {data.groups.map((group, index) => (
              <section
                key={group.id}
                data-group={group.id}
                className="mb-2 [contain-intrinsic-size:auto_300px] [content-visibility:auto]"
              >
                <h3 className="px-1 pb-1 text-2xs font-medium text-fg-subtle">
                  {groupLabel(group.key)}
                </h3>
                {renderGrid(group.emojis, index === 0 && recent.length === 0)}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
