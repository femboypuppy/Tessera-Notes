import { useMediaQuery } from '@tessera/ui';
import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from 'react';
import Sigma from 'sigma';
import type { Settings } from 'sigma/settings';
import type { EdgeAttributes, NodeAttributes, TesseraGraph } from './build';
import { ImagePan, isSoftwareRenderer, webglRendererName } from './image-pan';
import { placeLabels, type LabelCandidate } from './label-layout';
import { mix, type GraphTheme } from './theme';

/**
 * Test hooks for e2e specs and screenshots (only while the search test hooks are on): node
 * positions to click, and whether the layout has settled.
 */
export function useGraphTestHooks(
  canvas: { current: GraphCanvasHandle | null },
  running: boolean,
): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.__tesseraSearch) return undefined;
    const hooks = {
      nodePosition: (id: string) => canvas.current?.nodeClientPosition(id) ?? null,
      settled: () => !running,
    };
    const target = window as unknown as { __tesseraGraph?: typeof hooks };
    target.__tesseraGraph = hooks;
    return () => {
      if (target.__tesseraGraph === hooks) delete target.__tesseraGraph;
    };
  }, [canvas, running]);
}

/**
 * Whether this browser can create a WebGL context: graphics acceleration can be off, blocked or
 * missing (some virtual machines, locked-down or old browsers). The probe's context is released.
 */
export function webglAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const probe = document.createElement('canvas');
    const context = probe.getContext('webgl2') ?? probe.getContext('webgl');
    if (!context) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Imperative controls of a {@link GraphCanvas}. */
export interface GraphCanvasHandle {
  /** Centers the camera on a node (zooming in). */
  focusNode(id: string, ratio?: number): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Fits the whole graph. */
  reset(): void;
  /** A node's position in page coordinates (tests use it to click nodes), or null. */
  nodeClientPosition(id: string): { x: number; y: number } | null;
}

export interface GraphCanvasProps {
  graph: TesseraGraph;
  theme: GraphTheme;
  /** The focused page (search): it and its neighbors stay bright. */
  focused: string | null;
  onNodeClick(id: string): void;
  /** WebGL is unavailable (or the renderer failed to start). */
  onError?(error: unknown): void;
  /** Labels show for nodes at least this big on screen. */
  labelThreshold?: number;
  /** Space kept around the graph, in pixels (labels extend to the right of nodes). */
  padding?: number;
  /** Large graphs hide edges and labels while the camera moves, so panning stays fluid. */
  large?: boolean;
  className?: string;
  style?: CSSProperties;
  label: string;
  describedBy?: string;
}

type SigmaSettings = Partial<Settings<NodeAttributes, EdgeAttributes>>;

/** A label sigma picked during a render, drawn once the render is done (see `drawLabels`). */
interface QueuedLabel extends LabelCandidate {
  context: CanvasRenderingContext2D;
  text: string;
  x: number;
  y: number;
  font: string;
}

/**
 * Draws the labels picked during a render, leaving out any that would run into another
 * (`placeLabels`), then empties the queue. Labels get a halo in the background color, so they stay
 * legible over edges and nodes.
 */
