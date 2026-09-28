/**
 * Writes release notes from the Conventional Commits between the previous `v*` tag and `--to`.
 *
 *   node scripts/release/changelog.ts --to v0.2.0 --repo owner/name [--from v0.1.0] [--heading]
 *     [--intro .github/releases/v0.2.0.md] [--output notes.md]
 *
 * Without `--from`, the previous tag reachable from `--to` is used (or the first commit).
 * `--heading` adds a "## v0.2.0 (date)" line, for CHANGELOG.md. `--intro` puts a hand-written
 * introduction (the highlights) above the generated list, when that file exists.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isIgnoredCommit, parseCommit } from '../lib/conventional-commits.ts';

export interface CommitInfo {
  sha: string;
  message: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** The closest `v*` tag before `ref`, or null for the first release. */
export function previousTag(ref: string, cwd = process.cwd()): string | null {
  try {
    const output = execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', 'v*', `${ref}^`],
      // No tag before `ref` makes git exit with "fatal: No names found": that means "first release".
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return output.trim() || null;
  } catch {
    return null;
  }
}

/** Non-merge commits in `from..to` (everything up to `to` when `from` is null), newest first. */
export function collectCommits(from: string | null, to: string, cwd = process.cwd()): CommitInfo[] {
  const range = from ? `${from}..${to}` : to;
  return git(['log', '--no-merges', '--format=%H%x00%B%x1e', range], cwd)
    .split('\x1e')
    .map((entry) => entry.replace(/^\n+/, ''))
    .filter((entry) => entry.includes('\x00'))
    .map((entry) => {
      const [sha = '', message = ''] = entry.split('\x00');
      return { sha, message: message.trim() };
    });
}

interface Section {
  title: string;
  types: readonly string[];
  collapsed?: boolean;
}

const SECTIONS: readonly Section[] = [
  { title: 'Features', types: ['feat'] },
  { title: 'Bug fixes', types: ['fix'] },
  { title: 'Performance', types: ['perf'] },
  { title: 'Reverts', types: ['revert'] },
  { title: 'Documentation', types: ['docs'] },
  {
    title: 'Maintenance',
    types: ['refactor', 'build', 'ci', 'chore', 'style', 'test'],
    collapsed: true,
  },
];

export interface ChangelogInput {
  commits: readonly CommitInfo[];
  /** `owner/name`, for commit and compare links. */
  repo: string;
  from: string | null;
  to: string;
  /** Adds a "## <to> (<date>)" heading. */
  heading?: { date: string };
  /** Hand-written markdown (the highlights) above the generated sections. */
  intro?: string;
  serverUrl?: string;
}

/**
 * Puts the @-words of a commit subject in code, so release notes never mention (and notify) a
 * GitHub user or team: "time the @perf specs" becomes "time the `@perf` specs". Code spans and
 * email addresses stay as they are.
 */
/** A line that starts a Markdown block of its own (so it never continues the line above it). */
const BLOCK_START = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|```|~~~|<)/;

/**
 * Joins hard-wrapped Markdown so every paragraph and list item is one line, and reports which
 * lines were continuations (1-based). GitHub's release page turns each newline in the notes into a
 * line break, so wrapped text shows ragged there. Headings, tables, quotes, HTML and fenced code
 * are left as they are.
 */
function joinWrappedLines(text: string): { lines: string[]; joined: number[] } {
  const lines: string[] = [];
  const joined: number[] = [];
  let inFence = false;
  let joinable = false;
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, index) => {
      const fence = /^\s*(```|~~~)/.test(line);
      if (inFence || fence || !line.trim()) {
        if (fence) inFence = !inFence;
        lines.push(line);
        joinable = false;
      } else if (joinable && !BLOCK_START.test(line)) {
        lines[lines.length - 1] = `${lines.at(-1)?.trimEnd() ?? ''} ${line.trim()}`;
        joined.push(index + 1);
      } else {
        lines.push(line);
        // Paragraphs and list items take continuation lines; headings, tables and the rest don't.
        joinable = !/^\s*(?:#{1,6}\s|\||>|<)/.test(line);
      }
    });
  return { lines, joined };
}

