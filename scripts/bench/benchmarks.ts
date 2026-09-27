/**
 * The benchmarks. Each opens the seeded harness (the real app with a generated workspace, see
 * packages/testkit/harness) in a fresh Chromium context and measures in the page; the first-open
 * benchmark runs the app on its real storage, in a browser profile on disk of its own. Features
 * that aren't registered yet make their benchmark report "skipped" with the reason.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { GenerateOptions } from '../../packages/testkit/src/generator';
import type { HarnessState } from '../../packages/testkit/src/harness-state';
import {
  describeMissing,
  missingFeatures,
  readDiagnostics,
  type FeatureName,
} from '../../packages/testkit/src/playwright/features';
import type { HarnessServer } from '../../packages/testkit/src/playwright/harness-server';
import type { BenchResult } from './report.ts';
import { formatMs, median, percentile } from './stats.ts';

export interface BenchContext {
  browser: Browser;
  /** False with `--headed` (benchmarks that launch a browser of their own follow it). */
  headless: boolean;
  harness: HarnessServer;
  /** Repetitions for benchmarks that reload the app. */
  runs: number;
  log(message: string): void;
}

export type BenchOutcome = Omit<BenchResult, 'id' | 'title' | 'budget' | 'withinBudget'>;

/** What the harness publishes as `window.__tesseraHarness` (the import brings its global type). */
export type Harness = HarnessState;

export interface Benchmark {
  id: string;
  title: string;
  budget?: { max: number; label: string };
  run(context: BenchContext): Promise<BenchOutcome>;
}

const skipped = (reason: string): BenchOutcome => ({ status: 'skipped', reason });

/**
 * tsx compiles with esbuild's `keepNames`, which wraps named functions in `__name(…)` calls, and
 * the functions passed to `page.evaluate` are sent as source text. The page needs the helper too.
 */
export const KEEP_NAMES_SHIM = 'globalThis.__name = (target) => target;';

/** Opens the harness with a generated workspace and waits for an interactive sidebar. */
async function openHarness(
  context: BenchContext,
  options: GenerateOptions,
): Promise<{ page: Page; close(): Promise<void> }> {
  const browserContext = await context.browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await browserContext.addInitScript(KEEP_NAMES_SHIM);
  const page = await browserContext.newPage();
  await page.goto(context.harness.url(options));
  await page.waitForFunction(
    () => window.__tesseraHarness?.ready === true || Boolean(window.__tesseraHarness?.error),
    null,
    { timeout: 180_000 },
  );
  const error = await page.evaluate(() => window.__tesseraHarness?.error ?? null);
  if (error) throw new Error(`The harness failed to start: ${error}`);
  return { page, close: () => browserContext.close() };
}

/** Why the benchmark can't run in this build, or null when every feature is there. */
async function missing(page: Page, required: FeatureName[]): Promise<string | null> {
  const diagnostics = await readDiagnostics(page);
  if (!diagnostics) return 'no workspace opened';
  const absent = missingFeatures(diagnostics, required);
  return absent.length ? describeMissing(absent) : null;
}

const WORKSPACE_5000: GenerateOptions = { seed: 42, pages: 5000 };

