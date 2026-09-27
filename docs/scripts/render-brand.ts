/**
 * Renders every brand asset from source, so they are reproducible:
 *
 *   pnpm --dir docs brand
 *
 * 1. Reads the colors from packages/ui/src/styles/tokens.css.
 * 2. Writes the SVGs (the mark in its adaptive, light and dark versions, the app icon, the favicon
 *    and the wordmarks) to assets/brand/. The wordmark's text is outlined from Inter with fontkit,
 *    so it looks identical everywhere without the font.
 * 3. Renders PNGs of every SVG with Playwright (Chromium), a favicon.ico, a legibility sheet that
 *    shows the mark at 16, 32 and 64 px on light and dark backgrounds, and the 1280×640 social
 *    preview from assets/brand/social-preview.html.
 * 4. Creates the placeholder assets/demo.gif (with ffmpeg) if no demo exists yet.
 * 5. Copies the favicon set and the logo into docs/public/ and apps/web/public/, writes the app
 *    icon to apps/desktop/src-tauri/icons/source.svg and regenerates the desktop icons from it with
 *    `tauri icon` (`pnpm --filter @tessera/desktop icons`).
 */
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fontkit from 'fontkit';
import { chromium, type Page } from 'playwright';
import {
  WORDMARK,
  appIconSvg,
  brandColorsFromTokens,
  markSvg,
  wordmarkSvg,
  type BrandColors,
  type WordmarkText,
} from './brand.ts';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(docsDir, '..');
const brandDir = path.join(repoDir, 'assets', 'brand');
const pngDir = path.join(brandDir, 'png');
const publicDir = path.join(docsDir, 'public');
const webPublicDir = path.join(repoDir, 'apps', 'web', 'public');
const desktopIconSource = path.join(repoDir, 'apps', 'desktop', 'src-tauri', 'icons', 'source.svg');
const tokensPath = path.join(repoDir, 'packages', 'ui', 'src', 'styles', 'tokens.css');

/** Inter at one static weight: fontkit can't instantiate variations of a WOFF2 font. */
function openInter(weight: number) {
  const opened = fontkit.openSync(
    path.join(
      docsDir,
      'node_modules',
      '@fontsource',
      'inter',
      'files',
      `inter-latin-${weight}-normal.woff2`,
    ),
  );
  if (!('layout' in opened)) throw new Error('Expected a single font, got a collection');
  return opened;
}

/**
 * Outlines one word in mark units from `x` (cap height = WORDMARK.capHeight, baseline below).
 * `width` ends at the last glyph's ink; `space` is the width of a word space at this weight.
 */
function outlineWord(text: string, weight: number, x: number) {
  const font = openInter(weight);
  const scale = WORDMARK.capHeight / font.capHeight;
  const baseline = 16 + WORDMARK.capHeight / 2;
  const tracking = WORDMARK.tracking * font.unitsPerEm;
  const run = font.layout(text);
  let pen = 0;
  const parts: string[] = [];
  run.glyphs.forEach((glyph, index) => {
    const position = run.positions[index];
    if (!position) return;
    const left = x + (pen + position.xOffset) * scale;
    parts.push(glyph.path.scale(scale, -scale).translate(left, baseline).toSVG());
    pen += position.xAdvance + (index < run.glyphs.length - 1 ? tracking : 0);
  });
  // Trim the last glyph's right side bearing so the SVG hugs the ink.
  const last = run.glyphs.at(-1);
  const bearing = last ? last.advanceWidth - last.bbox.maxX : 0;
  const space = font.layout(' ').positions[0]?.xAdvance ?? 0;
  return { path: parts.join(''), width: (pen - bearing) * scale, space: space * scale };
}

/** "Tessera" and "Notes", one word space apart, right after the mark. */
function outlineWordmark(): WordmarkText {
  const start = 32 + WORDMARK.gap;
  const name = outlineWord(WORDMARK.name, WORDMARK.weight, start);
  const suffixStart = start + name.width + name.space;
  const suffix = outlineWord(WORDMARK.suffix, WORDMARK.suffixWeight, suffixStart);
  return {
    namePath: name.path,
    suffixPath: suffix.path,
    width: suffixStart + suffix.width - start,
  };
}

