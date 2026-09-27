import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { icoSizes, pngSize, readRepoFile, repoPath } from './repo-files';

/**
 * The brand assets in `assets/brand` (rendered by `pnpm --dir docs brand`): valid SVGs that
 * render at small sizes, and PNGs at their exact sizes.
 */

const SVGS = readdirSync(repoPath('assets/brand')).filter((name) => name.endsWith('.svg'));

test('every brand SVG is well-formed SVG with a viewBox and an accessible name', async ({
  page,
}) => {
  expect(SVGS.sort()).toEqual([
    'app-icon.svg',
    'favicon.svg',
    'logo-mark-dark.svg',
    'logo-mark-light.svg',
    'logo-mark.svg',
    'wordmark-dark.svg',
    'wordmark-light.svg',
  ]);
  for (const name of SVGS) {
    const source = readRepoFile(`assets/brand/${name}`);
    const result = await page.evaluate((svg) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const root = doc.documentElement;
      return {
        error: doc.getElementsByTagName('parsererror').length > 0,
        tag: root.tagName,
        namespace: root.namespaceURI,
        viewBox: root.getAttribute('viewBox'),
        label: root.getAttribute('aria-label'),
      };
    }, source);
    expect(result, name).toEqual({
      error: false,
      tag: 'svg',
      namespace: 'http://www.w3.org/2000/svg',
      viewBox: expect.stringMatching(/^0 0 [\d.]+ 32$/),
      label: 'Tessera Notes',
    });
  }
});

test('the logo and app icon render at 16, 32 and 64 px with visible tiles', async ({ page }) => {
  for (const name of ['logo-mark.svg', 'app-icon.svg']) {
    const dataUrl = `data:image/svg+xml;base64,${readFileSync(repoPath(`assets/brand/${name}`)).toString('base64')}`;
    for (const size of [16, 32, 64]) {
      const coverage = await page.evaluate(
        async ({ src, size }) => {
          const image = new Image(size, size);
          image.src = src;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('no 2d context');
          context.drawImage(image, 0, 0, size, size);
          const { data } = context.getImageData(0, 0, size, size);
          let opaque = 0;
          for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 200) opaque += 1;
          return opaque / (size * size);
        },
        { src: dataUrl, size },
      );
      // The mark's four tiles cover most of its box; the icon is almost fully opaque.
      if (name === 'logo-mark.svg') expect(coverage, `${name} @${size}`).toBeGreaterThan(0.2);
      else expect(coverage, `${name} @${size}`).toBeGreaterThan(0.85);
    }
  }
});

test('the social preview is exactly 1280×640', () => {
  expect(pngSize('assets/brand/social-preview.png')).toEqual({ width: 1280, height: 640 });
  expect(pngSize('docs/public/social-preview.png')).toEqual({ width: 1280, height: 640 });
});

test('the favicon set has every size', () => {
  expect(icoSizes('assets/brand/favicon.ico')).toEqual([16, 32, 48]);
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    expect(pngSize(`assets/brand/png/logo-mark-${size}.png`)).toEqual({
      width: size,
      height: size,
    });
  }
  for (const size of [180, 192, 512, 1024]) {
    expect(pngSize(`assets/brand/png/app-icon-${size}.png`)).toEqual({ width: size, height: size });
  }
  expect(pngSize('docs/public/apple-touch-icon.png')).toEqual({ width: 180, height: 180 });
});

test('the docs site uses the same logo and favicon', () => {
  for (const name of [
    'logo-mark.svg',
    'logo-mark-light.svg',
    'logo-mark-dark.svg',
    'favicon.svg',
    'favicon.ico',
  ]) {
    expect(
      readFileSync(repoPath(`docs/public/${name}`)).equals(
        readFileSync(repoPath(`assets/brand/${name}`)),
      ),
      name,
    ).toBe(true);
  }
});

test('the web app and the desktop app use the same icons', () => {
  const same = (copy: string, original: string) =>
    expect(readFileSync(repoPath(copy)).equals(readFileSync(repoPath(original))), copy).toBe(true);
  same('apps/web/public/favicon.svg', 'assets/brand/favicon.svg');
  same('apps/web/public/favicon.ico', 'assets/brand/favicon.ico');
  same('apps/web/public/apple-touch-icon.png', 'assets/brand/png/app-icon-180.png');
  // `tauri icon` renders the desktop icons from the app icon at 1024 px.
  expect(
    readRepoFile('apps/desktop/src-tauri/icons/source.svg').replace(
      ' width="1024" height="1024"',
      ' width="512" height="512"',
    ),
  ).toBe(readRepoFile('assets/brand/app-icon.svg'));
  expect(pngSize('apps/desktop/src-tauri/icons/icon.png')).toEqual({ width: 512, height: 512 });
});

test('docs screenshots exist in both themes at 1440×900', () => {
  for (const name of ['docs-home', 'docs-guide', 'docs-self-hosting']) {
    for (const theme of ['light', 'dark']) {
      expect(pngSize(`assets/screenshots/docs/${name}-${theme}.png`)).toEqual({
        width: 1440,
        height: 900,
      });
    }
  }
});
