/**
 * Renderers that draw WebGL on the CPU: SwiftShader (Chromium without a usable GPU), Mesa's
 * llvmpipe and softpipe (Linux), and the Microsoft Basic Render Driver (Windows without a driver).
 */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|basic render driver/i;

/** Whether a WebGL renderer name (see {@link webglRendererName}) is a software renderer. */
export function isSoftwareRenderer(name: string | null): boolean {
  return name !== null && SOFTWARE_RENDERER.test(name);
}

/** The renderer behind a WebGL context: the unmasked name where the browser shares it. */
export function webglRendererName(
  context: WebGLRenderingContext | WebGL2RenderingContext,
): string | null {
  const info = context.getExtension('WEBGL_debug_renderer_info');
  const name: unknown = context.getParameter(
    info ? info.UNMASKED_RENDERER_WEBGL : context.RENDERER,
  );
  return typeof name === 'string' ? name : null;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Pans by moving the drawn layers instead of redrawing them. Without a GPU, redrawing a large
 * graph takes about a fifth of a second, so a pan redrawn on every pointer move crawls (#96).
 * While the pointer drags, the layers follow it with a CSS transform; on release the camera moves
 * once, and {@link clear} puts the layers back when the graph has been redrawn there.
 */
export class ImagePan {
  private start: Point | null = null;
  private last: Point | null = null;

  constructor(private readonly layers: () => readonly HTMLElement[]) {}

  get active(): boolean {
    return this.start !== null;
  }

  begin(at: Point): void {
    this.start = { x: at.x, y: at.y };
    this.last = this.start;
  }

  move(to: Point): void {
    const start = this.start;
    if (!start) return;
    this.last = { x: to.x, y: to.y };
    const transform = `translate(${to.x - start.x}px, ${to.y - start.y}px)`;
    for (const layer of this.layers()) layer.style.transform = transform;
  }

  /** Ends the pan: where the pointer started and ended, or null if it didn't move. */
  end(): { from: Point; to: Point } | null {
    const from = this.start;
    const to = this.last;
    this.start = null;
    this.last = null;
    if (from && to && (from.x !== to.x || from.y !== to.y)) return { from, to };
    // Nothing moved, so nothing will be redrawn: the layers go back now.
    if (from) this.clear();
    return null;
  }

  /** Puts the layers back in place (once the graph is drawn at the camera's new position). */
  clear(): void {
    for (const layer of this.layers()) layer.style.transform = '';
  }
}
