/**
 * The Tessera Notes brand, as data: the logo geometry and the colors it takes from the design
 * tokens. `render-brand.ts` writes every SVG from these functions, so the mark, the app icon, the
 * wordmarks and the favicons can never drift apart.
 *
 * The mark is a leaf laid in mosaic: a 2×2 of 16-unit cells on 32 units, 2.2-unit grout, corners
 * rounded by 1.5. The top-left and bottom-right tiles are quarter discs whose right angles meet at
 * the centre; the other two are squares. The two curved tiles always take the stronger tone
 * (deep indigo on light backgrounds, lavender on dark ones) and the squares a quieter one, so at
 * 16 px the curves carry the shape and the mark doesn't read as four equal squares.
 */

export interface BrandColors {
  /** `--tess-accent`: the one accent color, identical in both themes. */
  accent: string;
  /** `--tess-accent-text` in the light theme: the curved tiles on light backgrounds. */
  accentTextLight: string;
  /** `--tess-accent-text` in the dark theme: the curved tiles on dark backgrounds. */
  accentTextDark: string;
  /** `--tess-fg` in both themes: the wordmark's "Tessera". */
  fgLight: string;
  fgDark: string;
  /** `--tess-fg-muted` in both themes: the wordmark's "Notes". */
  fgMutedLight: string;
  fgMutedDark: string;
  /** `--tess-bg` in both themes. */
  bgLight: string;
  bgDark: string;
}

type TokenBlock = Record<string, string>;

/** Reads `--tess-*` variables from one `{ … }` block of tokens.css. */
function readBlock(css: string, selector: string): TokenBlock {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`tokens.css has no "${selector}" block`);
  const end = css.indexOf('\n}', start);
  const block = css.slice(start, end);
  const tokens: TokenBlock = {};
  for (const match of block.matchAll(/--tess-([a-z0-9-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) tokens[name] = value.trim();
  }
  return tokens;
}

function requireToken(block: TokenBlock, name: string): string {
  const value = block[name];
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`Token --tess-${name} is missing or not a hex color: ${String(value)}`);
  }
  return value.toLowerCase();
}

/** Takes the brand colors from `packages/ui/src/styles/tokens.css`. */
export function brandColorsFromTokens(css: string): BrandColors {
  const light = readBlock(css, ':root');
  const dark = readBlock(css, ":root[data-theme='dark']");
  return {
    accent: requireToken(light, 'accent'),
    accentTextLight: requireToken(light, 'accent-text'),
    accentTextDark: requireToken(dark, 'accent-text'),
    fgLight: requireToken(light, 'fg'),
    fgDark: requireToken(dark, 'fg'),
    fgMutedLight: requireToken(light, 'fg-muted'),
    fgMutedDark: requireToken(dark, 'fg-muted'),
    bgLight: requireToken(light, 'bg'),
    bgDark: requireToken(dark, 'bg'),
  };
}

