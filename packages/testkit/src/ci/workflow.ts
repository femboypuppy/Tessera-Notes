import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

/** One step of a job (the fields the local runner and the policy checks use). */
export interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  if?: string | boolean;
  shell?: string;
  'working-directory'?: string;
  'continue-on-error'?: boolean | string;
  'timeout-minutes'?: number;
}

export interface WorkflowJob {
  name?: string;
  needs?: string | string[];
  if?: string | boolean;
  'runs-on'?: unknown;
  'timeout-minutes'?: number;
  permissions?: unknown;
  strategy?: { matrix?: Record<string, unknown>; 'fail-fast'?: boolean };
  env?: Record<string, unknown>;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
  /** A reusable workflow call. */
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  'continue-on-error'?: boolean | string;
  defaults?: { run?: { shell?: string; 'working-directory'?: string } };
}

export interface Workflow {
  /** Path the workflow was read from. */
  file: string;
  /** The raw text (comments included, for checks YAML parsing drops). */
  text: string;
  name?: string;
  on: unknown;
  permissions?: unknown;
  concurrency?: unknown;
  env?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a workflow file. Throws when it has no `jobs` map. */
export function loadWorkflow(file: string): Workflow {
  const text = readFileSync(file, 'utf8');
  const data: unknown = parse(text);
  if (!isRecord(data) || !isRecord(data.jobs)) throw new Error(`${file}: not a workflow (no jobs)`);
  return {
    ...(data as Omit<Workflow, 'file' | 'text'>),
    jobs: data.jobs as Record<string, WorkflowJob>,
    file,
    text,
  };
}

/** Every workflow in a `.github/workflows` folder, by file name. */
export function loadWorkflows(dir: string): Workflow[] {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => loadWorkflow(path.join(dir, name)));
}

/** `needs` as a list. */
export function jobNeeds(job: WorkflowJob): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

/** Job IDs in an order where every job comes after the jobs it needs. */
export function jobOrder(workflow: Pick<Workflow, 'jobs'>): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw new Error(`Cycle in job needs at "${id}"`);
    const job = workflow.jobs[id];
    if (!job) throw new Error(`Unknown job "${id}" in needs`);
    state.set(id, 'visiting');
    for (const need of jobNeeds(job)) visit(need);
    state.set(id, 'done');
    order.push(id);
  };
  for (const id of Object.keys(workflow.jobs)) visit(id);
  return order;
}

export type MatrixCombination = Record<string, unknown>;

/**
 * Expands `strategy.matrix` like Actions: the cross product of the array keys, minus `exclude`,
 * plus `include` (which extends matching combinations or adds new ones). No matrix → one empty
 * combination.
 */
export function expandMatrix(matrix: Record<string, unknown> | undefined): MatrixCombination[] {
  if (!matrix) return [{}];
  const include = Array.isArray(matrix.include) ? (matrix.include as MatrixCombination[]) : [];
  const exclude = Array.isArray(matrix.exclude) ? (matrix.exclude as MatrixCombination[]) : [];
  const axes = Object.entries(matrix).filter(
    ([key, value]) => key !== 'include' && key !== 'exclude' && Array.isArray(value),
  ) as Array<[string, unknown[]]>;
  let combinations: MatrixCombination[] = axes.length ? [{}] : [];
  for (const [key, values] of axes) {
    combinations = combinations.flatMap((combination) =>
      values.map((value) => ({ ...combination, [key]: value })),
    );
  }
  const matches = (combination: MatrixCombination, partial: MatrixCombination) =>
    Object.entries(partial).every(([key, value]) => combination[key] === value);
  combinations = combinations.filter(
    (combination) => !exclude.some((rule) => matches(combination, rule)),
  );
  // An include object extends every original combination whose matrix values it doesn't
  // overwrite; when there is none, it becomes a combination of its own.
  const originalKeys = new Set(axes.map(([key]) => key));
  const originals = combinations.map((combination) => ({ ...combination }));
  for (const extra of include) {
    const overlapping = Object.fromEntries(
      Object.entries(extra).filter(([key]) => originalKeys.has(key)),
    );
    const targets = combinations.filter((_, index) => {
      const original = originals[index];
      return original !== undefined && matches(original, overlapping);
    });
    if (targets.length) for (const combination of targets) Object.assign(combination, extra);
    else combinations.push({ ...extra });
  }
  return combinations.length ? combinations : [{}];
}