export const BENCHMARKS: readonly Benchmark[] = [
  {
    id: 'cold-start',
    title: 'Cold start, 5,000 pages → interactive sidebar',
    budget: { max: 2000, label: 'SPEC.md §10: < 2 s to an interactive sidebar' },
    async run(context) {
      const boot: number[] = [];
      const navigation: number[] = [];
      let pages = 0;
      for (let run = 0; run < context.runs; run += 1) {
        const { page, close } = await openHarness(context, WORKSPACE_5000);
        const state = await page.evaluate(() => {
          const harness = window.__tesseraHarness;
          return { timings: harness?.timings, pages: harness?.pages.length ?? 0 };
        });
        await close();
        if (!state.timings?.sidebarReady) throw new Error('No sidebar timing');
        boot.push(state.timings.sidebarReady - state.timings.seeded);
        navigation.push(state.timings.sidebarReady);
        pages = state.pages;
        context.log(`  run ${run + 1}: ${Math.round(boot.at(-1) ?? 0)} ms`);
      }
      return {
        status: 'ok',
        value: median(boot),
        unit: 'ms',
        measure: `median of ${boot.length} runs`,
        details: {
          'pages (with databases and rows)': String(pages),
          'since navigation, including generating the workspace': median(navigation),
        },
      };
    },
  },
  {
    id: 'search',
    title: 'Search, 5,000 pages: query p95',
    budget: { max: 50, label: 'SPEC.md §10: < 50 ms p95 per query' },
    async run(context) {
      const { page, close } = await openHarness(context, WORKSPACE_5000);
      try {
        const titles = await page.evaluate(
          () => window.__tesseraHarness?.pages.map((entry) => entry.title) ?? [],
        );
        const words = [
          ...new Set(
            titles
              .flatMap((title) => title.split(/\s+/))
              .filter((word) => /^[A-Za-z]{5,}$/.test(word)),
          ),
        ];
        const queries = [
          ...words.slice(0, 25),
          ...titles.slice(0, 15).map((title) => title.split(/\s+/).slice(0, 2).join(' ')),
          ...words.slice(25, 35).map((word) => word.slice(0, 3)),
          ...[
            '#space',
            '#engineering',
            '#recipes',
            '#travel',
            'launch window',
            'sourdough starter',
            'rate limiter',
            'pollinator',
            'Lisbon',
            'telemetry',
          ],
        ];
        const implementation = (await readDiagnostics(page))?.services.searchIndex ?? 'unknown';
        const measured = await page.evaluate(async (list) => {
          const ctx = window.__tesseraHarness?.ctx;
          if (!ctx) throw new Error('No workspace context');
          const index = ctx.services.searchIndex;
          const warmStart = performance.now();
          if (index.rebuild) await index.rebuild();
          else await index.query('warm up', { limit: 1 });
          const warm = performance.now() - warmStart;
          const times: number[] = [];
          for (const query of list) {
            const started = performance.now();
            await index.query(query, { limit: 20 });
            times.push(performance.now() - started);
          }
          return { warm, times };
        }, queries);
        return {
          status: 'ok',
          value: percentile(measured.times, 95),
          unit: 'ms',
          measure: `p95 of ${measured.times.length} queries`,
          details: {
            implementation,
            p50: percentile(measured.times, 50),
            'indexing all pages first': measured.warm,
          },
        };
      } finally {
        await close();
      }
    },
  },
  {
    id: 'palette',
    title: 'Command palette: keystroke → results p95',
    budget: { max: 50, label: 'SPEC.md §10: palette < 50 ms p95 per keystroke' },
    async run(context) {
      const { page, close } = await openHarness(context, WORKSPACE_5000);
      try {
        const reason = await missing(page, ['search']);
        if (reason) return skipped(reason);
        await page.keyboard.press('ControlOrMeta+K');
        await page.getByRole('dialog').first().waitFor();
        await page.evaluate(() => {
          const samples: number[] = [];
          (window as unknown as { __paletteLatency: number[] }).__paletteLatency = samples;
          let pending: number | null = null;
          document.addEventListener('keydown', (event) => (pending = event.timeStamp), {
            capture: true,
          });
          new MutationObserver(() => {
            if (pending === null) return;
            samples.push(performance.now() - pending);
            pending = null;
          }).observe(document.querySelector('[role="dialog"]') ?? document.body, {
            childList: true,
            subtree: true,
            characterData: true,
          });
        });
        await page.keyboard.type('mission control launch window', { delay: 150 });
        const samples = await page.evaluate(
          () => (window as unknown as { __paletteLatency: number[] }).__paletteLatency,
        );
        return {
          status: 'ok',
          value: percentile(samples, 95),
          unit: 'ms',
          measure: `p95 of ${samples.length} keystrokes`,
        };
      } finally {
        await close();
      }
    },
  },
  {
    id: 'open-large-page',
    title: 'Open a 2,000-block page',
    async run(context) {
      const times: number[] = [];
      for (let run = 0; run < context.runs; run += 1) {
        const { page, close } = await openHarness(context, {
          seed: 42,
          pages: 200,
          largePages: [2000],
        });
        try {
          const reason = await missing(page, ['editor']);
          if (reason) return skipped(reason);
          const large = await page.evaluate(() => window.__tesseraHarness?.largePages[0] ?? null);
          if (!large) throw new Error('No large page');
          times.push(
            await page.evaluate(async ({ id, marker }) => {
              const ctx = window.__tesseraHarness?.ctx;
              if (!ctx) throw new Error('No workspace context');
              const started = performance.now();
              ctx.navigate(id);
              await new Promise<void>((resolve, reject) => {
                const check = () => {
                  const editors = [...document.querySelectorAll('main [contenteditable="true"]')];
                  if (editors.some((element) => element.textContent?.includes(marker))) resolve();
                  else if (performance.now() - started > 60_000)
                    reject(new Error('The page body did not render'));
                  else requestAnimationFrame(check);
                };
                check();
              });
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => setTimeout(resolve, 0)),
              );
              return performance.now() - started;
            }, large),
          );
        } finally {
          await close();
        }
      }
      return {
        status: 'ok',
        value: median(times),
        unit: 'ms',
        measure: `median of ${times.length} runs`,
      };
    },
  },
  {
    id: 'typing',
    // End to end: it includes the browser's own input, style and layout work, which on a
    // 2,000-block contenteditable alone takes more than a frame on busy machines. SPEC.md's
    // < 16 ms budget is the editor's processing per keystroke, which
    // e2e/editor/performance.spec.ts measures and enforces, so this one is reported, not judged.
    title: 'Typing on a 2,000-block page: keystroke → next frame p95 (end to end)',
    async run(context) {
      const { page, close } = await openHarness(context, {
        seed: 42,
        pages: 200,
        largePages: [2000],
      });
      try {
        const reason = await missing(page, ['editor']);
        if (reason) return skipped(reason);
        const large = await page.evaluate(() => window.__tesseraHarness?.largePages[0] ?? null);
        if (!large) throw new Error('No large page');
        await page.evaluate((id) => window.__tesseraHarness?.ctx?.navigate(id), large.id);
        const body = page.locator('main [contenteditable="true"]').first();
        await body.getByText(large.marker).waitFor({ timeout: 60_000 });
        await body.locator('p').nth(1000).click();
        await page.keyboard.press('End');
        await page.evaluate(() => {
          const samples: number[] = [];
          (window as unknown as { __typingLatency: number[] }).__typingLatency = samples;
          document.addEventListener(
            'keydown',
            (event) => {
              const pressed = event.timeStamp;
              requestAnimationFrame(() => {
                const channel = new MessageChannel();
                channel.port1.onmessage = () => samples.push(performance.now() - pressed);
                channel.port2.postMessage(null);
              });
            },
            { capture: true },
          );
        });
        await page.keyboard.type(
          ' The quick brown fox jumps over the lazy dog while the engines hum.',
          { delay: 40 },
        );
        const samples = await page.evaluate(
          () => (window as unknown as { __typingLatency: number[] }).__typingLatency,
        );
        return {
          status: 'ok',
          value: percentile(samples, 95),
          unit: 'ms',
          measure: `p95 of ${samples.length} keystrokes`,
          details: { p50: percentile(samples, 50) },
        };
      } finally {
        await close();
      }
    },
  },
  {
    id: 'graph',
    title: 'Graph view, 5,000 pages: frame time p95',
    budget: { max: 33.4, label: 'SPEC.md §10: fluid (≥ 30 fps)' },
    async run(context) {
      const { page, close } = await openHarness(context, WORKSPACE_5000);
      try {
        const reason = await missing(page, ['graph']);
        if (reason) return skipped(reason);
        const measured = await page.evaluate(async () => {
          const ctx = window.__tesseraHarness?.ctx;
          if (!ctx) throw new Error('No workspace context');
          // The budget is the graph's own drawing. Opening 5,000 pages starts the search and link
          // indexes reading every page in the background (once per workspace; the search
          // benchmark times it): let that finish, as it has when someone opens the graph later.
          type Idle = { whenIdle?: () => Promise<void> };
          await (ctx.services.searchIndex as Idle).whenIdle?.();
          await (ctx.services.linkIndex as Idle).whenIdle?.();
          const started = performance.now();
          ctx.navigateTo('/graph');
          await new Promise<void>((resolve, reject) => {
            const check = () => {
              if (document.querySelector('main canvas')) resolve();
              else if (performance.now() - started > 60_000) reject(new Error('No graph canvas'));
              else requestAnimationFrame(check);
            };
            check();
          });
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const firstRender = performance.now() - started;
          const frames: number[] = [];
          let last = performance.now();
          await new Promise<void>((resolve) => {
            const tick = (now: number) => {
              frames.push(now - last);
              last = now;
              if (now - started - firstRender < 3000) requestAnimationFrame(tick);
              else resolve();
            };
            requestAnimationFrame(tick);
          });
          return { firstRender, frames };
        });
        return {
          status: 'ok',
          value: percentile(measured.frames, 95),
          unit: 'ms',
          measure: `p95 of ${measured.frames.length} frames`,
          details: { 'first render': measured.firstRender },
        };
      } finally {
        await close();
      }
    },
  },
  {
    id: 'import',
    title: 'Import 2,000 markdown files: longest main-thread block',
    budget: { max: 100, label: 'SPEC.md §10: without freezing the UI (no task over 100 ms)' },
    async run(context) {
      // The budget holds for every import, so the result is the longest block of all runs.
      const runs: ImportRun[] = [];
      for (let run = 0; run < context.runs; run += 1) {
        const measured = await importOnce(context);
        if ('error' in measured) return { status: 'failed', reason: measured.error };
        runs.push(measured);
        context.log(
          `  run ${run + 1}: longest ${Math.round(measured.longest)} ms, ${measured.longTasks} long tasks`,
        );
      }
      const last = runs.at(-1);
      if (!last) throw new Error('No import ran');
      return {
        status: 'ok',
        value: Math.max(...runs.map((measured) => measured.longest)),
        unit: 'ms',
        measure:
          runs.length > 1
            ? `longest of ${runs.length} runs, ${runs.map((measured) => measured.longTasks).join(' + ')} long tasks`
            : `${last.longTasks} long tasks`,
        details: {
          importer: last.importer,
          files: String(last.files),
          'pages created': String(last.pages),
          ...(runs.length > 1
            ? {
                'longest per run': runs.map((measured) => formatMs(measured.longest)).join(', '),
              }
            : {}),
          'total time': median(runs.map((measured) => measured.duration)),
        },
      };
    },
  },
  {
    id: 'first-open',
    // The real app on IndexedDB: 5,000 imported notes, opened again without the saved search
    // index (a first open on this device: the indexes read every page) and with it.
    title:
      'First open of 5,000 notes from IndexedDB: longest main-thread block in the first minute',
    async run(context) {
      return firstOpen(context);
    },
  },
];

