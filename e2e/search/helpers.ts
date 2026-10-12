import { expect, type Page } from '@playwright/test';

/**
 * Helpers for the search, backlinks and graph specs. Content is written through the search
 * feature's test hooks (`window.__tesseraSearch`, enabled by the device setting
 * `search.testHooks`), so the specs don't depend on the editor's UI.
 */

type InlineSpec = string | { link: string; label?: string } | { tag: string };

interface Hooks {
  seed(options: { pages: number; seed?: number }): Promise<Array<{ id: string; title: string }>>;
  writeParagraphs(
    pageId: string,
    paragraphs: InlineSpec[][],
    props?: Record<string, unknown>,
  ): Promise<void>;
  readDoc(pageId: string): Promise<unknown>;
  whenIndexed(): Promise<void>;
  stressGraph(pages: number, seed?: number): { nodes: number; edges: number; hub: string };
}

declare global {
  interface Window {
    __tesseraSearch?: Hooks;
  }
}

/** Turns the test hooks on before the app boots. */
export async function enableHooks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('tessera:device:search.testHooks', 'true');
  });
}

/** Opens the app, creates a workspace and waits for the hooks. */
export async function openWorkspace(page: Page, name = 'Research notes'): Promise<void> {
  await enableHooks(page);
  await page.goto('/');
  await page.getByLabel('Workspace name').fill(name);
  await page.getByRole('button', { name: 'Create an empty workspace' }).click();
  await expect(page.getByText('Your workspace is empty')).toBeVisible();
  await page.waitForFunction(() => window.__tesseraSearch !== undefined);
}

/** Seeds a generated workspace and waits until it is indexed. */
export async function seed(
  page: Page,
  pages: number,
  seedValue = 1,
): Promise<Array<{ id: string; title: string }>> {
  const result = await page.evaluate(
    async ({ count, value }) => {
      const hooks = window.__tesseraSearch;
      if (!hooks) throw new Error('search test hooks are not installed');
      const created = await hooks.seed({ pages: count, seed: value });
      await hooks.whenIndexed();
      return created;
    },
    { count: pages, value: seedValue },
  );
  return result;
}

/** Creates a page through the sidebar and returns its ID. */
export async function newPage(page: Page, title: string): Promise<string> {
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: 'New page', exact: true })
    .first()
    .click();
  const titleField = page.getByRole('textbox', { name: 'Page title' });
  await expect(titleField).toBeFocused();
  await page.keyboard.type(title);
  await expect(titleField).toHaveValue(title);
  await expect(page).toHaveURL(/\/p\//);
  const id = new URL(page.url()).pathname.split('/').pop();
  if (!id) throw new Error('no page ID in the URL');
  return decodeURIComponent(id);
}

/** Writes paragraphs (text, `{ link }` and `{ tag }` parts) into a page and waits for the index. */
export async function write(
  page: Page,
  pageId: string,
  paragraphs: InlineSpec[][],
  props?: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    async ({ id, content, pageProps }) => {
      const hooks = window.__tesseraSearch;
      if (!hooks) throw new Error('search test hooks are not installed');
      await hooks.writeParagraphs(id, content, pageProps);
      await hooks.whenIndexed();
    },
    { id: pageId, content: paragraphs, pageProps: props },
  );
}

/** Waits until the indexes caught up. */
export async function whenIndexed(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__tesseraSearch?.whenIndexed();
  });
}

/** The command palette dialog. */
export function palette(page: Page) {
  return page.getByRole('dialog', { name: 'Command palette' });
}

/** Opens the palette with the keyboard. */
export async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+K');
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole('combobox')).toBeFocused();
}
