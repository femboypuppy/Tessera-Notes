import type { AppContext, PageMeta } from '@tessera/core';
import { useAppContext, useSyncStatus } from '@tessera/core/react';
import { cn, toast } from '@tessera/ui';
import { Database, FileText } from 'lucide-react';
import type { NavigateFunction } from 'react-router';
import { t } from '../i18n';
import { useUiStore } from './ui-store';

const pageTreeCollapseHandlers = new Map<string, () => void>();

/** Requests that the mounted page tree for a workspace collapse its expanded pages. */
export function requestCollapseAllPages(workspaceId: string): void {
  pageTreeCollapseHandlers.get(workspaceId)?.();
}

/** Registers the page tree's collapse handler and returns its cleanup function. */
export function registerPageTreeCollapseHandler(
  workspaceId: string,
  handler: () => void,
): () => void {
  pageTreeCollapseHandlers.set(workspaceId, handler);
  return () => {
    if (pageTreeCollapseHandlers.get(workspaceId) === handler) {
      pageTreeCollapseHandlers.delete(workspaceId);
    }
  };
}

/** The title to display: the page's title, or "Untitled". */
export function displayTitle(page: Pick<PageMeta, 'title'> | undefined | null): string {
  return page?.title.trim() ? page.title : t('untitled');
}

/** A page's emoji icon, or a default icon for its kind. */
export function PageIcon({
  page,
  className,
}: {
  page: Pick<PageMeta, 'icon' | 'kind'>;
  className?: string;
}) {
  if (page.icon) {
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
  const Icon = page.kind === 'database' ? Database : FileText;
  return <Icon aria-hidden="true" className={cn('size-4 shrink-0 text-fg-subtle', className)} />;
}

/**
 * True when the server gave this device a read-only connection (the viewer role). Edits would
 * stay on this device, so the shell makes pages read-only and hides actions that change the tree.
 */
export function useViewOnly(): boolean {
  const ctx = useAppContext();
  return useSyncStatus(ctx.services.syncProvider).readOnly === true;
}

/** Moves a page to the trash and offers Undo in a toast. */
export function trashWithUndo(ctx: AppContext, pageId: string): void {
  const page = ctx.workspace.getPage(pageId);
  if (!page) return;
  ctx.workspace.trashPage(pageId);
  toast({
    title: t('movedToTrash', { title: displayTitle(page) }),
    action: { label: t('undo'), onClick: () => ctx.workspace.restorePage(pageId) },
  });
}

/** An absolute link to a page (for "Copy link"). */
export function pageUrl(pageId: string): string {
  return `${window.location.origin}/p/${encodeURIComponent(pageId)}`;
}

/** Runs a workspace operation, turning errors into a toast instead of a crash. */
export function attempt(action: () => void, message: string = t('cantMoveThere')): boolean {
  try {
    action();
    return true;
  } catch (error) {
    toast({
      variant: 'error',
      title: message,
      description: error instanceof Error ? error.message : undefined,
    });
    return false;
  }
}

/** Creates a page (top level or inside `parentId`), opens it and focuses its title. */
export function createPageAndOpen(
  ctx: AppContext,
  navigate: NavigateFunction,
  parentId: string | null = null,
): void {
  const page = ctx.workspace.createPage({ parentId });
  void navigate(`/p/${page.id}`, { state: { focusTitle: true } });
  useUiStore.getState().setDrawerOpen(false);
}