/** Mixes two hex colors channel by channel: `weight` of `a`, the rest of `b`. */
export function mixColors(a: string, b: string, weight: number): string {
  const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [ca, cb] = [channels(a), channels(b)];
  return `#${ca
    .map((value, i) => Math.round(value * weight + (cb[i] ?? 0) * (1 - weight)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** The mark's two tones. `tileOpacity` below 1 lets the background show through the squares. */
export interface MarkTones {
  leaf: string;
  tile: string;
  tileOpacity: number;
}

/**
 * - `light` and `dark`: for a known background (the wordmarks, the docs, the app, the app icon's
 *   white plate).
 * - `universal`: for a background nobody knows (favicon.ico, the PNGs): an accent leaf and
 *   half-transparent accent squares, which come out light on light backgrounds and dark on dark
 *   ones, so the leaf is the stronger tone on both.
 */
export type MarkVariant = 'light' | 'dark' | 'universal';

export function markTones(colors: BrandColors, variant: MarkVariant): MarkTones {
  if (variant === 'light') {
    return {
      leaf: colors.accentTextLight,
      tile: mixColors(colors.accent, colors.bgLight, 0.5),
      tileOpacity: 1,
    };
  }
  if (variant === 'dark')
    return { leaf: colors.accentTextDark, tile: colors.accent, tileOpacity: 1 };
  return { leaf: colors.accent, tile: colors.accent, tileOpacity: 0.5 };
}

export interface Tile {
  col: 0 | 1;
  row: 0 | 1;
  shape: 'quarter' | 'square';
  tone: 'leaf' | 'tile';
}

/** The four tiles: curved on one diagonal (the leaf), square on the other. */
export const TILES: readonly Tile[] = [
  { col: 0, row: 0, shape: 'quarter', tone: 'leaf' },
  { col: 1, row: 0, shape: 'square', tone: 'tile' },
  { col: 0, row: 1, shape: 'square', tone: 'tile' },
  { col: 1, row: 1, shape: 'quarter', tone: 'leaf' },
];

/** In mark units (the mark is 32 × 32). */
export const GEOMETRY = { cell: 16, grout: 2.2, radius: 1.5 } as const;

function round(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

type Point = [number, number];
const at = (p: Point) => `${round(p[0])} ${round(p[1])}`;
const add = (...points: Point[]): Point => [
  points.reduce((sum, p) => sum + p[0], 0),
  points.reduce((sum, p) => sum + p[1], 0),
];
const scale = (p: Point, factor: number): Point => [p[0] * factor, p[1] * factor];

/** A square tile with rounded corners. */
function squarePath(col: number, row: number): string {
  const { cell, grout, radius: r } = GEOMETRY;
  const x0 = col * cell + grout / 2;
  const y0 = row * cell + grout / 2;
  const x1 = x0 + cell - grout;
  const y1 = y0 + cell - grout;
  const arc = (to: Point) => `A${round(r)} ${round(r)} 0 0 1 ${at(to)}`;
  return [
    `M${at([x0 + r, y0])}H${round(x1 - r)}`,
    arc([x1, y0 + r]),
    `V${round(y1 - r)}`,
    arc([x1 - r, y1]),
    `H${round(x0 + r)}`,
    arc([x0, y1 - r]),
    `V${round(y0 + r)}`,
    arc([x0 + r, y0]),
    'Z',
  ].join('');
}

/**
 * A quarter-disc tile: its right angle at the centre of the mark, its straight edges along `ex`
 * and `ey`, its arc centred on the mark's centre. Every corner, including the two where an edge
 * meets the arc, is rounded by the same radius as the squares.
 */
function quarterPath(ex: Point, ey: Point): string {
  const { cell, grout, radius: r } = GEOMETRY;
  const c: Point = [cell, cell];
  const h = grout / 2;
  const outer = cell - h;
  const sweep = ex[0] * ey[1] - ex[1] * ey[0] > 0 ? 1 : 0;
  const corner = add(c, scale(ex, h), scale(ey, h));
  // Where a fillet of radius r touches the straight edge, and the arc (its centre is r inside both).
  const along = Math.sqrt((outer - r) ** 2 - (h + r) ** 2);
  const edgeX = add(c, scale(ey, h), scale(ex, along));
  const arcX = add(c, scale(add(scale(ey, h + r), scale(ex, along)), outer / (outer - r)));
  const edgeY = add(c, scale(ex, h), scale(ey, along));
  const arcY = add(c, scale(add(scale(ex, h + r), scale(ey, along)), outer / (outer - r)));
  const fillet = (to: Point) => `A${round(r)} ${round(r)} 0 0 ${sweep} ${at(to)}`;
  return [
    `M${at(add(corner, scale(ex, r)))}`,
    `L${at(edgeX)}`,
    fillet(arcX),
    `A${round(outer)} ${round(outer)} 0 0 ${sweep} ${at(arcY)}`,
    fillet(edgeY),
    `L${at(add(corner, scale(ey, r)))}`,
    fillet(add(corner, scale(ex, r))),
    'Z',
  ].join('');
}

/** Path data of one tile in mark units. */
export function tilePath(tile: Tile): string {
  if (tile.shape === 'square') return squarePath(tile.col, tile.row);
  return quarterPath([tile.col === 0 ? -1 : 1, 0], [0, tile.row === 0 ? -1 : 1]);
}

/** The tiles as `<path>` elements in fixed tones. */
function tilePaths(tones: MarkTones): string {
  return TILES.map((tile) => {
    const fill = tile.tone === 'leaf' ? tones.leaf : tones.tile;
    const opacity =
      tile.tone === 'tile' && tones.tileOpacity < 1 ? ` fill-opacity="${tones.tileOpacity}"` : '';
    return `<path d="${tilePath(tile)}" fill="${fill}"${opacity}/>`;
  }).join('');
}

const NAME = 'Tessera Notes';

function svgOpen(width: number, height: number, viewWidth = 32): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(viewWidth)} 32" width="${round(width)}" height="${round(height)}" role="img" aria-label="${NAME}">`;
}