export function unwrapMarkdown(text: string): string {
  return joinWrappedLines(text).lines.join('\n');
}

/** The 1-based numbers of the lines that continue the line above them (see `unwrapMarkdown`). */
export function hardWrappedLines(text: string): number[] {
  return joinWrappedLines(text).joined;
}

export function escapeMentions(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(/(^|[^\w@`])(@[A-Za-z0-9][\w-]*(?:\/[\w.-]*\w)?)/g, '$1`$2`'),
    )
    .join('');
}

/** Renders the notes as markdown. Commits keep their order (newest first) within a section. */
export function renderChangelog(input: ChangelogInput): string {
  const server = input.serverUrl ?? 'https://github.com';
  const link = (sha: string) => `[\`${sha.slice(0, 7)}\`](${server}/${input.repo}/commit/${sha})`;
  const entry = (text: string, scope: string | null, sha: string) =>
    `- ${scope ? `**${scope}:** ` : ''}${escapeMentions(text)} (${link(sha)})`;

  const breaking: string[] = [];
  const bySection = new Map<string, string[]>();
  const other: string[] = [];
  for (const commit of input.commits) {
    if (isIgnoredCommit(commit.message)) continue;
    const parsed = parseCommit(commit.message);
    if (!parsed) {
      other.push(entry(commit.message.split('\n', 1)[0] ?? '', null, commit.sha));
      continue;
    }
    if (parsed.breaking) {
      breaking.push(entry(parsed.breakingNote ?? parsed.subject, parsed.scope, commit.sha));
    }
    const section = SECTIONS.find((candidate) => candidate.types.includes(parsed.type));
    if (!section) {
      other.push(entry(parsed.header, null, commit.sha));
      continue;
    }
    const list = bySection.get(section.title) ?? [];
    list.push(entry(parsed.subject, parsed.scope, commit.sha));
    bySection.set(section.title, list);
  }

  const lines: string[] = [];
  if (input.heading) lines.push(`## ${input.to} (${input.heading.date})`, '');
  const intro = input.intro?.trim();
  if (intro) lines.push(intro, '');
  const start = lines.length;
  if (breaking.length) lines.push('### ⚠ Breaking changes', '', ...breaking, '');
  for (const section of SECTIONS) {
    const list = bySection.get(section.title);
    if (!list?.length) continue;
    if (section.collapsed) {
      lines.push(
        '<details>',
        `<summary><strong>${section.title}</strong> (${list.length})</summary>`,
        '',
        ...list,
        '',
        '</details>',
        '',
      );
    } else {
      lines.push(`### ${section.title}`, '', ...list, '');
    }
  }
  if (other.length) lines.push('### Other changes', '', ...other, '');
  if (lines.length === start) lines.push('No changes.', '');
  lines.push(
    input.from
      ? `**Full changelog:** ${server}/${input.repo}/compare/${input.from}...${input.to}`
      : `**Full changelog:** ${server}/${input.repo}/commits/${input.to}`,
  );
  return `${lines.join('\n')}\n`;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      to: { type: 'string', default: 'HEAD' },
      from: { type: 'string' },
      repo: { type: 'string', default: process.env.GITHUB_REPOSITORY ?? 'owner/repo' },
      output: { type: 'string' },
      heading: { type: 'boolean', default: false },
      intro: { type: 'string' },
    },
  });
  const to = values.to ?? 'HEAD';
  const from = values.from ?? previousTag(to);
  const markdown = renderChangelog({
    commits: collectCommits(from, to),
    repo: values.repo ?? 'owner/repo',
    from,
    to,
    heading: values.heading ? { date: new Date().toISOString().slice(0, 10) } : undefined,
    intro:
      values.intro && existsSync(values.intro) ? readFileSync(values.intro, 'utf8') : undefined,
    serverUrl: process.env.GITHUB_SERVER_URL,
  });
  if (values.output) writeFileSync(values.output, markdown);
  else process.stdout.write(markdown);
}
