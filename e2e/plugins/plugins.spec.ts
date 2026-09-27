import { readFileSync, statSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createPage, createWorkspace, pageTree } from '../architect/helpers';
import {
  approvePrompt,
  ensureExamplesBuilt,
  exampleDist,
  exampleZip,
  expectCommand,
  FIXTURE_BASE,
  fixtureText,
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

test.beforeEach(async ({ page }) => {
  await serveRegistry(page);
});

test('install Word count from the registry and see its panel', async ({ page }) => {
  await createWorkspace(page, 'Plugins');
  await createPage(page, 'Apollo program');
  await openPluginSettings(page);
  await page.getByRole('tab', { name: 'Browse' }).click();
  await expect(page.getByRole('heading', { name: 'Word count' })).toBeVisible();
  await page.getByRole('button', { name: 'Install Word count' }).click();
  const prompt = page.getByRole('dialog', { name: 'Install Word count?' });
  await expect(prompt.getByText('Read your pages')).toBeVisible();
  await expect(prompt.getByText('Add side panels')).toBeVisible();
  await approvePrompt(page, 'Word count');
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });

  await pageTree(page).getByRole('treeitem', { name: 'Apollo program' }).click();
  await openPanel(page, 'Word count');
  const panel = pluginFrame(page, 'Word count panel');
  await expect(panel.getByTestId('word-count')).toHaveText('0');
  await expect(panel.getByText('On “Apollo program”')).toBeVisible();

  // Typing in the page updates the panel live.
  await page.getByRole('textbox', { name: 'Page title' }).press('Enter');
  await page.keyboard.type('One small step for a man');
  await expect(panel.getByTestId('word-count')).toHaveText('6', { timeout: 10_000 });
});

test('install the Mermaid block, insert it from the slash menu and see it render', async ({
  page,
}) => {
  await createWorkspace(page, 'Diagrams');
  await openPluginSettings(page);
  await installFromRegistry(page, 'Mermaid diagrams');
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 });

  // Plugin blocks are in the editor's slash menu like any other block.
  await createPage(page, 'Architecture');
  await page.getByRole('textbox', { name: 'Page title' }).press('Enter');
  await page.keyboard.type('/mermaid');
  await expect(page.getByRole('option', { name: /Mermaid diagram/ })).toBeVisible();
  await page.keyboard.press('Enter');
  const block = pluginFrame(page, 'Mermaid diagram (Mermaid diagrams)');
  await expect(block.locator('svg').first()).toBeVisible({ timeout: 30_000 });
  await expect(block.getByText('Capture an idea')).toBeVisible();
  // The diagram's editor opens from the block, and closes with Escape.
  await block.getByRole('button', { name: 'Edit diagram' }).click();
  await expect(block.getByRole('textbox', { name: 'Diagram source (Mermaid)' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(block.getByRole('button', { name: 'Edit diagram' })).toBeAttached();
});

test('Mermaid blocks share one renderer, so each block stays light', async ({ page }) => {
  // The blocks' module leaves Mermaid to the renderer, which loads once (issue #14).
  expect(statSync(`${exampleDist('mermaid')}/main.js`).size).toBeLessThan(100_000);
  expect(statSync(`${exampleDist('mermaid')}/renderer.js`).size).toBeGreaterThan(1_000_000);
  await createWorkspace(page, 'Diagrams');
  await openPluginSettings(page);
  await installFromRegistry(page, 'Mermaid diagrams');
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 });

  await createPage(page, 'Architecture');
  await page.getByRole('textbox', { name: 'Page title' }).press('Enter');
  const frames = 'iframe[data-plugin-frame="ui"][title^="Mermaid diagram (Mermaid diagrams)"]';
  for (let count = 1; count <= 3; count += 1) {
    // Below the last block, the editor adds a line to type in.
    if (count > 1) await page.locator('.tess-editor-tail').click();
    await page.keyboard.type('/mermaid');
    await expect(page.getByRole('option', { name: /Mermaid diagram/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator(frames)).toHaveCount(count);
  }
  for (let index = 0; index < 3; index += 1)
    await expect(
      page.frameLocator(frames).nth(index).frameLocator('iframe').locator('svg').first(),
    ).toBeVisible({ timeout: 30_000 });
  // One hidden, sandboxed renderer drew all three.
  const renderer = page.locator('iframe[data-plugin-frame="renderer"]');
  await expect(renderer).toHaveCount(1);
  await expect(renderer).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(renderer).toHaveAttribute('aria-hidden', 'true');
  await expect(renderer).toHaveAttribute('title', 'Mermaid diagrams renderer');
  const csp = await renderer.evaluate(
    (frame) =>
      /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(
        (frame as HTMLIFrameElement).srcdoc,
      )?.[1] ?? '',
  );
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("frame-src 'none'");
});

test('revoke a permission and see a friendly error', async ({ page }) => {
  await createWorkspace(page, 'Permissions');
  await createPage(page, 'Launch plan');
  await openPluginSettings(page);
  await installFromRegistry(page, 'Word count');
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('tab', { name: 'Permissions' }).click();
  const read = page.getByRole('switch', { name: 'Read your pages' });
  await expect(read).toBeChecked();
  await read.click();
  await expect(read).not.toBeChecked();
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });

  await pageTree(page).getByRole('treeitem', { name: 'Launch plan' }).click();
  await openPanel(page, 'Word count');
  const panel = pluginFrame(page, 'Word count panel');
  await expect(
    panel.getByText(
      'Word count doesn’t have permission to read your pages. You can allow it in Settings → Plugins.',
    ),
  ).toBeVisible();
  const toast = page.getByText('Word count needs permission to read your pages', { exact: true });
  await expect(toast).toBeVisible();
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'Word count', level: 3 })).toBeVisible();
});

