import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';

export const historyGuardKey = new PluginKey('tesseraHistoryGuard');
export const historyKeysKey = new PluginKey('tesseraHistoryKeys');

/** Transaction meta: the change is an undo step of its own (see {@link ownUndoStep}). */
export const UNDO_STEP = 'tesseraUndoStep';

/**
 * Marks a block operation (delete, move, duplicate, turn into, insert…) as an undo step of its
 * own. The Yjs undo manager merges every change made within half a second into one step, so
 * without this, deleting blocks right after typing would undo the typing too.
 */
export function ownUndoStep(tr: Transaction): Transaction {
  return tr.setMeta(UNDO_STEP, true);
}

/** ProseMirror's own UI events that are separate steps too. */
const STEP_EVENTS = new Set(['paste', 'drop', 'cut']);

/**
 * Undo and redo keys, ahead of every other keymap: Mod+Z undoes, Mod+Y and Mod+Shift+Z redo, and
 * they are always handled. An empty history must never fall through to the browser's own
 * contenteditable undo (which edits the DOM behind ProseMirror's back), and a redo with nothing
 * to redo must never fall back to the unshifted Mod+Z binding (undo). The Edit menu's
 * undo and redo (`historyUndo` / `historyRedo` input events) go through Yjs too.
 */
export const HistoryKeys = Extension.create({
  name: 'historyKeys',
  priority: 1100,

  addKeyboardShortcuts() {
    const run = (action: 'undo' | 'redo') => () => {
      if (action === 'undo') this.editor.commands.undo();
      else this.editor.commands.redo();
      return true;
    };
    return {
      'Mod-z': run('undo'),
      'Mod-y': run('redo'),
      'Shift-Mod-z': run('redo'),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: historyKeysKey,
        props: {
          handleDOMEvents: {
            beforeinput: (_view, event) => {
              const input = event as InputEvent;
              if (input.inputType !== 'historyUndo' && input.inputType !== 'historyRedo')
                return false;
              event.preventDefault();
              if (input.inputType === 'historyUndo') this.editor.commands.undo();
              else this.editor.commands.redo();
              return true;
            },
          },
        },
      }),
    ];
  },
});

interface RelativeSelectionLike {
  absAnchor?: number | null;
  absHead?: number | null;
  [key: string]: unknown;
}

interface BindingLike {
  doc: Y.Doc;
  beforeTransactionSelection: RelativeSelectionLike | null;
}

interface UndoManagerLike {
  on(event: 'stack-item-popped', listener: () => void): void;
  off(event: 'stack-item-popped', listener: () => void): void;
  stopCapturing(): void;
}

/**
 * Undo steps and a y-tiptap fix. Block operations (see {@link ownUndoStep}) and pastes, drops and
 * cuts become undo steps of their own: the undo manager stops capturing before them and after them.
 *
 * It also keeps undo and redo reliable on top of `@tiptap/y-tiptap` 3.0.9 (issue #2). When an undo
 * or redo step is popped, y-tiptap hands the step's saved selection to the binding, meaning to
 * restore it while the step is applied. But Yjs announces the pop only after the step's
 * transaction has ended, so the *next* Yjs transaction gets it instead: a redo, or a
 * collaborator's keystroke. That moves the caret back to where it was when the step was recorded
 * (or selects a whole block, which the next keystroke replaces), and resolves the selection's
 * absolute positions, from an older document, against the current one. That can throw
 * (RangeError), which drops the update and leaves ProseMirror out of sync with Yjs (a redo that
 * never appears). So once the step's transaction is over, the selection is dropped here; popped
 * inside a caller's transaction, it is used there, without its absolute positions.
 */
export const HistoryGuard = Extension.create({
  name: 'historyGuard',
  // After Collaboration (priority 1000), so this listener runs after y-tiptap's own.
  priority: 90,

  addProseMirrorPlugins() {
    return [
      new Plugin<boolean>({
        key: historyGuardKey,
        state: {
          // Whether the last local change was an undo step of its own.
          init: () => false,
          apply(tr, previous, oldState) {
            // Remote changes and undo/redo themselves never add undo steps.
            if (!tr.docChanged || tr.getMeta(ySyncPluginKey) !== undefined) return previous;
            const step =
              tr.getMeta(UNDO_STEP) === true || STEP_EVENTS.has(String(tr.getMeta('uiEvent')));
            if (step || previous) {
              const undo = yUndoPluginKey.getState(oldState) as
                { undoManager?: UndoManagerLike } | undefined;
              undo?.undoManager?.stopCapturing();
            }
            return step;
          },
        },
        view: (view) => {
          const undoManager = (
            yUndoPluginKey.getState(view.state) as { undoManager?: UndoManagerLike } | undefined
          )?.undoManager;
          if (!undoManager) return {};
          const sanitize = () => {
            const binding = (
              ySyncPluginKey.getState(view.state) as { binding?: BindingLike } | undefined
            )?.binding;
            const selection = binding?.beforeTransactionSelection;
            if (!binding || !selection) return;
            // No transaction left to run (Yjs empties this list just before `afterAllTransactions`,
            // where y-tiptap clears the selection): nothing would use it but the next transaction.
            if (binding.doc._transactionCleanups.length === 0) {
              binding.beforeTransactionSelection = null;
            } else if (selection.absAnchor != null || selection.absHead != null) {
              binding.beforeTransactionSelection = { ...selection, absAnchor: null, absHead: null };
            }
          };
          undoManager.on('stack-item-popped', sanitize);
          return { destroy: () => undoManager.off('stack-item-popped', sanitize) };
        },
      }),
    ];
  },
});
