import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectCommits,
  escapeMentions,
  hardWrappedLines,
  previousTag,
  renderChangelog,
  unwrapMarkdown,
} from './changelog.ts';

const sha = (n: number) => String(n).repeat(40).slice(0, 40);

describe('renderChangelog', () => {
  it('groups commits into sections, highlights breaking changes and links everything', () => {
    const markdown = renderChangelog({
      repo: 'tessera/tessera',
      from: 'v0.1.0',
      to: 'v0.2.0',
      commits: [
        { sha: sha(1), message: 'feat(editor): add a slash menu (#12)' },
        { sha: sha(2), message: 'fix: keep focus after undo' },
        {
          sha: sha(3),
          message: 'feat(core)!: rename page helpers\n\nBREAKING CHANGE: createPage is now addPage',
        },
        { sha: sha(4), message: 'build(deps): bump vitest from 5.0.1 to 5.0.2' },
        { sha: sha(5), message: 'ci: cache browsers' },
        { sha: sha(6), message: "Merge branch 'main' into feat/x" },
        { sha: sha(7), message: 'Tweak things' },
      ],
    });
    const link = (n: number) =>
      `([\`${sha(n).slice(0, 7)}\`](https://github.com/tessera/tessera/commit/${sha(n)}))`;
    expect(markdown).toBe(
      [
        '### ⚠ Breaking changes',
        '',
        `- **core:** createPage is now addPage ${link(3)}`,
        '',
        '### Features',
        '',
        `- **editor:** add a slash menu (#12) ${link(1)}`,
        `- **core:** rename page helpers ${link(3)}`,
        '',
        '### Bug fixes',
        '',
        `- keep focus after undo ${link(2)}`,
        '',
        '<details>',
        '<summary><strong>Maintenance</strong> (2)</summary>',
        '',
        `- **deps:** bump vitest from 5.0.1 to 5.0.2 ${link(4)}`,
        `- cache browsers ${link(5)}`,
        '',
        '</details>',
        '',
        '### Other changes',
        '',
        `- Tweak things ${link(7)}`,
        '',
        '**Full changelog:** https://github.com/tessera/tessera/compare/v0.1.0...v0.2.0',
        '',
      ].join('\n'),
    );
  });

  it('adds a heading for CHANGELOG.md and links all commits for a first release', () => {
    const markdown = renderChangelog({
      repo: 'o/r',
      from: null,
      to: 'v0.1.0',
      commits: [],
      heading: { date: '2026-09-23' },
    });
    expect(markdown).toBe(
      '## v0.1.0 (2026-09-23)\n\nNo changes.\n\n**Full changelog:** https://github.com/o/r/commits/v0.1.0\n',
    );
  });
});

describe('escapeMentions', () => {
  it('puts @-words in code so the notes mention nobody', () => {
    expect(escapeMentions('time the @perf specs alone')).toBe('time the `@perf` specs alone');
    expect(escapeMentions('@perf first, then @tessera/ui.')).toBe(
      '`@perf` first, then `@tessera/ui`.',
    );
    expect(escapeMentions('(@team) and @user-name')).toBe('(`@team`) and `@user-name`');
  });

  it('leaves code spans, email addresses and lone @ signs alone', () => {
    expect(escapeMentions('run `pnpm test --grep @perf` again')).toBe(
      'run `pnpm test --grep @perf` again',
    );
    expect(escapeMentions('mail maya@example.com')).toBe('mail maya@example.com');
    expect(escapeMentions('2 @ 3 and @@')).toBe('2 @ 3 and @@');
  });

  it('is applied to every entry of the notes', () => {
    const markdown = renderChangelog({
      repo: 'tessera/tessera',
      from: null,
      to: 'v0.1.0',
      commits: [{ sha: sha(1), message: 'ci(e2e): time the @perf specs alone' }],
    });
    expect(markdown).toContain('time the `@perf` specs alone');
    expect(markdown).not.toMatch(/[^`]@perf/);
  });
});

describe('unwrapMarkdown', () => {
  const wrapped = [
    '**Lead.** It wraps',
    'onto a second line.',
    '',
    '### Highlights',
    '',
    '- **One.** A list item that',
    '  continues here.',
    '  - A nested item',
    '    that wraps too.',
    '- Two.',
    '',
    '| System | File |',
    '| --- | --- |',
    '| Linux | `a.AppImage` |',
    '',
    '```sh',
    'docker pull x',
    'docker run y',
    '```',
    '> A quote',
    '> on two lines.',
  ].join('\n');

  it('puts every paragraph and list item on one line, and leaves the other blocks alone', () => {
    expect(unwrapMarkdown(wrapped)).toBe(
      [
        '**Lead.** It wraps onto a second line.',
        '',
        '### Highlights',
        '',
        '- **One.** A list item that continues here.',
        '  - A nested item that wraps too.',
        '- Two.',
        '',
        '| System | File |',
        '| --- | --- |',
        '| Linux | `a.AppImage` |',
        '',
        '```sh',
        'docker pull x',
        'docker run y',
        '```',
        '> A quote',
        '> on two lines.',
      ].join('\n'),
    );
  });

  it('names the wrapped lines, and finds none once unwrapped', () => {
    expect(hardWrappedLines(wrapped)).toEqual([2, 7, 9]);
    expect(hardWrappedLines(unwrapMarkdown(wrapped))).toEqual([]);
  });
});

describe('release notes in this repository', () => {
  const dir = path.resolve(import.meta.dirname, '../../.github/releases');
  const version = (name: string) =>
    name
      .replace(/^v|\.md$/g, '')
      .split('.')
      .map(Number);
  const atLeast = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i += 1)
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
  };
  // From 0.1.2 on: GitHub's release page shows every newline as a line break.
  const files = readdirSync(dir).filter(
    (name) => /^v\d+\.\d+\.\d+\.md$/.test(name) && atLeast(version(name), [0, 1, 2]),
  );

  it.each(files)('%s has every paragraph and list item on one line', (name) => {
    const lines = hardWrappedLines(readFileSync(path.join(dir, name), 'utf8'));
    expect(lines, `wrapped lines (run unwrapMarkdown over the file): ${lines.join(', ')}`).toEqual(
      [],
    );
  });
});

describe('collectCommits and previousTag', () => {
  let repo = '';
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    });
  const commit = (message: string) => {
    writeFileSync(path.join(repo, 'file.txt'), message);
    git('add', 'file.txt');
    git('commit', '-q', '--no-verify', '-m', message);
  };

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'tessera-changelog-'));
    git('init', '-q', '-b', 'main');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    commit('chore: start');
    git('tag', 'v0.1.0');
    commit('feat: add x');
    commit('fix: repair x\n\nWith a body.');
    git('tag', 'v0.2.0');
    // Twelve git processes: seconds on a busy Windows machine, past Vitest's 10 s hook default.
  }, 60_000);
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('finds the previous tag, or none for the first release', () => {
    expect(previousTag('v0.2.0', repo)).toBe('v0.1.0');
    expect(previousTag('v0.1.0', repo)).toBeNull();
  });

  it('lists the commits between two tags, newest first, with full messages', () => {
    const commits = collectCommits('v0.1.0', 'v0.2.0', repo);
    expect(commits.map((entry) => entry.message)).toEqual([
      'fix: repair x\n\nWith a body.',
      'feat: add x',
    ]);
    expect(commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(collectCommits(null, 'v0.1.0', repo).map((entry) => entry.message)).toEqual([
      'chore: start',
    ]);
  });
});
