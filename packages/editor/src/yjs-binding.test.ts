import {
  build as b,
  docJSONEqual,
  readDocJSON,
  updateDocJSON,
  validateDocJSON,
  writeDocJSON,
} from '@tessera/core';
import { kitchenSinkDoc } from '@tessera/core/testing';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { deleteBlocks, duplicateBlock, moveBlock } from './actions/blocks';
import { blockTexts, createTestEditor, linkDocs, pressKey, typeText } from './test-utils';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup(...args: Parameters<typeof createTestEditor>) {
  const result = createTestEditor(...args);
  cleanups.push(result.destroy);
  return result;
}

describe('editor bound to the page doc', () => {
  it('renders the stored content exactly (kitchen sink)', () => {
    const { editor, doc } = setup({ content: kitchenSinkDoc() });
    expect(docJSONEqual(editor.getJSON(), kitchenSinkDoc())).toBe(true);
    // Rendering never rewrites the stored content.
    expect(docJSONEqual(readDocJSON(doc), kitchenSinkDoc())).toBe(true);
  });

  it('opening an empty page writes nothing', () => {
    const doc = new Y.Doc();
    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });
    setup({ doc });
    expect(updates).toBe(0);
  });

  it('writes edits to Yjs as valid DocJSON', () => {
    const { editor, doc } = setup({ content: b.doc(b.paragraph('Hello')) });
    editor.commands.setTextSelection(6);
    editor.commands.insertContent(' world');
    editor.commands.enter();
    editor.commands.insertContent('Second');
    const stored = readDocJSON(doc);
    expect(validateDocJSON(stored).ok).toBe(true);
    expect(stored.content.map((block) => block.type)).toEqual(['paragraph', 'paragraph']);
    expect(blockTexts(editor)).toEqual(['paragraph:Hello world', 'paragraph:Second']);
  });

  it('assigns unique block IDs to new blocks, and a new one to the split half', () => {
    const { editor } = setup({ content: b.doc(b.paragraph('One')) });
    editor.commands.setTextSelection(4);
    editor.commands.insertContent('!');
    editor.commands.enter();
    editor.commands.insertContent('Two');
    editor.commands.enter();
    editor.commands.insertContent('Three');
    const ids: unknown[] = [];
    editor.state.doc.forEach((node) => ids.push(node.attrs.blockId));
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  it('gives pasted copies of a block a new ID and keeps the original', () => {
    const { editor } = setup({
      content: b.doc({ type: 'paragraph', attrs: { blockId: 'orig1234' }, content: [b.text('A')] }),
    });
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: 'paragraph',
      attrs: { blockId: 'orig1234' },
      content: [{ type: 'text', text: 'Copy' }],
    });
    const ids: unknown[] = [];
    editor.state.doc.forEach((node) => ids.push(node.attrs.blockId));
    expect(ids[0]).toBe('orig1234');
    expect(ids[1]).not.toBe('orig1234');
    expect(typeof ids[1]).toBe('string');
  });

  it('undo only reverts this user’s edits', () => {
    const local = new Y.Doc();
    const remote = new Y.Doc();
    writeDocJSON(local, b.doc(b.paragraph('Start')));
    cleanups.push(linkDocs(local, remote));
    const { editor } = setup({ doc: local });

    editor.commands.setTextSelection(6);
    editor.commands.insertContent(' mine');
    // Someone else edits the same page.
    updateDocJSON(remote, (current) => ({
      ...current,
      content: [...current.content, b.paragraph('Theirs')],
    }));
    expect(blockTexts(editor)).toEqual(['paragraph:Start mine', 'paragraph:Theirs']);

    editor.commands.undo();
    expect(blockTexts(editor)).toEqual(['paragraph:Start', 'paragraph:Theirs']);
    editor.commands.redo();
    expect(blockTexts(editor)).toEqual(['paragraph:Start mine', 'paragraph:Theirs']);
  });

  it('shows remote edits live and keeps both sides converged', () => {
    const a = new Y.Doc();
    const bDoc = new Y.Doc();
    cleanups.push(linkDocs(a, bDoc));
    const first = setup({ doc: a });
    const second = setup({ doc: bDoc });
    first.editor.commands.insertContent('From A');
    expect(blockTexts(second.editor)).toEqual(['paragraph:From A']);
    second.editor.commands.setTextSelection(second.editor.state.doc.content.size - 1);
    second.editor.commands.insertContent(' and B');
    expect(blockTexts(first.editor)).toEqual(['paragraph:From A and B']);
    expect(docJSONEqual(readDocJSON(a), readDocJSON(bDoc))).toBe(true);
  });

  it('two people typing at the same spot keep their words whole', () => {
    // Both carets after "Notes: "; the keys alternate between the two people, and both words
    // start with the same letter. Which word comes first depends on the clients' IDs: both orders.
    for (const [firstId, secondId] of [
      [1, 2],
      [2, 1],
    ]) {
      const a = new Y.Doc();
      const bDoc = new Y.Doc();
      a.clientID = firstId as number;
      bDoc.clientID = secondId as number;
      writeDocJSON(a, b.doc(b.paragraph('Notes: '), b.paragraph('Below')));
      cleanups.push(linkDocs(a, bDoc));
      const first = setup({ doc: a });
      const second = setup({ doc: bDoc });
      first.editor.commands.setTextSelection(8);
      second.editor.commands.setTextSelection(8);
      const mine = 'engine room';
      const theirs = 'east wing';
      for (let index = 0; index < Math.max(mine.length, theirs.length); index += 1) {
        if (index < mine.length) typeText(first.editor, mine.charAt(index));
        if (index < theirs.length) typeText(second.editor, theirs.charAt(index));
      }
      const [line] = blockTexts(first.editor);
      expect(blockTexts(second.editor)).toEqual(blockTexts(first.editor));
      // Each caret stays after its own last character, so neither run is split or reordered.
      expect([`paragraph:Notes: ${mine}${theirs}`, `paragraph:Notes: ${theirs}${mine}`]).toContain(
        line,
      );
    }
  });

  it('a caret follows text someone else types before it in the same block', () => {
    const a = new Y.Doc();
    const bDoc = new Y.Doc();
    writeDocJSON(a, b.doc(b.paragraph('Launch at noon')));
    cleanups.push(linkDocs(a, bDoc));
    const first = setup({ doc: a });
    const second = setup({ doc: bDoc });
    first.editor.commands.setTextSelection(15);
    second.editor.commands.setTextSelection(1);
    typeText(second.editor, 'Update: ');
    typeText(first.editor, ' sharp');
    expect(blockTexts(first.editor)).toEqual(['paragraph:Update: Launch at noon sharp']);
    expect(blockTexts(second.editor)).toEqual(['paragraph:Update: Launch at noon sharp']);
  });
});

