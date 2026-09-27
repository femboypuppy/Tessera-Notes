import { expect, test } from '@playwright/test';
import { createPage, createWorkspace, pageTree } from '../architect/helpers';
import {
  ensureExamplesBuilt,
  expectCommand,
  expectNoEscape,
  FIXTURE_BASE,
  installFromRegistry,
  installFromUrl,
  openPanel,
  openPluginSettings,
  pluginFrame,
  serveFixtures,
  serveRegistry,
} from './support';

test.beforeAll(async () => {
  // The first run builds the example plugins (Mermaid takes a while).
  test.setTimeout(600_000);
  await ensureExamplesBuilt();
});

test('plugin code runs only in sandboxed frames with a strict CSP', async ({ page }) => {
  await serveRegistry(page);
  await createWorkspace(page, 'Sandbox');
  await createPage(page, 'Isolation');
  await openPluginSettings(page);
  await installFromRegistry(page, 'Word count');
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });
  await pageTree(page).getByRole('treeitem', { name: 'Isolation' }).click();
  await openPanel(page, 'Word count');
  await expect(pluginFrame(page, 'Word count panel').getByTestId('word-count')).toBeVisible();

  const frames = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLIFrameElement>('iframe[data-plugin-frame]')].map((frame) => ({
      kind: frame.getAttribute('data-plugin-frame'),
      sandbox: frame.getAttribute('sandbox'),
      csp: /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(frame.srcdoc)?.[1] ?? '',
      // An opaque origin: the app can't reach into the frame, and so the frame can't reach out.
      readableByApp: (() => {
        try {
          return frame.contentDocument !== null;
        } catch {
          return false;
        }
      })(),
    })),
  );
  expect(frames.map((frame) => frame.kind).sort()).toEqual(['ui', 'worker']);
  for (const frame of frames) {
    expect(frame.sandbox).toBe('allow-scripts');
    expect(frame.readableByApp).toBe(false);
    expect(frame.csp).toContain("default-src 'none'");
    expect(frame.csp).toContain("connect-src 'none'");
    expect(frame.csp).toContain("frame-src 'none'");
    expect(frame.csp).toContain("form-action 'none'");
    expect(frame.csp).toMatch(/script-src 'nonce-[A-Za-z0-9]+' blob:/);
    expect(frame.csp).not.toContain('unsafe-eval');
  }
});

test('a plugin stuck in an infinite loop is stopped while the app stays responsive', async ({
  page,
}) => {
  await serveFixtures(page);
  await createWorkspace(page, 'Watchdog');
  await openPluginSettings(page);
  await installFromUrl(page, `${FIXTURE_BASE}spinner/manifest.json`, 'Spinner');
  await expectCommand(page, 'plugins.spinner/spin');

  await createPage(page, 'Before the loop');
  await page.keyboard.press('ControlOrMeta+Alt+Shift+KeyY');

  // While the plugin's worker spins, the app keeps working.
  const started = Date.now();
  await createPage(page, 'Still responsive');
  expect(Date.now() - started).toBeLessThan(4_000);

  const notifications = page.getByRole('region', { name: /Notifications/ });
  await expect(
    notifications.getByText('Spinner stopped responding and was stopped.', { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(notifications.getByRole('button', { name: 'Restart' })).toBeVisible();
  await expectCommand(page, 'plugins.spinner/spin', false);
  await openPluginSettings(page);
  await page.getByRole('button', { name: 'Details for Spinner' }).click();
  await expect(page.getByText('Spinner stopped', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /Console/ }).click();
  await expect(page.getByRole('log').getByText('Spinning now')).toBeVisible();

  // It can be restarted (from its details here; the notification offers the same).
  await page.getByRole('main').getByRole('button', { name: 'Restart' }).click();
  await expectCommand(page, 'plugins.spinner/spin');
});

// Firefox and headless Chromium run panel and block frames on the app's main thread, so nothing
// outside a frame can interrupt its code: the host instruments that code, and the frame stops it
// after two seconds without a break.
test('a panel stuck in a loop is stopped, and the app keeps working', async ({ page }) => {
  await serveFixtures(page);
  await createWorkspace(page, 'Loops');
  await createPage(page, 'Plans');
  await openPluginSettings(page);
  await installFromUrl(page, `${FIXTURE_BASE}looper/manifest.json`, 'Looper');
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });
  await pageTree(page).getByRole('treeitem', { name: 'Plans' }).click();

  await openPanel(page, 'Loops');
  const panel = page.locator('[data-plugin-surface="panel"]');
  await expect(panel.getByRole('alert')).toContainText(
    'Looper stopped responding and was stopped.',
    { timeout: 15_000 },
  );
  const started = Date.now();
  await createPage(page, 'After the loop');
  expect(Date.now() - started).toBeLessThan(5_000);

  await openPluginSettings(page);
  await page.getByRole('button', { name: 'Details for Looper' }).click();
  // Only the panel was closed: the plugin runs on.
  await expect(page.getByText('Running', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /Console/ }).click();
  await expect(
    page.getByRole('log').getByText(/A panel ran without a break for \d+\.\d s and was closed\./),
  ).toBeVisible();
});

test('a block stuck in a promise loop is stopped, and can be reloaded', async ({ page }) => {
  await serveFixtures(page);
  await createWorkspace(page, 'Loops');
  await openPluginSettings(page);
  await installFromUrl(page, `${FIXTURE_BASE}looper/manifest.json`, 'Looper');
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });
  await createPage(page, 'Spinning');
  await page.getByRole('textbox', { name: 'Page title' }).press('Enter');
  await page.keyboard.type('/loop');
  await expect(page.getByRole('option', { name: /Loop block/ })).toBeVisible();
  await page.keyboard.press('Enter');

  const block = pluginFrame(page, 'Loop block (Looper)');
  await block.getByRole('button', { name: 'Spin' }).click();
  const surface = page.locator('[data-plugin-surface="block"]');
  await expect(surface.getByRole('alert')).toContainText(
    'Looper stopped responding and was stopped.',
    { timeout: 15_000 },
  );
  // The page is usable again, and the block comes back.
  const started = Date.now();
  await page.getByRole('textbox', { name: 'Page title' }).fill('Spun');
  await expect(pageTree(page).getByRole('treeitem', { name: 'Spun' })).toBeVisible();
  expect(Date.now() - started).toBeLessThan(5_000);
  await surface.getByRole('button', { name: 'Reload' }).click();
  await expect(block.getByRole('button', { name: 'Spin' })).toBeVisible();
});

test('a malicious plugin reaches nothing outside its sandbox', async ({ page, context }) => {
  await expectNoEscape(page, context);
});
