import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type FrameLocator, type Page } from '@playwright/test';
import { buildExamples } from '../../packages/plugins/scripts/build-examples';
import { buildRegistry } from '../../packages/plugins/scripts/registry-files';
import { DEFAULT_REGISTRY_BASE } from '../../packages/plugins/src/constants';
import { zipFileName, type RegistryDocument } from '../../packages/plugins/src/registry-publish';
import { createPage, createWorkspace, pageTree, readDiagnostics } from '../architect/helpers';

/** Helpers for the plugin specs. */

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const EXAMPLES = `${REPO}examples/plugins/`;
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const LOCK = `${EXAMPLES}.e2e-build-lock`;

/** Where the default registry and the example zips are published (served locally in tests). */
export const REGISTRY_BASE = DEFAULT_REGISTRY_BASE;
/** Test-only plugins in e2e/plugins/fixtures, served under this origin. */
export const FIXTURE_BASE = 'https://fixtures.tessera.test/';

/**
 * Builds the example plugins once for every worker (a lock folder keeps parallel workers from
 * building at the same time; up-to-date examples are skipped).
 */
export async function ensureExamplesBuilt(): Promise<void> {
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      // Another worker is building. A lock older than 10 minutes is stale.
      if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > 600_000) rmdirSync(LOCK);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    await buildExamples(undefined, { force: false });
  } finally {
    rmdirSync(LOCK);
  }
}

/** GitHub Pages' CORS header, which the docs site serves the registry with. */
const headers = { 'access-control-allow-origin': '*' };

let published: Promise<{ registry: RegistryDocument; zips: Map<string, Uint8Array> }> | null = null;

/**
 * The default registry exactly as the docs workflow publishes it: every example built, every URL
 * under REGISTRY_BASE, every zip's SHA-256 (`build-registry.ts` does the same).
 */
export function publishedRegistry(): Promise<{
  registry: RegistryDocument;
  zips: Map<string, Uint8Array>;
}> {
  published ??= (async () => {
    await ensureExamplesBuilt();
    const { registry, plugins } = await buildRegistry({ baseUrl: REGISTRY_BASE });
    return {
      registry,
      zips: new Map(plugins.map((plugin) => [zipFileName(plugin.manifest), plugin.zip])),
    };
  })();
  return published;
}

/**
 * Serves the default registry and the example zips at their published addresses. `tamper`
 * changes one byte of that plugin's zip, which then no longer matches its SHA-256.
 */
export async function serveRegistry(page: Page, options: { tamper?: string } = {}): Promise<void> {
  const { registry, zips } = await publishedRegistry();
  await page.route(`${REGISTRY_BASE}**`, async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    if (name === 'registry.json') {
      await route.fulfill({ json: registry, headers });
      return;
    }
    const zip = zips.get(name);
    if (!zip) {
      await route.fulfill({ status: 404, headers, body: '' });
      return;
    }
    const body = Buffer.from(zip);
    if (options.tamper && name.startsWith(`${options.tamper}-`)) {
      const at = Math.floor(body.length / 2);
      body.writeUInt8(body.readUInt8(at) ^ 0xff, at);
    }
    await route.fulfill({ body, headers, contentType: 'application/zip' });
  });
}

/** The built folder of an example plugin (`manifest.json`, `main.js`, `README.md`). */
export function exampleDist(id: string): string {
  return `${EXAMPLES}${id}/dist`;
}

/** The built zip of an example plugin. */
export function exampleZip(id: string, version = '1.0.0'): string {
  return `${EXAMPLES}${id}/dist/${id}-${version}.zip`;
}

