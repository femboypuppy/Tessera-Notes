import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

export const remoteEditCaretKey = new PluginKey('tesseraRemoteEditCaret');

/** The part of y-tiptap's binding this extension touches (its caret saved before a change). */
interface BindingLike {
  beforeTransactionSelection: {
    anchor?: unknown;
    head?: unknown;
    absAnchor?: number | null;
    absHead?: number | null;
  } | null;
}

/**
 * Whether Yjs still resolves `position`, a relative position saved before `transaction`, to where
 * it belongs: every type it lies in still exists, and none of them became another block (its
 * `blockId` changed, which is how y-tiptap moves a block when it rewrites blocks in place). What
 * others inserted or deleted around the position doesn't matter: Yjs accounts for that.
 */
export function resolvesExactly(transaction: Y.Transaction, position: unknown): boolean {
  if (!(position instanceof Y.RelativePosition)) return false;
  const absolute = Y.createAbsolutePositionFromRelativePosition(position, transaction.doc);
  if (!absolute) return false;
  let type = absolute.type;
  while (type._item) {
    if (type._item.deleted || transaction.changed.get(type)?.has('blockId')) return false;
    const parent = type._item.parent;
    if (!(parent instanceof Y.AbstractType)) return false;
    type = parent;
  }
  return true;
}

/**
 * Keeps the caret where Yjs puts it when someone else edits around it (issue #3).
 *
 * After a remote change, `@tiptap/y-tiptap` 3.0.9 restores the caret from its Yjs relative
 * position (anchored to the character before it), then second-guesses it: if the text of the
 * caret's block changed, it takes the position as "misresolved" (a check meant for moved blocks),
 * finds the block again by its ID and puts the caret back at its old offset in it. So when a
 * collaborator typed in the same block before the caret, the caret no longer followed the text,
 * and the next keystrokes landed inside their words: two people typing at the same spot scrambled
 * each other's text.
 *
 * For each end of the selection that Yjs still resolves exactly (see {@link resolvesExactly}),
 * this drops the absolute position that check needs, so the Yjs position wins. An end in a block
 * someone moved keeps y-tiptap's recovery, which finds the block again. Undo and redo are
 * {@link HistoryGuard}'s.
 */
export const RemoteEditCaret = Extension.create<{ fragment: Y.XmlFragment | null }>({
  name: 'remoteEditCaret',

  addOptions() {
    return { fragment: null };
  },

  addProseMirrorPlugins() {
    const doc = this.options.fragment?.doc;
    if (!doc) return [];
    return [
      new Plugin({
        key: remoteEditCaretKey,
        view: (view) => {
          // After the change is in the doc and before observers run: y-tiptap restores the caret
          // in its observer, from the selection it saved when the transaction began.
          const onBeforeObserverCalls = (transaction: Y.Transaction) => {
            if (transaction.local) return;
            const binding = (
              ySyncPluginKey.getState(view.state) as { binding?: BindingLike } | undefined
            )?.binding;
            const selection = binding?.beforeTransactionSelection;
            if (!binding || !selection) return;
            const absAnchor = resolvesExactly(transaction, selection.anchor)
              ? null
              : selection.absAnchor;
            const absHead = resolvesExactly(transaction, selection.head) ? null : selection.absHead;
            if (absAnchor === selection.absAnchor && absHead === selection.absHead) return;
            binding.beforeTransactionSelection = { ...selection, absAnchor, absHead };
          };
          doc.on('beforeObserverCalls', onBeforeObserverCalls);
          return { destroy: () => doc.off('beforeObserverCalls', onBeforeObserverCalls) };
        },
      }),
    ];
  },
});
