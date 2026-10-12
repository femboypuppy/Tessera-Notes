import { validateDocJSON, type AnyNodeJSON, type DocJSON } from '@tessera/core';
import { describe, expect, it } from 'vitest';
import { createMarkdownCodec } from './codec';

const codec = createMarkdownCodec();

const PAGES: Record<string, string> = {
  apollo: 'Apollo 11',
  plan: 'Launch plan',
  tasks: 'Tasks',
  cafe: 'Café crème',
};
const resolvePageLink = (target: string) =>
  Object.keys(PAGES).find(
    (id) =>
      PAGES[id]?.toLowerCase() === target.replace(/\.md$/i, '').replace(/^.*\//, '').toLowerCase(),
  ) ?? null;
const resolvePage = (id: string) => (PAGES[id] ? { title: PAGES[id] } : null);
const ASSETS: Record<string, string> = {
  'diagram.png': 'asset-diagram',
  'attachments/diagram.png': 'asset-diagram',
  'Launch plan/moon photo.jpg': 'asset-moon',
  'plan.pdf': 'asset-pdf',
};
const resolveAsset = (path: string) => ASSETS[path] ?? null;

function parse(markdown: string, options: Parameters<typeof codec.parse>[1] = {}) {
  const result = codec.parse(markdown, { resolvePageLink, resolveAsset, ...options });
  expect(validateDocJSON(result.doc).ok).toBe(true);
  return { ...result, content: result.doc.content as AnyNodeJSON[] };
}

function blocks(markdown: string, options: Parameters<typeof codec.parse>[1] = {}): AnyNodeJSON[] {
  return parse(markdown, options).doc.content as AnyNodeJSON[];
}

function inline(markdown: string): AnyNodeJSON[] {
  return blocks(markdown)[0]?.content ?? [];
}

describe('parse: Obsidian syntax', () => {
  it('turns wikilinks into page links with alias, heading and block parts', () => {
    const content = inline(
      'See [[Apollo 11]], [[Launch plan|the plan]], [[Launch plan#Countdown]], [[Launch plan#^step-1]] and [[Apollo 11^crew]].',
    );
    const links = content.filter((node) => node.type === 'pageLink').map((node) => node.attrs);
    expect(links).toEqual([
      { pageId: 'apollo', label: null, heading: null, blockRef: null },
      { pageId: 'plan', label: 'the plan', heading: null, blockRef: null },
      { pageId: 'plan', label: null, heading: 'Countdown', blockRef: null },
      { pageId: 'plan', label: null, heading: null, blockRef: 'step-1' },
      { pageId: 'apollo', label: null, heading: null, blockRef: 'crew' },
    ]);
  });

  it('keeps unresolved wikilinks as literal text and warns', () => {
    const { doc, warnings } = parse('A [[Missing note|alias]] here');
    expect(doc.content[0]).toMatchObject({
      content: [{ type: 'text', text: 'A [[Missing note|alias]] here' }],
    });
    expect(warnings).toContain('Unresolved link: [[Missing note|alias]]');
  });

  it('respects escapes: an escaped wikilink stays text without a warning', () => {
    const { content, warnings } = parse('\\[\\[Apollo 11]] and `[[Apollo 11]]`');
    expect(content[0]?.content?.some((node) => node.type === 'pageLink')).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('resolves wikilinks inside tables, where the alias separator is escaped', () => {
    const [table] = blocks('| Mission | Doc |\n| - | - |\n| One | [[Launch plan\\|plan]] |');
    const cell = table?.content?.[1]?.content?.[1];
    expect(cell?.content?.[0]?.content?.[0]).toMatchObject({
      type: 'pageLink',
      attrs: { pageId: 'plan', label: 'plan' },
    });
  });

  it('embeds images, files, databases and notes', () => {
    const result = blocks('![[diagram.png]]\n\n![[plan.pdf]]\n\n![[Tasks]]\n\n![[Apollo 11]]', {
      isDatabase: (id) => id === 'tasks',
    });
    expect(result[0]).toMatchObject({ type: 'image', attrs: { assetId: 'asset-diagram' } });
    expect(result[1]).toMatchObject({
      type: 'embed',
      attrs: { kind: 'file', ref: 'asset-pdf', data: { name: 'plan.pdf' } },
    });
    expect(result[2]).toMatchObject({
      type: 'embed',
      attrs: { kind: 'database', ref: 'tasks', data: { viewId: null } },
    });
    expect(result[3]).toMatchObject({
      type: 'paragraph',
      content: [{ type: 'pageLink', attrs: { pageId: 'apollo' } }],
    });
  });

  it('parses tags after whitespace only, including nested tags and unicode', () => {
    const content = inline('#project/alpha and #café but not a#b, #123 or \\#escaped');
    expect(content.filter((node) => node.type === 'tag').map((node) => node.attrs?.name)).toEqual([
      'project/alpha',
      'café',
    ]);
    expect(content.map((node) => node.text ?? '').join('')).toContain('a#b, #123 or #escaped');
  });

  it('parses highlights and keeps equals signs elsewhere', () => {
    const content = inline('==marked== but a == b and \\=\\=not\\=\\=');
    expect(content[0]).toMatchObject({
      text: 'marked',
      marks: [{ type: 'highlight', attrs: { color: null } }],
    });
    expect(
      content
        .slice(1)
        .map((node) => node.text)
        .join(''),
    ).toBe(' but a == b and ==not==');
  });

  it('parses callouts, their titles, types, aliases and emoji metadata', () => {
    const result = blocks(
      '> [!warning] Fuel low\n> Check the gauges.\n\n> [!FAQ]\n> Why?\n\n> [!note|🚀] Launch\n\n> [!unknown-type]\n> Body',
    );
    expect(result[0]).toMatchObject({
      type: 'callout',
      attrs: { tone: 'warning', emoji: '⚠️' },
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Fuel low', marks: [{ type: 'bold' }] }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Check the gauges.' }] },
      ],
    });
    expect(result[1]).toMatchObject({ type: 'callout', attrs: { tone: 'warning', emoji: '❓' } });
    expect(result[2]).toMatchObject({ type: 'callout', attrs: { tone: 'default', emoji: '🚀' } });
    expect(result[3]).toMatchObject({ type: 'callout', attrs: { tone: 'default', emoji: '💡' } });
  });

  it('turns foldable callouts into a callout holding a toggle', () => {
    const [folded, open] = blocks('> [!tip]- Hidden tip\n> Secret\n\n> [!info]+ Shown\n> Text');
    expect(folded).toMatchObject({
      type: 'callout',
      attrs: { tone: 'success' },
      content: [
        {
          type: 'toggle',
          attrs: { open: false },
          content: [
            { type: 'toggleSummary', content: [{ type: 'text', text: 'Hidden tip' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Secret' }] },
          ],
        },
      ],
    });
    expect(open?.content?.[0]?.attrs?.open).toBe(true);
  });

  it('parses task lists, splitting mixed lists', () => {
    const result = blocks('- [ ] Pack\n- [x] Launch\n  - [ ] Subtask\n- Plain item');
    expect(result.map((block) => block.type)).toEqual(['taskList', 'bulletList']);
    expect(result[0]?.content?.map((item) => item.attrs?.checked)).toEqual([false, true]);
    expect(result[0]?.content?.[1]?.content?.[1]?.type).toBe('taskList');
  });

  it('parses block IDs on paragraphs, list items and after blocks', () => {
    const result = blocks(
      'A paragraph ^para-1\n\n- item ^item-1\n\n| a |\n| - |\n| 1 |\n\n^table-1',
    );
    expect(result[0]?.attrs?.blockId).toBe('para-1');
    expect(result[0]?.content).toEqual([{ type: 'text', text: 'A paragraph' }]);
    expect(result[1]?.content?.[0]?.attrs?.blockId).toBe('item-1');
    expect(result[2]).toMatchObject({ type: 'table', attrs: { blockId: 'table-1' } });
    expect(result).toHaveLength(3);
  });

  it('parses toggles written as <details>, with nesting and the open state', () => {
    const [toggle] = blocks(
      '<details open>\n<summary>More **info**</summary>\n\nBody\n\n<details>\n<summary>Inner</summary>\n\nDeep\n\n</details>\n\n</details>',
    );
    expect(toggle).toMatchObject({
      type: 'toggle',
      attrs: { open: true },
      content: [
        {
          type: 'toggleSummary',
          content: [{ text: 'More ' }, { text: 'info', marks: [{ type: 'bold' }] }],
        },
        { type: 'paragraph', content: [{ text: 'Body' }] },
        { type: 'toggle', attrs: { open: false } },
      ],
    });
  });

  it('turns Notion <aside> callouts back into callouts', () => {
    const [callout, after] = blocks('<aside>\n⚠️ Launch day is **soon**.\n\n</aside>\n\nAfter');
    expect(callout).toMatchObject({
      type: 'callout',
      attrs: { emoji: '⚠️', tone: 'warning' },
      content: [
        {
          type: 'paragraph',
          content: [
            { text: 'Launch day is ' },
            { text: 'soon', marks: [{ type: 'bold' }] },
            { text: '.' },
          ],
        },
      ],
    });
    expect(after).toMatchObject({ type: 'paragraph', content: [{ text: 'After' }] });
  });

  it('turns single line breaks into hard breaks, as Obsidian renders them', () => {
    expect(inline('one\ntwo')).toEqual([
      { type: 'text', text: 'one' },
      { type: 'hardBreak' },
      { type: 'text', text: 'two' },
    ]);
  });
});

describe('parse: markdown', () => {
  it('reads frontmatter as JSON (tags, aliases, nested values, dates as text)', () => {
    const { frontmatter, doc } = parse(
      '---\ntags: [space, history]\naliases:\n  - Apollo\ncreated: 2026-09-23\nmeta:\n  crew: 3\n---\n\n# Body',
    );
    expect(frontmatter).toEqual({
      tags: ['space', 'history'],
      aliases: ['Apollo'],
      created: '2026-09-23',
      meta: { crew: 3 },
    });
    expect(doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
  });

  it('warns about invalid frontmatter and keeps the body', () => {
    const { frontmatter, warnings, doc } = parse('---\ntags: [unclosed\n---\n\nText');
    expect(frontmatter).toEqual({});
    expect(warnings[0]).toMatch(/Invalid frontmatter/);
    expect(doc.content[0]).toMatchObject({ content: [{ text: 'Text' }] });
  });

  it('resolves relative markdown links (with %20) to page links', () => {
    const content = inline(
      '[the plan](../Missions/Launch%20plan.md#Countdown) and [site](https://example.com)',
    );
    expect(content[0]).toMatchObject({
      type: 'pageLink',
      attrs: { pageId: 'plan', label: 'the plan', heading: 'Countdown' },
    });
    expect(content[2]).toMatchObject({
      text: 'site',
      marks: [{ type: 'link', attrs: { href: 'https://example.com', title: null } }],
    });
  });

  it('resolves relative images, decodes %20 and reads widths', () => {
    const result = blocks(
      '![Moon|50%](Launch%20plan/moon%20photo.jpg "Full moon")\n\n![Wide|300](diagram.png)',
    );
    expect(result[0]).toMatchObject({
      type: 'image',
      attrs: { assetId: 'asset-moon', alt: 'Moon', title: 'Full moon', width: 50 },
    });
    expect(result[1]).toMatchObject({
      type: 'image',
      attrs: { assetId: 'asset-diagram', alt: 'Wide', width: null },
    });
  });

  it('keeps unresolved images as relative sources and warns', () => {
    const { doc, warnings } = parse('![x](missing.png)');
    expect(doc.content[0]).toMatchObject({ type: 'image', attrs: { src: 'missing.png' } });
    expect(warnings).toContain('Image not found: missing.png');
  });

  it('turns video links written as images into web embeds', () => {
    expect(blocks('![Launch](https://www.youtube.com/watch?v=abc)')[0]).toMatchObject({
      type: 'embed',
      attrs: {
        kind: 'web',
        ref: 'https://www.youtube.com/watch?v=abc',
        data: { display: 'embed', title: 'Launch' },
      },
    });
  });

  it('drops unsafe links and images but keeps their text', () => {
    const { doc, content, warnings } = parse('[click](javascript:alert(1)) ![x](vbscript:evil)');
    expect(JSON.stringify(doc)).not.toMatch(/javascript|vbscript/);
    // The link keeps its text, the image its alt text.
    expect(content[0]?.content).toEqual([{ type: 'text', text: 'click x' }]);
    expect(warnings.some((warning) => warning.startsWith('Unsafe link removed'))).toBe(true);
  });

  it('simplifies raw HTML without ever keeping it', () => {
    const { doc, content } = parse(
      '<div onclick="x()">Block <b>bold</b></div>\n\nInline <u>under</u><script>alert(1)</script> <mark data-color="red">red</mark>',
    );
    expect(JSON.stringify(doc)).not.toMatch(/script|onclick|alert/);
    expect(content[0]).toMatchObject({
      content: [{ text: 'Block ' }, { text: 'bold', marks: [{ type: 'bold' }] }],
    });
    const second = content[1]?.content ?? [];
    expect(second.find((node) => node.text === 'under')?.marks).toEqual([{ type: 'underline' }]);
    expect(second.find((node) => node.text === 'red')?.marks).toEqual([
      { type: 'highlight', attrs: { color: 'red' } },
    ]);
  });

  it('parses code blocks with languages and the lossless embed fence', () => {
    const result = blocks(
      '```TypeScript\nconst x = 1;\n```\n\n```tessera-embed\n{"kind":"plugin:mermaid/diagram","data":{"source":"A-->B"}}\n```\n\n```tessera-embed\nnot json\n```',
    );
    expect(result[0]).toMatchObject({
      type: 'codeBlock',
      attrs: { language: 'typescript' },
      content: [{ text: 'const x = 1;' }],
    });
    expect(result[1]).toMatchObject({
      type: 'embed',
      attrs: { kind: 'plugin:mermaid/diagram', data: { source: 'A-->B' } },
    });
    expect(result[2]).toMatchObject({ type: 'codeBlock', attrs: { language: 'tessera-embed' } });
  });

  it('caps heading levels at 3 and warns once', () => {
    const { content, warnings } = parse('#### Four\n\n##### Five');
    expect(content.map((block) => block.attrs?.level)).toEqual([3, 3]);
    expect(warnings).toEqual(['Level 4 headings were imported as level 3']);
  });

  it('keeps footnotes as text', () => {
    const { doc, warnings } = parse('Claim[^1]\n\n[^1]: Source');
    expect(JSON.stringify(doc)).toContain('[^1]');
    expect(warnings).toContain('Footnotes were imported as plain text');
  });

  it('reads a code span across lines as one line, as CommonMark does', () => {
    expect(inline('Run `pnpm\ntest` now, `a\r\nb`')).toEqual([
      { type: 'text', text: 'Run ' },
      { type: 'text', text: 'pnpm test', marks: [{ type: 'code' }] },
      { type: 'text', text: ' now, ' },
      { type: 'text', text: 'a b', marks: [{ type: 'code' }] },
    ]);
    // A heading holding one is written the same way every time (found by the round trip property).
    const once = codec.serialize(codec.parse('`a\n**bold** `code`\n===\n# Heading').doc);
    expect(codec.serialize(codec.parse(once).doc)).toBe(once);
  });

  it('handles a byte order mark and Windows line endings', () => {
    expect(inline('\uFEFFHello\r\nWorld')).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'hardBreak' },
      { type: 'text', text: 'World' },
    ]);
  });

  it('never fails on odd input', () => {
    for (const input of [
      '',
      '\n\n',
      '[[',
      ']]',
      '![[',
      '#',
      '==',
      '> [!',
      '<details>',
      '|',
      '```',
      '^',
    ]) {
      expect(() => parse(input)).not.toThrow();
    }
  });
});

