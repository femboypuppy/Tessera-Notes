import { expect, test } from '@playwright/test';
import { createPage, createWorkspace, pageTree, treeOutline } from './helpers';

test.beforeEach(async ({ page }) => {
  await createWorkspace(page, 'Garden');
  for (const title of ['Alpha', 'Beta', 'Gamma']) await createPage(page, title);
  await expect.poll(() => treeOutline(page)).toEqual(['Alpha:1', 'Beta:1', 'Gamma:1']);
});

test('nests and reorders pages by dragging', async ({ page }) => {
  const tree = pageTree(page);
  const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });

  // Onto the middle of a row: nest inside it (the parent expands).
  await row('Gamma').dragTo(row('Alpha'));
  await expect.poll(() => treeOutline(page)).toEqual(['Alpha:1', 'Gamma:2', 'Beta:1']);
  await expect(row('Alpha')).toHaveAttribute('aria-expanded', 'true');

  // Onto the top edge of a row: place before it.
  const alphaBox = await row('Alpha').boundingBox();
  if (!alphaBox) throw new Error('Alpha row is not visible');
  await row('Beta').dragTo(row('Alpha'), { targetPosition: { x: alphaBox.width / 2, y: 2 } });
  await expect.poll(() => treeOutline(page)).toEqual(['Beta:1', 'Alpha:1', 'Gamma:2']);

  // Below the last row: back to the end of the top level.
  await row('Gamma').dragTo(tree.getByTestId('page-tree-root-drop'));
  await expect.poll(() => treeOutline(page)).toEqual(['Beta:1', 'Alpha:1', 'Gamma:1']);

  // A page can't be dropped inside its own subtree.
  await row('Gamma').dragTo(row('Alpha'));
  await expect.poll(() => treeOutline(page)).toEqual(['Beta:1', 'Alpha:1', 'Gamma:2']);
  await row('Alpha').dragTo(row('Gamma'));
  await expect.poll(() => treeOutline(page)).toEqual(['Beta:1', 'Alpha:1', 'Gamma:2']);
});

test('nests, un-nests and reorders pages from the keyboard', async ({ page }) => {
  const tree = pageTree(page);
  const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });

  await row('Beta').focus();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect.poll(() => treeOutline(page)).toEqual(['Alpha:1', 'Beta:2', 'Gamma:1']);
  await expect(row('Beta')).toBeFocused();

  await page.keyboard.press('Alt+Shift+ArrowLeft');
  await expect.poll(() => treeOutline(page)).toEqual(['Alpha:1', 'Beta:1', 'Gamma:1']);

  await page.keyboard.press('Alt+Shift+ArrowUp');
  await expect.poll(() => treeOutline(page)).toEqual(['Beta:1', 'Alpha:1', 'Gamma:1']);
  await expect(row('Beta')).toBeFocused();

  await page.keyboard.press('Alt+Shift+ArrowDown');
  await page.keyboard.press('Alt+Shift+ArrowDown');
  await expect.poll(() => treeOutline(page)).toEqual(['Alpha:1', 'Gamma:1', 'Beta:1']);

  // Arrows move focus, Enter opens.
  await page.keyboard.press('ArrowUp');
  await expect(row('Gamma')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Gamma');
});

test('collapses every expanded level from the Pages section', async ({ page }) => {
  await createPage(page, 'Delta');
  const tree = pageTree(page);
  const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });

  await row('Gamma').dragTo(row('Alpha'));
  await expect.poll(() => treeOutline(page)).toEqual(['Alpha:1', 'Gamma:2', 'Beta:1', 'Delta:1']);
  await row('Beta').dragTo(row('Gamma'));
  await expect.poll(() => treeOutline(page)).toEqual(['Alpha:1', 'Gamma:2', 'Beta:3', 'Delta:1']);

  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect.poll(() => treeOutline(page)).toEqual(['Alpha:1', 'Delta:1']);
  await expect(row('Alpha')).toHaveAttribute('aria-expanded', 'false');
});

test('moves pages from the row menu', async ({ page }) => {
  const tree = pageTree(page);
  const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });

  await row('Gamma').hover();
  await row('Gamma').getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Move into the page above' }).click();
  await expect.poll(() => treeOutline(page)).toEqual(['Alpha:1', 'Beta:1', 'Gamma:2']);

  await row('Alpha').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move down' }).click();
  await expect.poll(() => treeOutline(page)).toEqual(['Beta:1', 'Gamma:2', 'Alpha:1']);
});
