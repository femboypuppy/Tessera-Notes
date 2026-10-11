import type { FakeTauriHandle } from '../../apps/desktop/src/testing/fake-tauri';
import { createPage, createWorkspace, pageTree, readDiagnostics } from '../architect/helpers';
import {
  addFolder,
  clickMenu,
  createDesktopWorkspace,
  expect,
  fakeState,
  HOME,
  queuePick,
  queueSave,
  savedText,
  test,
  useDesktop,
} from './fixtures';

const MOD = 'ControlOrMeta';

test.describe('in a browser', () => {
  test('the desktop feature stays out of the way', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Create an empty workspace' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Open a workspace folder/ })).toHaveCount(0);
    await createWorkspace(page, 'Browser only');
    const diagnostics = await readDiagnostics(page);
    expect(diagnostics?.features).toContain('desktop');
    expect(diagnostics?.services.docStore).not.toBe('tauri-sqlite');
    expect(diagnostics?.contributions.settingsPanels ?? []).not.toContain('desktop');
    expect(diagnostics?.commands ?? []).not.toContain('desktop.openWorkspaces');
  });
});

test.describe('the desktop app (Tauri mocked)', () => {
  test('keeps workspaces in folders that survive a restart', async ({ page }) => {
    await useDesktop(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Open a workspace folder/ })).toBeVisible();
    await createDesktopWorkspace(page, 'Apollo research');
    await createPage(page, 'Launch plan');

    const folder = `${HOME}/Tessera/Apollo research`;
    const state = await fakeState(page);
    expect(state.registry[0]).toMatchObject({ name: 'Apollo research', path: folder });
    expect(state.folders[folder]?.workspace?.name).toBe('Apollo research');
    expect(state.title).toBe('Apollo research — Tessera');
    const diagnostics = await readDiagnostics(page);
    expect(diagnostics?.services).toMatchObject({
      workspaceRegistry: 'tauri-folders',
      docStore: 'tauri-sqlite',
      assetStore: 'tauri-files',
    });

    // Quitting and starting again: everything comes back from the folder.
    await page.reload();
    await expect(pageTree(page).getByRole('treeitem', { name: 'Launch plan' })).toBeVisible();
  });

  test('sets native menus whose items run commands', async ({ page }) => {
    await useDesktop(page);
    await createDesktopWorkspace(page, 'Apollo research');
    await expect.poll(async () => (await fakeState(page)).menu).not.toBeNull();
    const menu = (await fakeState(page)).menu as { menu: Array<{ label: string }> };
    expect(menu.menu.map((submenu) => submenu.label)).toEqual([
      'File',
      'Edit',
      'View',
      'Window',
      'Help',
    ]);

    await clickMenu(page, 'desktop.openWorkspaces');
    await expect(page.getByRole('dialog', { name: 'Workspaces' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Workspaces' })).toHaveCount(0);

    // The same command from the keyboard.
    await page.keyboard.press(`${MOD}+o`);
    await expect(page.getByRole('dialog', { name: 'Workspaces' })).toBeVisible();
  });

  test('the sidebar workspace menu opens folders and the workspace picker', async ({ page }) => {
    await useDesktop(page);
    await createDesktopWorkspace(page, 'Apollo research');
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await expect(page.getByRole('menuitem', { name: 'Open folder…' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Open workspace…' }).click();
    await expect(page.getByRole('dialog', { name: 'Workspaces' })).toBeVisible();
  });

  test('Edit → Undo and Redo in the native menu reach the editor history', async ({ page }) => {
    await useDesktop(page);
    await createDesktopWorkspace(page, 'Apollo research');
    await createPage(page, 'Flight log');
    await page.getByRole('textbox', { name: 'Page title' }).press('Enter');
    const body = page.getByRole('main').locator('[contenteditable="true"]').first();
    await expect(body).toBeFocused();
    await page.keyboard.type('Liftoff at 13:32');
    await expect(body).toContainText('Liftoff at 13:32');

    // The menu item sends the shortcut to the focused editor, whose undo is Yjs-aware.
    await clickMenu(page, 'desktop.undo');
    await expect(body).not.toContainText('Liftoff');
    await clickMenu(page, 'desktop.redo');
    await expect(body).toContainText('Liftoff at 13:32');
  });

  test('opens folders, creates workspaces and switches between them', async ({ page }) => {
    await useDesktop(page);
    await createDesktopWorkspace(page, 'Apollo research');
    await addFolder(page, 'D:/Shared/Team notes', {
      workspace: { id: 'ws_team_notes', name: 'Team notes', createdAt: 1, formatVersion: 1 },
      entries: 2,
    });

    await page.keyboard.press(`${MOD}+o`);
    const picker = page.getByRole('dialog', { name: 'Workspaces' });
    await expect(picker.getByText('~/Tessera/Apollo research')).toBeVisible();
    await queuePick(page, 'D:/Shared/Team notes');
    await picker.getByRole('button', { name: 'Open folder…' }).click();
    const switcher = page.getByRole('button', { name: 'Switch workspace' });
    await expect(switcher).toContainText('Team notes');
    await expect.poll(async () => (await fakeState(page)).title).toBe('Team notes — Tessera');

    // Back to Apollo from the list, with the keyboard.
    await page.keyboard.press(`${MOD}+o`);
    const rows = picker.locator('[data-workspace-row]');
    await expect(rows).toHaveCount(2);
    await rows.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    await expect(rows.nth(1)).toContainText('Apollo research');
    await page.keyboard.press('Enter');
    await expect(switcher).toContainText('Apollo research');

    // A new workspace in a folder of its own.
    await page.keyboard.press(`${MOD}+o`);
    await picker.getByRole('button', { name: 'New workspace…' }).click();
    const form = page.getByRole('dialog', { name: 'New workspace' });
    await form.getByLabel('Name').fill('Personal');
    await expect(form.getByText('Creates ~/Tessera/Personal')).toBeVisible();
    await form.getByRole('button', { name: 'Create workspace' }).click();
    await expect(switcher).toContainText('Personal');

    // Forgetting a workspace leaves its folder alone.
    await page.keyboard.press(`${MOD}+o`);
    await picker.getByRole('button', { name: 'Actions for Team notes' }).click();
    await page.getByRole('menuitem', { name: 'Remove from list' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove from list' }).click();
    await expect(picker.getByText('Team notes')).toHaveCount(0);
    const state = await fakeState(page);
    expect(state.registry.map((entry) => entry.name)).not.toContain('Team notes');
    expect(state.folders['D:/Shared/Team notes']?.workspace?.name).toBe('Team notes');
  });

  test('warns about synced folders and merges conflicted copies back', async ({ page }) => {
    await useDesktop(page);
    await createDesktopWorkspace(page, 'Apollo research');
    const folder = `${HOME}/Dropbox/Notes`;
    await addFolder(page, folder, { entries: 3 });

    // File → Open folder…, and the native dialog answers with a folder inside Dropbox.
    await queuePick(page, folder);
    await clickMenu(page, 'desktop.openFolder');
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Use “Notes” as a workspace?');
    await confirm.getByRole('button', { name: 'Use this folder' }).click();
    await expect(confirm).toContainText('This folder is synced by Dropbox');
    await confirm.getByRole('button', { name: 'Use it anyway' }).click();
    await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('Notes');

    // Create something so the folder exists, then let "Dropbox" leave a conflicted copy.
    await createPage(page, 'Field notes');
    await page.evaluate((path) => {
      const hooks = (window as unknown as { __fakeTauri: FakeTauriHandle }).__fakeTauri;
      const entry = hooks.state.folders[path];
      if (entry) entry.conflicts = ['tessera (Ada’s conflicted copy 2026-09-20).db'];
      hooks.save();
    }, folder);

    await page.goto('/settings/desktop');
    await expect(page.getByText('Synced by Dropbox').first()).toBeVisible();
    const conflicts = page.getByRole('alert').filter({ hasText: 'Conflicting copies found' });
    await expect(conflicts).toContainText('tessera (Ada’s conflicted copy 2026-09-20).db');
    await conflicts.getByRole('button', { name: 'Merge' }).click();
    await expect(
      page.getByText('Merged tessera (Ada’s conflicted copy 2026-09-20).db', { exact: true }),
    ).toBeVisible();
    await expect.poll(async () => (await fakeState(page)).folders[folder]?.conflicts).toEqual([]);
  });

  test('quick capture appends to the Inbox, live in the main window', async ({ page, context }) => {
    await useDesktop(page);
    await createDesktopWorkspace(page, 'Apollo research');

    const capture = await context.newPage();
    await useDesktop(capture, { windowLabel: 'capture' });
    await capture.setViewportSize({ width: 600, height: 300 });
    await capture.goto('/capture');
    const field = capture.getByRole('textbox', { name: 'Quick capture' });
    await expect(field).toBeFocused();
    await expect(capture.getByText('Into Inbox · Apollo research')).toBeVisible();
    await field.fill('Call the machine shop about the heat shield\n[ ] order new tiles');
    await field.press('Enter');
    await expect(capture.getByText('Added to Inbox')).toBeVisible();
    await expect(field).toHaveValue('');

    // Written by the capture window, relayed to the main window's open workspace.
    await expect(pageTree(page).getByRole('treeitem', { name: 'Inbox' })).toBeVisible();

    // The main window opens another workspace: quick capture follows it.
    await page.keyboard.press(`${MOD}+o`);
    await page.getByRole('button', { name: 'New workspace…' }).click();
    await page.getByRole('dialog', { name: 'New workspace' }).getByLabel('Name').fill('Personal');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('Personal');
    await expect(capture.getByText('Into Inbox · Personal')).toBeVisible();
    await expect(capture).toHaveURL(/\/capture$/);
    await capture.close();
  });

  test('opens pages from tessera:// links', async ({ page }) => {
    await useDesktop(page);
    await createDesktopWorkspace(page, 'Apollo research');
    await createPage(page, 'Mission checklist');
    const pageId = new URL(page.url()).pathname.split('/').pop() ?? '';
    await createPage(page, 'Crew roster');
    await expect(page).not.toHaveURL(new RegExp(pageId));
    await page.evaluate(
      (id) =>
        (window as unknown as { __fakeTauri: FakeTauriHandle }).__fakeTauri.queueLink({
          pageId: id,
        }),
      pageId,
    );
    await expect(page).toHaveURL(new RegExp(`/p/${pageId}$`));
  });

  test('exports save through the native dialog and printing uses the webview', async ({
    page,
  }) => {
    // Webviews ignore downloads and (WKWebView) `window.print()`: neither may be used here.
    await page.addInitScript(() => {
      const state = window as unknown as { browserPrints: number };
      state.browserPrints = 0;
      window.print = () => {
        state.browserPrints += 1;
      };
    });
    const downloads: string[] = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    await useDesktop(page);
    await createDesktopWorkspace(page, 'Apollo research');
    await createPage(page, 'Launch plan');
    await page.getByRole('textbox', { name: 'Page title' }).press('Enter');
    const body = page.getByRole('main').locator('[contenteditable="true"]').first();
    await expect(body).toBeFocused();
    await page.keyboard.type('T-minus 10 and holding');
    await expect(body).toContainText('T-minus 10 and holding');

    // Markdown: the native save dialog suggests the file name, and the file lands where chosen.
    const target = `${HOME}/Documents/Launch plan.md`;
    await queueSave(page, target);
    await page.getByRole('button', { name: 'Export page' }).click();
    const exportDialog = page.getByRole('dialog', { name: 'Export' });
    await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
    const done = page.getByRole('dialog', { name: 'Export ready' });
    await expect(done).toContainText(`saved to ${target}`);
    const state = await fakeState(page);
    expect(state.saveDialogs).toEqual([
      { title: 'Save as', name: 'Launch plan.md', filter: 'MD file' },
    ]);
    await expect.poll(() => savedText(page, target)).toContain('T-minus 10 and holding');

    // Cancelling a second save writes nothing and says so.
    await queueSave(page, null);
    await done.getByRole('button', { name: 'Save as…' }).click();
    await expect(done).toContainText('Launch plan.md was not saved');
    expect(Object.keys((await fakeState(page)).savedFiles)).toEqual([target]);
    await done.getByRole('button', { name: 'Done' }).click();

    // PDF: the print view opens the webview's print dialog, and so does its Print button.
    await page.getByRole('button', { name: 'Export page' }).click();
    await exportDialog.getByRole('radio', { name: /^PDF/ }).click();
    await exportDialog.getByRole('button', { name: 'Open print view' }).click();
    await expect(page.getByTestId('print-page').getByRole('heading', { level: 1 })).toHaveText(
      'Launch plan',
    );
    await expect.poll(async () => (await fakeState(page)).printed).toBe(1);
    await page.getByRole('button', { name: 'Print or save as PDF' }).click();
    await expect.poll(async () => (await fakeState(page)).printed).toBe(2);

    expect(
      await page.evaluate(() => (window as unknown as { browserPrints: number }).browserPrints),
    ).toBe(0);
    expect(downloads).toEqual([]);
  });

  test('Desktop settings control the folder, the mirror, quick capture and the tray', async ({
    page,
  }) => {
    await useDesktop(page);
    await createDesktopWorkspace(page, 'Apollo research');
    await createPage(page, 'Launch plan');
    await page.goto('/settings/desktop');
    await expect(page.getByRole('heading', { name: 'Desktop', level: 2 })).toBeVisible();
    await expect(page.getByText(`${HOME}/Tessera/Apollo research`)).toBeVisible();

    await page
      .getByRole('button', { name: /^(Show in Explorer|Show in file manager|Reveal in Finder)$/ })
      .click();
    await expect
      .poll(async () => (await fakeState(page)).revealed)
      .toEqual([`${HOME}/Tessera/Apollo research`]);

    await page.getByRole('switch', { name: 'Keep a markdown copy of every page' }).click();
    await expect
      .poll(async () => Object.keys((await fakeState(page)).mirror).length)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => Object.values((await fakeState(page)).mirror).flatMap(Object.keys))
      .toContain('Launch plan.md');
    await expect(page.getByText(/Updated .* · 1 file/)).toBeVisible();

    const tray = page.getByRole('switch', {
      name: 'Keep running in the background when the window is closed',
    });
    await expect(tray).toBeChecked();
    await tray.click();
    await expect(tray).not.toBeChecked();
    await expect
      .poll(async () => (await fakeState(page)).prefs)
      .toMatchObject({ closeToTray: false });

    await page.getByRole('button', { name: 'Change' }).click();
    await expect(page.getByText('Press the new shortcut…')).toBeVisible();
    await page.keyboard.press('Control+Alt+K');
    await expect
      .poll(async () => (await fakeState(page)).prefs)
      .toMatchObject({ captureShortcut: 'CommandOrControl+Alt+K' });
    await expect(page.getByRole('button', { name: 'Change' })).toBeVisible();
  });
});
