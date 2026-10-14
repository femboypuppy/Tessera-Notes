import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  githubSlug,
  linkTargets,
  promisedScreenshots,
  readRepoFile,
  repoFileExists,
  repoPath,
} from './repo-files';

/**
 * The README and the other root documents must render correctly on GitHub: every relative link
 * and image resolves (no broken images), every anchor exists, and the README uses GitHub's
 * features the way the brief asks.
 */

const DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'LAUNCH.md',
  'BUILT_WITH_AGENTS.md',
];

const REPO_URL = 'https://github.com/femboypuppy/Tessera-Notes';

function isExternal(target: string): boolean {
  return /^(https?:|mailto:)/.test(target);
}

/** Heading slugs plus explicit `id`/`name` anchors, the way GitHub resolves `#fragment` links. */
function anchors(markdown: string): string[] {
  const headings = markdown
    .split('\n')
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => githubSlug(line.replace(/^#+\s*/, '')));
  const explicit = [...markdown.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)].map((m) => m[1] ?? '');
  return [...headings, ...explicit];
}

function section(markdown: string, start: string, end: string): string {
  const from = markdown.indexOf(start);
  const to = markdown.indexOf(end, from + start.length);
  expect(from, `section ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `section end ${end}`).toBeGreaterThan(from);
  return markdown.slice(from, to);
}

for (const file of DOCS) {
  test(`${file}: every relative link, image and anchor resolves`, () => {
    const markdown = readRepoFile(file);
    const known = anchors(markdown);
    const missing: string[] = [];
    for (const target of linkTargets(markdown)) {
      if (isExternal(target)) continue;
      if (target.startsWith('#')) {
        if (!known.includes(target.slice(1))) missing.push(target);
        continue;
      }
      const relative = decodeURIComponent(target.split(/[?#]/)[0] ?? '').replace(/^\.\//, '');
      const base = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
      if (!repoFileExists(`${base}${relative}`.replace(/\/$/, ''))) missing.push(target);
    }
    expect(missing).toEqual([]);
  });
}

test('README: every image has alt text and an explicit width', () => {
  const readme = readRepoFile('README.md');
  // No markdown-syntax images: they can't carry a width.
  expect(readme.replace(/```[\s\S]*?```/g, '')).not.toMatch(/!\[[^\]]*\]\(/);
  const images = [...readme.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
  expect(images.length).toBeGreaterThan(20);
  for (const image of images) {
    expect(image, image).toMatch(/\balt="[^"]{3,}"/);
    expect(image, image).toMatch(/\bwidth="\d+"/);
  }
});

test('README: repo images use relative paths, and light/dark pictures come in pairs', () => {
  const readme = readRepoFile('README.md');
  expect(readme).not.toContain(`${REPO_URL}/raw/`);
  expect(readme).not.toContain('raw.githubusercontent.com/femboypuppy/Tessera-Notes/main/assets');
  const pictures = [...readme.matchAll(/<picture>([\s\S]*?)<\/picture>/g)].map((m) => m[1] ?? '');
  expect(pictures.length).toBeGreaterThanOrEqual(8);
  for (const picture of pictures) {
    const dark = /media="\(prefers-color-scheme: dark\)" srcset="([^"]+)"/.exec(picture)?.[1];
    const fallback = /<img\b[^>]*\bsrc="([^"]+)"/.exec(picture)?.[1];
    expect(dark, picture).toBeTruthy();
    expect(fallback, picture).toBeTruthy();
    if (fallback && !isExternal(fallback)) {
      expect(repoFileExists(fallback), fallback).toBe(true);
      expect(repoFileExists(dark ?? ''), dark).toBe(true);
    }
  }
});

test('README top: centered logo, tagline, badges, quick links and the demo, kept short', () => {
  const readme = readRepoFile('README.md');
  const top = readme.slice(0, readme.indexOf('## Features'));
  expect(top).toMatch(/<p align="center">\s*<a [^>]+>\s*<picture>/);
  expect(top).toContain('srcset="assets/brand/wordmark-dark.svg"');
  expect(top).toContain('src="assets/brand/wordmark-light.svg"');
  // "Tessera Notes" tells the project apart from others named Tessera; the product is Tessera.
  expect(top).toContain('<h1 align="center">Tessera Notes</h1>');
  expect(top).toContain("Notion's power, Obsidian's freedom.");
  for (const badge of [
    'img.shields.io/github/stars/femboypuppy/Tessera-Notes',
    'img.shields.io/github/forks/femboypuppy/Tessera-Notes',
    'img.shields.io/github/v/release/femboypuppy/Tessera-Notes',
    'img.shields.io/github/downloads/femboypuppy/Tessera-Notes/total',
    'img.shields.io/github/actions/workflow/status/femboypuppy/Tessera-Notes/ci.yml',
    'img.shields.io/github/license/femboypuppy/Tessera-Notes',
    'img.shields.io/badge/docker-ghcr.io',
    'img.shields.io/github/last-commit/femboypuppy/Tessera-Notes',
    'img.shields.io/github/issues/femboypuppy/Tessera-Notes',
    'img.shields.io/github/contributors/femboypuppy/Tessera-Notes',
    'img.shields.io/github/discussions/femboypuppy/Tessera-Notes',
  ]) {
    expect(top).toContain(badge);
  }
  for (const link of ['Docs', 'Download', 'Self-host', 'Plugins', 'Roadmap', 'Discussions']) {
    expect(top).toContain(`<strong>${link}</strong></a>`);
  }
  expect(top).toMatch(/<p align="center">\s*<img src="assets\/demo\.gif"[^>]*width="800"/);
  // The real recording (scripts/record-demo), no placeholder left.
  expect(top).not.toMatch(/placeholder|coming soon/i);
  // Scannable: the prose above the features stays short.
  const prose = top
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .filter((line) => line.trim() !== '');
  expect(prose.length).toBeLessThanOrEqual(30);
});

test('the demo is an animated GIF under 8 MB, with an MP4 of it', () => {
  const gif = readFileSync(repoPath('assets/demo.gif'));
  expect(['GIF87a', 'GIF89a']).toContain(gif.subarray(0, 6).toString('ascii'));
  expect(gif.length).toBeLessThanOrEqual(8 * 1024 * 1024);
  // Each frame starts with a graphic control extension (0x21 0xF9 0x04).
  let frames = 0;
  for (let index = gif.indexOf(0x21); index >= 0; index = gif.indexOf(0x21, index + 1)) {
    if (gif[index + 1] === 0xf9 && gif[index + 2] === 0x04) frames += 1;
  }
  expect(frames).toBeGreaterThan(100);
  const mp4 = readFileSync(repoPath('assets/demo.mp4'));
  expect(mp4.subarray(4, 8).toString('ascii')).toBe('ftyp');
});

test('README: table of contents and back-to-top links', () => {
  const readme = readRepoFile('README.md');
  const toc = section(
    readme,
    '<summary><strong>Table of contents</strong></summary>',
    '</details>',
  );
  const headings = readme
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => githubSlug(line.slice(3)));
  const linked = [...toc.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  expect(linked).toEqual(headings);
  expect(readme).toContain('<a id="readme-top"></a>');
  const backToTop = readme.match(/<a href="#readme-top">back to top ↑<\/a>/g) ?? [];
  expect(backToTop.length).toBeGreaterThanOrEqual(5);
});

test('README: GitHub alerts, collapsible sections and a Mermaid diagram', () => {
  const readme = readRepoFile('README.md');
  for (const alert of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING']) {
    expect(readme).toMatch(new RegExp(`^> \\[!${alert}\\]\\n> \\S`, 'm'));
  }
  for (const summary of ['All install methods', 'The full feature list', 'Is Tessera free?']) {
    expect(readme).toContain(`<summary><strong>${summary}</strong></summary>`);
  }
  // GitHub renders markdown inside HTML blocks only with blank lines around it.
  for (const details of readme.matchAll(
    /<details>\n<summary>.*<\/summary>\n([\s\S]*?)<\/details>/g,
  )) {
    const body = details[1] ?? '';
    expect(body.startsWith('\n'), details[0].slice(0, 80)).toBe(true);
    expect(body.endsWith('\n\n'), details[0].slice(0, 80)).toBe(true);
  }
  expect(readme).toMatch(/^```mermaid\nflowchart /m);
});