interface ImportRun {
  importer: string;
  files: number;
  pages: number;
  duration: number;
  longest: number;
  longTasks: number;
}

/** Imports the generated vault once into a fresh 2,000-page workspace, watching long tasks. */
async function importOnce(context: BenchContext): Promise<ImportRun | { error: string }> {
  const { page, close } = await openHarness(context, {
    seed: 'import',
    pages: 1990,
    databases: 3,
    rowsPerDatabase: 20,
  });
  try {
    return await page.evaluate(async () => {
      const harness = window.__tesseraHarness;
      const ctx = harness?.ctx;
      if (!harness || !ctx) throw new Error('No workspace context');
      const encoder = new TextEncoder();
      const files = harness.markdownFiles().map((file) => {
        const bytes = encoder.encode(file.content);
        return {
          path: file.path,
          size: bytes.byteLength,
          text: async () => file.content,
          bytes: async () => bytes,
        };
      });
      const [best] = await ctx.importers.detect(files);
      if (!best) return { error: 'No importer recognized the markdown files' } as const;
      // In the app, detection runs when files are chosen and the import starts when the
      // person clicks Import below the preview; detection loads the import's code meanwhile.
      // The pause stands for that moment, so this measures the import, not a one-time load.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ type: 'longtask' });
      const started = performance.now();
      const report = await best.importer.run(
        files,
        {
          workspace: ctx.workspace,
          loadPageDoc: (id) => ctx.loadPageDoc(id),
          loadDatabaseDoc: (id) => ctx.loadDatabaseDoc(id),
          assets: ctx.services.assetStore,
          codec: ctx.services.markdownCodec,
          parentId: null,
          rootTitle: 'Benchmark import',
          currentUser: ctx.currentUser,
        },
        () => undefined,
        new AbortController().signal,
      );
      const duration = performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 200));
      observer.disconnect();
      return {
        importer: best.importer.id,
        files: files.length,
        pages: report.counts.pages,
        duration,
        longest: Math.max(0, ...longTasks),
        longTasks: longTasks.length,
      };
    });
  } finally {
    await close();
  }
}