function drawLabels(queue: QueuedLabel[], theme: GraphTheme): void {
  for (const { context, text, x, y, font } of placeLabels(queue)) {
    context.font = font;
    context.lineJoin = 'round';
    context.lineWidth = 4;
    context.strokeStyle = theme.background;
    context.strokeText(text, x, y);
    context.fillStyle = theme.label;
    context.fillText(text, x, y);
  }
  queue.length = 0;
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function settingsFor(
  theme: GraphTheme,
  labelThreshold: number,
  padding: number,
  large: boolean,
  labels: QueuedLabel[],
): SigmaSettings {
  return {
    hideEdgesOnMove: large,
    hideLabelsOnMove: large,
    labelFont: theme.font,
    labelSize: 12,
    labelWeight: '500',
    labelColor: { color: theme.label },
    labelDensity: 0.4,
    labelGridCellSize: 180,
    labelRenderedSizeThreshold: labelThreshold,
    defaultEdgeColor: theme.edge,
    defaultNodeColor: theme.neutral,
    zIndex: true,
    minCameraRatio: 0.04,
    maxCameraRatio: 6,
    stagePadding: padding,
    allowInvalidContainer: true,
    // Sigma picks the labels; they are drawn after the render, so overlapping ones can be left out.
    defaultDrawNodeLabel: (context, data, settings) => {
      if (!data.label) return;
      const size = settings.labelSize;
      const font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
      context.font = font;
      const x = data.x + data.size + 4;
      const y = data.y + size / 3;
      const width = context.measureText(data.label).width;
      labels.push({
        context,
        text: data.label,
        x,
        y,
        font,
        size: data.size,
        forced: data.forceLabel === true,
        // The halo reaches 2 px around the text.
        box: { left: x - 2, top: y - size, right: x + width + 2, bottom: y + size * 0.3 + 2 },
      });
    },
    // The default hover label is always white; this one follows the theme.
    defaultDrawNodeHover: (context, data, settings) => {
      const size = settings.labelSize;
      const text = data.label ?? '';
      context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
      const width = context.measureText(text).width;
      const boxX = data.x + data.size + 6;
      const boxY = data.y - size / 2 - 6;
      const boxWidth = width + 14;
      const boxHeight = size + 12;
      context.save();
      context.shadowColor = theme.dark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(15, 15, 15, 0.16)';
      context.shadowBlur = 12;
      context.shadowOffsetY = 3;
      context.fillStyle = theme.surface;
      roundRect(context, boxX, boxY, boxWidth, boxHeight, 6);
      context.fill();
      context.restore();
      context.strokeStyle = theme.border;
      context.lineWidth = 1;
      roundRect(context, boxX, boxY, boxWidth, boxHeight, 6);
      context.stroke();
      context.fillStyle = theme.labelStrong;
      context.textBaseline = 'middle';
      context.fillText(text, boxX + 7, data.y);
      context.textBaseline = 'alphabetic';
      // A ring around the node.
      context.beginPath();
      context.arc(data.x, data.y, data.size + 2.5, 0, Math.PI * 2);
      context.strokeStyle = data.color;
      context.lineWidth = 2;
      context.stroke();
    },
  };
}

/**
 * A sigma.js (WebGL) rendering of a graph: hovering or focusing a page highlights it and its
 * neighbors and dims the rest, clicks open pages, and the camera animates (unless reduced motion
 * is on). The renderer is killed on unmount so no WebGL context leaks.
 */
export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  {
    graph,
    theme,
    focused,
    onNodeClick,
    onError,
    labelThreshold = 7,
    padding = 40,
    large = false,
    className,
    style,
    label,
    describedBy,
  },
  ref,
) {
  const container = useRef<HTMLDivElement>(null);
  const sigma = useRef<Sigma<NodeAttributes, EdgeAttributes> | null>(null);
  const hovered = useRef<string | null>(null);
  const focusedRef = useRef<string | null>(focused);
  const themeRef = useRef(theme);
  const clickRef = useRef(onNodeClick);
  const errorRef = useRef(onError);
  const highlight = useRef<() => void>(() => undefined);
  const dimmed = useRef(new Map<string, string>());
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const motion = useRef(reduceMotion);
  const initialGraph = useRef(graph);
  const initialThreshold = useRef(labelThreshold);
  const initialPadding = useRef(padding);
  const initialLarge = useRef(large);
  const largeRef = useRef(large);
  const labels = useRef<QueuedLabel[]>([]);
  useEffect(() => {
    clickRef.current = onNodeClick;
    errorRef.current = onError;
    largeRef.current = large;
    motion.current = reduceMotion;
  });

  // The renderer is created once; later graphs are swapped in with `setGraph`.
  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const dim = (color: string) => {
      let value = dimmed.current.get(color);
      if (!value) {
        const current = themeRef.current;
        value = mix(color, current.background, current.dark ? 0.78 : 0.84);
        dimmed.current.set(color, value);
      }
      return value;
    };
    let active: string | null = null;
    let near = new Set<string>();
    if (!webglAvailable()) {
      errorRef.current?.(new Error('WebGL is not available in this browser'));
      return undefined;
    }
    let renderer: Sigma<NodeAttributes, EdgeAttributes>;
    try {
      renderer = new Sigma<NodeAttributes, EdgeAttributes>(initialGraph.current, element, {
        ...settingsFor(
          themeRef.current,
          initialThreshold.current,
          initialPadding.current,
          initialLarge.current,
          labels.current,
        ),
        nodeReducer: (node, data) => {
          if (!active) return data;
          if (node === active) return { ...data, zIndex: 2, forceLabel: true, highlighted: true };
          if (near.has(node)) return { ...data, zIndex: 1, forceLabel: near.size <= 24 };
          return { ...data, color: dim(data.color), label: null, zIndex: 0 };
        },
        edgeReducer: (edge, data) => {
          if (!active) return data;
          const [source, target] = renderer.getGraph().extremities(edge);
          if (source === active || target === active) {
            return {
              ...data,
              color: themeRef.current.edgeHighlight,
              size: data.size + 0.6,
              zIndex: 1,
            };
          }
          return { ...data, color: dim(data.color), zIndex: 0 };
        },
      });
    } catch (error) {
      // No WebGL (old hardware, disabled GPU): the view shows a message instead of crashing.
      console.warn('[graph] the renderer could not start', error);
      errorRef.current?.(error);
      return undefined;
    }
    highlight.current = () => {
      const current = renderer.getGraph();
      const next = dragging ? focusedRef.current : (hovered.current ?? focusedRef.current);
      const nextActive = next && current.hasNode(next) ? next : null;
      if (nextActive === active && nextActive === null) return;
      active = nextActive;
      near = active ? new Set(current.neighbors(active)) : new Set();
      renderer.refresh({ skipIndexation: true });
    };
    // Highlighting redraws every node and edge. On large graphs it waits until the pointer rests
    // on a node, so sweeping across the graph never stalls; it never runs while dragging.
    let dragging = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!largeRef.current) {
        highlight.current();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        highlight.current();
      }, 140);
    };
    renderer.on('enterNode', ({ node }) => {
      hovered.current = node;
      element.style.cursor = 'pointer';
      if (!dragging) schedule();
    });
    renderer.on('leaveNode', () => {
      hovered.current = null;
      element.style.cursor = '';
      if (!dragging) schedule();
    });
    renderer.on('downStage', () => {
      dragging = true;
    });
    renderer.on('upStage', () => {
      dragging = false;
      schedule();
    });
    renderer.on('clickNode', ({ node }) => clickRef.current(node));
    // Without a GPU, a large graph pans by moving the drawn layers and is redrawn once on release
    // (see ImagePan). The mouse layer stays in place: sigma reads pointer positions relative to it.
    const nodeLayer = renderer.getCanvases().nodes;
    const context = nodeLayer?.getContext('webgl2') ?? nodeLayer?.getContext('webgl') ?? null;
    const software = context !== null && isSoftwareRenderer(webglRendererName(context));
    const pan = new ImagePan(() =>
      Object.entries(renderer.getCanvases())
        .filter(([id]) => id !== 'mouse')
        .map(([, layer]) => layer),
    );
    let panned = false;
    const captor = renderer.getMouseCaptor();
    captor.on('mousedown', (event) => {
      const pressed = event.original;
      if (software && largeRef.current && pressed instanceof MouseEvent && pressed.button === 0) {
        pan.begin(event);
      }
    });
    captor.on('mousemovebody', (event) => {
      if (!pan.active) return;
      // Sigma would move the camera and redraw. Counting the move as a drag, like sigma does,
      // keeps the release from being taken for a click on the node under the pointer.
      event.preventSigmaDefault();
      captor.draggedEvents += 1;
      pan.move(event);
    });
    captor.on('mouseup', () => {
      const moved = pan.end();
      if (!moved) return;
      // The same camera move as sigma's drag, in one step.
      const from = renderer.viewportToFramedGraph(moved.from);
      const to = renderer.viewportToFramedGraph(moved.to);
      const camera = renderer.getCamera();
      const state = camera.getState();
      panned = true;
      camera.setState({ x: state.x + from.x - to.x, y: state.y + from.y - to.y });
    });
    renderer.on('afterRender', () => {
      drawLabels(labels.current, themeRef.current);
      if (panned) {
        panned = false;
        pan.clear();
      }
    });
    sigma.current = renderer;
    // The graphics driver can drop the context later (a GPU reset, too many contexts): the view
    // then shows its fallback, which can start a new renderer.
    const lost = (event: Event) => {
      event.preventDefault();
      errorRef.current?.(new Error('The WebGL context was lost'));
    };
    const canvases = Object.values(renderer.getCanvases());
    for (const canvas of canvases) canvas.addEventListener('webglcontextlost', lost);
    // Sigma only listens to window resizes; panels and the sidebar resize the container too.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            renderer.resize();
            renderer.refresh();
          });
    observer?.observe(element);
    return () => {
      if (timer) clearTimeout(timer);
      observer?.disconnect();
      for (const canvas of canvases) canvas.removeEventListener('webglcontextlost', lost);
      renderer.kill();
      sigma.current = null;
      highlight.current = () => undefined;
    };
  }, []);

  useEffect(() => {
    const renderer = sigma.current;
    if (renderer && renderer.getGraph() !== graph) {
      renderer.setGraph(graph);
      highlight.current();
    }
  }, [graph]);

  useEffect(() => {
    themeRef.current = theme;
    dimmed.current.clear();
    const renderer = sigma.current;
    if (!renderer) return;
    renderer.setSettings(settingsFor(theme, labelThreshold, padding, large, labels.current));
    renderer.refresh();
  }, [theme, labelThreshold, padding, large]);

  useEffect(() => {
    focusedRef.current = focused;
    highlight.current();
  }, [focused]);

  // Camera moves ease out like the rest of the UI: 200 ms for zooms (the app's longest duration);
  // travelling to a node or back to the whole graph takes 300 ms so the eye can follow the move.
  const zoom = () => ({ duration: motion.current ? 0 : 200, easing: 'cubicOut' as const });
  const travel = () => ({ duration: motion.current ? 0 : 300, easing: 'cubicOut' as const });
  useImperativeHandle(
    ref,
    () => ({
      focusNode(id, ratio = 0.35) {
        const renderer = sigma.current;
        const data = renderer?.getNodeDisplayData(id);
        if (!renderer || !data) return;
        void renderer.getCamera().animate({ x: data.x, y: data.y, ratio }, travel());
      },
      zoomIn() {
        void sigma.current?.getCamera().animatedZoom(zoom());
      },
      zoomOut() {
        void sigma.current?.getCamera().animatedUnzoom(zoom());
      },
      reset() {
        void sigma.current?.getCamera().animatedReset(travel());
      },
      nodeClientPosition(id) {
        const renderer = sigma.current;
        const element = container.current;
        if (!renderer || !element || !graph.hasNode(id)) return null;
        const attributes = graph.getNodeAttributes(id);
        // Positions arrive once per frame; a refresh brings the camera's framing up to date first.
        renderer.refresh();
        const point = renderer.graphToViewport({ x: attributes.x, y: attributes.y });
        const box = element.getBoundingClientRect();
        return { x: box.left + point.x, y: box.top + point.y };
      },
    }),
    [graph],
  );

  return (
    <div
      ref={container}
      role="img"
      aria-label={label}
      aria-describedby={describedBy}
      className={className}
      // Layers moved during a pan stay inside the graph's box.
      style={{ overflow: 'hidden', ...style }}
    />
  );
});
