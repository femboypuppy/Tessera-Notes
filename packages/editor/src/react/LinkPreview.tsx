import { extractTextBlocks, readDocJSON, type TextBlock } from '@tessera/core';
import { useAncestors, usePage, usePagesSelector } from '@tessera/core/react';
import { cn, Skeleton } from '@tessera/ui';
import { FileText, FileX, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import type { EditorController } from './controller';
import { useFloatingPosition } from './floating';
import { useStore } from './store';

type Preview =
  { status: 'loading' } | { status: 'ready'; blocks: TextBlock[] } | { status: 'error' };

const MAX_BLOCKS = 5;

/** Loads the first lines of a page (the doc is released right after reading). */
function usePagePreview(controller: EditorController, pageId: string | null): Preview {
  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  useEffect(() => {
    if (!pageId) return undefined;
    let active = true;
    setPreview({ status: 'loading' });
    controller.ctx.loadPageDoc(pageId).then(
      (handle) => {
        try {
          const blocks = extractTextBlocks(readDocJSON(handle.doc))
            .filter((block) => block.text.trim())
            .slice(0, MAX_BLOCKS);
          if (active) setPreview({ status: 'ready', blocks });
        } catch {
          if (active) setPreview({ status: 'error' });
        } finally {
          handle.release();
        }
      },
      () => {
        if (active) setPreview({ status: 'error' });
      },
    );
    return () => {
      active = false;
    };
  }, [controller, pageId]);
  return preview;
}

/**
 * The preview card of a hovered (or selected) page link: icon, title, breadcrumb and the first
 * lines of the target. Clicking it opens the page. Missing and trashed targets say so.
 */
export function LinkPreview({ controller }: { controller: EditorController }) {
  const state = useStore(controller.linkPreview);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const anchor = state?.anchor ?? null;
  const getRect = useCallback(
    () => (anchor?.isConnected ? anchor.getBoundingClientRect() : null),
    [anchor],
  );
  const position = useFloatingPosition(panel, anchor ? getRect : null, { gap: 8 });
  const pageId = state?.pageId ?? null;
  // Only the previewed page (and its ancestors): nothing re-renders while no preview is open.
  const page = usePage(pageId);
  const trashed = usePagesSelector((pages) => (page ? pages.isTrashed(page.id) : false));
  const ancestors = useAncestors(page?.id);
  const preview = usePagePreview(controller, page && !trashed ? page.id : null);

  // The link describes itself with the card while it is shown.
  useEffect(() => {
    if (!anchor) return undefined;
    anchor.setAttribute('aria-describedby', id);
    return () => anchor.removeAttribute('aria-describedby');
  }, [anchor, id]);

  if (!state || !pageId) return null;
  const title = page ? page.title || t('untitled') : t('missingPage');

  let body;
  if (!page) body = <p className="text-ui text-fg-muted">{t('linkPreviewMissing')}</p>;
  else if (trashed) body = <p className="text-ui text-fg-muted">{t('linkPreviewTrashed')}</p>;
  else if (preview.status === 'loading')
    body = (
      <div className="flex flex-col gap-2 pt-1" aria-label={t('linkPreviewLoading')}>
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  else if (preview.status === 'error')
    body = <p className="text-ui text-fg-muted">{t('linkPreviewError')}</p>;
  else if (preview.blocks.length === 0)
    body = <p className="text-ui text-fg-subtle italic">{t('linkPreviewEmpty')}</p>;
  else
    body = (
      <div className="flex flex-col gap-1">
        {preview.blocks.map((block, index) => (
          <p
            key={index}
            className={cn(
              'line-clamp-2 text-ui break-words',
              block.type === 'heading' ? 'font-semibold text-fg' : 'text-fg-muted',
              block.type === 'codeBlock' && 'font-mono text-2xs',
            )}
          >
            {block.text}
          </p>
        ))}
      </div>
    );

  // A preview, not a control: the link itself opens the page (click, or Enter when selected).
  return createPortal(
    <div
      ref={panel}
      id={id}
      role="tooltip"
      className={cn(
        'tess-link-preview fixed z-[var(--tess-z-popover)] w-80 rounded-lg border border-border bg-surface-raised p-3 shadow-popover',
        position ? 'visible animate-pop-in' : 'invisible',
      )}
      style={{ top: position?.top ?? 0, left: position?.left ?? 0 }}
      onMouseEnter={() => controller.holdLinkPreview()}
      onMouseLeave={() => controller.releaseLinkPreview()}
    >
      <div className="mb-2 flex items-start gap-2">
        <span className="flex size-6 flex-none items-center justify-center text-base leading-none">
          {page?.icon ? (
            page.icon
          ) : !page ? (
            <FileX className="size-4 text-fg-subtle" aria-hidden="true" />
          ) : trashed ? (
            <Trash2 className="size-4 text-fg-subtle" aria-hidden="true" />
          ) : (
            <FileText className="size-4 text-fg-muted" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg">{title}</p>
          {ancestors.length ? (
            <p className="truncate text-2xs text-fg-subtle">
              {ancestors.map((ancestor) => ancestor.title || t('untitled')).join(' / ')}
            </p>
          ) : null}
        </div>
      </div>
      {body}
    </div>,
    document.body,
  );
}