/**
 * The mark on a transparent background. `adaptive` (the default) follows the viewer's color
 * scheme (favicons, and wherever a page's theme is the system's); the others are fixed.
 */
export function markSvg(
  colors: BrandColors,
  size = 32,
  variant: MarkVariant | 'adaptive' = 'adaptive',
): string {
  if (variant !== 'adaptive') {
    return [svgOpen(size, size), tilePaths(markTones(colors, variant)), '</svg>'].join('');
  }
  const light = markTones(colors, 'light');
  const dark = markTones(colors, 'dark');
  return [
    svgOpen(size, size),
    `<style>.leaf{fill:${light.leaf}}.tile{fill:${light.tile}}`,
    `@media (prefers-color-scheme:dark){.leaf{fill:${dark.leaf}}.tile{fill:${dark.tile}}}</style>`,
    ...TILES.map((tile) => `<path class="${tile.tone}" d="${tilePath(tile)}"/>`),
    '</svg>',
  ].join('');
}

/**
 * The app icon (desktop, PWA and touch icons): the mark in its light tones on a white rounded
 * square with a hairline edge, so it holds its own on light and dark desktops alike.
 */
export function appIconSvg(colors: BrandColors, size = 512): string {
  const inset = 6.4;
  return [
    svgOpen(size, size),
    `<rect width="32" height="32" rx="7.2" fill="${colors.bgLight}"/>`,
    '<rect x="0.25" y="0.25" width="31.5" height="31.5" rx="6.95" fill="none" stroke="#000000" stroke-opacity="0.08" stroke-width="0.5"/>',
    `<g transform="translate(${inset} ${inset}) scale(${round((32 - inset * 2) / 32)})">`,
    tilePaths(markTones(colors, 'light')),
    '</g></svg>',
  ].join('');
}

/**
 * Wordmark layout in mark units: "Tessera" in Inter 600 and "Notes" in Inter 400, cap height 22 of
 * the mark's 32 units.
 */
export const WORDMARK = {
  name: 'Tessera',
  suffix: 'Notes',
  weight: 600,
  suffixWeight: 400,
  capHeight: 22,
  gap: 11,
  tracking: -0.012,
} as const;

/** The outlined words, already placed in mark units (see `render-brand.ts`). */
export interface WordmarkText {
  namePath: string;
  suffixPath: string;
  /** From the start of "Tessera" to the end of "Notes". */
  width: number;
}

/** The mark followed by the outlined name, for a light or a dark background. */
export function wordmarkSvg(
  colors: BrandColors,
  theme: 'light' | 'dark',
  text: WordmarkText,
  height = 64,
): string {
  const width = 32 + WORDMARK.gap + text.width + 1;
  const fg = theme === 'light' ? colors.fgLight : colors.fgDark;
  const muted = theme === 'light' ? colors.fgMutedLight : colors.fgMutedDark;
  return [
    svgOpen((width / 32) * height, height, width),
    tilePaths(markTones(colors, theme)),
    `<path d="${text.namePath}" fill="${fg}"/>`,
    `<path d="${text.suffixPath}" fill="${muted}"/>`,
    '</svg>',
  ].join('');
}
