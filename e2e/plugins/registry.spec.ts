import { expect, test, type Page } from '@playwright/test';
import { createWorkspace } from '../architect/helpers';
import {
  approvePrompt,
  ensureExamplesBuilt,
  openPluginSettings,
  publishedRegistry,
  REGISTRY_BASE,
  serveRegistry,
} from './support';

/**
 * Settings → Plugins → Browse against the default registry, served as the docs workflow publishes
 * it (generated from the examples, with a SHA-256 for every zip).
 */

test.beforeAll(async () => {
  test.setTimeout(600_000);
  await ensureExamplesBuilt();
});

/** Records the registry files the app asks for. */
function trackRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(REGISTRY_BASE))
      requests.push(request.url().slice(REGISTRY_BASE.length));
  });
  return requests;
}

test('browses the registry, searches it and installs a plugin after checking its SHA-256', async ({
  page,
}) => {
  const { registry } = await publishedRegistry();
  expect(registry.plugins.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256 ?? ''))).toBe(true);
  await serveRegistry(page);
  const requests = trackRequests(page);
  await createWorkspace(page, 'Registry');
  await openPluginSettings(page);
  await page.getByRole('tab', { name: 'Browse' }).click();

  // Every published plugin has a card.
  for (const entry of registry.plugins) {
    await expect(page.getByRole('heading', { name: entry.name, exact: true })).toBeVisible();
  }
  await page.getByRole('searchbox', { name: 'Search plugins' }).fill('timer');
  await expect(page.getByRole('heading', { name: 'Pomodoro', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Word count', exact: true })).toBeHidden();

  await page.getByRole('button', { name: 'Install Pomodoro' }).click();
  await approvePrompt(page, 'Pomodoro');
  expect(requests).toEqual(expect.arrayContaining(['registry.json', 'pomodoro-1.0.0.zip']));
  // The installed plugin's details open, and it starts.
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });
});

test('refuses a download that does not match the registry’s SHA-256', async ({ page }) => {
  await serveRegistry(page, { tamper: 'word-count' });
  await createWorkspace(page, 'Tampered');
  await openPluginSettings(page);
  await page.getByRole('tab', { name: 'Browse' }).click();
  await page.getByRole('button', { name: 'Install Word count' }).click();

  const failure = page.getByRole('dialog', { name: 'Couldn’t install the plugin' });
  await expect(failure).toBeVisible({ timeout: 30_000 });
  await expect(failure).toContainText('doesn’t match the registry’s checksum');
  // Nothing was installed: no permission prompt, and the Installed tab stays empty of it.
  await expect(page.getByRole('dialog', { name: 'Install Word count?' })).toBeHidden();
  await failure.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('tab', { name: 'Installed' }).click();
  await expect(page.getByText('Running', { exact: true })).toBeHidden();
});
