import {
  addProperty,
  addSelectOption,
  createPage,
  getPage,
  getProperty,
  getRow,
  getView,
  listProperties,
  listRows,
  listViews,
  readDocJSON,
  setRowTemplate,
  setRowValue,
  getPageProp,
  writeDocJSON,
  build,
  updateView,
  type DocHandle,
} from '@tessera/core';
import { createTestAppContext, type TestAppContext } from '@tessera/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testContext } from '../test/fixtures';
import { addRowsInBulk } from './bulk';
import {
  addDatabaseProperty,
  addDatabaseView,
  addRow,
  changePropertyType,
  changeViewType,
  createDatabase,
  deleteOptionUndoable,
  deletePropertyUndoable,
  deleteViewUndoable,
  duplicateProperty,
  duplicateRows,
  enableTwoWay,
  ensureOption,
  materializeViewProperties,
  movePropertyInView,
  renameProperty,
  setAllPropertiesVisible,
  setCell,
  setCellsFromText,
  setColumnWidth,
  setPropertyVisible,
  trashRows,
  uniquePropertyName,
  type DatabaseRef,
} from './operations';
import {
  relationIds,
  removeDeletedFromRelations,
  setRelationValue,
  unlinkTwoWay,
} from './relations';
import { acquireDatabaseStore } from './store';
import { runUndoable } from './undo';

let app: TestAppContext;
const handles: DocHandle[] = [];

beforeEach(async () => {
  app = await createTestAppContext();
});

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.release();
  await app.dispose();
});

async function database(title = 'Tasks'): Promise<DatabaseRef> {
  const { page } = await createDatabase(app.ctx, { title });
  const handle = await app.ctx.loadDatabaseDoc(page.id);
  handles.push(handle);
  return { id: page.id, doc: handle.doc };
}

describe('createDatabase and addRow', () => {
  it('creates a database with a title property and a table, full width on request', async () => {
    const { page } = await createDatabase(app.ctx, { title: 'Reading list', fullWidth: true });
    const handle = await app.ctx.loadDatabaseDoc(page.id);
    handles.push(handle);
    expect(listProperties(handle.doc).map((p) => [p.name, p.type])).toEqual([['Name', 'title']]);
    expect(listViews(handle.doc).map((v) => [v.name, v.type])).toEqual([['Table', 'table']]);
    const pageDoc = await app.ctx.loadPageDoc(page.id);
    handles.push(pageDoc);
    expect(getPageProp(pageDoc.doc, 'fullWidth')).toBe(true);
  });

  it('copies the row template into new rows', async () => {
    const ref = await database();
    const template = app.ctx.workspace.createPage({
      parentId: ref.id,
      title: 'Weekly review',
      icon: '📝',
    });
    const templateDoc = await app.ctx.loadPageDoc(template.id);
    handles.push(templateDoc);
    writeDocJSON(templateDoc.doc, build.doc(build.heading(2, 'Agenda'), build.paragraph('Wins')));
    setRowTemplate(ref.doc, template.id);
    const row = await addRow(app.ctx, ref, {});
    expect(row.title).toBe('Weekly review');
    expect(row.icon).toBe('📝');
    const rowDoc = await app.ctx.loadPageDoc(row.id);
    handles.push(rowDoc);
    expect(JSON.stringify(readDocJSON(rowDoc.doc))).toContain('Agenda');
    const plain = await addRow(app.ctx, ref, { title: 'Blank', useTemplate: false });
    expect(plain.icon).toBeUndefined();
    // A trashed template is ignored.
    app.ctx.workspace.trashPage(template.id);
    expect((await addRow(app.ctx, ref, { title: 'After' })).icon).toBeUndefined();
  });
});

