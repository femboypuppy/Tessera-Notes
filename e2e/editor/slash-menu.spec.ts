import { expect, test, type Page } from '@playwright/test';
import {
  createPage,
  createWorkspace,
  docJSON,
  editor,
  findNodes,
  outline,
  redo,
  slash,
  undo,
} from './helpers';
import { PNG_ROCKET } from './fixtures';

/** Leaves the current container (toggle, quote, list…) by clicking under the last block. */
async function continueBelow(page: Page): Promise<void> {
  await page.locator('.tess-editor-tail').click();
  await expect(editor(page)).toBeFocused();
}

test('inserts every block type from the slash menu', async ({ page }) => {
  // One long flow (every block type, then undo and redo across all of them).
  test.setTimeout(90_000);
  await createWorkspace(page);
  await createPage(page, 'Mission control');
  await page.keyboard.type('The control room.');
  await createPage(page, 'Every block');
  const type = (text: string) => page.keyboard.type(text);
  const enter = () => page.keyboard.press('Enter');

  await slash(page, 'text');
  await type('Plain text');
  await enter();
  await slash(page, 'heading 1');
  await type('Heading one');
  await enter();
  await slash(page, 'heading 2');
  await type('Heading two');
  await enter();
  await slash(page, 'heading 3');
  await type('Heading three');
  await enter();
  await slash(page, 'bulleted');
  await type('Bullet');
  await enter();
  await enter();
  await slash(page, 'numbered');
  await type('Number');
  await enter();
  await enter();
  await slash(page, 'to-do');
  await type('Task');
  await enter();
  await enter();
  await slash(page, 'toggle');
  await type('Toggle title');
  await enter();
  await type('Inside the toggle');
  await continueBelow(page);
  await slash(page, 'quote');
  await type('Quoted');
  await continueBelow(page);
  await slash(page, 'callout');
  await type('Called out');
  await continueBelow(page);
  await slash(page, 'date');
  await enter();
  await continueBelow(page);
  await slash(page, 'divider');
  await slash(page, 'code');
  await type('let x = 1');
  await continueBelow(page);

  // Table: the size picker inserts a 3 × 3 table with a header row by default.
  await slash(page, 'table');
  const tablePicker = page.getByRole('grid', { name: /Insert table/ });
  await expect(tablePicker).toBeVisible();
  await page.keyboard.press('Enter');
  await type('Cell');
  await continueBelow(page);

  // Image: uploaded through the asset store.
  await slash(page, 'image');
  await page.getByLabel('Choose an image').setInputFiles({
    name: 'rocket.png',
    mimeType: 'image/png',
    buffer: PNG_ROCKET,
  });
  await expect(editor(page).locator('.tess-image img')).toBeVisible();
  await continueBelow(page);

  // Embed and bookmark: a link typed into the prompt.
  await slash(page, 'embed');
  await page
    .getByRole('textbox', { name: 'Paste a link to embed…' })
    .fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.keyboard.press('Enter');
  await expect(editor(page).locator('iframe[title="YouTube embed"]')).toBeAttached();
  await continueBelow(page);
  await slash(page, 'bookmark');
  await page
    .getByRole('textbox', { name: 'Paste a link to bookmark…' })
    .fill('https://tessera.dev/docs');
  await page.keyboard.press('Enter');
  await expect(editor(page).locator('.tess-bookmark')).toBeVisible();
  await continueBelow(page);

  // Link to page: opens the page autocomplete.
  await slash(page, 'link to page');
  await expect(page.getByRole('listbox', { name: 'Link to a page' })).toBeVisible();
  await type('Missi');
  await page.keyboard.press('Enter');
  await expect(editor(page).locator('.tess-page-link')).toHaveText('Mission control');

  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date()),
  );
  await expect
    .poll(() => outline(page))
    .toEqual([
      'paragraph:Plain text',
      'heading:Heading one',
      'heading:Heading two',
      'heading:Heading three',
      'bulletList:Bullet',
      'orderedList:Number',
      'taskList:Task',
      'toggle:Toggle titleInside the toggle',
      'blockquote:Quoted',
      'callout:Called out',
      `paragraph:${today}`,
      'horizontalRule:',
      'codeBlock:let x = 1',
      'table:Cell',
      'image:',
      'embed:',
      'embed:',
      'paragraph:[link] ',
    ]);
  const doc = await docJSON(page);
  expect(findNodes(doc, 'heading').map((node) => node.attrs?.level)).toEqual([1, 2, 3]);
  expect(findNodes(doc, 'image')[0]?.attrs?.assetId).toEqual(expect.any(String));
  expect(
    findNodes(doc, 'embed').map((node) => (node.attrs?.data as { display?: string }).display),
  ).toEqual(['embed', 'bookmark']);
  expect(findNodes(doc, 'tableHeader')).toHaveLength(3);

  // Undo takes the last insertions back, redo restores them exactly.
  const final = await outline(page);
  await undo(page, 3);
  await expect.poll(async () => (await outline(page)).length).toBeLessThan(final.length);
  await redo(page, 3);
  await expect.poll(() => outline(page)).toEqual(final);
});

test('the slash menu is fully keyboard driven', async ({ page }) => {
  await createWorkspace(page);
  await createPage(page, 'Keyboard menu');
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox', { name: 'Insert a block' });
  await expect(menu).toBeVisible();
  // The editor points at the active option.
  const firstId = await menu.getByRole('option').first().getAttribute('id');
  await expect(editor(page)).toHaveAttribute('aria-activedescendant', firstId ?? '');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('option', { selected: true })).toContainText('Heading 2');
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('option', { selected: true })).toContainText('Heading 1');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(editor(page)).not.toHaveAttribute('aria-activedescendant', /.+/);
  // Filtering, then Enter.
  await page.keyboard.press('Backspace');
  await page.keyboard.type('/tgl');
  await expect(menu.getByRole('option').first()).toContainText('Toggle');
  await page.keyboard.press('Enter');
  await expect.poll(() => outline(page)).toEqual(['toggle:']);
});
