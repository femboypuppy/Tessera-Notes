/**
 * The benchmark suite (SPEC.md section 10): cold start with 5,000 pages, search p95, the palette,
 * opening a 2,000-block page, typing latency, the graph view, importing 2,000 files, and the first
 * open of 5,000 imported notes from IndexedDB. It builds the seeded harness (the real app with a
 * generated workspace, or on its real storage), runs each benchmark in a fresh Chromium context,
 * prints a markdown table and writes JSON.
 *
 *   pnpm exec tsx scripts/bench/run.ts [--out dir] [--only cold-start,search]
 *     [--runs 3] [--compare baseline/results.json] [--strict] [--headed]
 *
 * Budgets are reported, not enforced (the owners' tests and the bundle check enforce theirs);
 * `--strict` makes a missed budget exit with 1. A benchmark that errors always does.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { startHarness } from '../../packages/testkit/src/playwright/harness-server';
import { appendJobSummary } from '../lib/github.ts';
import { BENCHMARKS, type BenchContext } from './benchmarks.ts';
import { benchMarkdown, parseRun, type BenchResult, type BenchRun } from './report.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const { values } = parseArgs({
  options: {
    // Ignored by git; CI passes --out bench-results to upload them.
    out: { type: 'string', default: path.join(root, 'node_modules', '.cache', 'bench-results') },
    only: { type: 'string' },
    runs: { type: 'string', default: '3' },
    compare: { type: 'string' },
    strict: { type: 'boolean', default: false },
    // A visible window renders with the GPU; headless Chromium falls back to software rendering.
    headed: { type: 'boolean', default: false },
  },
});

const only = values.only
  ?.split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const selected = BENCHMARKS.filter((benchmark) => !only?.length || only.includes(benchmark.id));
if (!selected.length) {
  console.error(
    `No benchmark matches --only ${values.only}. Known: ${BENCHMARKS.map((b) => b.id).join(', ')}`,
  );
  process.exit(2);
}

const log = (message: string) => console.info(message);
log('Building and serving the seeded harness…');
const harness = await startHarness({
  mode: 'preview',
  outDir: path.join(root, 'node_modules', '.cache', 'bench-harness'),
});
const browser = await chromium.launch({ headless: !values.headed });
const context: BenchContext = {
  browser,
  headless: !values.headed,
  harness,
  runs: Math.max(1, Number(values.runs) || 3),
  log,
};

const results: BenchResult[] = [];
try {
  for (const benchmark of selected) {
    log(`▶ ${benchmark.title}`);
    const started = Date.now();
    let result: BenchResult;
    try {
      const outcome = await benchmark.run(context);
      result = { id: benchmark.id, title: benchmark.title, ...outcome };
      if (benchmark.budget) {
        result.budget = benchmark.budget;
        if (outcome.status === 'ok' && outcome.value !== undefined) {
          result.withinBudget = outcome.value <= benchmark.budget.max;
        }
      }
    } catch (error) {
      result = {
        id: benchmark.id,
        title: benchmark.title,
        status: 'failed',
        reason: error instanceof Error ? error.message.split('\n')[0] : String(error),
        ...(benchmark.budget ? { budget: benchmark.budget } : {}),
      };
    }
    results.push(result);
    log(
      `  ${result.status}${result.value !== undefined ? ` ${result.value.toFixed(1)} ms` : ''}${result.reason ? `: ${result.reason}` : ''} (${((Date.now() - started) / 1000).toFixed(0)} s)`,
    );
  }
} finally {
  await browser.close();
  await harness.close();
}

const git = (...args: string[]) => {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};
const run: BenchRun = {
  version: 1,
  startedAt: new Date().toISOString(),
  commit: git('rev-parse', 'HEAD'),
  environment: {
    os: `${platform()} ${release()}`,
    node: process.version,
    browser: `Chromium ${browser.version()}`,
    cpus: cpus().length,
  },
  results,
};
const baseline =
  values.compare && existsSync(values.compare)
    ? parseRun(readFileSync(values.compare, 'utf8'))
    : null;
if (values.compare && !baseline) log(`No baseline at ${values.compare}; nothing to compare with.`);
const markdown = benchMarkdown(run, baseline);

const out = values.out ?? path.join(root, 'node_modules', '.cache', 'bench-results');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(run, null, 2)}\n`);
writeFileSync(path.join(out, 'results.md'), markdown);
console.log(`\n${markdown}`);
appendJobSummary(markdown);
log(`Results: ${path.relative(root, path.join(out, 'results.json'))}`);

const broken = results.some((result) => result.status === 'failed');
const missed = results.some((result) => result.withinBudget === false);
process.exitCode = broken || (values.strict && missed) ? 1 : 0;
