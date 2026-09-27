import { build as b, docJSONEqual, readDocJSON, writeDocJSON } from '@tessera/core';
import type { Editor } from '@tiptap/core';
import { ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { deleteBlocks, moveBlock } from '../actions/blocks';
import { createTestEditor, linkDocs, pressKey, typeText } from '../test-utils';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup(...args: Parameters<typeof createTestEditor>) {
  const result = createTestEditor(...args);
  cleanups.push(result.destroy);
  return result;
}

/** Every position inside a textblock, where a caret can go. */
function textPositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    for (let offset = 0; offset <= node.content.size; offset += 1) positions.push(pos + 1 + offset);
    return false;
  });
  return positions;
}

function inSync(editor: Editor, doc: Y.Doc): boolean {
  return docJSONEqual(readDocJSON(doc), editor.getJSON());
}

describe('Yjs sync', () => {
  it('handles a keystroke with the same work on a long page as on a short one', () => {
    // Lookups in y-tiptap's map between Yjs types and ProseMirror nodes, for one keystroke in
    // the middle of the page: diffing the page or walking it to the caret looks up every block.
    const lookups = (blocks: number) => {
      const content = b.doc(
        ...Array.from({ length: blocks }, (_, index) => b.paragraph(`Log entry ${index + 1}`)),
      );
      const { editor, doc } = setup({ content });
      let end = 0;
      editor.state.doc.forEach((node, offset, index) => {
        if (index === Math.floor(blocks / 2)) end = offset + node.nodeSize - 1;
      });
      editor.commands.setTextSelection(end);
      const { binding } = ySyncPluginKey.getState(editor.state) as {
        binding: { mapping: Map<unknown, unknown> };
      };
      const get = vi.spyOn(binding.mapping, 'get');
      typeText(editor, '!');
      const count = get.mock.calls.length;
      get.mockRestore();
      expect(inSync(editor, doc)).toBe(true);
      return count;
    };
    expect(lookups(1000)).toBe(lookups(10));
  });

  it('keeps Yjs identical to the page through random edits, undo, redo and a collaborator', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      let state = seed;
      const random = () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
      };
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      const mineDoc = new Y.Doc();
      const theirsDoc = new Y.Doc();
      writeDocJSON(
        mineDoc,
        b.doc(
          b.heading(2, 'Day 1: orbit 3'),
          b.paragraph('Crew woke at 06:00 and ran the ', b.text('checklist', b.mark.bold())),
          b.bulletList(
            b.listItem(b.paragraph('Water: nominal')),
            b.listItem(b.paragraph('Oxygen')),
          ),
          b.toggle('Flight surgeon notes', [b.paragraph('Heart rates steady.')]),
          b.horizontalRule(),
          b.paragraph('End of day report filed.'),
        ),
      );
      cleanups.push(linkDocs(mineDoc, theirsDoc));
      const mine = setup({ doc: mineDoc });
      const theirs = setup({ doc: theirsDoc });
      const undoManager = () =>
        (yUndoPluginKey.getState(mine.editor.state) as { undoManager: Y.UndoManager }).undoManager;
      const history: string[] = [];
      for (let step = 0; step < 40; step += 1) {
        const editor = random() < 0.3 ? theirs.editor : mine.editor;
        const who = editor === mine.editor ? 'I' : 'they';
        const positions = textPositions(editor);
        const roll = random();
        if (roll < 0.35 && positions.length) {
          const at = pick(positions);
          editor.commands.setTextSelection(at);
          const text = pick(['x', 'go ', ' ']);
          typeText(editor, text);
          history.push(`${who} type ${JSON.stringify(text)} at ${at}`);
        } else if (roll < 0.43 && positions.length) {
          const [one, other] = [pick(positions), pick(positions)];
          const [from, to] = [Math.min(one, other), Math.max(one, other)];
          editor.chain().setTextSelection({ from, to }).toggleBold().run();
          history.push(`${who} bold ${from}-${to}`);
        } else if (roll < 0.5) {
          pressKey(editor, 'Enter');
          history.push(`${who} Enter`);
        } else if (roll < 0.57) {
          pressKey(editor, 'Backspace');
          history.push(`${who} Backspace`);
        } else if (roll < 0.63 && editor.state.doc.childCount > 2) {
          const index = Math.floor(random() * (editor.state.doc.childCount - 1));
          let pos = 0;
          for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
          moveBlock(editor, { pos, node: editor.state.doc.child(index) }, 'down');
          history.push(`${who} move block ${index} down`);
        } else if (roll < 0.67 && editor.state.doc.childCount > 1) {
          const index = Math.floor(random() * editor.state.doc.childCount);
          let pos = 0;
          for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
          deleteBlocks(editor, [{ pos, node: editor.state.doc.child(index) }]);
          history.push(`${who} delete block ${index}`);
        } else if (roll < 0.85) {
          if (random() < 0.5) undoManager().stopCapturing();
          mine.editor.commands.undo();
          history.push('I undo');
        } else {
          mine.editor.commands.redo();
          history.push('I redo');
        }
        if (!inSync(mine.editor, mineDoc) || !inSync(theirs.editor, theirsDoc))
          throw new Error(`seed ${seed}: out of sync after ${history.join(', ')}`);
      }
      expect(readDocJSON(theirsDoc)).toEqual(readDocJSON(mineDoc));
      while (cleanups.length) cleanups.pop()?.();
    }
  }, 60_000);
});