/** The notes a person brings along: 5,000 of them, with databases (as the import benchmark). */
const NOTES_5000: GenerateOptions = {
  seed: 'first-open',
  pages: 5000,
  databases: 3,
  rowsPerDatabase: 20,
};

/** Records long tasks from navigation on (init scripts run before the app's code). */
const LONG_TASKS_SCRIPT = `globalThis.__longTasks = [];
new PerformanceObserver((list) => {
  for (const entry of list.getEntries())
    globalThis.__longTasks.push({ start: entry.startTime, duration: entry.duration });
}).observe({ type: 'longtask' });`;

/** How long each open is recorded (longer when the indexes take longer). */
const FIRST_MINUTE_MS = 60_000;

/** What one open of the workspace did in its first minute. */
interface OpenRun {
  /** Navigation → interactive sidebar. */
  sidebar: number;
  /** Navigation → every page in the search and link indexes. */
  indexed: number;
  /** Docs the indexes read. */
  docsRead: number;
  longest: number;
  /** The longest block once the sidebar was interactive: indexing, not opening the workspace. */
  longestAfterSidebar: number;
  longTasks: number;
  /** Total blocking time: the part of each long task over 50 ms, summed. */
  blocking: number;
}

/**
 * Imports 5,000 generated notes into a real IndexedDB workspace (the harness's
 * `store=indexeddb`, in a browser profile on disk), then opens it again without the saved search
 * index (`index=fresh`: a first open on this device, which reads every page) and with it, and
 * records the first minute of each open.
 */
