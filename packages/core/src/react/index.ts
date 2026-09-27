/**
 * React bindings for the core contracts. Import from `@tessera/core/react`.
 *
 * @example
 * function Breadcrumbs({ pageId }: { pageId: string }) {
 *   const ancestors = useAncestors(pageId);
 *   return ancestors.map((page) => <span key={page.id}>{page.title}</span>);
 * }
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/with-selector';
import type { JsonValue } from '../json';
import type { PageTreeNode } from '../model/page-index';
import type { PageMeta } from '../model/page-meta';
import type { SyncHandle, SyncStatusInfo } from '../services/sync-provider';
import type { AppContext } from '../runtime/app-context';
import type { Command } from '../runtime/commands';
import type { DocHandle } from '../runtime/doc-manager';
import type { TesseraEvents } from '../runtime/events';
import type { Contribution, ContributionKind } from '../runtime/feature';
import type { PagesSnapshot } from '../runtime/pages-store';
import type { SettingsStore } from '../runtime/settings';
import type { CurrentUser } from '../runtime/user';

const AppContextReact = createContext<AppContext | null>(null);

/** Provides the {@link AppContext} of the open workspace to every feature component. */
export function AppContextProvider({
  value,
  children,
}: {
  value: AppContext;
  children?: ReactNode;
}) {
  return createElement(AppContextReact.Provider, { value }, children);
}

/** The {@link AppContext}. Throws outside a workspace. */
export function useAppContext(): AppContext {
  const ctx = useContext(AppContextReact);
  if (!ctx)
    throw new Error('useAppContext must be used inside an open workspace (AppContextProvider)');
  return ctx;
}

/** The {@link AppContext}, or null outside a workspace (onboarding, dev pages). */
export function useOptionalAppContext(): AppContext | null {
  return useContext(AppContextReact);
}

/**
 * The current pages snapshot; re-renders on every page change. Components that show a few pages
 * select them with {@link usePagesSelector} instead: an import changes the pages thousands of
 * times.
 */
export function usePages(): PagesSnapshot {
  const { workspace } = useAppContext();
  return useSyncExternalStore(
    workspace.pages.subscribe,
    workspace.pages.getSnapshot,
    workspace.pages.getSnapshot,
  );
}

/**
 * Selects from the pages snapshot and re-renders only when the selection changes, as `isEqual`
 * (default `Object.is`) compares it with the last one. Page objects keep their identity while
 * they are unchanged, so selecting pages re-renders when one of them changes, not with every
 * change to the workspace.
 *
 * @example
 * const trashed = usePagesSelector((pages) => pages.isTrashed(pageId));
 * const favorites = usePagesSelector((pages) => pages.favorites(), sameItems);
 */
export function usePagesSelector<T>(
  select: (pages: PagesSnapshot) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  const { workspace } = useAppContext();
  return useSyncExternalStoreWithSelector(
    workspace.pages.subscribe,
    workspace.pages.getSnapshot,
    workspace.pages.getSnapshot,
    select,
    isEqual,
  );
}

/** True when two lists hold the same items in the same order: `isEqual` for list selectors. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
}

const NO_PAGES: readonly PageMeta[] = [];

/** One page's metadata (undefined when it does not exist); re-renders when it changes. */
export function usePage(pageId: string | null | undefined): PageMeta | undefined {
  return usePagesSelector((pages) => (pageId ? pages.get(pageId) : undefined));
}

/** The sidebar tree (trash and database rows excluded); re-renders on every page change. */
export function usePageTree(): readonly PageTreeNode[] {
  return usePages().tree();
}

/** Ancestors of a page, root first (breadcrumbs); re-renders when one of them changes. */
export function useAncestors(pageId: string | null | undefined): readonly PageMeta[] {
  return usePagesSelector((pages) => (pageId ? pages.ancestors(pageId) : NO_PAGES), sameItems);
}

/** Result of {@link usePageDoc} and {@link useDatabaseDoc}. */
export interface DocHandleState {
  handle: DocHandle | null;
  loaded: boolean;
  error: Error | null;
}

function useDocHandle(
  acquire: ((id: string) => DocHandle) | null,
  id: string | null | undefined,
): DocHandleState {
  const [state, setState] = useState<DocHandleState>({ handle: null, loaded: false, error: null });
  useEffect(() => {
    if (!acquire || !id) {
      setState({ handle: null, loaded: false, error: null });
      return undefined;
    }
    const handle = acquire(id);
    let active = true;
    setState({ handle, loaded: handle.isLoaded, error: handle.error });
    handle.whenLoaded.then(
      () => {
        if (active) setState({ handle, loaded: true, error: null });
      },
      (error: unknown) => {
        if (active)
          setState({
            handle,
            loaded: false,
            error: error instanceof Error ? error : new Error(String(error)),
          });
      },
    );
    return () => {
      active = false;
      handle.release();
    };
  }, [acquire, id]);
  return state;
}

