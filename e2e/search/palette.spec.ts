import { expect, test } from '@playwright/test';
import { newPage, openPalette, openWorkspace, palette, seed, whenIndexed, write } from './helpers';

test.describe('command palette', () => {
  test('opens with Mod+K, finds a page by title and opens it', async ({ page }) => {
    await openWorkspace(page);
    await seed(page, 40, 3);
    await openPalette(page);
    const dialog = palette(page);
    await page.keyboard.type('europa');
    const option = dialog.getByRole('option', { name: /^Europa/ }).first();
    await expect(option).toBeVisible();
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Europa');
  });

  test('shows full-text hits with snippets and keyboard navigation', async ({ page }) => {
    await openWorkspace(page);
    const id = await newPage(page, 'Launch checklist');
    await write(page, id, [['Fuel the booster before the rendezvous window opens.']]);
    await newPage(page, 'Rendezvous notes');
    await openPalette(page);
    await page.keyboard.type('rendezvous');
    const dialog = palette(page);
    const titleHit = dialog.getByRole('option', { name: /Rendezvous notes/ });
    const contentHit = dialog.getByRole('option', { name: /Launch checklist/ });
    await expect(titleHit).toBeVisible();
    await expect(contentHit).toContainText('Fuel the booster before the rendezvous');
    await expect(contentHit.locator('mark')).toHaveText('rendezvous');
    await page.keyboard.press('ArrowDown');
    await expect(contentHit).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Launch checklist');
  });

  test('finds a page by the new title of a page it links to', async ({ page }) => {
    await openWorkspace(page);
    const apollo = await newPage(page, 'Apollo');
    const notes = await newPage(page, 'Mission notes');
    await write(page, notes, [['Read the ', { link: apollo }, ' briefing first.']]);
    await page
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('treeitem', { name: 'Apollo' })
      .click();
    const title = page.getByRole('textbox', { name: 'Page title' });
    await expect(title).toHaveValue('Apollo');
    await title.fill('Artemis');
    await whenIndexed(page);

    await openPalette(page);
    await page.keyboard.type('artemis');
    const hit = palette(page).getByRole('option', { name: /Mission notes/ });
    await expect(hit).toContainText('Read the Artemis briefing');
    await expect(hit.locator('mark')).toHaveText('Artemis');
    await page.keyboard.press('Escape');
    await openPalette(page);
    await page.keyboard.type('apollo');
    await expect(palette(page).getByText('No results for “apollo”')).toBeVisible();
  });

  test('runs a command and shows its shortcut', async ({ page }) => {
    await openWorkspace(page);
    await openPalette(page);
    await page.keyboard.type('>dark');
    const command = palette(page).getByRole('option', { name: /Toggle dark mode/i });
    await expect(command).toBeVisible();
    await expect(command.locator('kbd').first()).toBeVisible();
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.keyboard.press('Enter');
    await expect(palette(page)).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .not.toBe(before);
  });

  test('creates a page and lists recent pages', async ({ page }) => {
    await openWorkspace(page);
    await openPalette(page);
    await page.keyboard.type('Quarterly planning');
    const create = palette(page).getByRole('option', { name: 'Create page “Quarterly planning”' });
    await create.click();
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(
      'Quarterly planning',
    );
    await openPalette(page);
    await expect(palette(page).getByRole('group', { name: 'Recent' })).toContainText(
      'Quarterly planning',
    );
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
  });

  test('never shows a page after it goes to the trash', async ({ page }) => {
    await openWorkspace(page);
    await newPage(page, 'Temporary draft');
    await openPalette(page);
    await page.keyboard.type('temporary');
    await expect(palette(page).getByRole('option', { name: /Temporary draft/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to trash' }).click();
    await expect(page.getByRole('menu')).toBeHidden();
    await openPalette(page);
    await page.keyboard.type('temporary');
    await expect(palette(page).getByText('No results for “temporary”')).toBeVisible();
    await expect(palette(page).getByRole('option', { name: /Temporary draft/ })).toHaveCount(0);
  });
});