async function firstOpen(context: BenchContext): Promise<BenchOutcome> {
  const profile = await mkdtemp(path.join(tmpdir(), 'tessera-first-open-'));
  // A profile on disk, as people have one: Playwright's own contexts keep IndexedDB in memory.
  const browser = await chromium.launchPersistentContext(profile, {
    headless: context.headless,
    viewport: { width: 1440, height: 900 },
  });
  try {
    await browser.addInitScript(KEEP_NAMES_SHIM);
    await browser.addInitScript(LONG_TASKS_SCRIPT);
    const page = browser.pages()[0] ?? (await browser.newPage());
    const url = (fresh: boolean) => {
      const target = new URL(context.harness.url(NOTES_5000));
      target.searchParams.set('store', 'indexeddb');
      if (fresh) target.searchParams.set('index', 'fresh');
      return target.toString();
    };
    context.log('  importing 5,000 notes into a new workspace…');
    const seeded = await seed(page, url(false));
    if ('error' in seeded) return { status: 'failed', reason: seeded.error };
    context.log(`  ${seeded.pages} pages imported in ${formatMs(seeded.duration)}`);

    const fresh: OpenRun[] = [];
    for (let run = 0; run < context.runs; run += 1) {
      const measured = await openOnce(page, url(true));
      fresh.push(measured);
      context.log(
        `  first open ${run + 1}: longest ${Math.round(measured.longest)} ms (${Math.round(measured.longestAfterSidebar)} ms once the sidebar was up), ${measured.longTasks} long tasks, every page indexed after ${formatMs(measured.indexed)}`,
      );
    }
    await waitForSavedIndex(page, seeded.workspaceId);
    const saved = await openOnce(page, url(false));
    context.log(
      `  with the saved index: longest ${Math.round(saved.longest)} ms, ${saved.longTasks} long tasks, ${saved.docsRead} docs read`,
    );
    return {
      status: 'ok',
      value: Math.max(...fresh.map((run) => run.longest)),
      unit: 'ms',
      measure: `longest of ${fresh.length} first opens, ${fresh.map((run) => run.longTasks).join(' + ')} long tasks`,
      details: {
        pages: String(seeded.pages),
        'interactive sidebar': median(fresh.map((run) => run.sidebar)),
        'every page indexed': median(fresh.map((run) => run.indexed)),
        'docs read': String(fresh.at(-1)?.docsRead ?? 0),
        'longest block while indexing (after the sidebar)': Math.max(
          ...fresh.map((run) => run.longestAfterSidebar),
        ),
        'total blocking time': median(fresh.map((run) => run.blocking)),
        'with the saved index: longest block': saved.longest,
        'with the saved index: long tasks': String(saved.longTasks),
        'with the saved index: every page indexed': saved.indexed,
      },
    };
  } finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Creates a workspace through onboarding and imports the generated notes into it. */
async function seed(
  page: Page,
  url: string,
): Promise<{ pages: number; duration: number; workspaceId: string } | { error: string }> {
  await page.goto(url);
  await page.getByLabel('Workspace name').fill('Notes');
  await page.getByRole('button', { name: 'Create an empty workspace' }).click();
  await page.waitForFunction(() => Boolean(window.__tesseraHarness?.ctx), null, {
    timeout: 60_000,
  });
  const seeded = await page.evaluate(async () => {
    const harness = window.__tesseraHarness;
    const ctx = harness?.ctx;
    if (!harness || !ctx) throw new Error('No workspace context');
    const encoder = new TextEncoder();
    const files = harness.markdownFiles().map((file) => {
      const bytes = encoder.encode(file.content);
      return {
        path: file.path,
        size: bytes.byteLength,
        text: async () => file.content,
        bytes: async () => bytes,
      };
    });
    const [best] = await ctx.importers.detect(files);
    if (!best) return { error: 'No importer recognized the markdown files' } as const;
    const started = performance.now();
    const report = await best.importer.run(
      files,
      {
        workspace: ctx.workspace,
        loadPageDoc: (id) => ctx.loadPageDoc(id),
        loadDatabaseDoc: (id) => ctx.loadDatabaseDoc(id),
        assets: ctx.services.assetStore,
        codec: ctx.services.markdownCodec,
        parentId: null,
        rootTitle: 'Notes',
        currentUser: ctx.currentUser,
      },
      () => undefined,
      new AbortController().signal,
    );
    type Idle = { whenIdle?: () => Promise<void> };
    await (ctx.services.searchIndex as Idle).whenIdle?.();
    await (ctx.services.linkIndex as Idle).whenIdle?.();
    await ctx.services.docStore.flush?.();
    return {
      pages: report.counts.pages,
      duration: performance.now() - started,
      workspaceId: ctx.workspace.info.id,
    };
  });
  if ('error' in seeded) return seeded;
  await waitForSavedIndex(page, seeded.workspaceId);
  return seeded;
}

/** Waits until the indexes saved themselves (10 s after their last change). */
async function waitForSavedIndex(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const saved = async () => {
      // Opening a database creates it: only look once the app has.
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === 'tessera-search')) return false;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('tessera-search');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Cannot open the saved indexes'));
      });
      try {
        if (!db.objectStoreNames.contains('indexes')) return false;
        const value = await new Promise<unknown>((resolve, reject) => {
          const request = db.transaction('indexes').objectStore('indexes').get(id);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('Cannot read the saved index'));
        });
        return value !== undefined;
      } finally {
        db.close();
      }
    };
    const deadline = performance.now() + 120_000;
    while (!(await saved())) {
      if (performance.now() > deadline) throw new Error('The indexes were never saved');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }, workspaceId);
}

