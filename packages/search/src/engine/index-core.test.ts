import {
  build as b,
  createDocFromJSON,
  initDatabaseDoc,
  addProperty,
  addRow,
  addSelectOption,
  setPageProps,
  type DocJSON,
  type JsonValue,
} from '@tessera/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { IndexCore, INDEX_FORMAT_VERSION } from './index-core';
import type { PageMetaLite, QueryFilters } from './types';

const NOW = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;

function meta(id: string, title: string, extra: Partial<PageMetaLite> = {}): PageMetaLite {
  return {
    id,
    title,
    kind: 'page',
    parentId: null,
    trashed: false,
    isRow: false,
    icon: null,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - DAY,
    ...extra,
  };
}

function bytes(doc: DocJSON, props?: Record<string, JsonValue>): Uint8Array {
  const ydoc = createDocFromJSON(doc);
  if (props) setPageProps(ydoc, props);
  return Y.encodeStateAsUpdate(ydoc);
}

function query(core: IndexCore, text: string, filters: QueryFilters = {}, limit = 20) {
  return core.query({ text, filters, limit, offset: 0 });
}

const ids = (result: { hits: Array<{ pageId: string }> }) => result.hits.map((hit) => hit.pageId);
const slices = (text: string, ranges: Array<{ start: number; end: number }>) =>
  ranges.map((range) => text.slice(range.start, range.end));

/** A small workspace: a program page, notes under a mission page, a trashed draft. */
function workspace() {
  const core = new IndexCore({ now: () => NOW });
  core.setMeta(
    [
      meta('apollo', 'Apollo program'),
      meta('gemini', 'Gemini'),
      meta('notes', 'Mission notes', { parentId: 'gemini' }),
      meta('deep', 'Deep dive', { parentId: 'notes', updatedAt: NOW }),
      meta('draft', 'Old Apollo draft', { trashed: true }),
      meta('cafe', 'Café culture'),
    ],
    [],
    true,
  );
  core.setContentFromBytes(
    'apollo',
    bytes(
      b.doc(
        b.heading(1, 'Overview'),
        b.paragraph('The moon landing program. ', b.tag('space'), ' ', b.tag('history/nasa')),
        b.heading(2, 'Saturn V rocket'),
      ),
      { aliases: ['Project Apollo'], tags: ['Heritage'] },
    ),
    NOW - DAY,
  );
  core.setContentFromBytes(
    'notes',
    bytes(
      b.doc(
        b.paragraph('We followed the ', b.pageLink('apollo'), ' closely.'),
        b.paragraph('The Apollo program changed everything; so did Project Apollo.'),
        b.taskList(b.taskItem(false, 'Review the landing footage')),
      ),
    ),
    NOW - DAY,
  );
  core.setContentFromBytes(
    'gemini',
    bytes(
      b.doc(
        b.paragraph('Links to ', b.pageLink('apollo'), ' and to itself ', b.pageLink('gemini')),
        b.paragraph('Orbital rendezvous practice. ', b.tag('space')),
      ),
    ),
    NOW - DAY,
  );
  core.setContentFromBytes('deep', bytes(b.doc(b.paragraph('Rendezvous radar details'))), NOW);
  core.setContentFromBytes(
    'draft',
    bytes(b.doc(b.paragraph('Apollo program ', b.pageLink('apollo')))),
    NOW,
  );
  return core;
}