test('README: every code block has a language, and quickstart blocks stay short', () => {
  const readme = readRepoFile('README.md');
  const fences = readme.match(/^```.*$/gm) ?? [];
  const openings = fences.filter((_, index) => index % 2 === 0);
  expect(openings.length).toBeGreaterThanOrEqual(4);
  for (const opening of openings) expect(opening).toMatch(/^```[a-z]+$/);
  const quickstart = section(readme, '## Quickstart', '## How it works');
  const blocks = [...quickstart.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
  expect(blocks.length).toBeGreaterThanOrEqual(3);
  for (const block of blocks) {
    expect(block.split('\n').filter((line) => line.trim() !== '').length).toBeLessThanOrEqual(4);
  }
});

test('the comparison table is dated, uses ✅ ⚠️ ❌ and covers every product and criterion', () => {
  const readme = readRepoFile('README.md');
  const table = section(readme, '## How Tessera compares', '## Roadmap');
  expect(table).toMatch(/Last checked \*\*\d{4}-\d{2}-\d{2}\*\*/);
  const header = table.split('\n').find((line) => line.startsWith('|') && line.includes('Notion'));
  for (const product of ['Tessera', 'Notion', 'Obsidian', 'Anytype', 'AFFiNE', 'Logseq']) {
    expect(header).toContain(product);
  }
  for (const row of [
    'Open source',
    'Local-first',
    'Self-hostable',
    'Real-time collaboration',
    'Databases',
    'Plugins',
    'Graph view',
    'Price',
  ]) {
    expect(table).toMatch(new RegExp(`^\\| ${row}`, 'm'));
  }
  for (const mark of ['✅', '⚠️', '❌']) expect(table).toContain(mark);
  // Notes sit right under the table (GFM footnotes would render at the end of the README).
  const used = new Set([...table.matchAll(/<sup>(\d+)<\/sup>/g)].map((match) => Number(match[1])));
  const notes = section(table, '**Notes**', 'Prices are');
  const defined = [...notes.matchAll(/^(\d+)\. \S/gm)].map((match) => Number(match[1]));
  expect(defined).toEqual(defined.map((_, index) => index + 1));
  expect([...used].sort((a, b) => a - b)).toEqual(defined);
  expect(readme).not.toMatch(/\[\^[a-z-]+\]/);
});

test('README: star history with a dark variant, contributors and the footer', () => {
  const readme = readRepoFile('README.md');
  const stars = section(readme, '## Star history', '## Acknowledgements');
  expect(stars).toContain('⭐');
  expect(stars).toContain(
    'api.star-history.com/svg?repos=femboypuppy/Tessera-Notes&type=Date&theme=dark',
  );
  expect(stars).toMatch(/<source media="\(prefers-color-scheme: dark\)"/);
  expect(readme).toContain('contrib.rocks/image?repo=femboypuppy/Tessera-Notes');
  const footer = readme.slice(readme.indexOf('## License and contact'));
  expect(footer).toContain('[MIT License](LICENSE)');
  expect(footer).toContain('[BUILT_WITH_AGENTS.md](BUILT_WITH_AGENTS.md)');
  expect(footer).toContain('mailto:femboypuppy@tutanota.de');
});

test('the Code of Conduct names the contact email', () => {
  const conduct = readRepoFile('CODE_OF_CONDUCT.md');
  expect(conduct).toContain('[femboypuppy@tutanota.de](mailto:femboypuppy@tutanota.de)');
  expect(conduct).not.toMatch(/address on their GitHub profile/);
});

test('the merge-time showcase in HANDOFF only uses screenshots other agents promise', () => {
  const handoff = readRepoFile('HANDOFF/docs.md');
  const snippet = section(handoff, '<!-- merge-showcase:start -->', '<!-- merge-showcase:end -->');
  const promised = promisedScreenshots();
  const shots = [
    ...snippet.matchAll(/assets\/screenshots\/([a-z]+)\/([a-z0-9-]+)-(light|dark)\.png/g),
  ];
  expect(shots.length).toBeGreaterThanOrEqual(12);
  for (const [path, area = '', name = ''] of shots) {
    expect(promised.get(area)?.has(name), path).toBe(true);
  }
});