/** The text of a fixture file, or null when there is none. */
export function fixtureText(name: string, file: string): string | null {
  if (!/^[a-z-]+$/.test(name) || !/^[a-z.]+$/.test(file)) return null;
  const path = `${FIXTURES}${name}/${file}`;
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Serves e2e/plugins/fixtures/<name>/<file> at FIXTURE_BASE, optionally rewriting the text. */
export async function serveFixtures(
  page: Page,
  rewrite: (name: string, file: string, text: string) => string = (_n, _f, text) => text,
): Promise<void> {
  await page.route(`${FIXTURE_BASE}**`, async (route) => {
    const [, name = '', file = ''] = new URL(route.request().url()).pathname.split('/');
    const path = `${FIXTURES}${name}/${file}`;
    if (!/^[a-z-]+$/.test(name) || !/^[a-z.]+$/.test(file) || !existsSync(path)) {
      await route.fulfill({ status: 404, headers, body: '' });
      return;
    }
    await route.fulfill({
      body: rewrite(name, file, readFileSync(path, 'utf8')),
      headers: {
        ...headers,
        'content-type': file.endsWith('.js') ? 'text/javascript' : 'application/json',
      },
    });
  });
}

/** Opens Settings → Plugins without reloading (the workspace lives in memory until sync lands). */
export async function openPluginSettings(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  // The settings UI loads on demand (slow on a cold dev server).
  await expect(page.getByRole('button', { name: 'Install plugin' })).toBeVisible({
    timeout: 30_000,
  });
}

/** Approves the permission prompt that is open. */
export async function approvePrompt(page: Page, pluginName: string): Promise<void> {
  const prompt = page.getByRole('dialog', { name: `Install ${pluginName}?` });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await prompt.getByRole('button', { name: 'Install', exact: true }).click();
  // `exact`: the toast's text is also announced in a live region ("Notifications …").
  await expect(page.getByText(`${pluginName} is installed`, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** Installs a plugin from the Browse tab (Settings → Plugins must be open). */
export async function installFromRegistry(page: Page, pluginName: string): Promise<void> {
  await page.getByRole('tab', { name: 'Browse' }).click();
  await page.getByRole('button', { name: `Install ${pluginName}` }).click();
  await approvePrompt(page, pluginName);
}

/** Installs a plugin from a URL (Settings → Plugins must be open). */
export async function installFromUrl(page: Page, url: string, pluginName: string): Promise<void> {
  await page.getByRole('button', { name: 'Install plugin' }).click();
  await page.getByRole('menuitem', { name: 'From a URL…' }).click();
  await page.getByLabel('Plugin URL').fill(url);
  await page.getByRole('button', { name: 'Continue' }).click();
  await approvePrompt(page, pluginName);
}

/** The inner frame of a plugin panel or block, where the plugin's own UI runs. */
export function pluginFrame(page: Page, titlePrefix: string): FrameLocator {
  return page
    .frameLocator(`iframe[data-plugin-frame="ui"][title^="${titlePrefix}"]`)
    .frameLocator('iframe');
}

/** Waits until a command registered by a plugin is available. */
export async function expectCommand(page: Page, commandId: string, present = true): Promise<void> {
  await expect
    .poll(async () => (await readDiagnostics(page))?.commands.includes(commandId) ?? false, {
      timeout: 20_000,
    })
    .toBe(present);
}

/**
 * Opens a side panel from the top bar: its own button, or the "Panels" menu that the top bar shows
 * instead once more than three panels exist (backlinks, local graph and history, plus plugins').
 */
export async function openPanel(page: Page, title: string): Promise<void> {
  const banner = page.getByRole('banner');
  const button = banner.getByRole('button', { name: title, exact: true });
  const menu = banner.getByRole('button', { name: 'Panels', exact: true });
  await expect(button.or(menu).first()).toBeVisible({ timeout: 20_000 });
  if (await button.isVisible()) {
    await button.click();
    return;
  }
  await menu.click();
  await page.getByRole('menuitem', { name: title, exact: true }).click();
}

/**
 * Installs the hostile fixture plugin (`fixtures/escape`) in a new workspace and checks that none
 * of its probes gets out: every request that reaches the attacker's origin is recorded, and
 * answered, so a leak would succeed; the record, not the plugin's own report, decides.
 */
export async function expectNoEscape(page: Page, context: BrowserContext): Promise<void> {
  const reached: string[] = [];
  await context.route('https://evil.tessera.test/**', async (route) => {
    reached.push(route.request().url());
    await route.fulfill({
      status: 200,
      body: 'ok',
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await serveFixtures(page);
  await createWorkspace(page, 'Fortress');
  await createPage(page, 'Secret plans');
  await page.evaluate(() => {
    document.cookie = 'tessera-secret=launch-codes; path=/';
    localStorage.setItem('tessera-secret', 'launch-codes');
  });
  const appOrigin = new URL(page.url()).origin;

  await openPluginSettings(page);
  await installFromUrl(page, `${FIXTURE_BASE}escape/manifest.json`, 'Escape artist');
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });
  await pageTree(page).getByRole('treeitem', { name: 'Secret plans' }).click();
  await openPanel(page, 'Escape probes');

  const frame = pluginFrame(page, 'Escape probes');
  await expect(frame.locator('[data-done="true"]')).toBeAttached({ timeout: 30_000 });
  const results = await frame
    .locator('[data-probe]')
    .evaluateAll((items) =>
      items.map((item) => [item.getAttribute('data-probe'), item.getAttribute('data-result')]),
    );
  // Every probe ran (worker and panel), and none got through.
  expect(results.map(([name]) => name)).toEqual(
    expect.arrayContaining([
      'worker: read pages without permission',
      'worker: fetch another origin',
      'worker: importScripts from another origin',
      'panel: read the app document',
      'panel: read cookies',
      'panel: localStorage',
      'panel: eval',
      'panel: read the CSP nonce it runs under',
    ]),
  );
  expect(results.length).toBeGreaterThanOrEqual(20);
  expect(results.filter(([, result]) => result !== 'blocked')).toEqual([]);

  // Last, the navigations: the app's top window, a form posted to the top, the frame itself.
  await frame.getByRole('button', { name: 'Try to navigate away' }).click();
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).origin).toBe(appOrigin);
  await expect(pageTree(page).getByRole('treeitem', { name: 'Secret plans' })).toBeVisible();
  // The forged "delete" and "list" messages changed nothing, and the app's storage is intact.
  expect(await page.evaluate(() => localStorage.getItem('tessera-secret'))).toBe('launch-codes');
  expect(reached).toEqual([]);
}