/**
 * Holds a lease on a page doc while the component is mounted.
 *
 * @example
 * const { handle, loaded } = usePageDoc(pageId);
 * if (!loaded || !handle) return <Skeleton />;
 */
export function usePageDoc(pageId: string | null | undefined): DocHandleState {
  const ctx = useAppContext();
  return useDocHandle(ctx.acquirePageDoc, pageId);
}

/** Holds a lease on a database doc while the component is mounted. */
export function useDatabaseDoc(databaseId: string | null | undefined): DocHandleState {
  const ctx = useAppContext();
  return useDocHandle(ctx.acquireDatabaseDoc, databaseId);
}

/** The sync status of a doc handle (or `local` when none). */
export function useSyncStatus(
  sync: Pick<SyncHandle, 'getStatus' | 'onStatus'> | null | undefined,
): SyncStatusInfo {
  const subscribe = useCallback(
    (listener: () => void) => (sync ? sync.onStatus(listener) : () => undefined),
    [sync],
  );
  const lastRef = useRef<SyncStatusInfo>({ status: 'local' });
  const get = useCallback(() => {
    const next = sync?.getStatus() ?? { status: 'local' as const };
    if (JSON.stringify(next) !== JSON.stringify(lastRef.current)) lastRef.current = next;
    return lastRef.current;
  }, [sync]);
  return useSyncExternalStore(subscribe, get, get);
}

/** Subscribes to an event while mounted. The latest handler is always used. */
export function useEvent<K extends keyof TesseraEvents>(
  type: K,
  handler: (payload: TesseraEvents[K]) => void,
): void {
  const { events } = useAppContext();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => events.on(type, (payload) => handlerRef.current(payload)), [events, type]);
}

/** Registered commands (re-renders when the registry changes). */
export function useCommands(): Command[] {
  const { commands } = useAppContext();
  const cache = useRef<{ version: number; list: Command[] }>({ version: -1, list: [] });
  const versionRef = useRef(0);
  const subscribe = useCallback(
    (listener: () => void) =>
      commands.subscribe(() => {
        versionRef.current += 1;
        listener();
      }),
    [commands],
  );
  const get = useCallback(() => {
    if (cache.current.version !== versionRef.current) {
      cache.current = { version: versionRef.current, list: commands.list() };
    }
    return cache.current.list;
  }, [commands]);
  return useSyncExternalStore(subscribe, get, get);
}

/** UI contributions of one kind (routes, panels, sections…), re-rendering on changes. */
export function useContributions<K extends ContributionKind>(
  kind: K,
): ReadonlyArray<Contribution<K>> {
  const { contributions } = useAppContext();
  const version = useSyncExternalStore(
    contributions.subscribe,
    contributions.getVersion,
    contributions.getVersion,
  );
  const cache = useRef<{ version: number; list: ReadonlyArray<Contribution<K>> } | null>(null);
  if (!cache.current || cache.current.version !== version)
    cache.current = { version, list: contributions.list(kind) };
  return cache.current.list;
}

/**
 * Reads and writes a setting, re-rendering when it changes (also from other tabs).
 *
 * @example
 * const [showFooter, setShowFooter] = useSetting(ctx.settings.workspace, 'backlinks.showFooter', false);
 */
export function useSetting<T extends JsonValue>(
  store: SettingsStore,
  key: string,
  fallback: T,
): [T, (value: T | undefined) => void] {
  const subscribe = useCallback(
    (listener: () => void) =>
      store.subscribe((changed) => {
        if (changed === key) listener();
      }),
    [store, key],
  );
  const cache = useRef<{ raw: string; value: T } | null>(null);
  const get = useCallback((): T => {
    const value = store.get(key);
    const resolved = (value === undefined ? fallback : value) as T;
    const raw = JSON.stringify(resolved);
    if (!cache.current || cache.current.raw !== raw) cache.current = { raw, value: resolved };
    return cache.current.value;
  }, [store, key, fallback]);
  const value = useSyncExternalStore(subscribe, get, get);
  const set = useCallback((next: T | undefined) => store.set(key, next), [store, key]);
  return [value, set];
}

/** The current user (re-renders when the name or color changes). */
export function useCurrentUser(): CurrentUser {
  const ctx = useAppContext();
  const [user, setUser] = useState(ctx.currentUser);
  useEffect(() => ctx.events.on('user.changed', ({ user: next }) => setUser(next)), [ctx]);
  return user;
}
