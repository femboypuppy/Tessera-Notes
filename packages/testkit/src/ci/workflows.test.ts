/**
 * Policy checks for `.github/`: every workflow pins its actions to commit SHAs, grants the least
 * permissions, has timeouts, avoids script injection, and the CI gate covers every required job.
 * actionlint (scripts/ci/actionlint.ts) checks syntax and types; these check our own rules.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { expandMatrix, jobNeeds, loadWorkflows, type Workflow, type WorkflowJob } from './workflow';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const WORKFLOWS = loadWorkflows(path.join(ROOT, '.github', 'workflows'));
const byName = (file: string): Workflow => {
  const workflow = WORKFLOWS.find((candidate) => path.basename(candidate.file) === file);
  if (!workflow) throw new Error(`Missing workflow ${file}`);
  return workflow;
};

/** Every `uses:` line of every workflow, with its file. */
const usesLines = WORKFLOWS.flatMap((workflow) =>
  workflow.text
    .split('\n')
    .map((line) => /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      file: path.basename(workflow.file),
      ref: match[1] ?? '',
      rest: match[2] ?? '',
    })),
);

const steps = (job: WorkflowJob) => job.steps ?? [];

describe('.github/workflows', () => {
  it('has the workflows the project needs', () => {
    expect(WORKFLOWS.map((workflow) => path.basename(workflow.file))).toEqual(
      expect.arrayContaining([
        'bench.yml',
        'ci.yml',
        'codeql.yml',
        'desktop.yml',
        'docker.yml',
        'docs.yml',
        'labeler.yml',
        'nightly.yml',
        'release.yml',
      ]),
    );
  });

  it('pins every third-party action to a full commit SHA with a version comment', () => {
    const remote = usesLines.filter((line) => !line.ref.startsWith('./'));
    expect(remote.length).toBeGreaterThan(20);
    for (const line of remote) {
      expect(line.ref, `${line.file}: ${line.ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(line.rest, `${line.file}: ${line.ref} needs "# vX.Y.Z"`).toMatch(
        /^\s+#\s+v\d+\.\d+\.\d+$/,
      );
    }
  });

  it('pins each action to the same commit everywhere', () => {
    const pins = new Map<string, Set<string>>();
    for (const line of usesLines.filter((entry) => !entry.ref.startsWith('./'))) {
      const [action = '', sha = ''] = line.ref.split('@');
      const repo = action.split('/').slice(0, 2).join('/');
      pins.set(repo, new Set([...(pins.get(repo) ?? []), sha]));
    }
    for (const [repo, shas] of pins) expect([...shas], repo).toHaveLength(1);
  });

  it('defaults to read-only permissions and gives every job explicit permissions', () => {
    for (const workflow of WORKFLOWS) {
      const file = path.basename(workflow.file);
      expect(workflow.permissions, file).toEqual({ contents: 'read' });
      for (const [id, job] of Object.entries(workflow.jobs)) {
        expect(job.permissions, `${file} → ${id}`).toBeDefined();
      }
    }
  });

  it('sets a timeout on every job that runs on a runner', () => {
    for (const workflow of WORKFLOWS) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        if (job.uses) continue;
        expect(job['timeout-minutes'], `${path.basename(workflow.file)} → ${id}`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it('gives step timeouts room inside their job timeout', () => {
    // A step timeout at or above the job's never fires: the job's timeout cancels the run first.
    for (const workflow of WORKFLOWS) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        for (const step of steps(job).filter((entry) => entry['timeout-minutes'] !== undefined)) {
          expect(
            step['timeout-minutes'],
            `${path.basename(workflow.file)} → ${id} → ${step.name ?? step.uses ?? ''}`,
          ).toBeLessThan(job['timeout-minutes'] ?? 360);
        }
      }
    }
  });

  it('never persists the checkout token', () => {
    for (const workflow of WORKFLOWS) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        for (const step of steps(job).filter((entry) =>
          entry.uses?.startsWith('actions/checkout@'),
        )) {
          expect(
            step.with?.['persist-credentials'],
            `${path.basename(workflow.file)} → ${id}`,
          ).toBe(false);
        }
      }
    }
  });

  it('passes untrusted event data to scripts through env, never inline', () => {
    for (const workflow of WORKFLOWS) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        for (const step of steps(job)) {
          expect(step.run ?? '', `${path.basename(workflow.file)} → ${id}`).not.toMatch(
            /\$\{\{\s*github\.(?:event|head_ref)/,
          );
        }
      }
    }
  });

  it('never checks out code in pull_request_target workflows', () => {
    for (const workflow of WORKFLOWS) {
      const triggers =
        typeof workflow.on === 'object' && workflow.on !== null ? Object.keys(workflow.on) : [];
      if (!triggers.includes('pull_request_target')) continue;
      for (const job of Object.values(workflow.jobs)) {
        expect(steps(job).some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(false);
      }
    }
  });

  it('only runs scripts that exist', () => {
    for (const workflow of WORKFLOWS) {
      for (const match of workflow.text.matchAll(/(?:node|tsx)\s+(scripts\/[\w./-]+\.ts)/g)) {
        expect(
          existsSync(path.join(ROOT, match[1] ?? '')),
          `${path.basename(workflow.file)}: ${match[1]}`,
        ).toBe(true);
      }
    }
  });
});

describe('ci.yml', () => {
  const ci = byName('ci.yml');

  it('cancels superseded runs and runs on pull requests and main', () => {
    expect(ci.concurrency).toMatchObject({ 'cancel-in-progress': true });
    expect(ci.on).toMatchObject({ pull_request: null, push: { branches: ['main'] } });
  });

  it('gates on every required job through the final "CI" job', () => {
    const gate = ci.jobs.ci;
    expect(gate?.if).toBe('always()');
    const nonBlocking = new Set(['ci', 'audit', 'e2e-report', 'lighthouse']);
    const required = Object.keys(ci.jobs).filter((id) => !nonBlocking.has(id));
    expect([...(gate?.needs ?? [])].sort()).toEqual(required.sort());
  });

  it('runs e2e on Chromium and Firefox in shards', () => {
    expect(ci.jobs.e2e?.strategy?.matrix).toEqual({
      browser: ['chromium', 'firefox'],
      shard: [1, 2],
    });
    const run = steps(ci.jobs.e2e ?? {}).find((step) => step.name === 'Playwright')?.run ?? '';
    expect(run).toContain('--project=${{ matrix.browser }}');
    expect(run).toContain('--shard=${{ matrix.shard }}/2');
  });

  it('times the @perf specs alone, after the others', () => {
    const e2e = steps(ci.jobs.e2e ?? {});
    const main = e2e.find((step) => step.name === 'Playwright')?.run ?? '';
    const timed = e2e.find((step) => step.name === 'Playwright, timed specs alone')?.run ?? '';
    expect(main).toContain('--grep-invert @perf');
    expect(timed).toContain('--grep @perf');
    expect(timed).toContain('--workers=1');
    expect(timed).toContain('--project=${{ matrix.browser }}');
    expect(e2e.findIndex((step) => step.run === timed)).toBeGreaterThan(
      e2e.findIndex((step) => step.run === main),
    );
  });

  it('calls the same root scripts contributors run', () => {
    const runs = Object.values(ci.jobs).flatMap((job) => steps(job).map((step) => step.run ?? ''));
    for (const command of [
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test:coverage',
      'pnpm build',
      'pnpm test:e2e',
    ]) {
      expect(
        runs.some((run) => run.includes(command)),
        command,
      ).toBe(true);
    }
  });
});

describe('docker.yml', () => {
  const docker = byName('docker.yml');
  const build = docker.jobs.build ?? {};
  const merge = docker.jobs.merge ?? {};
  const buildStep = steps(build).find((step) => step.uses?.startsWith('docker/build-push-action@'));
  const createStep = steps(merge).find((step) =>
    step.run?.includes('docker buildx imagetools create'),
  );

  it('publishes ghcr.io/<owner>/tessera whatever the repository is called', () => {
    // The repository became Tessera-Notes; the image kept its name so docker commands keep working.
    for (const job of [build, merge]) {
      const name = steps(job).find((step) => step.name === 'Image name');
      expect(name?.env).toEqual({ OWNER: '${{ github.repository_owner }}' });
      expect(name?.run).toContain('name=ghcr.io/${OWNER,,}/tessera');
    }
  });

  it('builds each platform natively on its own runner, never under QEMU', () => {
    // Under QEMU the arm64 install hung until the job's 60-minute timeout (#56).
    expect(docker.text).not.toContain('setup-qemu-action');
    expect(build['runs-on']).toBe('${{ matrix.runner }}');
    expect(
      expandMatrix(build.strategy?.matrix).map(({ platform, runner }) => ({ platform, runner })),
    ).toEqual([
      { platform: 'linux/amd64', runner: 'ubuntu-24.04' },
      { platform: 'linux/arm64', runner: 'ubuntu-24.04-arm' },
    ]);
    expect(buildStep?.with?.platforms).toBe('${{ matrix.platform }}');
  });

  it('fails a stuck build within a step timeout, well before 15 minutes of the job', () => {
    for (const step of [buildStep, createStep]) {
      expect(step?.['timeout-minutes']).toBeGreaterThan(0);
      expect(step?.['timeout-minutes']).toBeLessThanOrEqual(12);
    }
    expect(build['timeout-minutes']).toBeLessThanOrEqual(20);
    expect(merge['timeout-minutes']).toBeLessThanOrEqual(10);
  });

  it('caches the layers of each platform in their own scope', () => {
    expect(buildStep?.with?.['cache-from']).toBe('type=gha,scope=docker-${{ matrix.arch }}');
    expect(buildStep?.with?.['cache-to']).toBe('type=gha,mode=max,scope=docker-${{ matrix.arch }}');
  });

  it('pushes each platform by digest, then tags one manifest list, only when asked to push', () => {
    const outputs = String(buildStep?.with?.outputs);
    expect(outputs).toContain('push-by-digest=true');
    expect(outputs).toContain('push=${{ inputs.push == true }}');
    expect(buildStep?.with?.provenance).toBe("${{ inputs.push == true && 'mode=max' || 'false' }}");
    expect(buildStep?.with?.sbom).toBe('${{ inputs.push == true }}');
    expect(jobNeeds(merge)).toEqual(['build']);
    expect(merge.if).toBe('inputs.push == true');
    const meta = steps(merge).find((step) => step.uses?.startsWith('docker/metadata-action@'));
    expect(String(meta?.with?.tags)).toContain('type=semver,pattern={{version}}');
    expect(steps(merge).indexOf(meta ?? {})).toBeLessThan(steps(merge).indexOf(createStep ?? {}));
  });
});

describe('desktop.yml', () => {
  const desktop = byName('desktop.yml');
  const job = Object.values(desktop.jobs)[0] ?? {};
  const build = steps(job).find((step) => step.name === 'Tauri build');
  const secrets = steps(job).find((step) => step.name === 'Signing secrets');

  it('hands the Tauri build only the signing secrets that are set', () => {
    // An unset secret is an empty string, and an empty APPLE_CERTIFICATE made the macOS builds
    // of v0.1.0 fail importing it: the build step's env holds no secret but the token.
    expect(Object.keys(build?.env ?? {})).toEqual(['GITHUB_TOKEN']);
    const run = secrets?.run ?? '';
    expect(run).toContain('if [ -n "${!name}" ]');
    expect(run).toContain('"$GITHUB_ENV"');
    for (const name of [
      'APPLE_CERTIFICATE',
      'APPLE_SIGNING_IDENTITY',
      'TAURI_SIGNING_PRIVATE_KEY',
    ]) {
      expect(secrets?.env?.[name]).toBe(`\${{ secrets.${name} }}`);
    }
    expect(steps(job).indexOf(secrets ?? {})).toBeLessThan(steps(job).indexOf(build ?? {}));
  });

  it('ad-hoc signs the macOS app when no Apple certificate is set', () => {
    const config = JSON.parse(
      readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as { bundle?: { macOS?: { signingIdentity?: string } } };
    expect(config.bundle?.macOS?.signingIdentity).toBe('-');
  });
});

describe('nightly.yml', () => {
  const nightly = byName('nightly.yml');
  const runs = Object.values(nightly.jobs).flatMap((job) =>
    steps(job).map((step) => step.run ?? ''),
  );

  it('runs every night and on demand, and never cancels a run in progress', () => {
    expect(nightly.on).toMatchObject({ schedule: [{ cron: expect.any(String) }] });
    expect(nightly.on).toHaveProperty('workflow_dispatch');
    expect(nightly.concurrency).toMatchObject({ 'cancel-in-progress': false });
  });

  it('runs the heavy checks that run nowhere else in CI (#33)', () => {
    for (const command of [
      'pnpm --filter @tessera/server load-test',
      'TESSERA_IMPORT_BENCH_NOTES: 2000',
      'pnpm --filter @tessera/search bench',
      'playwright test -c e2e/search/perf.config.ts',
      'scripts/memory/soak.ts --strict',
    ]) {
      expect(nightly.text.includes(command), `nightly.yml runs "${command}"`).toBe(true);
    }
    expect(nightly.text).toContain("PERF_SOFTWARE_GL: '1'");
  });

  it('keeps every report as an artifact, also when its check fails', () => {
    // A failed check fails the run: no step or job may hide it.
    for (const [id, job] of Object.entries(nightly.jobs)) {
      expect(job['continue-on-error'], id).toBeUndefined();
      const upload = steps(job).find((step) => step.uses?.startsWith('actions/upload-artifact@'));
      expect(upload?.if, id).toBe('${{ !cancelled() }}');
      expect(upload?.with?.['retention-days'], id).toBeGreaterThan(0);
      expect(steps(job).every((step) => step['continue-on-error'] === undefined)).toBe(true);
    }
    // Console reports are kept with `tee`. The default shell (`bash -e`) has no pipefail, so
    // without it the pipeline would exit with tee's status and a failed check would pass.
    const teed = runs.filter((run) => run.includes('| tee'));
    expect(teed.length).toBeGreaterThan(0);
    for (const run of teed) expect(run).toContain('set -o pipefail');
  });
});

describe('dependabot.yml and labeler.yml', () => {
  it('updates npm weekly (grouped), actions monthly and cargo weekly', () => {
    const config = parse(readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8')) as {
      updates: Array<{
        'package-ecosystem': string;
        schedule: { interval: string };
        groups?: object;
      }>;
    };
    const find = (ecosystem: string) =>
      config.updates.filter((update) => update['package-ecosystem'] === ecosystem);
    expect(
      find('npm').every((update) => update.schedule.interval === 'weekly' && update.groups),
    ).toBe(true);
    expect(find('npm')).not.toHaveLength(0);
    expect(find('github-actions').map((update) => update.schedule.interval)).toEqual(['monthly']);
    expect(find('cargo').map((update) => update.schedule.interval)).toEqual(['weekly']);
  });

  it('labels every area by path', () => {
    const config = parse(readFileSync(path.join(ROOT, '.github', 'labeler.yml'), 'utf8')) as Record<
      string,
      Array<{ 'changed-files': Array<{ 'any-glob-to-any-file': string | string[] }> }>
    >;
    for (const area of [
      'editor',
      'sync',
      'databases',
      'search',
      'plugins',
      'desktop',
      'import-export',
      'ci',
    ]) {
      expect(Object.keys(config)).toContain(`area: ${area}`);
    }
    for (const [label, rules] of Object.entries(config)) {
      const globs = rules.flatMap((rule) =>
        rule['changed-files'].flatMap((entry) => entry['any-glob-to-any-file']),
      );
      expect(globs.length, label).toBeGreaterThan(0);
    }
  });
});