describe('DatabaseStore', () => {
  it('joins rows with their pages and updates incrementally', async () => {
    const ref = await database();
    const status = addProperty(ref.doc, {
      name: 'Status',
      type: 'select',
      options: [{ name: 'Todo' }],
    });
    const first = await addRow(app.ctx, ref, { title: 'First' });
    const { store, release } = acquireDatabaseStore(ref.doc, app.ctx.workspace.pages);
    const again = acquireDatabaseStore(ref.doc, app.ctx.workspace.pages);
    expect(again.store).toBe(store);
    let notified = 0;
    const stop = store.subscribe(() => {
      notified += 1;
    });
    const snapshot = store.getSnapshot();
    expect(snapshot.initialized).toBe(true);
    expect(snapshot.rows.map((row) => row.title)).toEqual(['First']);
    expect(snapshot.titleProperty?.type).toBe('title');

    const second = await addRow(app.ctx, ref, { title: 'Second', position: 'start' });
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual([second.id, first.id]);
    const unchanged = store.getSnapshot().rows.find((row) => row.id === first.id);

    setRowValue(ref.doc, second.id, status.id, status.options?.[0]?.id ?? null);
    const afterValue = store.getSnapshot();
    expect(afterValue.rows.find((row) => row.id === first.id)).toBe(unchanged);
    expect(afterValue.rows.find((row) => row.id === second.id)?.values[status.id]).toBe(
      status.options?.[0]?.id,
    );

    app.ctx.workspace.renamePage(first.id, 'Renamed');
    expect(store.getSnapshot().rows.find((row) => row.id === first.id)?.title).toBe('Renamed');

    app.ctx.workspace.trashPage(second.id);
    expect(store.getSnapshot().rows.find((row) => row.id === second.id)?.trashed).toBe(true);

    updateView(ref.doc, listViews(ref.doc)[0]?.id ?? '', { name: 'All tasks' });
    expect(store.getSnapshot().views[0]?.name).toBe('All tasks');
    expect(notified).toBeGreaterThan(3);

    stop();
    again.release();
    release();
    release();
    // A new store after the last release.
    const fresh = acquireDatabaseStore(ref.doc, app.ctx.workspace.pages);
    expect(fresh.store).not.toBe(store);
    fresh.release();
  });

  it('stays quiet while pages outside the database change', async () => {
    const ref = await database();
    const row = await addRow(app.ctx, ref, { title: 'Launch checklist' });
    const { store, release } = acquireDatabaseStore(ref.doc, app.ctx.workspace.pages);
    let notified = 0;
    const stop = store.subscribe(() => {
      notified += 1;
    });
    const before = store.getSnapshot();

    // An import creates pages elsewhere; the rows are what they were.
    const folder = app.ctx.workspace.createPage({ title: 'Imported notes' });
    app.ctx.workspace.createPage({ title: 'Mission log', parentId: folder.id });
    app.ctx.workspace.renamePage(folder.id, 'Imported');
    expect(notified).toBe(0);
    expect(store.getSnapshot()).toBe(before);

    // Its rows' pages still come through.
    app.ctx.workspace.renamePage(row.id, 'Launch day');
    expect(notified).toBe(1);
    expect(store.getSnapshot().rows.map((candidate) => candidate.title)).toEqual(['Launch day']);
    app.ctx.workspace.trashPage(row.id);
    expect(notified).toBe(2);
    expect(store.getSnapshot().rows[0]?.trashed).toBe(true);
    stop();
    release();
  });
});