describe('undo and redo across structural changes', () => {
  it('redoes a step that removed a block (y-tiptap stale selection regression)', () => {
    const { editor, doc } = setup({ content: b.doc(b.paragraph()) });
    editor.commands.focus('end');
    const undoManager = () =>
      (yUndoPluginKey.getState(editor.state) as { undoManager: { stopCapturing(): void } })
        .undoManager;
    typeText(editor, 'Head');
    undoManager().stopCapturing();
    pressKey(editor, 'Enter');
    typeText(editor, 'x');
    undoManager().stopCapturing();
    for (let round = 0; round < 3; round += 1) {
      editor.commands.undo();
      expect(blockTexts(editor)).toEqual(['paragraph:Head']);
      expect(readDocJSON(doc).content).toHaveLength(1);
      editor.commands.redo();
      expect(blockTexts(editor)).toEqual(['paragraph:Head', 'paragraph:x']);
      expect(readDocJSON(doc).content).toHaveLength(2);
    }
  });

  // The same y-tiptap bug: an undo step's saved caret must not reach the next Yjs transaction.
  it('keeps the caret in place when someone else edits right after an undo', () => {
    const a = new Y.Doc();
    const bDoc = new Y.Doc();
    writeDocJSON(a, b.doc(b.paragraph('Agenda'), b.paragraph('Minutes')));
    cleanups.push(linkDocs(a, bDoc));
    const mine = setup({ doc: a });
    const theirs = setup({ doc: bDoc });
    mine.editor.commands.setTextSelection(7);
    typeText(mine.editor, ' draft');
    // Back at the end of "Minutes", undo the typing.
    mine.editor.commands.setTextSelection(mine.editor.state.doc.content.size - 1);
    mine.editor.commands.undo();
    // Before my next keystroke, someone else types at the start of "Minutes".
    theirs.editor.commands.setTextSelection(9);
    typeText(theirs.editor, 'Re: ');
    typeText(mine.editor, ' approved');

    expect(blockTexts(mine.editor)).toEqual(['paragraph:Agenda', 'paragraph:Re: Minutes approved']);
    expect(blockTexts(theirs.editor)).toEqual(blockTexts(mine.editor));
  });

  it('never leaves a block selected for the next keystroke to replace, after an undo', () => {
    const a = new Y.Doc();
    const bDoc = new Y.Doc();
    writeDocJSON(a, b.doc(b.paragraph('Above'), b.horizontalRule(), b.paragraph('Below')));
    cleanups.push(linkDocs(a, bDoc));
    const mine = setup({ doc: a });
    const theirs = setup({ doc: bDoc });
    // Select the divider and delete it, then undo from the end of "Below".
    mine.editor.commands.setNodeSelection(7);
    mine.editor.commands.deleteSelection();
    mine.editor.commands.setTextSelection(mine.editor.state.doc.content.size - 1);
    mine.editor.commands.undo();
    // Before my next keystroke, someone else types in "Above".
    theirs.editor.commands.setTextSelection(1);
    typeText(theirs.editor, 'See ');
    typeText(mine.editor, '!');

    expect(blockTexts(mine.editor)).toEqual([
      'paragraph:See Above',
      'horizontalRule:',
      'paragraph:Below!',
    ]);
    expect(blockTexts(theirs.editor)).toEqual(blockTexts(mine.editor));
  });

  it('makes block operations undo steps of their own, even right after typing', () => {
    const { editor } = setup({ content: b.doc(b.paragraph('Ignition'), b.paragraph('Orbit')) });
    editor.commands.focus('end');
    typeText(editor, ' reached');
    // Within the undo manager's half-second capture window: without separate steps, one undo
    // would revert the typing as well.
    const second = () => ({
      pos: editor.state.doc.child(0).nodeSize,
      node: editor.state.doc.child(1),
    });
    duplicateBlock(editor, second());
    expect(blockTexts(editor)).toEqual([
      'paragraph:Ignition',
      'paragraph:Orbit reached',
      'paragraph:Orbit reached',
    ]);
    moveBlock(editor, second(), 'up');
    deleteBlocks(editor, [{ pos: 0, node: editor.state.doc.child(0) }]);
    expect(blockTexts(editor)).toEqual(['paragraph:Ignition', 'paragraph:Orbit reached']);
    typeText(editor, '!');
    editor.commands.undo();
    expect(blockTexts(editor)).toEqual(['paragraph:Ignition', 'paragraph:Orbit reached']);
    editor.commands.undo();
    expect(blockTexts(editor)).toEqual([
      'paragraph:Orbit reached',
      'paragraph:Ignition',
      'paragraph:Orbit reached',
    ]);
    editor.commands.undo();
    expect(blockTexts(editor)).toEqual([
      'paragraph:Ignition',
      'paragraph:Orbit reached',
      'paragraph:Orbit reached',
    ]);
    editor.commands.undo();
    expect(blockTexts(editor)).toEqual(['paragraph:Ignition', 'paragraph:Orbit reached']);
    editor.commands.undo();
    expect(blockTexts(editor)).toEqual(['paragraph:Ignition', 'paragraph:Orbit']);
  });

  it('keeps undo keys away from the browser when there is nothing to undo', () => {
    const { editor } = setup({ content: b.doc(b.paragraph('Stay')) });
    expect(pressKey(editor, 'z', { mod: true })).toBe(true);
    expect(pressKey(editor, 'y', { mod: true })).toBe(true);
    expect(blockTexts(editor)).toEqual(['paragraph:Stay']);
  });
});