async function renderSvg(page: Page, svg: string, width: number, height: number, file: string) {
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">${svg
      .replace(/ width="[^"]+"/, ` width="${width}"`)
      .replace(/ height="[^"]+"/, ` height="${height}"`)}</body></html>`,
  );
  await page.locator('svg').screenshot({ path: file, omitBackground: true });
}

/** A favicon.ico holding PNG images (supported by every current browser and Windows). */
function encodeIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

/**
 * The mark at 16, 32 and 64 px on both theme backgrounds, at 1:1 pixels, for review: the version
 * for that background, the universal one (favicon.ico, PNGs) and the app icon.
 */
function legibilitySheet(colors: BrandColors, icon: string): string {
  const cell = (svg: string, size: number) =>
    `<div class="cell">${svg.replace(/ width="[^"]+"/, ` width="${size}"`).replace(/ height="[^"]+"/, ` height="${size}"`)}<small>${size}px</small></div>`;
  const cells = (svg: string) => [16, 32, 64].map((s) => cell(svg, s)).join('');
  const row = (bg: string, fg: string, label: string, theme: 'light' | 'dark') =>
    `<section style="background:${bg};color:${fg}"><h2>${label}</h2>${cells(markSvg(colors, 64, theme))}${cells(markSvg(colors, 64, 'universal'))}${cells(icon)}</section>`;
  return `<!doctype html><html><head><style>
    body{margin:0;font:12px system-ui,sans-serif}
    section{display:flex;align-items:flex-end;gap:28px;padding:20px 24px}
    h2{width:64px;margin:0;font-size:12px;font-weight:600}
    .cell{display:flex;flex-direction:column;align-items:center;gap:6px}
    small{opacity:.6}
  </style></head><body>
    ${row(colors.bgLight, colors.fgLight, 'Light', 'light')}
    ${row(colors.bgDark, colors.fgDark, 'Dark', 'dark')}
    ${row('#0d1117', '#e6edf3', 'GitHub dark', 'dark')}
  </body></html>`;
}

/** The frame shown at `assets/demo.gif` until the polish phase records the real demo. */
function demoPlaceholderHtml(colors: BrandColors, icon: string): string {
  return `<!doctype html><html><head><style>
    body{margin:0;width:1280px;height:720px;display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:20px;background:${colors.bgDark};color:${colors.fgDark};
      font:500 22px system-ui,sans-serif;text-align:center}
    svg{width:96px;height:96px}
    h1{margin:8px 0 0;font-size:44px;font-weight:700;letter-spacing:-.02em}
    p{margin:0;opacity:.65;max-width:720px;line-height:1.5}
    code{font:600 18px ui-monospace,monospace;padding:4px 10px;border-radius:6px;background:#ffffff14}
  </style></head><body>
    ${icon}
    <h1>Demo recording coming soon</h1>
    <p>Placeholder. A 20-second demo of Tessera replaces this image before the first release.</p>
    <code>assets/demo.gif</code>
  </body></html>`;
}

/**
 * Converts the placeholder frame to `assets/demo.gif` with ffmpeg. Never overwrites an existing
 * GIF, because the polish phase puts the real recording there.
 */
async function writeDemoPlaceholder() {
  const target = path.join(repoDir, 'assets', 'demo.gif');
  try {
    await access(target);
    console.info('assets/demo.gif exists; left untouched');
    return;
  } catch {
    // Missing: create the placeholder below.
  }
  const result = spawnSync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-i',
      path.join(pngDir, 'demo-placeholder.png'),
      '-vf',
      'scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse',
      target,
    ],
    { stdio: 'inherit' },
  );
  if (result.error || result.status !== 0) {
    console.warn('ffmpeg is not available; assets/demo.gif was not created');
  }
}