describe('serialize', () => {
  const doc = (content: AnyNodeJSON[]): DocJSON => ({ type: 'doc', content }) as DocJSON;

  it('keeps plain URLs and emails plain across a round trip, and links linked', () => {
    for (const text of [
      'see http://example.com here',
      'www.example.com',
      'mail bob@example.com now',
      'a@a.a',
    ]) {
      const plain = doc([{ type: 'paragraph', content: [{ type: 'text', text }] }]);
      const back = codec.parse(codec.serialize(plain)).doc;
      expect(back.content[0]).toMatchObject({ content: [{ type: 'text', text }] });
      expect(JSON.stringify(back)).not.toContain('"link"');
    }
    // Literals typed in markdown are still links.
    const typed = codec.parse('see http://example.com and bob@example.com').doc;
    expect(JSON.stringify(typed)).toContain('mailto:bob@example.com');
    expect(JSON.stringify(typed)).toContain('"href":"http://example.com"');
  });

  it('keeps runs of backslashes before punctuation, in text and in toggle summaries', () => {
    const b = '\\';
    for (const text of [
      `${b}${b}@`,
      `${b}${b}:`,
      `${b}${b}. `,
      `${b}${b}${b}x`,
      `${b}${b}${b}@`,
      `x${b}${b}`,
      `${b} ${b}${b}.`,
    ]) {
      const paragraph = doc([{ type: 'paragraph', content: [{ type: 'text', text }] }]);
      expect(codec.parse(codec.serialize(paragraph)).doc.content[0]).toMatchObject({
        content: [{ type: 'text', text }],
      });
      const toggle = doc([
        {
          type: 'toggle',
          attrs: { open: false },
          content: [{ type: 'toggleSummary', content: [{ type: 'text', text }] }],
        },
      ]);
      expect(codec.parse(codec.serialize(toggle)).doc.content[0]).toMatchObject({
        content: [{ type: 'toggleSummary', content: [{ type: 'text', text }] }],
      });
    }
  });

  it('keeps line breaks in callout titles, folded or not (#87)', () => {
    const title = [
      { type: 'text', text: 'Fuel low' },
      { type: 'hardBreak' },
      { type: 'text', text: 'check the gauges' },
    ];
    const folded = doc([
      {
        type: 'callout',
        attrs: { tone: 'warning', emoji: '⚠️' },
        content: [
          {
            type: 'toggle',
            attrs: { open: false },
            content: [
              { type: 'toggleSummary', content: title },
              { type: 'paragraph', content: [{ type: 'text', text: 'Abort below 10%.' }] },
            ],
          },
        ],
      },
    ]);
    const markdown = codec.serialize(folded);
    expect(markdown).toBe('> [!warning]- Fuel low<br>check the gauges\n>\n> Abort below 10%.\n');
    expect(blocks(markdown)[0]?.content?.[0]?.content).toMatchObject([
      { type: 'toggleSummary', content: title },
      { type: 'paragraph', content: [{ type: 'text', text: 'Abort below 10%.' }] },
    ]);

    const bold = title.map((node) =>
      node.type === 'text' ? { ...node, marks: [{ type: 'bold' }] } : node,
    );
    const plain = doc([
      {
        type: 'callout',
        attrs: { tone: 'warning', emoji: '⚠️' },
        content: [
          { type: 'paragraph', content: bold },
          { type: 'paragraph', content: [{ type: 'text', text: 'Abort below 10%.' }] },
        ],
      },
    ]);
    expect(blocks(codec.serialize(plain))[0]?.content).toMatchObject([
      { type: 'paragraph', content: bold },
      { type: 'paragraph', content: [{ type: 'text', text: 'Abort below 10%.' }] },
    ]);
  });

  it('writes only the block IDs keepBlockId accepts', () => {
    const blocks = doc([
      {
        type: 'paragraph',
        attrs: { blockId: 'linked' },
        content: [{ type: 'text', text: 'Kept' }],
      },
      {
        type: 'paragraph',
        attrs: { blockId: 'loose' },
        content: [{ type: 'text', text: 'Plain' }],
      },
    ]);
    expect(codec.serialize(blocks)).toBe('Kept ^linked\n\nPlain ^loose\n');
    expect(codec.serialize(blocks, { keepBlockId: (id) => id === 'linked' })).toBe(
      'Kept ^linked\n\nPlain\n',
    );
    expect(codec.serialize(blocks, { keepBlockId: () => false })).toBe('Kept\n\nPlain\n');
  });

  it('writes clean, Obsidian-style markdown', () => {
    const markdown = codec.serialize(
      doc([
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'pageLink', attrs: { pageId: 'plan', label: 'the plan' } },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'this', marks: [{ type: 'highlight' }] },
            { type: 'text', text: ' ' },
            { type: 'tag', attrs: { name: 'space' } },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done' }] }],
            },
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Todo' }] }],
            },
          ],
        },
        {
          type: 'callout',
          attrs: { tone: 'warning', emoji: '⚠️' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Careful' }] }],
        },
        { type: 'horizontalRule' },
      ]),
      { resolvePage },
    );
    expect(markdown).toBe(
      '## Plan\n\nSee [[Launch plan|the plan]] and ==this== #space\n\n- [x] Done\n- [ ] Todo\n\n> [!warning]\n>\n> Careful\n\n---\n',
    );
  });

  it('writes relative markdown links when asked', () => {
    const markdown = codec.serialize(
      doc([
        {
          type: 'paragraph',
          content: [{ type: 'pageLink', attrs: { pageId: 'plan', heading: 'Count down' } }],
        },
      ]),
      {
        linkStyle: 'markdown',
        resolvePage: (id) => ({ title: PAGES[id] ?? '', path: '../Missions/Launch plan.md' }),
      },
    );
    expect(markdown).toBe('[Launch plan](../Missions/Launch%20plan.md#Count%20down)\n');
  });

  it('uses export paths for wikilinks and attachments', () => {
    const markdown = codec.serialize(
      doc([
        { type: 'paragraph', content: [{ type: 'pageLink', attrs: { pageId: 'plan' } }] },
        { type: 'image', attrs: { assetId: 'asset-moon', alt: 'Moon' } },
        { type: 'embed', attrs: { kind: 'file', ref: 'asset-pdf', data: { name: 'plan.pdf' } } },
      ]),
      {
        resolvePage: () => ({ title: 'Launch plan', path: 'Missions/Launch plan.md' }),
        resolveAssetPath: (id) =>
          id === 'asset-moon' ? 'attachments/moon photo.jpg' : 'attachments/plan.pdf',
      },
    );
    expect(markdown).toBe(
      '[[Missions/Launch plan]]\n\n![Moon](attachments/moon%20photo.jpg)\n\n![[attachments/plan.pdf]]\n',
    );
  });

  it('writes frontmatter first', () => {
    const markdown = codec.serialize(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }]),
      {
        frontmatter: { tags: ['a', 'b'], aliases: ['Hello'], rating: 4 },
      },
    );
    expect(markdown).toBe('---\ntags:\n  - a\n  - b\naliases:\n  - Hello\nrating: 4\n---\n\nHi\n');
    expect(codec.parse(markdown).frontmatter).toEqual({
      tags: ['a', 'b'],
      aliases: ['Hello'],
      rating: 4,
    });
  });

  it('writes an empty document as an empty string', () => {
    expect(codec.serialize(doc([{ type: 'paragraph' }]))).toBe('');
  });

  it('never lets a first horizontal rule look like frontmatter', () => {
    const markdown = codec.serialize(
      doc([
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
        { type: 'horizontalRule' },
      ]),
    );
    expect(markdown).toBe('***\n\nx\n\n---\n');
    expect(codec.parse(markdown).doc.content.map((block) => block.type)).toEqual([
      'horizontalRule',
      'paragraph',
      'horizontalRule',
    ]);
  });
});
