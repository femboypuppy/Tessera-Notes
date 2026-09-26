// @vitest-environment jsdom
import '../testing/setup-dom';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { defineFeature } from '../runtime/feature';
import { createTestAppContext } from '../testing/index';
import {
  AppContextProvider,
  useAncestors,
  useAppContext,
  useCommands,
  useContributions,
  useCurrentUser,
  useDatabaseDoc,
  useEvent,
  useOptionalAppContext,
  usePage,
  usePageDoc,
  usePagesSelector,
  usePageTree,
  sameItems,
  useSetting,
  useSyncStatus,
} from './index';

async function setup(
  features = [defineFeature({ id: 'demo', topBarItems: [{ id: 'item', component: () => null }] })],
) {
  const test = await createTestAppContext({ features });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppContextProvider value={test.ctx}>{children}</AppContextProvider>
  );
  return { ...test, wrapper };
}

describe('React bindings', () => {
  it('requires a provider', () => {
    expect(() => renderHook(() => useAppContext())).toThrow('useAppContext');
    expect(renderHook(() => useOptionalAppContext()).result.current).toBeNull();
  });

  it('re-renders page consumers on changes', async () => {
    const { ctx, wrapper, dispose } = await setup();
    const parent = ctx.workspace.createPage({ title: 'Parent' });
    const child = ctx.workspace.createPage({ title: 'Child', parentId: parent.id });
    function Tree() {
      const tree = usePageTree();
      const page = usePage(child.id);
      const ancestors = useAncestors(child.id);
      return (
        <div>
          <span data-testid="roots">{tree.map((node) => node.page.title).join(',')}</span>
          <span data-testid="title">{page?.title}</span>
          <span data-testid="crumbs">{ancestors.map((p) => p.title).join('/')}</span>
        </div>
      );
    }
    render(<Tree />, { wrapper });
    expect(screen.getByTestId('roots')).toHaveTextContent('Parent');
    expect(screen.getByTestId('crumbs')).toHaveTextContent('Parent');
    act(() => {
      ctx.workspace.renamePage(child.id, 'Renamed');
      ctx.workspace.createPage({ title: 'Second' });
    });
    expect(screen.getByTestId('title')).toHaveTextContent('Renamed');
    expect(screen.getByTestId('roots')).toHaveTextContent('Parent,Second');
    await dispose();
  });

  it('re-renders a page or breadcrumbs only when they change', async () => {
    const { ctx, wrapper, dispose } = await setup();
    const parent = ctx.workspace.createPage({ title: 'Parent' });
    const child = ctx.workspace.createPage({ title: 'Child', parentId: parent.id });
    const renders = { page: 0, crumbs: 0 };
    function Title() {
      renders.page += 1;
      return <span data-testid="title">{usePage(child.id)?.title}</span>;
    }
    function Crumbs() {
      renders.crumbs += 1;
      const ancestors = useAncestors(child.id);
      return <span data-testid="crumbs">{ancestors.map((page) => page.title).join('/')}</span>;
    }
    render(
      <>
        <Title />
        <Crumbs />
      </>,
      { wrapper },
    );
    expect(renders).toEqual({ page: 1, crumbs: 1 });

    // Other pages come and go (an import adds thousands): nothing here changes.
    act(() => {
      const other = ctx.workspace.createPage({ title: 'Other' });
      ctx.workspace.createPage({ title: 'Nested', parentId: other.id });
      ctx.workspace.renamePage(other.id, 'Renamed other');
    });
    expect(renders).toEqual({ page: 1, crumbs: 1 });

    act(() => ctx.workspace.renamePage(parent.id, 'Folder'));
    expect(screen.getByTestId('crumbs')).toHaveTextContent('Folder');
    expect(renders).toEqual({ page: 1, crumbs: 2 });

    act(() => ctx.workspace.renamePage(child.id, 'Chapter'));
    expect(screen.getByTestId('title')).toHaveTextContent('Chapter');
    expect(renders).toEqual({ page: 2, crumbs: 2 });
    await dispose();
  });

  it('selects from the pages, re-rendering when the selection changes', async () => {
    const { ctx, wrapper, dispose } = await setup();
    const page = ctx.workspace.createPage({ title: 'Launch plan' });
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return {
          trashed: usePagesSelector((pages) => pages.isTrashed(page.id)),
          favorites: usePagesSelector((pages) => pages.favorites(), sameItems),
        };
      },
      { wrapper },
    );
    expect(result.current).toEqual({ trashed: false, favorites: [] });
    act(() => {
      ctx.workspace.createPage({ title: 'Other' });
      ctx.workspace.renamePage(page.id, 'Launch checklist');
    });
    expect(renders).toBe(1);

    act(() => ctx.workspace.setFavorite(page.id, true));
    expect(result.current.favorites.map((favorite) => favorite.title)).toEqual([
      'Launch checklist',
    ]);
    expect(renders).toBe(2);
    act(() => ctx.workspace.trashPage(page.id));
    expect(result.current).toEqual({ trashed: true, favorites: [] });
    expect(renders).toBe(3);
    await dispose();
  });

  it('compares lists item by item', () => {
    const page = { id: 'p' };
    expect(sameItems([page, 1, 'a'], [page, 1, 'a'])).toBe(true);
    expect(sameItems([], [])).toBe(true);
    expect(sameItems([Number.NaN], [Number.NaN])).toBe(true);
    expect(sameItems([page], [{ id: 'p' }])).toBe(false);
    expect(sameItems([1, 2], [2, 1])).toBe(false);
    expect(sameItems([1], [1, 2])).toBe(false);
  });

  it('holds doc leases while mounted', async () => {
    const { ctx, wrapper, dispose } = await setup();
    const page = ctx.workspace.createPage({ title: 'Doc' });
    const { page: database } = await ctx.workspace.createDatabase({
      title: 'DB',
      titlePropertyName: 'Name',
      viewName: 'Table',
    });
    const { result, unmount } = renderHook(
      () => ({
        page: usePageDoc(page.id),
        db: useDatabaseDoc(database.id),
        none: usePageDoc(null),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.page.loaded).toBe(true));
    await waitFor(() => expect(result.current.db.loaded).toBe(true));
    expect(result.current.page.handle?.docName).toBe(`page:${page.id}`);
    expect(result.current.none).toEqual({ handle: null, loaded: false, error: null });
    const status = renderHook(() => useSyncStatus(result.current.page.handle?.sync), { wrapper });
    expect(status.result.current).toEqual({ status: 'local' });
    unmount();
    await dispose();
  });

  it('reads and writes settings, commands, contributions, events and the user', async () => {
    const { ctx, runtime, wrapper, dispose } = await setup();
    const seen: string[] = [];
    const { result } = renderHook(
      () => {
        useEvent('page.created', ({ page }) => seen.push(page.title));
        return {
          setting: useSetting<boolean>(ctx.settings.device, 'editor.fullWidth', false),
          commands: useCommands(),
          items: useContributions('topBarItems'),
          user: useCurrentUser(),
        };
      },
      { wrapper },
    );
    expect(result.current.setting[0]).toBe(false);
    act(() => result.current.setting[1](true));
    expect(result.current.setting[0]).toBe(true);
    expect(ctx.settings.device.get('editor.fullWidth')).toBe(true);
    expect(result.current.items.map((item) => [item.id, item.featureId])).toEqual([
      ['item', 'demo'],
    ]);
    act(() => {
      ctx.commands.register({ id: 'x.y', title: 'XY', run: () => undefined });
    });
    expect(result.current.commands.map((c) => c.id)).toEqual(['x.y']);
    act(() => {
      ctx.workspace.createPage({ title: 'Evented' });
      runtime.updateCurrentUser({ name: 'Katherine' });
    });
    expect(seen).toEqual(['Evented']);
    expect(result.current.user.name).toBe('Katherine');
    await dispose();
  });
});
