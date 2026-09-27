import {
  getPageContent,
  InvalidOperationError,
  replaceTextWithPageLink,
  updateDocJSON,
  type AppContext,
  type Backlink,
  type UnlinkedMention,
} from '@tessera/core';
import { useAppContext, usePagesSelector } from '@tessera/core/react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import * as Y from 'yjs';
import { escapeRegExp } from '../engine/text';
import type { RichBacklink, Segment } from '../engine/types';
import { t } from '../i18n';
import { displayTitle } from '../ui/common';

/** Workspace setting: show the compact backlinks footer under every page. */
export const SHOW_FOOTER_SETTING = 'backlinks.showFooter';

export interface LinkData<T> {
  status: 'loading' | 'ready' | 'error';
  data: T;
  error: Error | null;
  retry(): void;
}

/**
 * Loads link data for a page and reloads it when the link index changes (throttled by the index),
 * keeping the last data on screen while reloading.
 */
export function useLinkData<T>(
  pageId: string | null,
  load: (ctx: AppContext, pageId: string) => Promise<T>,
  empty: T,
  enabled = true,
): LinkData<T> {
  const ctx = useAppContext();
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{
    pageId: string | null;
    status: LinkData<T>['status'];
    data: T;
    error: Error | null;
  }>({ pageId: null, status: 'loading', data: empty, error: null });
  useEffect(() => {
    if (!enabled) return undefined;
    return ctx.services.linkIndex.subscribe(() => setVersion((value) => value + 1));
  }, [ctx, enabled]);
  useEffect(() => {
    if (!enabled || !pageId) return undefined;
    let active = true;
    setState((previous) =>
      previous.pageId === pageId
        ? { ...previous, status: previous.status === 'error' ? 'loading' : previous.status }
        : { pageId, status: 'loading', data: empty, error: null },
    );
    load(ctx, pageId).then(
      (data) => {
        if (active) setState({ pageId, status: 'ready', data, error: null });
      },
      (error: unknown) => {
        if (!active) return;
        setState({
          pageId,
          status: 'error',
          data: empty,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      },
    );
    return () => {
      active = false;
    };
    // Callers pass module-level `load` and `empty`, so they never retrigger this.
  }, [ctx, pageId, version, enabled, load, empty]);
  const retry = useCallback(() => setVersion((value) => value + 1), []);
  const current =
    state.pageId === pageId ? state : { status: 'loading' as const, data: empty, error: null };
  return { ...current, retry };
}

export const loadBacklinks = (ctx: AppContext, pageId: string) =>
  ctx.services.linkIndex.backlinks(pageId) as Promise<Array<Backlink & Partial<RichBacklink>>>;

export const loadMentions = (ctx: AppContext, pageId: string) =>
  ctx.services.linkIndex.unlinkedMentions(pageId);

/** Groups items by source page, keeping the index's order (by source title). */
export function groupBySource<T extends { sourcePageId: string }>(
  items: readonly T[],
): Array<{ sourcePageId: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.sourcePageId);
    if (list) list.push(item);
    else groups.set(item.sourcePageId, [item]);
  }
  return [...groups].map(([sourcePageId, list]) => ({ sourcePageId, items: list }));
}

/** A page's current title (links without a label show it, and follow renames). */
function PageTitle({ id }: { id: string }) {
  return <>{displayTitle(usePagesSelector((pages) => pages.get(id)?.title))}</>;
}

/**
 * A block's inline content with live titles for links; the link to `targetId` is highlighted.
 * Falls back to plain text when the index did not provide segments.
 */
export function Context({
  segments,
  text,
  targetId,
}: {
  segments: readonly Segment[] | undefined;
  text: string;
  targetId: string;
}) {
  if (!segments?.length) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) => {
        switch (segment.t) {
          case 'text':
            return <Fragment key={index}>{segment.v}</Fragment>;
          case 'br':
            return <Fragment key={index}> </Fragment>;
          case 'tag':
            return (
              <span key={index} className="text-accent-text">
                #{segment.v}
              </span>
            );
          case 'link': {
            const title = segment.label ?? <PageTitle id={segment.id} />;
            return segment.id === targetId ? (
              <mark
                key={index}
                className="rounded-[3px] bg-accent-subtle px-0.5 font-medium text-accent-text"
              >
                {title}
              </mark>
            ) : (
              <span
                key={index}
                className="text-fg underline decoration-border-strong underline-offset-2"
              >
                {title}
              </span>
            );
          }
          default:
            return null;
        }
      })}
    </>
  );
}

/**
 * Highlights the mention in its block's text: the n-th whole-word occurrence of its text, where
 * n is its rank among the block's mentions with the same text.
 */
export function mentionRange(
  mention: UnlinkedMention & { display?: { start: number; end: number } | null },
  siblings: readonly UnlinkedMention[],
): { start: number; end: number } | null {
  // Our index knows the exact position; other link indexes only give the text.
  if (mention.display) return mention.display;
  const same = siblings
    .filter(
      (other) =>
        other.path.join('.') === mention.path.join('.') &&
        other.text.toLocaleLowerCase() === mention.text.toLocaleLowerCase(),
    )
    .sort((a, b) => a.from - b.from);
  const rank = Math.max(0, same.indexOf(mention));
  const regex = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(mention.text)}(?![\\p{L}\\p{N}_])`,
    'giu',
  );
  let count = 0;
  for (let match = regex.exec(mention.blockText); match; match = regex.exec(mention.blockText)) {
    if (count === rank) return { start: match.index, end: match.index + match[0].length };
    count += 1;
  }
  return null;
}

const LINK_ORIGIN = Symbol('tessera:link-mention');
const UNDO_WINDOW_MS = 8000;

/**
 * Turns an unlinked mention into a page link in its source page, with an undo toast. The undo
 * reverts exactly this change (a `Y.UndoManager` scoped to it), even if the page was edited since.
 * Returns false (after telling the user) when the text changed since the mention was found.
 */
export async function linkMention(
  ctx: AppContext,
  mention: UnlinkedMention,
  target: { id: string; title: string },
): Promise<boolean> {
  const handle = await ctx.loadPageDoc(mention.sourcePageId);
  const undo = new Y.UndoManager(getPageContent(handle.doc), {
    trackedOrigins: new Set([LINK_ORIGIN]),
  });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    undo.destroy();
    handle.release();
  };
  try {
    updateDocJSON(
      handle.doc,
      (doc) =>
        replaceTextWithPageLink(
          doc,
          mention,
          { pageId: target.id },
          { expectedText: mention.text },
        ),
      { origin: LINK_ORIGIN },
    );
  } catch (error) {
    finish();
    if (error instanceof InvalidOperationError) {
      ctx.toast({ title: t('linkFailed'), variant: 'warning' });
      return false;
    }
    throw error;
  }
  const source = displayTitle(ctx.workspace.getPage(mention.sourcePageId)?.title);
  ctx.toast({
    title: t('linked', { text: mention.text, source }),
    durationMs: UNDO_WINDOW_MS,
    action: {
      label: t('undo'),
      onClick: () => {
        if (!done) undo.undo();
        finish();
      },
    },
  });
  // Keep the doc open (and the undo available) while the toast is up.
  setTimeout(finish, UNDO_WINDOW_MS + 1000);
  return true;
}

/** Stable key of a mention (source, block path and range). */
export function mentionKey(mention: UnlinkedMention): string {
  return `${mention.sourcePageId}:${mention.path.join('.')}:${mention.from}-${mention.to}`;
}
