/**
 * The memory soak (SPEC.md §10, "no growth over 10 minutes of editing"): the demo workspace in
 * Chromium, edited for `--minutes` (10 by default) the way a person works: a new page typed with
 * the slash menu and a [[link]], the palette, the project board, a note with its backlinks, undo
 * and redo, the page moved to the trash, and the trash emptied every few rounds. After a warm-up,
 * the JS heap is measured after a forced garbage collection every `--every` seconds, with the DOM
 * node and event listener counts.
 *
 *   pnpm exec tsx scripts/memory/soak.ts [--minutes 10] [--every 30] [--url …] [--strict]
 *
 * It passes when the heap after GC doesn't trend upward (least-squares slope under 0.25 MB per
 * minute over the measured part) and the DOM nodes and listeners end within 10% of where they
 * started. `--strict` exits with 1 when it doesn't. Writes `results.{json,md}` to
 * `node_modules/.cache/memory-soak` (or `--out`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type CDPSession, type Page } from '@playwright/test';
import { serveApp } from '../lib/serve-app.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const { values } = parseArgs({
  options: {
    minutes: { type: 'string', default: '10' },
    every: { type: 'string', default: '30' },
    warmup: { type: 'string', default: '60' },
    url: { type: 'string' },
    out: { type: 'string', default: path.join(root, 'node_modules', '.cache', 'memory-soak') },
    strict: { type: 'boolean', default: false },
  },
});

const MINUTES = Number(values.minutes);
const EVERY_MS = Number(values.every) * 1000;
const WARMUP_MS = Number(values.warmup) * 1000;
const MAX_SLOPE_MB_PER_MINUTE = 0.25;
const MAX_DOM_GROWTH = 0.1;
/** Every sample is taken on this page of the demo workspace. */
const SAMPLE_PAGE = 'Welcome to Tessera';

interface Sample {
  minute: number;
  heapMB: number;
  nodes: number;
  listeners: number;
  rounds: number;
  /** Where the app was: samples are only comparable on the same screen. */
  screen: string;
}

async function measure(page: Page, cdp: CDPSession): Promise<Omit<Sample, 'minute' | 'rounds'>> {
  // Twice: objects freed by the first pass (finalizers, weak maps) go in the second.
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters');
  const screen = await page.evaluate(
    () =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Page title"]')?.value ??
      location.pathname,
  );
  return {
    heapMB: heap.usedSize / 1024 / 1024,
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    screen,
  };
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const tree = (page: Page) => sidebar(page).getByRole('tree', { name: 'Pages' });

async function open(page: Page, title: string): Promise<void> {
  await tree(page).getByRole('treeitem', { name: title, exact: true }).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Page title"]')?.value ===
      expected,
    title,
  );
}

/** Waits until keyboard focus is in the element with this accessible name. */
async function focusIn(page: Page, label: string): Promise<void> {
  await page.waitForFunction(
    (name) => document.activeElement?.closest(`[aria-label="${name}"]`) !== null,
    label,
  );
}

/** One round of editing, about 20 seconds. */
async function round(page: Page, index: number): Promise<void> {
  // A new page, written with the slash menu and a link.
  await sidebar(page).getByRole('button', { name: 'New page', exact: true }).first().click();
  await focusIn(page, 'Page title');
  await page.keyboard.type(`Soak ${index}`, { delay: 15 });
  await page.keyboard.press('Enter');
  await focusIn(page, 'Page content');
  await page.keyboard.type('Checking the exhibit before the doors open. See ', { delay: 10 });
  await page.keyboard.type('[[saturn');
  await page.getByRole('listbox', { name: /link to a page/i }).waitFor();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/to-do');
  await page.getByRole('listbox', { name: 'Insert a block' }).waitFor();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Dust the lunar module model', { delay: 10 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Charge the audio guides', { delay: 10 });
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ControlOrMeta+z');
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ControlOrMeta+Shift+z');

  // The palette.
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: /command palette/i });
  await page.keyboard.type('gagarin', { delay: 20 });
  await palette.getByRole('option').first().waitFor();
  await page.keyboard.press('Escape');

  // The board and a note with its backlinks.
  await open(page, 'Projects');
  await page.locator('section[data-group-key]').first().waitFor();
  await open(page, 'Welcome to Tessera');
  const panelToggle = page.getByRole('banner').getByRole('button', { name: /^Backlinks/ });
  await panelToggle.click();
  await page.getByRole('complementary', { name: /Backlinks/ }).waitFor();
  await panelToggle.click();

  // The page goes to the trash, and the trash is emptied every fifth round.
  await open(page, `Soak ${index}`);
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  if (index % 5 === 4) {
    await sidebar(page).getByRole('button', { name: 'Trash' }).click();
    await page.getByRole('button', { name: /^Empty trash/ }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^(Empty trash|Delete)/ })
      .click();
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
  }
}