test('install from a zip file, then uninstall', async ({ page }) => {
  await createWorkspace(page, 'Zip');
  await openPluginSettings(page);
  await expect(page.getByText('No plugins yet')).toBeVisible();
  await page.getByRole('button', { name: 'Install plugin' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'From a file (.zip)…' }).click();
  await (await chooser).setFiles(exampleZip('random-page'));
  await approvePrompt(page, 'Random page');
  await expectCommand(page, 'plugins.random-page/open-random');
  await expect(page.getByText('Random page: Open a random page')).toBeVisible();

  await page.getByRole('button', { name: 'Uninstall' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Uninstall Random page?' });
  await confirm.getByRole('button', { name: 'Uninstall' }).click();
  await expect(page.getByText('Random page was uninstalled', { exact: true })).toBeVisible();
  await expect(page.getByText('No plugins yet')).toBeVisible();
  await expectCommand(page, 'plugins.random-page/open-random', false);
});

test('install from a folder', async ({ page, browserName }) => {
  const folder = exampleDist('word-count');
  if (browserName === 'chromium') {
    // Chromium has the File System Access API. Its native dialog can't be driven, so the picker
    // returns the built plugin's files through the same handle interface.
    const files = ['manifest.json', 'main.js', 'README.md'].map((name) => [
      name,
      readFileSync(`${folder}/${name}`, 'utf8'),
    ]);
    await page.addInitScript((entries: string[][]) => {
      Object.assign(window, {
        showDirectoryPicker: async () => ({
          kind: 'directory',
          name: 'dist',
          async *values() {
            for (const [name = '', text = ''] of entries)
              yield { kind: 'file', name, getFile: async () => new File([text], name) };
          },
        }),
      });
    }, files);
  }
  await createWorkspace(page, 'Folder');
  await openPluginSettings(page);
  await page.getByRole('button', { name: 'Install plugin' }).click();
  if (browserName === 'chromium') {
    await page.getByRole('menuitem', { name: 'From a folder…' }).click();
  } else {
    // Elsewhere, a folder input (`webkitdirectory`).
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'From a folder…' }).click();
    await (await chooser).setFiles(folder);
  }
  await approvePrompt(page, 'Word count');
  await expect(page.getByText('Running', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'About' }).click();
  await expect(page.getByText('a folder: dist')).toBeVisible();
});

test('dev mode reloads a plugin when its code changes', async ({ page }) => {
  // A stand-in for `pnpm dev` in a plugin folder: it serves the fixture, and "saving" changes it.
  let version = 'one';
  await page.route('http://localhost:5199/**', async (route) => {
    const file = new URL(route.request().url()).pathname.slice(1) || 'manifest.json';
    const text = fixtureText('live-dev', file);
    await route.fulfill(
      text === null
        ? { status: 404, body: '', headers: { 'access-control-allow-origin': '*' } }
        : {
            body: text.replaceAll('__VERSION__', version),
            headers: {
              'access-control-allow-origin': '*',
              'content-type': file.endsWith('.js') ? 'text/javascript' : 'application/json',
            },
          },
    );
  });
  await createWorkspace(page, 'Dev');
  await openPluginSettings(page);
  await page.getByRole('button', { name: 'Install plugin' }).click();
  await page.getByRole('menuitem', { name: 'Load a dev plugin…' }).click();
  await page.getByLabel('Dev server URL').fill('http://localhost:5199/');
  await page.getByRole('button', { name: 'Connect' }).click();
  await approvePrompt(page, 'Live dev');
  await expectCommand(page, 'plugins.live-dev/greet-one');
  await expect(page.getByText('Live reload is on')).toBeVisible();

  version = 'two';
  await expectCommand(page, 'plugins.live-dev/greet-two');
  await expectCommand(page, 'plugins.live-dev/greet-one', false);
});

test('install from a URL refuses things that are not plugins', async ({ page }) => {
  await serveFixtures(page);
  await createWorkspace(page, 'Refusals');
  await openPluginSettings(page);
  await page.getByRole('button', { name: 'Install plugin' }).click();
  await page.getByRole('menuitem', { name: 'From a URL…' }).click();
  await page.getByLabel('Plugin URL').fill(`${FIXTURE_BASE}missing/manifest.json`);
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog', { name: 'Couldn’t install the plugin' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('The download failed (404).')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await installFromUrl(page, `${FIXTURE_BASE}spinner/manifest.json`, 'Spinner');
});
