import { Collaboration } from '@tiptap/extension-collaboration';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Plugin } from '@tiptap/pm/state';
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
    const prosemirrorChanged = binding._prosemirrorChanged.bind(binding);
    binding._prosemirrorChanged = (doc: PMNode) => {
      if (binding.beforeTransactionSelection !== LOCAL_SYNC) {
        prosemirrorChanged(doc);
        return;
      }
      binding.doc.transact(() => {
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
        try {
          pluginView.update?.(updated, previous);
        } finally {
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
