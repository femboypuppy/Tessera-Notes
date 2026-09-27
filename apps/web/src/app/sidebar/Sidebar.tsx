import { COMMANDS, formatShortcut, SETTING_KEYS } from '@tessera/core';
import {
  sameItems,
  useAppContext,
  useCommands,
  useContributions,
  usePagesSelector,
} from '@tessera/core/react';
import {
  cn,
  FeatureBoundary,
  IconButton,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarItem,
  SidebarRoot,
  SidebarSection,
  sidebarItemClass,
} from '@tessera/ui';
import { ChevronsLeft, Plus, Search, Settings, SquarePen, Trash2 } from 'lucide-react';
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { t } from '../../i18n';
import { displayTitle, PageIcon, createPageAndOpen, useViewOnly } from '../page-helpers';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useUiStore } from '../ui-store';
import { PageTree } from './PageTree';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

function Favorites() {
  const ctx = useAppContext();
  const currentPageId = useUiStore((state) => state.currentPageId);
  const favorites = usePagesSelector((pages) => pages.favorites(), sameItems);
  if (favorites.length === 0) return null;
  return (
    <SidebarSection title={t('favorites')} collapsible>
      {favorites.map((page) => (
        <button
          key={page.id}
          type="button"
          data-active={page.id === currentPageId || undefined}
          aria-current={page.id === currentPageId ? 'page' : undefined}
          onClick={() => ctx.navigate(page.id)}
          className={cn(sidebarItemClass, 'w-full text-left')}
        >
          <PageIcon page={page} />
          <span className="min-w-0 flex-1 truncate">{displayTitle(page)}</span>
        </button>
      ))}
    </SidebarSection>
  );
}

function ContributedSections({ position }: { position: 'top' | 'bottom' }) {
  const sections = useContributions('sidebarSections').filter(
    (section) => (section.position ?? 'top') === position,
  );
  return (
    <>
      {sections.map((section) => {
        const Component = section.component;
        return (
          <FeatureBoundary
            key={`${section.featureId}:${section.id}`}
            featureId={section.featureId}
            className="my-2"
          >
            <Component />
          </FeatureBoundary>
        );
      })}
    </>
  );
}

function ResizeHandle() {
  const ctx = useAppContext();
  const width = useUiStore((state) => state.sidebarWidth);
  const setWidth = useUiStore((state) => state.setSidebarWidth);
  const start = useRef<{ x: number; width: number } | null>(null);
  const persist = () =>
    ctx.settings.device.set(SETTING_KEYS.sidebarWidth, useUiStore.getState().sidebarWidth);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    start.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current) setWidth(start.current.width + event.clientX - start.current.x);
  };
  const onPointerUp = () => {
    if (!start.current) return;
    start.current = null;
    persist();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setWidth(width + (event.key === 'ArrowRight' ? step : -step));
      persist();
    }
  };
  // A focusable separator with a value is the ARIA "window splitter" widget; jsx-a11y treats every
  // separator as static content, so its two interaction rules are disabled for this element only.
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- ARIA window splitter pattern (focusable separator)
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('resizeSidebar')}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- ARIA window splitter pattern (focusable separator)
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-border-strong focus-visible:after:bg-accent"
    />
  );
}

/** The app sidebar: workspace switcher, search, favorites, the page tree, trash and settings. */
export function Sidebar({ resizable = false }: { resizable?: boolean }) {
  const ctx = useAppContext();
  const navigate = useNavigate();
  const location = useLocation();
  const width = useUiStore((state) => state.sidebarWidth);
  const commands = useCommands();
  const hasPalette = commands.some((command) => command.id === COMMANDS.openPalette);
  const isApple = ctx.platform.isApple;
  const viewOnly = useViewOnly();
  const closeSidebar = () => {
    if (resizable) {
      useUiStore.getState().setSidebarOpen(false);
      ctx.settings.device.set(SETTING_KEYS.sidebarOpen, false);
    } else {
      useUiStore.getState().setDrawerOpen(false);
    }
  };
  return (
    <div
      className="relative h-full shrink-0 border-r border-border"
      style={resizable ? { width } : { width: '100%' }}
    >
      <SidebarRoot aria-label={t('sidebar')}>
        <SidebarHeader>
          <div className="flex items-center gap-1">
            <WorkspaceSwitcher />
            <IconButton
              label={t('collapseSidebar')}
              icon={<ChevronsLeft />}
              shortcut={formatShortcut('Mod+\\', isApple)}
              onClick={closeSidebar}
            />
          </div>
          {hasPalette ? (
            <SidebarItem
              icon={<Search />}
              label={t('search')}
              shortcut={formatShortcut('Mod+K', isApple)}
              onClick={() => void ctx.commands.execute(COMMANDS.openPalette, { source: 'menu' })}
            />
          ) : null}
          {viewOnly ? null : (
            <SidebarItem
              icon={<SquarePen />}
              label={t('newPage')}
              shortcut={formatShortcut(ctx.platform.isDesktopApp ? 'Mod+N' : 'Mod+Alt+N', isApple)}
              onClick={() => createPageAndOpen(ctx, navigate)}
            />
          )}
        </SidebarHeader>
        <SidebarContent>
          <ContributedSections position="top" />
          <Favorites />
          <SidebarSection
            title={t('pages')}
            action={
              viewOnly ? undefined : (
                <IconButton
                  size="sm"
                  label={t('newPage')}
                  icon={<Plus />}
                  onClick={() => createPageAndOpen(ctx, navigate)}
                />
              )
            }
          >
            <PageTree />
          </SidebarSection>
          <ContributedSections position="bottom" />
        </SidebarContent>
        <SidebarFooter>
          <SidebarItem
            icon={<Trash2 />}
            label={t('trash')}
            active={location.pathname === '/trash'}
            onClick={() => ctx.navigateTo('/trash')}
          />
          <SidebarItem
            icon={<Settings />}
            label={t('settings')}
            active={location.pathname.startsWith('/settings')}
            shortcut={formatShortcut('Mod+,', isApple)}
            onClick={() => ctx.navigateTo('/settings')}
          />
        </SidebarFooter>
      </SidebarRoot>
      {resizable ? <ResizeHandle /> : null}
    </div>
  );
}
