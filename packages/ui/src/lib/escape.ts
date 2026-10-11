import { useCallback, useRef, type Ref, type RefCallback } from 'react';

/** How long a closing layer may stay mounted before a held-back Escape is dropped. */
const MAX_EXIT_MS = 1_000;

/**
 * Radix keeps a popover, menu or dialog mounted while it plays its exit animation, and still
 * treats it as the top layer, so an Escape pressed during that animation reached the closing layer
 * and did nothing: the layer under it needed a second press (#8). With this, a closing layer lets
 * the press go: it ignores it, and once it has unmounted the press is replayed, so it reaches the
 * layer that is now on top. Each press still closes one layer.
 *
 * @example
 * const escape = useEscapePastClosingLayer(props.onEscapeKeyDown, props.ref);
 * <PopoverPrimitive.Content {...props} ref={escape.ref} onEscapeKeyDown={escape.onEscapeKeyDown} />
 */
export function useEscapePastClosingLayer<E extends HTMLElement>(
  onEscapeKeyDown: ((event: KeyboardEvent) => void) | undefined,
  forwardedRef?: Ref<E>,
): { ref: RefCallback<E>; onEscapeKeyDown: (event: KeyboardEvent) => void } {
  const element = useRef<E | null>(null);
  const ref = useCallback(
    (node: E | null) => {
      element.current = node;
      if (typeof forwardedRef === 'function') return forwardedRef(node);
      if (forwardedRef) forwardedRef.current = node;
      return undefined;
    },
    [forwardedRef],
  );
  const handle = useCallback(
    (event: KeyboardEvent) => {
      const node = element.current;
      if (node?.getAttribute('data-state') === 'closed') {
        // Nothing left to close here: keep this layer from handling it, and pass it on.
        event.preventDefault();
        replayWhenGone(node);
        return;
      }
      onEscapeKeyDown?.(event);
    },
    [onEscapeKeyDown],
  );
  return { ref, onEscapeKeyDown: handle };
}

/** Dispatches Escape again once `node` has left the document (the next layer is then on top). */
function replayWhenGone(node: HTMLElement): void {
  const document = node.ownerDocument;
  const view = document.defaultView;
  if (!view) return;
  const started = view.performance.now();
  const check = () => {
    if (!node.isConnected) {
      document.dispatchEvent(
        new view.KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    } else if (view.performance.now() - started < MAX_EXIT_MS) {
      view.requestAnimationFrame(check);
    }
    // Still mounted after a second: drop the press rather than replay it to the same layer.
  };
  view.requestAnimationFrame(check);
}