describe('IndexCore search', () => {
  it('ranks title matches first and highlights them', () => {
    const core = workspace();
    const result = query(core, 'apollo');
    // Pages that link to Apollo contain its title in their text, so they match too.
    expect(ids(result)).toEqual(['apollo', 'notes', 'gemini']);
    expect(result.total).toBe(3);
    const [first, second] = result.hits;
    expect(first?.matchedIn).toBe('title');
    expect(first && slices(first.title, first.titleHighlights)).toEqual(['Apollo']);
    expect(second?.matchedIn).toBe('body');
    const snippet = second?.snippet;
    expect(snippet?.text).toContain('Apollo program changed everything');
    expect(snippet && slices(snippet.text, snippet.highlights)).toEqual(['Apollo', 'Apollo']);
  });

  it('matches typos, prefixes and accents', () => {
    const core = workspace();
    expect(ids(query(core, 'apolo'))).toContain('apollo');
    expect(ids(query(core, 'rendezvus'))).toEqual(expect.arrayContaining(['gemini', 'deep']));
    expect(ids(query(core, 'gem'))).toEqual(['gemini']);
    expect(ids(query(core, 'cafe'))).toEqual(['cafe']);
    expect(ids(query(core, 'CAFÉ'))).toEqual(['cafe']);
    expect(query(core, 'zzzzqqq').total).toBe(0);
  });

  it('requires every word and finds headings, aliases, tags and body text', () => {
    const core = workspace();
    expect(ids(query(core, 'moon landing'))).toEqual(['apollo']);
    const heading = query(core, 'saturn').hits[0];
    expect(heading).toMatchObject({
      pageId: 'apollo',
      matchedIn: 'heading',
      heading: 'Saturn V rocket',
    });
    expect(heading?.snippet?.text).toBe('Saturn V rocket');
    expect(query(core, 'heritage').hits[0]).toMatchObject({ pageId: 'apollo', matchedIn: 'tag' });
    expect(query(core, 'project apollo').hits[0]?.pageId).toBe('apollo');
    expect(ids(query(core, 'footage'))).toEqual(['notes']);
  });

  it('never returns trashed pages', () => {
    const core = workspace();
    expect(ids(query(core, 'draft'))).toEqual([]);
    expect(ids(query(core, ''))).not.toContain('draft');
  });

  it('filters by tag (nested and case-insensitive), subtree, kind and tasks', () => {
    const core = workspace();
    expect(ids(query(core, '', { tags: ['SPACE'] })).sort()).toEqual(['apollo', 'gemini']);
    expect(ids(query(core, '', { tags: ['history'] }))).toEqual(['apollo']);
    expect(ids(query(core, '', { tags: ['history/nasa', 'space'] }))).toEqual(['apollo']);
    expect(ids(query(core, '', { tags: ['nasa'] }))).toEqual([]);
    expect(ids(query(core, '', { within: ['gemini'] }))).toEqual(['deep', 'notes']);
    expect(ids(query(core, 'rendezvous', { within: ['gemini'] }))).toEqual(['deep']);
    expect(ids(query(core, '', { hasTasks: true }))).toEqual(['notes']);
    expect(query(core, '', { kinds: ['database'] }).total).toBe(0);
  });

  it('lists everything by recency for an empty query, and paginates', () => {
    const core = workspace();
    expect(ids(query(core, ''))[0]).toBe('deep');
    const page = core.query({ text: '', filters: {}, limit: 2, offset: 2 });
    expect(page.hits).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it('weighs recency and backlinks when text scores tie', () => {
    const core = new IndexCore({ now: () => NOW });
    core.setMeta(
      [
        meta('old', 'Kepler notes', { updatedAt: NOW - 400 * DAY }),
        meta('new', 'Kepler notes', { updatedAt: NOW }),
        meta('linked', 'Kepler notes', { updatedAt: NOW - 400 * DAY }),
        meta('a', 'Source A'),
        meta('c', 'Source C'),
      ],
      [],
      true,
    );
    expect(ids(query(core, 'kepler'))[0]).toBe('new');
    core.setContentFromBytes('a', bytes(b.doc(b.paragraph(b.pageLink('linked')))), NOW);
    core.setContentFromBytes('c', bytes(b.doc(b.paragraph(b.pageLink('linked')))), NOW);
    const ranked = ids(query(core, 'kepler'));
    expect(ranked.indexOf('linked')).toBeLessThan(ranked.indexOf('old'));
  });

  it('searches database row values and can exclude rows', () => {
    const core = new IndexCore({ now: () => NOW });
    core.setMeta(
      [
        meta('db', 'Reading list', { kind: 'database' }),
        meta('row', 'Dune', { parentId: 'db', isRow: true }),
      ],
      [],
      true,
    );
    const db = new Y.Doc();
    initDatabaseDoc(db, { titlePropertyName: 'Name', viewName: 'Table' });
    const author = addProperty(db, { name: 'Author', type: 'text' });
    const status = addProperty(db, { name: 'Status', type: 'select' });
    const reading = addSelectOption(db, status.id, { name: 'Reading', color: 'blue' });
    addRow(db, { id: 'row', values: { [author.id]: 'Frank Herbert', [status.id]: reading.id } });
    core.setDatabaseFromBytes('db', Y.encodeStateAsUpdate(db), NOW);
    const hit = query(core, 'herbert').hits[0];
    expect(hit).toMatchObject({ pageId: 'row', matchedIn: 'property' });
    expect(hit?.snippet?.text).toBe('Frank Herbert');
    expect(ids(query(core, 'reading'))).toEqual(['db', 'row']);
    expect(
      ids(core.query({ text: 'herbert', filters: { includeRows: false }, limit: 5, offset: 0 })),
    ).toEqual([]);
    expect(ids(query(core, '', { kinds: ['database'] }))).toEqual(['db']);
  });

  it('updates on rename, content edits and removal', () => {
    const core = workspace();
    core.setMeta([meta('gemini', 'Gemini 4')], []);
    expect(query(core, 'gemini 4').hits[0]?.title).toBe('Gemini 4');
    core.setContentFromBytes('gemini', bytes(b.doc(b.paragraph('Spacewalk training'))), NOW);
    expect(ids(query(core, 'spacewalk'))).toEqual(['gemini']);
    expect(ids(query(core, 'orbital'))).toEqual([]);
    core.removePages(['gemini']);
    expect(ids(query(core, 'spacewalk'))).toEqual([]);
    expect(core.edges().some((edge) => edge.source === 'gemini')).toBe(false);
  });
});

describe('IndexCore links', () => {
  it('lists backlinks with live context, excluding self-links and trashed sources', () => {
    const core = workspace();
    const backlinks = core.backlinks('apollo');
    expect(backlinks.map((link) => [link.sourcePageId, link.blockText])).toEqual([
      ['gemini', 'Links to Apollo program and to itself Gemini'],
      ['notes', 'We followed the Apollo program closely.'],
    ]);
    expect(core.backlinks('gemini')).toEqual([]);
    core.setMeta([meta('apollo', 'Apollo')], []);
    expect(core.backlinks('apollo')[1]?.blockText).toBe('We followed the Apollo closely.');
  });

  it('finds links inside tables, toggles, lists, quotes and callouts', () => {
    const core = new IndexCore({ now: () => NOW });
    core.setMeta([meta('src', 'Source'), meta('t', 'Target')], [], true);
    core.setContentFromBytes(
      'src',
      bytes(
        b.doc(
          b.table(
            { header: true },
            ['Name', 'Link'],
            ['Row', b.tableCell(b.paragraph('see ', b.pageLink('t')))],
          ),
          b.toggle(['Summary ', b.pageLink('t')], [b.paragraph('Hidden ', b.pageLink('t'))]),
          b.bulletList(b.listItem(b.paragraph('Item ', b.pageLink('t', { label: 'the target' })))),
          b.blockquote(b.paragraph('Quoted ', b.pageLink('t', { heading: 'Intro' }))),
          b.callout({ emoji: '💡' }, b.paragraph('Callout ', b.pageLink('t'))),
        ),
      ),
      NOW,
    );
    const backlinks = core.backlinks('t');
    expect(backlinks.map((link) => link.blockText)).toEqual([
      'see Target',
      'Summary Target',
      'Hidden Target',
      'Item the target',
      'Quoted Target',
      'Callout Target',
    ]);
    expect(backlinks[3]?.label).toBe('the target');
    expect(backlinks[4]?.heading).toBe('Intro');
    expect(core.edges()).toEqual([{ source: 'src', target: 't', count: 6 }]);
    expect(core.outgoing('src')).toHaveLength(6);
  });

  it('keeps links to trashed pages in outgoing but not in the graph', () => {
    const core = workspace();
    core.setMeta([meta('apollo', 'Apollo program', { trashed: true })], []);
    expect(core.outgoing('notes').map((link) => link.targetPageId)).toEqual(['apollo']);
    expect(core.edges().filter((edge) => edge.target === 'apollo')).toEqual([]);
    expect(core.backlinks('apollo').map((link) => link.sourcePageId)).toEqual(['gemini', 'notes']);
    expect(core.graph().nodes.map((node) => node.id)).not.toContain('apollo');
  });

  it('counts edges once per pair, ignoring self-links and missing targets', () => {
    const core = workspace();
    core.setContentFromBytes(
      'deep',
      bytes(
        b.doc(
          b.paragraph(
            b.pageLink('notes'),
            b.pageLink('notes'),
            b.pageLink('missing'),
            b.pageLink('deep'),
          ),
        ),
      ),
      NOW,
    );
    expect(core.edges()).toEqual(
      expect.arrayContaining([
        { source: 'deep', target: 'notes', count: 2 },
        { source: 'notes', target: 'apollo', count: 1 },
        { source: 'gemini', target: 'apollo', count: 1 },
      ]),
    );
    expect(core.edges()).toHaveLength(3);
  });
});

describe('IndexCore mentions', () => {
  const sources = (entries: Record<string, DocJSON>) =>
    Object.entries(entries).map(([pageId, doc]) => ({ pageId, bytes: bytes(doc) }));

  it('matches whole words case-insensitively, including aliases', () => {
    const core = new IndexCore({ now: () => NOW });
    core.setMeta(
      [meta('apollo', 'Apollo'), meta('a', 'A'), meta('b', 'B'), meta('c', 'C')],
      [],
      true,
    );
    core.setContentFromBytes(
      'apollo',
      bytes(b.doc('x'), { aliases: ['Project Apollo', ' '] }),
      NOW,
    );
    const docs = {
      a: b.doc(b.paragraph('APOLLO landed. The apollonian ideal is not a mention.')),
      b: b.doc(b.paragraph('We loved project apollo, and Apollo_2 is a different word.')),
      c: b.doc(b.codeBlock('apollo in code'), b.paragraph(b.text('apollo', b.mark.code()))),
    };
    for (const [id, doc] of Object.entries(docs)) core.setContentFromBytes(id, bytes(doc), NOW);
    expect(core.mentionCandidates('apollo').sort()).toEqual(['a', 'b', 'c']);
    const mentions = core.findMentions('apollo', sources(docs));
    expect(mentions.map((mention) => [mention.sourcePageId, mention.text])).toEqual([
      ['a', 'APOLLO'],
      ['b', 'project apollo'],
    ]);
    expect(mentions[0]).toMatchObject({ path: [0], from: 0, to: 6 });
  });

  it('reports where each mention sits in the displayed block text', () => {
    const core = new IndexCore({ now: () => NOW });
    core.setMeta(
      [meta('europa', 'Europa'), meta('notes', 'Europa reading notes'), meta('s', 'S')],
      [],
      true,
    );
    const doc = b.doc(
      b.paragraph(
        'See ',
        b.pageLink('notes'),
        ' before Europa rises, then ',
        b.tag('europa'),
        ' Europa.',
      ),
    );
    core.setContentFromBytes('s', bytes(doc), NOW);
    const mentions = core.findMentions('europa', [{ pageId: 's', bytes: bytes(doc) }]);
    expect(mentions).toHaveLength(2);
    for (const mention of mentions) {
      const range = mention.display;
      expect(range && mention.blockText.slice(range.start, range.end)).toBe('Europa');
    }
    expect(mentions[0]?.blockText).toBe(
      'See Europa reading notes before Europa rises, then #europa Europa.',
    );
    expect(mentions.map((mention) => mention.display?.start)).toEqual([32, 59]);
  });

  it('ignores the page itself, trashed sources, linked text and one-letter titles', () => {
    const core = new IndexCore({ now: () => NOW });
    core.setMeta(
      [
        meta('t', 'Tessera'),
        meta('x', 'X'),
        meta('trash', 'Bin', { trashed: true }),
        meta('s', 'S'),
      ],
      [],
      true,
    );
    const docs = {
      t: b.doc('Tessera mentions itself'),
      trash: b.doc('Tessera in the trash'),
      s: b.doc(
        b.paragraph(
          b.text('Tessera', b.mark.link('https://example.com')),
          ' and ',
          b.pageLink('t'),
        ),
      ),
    };
    for (const [id, doc] of Object.entries(docs)) core.setContentFromBytes(id, bytes(doc), NOW);
    expect(core.mentionCandidates('t')).toEqual(['s']);
    expect(core.findMentions('t', sources(docs))).toEqual([]);
    expect(core.mentionNeedles('x')).toEqual([]);
    expect(core.mentionCandidates('x')).toEqual([]);
  });
});

describe('IndexCore tags and graph', () => {
  it('counts tags, co-occurrences and orphans', () => {
    const core = workspace();
    expect(core.tags()).toEqual([
      { key: 'space', name: 'space', count: 2 },
      { key: 'heritage', name: 'Heritage', count: 1 },
      { key: 'history/nasa', name: 'history/nasa', count: 1 },
    ]);
    expect(core.tagCooccurrence()).toEqual([
      { a: 'heritage', b: 'history/nasa', count: 1 },
      { a: 'heritage', b: 'space', count: 1 },
      { a: 'history/nasa', b: 'space', count: 1 },
    ]);
    expect(core.orphans()).toEqual(['cafe', 'deep']);
  });

  it('builds graph snapshots and neighborhoods', () => {
    const core = workspace();
    const graph = core.graph();
    expect(graph.nodes.find((node) => node.id === 'deep')).toMatchObject({ rootId: 'gemini' });
    expect(graph.nodes.find((node) => node.id === 'apollo')?.tags.sort()).toEqual([
      'heritage',
      'history/nasa',
      'space',
    ]);
    expect(
      core
        .neighborhood('notes', 1)
        .nodes.map((node) => node.id)
        .sort(),
    ).toEqual(['apollo', 'notes']);
    expect(
      core
        .neighborhood('notes', 2)
        .nodes.map((node) => node.id)
        .sort(),
    ).toEqual(['apollo', 'gemini', 'notes']);
    expect(core.neighborhood('missing', 2).nodes).toEqual([]);
  });
});

describe('IndexCore persistence', () => {
  it('restores from a persisted snapshot and reports only stale pages', () => {
    const core = workspace();
    const persisted = structuredClone(core.toPersisted());
    const restored = new IndexCore({ now: () => NOW, persisted });
    expect(restored.restored).toBe(true);
    const stale = restored.setMeta(
      [
        meta('apollo', 'Apollo program'),
        meta('gemini', 'Gemini', { updatedAt: NOW }),
        meta('notes', 'Mission notes', { parentId: 'gemini' }),
        meta('deep', 'Deep dive', { parentId: 'notes', updatedAt: NOW }),
        meta('cafe', 'Café culture'),
        meta('new', 'Brand new page'),
      ],
      [],
      true,
    );
    expect(stale.pages.sort()).toEqual(['cafe', 'gemini', 'new']);
    expect(ids(query(restored, 'apollo'))).toEqual(['apollo', 'notes', 'gemini']);
    expect(ids(query(restored, 'brand'))).toEqual(['new']);
    expect(ids(query(restored, 'draft'))).toEqual([]);
    expect(restored.backlinks('apollo').map((link) => link.sourcePageId)).toEqual([
      'gemini',
      'notes',
    ]);
  });

  it('starts empty when the persisted format or schema version differs', () => {
    const persisted = { ...workspace().toPersisted(), format: INDEX_FORMAT_VERSION + 1 };
    const core = new IndexCore({ now: () => NOW, persisted });
    expect(core.restored).toBe(false);
    expect(core.documentCount).toBe(0);
    const schemaChanged = { ...workspace().toPersisted(), docSchema: 999 };
    expect(IndexCore.isCompatible(schemaChanged)).toBe(false);
  });
});

describe('IndexCore titles in the text of other pages', () => {
  const notesBytes = bytes(b.doc(b.paragraph('Read ', b.pageLink('apollo'), ' first')));
  const logBytes = bytes(b.doc(b.paragraph(b.pageLink('apollo'), ' launched on time')));
  const pages = (apollo = 'Apollo') => [
    meta('apollo', apollo),
    meta('notes', 'Mission notes', { updatedAt: NOW }),
    meta('log', 'Flight log'),
  ];

  /** Apollo, and two pages whose text shows its title through a link. */
  function linked(): IndexCore {
    const core = new IndexCore({ now: () => NOW });
    core.setMeta(pages(), [], true);
    core.setContentFromBytes('apollo', bytes(b.doc(b.paragraph('The moon program'))), NOW - DAY);
    core.setContentFromBytes('notes', notesBytes, NOW);
    core.setContentFromBytes('log', logBytes, NOW - DAY);
    return core;
  }

  /** A database whose row relates to Apollo. */
  function related(): { core: IndexCore; update: Uint8Array; metas: PageMetaLite[] } {
    const core = new IndexCore({ now: () => NOW });
    const metas = [
      meta('apollo', 'Apollo'),
      meta('db', 'Missions', { kind: 'database', updatedAt: NOW }),
      meta('crew', 'Crew selection', { parentId: 'db', isRow: true }),
    ];
    core.setMeta(metas, [], true);
    const db = new Y.Doc();
    initDatabaseDoc(db, { titlePropertyName: 'Name', viewName: 'Table' });
    const program = addProperty(db, {
      name: 'Program',
      type: 'relation',
      relation: { targetDatabaseId: null, limit: 'many' },
    });
    addRow(db, { id: 'crew', values: { [program.id]: ['apollo'] } });
    const update = Y.encodeStateAsUpdate(db);
    core.setDatabaseFromBytes('db', update, NOW);
    return { core, update, metas };
  }

  it('reports the pages that link to a renamed page, whose text follows once read again', () => {
    const core = linked();
    expect(ids(query(core, 'apollo')).sort()).toEqual(['apollo', 'log', 'notes']);
    expect(core.setMeta([meta('apollo', 'Artemis')], [])).toEqual({
      pages: ['notes', 'log'],
      databases: [],
    });
    core.setContentFromBytes('notes', notesBytes, NOW);
    core.setContentFromBytes('log', logBytes, NOW - DAY);
    expect(ids(query(core, 'artemis')).sort()).toEqual(['apollo', 'log', 'notes']);
    expect(ids(query(core, 'apollo'))).toEqual([]);
    // Other changes to the page leave the text of the others as it is.
    expect(core.setMeta([meta('apollo', 'Artemis', { icon: '🚀' })], [])).toEqual({
      pages: [],
      databases: [],
    });
  });

  it('reports them when the page they link to appears or goes', () => {
    const core = new IndexCore({ now: () => NOW });
    core.setMeta([meta('notes', 'Mission notes', { updatedAt: NOW })], [], true);
    core.setContentFromBytes('notes', notesBytes, NOW);
    expect(core.setMeta([meta('apollo', 'Apollo')], [])).toEqual({
      pages: ['notes'],
      databases: [],
    });
    core.setContentFromBytes('notes', notesBytes, NOW);
    expect(ids(query(core, 'apollo')).sort()).toEqual(['apollo', 'notes']);
    expect(core.setMeta([], ['apollo'])).toEqual({ pages: ['notes'], databases: [] });
    core.setContentFromBytes('notes', notesBytes, NOW);
    expect(ids(query(core, 'apollo'))).toEqual([]);
  });

  it('reports the databases whose rows relate to a renamed page', () => {
    const { core, update } = related();
    expect(ids(query(core, 'apollo')).sort()).toEqual(['apollo', 'crew']);
    expect(core.setMeta([meta('apollo', 'Artemis')], [])).toEqual({
      pages: [],
      databases: ['db'],
    });
    core.setDatabaseFromBytes('db', update, NOW);
    expect(ids(query(core, 'artemis')).sort()).toEqual(['apollo', 'crew']);
    expect(ids(query(core, 'apollo'))).toEqual([]);
  });

  it('catches up with titles that changed while the app was closed', () => {
    const restored = new IndexCore({
      now: () => NOW,
      persisted: structuredClone(linked().toPersisted()),
    });
    expect(restored.setMeta(pages('Artemis'), [], true)).toEqual({
      pages: ['notes', 'log'],
      databases: [],
    });
    const { core, metas } = related();
    const again = new IndexCore({ now: () => NOW, persisted: structuredClone(core.toPersisted()) });
    const renamed = metas.map((page) =>
      page.id === 'apollo' ? { ...page, title: 'Artemis' } : page,
    );
    expect(again.setMeta(renamed, [], true).databases).toEqual(['db']);
  });

  it('reads databases saved without their relation targets once', () => {
    const { core, update, metas } = related();
    const persisted = structuredClone(core.toPersisted());
    // Indexes saved before rows kept their relation targets.
    persisted.rows = persisted.rows.map(([id, { databaseId, text }]) => [id, { databaseId, text }]);
    const restored = new IndexCore({ now: () => NOW, persisted });
    expect(restored.setMeta(metas, [], true).databases).toEqual(['db']);
    restored.setDatabaseFromBytes('db', update, NOW);
    const again = new IndexCore({
      now: () => NOW,
      persisted: structuredClone(restored.toPersisted()),
    });
    expect(again.setMeta(metas, [], true).databases).toEqual([]);
  });
});
