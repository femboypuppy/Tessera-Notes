import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Windows' default path limit is 260 characters, and Git for Windows keeps it unless
 * `core.longpaths` is set. The Notion fixture keeps Notion's real names (a title and a 32-character
 * ID per level), so its deepest file is 184 characters inside the repository: a clone works in a
 * folder of up to 75 characters, and CONTRIBUTING.md explains `core.longpaths` for deeper ones.
 * New paths must not push that limit lower (#11).
 */
const MAX_TRACKED_PATH = 184;

describe('the repository', () => {
  it(`keeps every tracked path within ${MAX_TRACKED_PATH} characters, for clones on Windows`, () => {
    const paths = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    expect(paths.length).toBeGreaterThan(100);
    expect(paths.filter((file) => file.length > MAX_TRACKED_PATH)).toEqual([]);
  });

  it('tells contributors on Windows how to clone into a deep folder', () => {
    const contributing = readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');
    expect(contributing).toContain('core.longpaths');
  });
});