async function main() {
  const colors = brandColorsFromTokens(await readFile(tokensPath, 'utf8'));
  await mkdir(pngDir, { recursive: true });
  await mkdir(publicDir, { recursive: true });

  const wordmark = outlineWordmark();
  const svgs = {
    'logo-mark.svg': markSvg(colors, 64),
    'logo-mark-light.svg': markSvg(colors, 64, 'light'),
    'logo-mark-dark.svg': markSvg(colors, 64, 'dark'),
    'favicon.svg': markSvg(colors, 32),
    'app-icon.svg': appIconSvg(colors, 512),
    'wordmark-light.svg': wordmarkSvg(colors, 'light', wordmark),
    'wordmark-dark.svg': wordmarkSvg(colors, 'dark', wordmark),
  } as const;
  for (const [name, svg] of Object.entries(svgs)) {
    await writeFile(path.join(brandDir, name), `${svg}\n`);
  }
  // favicon.ico and the PNGs can't follow the color scheme, so they get the universal version.
  const universalMark = markSvg(colors, 64, 'universal');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });

    for (const size of [16, 32, 48, 64, 128, 256, 512]) {
      await renderSvg(page, universalMark, size, size, path.join(pngDir, `logo-mark-${size}.png`));
    }
    for (const size of [180, 192, 512, 1024]) {
      await renderSvg(
        page,
        svgs['app-icon.svg'],
        size,
        size,
        path.join(pngDir, `app-icon-${size}.png`),
      );
    }
    const wordmarkHeight = 128;
    const wordmarkWidth = Math.round(
      (Number(/viewBox="0 0 ([\d.]+) 32"/.exec(svgs['wordmark-light.svg'])?.[1]) / 32) *
        wordmarkHeight,
    );
    for (const theme of ['light', 'dark'] as const) {
      await renderSvg(
        page,
        svgs[`wordmark-${theme}.svg`],
        wordmarkWidth,
        wordmarkHeight,
        path.join(pngDir, `wordmark-${theme}.png`),
      );
    }

    const icoSizes = [16, 32, 48];
    const icoImages = await Promise.all(
      icoSizes.map(async (size) => ({
        size,
        png: await readFile(path.join(pngDir, `logo-mark-${size}.png`)),
      })),
    );
    await writeFile(path.join(brandDir, 'favicon.ico'), encodeIco(icoImages));

    await page.setViewportSize({ width: 820, height: 400 });
    await page.setContent(legibilitySheet(colors, svgs['app-icon.svg']));
    await page.screenshot({ path: path.join(pngDir, 'legibility.png'), fullPage: true });

    const social = await browser.newPage({
      viewport: { width: 1280, height: 640 },
      deviceScaleFactor: 1,
    });
    await social.goto(pathToFileURL(path.join(brandDir, 'social-preview.html')).href);
    const interLoaded = await social.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].some(
        (face) => face.family.includes('Inter') && face.status === 'loaded',
      );
    });
    if (!interLoaded) throw new Error('Inter did not load; run `pnpm --dir docs install` first');
    await social.screenshot({ path: path.join(brandDir, 'social-preview.png') });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.setContent(demoPlaceholderHtml(colors, svgs['app-icon.svg']));
    await page.screenshot({ path: path.join(pngDir, 'demo-placeholder.png') });
  } finally {
    await browser.close();
  }

  await writeDemoPlaceholder();

  for (const dir of [publicDir, webPublicDir]) {
    await copyFile(path.join(brandDir, 'favicon.svg'), path.join(dir, 'favicon.svg'));
    await copyFile(path.join(brandDir, 'favicon.ico'), path.join(dir, 'favicon.ico'));
    await copyFile(path.join(pngDir, 'app-icon-180.png'), path.join(dir, 'apple-touch-icon.png'));
  }
  for (const name of ['logo-mark.svg', 'logo-mark-light.svg', 'logo-mark-dark.svg']) {
    await copyFile(path.join(brandDir, name), path.join(publicDir, name));
  }
  await copyFile(
    path.join(brandDir, 'social-preview.png'),
    path.join(publicDir, 'social-preview.png'),
  );

  // The desktop icons: `tauri icon` renders every size from a 1024 px source.
  await writeFile(desktopIconSource, `${appIconSvg(colors, 1024)}\n`);
  // One command string: pnpm is a .cmd shim on Windows, which only a shell runs.
  const icons = spawnSync('pnpm --filter @tessera/desktop icons', {
    cwd: repoDir,
    stdio: 'inherit',
    shell: true,
  });
  if (icons.error || icons.status !== 0) {
    throw new Error(
      '`pnpm --filter @tessera/desktop icons` failed, so the desktop icons are stale',
    );
  }

  console.info(
    `Brand assets written to ${path.relative(repoDir, brandDir)}, docs/public, apps/web/public and the desktop icons`,
  );
}

await main();