/** Opens the workspace and records its first minute (until the indexes are done, if later). */
async function openOnce(page: Page, url: string): Promise<OpenRun> {
  await page.goto(url);
  await page.waitForFunction(
    () =>
      window.__tesseraHarness?.timings.sidebarReady != null ||
      Boolean(window.__tesseraHarness?.error),
    null,
    { timeout: 180_000 },
  );
  const error = await page.evaluate(() => window.__tesseraHarness?.error ?? null);
  if (error) throw new Error(`The harness failed to start: ${error}`);
  return page.evaluate(async (firstMinute) => {
    const harness = window.__tesseraHarness;
    const ctx = harness?.ctx;
    if (!harness || !ctx) throw new Error('No workspace context');
    type Indexes = { whenIdle?: () => Promise<void>; host?: { docsRead: number } };
    const search = ctx.services.searchIndex as Indexes;
    await search.whenIdle?.();
    await (ctx.services.linkIndex as Indexes).whenIdle?.();
    const indexed = performance.now();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, firstMinute - performance.now())),
    );
    const tasks =
      (globalThis as { __longTasks?: Array<{ start: number; duration: number }> }).__longTasks ??
      [];
    const sidebar = harness.timings.sidebarReady ?? Number.NaN;
    return {
      sidebar,
      indexed,
      docsRead: search.host?.docsRead ?? 0,
      longest: Math.max(0, ...tasks.map((task) => task.duration)),
      longestAfterSidebar: Math.max(
        0,
        ...tasks.filter((task) => task.start >= sidebar).map((task) => task.duration),
      ),
      longTasks: tasks.length,
      blocking: tasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
    };
  }, FIRST_MINUTE_MS);
}
