import type { DocHandle } from '@tessera/core';
import { AppContextProvider } from '@tessera/core/react';
import { createTestAppContext, type TestAppContext } from '@tessera/core/testing';
import { TooltipProvider } from '@tessera/ui';
import { act, render, screen, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDatabaseProperty, addRow, createDatabase, setCell } from '../model/operations';
import { DatabaseView } from './database-view';

let app: TestAppContext | null = null;
const handles: DocHandle[] = [];

beforeEach(() => {
  // jsdom lays nothing out; give elements a size so the virtualized table renders its rows.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) handle.release();
  await app?.dispose();
  app = null;
});

describe('DatabaseView', () => {
  it('re-renders only when its rows or the pages they relate to change', async () => {
    app = await createTestAppContext();
    const { ctx } = app;
    const { page } = await createDatabase(ctx, { title: 'Tasks' });
    const handle = await ctx.loadDatabaseDoc(page.id);
    handles.push(handle);
    const ref = { id: page.id, doc: handle.doc };
    const owner = addDatabaseProperty(ref, { type: 'relation', name: 'Owner' });
    const ada = ctx.workspace.createPage({ title: 'Ada' });
    const row = await addRow(ctx, ref, { title: 'Write the brief' });
    await setCell(ctx, ref, row.id, owner, [ada.id]);

    let commits = 0;
    render(
      <AppContextProvider value={ctx}>
        <TooltipProvider>
          <Profiler id="database" onRender={() => (commits += 1)}>
            <DatabaseView databaseId={page.id} variant="page" readOnly={false} />
          </Profiler>
        </TooltipProvider>
      </AppContextProvider>,
    );
    const grid = await screen.findByRole('grid');
    expect(within(grid).getByText('Write the brief')).toBeInTheDocument();
    expect(within(grid).getByText('Ada')).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));

    // An import fills another part of the workspace: the table has nothing to redraw.
    commits = 0;
    act(() => {
      const folder = ctx.workspace.createPage({ title: 'Imported notes' });
      for (let index = 0; index < 25; index += 1)
        ctx.workspace.createPage({ title: `Mission log ${index}`, parentId: folder.id });
      ctx.workspace.renamePage(folder.id, 'Imported');
    });
    expect(commits).toBe(0);

    // The pages its relations point to still show as they are.
    act(() => ctx.workspace.renamePage(ada.id, 'Ada Lovelace'));
    expect(within(grid).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(commits).toBeGreaterThan(0);
    act(() => ctx.workspace.trashPage(ada.id));
    expect(within(grid).queryByText('Ada Lovelace')).not.toBeInTheDocument();
    act(() => ctx.workspace.restorePage(ada.id));
    expect(within(grid).getByText('Ada Lovelace')).toBeInTheDocument();

    // And so do its rows.
    act(() => ctx.workspace.renamePage(row.id, 'Write the launch brief'));
    expect(within(grid).getByText('Write the launch brief')).toBeInTheDocument();
  });
});