describe('addRowsInBulk', () => {
  it('writes rows that read back exactly like addDatabaseRow rows', async () => {
    const ref = await database();
    const status = addProperty(ref.doc, {
      name: 'Status',
      type: 'select',
      options: [{ name: 'Todo' }],
    });
    const points = addProperty(ref.doc, { name: 'Points', type: 'number' });
    const optionId = status.options?.[0]?.id ?? '';
    const viaCore = await app.ctx.workspace.addDatabaseRow(ref.id, {
      title: 'Same',
      icon: '🚀',
      values: { [status.id]: optionId, [points.id]: 3 },
    });
    const [viaBulk] = addRowsInBulk(app.ctx, ref.doc, ref.id, [
      { title: 'Same', icon: '🚀', values: { [status.id]: optionId, [points.id]: 3, other: null } },
    ]);
    if (!viaBulk) throw new Error('no row');
    const a = getPage(app.ctx.workspace.doc, viaCore.id);
    const b = getPage(app.ctx.workspace.doc, viaBulk);
    const strip = (page: typeof a) => {
      if (!page) return page;
      const { id: _id, order: _order, createdAt: _c, updatedAt: _u, ...rest } = page;
      return rest;
    };
    expect(strip(b)).toEqual(strip(a));
    expect(getRow(ref.doc, viaBulk)?.values).toEqual(getRow(ref.doc, viaCore.id)?.values);
    const snapshot = app.ctx.workspace.pages.getSnapshot();
    expect(snapshot.isRow(viaBulk)).toBe(true);
    expect(snapshot.tree().some((node) => node.page.id === viaBulk)).toBe(false);
    expect(listRows(ref.doc).map((row) => row.id)).toEqual([viaCore.id, viaBulk]);
  });

  it('inserts after a row, validates first and scales to thousands of rows', async () => {
    const ref = await database();
    const status = addProperty(ref.doc, {
      name: 'Status',
      type: 'select',
      options: [{ name: 'Todo' }],
    });
    const ids = addRowsInBulk(app.ctx, ref.doc, ref.id, [{ title: 'a' }, { title: 'c' }]);
    const [inserted] = addRowsInBulk(app.ctx, ref.doc, ref.id, [{ title: 'b' }], {
      after: ids[0] ?? null,
    });
    expect(listRows(ref.doc).map((row) => getPage(app.ctx.workspace.doc, row.id)?.title)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(inserted).toBeDefined();
    expect(() =>
      addRowsInBulk(app.ctx, ref.doc, ref.id, [{ values: { [status.id]: 'nope' } }]),
    ).toThrow();
    expect(() => addRowsInBulk(app.ctx, ref.doc, ref.id, [{ values: { ghost: 1 } }])).toThrow();
    expect(() => addRowsInBulk(app.ctx, ref.doc, 'missing', [{}])).toThrow();
    expect(addRowsInBulk(app.ctx, ref.doc, ref.id, [])).toEqual([]);
    const started = performance.now();
    addRowsInBulk(
      app.ctx,
      ref.doc,
      ref.id,
      Array.from({ length: 5000 }, (_, i) => ({ title: `Row ${i}` })),
    );
    expect(listRows(ref.doc)).toHaveLength(5003);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('cells', () => {
  it('renames titles, validates values and refuses computed columns', async () => {
    const ref = await database();
    const row = await addRow(app.ctx, ref, { title: 'Draft' });
    const title = listProperties(ref.doc)[0];
    const notes = addProperty(ref.doc, { name: 'Notes', type: 'text' });
    const created = addProperty(ref.doc, { name: 'Created', type: 'createdTime' });
    if (!title) throw new Error('no title');
    await setCell(app.ctx, ref, row.id, title, 'Final');
    await setCell(app.ctx, ref, row.id, notes, 'Hello');
    expect(app.ctx.workspace.getPage(row.id)?.title).toBe('Final');
    expect(getRow(ref.doc, row.id)?.values[notes.id]).toBe('Hello');
    await expect(setCell(app.ctx, ref, row.id, created, 1)).rejects.toThrow();
    await setCell(app.ctx, ref, row.id, notes, null);
    expect(getRow(ref.doc, row.id)?.values[notes.id]).toBeUndefined();
  });

  it('pastes text into every kind of cell, creating options', async () => {
    const ref = await database();
    const rows = [
      await addRow(app.ctx, ref, { title: 'A' }),
      await addRow(app.ctx, ref, { title: 'B' }),
    ];
    const [title] = listProperties(ref.doc);
    const status = addProperty(ref.doc, {
      name: 'Status',
      type: 'select',
      options: [{ name: 'Todo' }],
    });
    const tags = addProperty(ref.doc, { name: 'Tags', type: 'multiSelect' });
    const due = addProperty(ref.doc, { name: 'Due', type: 'date' });
    const points = addProperty(ref.doc, { name: 'Points', type: 'number' });
    const link = addProperty(ref.doc, { name: 'Link', type: 'relation' });
    const target = app.ctx.workspace.createPage({ title: 'Moon base' });
    if (!title) throw new Error('fixture');
    const [first, second] = rows;
    if (!first || !second) throw new Error('fixture');
    const result = await setCellsFromText(
      app.ctx,
      ref,
      [
        { rowId: first.id, property: title, text: 'Alpha' },
        { rowId: first.id, property: status, text: 'todo' },
        { rowId: first.id, property: tags, text: 'red, blue' },
        { rowId: first.id, property: due, text: 'Sep 30, 2026' },
        { rowId: first.id, property: points, text: 'many' },
        { rowId: second.id, property: status, text: 'Blocked' },
        { rowId: second.id, property: link, text: 'moon base' },
        { rowId: second.id, property: link, text: 'Nowhere' },
      ],
      testContext(),
    );
    expect(result).toEqual({ written: 6, skipped: 2 });
    const statusNow = getProperty(ref.doc, status.id);
    expect(statusNow?.options?.map((option) => option.name)).toEqual(['Todo', 'Blocked']);
    expect(getRow(ref.doc, first.id)?.values[status.id]).toBe(status.options?.[0]?.id);
    expect(getProperty(ref.doc, tags.id)?.options?.map((option) => option.name)).toEqual([
      'red',
      'blue',
    ]);
    expect(getRow(ref.doc, first.id)?.values[due.id]).toEqual({ start: '2026-09-30' });
    expect(app.ctx.workspace.getPage(first.id)?.title).toBe('Alpha');
    expect(getRow(ref.doc, second.id)?.values[link.id]).toEqual([target.id]);
    expect(ensureOption(ref.doc, status.id, 'BLOCKED').name).toBe('Blocked');
  });
});

describe('rows', () => {
  it('trashes rows with undo and duplicates rows with their content', async () => {
    const ref = await database();
    const notes = addProperty(ref.doc, { name: 'Notes', type: 'text' });
    const row = await addRow(app.ctx, ref, { title: 'Original', values: { [notes.id]: 'x' } });
    const other = await addRow(app.ctx, ref, { title: 'Other' });
    const doc = await app.ctx.loadPageDoc(row.id);
    handles.push(doc);
    writeDocJSON(doc.doc, build.doc(build.paragraph('Body text')));
    // A stale value (left from another type) is not copied.
    const numbers = addProperty(ref.doc, { name: 'N', type: 'number' });
    setRowValue(ref.doc, row.id, numbers.id, 5);
    const [copy] = await duplicateRows(app.ctx, ref, [row.id]);
    if (!copy) throw new Error('no copy');
    expect(app.ctx.workspace.getPage(copy)?.title).toBe('Original');
    expect(getRow(ref.doc, copy)?.values[notes.id]).toBe('x');
    expect(listRows(ref.doc).map((entry) => entry.id)).toEqual([row.id, copy, other.id]);
    const copyDoc = await app.ctx.loadPageDoc(copy);
    handles.push(copyDoc);
    expect(JSON.stringify(readDocJSON(copyDoc.doc))).toContain('Body text');

    const undo = trashRows(app.ctx, [row.id, other.id, 'ghost']);
    const snapshot = app.ctx.workspace.pages.getSnapshot();
    expect(snapshot.isTrashed(row.id) && snapshot.isTrashed(other.id)).toBe(true);
    undo();
    expect(app.ctx.workspace.pages.getSnapshot().isTrashed(row.id)).toBe(false);
    expect(getRow(ref.doc, row.id)).toBeDefined();
    expect(await duplicateRows(app.ctx, ref, ['ghost'])).toEqual([]);
  });
});

describe('two-way relations', () => {
  it('keeps both sides in step, including limits, trash and permanent deletion', async () => {
    const tasks = await database('Tasks');
    const projects = await database('Projects');
    const project = addDatabaseProperty(tasks, {
      type: 'relation',
      name: 'Project',
      relationTarget: projects.id,
    });
    const apollo = await addRow(app.ctx, projects, { title: 'Apollo' });
    const gemini = await addRow(app.ctx, projects, { title: 'Gemini' });
    const launch = await addRow(app.ctx, tasks, { title: 'Launch' });
    const land = await addRow(app.ctx, tasks, { title: 'Land' });
    await setRelationValue(app.ctx, tasks.doc, launch.id, project, [apollo.id]);

    const back = await enableTwoWay(app.ctx, tasks, project.id);
    if (!back) throw new Error('no back property');
    expect(back.name).toBe('Related to Tasks');
    expect(getRow(projects.doc, apollo.id)?.values[back.id]).toEqual([launch.id]);
    const linked = getProperty(tasks.doc, project.id);
    if (!linked) throw new Error('fixture');
    expect(linked.relation?.backPropertyId).toBe(back.id);
    expect(await enableTwoWay(app.ctx, tasks, project.id)).toMatchObject({ id: back.id });

    await setRelationValue(app.ctx, tasks.doc, land.id, linked, [apollo.id, gemini.id]);
    expect(getRow(projects.doc, apollo.id)?.values[back.id]).toEqual([launch.id, land.id]);
    expect(getRow(projects.doc, gemini.id)?.values[back.id]).toEqual([land.id]);
    await setRelationValue(app.ctx, tasks.doc, land.id, linked, [gemini.id]);
    expect(getRow(projects.doc, apollo.id)?.values[back.id]).toEqual([launch.id]);

    // The back side limited to one page displaces the previous source.
    const backNow = getProperty(projects.doc, back.id);
    if (!backNow) throw new Error('fixture');
    const { updateProperty } = await import('@tessera/core');
    updateProperty(projects.doc, back.id, { relation: { limit: 'one' } });
    await setRelationValue(app.ctx, tasks.doc, launch.id, linked, [apollo.id, gemini.id]);
    expect(getRow(projects.doc, gemini.id)?.values[back.id]).toEqual([launch.id]);
    expect(relationIds(getRow(tasks.doc, land.id)?.values[project.id])).toEqual([]);

    // Trash changes nothing; permanent deletion removes the page everywhere.
    app.ctx.workspace.trashPage(gemini.id);
    expect(relationIds(getRow(tasks.doc, launch.id)?.values[project.id])).toContain(gemini.id);
    await app.ctx.workspace.deletePagePermanently(gemini.id);
    await removeDeletedFromRelations(app.ctx, new Set([gemini.id]), new Set());
    expect(relationIds(getRow(tasks.doc, launch.id)?.values[project.id])).toEqual([apollo.id]);

    // Deleting the target database makes the relation one-way.
    await removeDeletedFromRelations(app.ctx, new Set([projects.id]), new Set([projects.id]));
    expect(getProperty(tasks.doc, project.id)?.relation?.backPropertyId).toBeNull();
  });

  it('unlinks both sides and deleting a two-way property unlinks the other side', async () => {
    const tasks = await database('Tasks');
    const people = await database('People');
    const owner = addDatabaseProperty(tasks, {
      type: 'relation',
      name: 'Owner',
      relationTarget: people.id,
    });
    const back = await enableTwoWay(app.ctx, tasks, owner.id);
    if (!back) throw new Error('fixture');
    const linked = getProperty(tasks.doc, owner.id);
    if (!linked) throw new Error('fixture');
    await unlinkTwoWay(app.ctx, tasks.doc, linked);
    expect(getProperty(tasks.doc, owner.id)?.relation?.backPropertyId).toBeNull();
    expect(getProperty(people.doc, back.id)?.relation?.backPropertyId).toBeNull();

    const again = await enableTwoWay(app.ctx, tasks, owner.id);
    if (!again) throw new Error('fixture');
    const handle = await deletePropertyUndoable(app.ctx, tasks, owner.id);
    expect(getProperty(tasks.doc, owner.id)).toBeUndefined();
    expect(getProperty(people.doc, again.id)?.relation?.backPropertyId).toBeNull();
    handle.undo();
    expect(getProperty(tasks.doc, owner.id)?.name).toBe('Owner');
  });
});

describe('properties', () => {
  it('changes types with conversion and undo, and switching back restores values', async () => {
    const ref = await database();
    const points = addProperty(ref.doc, { name: 'Points', type: 'number' });
    const a = await addRow(app.ctx, ref, { title: 'A', values: { [points.id]: 42 } });
    const store = acquireDatabaseStore(ref.doc, app.ctx.workspace.pages);
    const ctx = testContext();
    const toText = await changePropertyType(
      app.ctx,
      ref,
      store.store.getSnapshot().rows,
      points.id,
      'text',
      ctx,
    );
    expect(getProperty(ref.doc, points.id)?.type).toBe('text');
    expect(getRow(ref.doc, a.id)?.values[points.id]).toBe('42');
    setRowValue(ref.doc, a.id, points.id, 'forty-two');
    await changePropertyType(
      app.ctx,
      ref,
      store.store.getSnapshot().rows,
      points.id,
      'number',
      ctx,
    );
    expect(getRow(ref.doc, a.id)?.values[points.id]).toBe('forty-two');
    await changePropertyType(app.ctx, ref, store.store.getSnapshot().rows, points.id, 'text', ctx);
    expect(getRow(ref.doc, a.id)?.values[points.id]).toBe('forty-two');

    const toSelect = await changePropertyType(
      app.ctx,
      ref,
      store.store.getSnapshot().rows,
      points.id,
      'select',
      ctx,
    );
    const select = getProperty(ref.doc, points.id);
    expect(select?.options?.map((option) => option.name)).toEqual(['forty-two']);
    expect(getRow(ref.doc, a.id)?.values[points.id]).toBe(select?.options?.[0]?.id);
    toSelect?.undo();
    expect(getProperty(ref.doc, points.id)?.type).toBe('text');
    expect(getRow(ref.doc, a.id)?.values[points.id]).toBe('forty-two');
    expect(toText).not.toBeNull();
    expect(await changePropertyType(app.ctx, ref, [], points.id, 'text', ctx)).toBeNull();
    const toRelation = await changePropertyType(
      app.ctx,
      ref,
      store.store.getSnapshot().rows,
      points.id,
      'relation',
      ctx,
    );
    expect(getProperty(ref.doc, points.id)?.relation?.targetDatabaseId).toBeNull();
    toRelation?.undo();
    store.release();
  });

  it('renames properties and the formulas that read them', async () => {
    const ref = await database();
    const pages = addProperty(ref.doc, { name: 'Pages', type: 'number' });
    const perDay = addProperty(ref.doc, {
      name: 'Per day',
      type: 'formula',
      formula: { expression: 'prop("Pages") / 30 + length(prop("Name"))' },
    });
    const other = addProperty(ref.doc, {
      name: 'Other',
      type: 'formula',
      formula: { expression: '"Pages"' },
    });
    renameProperty(ref, pages.id, 'Page count');
    expect(getProperty(ref.doc, pages.id)?.name).toBe('Page count');
    expect(getProperty(ref.doc, perDay.id)?.formula?.expression).toBe(
      'prop("Page count") / 30 + length(prop("Name"))',
    );
    expect(getProperty(ref.doc, other.id)?.formula?.expression).toBe('"Pages"');
    // Same name, or a property that is gone: nothing happens.
    renameProperty(ref, pages.id, 'Page count');
    renameProperty(ref, 'ghost', 'x');
    expect(getProperty(ref.doc, perDay.id)?.formula?.expression).toContain('Page count');
  });

  it('turns a formula into stored values of another type', async () => {
    const ref = await database();
    const pages = addProperty(ref.doc, { name: 'Pages', type: 'number' });
    const label = addProperty(ref.doc, {
      name: 'Label',
      type: 'formula',
      formula: { expression: 'if(prop("Pages") > 400, "Long", "Short")' },
    });
    const dune = await addRow(app.ctx, ref, { title: 'Dune', values: { [pages.id]: 688 } });
    const store = acquireDatabaseStore(ref.doc, app.ctx.workspace.pages);
    const handle = await changePropertyType(
      app.ctx,
      ref,
      store.store.getSnapshot().rows,
      label.id,
      'text',
      testContext(),
    );
    expect(getProperty(ref.doc, label.id)?.type).toBe('text');
    expect(getRow(ref.doc, dune.id)?.values[label.id]).toBe('Long');
    handle?.undo();
    expect(getProperty(ref.doc, label.id)?.type).toBe('formula');
    expect(getRow(ref.doc, dune.id)?.values[label.id]).toBeUndefined();
    store.release();
  });

  it('adds, duplicates and deletes properties and options with undo', async () => {
    const ref = await database();
    const view = listViews(ref.doc)[0];
    if (!view) throw new Error('fixture');
    const status = addDatabaseProperty(ref, { type: 'select', view: { id: view.id, index: 1 } });
    expect(status.name).toBe('Select');
    expect(uniquePropertyName(ref.doc, 'select')).toBe('select 2');
    const option = addSelectOption(ref.doc, status.id, { name: 'Done', color: 'green' });
    const row = await addRow(app.ctx, ref, { title: 'A', values: { [status.id]: option.id } });
    const copy = duplicateProperty(ref, status.id, 'Select copy');
    expect(copy.options?.map((o) => o.name)).toEqual(['Done']);
    expect(getRow(ref.doc, row.id)?.values[copy.id]).toBe(copy.options?.[0]?.id);

    const deletion = deleteOptionUndoable(ref, status.id, option.id);
    expect(getRow(ref.doc, row.id)?.values[status.id]).toBeUndefined();
    deletion.undo();
    expect(getRow(ref.doc, row.id)?.values[status.id]).toBe(option.id);

    const handle = await deletePropertyUndoable(app.ctx, ref, status.id);
    expect(getProperty(ref.doc, status.id)).toBeUndefined();
    handle.undo();
    handle.undo();
    expect(getProperty(ref.doc, status.id)?.options?.[0]?.name).toBe('Done');
    expect(getRow(ref.doc, row.id)?.values[status.id]).toBe(option.id);
    await expect(deletePropertyUndoable(app.ctx, ref, 'ghost')).rejects.toThrow();
    const titleId = listProperties(ref.doc)[0]?.id ?? '';
    expect(() => duplicateProperty(ref, titleId, 'x')).toThrow();
  });
});

describe('views', () => {
  it('sets boards and calendars up, and manages columns', async () => {
    const ref = await database();
    const board = addDatabaseView(ref, 'board');
    const status = getProperty(ref.doc, board.group?.propertyId ?? '');
    expect(status?.name).toBe('Status');
    expect(status?.options?.map((option) => option.name)).toEqual([
      'Not started',
      'In progress',
      'Done',
    ]);
    const calendar = addDatabaseView(ref, 'calendar', 'Schedule');
    expect(getProperty(ref.doc, calendar.calendar.datePropertyId ?? '')?.type).toBe('date');
    const table = listViews(ref.doc)[0];
    if (!table) throw new Error('fixture');
    changeViewType(ref, table.id, 'board');
    expect(getView(ref.doc, table.id)?.group?.propertyId).toBe(status?.id);
    changeViewType(ref, table.id, 'table');

    const titleId = listProperties(ref.doc)[0]?.id ?? '';
    const notes = addDatabaseProperty(ref, {
      type: 'text',
      name: 'Notes',
      view: { id: table.id, index: 0 },
    });
    expect(
      materializeViewProperties(listProperties(ref.doc), getView(ref.doc, table.id) ?? table)[0]
        ?.propertyId,
    ).toBe(notes.id);
    movePropertyInView(ref, table.id, notes.id, 5);
    setPropertyVisible(ref, table.id, notes.id, false);
    setColumnWidth(ref, table.id, notes.id, 5);
    const current = getView(ref.doc, table.id);
    const entry = current?.properties.find((p) => p.propertyId === notes.id);
    expect(entry).toMatchObject({ visible: false, width: 40 });
    expect(current?.properties.at(-1)?.propertyId).toBe(notes.id);
    setAllPropertiesVisible(ref, table.id, false);
    expect(
      getView(ref.doc, table.id)?.properties.every((p) => !p.visible || p.propertyId === titleId),
    ).toBe(true);

    const deletion = deleteViewUndoable(ref, board.id);
    expect(getView(ref.doc, board.id)).toBeUndefined();
    deletion.undo();
    expect(getView(ref.doc, board.id)?.name).toBe('Board');
    deleteViewUndoable(ref, board.id);
    deleteViewUndoable(ref, calendar.id);
    expect(() => deleteViewUndoable(ref, table.id)).toThrow('A database keeps at least one view');
  });
});

describe('runUndoable', () => {
  it('reverts a failed action and ignores later edits when undoing', async () => {
    const ref = await database();
    expect(() =>
      runUndoable(ref.doc, () => {
        addProperty(ref.doc, { name: 'Half', type: 'text' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(listProperties(ref.doc).map((p) => p.name)).toEqual(['Name']);
    const handle = runUndoable(ref.doc, () =>
      addProperty(ref.doc, { name: 'Kept?', type: 'text' }),
    );
    const later = addProperty(ref.doc, { name: 'Later', type: 'text' });
    handle.undo();
    expect(listProperties(ref.doc).map((p) => p.name)).toEqual(['Name', 'Later']);
    expect(later.id).toBeDefined();
    const forgotten = runUndoable(ref.doc, () =>
      addProperty(ref.doc, { name: 'Stays', type: 'text' }),
    );
    forgotten.forget();
    forgotten.undo();
    expect(listProperties(ref.doc).map((p) => p.name)).toContain('Stays');
  });
});

describe('createPage guard', () => {
  it('keeps using core helpers for pages', () => {
    const page = createPage(app.ctx.workspace.doc, { title: 'Plain' });
    expect(getPage(app.ctx.workspace.doc, page.id)?.title).toBe('Plain');
  });
});
