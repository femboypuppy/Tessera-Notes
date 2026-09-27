import { Collaboration } from '@tiptap/extension-collaboration';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Plugin, Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { updateYFragment, ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

/** The binding's mapping between Yjs types and ProseMirror nodes (not exported by name). */
type BindingMetadata = Parameters<typeof updateYFragment>[3];

/** The parts of y-tiptap's binding used here. */
interface SyncBinding extends BindingMetadata {
  doc: Y.Doc;
  type: Y.XmlFragment;
  beforeTransactionSelection: unknown;
  _prosemirrorChanged(doc: PMNode): void;
}

/** y-tiptap's undo plugin state. */
interface UndoPluginState {
  undoManager: Y.UndoManager;
  prevSel: unknown;
  hasUndoOps: boolean;
  hasRedoOps: boolean;
}

/**
 * Takes the place of the selection y-tiptap saves when a Yjs transaction begins, during its own
 * sync of a local change: nothing reads that selection there.
 */
const LOCAL_SYNC = Object.freeze({ anchor: null, head: null, absAnchor: null, absHead: null });

/**
 * The undo plugin saves the selection with every transaction, for the next undo step: a conversion
 * to Yjs relative positions that walks the page from its start to the caret. That saved selection
 * is never restored ({@link HistoryGuard} drops it), so the plugin's state keeps `prevSel` null.
 */
function skipSavedSelections(plugin: Plugin): void {
  const field = plugin.spec.state;
  if (!field) return;
  field.apply = (_tr, value: UndoPluginState) => {
    const hasUndoOps = value.undoManager.undoStack.length > 0;
    const hasRedoOps = value.undoManager.redoStack.length > 0;
    if (
      value.prevSel === null &&
      hasUndoOps === value.hasUndoOps &&
      hasRedoOps === value.hasRedoOps
    )
      return value;
    return { ...value, prevSel: null, hasUndoOps, hasRedoOps };
  };
}

/**
 * Writes `doc` to Yjs when it differs from the page as last synced in at most one top-level block:
 * that block is updated the way `updateYFragment` updates it after diffing the whole page, which
 * finds the same block. Returns false when the page doesn't line up that way (blocks added,
 * removed, moved or turned into another type, or a change from Yjs since the last sync).
 */
function syncChangedBlock(binding: SyncBinding, doc: PMNode): boolean {
  // `updateYFragment` maps the fragment to the document it syncs; applying a Yjs change clears it.
  const synced = binding.mapping.get(binding.type);
  if (synced === doc) return true;
  if (!synced || Array.isArray(synced)) return false;
  const count = doc.childCount;
  if (synced.childCount !== count || binding.type.length !== count) return false;
  let changed = -1;
  for (let index = 0; index < count; index += 1) {
    if (doc.child(index) === synced.child(index)) continue;
    if (changed >= 0) return false;
    changed = index;
  }
  if (changed >= 0) {
    const yBlock = binding.type.get(changed);
    const block = doc.child(changed);
    if (
      !(yBlock instanceof Y.XmlElement) ||
      yBlock.nodeName !== block.type.name ||
      binding.mapping.get(yBlock) !== synced.child(changed)
    )
      return false;
    updateYFragment(binding.doc, yBlock, block, binding);
  }
  binding.mapping.set(binding.type, doc);
  return true;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** Whether `index` falls between the two halves of a character outside the Basic Plane. */
const splitsPair = (text: string, index: number) =>
  index > 0 &&
  isHighSurrogate(text.charCodeAt(index - 1)) &&
  isLowSurrogate(text.charCodeAt(index));

/**
 * How `before` became `after` by inserting or deleting text right where the caret now is
 * (`caret`, an offset in `after`: typing ends at the caret, Backspace and Delete leave it where
 * the text was). Null when the change is not that, or when a plain diff places it there too.
 *
 * Next to identical characters, the same change fits several places ("a" typed into "a" gives
 * "aa" whether it went before or after the first one) and a plain diff takes the last. Every place
 * gives exactly `after`: only which characters count as the new ones differs.
 */
export function editAtCaret(
  before: string,
  after: string,
  caret: number,
): { index: number; remove: number; insert: string } | null {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length &&
    suffix < after.length &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;
  const inserted = after.length - before.length;
  if (inserted > 0) {
    // Inserted at `index`: `before` up to there stays in front of it, the rest behind it.
    const index = caret - inserted;
    if (index < 0 || index < before.length - suffix || index >= Math.min(prefix, before.length))
      return null;
    if (splitsPair(after, index) || splitsPair(after, caret)) return null;
    return { index, remove: 0, insert: after.slice(index, caret) };
  }
  if (inserted < 0) {
    const index = caret;
    if (index < after.length - suffix || index >= Math.min(prefix, after.length)) return null;
    if (splitsPair(before, index) || splitsPair(before, index - inserted)) return null;
    return { index, remove: -inserted, insert: '' };
  }
  return null;
}

/** A textblock's content as y-tiptap stores it: runs of text (a Y.XmlText each) and inline nodes. */
function inlineRuns(block: PMNode): Array<PMNode | PMNode[]> {
  const runs: Array<PMNode | PMNode[]> = [];
  block.forEach((child) => {
    const last = runs[runs.length - 1];
    if (child.isText && Array.isArray(last)) last.push(child);
    else runs.push(child.isText ? [child] : child);
  });
  return runs;
}

const runSize = (run: PMNode | PMNode[]) =>
  Array.isArray(run) ? run.reduce((size, text) => size + text.nodeSize, 0) : run.nodeSize;
const runText = (run: PMNode[]) => run.map((text) => text.text ?? '').join('');
const sameRun = (a: PMNode | PMNode[] | undefined, b: PMNode | PMNode[] | undefined) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((text, index) => text === b[index])
    : a === b;

/**
 * Writes the edit at the caret to Yjs before y-tiptap does (issue #4). y-tiptap finds what changed
 * in a text by diffing it, without knowing where the caret is: next to identical characters it can
 * take someone else's character for the new one, so what's typed next follows their text instead
 * of the typist's (two people typing a space at the same spot swapped that space). Here, the text
 * holding the caret gets the edit placed at the caret ({@link editAtCaret}), and y-tiptap then
 * finds it up to date.
 *
 * Only when the page as last synced (`before`) and `doc` differ in that text alone, and Yjs holds
 * that text as it was synced; otherwise y-tiptap writes everything as usual.
 */
function writeEditAtCaret(
  binding: SyncBinding,
  before: PMNode,
  doc: PMNode,
  selection: Selection,
): void {
  if (!selection.empty) return;
  const { $head } = selection;
  if (!$head.parent.isTextblock) return;
  let synced = before;
  let current = doc;
  let yParent: Y.XmlFragment = binding.type;
  for (let depth = 0; depth < $head.depth; depth += 1) {
    const index = $head.index(depth);
    const count = current.childCount;
    if (synced.childCount !== count || yParent.length !== count) return;
    for (let other = 0; other < count; other += 1)
      if (other !== index && current.child(other) !== synced.child(other)) return;
    const yChild = yParent.get(index);
    synced = synced.child(index);
    current = current.child(index);
    if (!(yChild instanceof Y.XmlElement) || yChild.nodeName !== current.type.name) return;
    yParent = yChild;
  }
  // `yParent` holds the caret's textblock, as synced from `synced`.
  if (binding.mapping.get(yParent) !== synced) return;
  const syncedRuns = inlineRuns(synced);
  const runs = inlineRuns(current);
  if (runs.length !== syncedRuns.length || yParent.length !== runs.length) return;
  // The one run that changed, and where it starts in the textblock.
  let changed = -1;
  let start = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index] as PMNode | PMNode[];
    if (sameRun(run, syncedRuns[index])) {
      if (changed < 0) start += runSize(run);
    } else if (changed < 0) {
      changed = index;
    } else {
      return;
    }
  }
  const run = runs[changed];
  const syncedRun = syncedRuns[changed];
  const yText = yParent.get(changed);
  if (!Array.isArray(run) || !Array.isArray(syncedRun) || !(yText instanceof Y.XmlText)) return;
  const text = runText(syncedRun);
  const delta = yText.toDelta() as Array<{ insert: unknown }>;
  if (delta.some((op) => typeof op.insert !== 'string')) return;
  if (delta.map((op) => op.insert).join('') !== text) return;
  const edit = editAtCaret(text, runText(run), $head.parentOffset - start);
  if (!edit) return;
  if (edit.remove) yText.delete(edit.index, edit.remove);
  if (edit.insert) yText.insert(edit.index, edit.insert);
}

