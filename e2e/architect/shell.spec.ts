import { expect, test } from '@playwright/test';
import { createPage, createWorkspace, pageTree, readDiagnostics } from './helpers';

test('switches theme with the shortcut and from settings, and remembers it', async ({ page }) => {
  const sidebar = await createWorkspace(page, 'Themes');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.keyboard.press('ControlOrMeta+Shift+L');
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await sidebar.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('radio', { name: /Dark/ })).toBeChecked();
  await page.getByRole('radio', { name: /Light/ }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.getByRole('radio', { name: /Dark/ }).click();

  // The theme is a device setting: it survives a reload, before the app script runs.
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('follows the system theme by default', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await createWorkspace(page, 'System');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('shows the keyboard shortcuts overlay', async ({ page }) => {
  await createWorkspace(page, 'Keys');
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText([
    'Navigation',
    'Page',
    'View',
    'Help',
  ]);
  await expect(dialog).toContainText('Toggle dark mode');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Typing "?" in a text field types it.
  await createPage(page, 'Why?');
  await expect(dialog).toBeHidden();
});

test('creates pages and toggles the sidebar from the keyboard', async ({ page }) => {
  const sidebar = await createWorkspace(page, 'Shortcuts');
  await page.keyboard.press('ControlOrMeta+Alt+N');
  const title = page.getByRole('textbox', { name: 'Page title' });
  await expect(title).toBeFocused();
  await page.keyboard.type('Made from the keyboard');
  await expect(
    pageTree(page).getByRole('treeitem', { name: 'Made from the keyboard' }),
  ).toBeVisible();

  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(sidebar).toBeHidden();
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(sidebar).toBeVisible();

  await sidebar.getByRole('button', { name: 'Close sidebar' }).click();
  await expect(sidebar).toBeHidden();
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await expect(sidebar).toBeVisible();
});

test('adds an icon, a cover and a favorite', async ({ page }) => {
  const sidebar = await createWorkspace(page, 'Decor');
  await createPage(page, 'Apollo program');

  await page.getByRole('textbox', { name: 'Page title' }).hover();
  await page.getByRole('button', { name: 'Add icon' }).click();
  await page.getByRole('searchbox', { name: 'Search emoji' }).fill('rocket');
  await page.getByRole('button', { name: 'rocket', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Change icon' })).toHaveText('🚀');

  await page.getByRole('textbox', { name: 'Page title' }).hover();
  await page.getByRole('button', { name: 'Add cover' }).click();
  await expect(page.getByRole('button', { name: 'Change cover' })).toBeAttached();

  await page.getByRole('button', { name: 'Add to favorites' }).click();
  const favorites = sidebar.getByRole('button', { name: 'Favorites' });
  await expect(favorites).toBeVisible();
  await expect(sidebar.getByRole('button', { name: /Apollo program/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove from favorites' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('publishes diagnostics for tests and bug reports', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create an empty workspace' })).toBeVisible();
  expect(await readDiagnostics(page)).toBeNull();

  await createWorkspace(page, 'Diagnostics');
  const diagnostics = await readDiagnostics(page);
  expect(diagnostics?.features).toEqual([
    'editor',
    'sync',
    'databases',
    'search',
    'graph',
    'backlinks',
    'plugins',
    'import-export',
    'desktop',
  ]);
  expect(diagnostics?.failedFeatures).toEqual([]);
  expect(diagnostics?.commands).toEqual(
    expect.arrayContaining(['shell.newPage', 'shell.toggleTheme']),
  );
  expect(Object.keys(diagnostics?.services ?? {}).sort()).toEqual([
    'assetStore',
    'credentialStore',
    'docStore',
    'fileSaver',
    'linkIndex',
    'markdownCodec',
    'searchIndex',
    'syncProvider',
    'workspaceRegistry',
  ]);
});

test('isolates a crashing feature', async ({ page }) => {
  await page.goto('/dev/ui');
  await expect(page.getByRole('heading', { name: '@tessera/ui' })).toBeVisible();
  await page.getByRole('button', { name: 'Crash a feature' }).click();
  await expect(page.getByText('Something went wrong here')).toBeVisible();
  // The rest of the page still works.
  await page.getByRole('button', { name: 'Open dialog' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('uses a drawer for the sidebar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an empty workspace' }).click();
    await expect(page.getByText('Your workspace is empty')).toBeVisible();
    const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
    await expect(sidebar).toBeHidden();

    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole('button', { name: 'New page', exact: true }).first().click();
    // Opening a page closes the drawer.
    await expect(sidebar).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Page title' })).toBeFocused();
    await page.keyboard.type('Pocket notes');

    // Escape closes the drawer; so does its close button, which returns focus to the menu button.
    const openSidebar = page.getByRole('button', { name: 'Open sidebar' });
    await openSidebar.click();
    await expect(pageTree(page).getByRole('treeitem', { name: 'Pocket notes' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sidebar).toBeHidden();
    await openSidebar.click();
    await sidebar.getByRole('button', { name: 'Close sidebar' }).click();
    await expect(sidebar).toBeHidden();
    await expect(openSidebar).toBeFocused();
  });
});
