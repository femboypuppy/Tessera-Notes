import { type SidePanelProps, type UnlinkedMention } from '@tessera/core';
import {
  sameItems,
  useAppContext,
  usePage,
  usePagesSelector,
  useSetting,
} from '@tessera/core/react';
import { Button, cn, EmptyState, Skeleton, Switch } from '@tessera/ui';
import { ChevronRight, Link2, Link2Off, TriangleAlert } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { displayTitle, focusSnippet, Highlighted, PageGlyph } from '../ui/common';
import {
  Context,
  groupBySource,
  linkMention,
  loadBacklinks,
  loadMentions,
  mentionKey,
  mentionRange,
  SHOW_FOOTER_SETTING,
  useLinkData,
} from './shared';

const NO_BACKLINKS: Awaited<ReturnType<typeof loadBacklinks>> = [];
const NO_MENTIONS: UnlinkedMention[] = [];

function Section({
  title,
  count,
  countLabel,
  children,
  defaultOpen = true,
}: {
  title: string;
  count: number | null;
  countLabel: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`} className="border-b border-border last:border-b-0">
      <h3 className="m-0">
        <button
          type="button"
          id={`${id}-title`}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((value) => !value)}
          className="duration-fast flex h-9 w-full items-center gap-1.5 px-3 text-left text-xs font-semibold tracking-wide text-fg-muted uppercase transition-colors outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn('duration-fast size-3.5 transition-transform', open && 'rotate-90')}
          />
          <span className="flex-1">{title}</span>
          {count !== null ? (
            <>
              <span
                aria-hidden="true"
                className="font-normal tracking-normal text-fg-subtle normal-case"
              >
                {count}
              </span>
              <span className="sr-only">{countLabel}</span>
            </>
          ) : null}
        </button>
      </h3>
      <div id={`${id}-body`} hidden={!open} className="px-2 pb-3">
        {children}
      </div>
    </section>
  );
}

function SourceHeader({ pageId, count }: { pageId: string; count?: string }) {
  const ctx = useAppContext();
  const page = usePage(pageId);
  const isRow = usePagesSelector((pages) => pages.isRow(pageId));
  const title = displayTitle(page?.title);
  return (
    <button
      type="button"
      onClick={() => ctx.navigate(pageId)}
      className="duration-fast flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm font-medium text-fg transition-colors outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
    >
      <PageGlyph page={page} isRow={isRow} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {count ? <span className="shrink-0 text-xs font-normal text-fg-subtle">{count}</span> : null}
    </button>
  );
}

function Loading() {
  return (
    <div
      aria-busy="true"
      aria-label={t('loadingBacklinks')}
      className="flex flex-col gap-3 px-1.5 py-2"
    >
      {[0, 1].map((row) => (
        <div key={row} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="ml-6 h-3 w-5/6" />
        </div>
      ))}
    </div>
  );
}

function Failed({ retry }: { retry: () => void }) {
  return (
    <EmptyState
      tone="danger"
      icon={<TriangleAlert />}
      title={t('backlinksFailed')}
      className="py-6"
      actions={
        <Button size="sm" onClick={retry}>
          {t('retry')}
        </Button>
      }
    />
  );
}

function LinkedReferences({ pageId }: { pageId: string }) {
  const ctx = useAppContext();
  const backlinks = useLinkData(pageId, loadBacklinks, NO_BACKLINKS);
  const groups = groupBySource(backlinks.data);
  return (
    <Section
      title={t('linkedReferences')}
      count={backlinks.status === 'ready' ? backlinks.data.length : null}
      countLabel={t('referencesCount', { count: backlinks.data.length })}
    >
      {backlinks.status === 'loading' && backlinks.data.length === 0 ? (
        <Loading />
      ) : backlinks.status === 'error' ? (
        <Failed retry={backlinks.retry} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<Link2 />}
          title={t('noBacklinks')}
          description={t('noBacklinksHint')}
          className="py-6"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((group) => (
            <li key={group.sourcePageId}>
              <SourceHeader
                pageId={group.sourcePageId}
                count={group.items.length > 1 ? String(group.items.length) : undefined}
              />
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {group.items.map((link, index) => (
                  <li key={`${link.path.join('.')}:${link.offset}:${index}`}>
                    <button
                      type="button"
                      onClick={() =>
                        ctx.navigate(
                          group.sourcePageId,
                          link.blockId ? { blockId: link.blockId } : {},
                        )
                      }
                      className="duration-fast ml-6 w-[calc(100%-1.5rem)] rounded-md border-l-2 border-border px-2 py-1 text-left text-ui leading-relaxed text-fg-muted transition-colors outline-none hover:border-accent hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <span className="line-clamp-3">
                        <Context segments={link.segments} text={link.blockText} targetId={pageId} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function UnlinkedMentions({ pageId, readOnly }: { pageId: string; readOnly: boolean }) {
  const ctx = useAppContext();
  const mentions = useLinkData(pageId, loadMentions, NO_MENTIONS);
  // Mentions linked from here hide at once; fresh data from the index replaces the list (and
  // brings a mention back after Undo).
  const [linked, setLinked] = useState<{ data: unknown; keys: ReadonlySet<string> }>({
    data: null,
    keys: new Set(),
  });
  const hidden = linked.data === mentions.data ? linked.keys : new Set<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const title = displayTitle(usePagesSelector((pages) => pages.get(pageId)?.title));
  const visible = mentions.data.filter((mention) => !hidden.has(mentionKey(mention)));
  const groups = groupBySource(visible);
  const sources = usePagesSelector(
    (pages) => groups.map((group) => pages.get(group.sourcePageId)?.title),
    sameItems,
  );
  const link = async (mention: UnlinkedMention) => {
    const key = mentionKey(mention);
    setBusy(key);
    try {
      const ok = await linkMention(ctx, mention, { id: pageId, title });
      if (ok)
        setLinked((previous) => ({
          data: mentions.data,
          keys: new Set([...(previous.data === mentions.data ? previous.keys : []), key]),
        }));
      else mentions.retry();
    } catch (error) {
      ctx.toast({
        title: t('backlinksFailed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'error',
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section
      title={t('unlinkedMentions')}
      count={mentions.status === 'ready' ? visible.length : null}
      countLabel={t('mentionsCount', { count: visible.length })}
    >
      {mentions.status === 'loading' && mentions.data.length === 0 ? (
        <Loading />
      ) : mentions.status === 'error' ? (
        <Failed retry={mentions.retry} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<Link2Off />}
          title={t('noMentions')}
          description={t('noMentionsHint', { title })}
          className="py-6"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((group, index) => {
            const source = displayTitle(sources[index]);
            return (
              <li key={group.sourcePageId}>
                <SourceHeader pageId={group.sourcePageId} />
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {group.items.map((mention) => {
                    const key = mentionKey(mention);
                    return (
                      <li
                        key={key}
                        className="group/mention ml-6 flex items-start gap-2 rounded-md border-l-2 border-border px-2 py-1 hover:bg-hover"
                      >
                        <span className="line-clamp-3 min-w-0 flex-1 text-ui leading-relaxed text-fg-muted">
                          <MentionText mention={mention} siblings={group.items} />
                        </span>
                        {readOnly ? null : (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy === key}
                            disabled={busy !== null && busy !== key}
                            aria-label={t('linkMention', { title, source })}
                            className="h-6 px-2 text-xs"
                            onClick={() => void link(mention)}
                          >
                            <Link2 aria-hidden="true" />
                            {t('link')}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** The mention in its block, with the text around it (long blocks are cut before it). */
function MentionText({
  mention,
  siblings,
}: {
  mention: UnlinkedMention;
  siblings: readonly UnlinkedMention[];
}) {
  const range = mentionRange(mention, siblings);
  const excerpt = focusSnippet({ text: mention.blockText, highlights: range ? [range] : [] }, 48);
  return <Highlighted text={excerpt.text} ranges={excerpt.highlights} />;
}

function FooterToggle() {
  const ctx = useAppContext();
  const [show, setShow] = useSetting<boolean>(ctx.settings.workspace, SHOW_FOOTER_SETTING, false);
  const id = useId();
  return (
    <div className="mt-auto flex items-center gap-3 border-t border-border px-3 py-3">
      <Switch id={id} checked={show} onCheckedChange={(checked) => setShow(checked)} />
      <label htmlFor={id} className="text-ui text-fg-muted">
        {t('showFooter')}
      </label>
    </div>
  );
}

/** The backlinks side panel (`PANELS.backlinks`): linked references and unlinked mentions. */
export default function BacklinksPanel({ pageId, page }: SidePanelProps) {
  const readOnly = usePagesSelector((pages) => !!pageId && pages.isTrashed(pageId));
  if (!pageId || !page) {
    return <EmptyState icon={<Link2 />} title={t('noPageOpen')} className="py-10" />;
  }
  return (
    <div className="flex min-h-full flex-col">
      <LinkedReferences key={`refs:${pageId}`} pageId={pageId} />
      <UnlinkedMentions key={`mentions:${pageId}`} pageId={pageId} readOnly={readOnly} />
      <FooterToggle />
    </div>
  );
}
