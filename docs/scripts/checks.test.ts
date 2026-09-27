/**
 * Checks for the files the docs team owns that no other test covers:
 *
 * - the GitHub issue forms are valid YAML with the structure GitHub requires;
 * - the demo workspace is valid markdown and CSV, and every wikilink in it resolves;
 * - the brand colors come from the design tokens, and the logo keeps its leaf legible.
 *
 * Run with `pnpm --dir docs test`. `pnpm --dir docs build` runs them first.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import {
  brandColorsFromTokens,
  markSvg,
  markTones,
  mixColors,
  tilePath,
  TILES,
  type MarkVariant,
} from './brand.ts';
import { parseCsv } from './csv.ts';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const formsDir = path.join(repoDir, '.github', 'ISSUE_TEMPLATE');
const demoDir = path.join(repoDir, 'examples', 'demo-workspace');

function parseYaml(source: string, file: string): unknown {
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: true });
  assert.deepEqual(
    document.errors.map((error) => error.message),
    [],
    `${file} is not valid YAML`,
  );
  return document.toJS();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('issue forms', () => {
  const FORM_KEYS = [
    'name',
    'description',
    'title',
    'labels',
    'assignees',
    'projects',
    'type',
    'body',
  ];
  const ELEMENT_TYPES = ['markdown', 'textarea', 'input', 'dropdown', 'checkboxes'];
  const forms = readdirSync(formsDir).filter(
    (name) => name.endsWith('.yml') && name !== 'config.yml',
  );

  it('has a bug report, a feature request and a question form', () => {
    assert.deepEqual(forms.sort(), ['bug_report.yml', 'feature_request.yml', 'question.yml']);
  });

  for (const name of forms) {
    it(`${name} is a valid issue form`, () => {
      const form = parseYaml(readFileSync(path.join(formsDir, name), 'utf8'), name);
      assert.ok(isRecord(form), 'the top level is a mapping');
      for (const key of Object.keys(form)) assert.ok(FORM_KEYS.includes(key), `unknown key ${key}`);
      assert.ok(nonEmptyString(form.name), 'name');
      assert.ok(nonEmptyString(form.description), 'description');
      assert.ok(Array.isArray(form.body) && form.body.length > 0, 'body is a non-empty list');
      const ids = new Set<string>();
      let inputs = 0;
      for (const element of form.body) {
        assert.ok(isRecord(element), 'each body element is a mapping');
        assert.ok(
          ELEMENT_TYPES.includes(String(element.type)),
          `unknown type ${String(element.type)}`,
        );
        assert.ok(isRecord(element.attributes), `${String(element.type)} has attributes`);
        const attributes = element.attributes;
        if (element.type === 'markdown') {
          assert.ok(nonEmptyString(attributes.value), 'markdown has a value');
          assert.equal(element.id, undefined, 'markdown elements take no id');
          continue;
        }
        inputs += 1;
        assert.ok(nonEmptyString(element.id) && /^[a-z0-9_-]+$/i.test(element.id), 'id');
        assert.ok(!ids.has(element.id), `duplicate id ${element.id}`);
        ids.add(element.id);
        assert.ok(nonEmptyString(attributes.label), `${element.id} has a label`);
        if (element.type === 'dropdown') {
          const options = attributes.options;
          assert.ok(Array.isArray(options) && options.length > 0, `${element.id} has options`);
          assert.ok(options.every(nonEmptyString), `${element.id} options are strings`);
          assert.equal(new Set(options).size, options.length, `${element.id} options are unique`);
        }
        if (element.type === 'checkboxes') {
          const options = attributes.options;
          assert.ok(Array.isArray(options) && options.length > 0, `${element.id} has options`);
          for (const option of options) {
            assert.ok(
              isRecord(option) && nonEmptyString(option.label),
              `${element.id} option label`,
            );
          }
        }
        if (element.validations !== undefined) {
          assert.ok(isRecord(element.validations), 'validations is a mapping');
          assert.equal(typeof element.validations.required, 'boolean');
        }
      }
      assert.ok(inputs > 0, 'the form asks at least one question');
    });
  }

  it('config.yml points to Discussions and private security reports', () => {
    const config = parseYaml(readFileSync(path.join(formsDir, 'config.yml'), 'utf8'), 'config.yml');
    assert.ok(isRecord(config));
    assert.equal(typeof config.blank_issues_enabled, 'boolean');
    assert.ok(Array.isArray(config.contact_links) && config.contact_links.length > 0);
    for (const link of config.contact_links) {
      assert.ok(isRecord(link) && nonEmptyString(link.name) && nonEmptyString(link.about));
      assert.match(
        String(link.url),
        /^https:\/\/(github\.com\/femboypuppy\/Tessera-Notes\/|femboypuppy\.github\.io\/Tessera-Notes\/)/,
      );
    }
    const urls = config.contact_links.map((link: unknown) => (isRecord(link) ? link.url : ''));
    assert.ok(urls.some((url) => String(url).endsWith('/discussions')));
    assert.ok(urls.some((url) => String(url).includes('/security/advisories/new')));
  });
});

interface Page {
  file: string;
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
  headings: string[];
}

function readPage(file: string): Page {
  const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  const frontmatter = match?.[1] ? parseYaml(match[1], file) : {};
  assert.ok(isRecord(frontmatter), `${file}: frontmatter is a mapping`);
  const body = match ? source.slice(match[0].length) : source;
  const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => (m[1] ?? '').trim());
  return { file, name: path.basename(file, '.md'), frontmatter, body, headings };
}

/** Removes fenced code blocks and inline code, where `[[` and `|` are literal text. */
function withoutCode(markdown: string): string {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, '').replace(/`[^`\n]*`/g, '``');
}

describe('demo workspace', () => {
  const files = walk(demoDir);
  const relative = (file: string) => path.relative(demoDir, file).replaceAll(path.sep, '/');
  const pages = files.filter((file) => file.endsWith('.md')).map(readPage);
  const csvFiles = files.filter((file) => file.endsWith('.csv'));
  const attachments = files.filter((file) => /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(file));
  const folders = new Set(
    files.flatMap((file) => path.dirname(relative(file)).split('/')).filter((d) => d !== '.'),
  );

  it('has about 40 pages and databases, with no unexpected files', () => {
    assert.ok(
      pages.length + csvFiles.length >= 40,
      `${pages.length} pages, ${csvFiles.length} CSVs`,
    );
    const unexpected = files.filter(
      (file) => !file.endsWith('.md') && !file.endsWith('.csv') && !attachments.includes(file),
    );
    assert.deepEqual(unexpected.map(relative), []);
  });

  it('has the pages the onboarding and the docs promise', () => {
    const names = new Set(pages.map((page) => page.name));
    for (const required of [
      'Welcome to Tessera',
      'Keyboard shortcuts',
      'Every block type',
      'Space exploration',
    ]) {
      assert.ok(names.has(required), `missing ${required}`);
    }
    const csvNames = csvFiles.map((file) => path.basename(file, '.csv')).sort();
    assert.deepEqual(csvNames, ['Projects', 'Reading list']);
    assert.ok(folders.has('Meeting notes') && folders.has('Knowledge garden'));
  });

  it('has unique page names, so every wikilink is unambiguous', () => {
    const names = [...pages.map((p) => p.name), ...csvFiles.map((f) => path.basename(f, '.csv'))];
    const lower = names.map((name) => name.toLowerCase());
    assert.equal(new Set(lower).size, lower.length);
  });

  it('uses only the frontmatter the importer understands, with valid tags and aliases', () => {
    for (const page of pages) {
      const { tags, aliases } = page.frontmatter;
      for (const [key, value] of [
        ['tags', tags],
        ['aliases', aliases],
      ] as const) {
        if (value === undefined) continue;
        assert.ok(Array.isArray(value) && value.every(nonEmptyString), `${page.name}: ${key}`);
      }
      if (Array.isArray(tags)) {
        for (const tag of tags) assert.match(String(tag), /^[\p{L}\p{N}_/-]+$/u, page.name);
      }
    }
  });

  it('has valid markdown structure: closed code fences, toggles, tables and callouts', () => {
    const CALLOUTS = [
      'note',
      'info',
      'tip',
      'success',
      'warning',
      'danger',
      'quote',
      'faq',
      'example',
      'question',
    ];
    for (const page of pages) {
      const fences = page.body.match(/^```/gm) ?? [];
      assert.equal(fences.length % 2, 0, `${page.name}: unclosed code fence`);
      const text = withoutCode(page.body);
      const open = (text.match(/<details>/g) ?? []).length;
      assert.equal(open, (text.match(/<\/details>/g) ?? []).length, `${page.name}: <details>`);
      assert.equal(open, (text.match(/<summary>[^<]+<\/summary>/g) ?? []).length, page.name);
      for (const match of text.matchAll(/^> \[!([a-z]+)\][+-]?/gm)) {
        assert.ok(CALLOUTS.includes(match[1] ?? ''), `${page.name}: callout type ${match[1]}`);
      }
      const lines = text.replace(/\[\[[^\]]*\]\]/g, 'link').split('\n');
      let columns = 0;
      for (const [index, line] of lines.entries()) {
        if (!line.startsWith('|')) {
          columns = 0;
          continue;
        }
        const cells = line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|').length;
        if (columns === 0) {
          columns = cells;
          assert.match(
            lines[index + 1] ?? '',
            /^\|(\s*:?-+:?\s*\|)+$/,
            `${page.name}: table header`,
          );
        }
        assert.equal(cells, columns, `${page.name}: table row "${line}"`);
      }
      assert.doesNotMatch(page.body, /lorem ipsum/i, page.name);
    }
  });

  it('resolves every wikilink, heading link and embed', () => {
    const targets = new Map<string, Page | 'database' | 'folder'>();
    for (const page of pages) targets.set(page.name.toLowerCase(), page);
    for (const file of csvFiles) targets.set(path.basename(file, '.csv').toLowerCase(), 'database');
    for (const folder of folders) targets.set(folder.toLowerCase(), 'folder');
    for (const page of pages) {
      const aliases = page.frontmatter.aliases;
      if (!Array.isArray(aliases)) continue;
      for (const alias of aliases) {
        const key = String(alias).toLowerCase();
        assert.ok(!targets.has(key) || targets.get(key) === page, `alias "${alias}" is ambiguous`);
        targets.set(key, page);
      }
    }
    const attachmentNames = new Set(attachments.map((file) => path.basename(file).toLowerCase()));
    let links = 0;
    for (const page of pages) {
      for (const match of withoutCode(page.body).matchAll(
        /(!?)\[\[([^\]|#]+)(#[^\]|]+)?(\|[^\]]+)?\]\]/g,
      )) {
        links += 1;
        const [, embed, rawTarget = '', heading] = match;
        const target = rawTarget.trim().toLowerCase();
        if (embed && /\.[a-z0-9]+$/.test(target)) {
          assert.ok(attachmentNames.has(target), `${page.name}: missing attachment ${rawTarget}`);
          continue;
        }
        const resolved = targets.get(target);
        assert.ok(resolved, `${page.name}: [[${rawTarget}]] doesn't resolve`);
        if (heading && typeof resolved === 'object') {
          const wanted = heading.slice(1).trim().toLowerCase();
          assert.ok(
            resolved.headings.some((h) => h.toLowerCase() === wanted),
            `${page.name}: [[${rawTarget}${heading}]] has no such heading`,
          );
        }
      }
    }
    assert.ok(links > 200, `a richly linked workspace (${links} links)`);
  });

  it('links every knowledge-garden note to at least two others', () => {
    const garden = pages.filter((page) => relative(page.file).startsWith('Knowledge garden/'));
    assert.ok(garden.length >= 25, `${garden.length} garden notes`);
    for (const page of garden) {
      const outgoing = new Set(
        [...page.body.matchAll(/\[\[([^\]|#]+)/g)].map((m) => (m[1] ?? '').toLowerCase()),
      );
      outgoing.delete(page.name.toLowerCase());
      assert.ok(outgoing.size >= 2, `${page.name} links to ${outgoing.size} notes`);
    }
  });

  for (const file of csvFiles) {
    it(`${path.basename(file)} is valid CSV with typed columns`, () => {
      const rows = parseCsv(readFileSync(file, 'utf8'));
      const [header, ...records] = rows;
      assert.ok(header && records.length >= 10, 'a header and at least 10 rows');
      assert.ok(header.every(nonEmptyString), 'every column has a name');
      assert.equal(new Set(header).size, header.length, 'column names are unique');
      for (const record of records) assert.equal(record.length, header.length, record.join(','));
      const titles = records.map((record) => record[0]);
      assert.ok(titles.every(nonEmptyString), 'every row has a title');
      assert.equal(new Set(titles).size, titles.length, 'titles are unique');
      header.forEach((column, index) => {
        const values = records.map((record) => record[index] ?? '').filter((value) => value !== '');
        if (values.some((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) {
          for (const value of values) {
            assert.match(value, /^\d{4}-\d{2}-\d{2}$/, `${column}: ${value}`);
            assert.ok(!Number.isNaN(Date.parse(`${value}T00:00:00Z`)), `${column}: ${value}`);
          }
        }
        if (values.some((value) => value === 'true' || value === 'false')) {
          assert.ok(
            values.every((value) => value === 'true' || value === 'false'),
            column,
          );
        }
      });
    });
  }
});

describe('csv parser', () => {
  it('parses quotes, doubled quotes and commas inside quotes', () => {
    assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n'), [
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  it('rejects malformed quoting', () => {
    assert.throws(() => parseCsv('a,b\n"x"y,z\n'));
    assert.throws(() => parseCsv('a,b\nx"y,z\n'));
    assert.throws(() => parseCsv('a,b\n"open,z\n'));
  });
});

/** WCAG relative luminance of a `#rrggbb` color. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

describe('brand', () => {
  const tokens = readFileSync(path.join(repoDir, 'packages/ui/src/styles/tokens.css'), 'utf8');
  const colors = brandColorsFromTokens(tokens);

  it('takes its colors from the design tokens', () => {
    assert.equal(
      colors.accent,
      /--tess-accent:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1]?.toLowerCase(),
    );
    assert.match(colors.fgDark, /^#[0-9a-f]{6}$/);
    assert.notEqual(colors.fgLight, colors.fgDark);
    assert.notEqual(colors.accentTextLight, colors.accentTextDark);
  });

  it('draws a leaf: quarter-round tiles on one diagonal, squares on the other', () => {
    assert.deepEqual(
      TILES.map((tile) => `${tile.col}${tile.row} ${tile.shape} ${tile.tone}`),
      ['00 quarter leaf', '10 square tile', '01 square tile', '11 quarter leaf'],
    );
    assert.equal(markSvg(colors, 32, 'light').match(/<path /g)?.length, 4);
  });

  it('keeps the leaf the stronger tone on every background, so it never reads as four squares', () => {
    // At 16 px the mark must not look like a 2×2 of equal squares. The first proposal (tones 1.8:1
    // apart, the squares brighter than the leaf in the dark theme) did.
    const cases: [MarkVariant, string][] = [
      ['light', colors.bgLight],
      ['dark', colors.bgDark],
      ['dark', '#0d1117'], // GitHub's dark theme (the README)
      ['universal', colors.bgLight],
      ['universal', colors.bgDark],
    ];
    for (const [variant, background] of cases) {
      const tones = markTones(colors, variant);
      const tile = mixColors(tones.tile, background, tones.tileOpacity);
      const where = `${variant} on ${background}`;
      assert.ok(contrast(tones.leaf, background) > contrast(tile, background), where);
      assert.ok(contrast(tones.leaf, tile) >= 1.85, `${where}: the tones are too close`);
      assert.ok(contrast(tile, background) >= 1.4, `${where}: the squares disappear`);
    }
  });

  it('matches the committed logos', () => {
    const committed = (name: string) =>
      readFileSync(path.join(repoDir, 'assets/brand', name), 'utf8').trim();
    assert.equal(committed('logo-mark.svg'), markSvg(colors, 64));
    assert.equal(committed('logo-mark-light.svg'), markSvg(colors, 64, 'light'));
    assert.equal(committed('logo-mark-dark.svg'), markSvg(colors, 64, 'dark'));
    assert.equal(committed('favicon.svg'), markSvg(colors, 32));
  });

  it("matches the app's LogoMark", () => {
    const source = readFileSync(path.join(repoDir, 'apps/web/src/app/LogoMark.tsx'), 'utf8');
    const drawn = [...source.matchAll(/tone: '(leaf|tile)',\s*d: '([^']+)'/g)].map(
      ([, tone, d]) => `${tone} ${d}`,
    );
    assert.deepEqual(
      drawn,
      TILES.map((tile) => `${tile.tone} ${tilePath(tile)}`),
    );
  });
});
