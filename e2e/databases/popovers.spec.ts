import { expect, test } from '@playwright/test';
import { addProperty, addRow, choose, newDatabase, openWorkspace, pasteIntoGrid } from './helpers';

/**
 * Escape closes one layer per press, even while the layer above is still playing its exit
 * animation (about 150 ms): the closing layer used to swallow the second press (#8).
 */
test('two quick Escapes close a nested popover and the panel under it', async ({ page }) => {
  await openWorkspace(page);
  await newDatabase(page, 'Reading list');
  await addProperty(page, 'Select', 'Status');
  await addRow(page, 'Dune');
  await pasteIntoGrid(page, [
    ['Dune', 'Reading'],
    ['Solaris', 'Finished'],
  ]);
  await expect(page.getByText('2 rows', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('button', { name: 'Add a filter rule' }).click();
  await choose(page, page.getByRole('combobox', { name: 'Property' }), 'Status');
  await page.getByRole('button', { name: 'Value' }).click();
  const picker = page.getByRole('option', { name: 'Reading' });
  await expect(picker).toBeVisible();

  // Both presses land while the picker is still animating out.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add a filter rule' })).toBeHidden();

  // And a single press still closes just one layer.
  await page.getByRole('button', { name: '1 filter', exact: true }).click();
  await page.getByRole('button', { name: 'Value' }).click();
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add a filter rule' })).toBeVisible();
});
