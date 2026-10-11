import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEscapePastClosingLayer } from './escape';

afterEach(() => {
  vi.useRealTimers();
});

function Layer({
  state,
  onEscape,
  expose,
}: {
  state: 'open' | 'closed';
  onEscape: (event: KeyboardEvent) => void;
  expose: (handler: (event: KeyboardEvent) => void) => void;
}) {
  const escape = useEscapePastClosingLayer<HTMLDivElement>(onEscape);
  expose(escape.onEscapeKeyDown);
  return <div ref={escape.ref} data-state={state} />;
}

describe('useEscapePastClosingLayer', () => {
  it('hands Escape to an open layer, unchanged', () => {
    const onEscape = vi.fn();
    const layer: { handler?: (event: KeyboardEvent) => void } = {};
    render(<Layer state="open" onEscape={onEscape} expose={(h) => (layer.handler = h)} />);
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    layer.handler?.(event);
    expect(onEscape).toHaveBeenCalledWith(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('lets a closing layer pass Escape on to the layer under it once it has unmounted', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'performance'] });
    const onEscape = vi.fn();
    const replayed = vi.fn();
    document.addEventListener('keydown', replayed);
    const layer: { handler?: (event: KeyboardEvent) => void } = {};
    const view = render(
      <Layer state="closed" onEscape={onEscape} expose={(h) => (layer.handler = h)} />,
    );

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    layer.handler?.(event);
    // The closing layer doesn't handle it (Radix then leaves it alone too)…
    expect(onEscape).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    // …and nothing is replayed while it is still on screen, animating out.
    act(() => vi.advanceTimersByTime(100));
    expect(replayed).not.toHaveBeenCalled();

    view.unmount();
    act(() => vi.advanceTimersByTime(20));
    expect(replayed).toHaveBeenCalledTimes(1);
    expect(replayed.mock.calls[0]?.[0]).toMatchObject({ key: 'Escape' });
    document.removeEventListener('keydown', replayed);
  });

  it('drops the press if the closing layer never unmounts, rather than looping', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'performance'] });
    const replayed = vi.fn();
    document.addEventListener('keydown', replayed);
    const layer: { handler?: (event: KeyboardEvent) => void } = {};
    render(<Layer state="closed" onEscape={vi.fn()} expose={(h) => (layer.handler = h)} />);
    layer.handler?.(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    act(() => vi.advanceTimersByTime(3_000));
    expect(replayed).not.toHaveBeenCalled();
    document.removeEventListener('keydown', replayed);
  });
});