/**
 * After every view update, y-tiptap writes the document to Yjs in a transaction of its own. On a
 * long page, most of that work is the same whatever changed: `updateYFragment` diffs every
 * top-level block, and the selection is converted to Yjs relative positions twice (when the
 * transaction begins, and after the diff), each a walk from the start of the page to the caret,
 * and nothing uses either conversion in that transaction. Here, that transaction skips both
 * conversions and updates only the block that changed (see {@link syncChangedBlock}); everything
 * else goes through y-tiptap as is.
 */
function trimLocalSync(plugin: Plugin): void {
  const createView = plugin.spec.view;
  if (!createView) return;
  plugin.spec.view = (view: EditorView) => {
    const pluginView = createView(view);
    const binding = (ySyncPluginKey.getState(view.state) as { binding?: SyncBinding } | undefined)
      ?.binding;
    if (!binding) return pluginView;
    // The document before the view update being synced.
    let before: PMNode | null = null;
    const prosemirrorChanged = binding._prosemirrorChanged.bind(binding);
    binding._prosemirrorChanged = (doc: PMNode) => {
      if (binding.beforeTransactionSelection !== LOCAL_SYNC) {
        prosemirrorChanged(doc);
        return;
      }
      binding.doc.transact(() => {
        if (before) writeEditAtCaret(binding, before, doc, view.state.selection);
        if (!syncChangedBlock(binding, doc))
          updateYFragment(binding.doc, binding.type, doc, binding);
      }, ySyncPluginKey);
    };
    return {
      update: (updated: EditorView, previous: EditorState) => {
        // y-tiptap's `beforeAllTransactions` saves the selection only when none is saved, and
        // `afterAllTransactions` clears it: marking the sync here skips that walk. Only outside
        // any Yjs transaction; inside one, the saved selection is that transaction's.
        const local =
          binding.beforeTransactionSelection === null &&
          binding.doc._transactionCleanups.length === 0;
        if (local) binding.beforeTransactionSelection = LOCAL_SYNC;
        const outer = before;
        before = previous.doc;
        try {
          pluginView.update?.(updated, previous);
        } finally {
          before = outer;
          if (local && binding.beforeTransactionSelection === LOCAL_SYNC)
            binding.beforeTransactionSelection = null;
        }
      },
      destroy: () => pluginView.destroy?.(),
    };
  };
}

/**
 * TipTap's Collaboration (Yjs through `@tiptap/y-tiptap` 3.0.9), with less work per keystroke.
 * y-tiptap does work in proportion to the page for every keystroke (issue #1): on a 2,000-block
 * page, about half of the editor's processing per keystroke in Firefox. This removes what Tessera
 * doesn't use ({@link skipSavedSelections}) and what can be skipped when one block changed
 * ({@link trimLocalSync}), without changing what gets written to Yjs.
 */
export const TesseraCollaboration = Collaboration.extend({
  addProseMirrorPlugins() {
    const plugins = this.parent?.() ?? [];
    for (const plugin of plugins) {
      if (plugin.spec.key === yUndoPluginKey) skipSavedSelections(plugin);
      if (plugin.spec.key === ySyncPluginKey) trimLocalSync(plugin);
    }
    return plugins;
  },
});