/** Least-squares slope of y over x. */
function slope(points: ReadonlyArray<readonly [number, number]>): number {
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
  let top = 0;
  let bottom = 0;
  for (const [x, y] of points) {
    top += (x - meanX) * (y - meanY);
    bottom += (x - meanX) ** 2;
  }
  return bottom === 0 ? 0 : top / bottom;
}

const app = await serveApp(values.url);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(app.url);
  await page.getByRole('button', { name: /Open the demo workspace/ }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Page title"]')?.value ===
      'Welcome to Tessera',
    null,
    { timeout: 60_000 },
  );

  const started = Date.now();
  const end = started + MINUTES * 60_000;
  const samples: Sample[] = [];
  let rounds = 0;
  let nextSample = started + WARMUP_MS;
  console.info(`Editing for ${MINUTES} minutes (samples every ${values.every} s after a warm-up)…`);
  while (Date.now() < end) {
    try {
      await round(page, rounds);
    } catch (error) {
      await page.screenshot({ path: path.join(values.out, 'failure.png') });
      throw error;
    }
    rounds += 1;
    if (Date.now() >= nextSample) {
      const minute = (Date.now() - started) / 60_000;
      // A round ends on its own page or, every fifth round, on the Trash: measure on one screen.
      await open(page, SAMPLE_PAGE);
      const sample = { minute, rounds, ...(await measure(page, cdp)) };
      samples.push(sample);
      console.info(
        `${minute.toFixed(1)} min, ${rounds} rounds: heap ${sample.heapMB.toFixed(1)} MB, ` +
          `${sample.nodes} nodes, ${sample.listeners} listeners (${sample.screen})`,
      );
      nextSample += EVERY_MS;
    }
  }
  if (samples.length < 3) throw new Error('Too few samples; run for longer');
  // Two screens differ by hundreds of DOM nodes and over a megabyte of heap, which would read as
  // growth (or hide it): every sample must come from the same one.
  const screens = [...new Set(samples.map((sample) => sample.screen))];
  if (screens.length > 1)
    throw new Error(`Samples were taken on different screens: ${screens.join(', ')}`);

  const heapSlope = slope(samples.map((sample) => [sample.minute, sample.heapMB] as const));
  const first = samples[0] as Sample;
  const last = samples.at(-1) as Sample;
  const nodesGrowth = (last.nodes - first.nodes) / first.nodes;
  const listenersGrowth = (last.listeners - first.listeners) / first.listeners;
  const passed =
    heapSlope < MAX_SLOPE_MB_PER_MINUTE &&
    nodesGrowth <= MAX_DOM_GROWTH &&
    listenersGrowth <= MAX_DOM_GROWTH;
  const summary = {
    minutes: MINUTES,
    rounds,
    heapStartMB: first.heapMB,
    heapEndMB: last.heapMB,
    heapSlopeMBPerMinute: heapSlope,
    nodes: [first.nodes, last.nodes],
    listeners: [first.listeners, last.listeners],
    passed,
    samples,
  };
  const markdown = [
    `## Memory soak: ${MINUTES} minutes, ${rounds} rounds of editing`,
    '',
    `${passed ? '✅' : '❌'} Heap after GC: ${first.heapMB.toFixed(1)} → ${last.heapMB.toFixed(1)} MB, ` +
      `slope ${heapSlope.toFixed(3)} MB/min (budget < ${MAX_SLOPE_MB_PER_MINUTE}); DOM nodes ` +
      `${first.nodes} → ${last.nodes}, listeners ${first.listeners} → ${last.listeners}.`,
    '',
    '| Minute | Rounds | Heap after GC (MB) | DOM nodes | Listeners |',
    '| ---: | ---: | ---: | ---: | ---: |',
    ...samples.map(
      (sample) =>
        `| ${sample.minute.toFixed(1)} | ${sample.rounds} | ${sample.heapMB.toFixed(1)} | ${sample.nodes} | ${sample.listeners} |`,
    ),
    '',
  ].join('\n');
  mkdirSync(values.out, { recursive: true });
  writeFileSync(path.join(values.out, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(values.out, 'results.md'), markdown);
  console.info(`\n${markdown}`);
  if (!passed && values.strict) process.exitCode = 1;
} finally {
  await browser.close();
  app.stop();
}
