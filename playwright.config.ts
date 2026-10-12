import { createHash } from 'node:crypto';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests live in `e2e/<area>/*.spec.ts` and run against a production build served by
 * `vite preview`. `E2E_DEV=1` runs them against the Vite dev server instead (no rebuild).
 *
 * Several agents run e2e suites at the same time from sibling worktrees (`<repo>-<area>`), so each
 * worktree gets its own port. Otherwise one worktree could silently reuse another worktree's server
 * and test the wrong code. `E2E_PORT` overrides the port.
 */
function worktreePort(): number {
  if (process.env.E2E_PORT) return Number(process.env.E2E_PORT);
  const folder = path.basename(process.cwd());
  const areas = [
    'editor',
    'sync',
    'databases',
    'search',
    'plugins',
    'desktop',
    'importers',
    'ci',
    'docs',
  ];
  const area = areas.findIndex((name) => folder.endsWith(`-${name}`));
  if (area >= 0) return 4200 + (area + 1) * 10;
  if (folder === 'Tessera' || folder === 'tessera') return 4173;
  const hash = createHash('sha256').update(process.cwd()).digest().readUInt16BE(0);
  return 4300 + (hash % 500);
}

const PORT = worktreePort();
const useDevServer = process.env.E2E_DEV === '1';
const baseURL = `http://localhost:${PORT}`;
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  timeout: 45_000,
  expect: { timeout: 7_500 },
  use: {
    baseURL,
    viewport,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    // Requests a service worker answers bypass `page.route`, so specs run without it; the offline
    // spec turns it on (e2e/architect/offline.spec.ts).
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport } },
    // Firefox runs the same steps two to three times slower on a busy machine (a plugin install
    // flow measured 60 s against Chromium's 25 s), so its budget is doubled. Assertions don't change.
    {
      name: 'firefox',
      timeout: 90_000,
      use: { ...devices['Desktop Firefox'], viewport },
    },
  ],
  webServer: {
    command: useDevServer
      ? `pnpm --filter @tessera/web exec vite --port ${PORT} --strictPort`
      : `pnpm --filter @tessera/web build && pnpm --filter @tessera/web exec vite preview --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
