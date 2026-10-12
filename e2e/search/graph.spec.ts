import { expect, test, type Page } from '@playwright/test';
import { softwareWebGL } from '../support/webgl';
import { newPage, openPalette, openWorkspace, seed, whenIndexed } from './helpers';

// The graph draws with WebGL: in software on Linux CI, which has no GPU.
test.use(softwareWebGL);

interface GraphHooks {
  nodePosition(id: string): { x: number; y: number } | null;
  settled(): boolean;
}

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __tesseraGraph?: GraphHooks }).__tesseraGraph?.settled() === true,
    undefined,
    { timeout: 60_000 },
  );
}

async function nodePosition(page: Page, id: string): Promise<{ x: number; y: number }> {
  const position = await page.evaluate(
    (nodeId) =>
      (window as unknown as { __tesseraGraph?: GraphHooks }).__tesseraGraph?.nodePosition(nodeId) ??
      null,
    id,
  );
  if (!position) throw new Error(`node ${id} is not in the graph`);
  return position;
}

async function openGraph(page: Page): Promise<void> {
  await openPalette(page);
  await page.keyboard.type('>graph view');
  await page.keyboard.press('Enter');
}

test.describe('graph view', () => {
  test('renders the workspace and opens a page when its node is clicked', async ({ page }) => {
    await openWorkspace(page);
    const pages = await seed(page, 60, 5);
    // From the sidebar this time (the other specs use the palette).
    const entry = page
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: 'Graph view' });
    await entry.click();
    await expect(entry).toHaveAttribute('aria-current', 'page');
    const graph = page.getByRole('img', { name: /Graph view: 60 pages/ });
    await expect(graph).toBeVisible();
    await expect(graph.locator('canvas').first()).toBeVisible();
    await settled(page);
    await expect(
      page.getByRole('status').filter({ hasText: /60 pages · \d+ links/ }),
    ).toBeVisible();
    const target = pages.find((entry) => entry.title === 'Europa');
    if (!target) throw new Error('no Europa page');
    const { x, y } = await nodePosition(page, target.id);
    await page.mouse.click(x, y);
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Europa');
  });

  test('the search box focuses a page, and Enter opens it', async ({ page }) => {
    await openWorkspace(page);
    await seed(page, 60, 5);
    await openGraph(page);
    await settled(page);
    const search = page.getByRole('combobox', { name: 'Find a page in the graph' });
    await search.fill('tita');
    await expect(page.getByRole('option', { name: 'Titan', exact: true })).toBeVisible();
    await search.press('Enter');
    await expect(page.getByText('Focused on Titan')).toBeVisible();
    await search.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Titan');
  });

  test('filters hide orphans and limit depth around the focused page', async ({ page }) => {
    await openWorkspace(page);
    await seed(page, 60, 5);
    await newPage(page, 'A lonely page');
    await whenIndexed(page);
    await openGraph(page);
    await settled(page);
    const stats = page.getByRole('status').filter({ hasText: /pages · \d+ links/ });
    const pagesShown = async () =>
      Number(/(\d+) pages/.exec((await stats.textContent()) ?? '')?.[1]);
    await expect(stats).toContainText('61 pages');
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('switch', { name: 'Orphans' }).click();
    // The new page and any other page without links disappear.
    await expect.poll(pagesShown).toBeLessThan(61);
    await page.keyboard.press('Escape');
    const withoutOrphans = await pagesShown();
    const search = page.getByRole('combobox', { name: 'Find a page in the graph' });
    await search.fill('lonely');
    await expect(page.getByText('No page matches')).toBeVisible();
    await search.fill('');

    await search.fill('Europa');
    await page.getByRole('option', { name: 'Europa', exact: true }).click();
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('combobox', { name: 'Depth' }).click();
    await page.getByRole('option', { name: '1', exact: true }).click();
    await page.keyboard.press('Escape');
    await settled(page);
    const count = await pagesShown();
    expect(count).toBeGreaterThan(1);
    expect(count).toBeLessThan(withoutOrphans);
  });

  test('a large graph follows the pointer when dragged, and the drag is not a click', async ({
    page,
  }) => {
    await openWorkspace(page);
    // Over 3,000 pages counts as large: without a GPU (as in CI), it pans by moving the image.
    const { hub } = await page.evaluate(() => {
      const hooks = window.__tesseraSearch;
      if (!hooks) throw new Error('search test hooks are not installed');
      return hooks.stressGraph(3_500);
    });
    await openGraph(page);
    const graph = page.getByRole('img', { name: /Graph view: 3,500 pages/ });
    await expect(graph).toBeVisible({ timeout: 60_000 });
    await settled(page);
    const before = await nodePosition(page, hub);
    // Starts on a node: a drag from a node pans too, and the release must not open the page.
    await page.mouse.move(before.x, before.y);
    await page.mouse.down();
    for (let step = 1; step <= 20; step += 1) {
      await page.mouse.move(before.x - step * 6, before.y + step * 4);
    }
    // Rests before releasing (longer than sigma's 100 ms drag timeout): released on the move, the
    // graph would glide on past the pointer where sigma pans it (with a GPU).
    await page.waitForTimeout(300);
    await page.mouse.up();
    await expect
      .poll(async () => {
        const after = await nodePosition(page, hub);
        return [Math.round(after.x - before.x), Math.round(after.y - before.y)];
      })
      .toEqual([-120, 80]);
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveCount(0);
    await expect(graph).toBeVisible();
  });

  test('the local graph shows the page and its neighbors', async ({ page }) => {
    await openWorkspace(page);
    const pages = await seed(page, 60, 5);
    await openPalette(page);
    await page.keyboard.type('europa');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Europa');
    await page.getByRole('button', { name: 'Local graph', exact: true }).first().click();
    const local = page.getByRole('img', { name: /Local graph: \d+ pages/ });
    await expect(local).toBeVisible();
    await settled(page);
    const depth1 = Number(/(\d+) pages/.exec((await local.getAttribute('aria-label')) ?? '')?.[1]);
    await page.getByLabel('Depth 1').fill('2');
    await expect(page.getByText('Depth 2')).toBeVisible();
    await expect
      .poll(async () =>
        Number(/(\d+) pages/.exec((await local.getAttribute('aria-label')) ?? '')?.[1]),
      )
      .toBeGreaterThan(depth1);
    // Clicking a neighbor opens it.
    await settled(page);
    const neighbor = await page.evaluate(
      (ids) => {
        const hooks = (window as unknown as { __tesseraGraph?: GraphHooks }).__tesseraGraph;
        return ids.find((id) => hooks?.nodePosition(id)) ?? null;
      },
      pages.filter((entry) => entry.title !== 'Europa').map((entry) => entry.id),
    );
    if (!neighbor) throw new Error('no neighbor in the local graph');
    const { x, y } = await nodePosition(page, neighbor);
    await page.mouse.click(x, y);
    await expect(page.getByRole('textbox', { name: 'Page title' })).not.toHaveValue('Europa');
  });

  test.describe('without WebGL', () => {
    // A browser with graphics acceleration off: every WebGL context request fails.
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (
          this: HTMLCanvasElement,
          type: string,
          ...rest: unknown[]
        ) {
          if (/webgl/i.test(type)) return null;
          return (original as (...args: unknown[]) => unknown).call(this, type, ...rest);
        } as typeof original;
      });
    });

    test('the graph view explains why and lists the most connected pages', async ({ page }) => {
      await openWorkspace(page);
      await seed(page, 60, 5);
      await openGraph(page);
      const fallback = page.getByRole('region', { name: 'The graph needs WebGL' });
      await expect(fallback).toBeVisible();
      await expect(fallback.getByText(/hardware acceleration/)).toBeVisible();
      // The controls that only work on a drawn graph are gone; the search box stays.
      await expect(page.getByRole('button', { name: 'Zoom in' })).toBeHidden();
      await expect(page.getByPlaceholder('Find a page…')).toBeVisible();
      const list = fallback.getByRole('region', { name: 'Most connected pages' });
      const entries = list.getByRole('button');
      await expect(entries).toHaveCount(12);
      // Most connected first: link counts never go up down the list.
      const counts = (await entries.allTextContents()).map((text) =>
        Number(/(\d+) links?$/.exec(text)?.[1] ?? Number.NaN),
      );
      expect(counts.every((count, index) => index === 0 || count <= (counts[index - 1] ?? 0))).toBe(
        true,
      );
      // Trying again without WebGL keeps the fallback; opening a page from the list works.
      await fallback.getByRole('button', { name: 'Try again' }).click();
      await expect(fallback).toBeVisible();
      const first = (await entries.first().textContent())?.replace(/\d+ links?$/, '').trim();
      await entries.first().click();
      await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(first ?? '');
    });

    test('the local graph lists the linked pages', async ({ page }) => {
      await openWorkspace(page);
      await seed(page, 60, 5);
      await openPalette(page);
      await page.keyboard.type('europa');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Europa');
      await page.getByRole('button', { name: 'Local graph', exact: true }).first().click();
      const fallback = page.getByRole('region', { name: 'The graph needs WebGL' });
      await expect(fallback).toBeVisible();
      const linked = fallback.getByRole('region', { name: 'Linked pages' }).getByRole('button');
      await expect(linked.first()).toBeVisible();
      // The page itself isn't listed ("Europa reading notes", a neighbor, is): its title then its count.
      await expect(linked.filter({ hasText: /^Europa\d/ })).toHaveCount(0);
      await linked.first().click();
      await expect(page.getByRole('textbox', { name: 'Page title' })).not.toHaveValue('Europa');
    });
  });
});
