import { cp, readFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefaultTheme, Plugin } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshotsDir = path.resolve(docsDir, '..', 'assets', 'screenshots');
const repo = 'https://github.com/femboypuppy/Tessera-Notes';

/**
 * GitHub Pages serves the site from https://femboypuppy.github.io/Tessera-Notes/, so every URL lives
 * under `/Tessera-Notes/`. Set `DOCS_BASE=/` for a custom domain or a local preview at the root.
 */
const base = process.env.DOCS_BASE ?? '/Tessera-Notes/';

/** Reads a page's title from its frontmatter `title` or its first `# ` heading. */
function pageTitle(file: string): string {
  const source = readFileSync(file, 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
  const fromFrontmatter = frontmatter && /^title:\s*['"]?(.+?)['"]?\s*$/m.exec(frontmatter)?.[1];
  const fromHeading = /^#\s+(.+)$/m.exec(source)?.[1];
  return (fromFrontmatter || fromHeading || path.basename(file, '.md')).trim();
}

const PLUGIN_PAGE_ORDER = [
  'index',
  'getting-started',
  'api',
  'permissions',
  'security',
  'publishing',
];

function pluginRank(name: string): number {
  const rank = PLUGIN_PAGE_ORDER.indexOf(name);
  return rank < 0 ? PLUGIN_PAGE_ORDER.length : rank;
}

/**
 * The plugin docs live in `docs/plugins/` (written by the plugins team). The sidebar lists
 * whatever pages exist there, so it never points at a page that isn't written, and new pages
 * appear without a config change. Subfolders (such as a generated API reference) become groups.
 */
function pluginSidebar(dir = path.join(docsDir, 'plugins')): DefaultTheme.SidebarItem[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .sort((a, b) => {
      const [nameA, nameB] = [a.replace(/\.md$/, ''), b.replace(/\.md$/, '')];
      return pluginRank(nameA) - pluginRank(nameB) || nameA.localeCompare(nameB);
    });
  const items: DefaultTheme.SidebarItem[] = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    const link = `/${path.relative(docsDir, full).replaceAll(path.sep, '/')}`;
    if (statSync(full).isDirectory()) {
      const children = pluginSidebar(full);
      if (children.length > 0) {
        const index = path.join(full, 'index.md');
        items.push({
          text: existsSync(index) ? pageTitle(index) : name,
          collapsed: true,
          items: children,
        });
      }
    } else if (name.endsWith('.md')) {
      items.push({ text: pageTitle(full), link: link.replace(/(index)?\.md$/, '') });
    }
  }
  return items;
}

/** The first page in a sidebar tree, depth first. */
function firstLink(items: DefaultTheme.SidebarItem[]): string | undefined {
  for (const item of items) {
    const link = item.link ?? (item.items ? firstLink(item.items) : undefined);
    if (link) return link;
  }
  return undefined;
}

const pluginItems = pluginSidebar();
const firstPluginPage = firstLink(pluginItems);
const pluginsLink: DefaultTheme.NavItemWithLink = firstPluginPage
  ? { text: 'Plugins', link: firstPluginPage, activeMatch: '^/plugins/' }
  : { text: 'Plugins', link: `${repo}/tree/main/docs/plugins` };

const guideSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Getting started',
    items: [
      { text: 'What is Tessera?', link: '/guide/' },
      { text: 'Installation', link: '/guide/installation' },
      { text: 'First steps', link: '/guide/first-steps' },
    ],
  },
  {
    text: 'Using Tessera',
    items: [
      { text: 'The editor', link: '/guide/editor' },
      { text: 'Keyboard shortcuts', link: '/guide/keyboard-shortcuts' },
      { text: 'Databases', link: '/guide/databases' },
      { text: 'Links, backlinks and the graph', link: '/guide/links-and-graph' },
      { text: 'Search', link: '/guide/search' },
      { text: 'Import and export', link: '/guide/import-export' },
      { text: 'Sync and collaboration', link: '/guide/sync-and-collaboration' },
      { text: 'The desktop app', link: '/guide/desktop' },
    ],
  },
  {
    text: 'Help',
    items: [
      { text: 'FAQ', link: '/guide/faq' },
      { text: 'Troubleshooting', link: '/guide/troubleshooting' },
    ],
  },
];

const selfHostingSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Self-hosting',
    items: [
      { text: 'Overview', link: '/self-hosting/' },
      { text: 'Configuration reference', link: '/self-hosting/configuration' },
      { text: 'HTTPS and reverse proxies', link: '/self-hosting/https' },
      { text: 'Backups and restore', link: '/self-hosting/backups' },
      { text: 'Upgrading', link: '/self-hosting/upgrading' },
    ],
  },
];

const contributingSidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Contributing',
    items: [
      { text: 'Start here', link: '/contributing/' },
      { text: 'Architecture', link: '/contributing/architecture' },
      { text: 'Writing docs', link: '/contributing/docs' },
    ],
  },
];

/**
 * Screenshots live in `assets/screenshots/<area>/` at the repo root (every feature team writes
 * its own). Serve them at `/screenshots/` in dev and copy them into the build, so the docs use
 * the same images as the README without duplicating them.
 */
function screenshotsPlugin(): Plugin {
  return {
    name: 'tessera-screenshots',
    configureServer(server) {
      server.middlewares.use('/screenshots/', (request, response, next) => {
        const relative = decodeURIComponent((request.url ?? '').split('?')[0] ?? '');
        const file = path.resolve(screenshotsDir, `.${relative}`);
        if (!file.startsWith(screenshotsDir + path.sep) || !file.endsWith('.png')) return next();
        readFile(file).then(
          (data) => {
            response.setHeader('Content-Type', 'image/png');
            response.end(data);
          },
          () => next(),
        );
      });
    },
  };
}

export default withMermaid({
  base,
  lang: 'en-US',
  // "Tessera Notes" in page titles and link previews tells the project apart from others named
  // Tessera; the nav bar keeps the product's name (themeConfig.siteTitle).
  title: 'Tessera Notes',
  description:
    'Tessera is an open-source, local-first knowledge app: blocks and databases, wikilinks and a graph, real-time collaboration and plugins, on your device and your own server.',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['README.md', 'scripts/**'],
  head: [
    ['link', { rel: 'icon', href: `${base}favicon.ico`, sizes: '48x48' }],
    ['link', { rel: 'icon', href: `${base}favicon.svg`, type: 'image/svg+xml' }],
    ['link', { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` }],
    ['meta', { name: 'theme-color', content: '#5b5bd6' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Tessera Notes' }],
    ['meta', { property: 'og:title', content: 'Tessera Notes' }],
    ['meta', { property: 'og:url', content: `https://femboypuppy.github.io${base}` }],
    [
      'meta',
      {
        property: 'og:description',
        content: "Your notes, your server. Notion's power, Obsidian's freedom.",
      },
    ],
    [
      'meta',
      { property: 'og:image', content: `https://femboypuppy.github.io${base}social-preview.png` },
    ],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  themeConfig: {
    // The site's own theme toggle picks the version (the adaptive logo-mark.svg follows the OS).
    logo: { light: '/logo-mark-light.svg', dark: '/logo-mark-dark.svg', alt: '' },
    siteTitle: 'Tessera',
    nav: [
      { text: 'Guide', link: '/guide/', activeMatch: '^/guide/' },
      { text: 'Self-hosting', link: '/self-hosting/', activeMatch: '^/self-hosting/' },
      pluginsLink,
      { text: 'Contributing', link: '/contributing/', activeMatch: '^/contributing/' },
      { text: 'Download', link: `${repo}/releases/latest` },
    ],
    sidebar: {
      '/guide/': guideSidebar,
      '/self-hosting/': selfHostingSidebar,
      '/contributing/': contributingSidebar,
      ...(pluginItems.length ? { '/plugins/': [{ text: 'Plugins', items: pluginItems }] } : {}),
    },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 the Tessera contributors',
    },
  },
  vite: {
    plugins: [screenshotsPlugin()],
    // vitepress-plugin-mermaid pre-bundles mermaid's CommonJS dependencies by bare name, which
    // pnpm's strict node_modules can't resolve from here, so `vitepress dev` served them as they
    // are (dayjs, fastdom) and every page stayed blank. Pre-bundling mermaid itself converts all
    // of them.
    optimizeDeps: {
      include: ['mermaid'],
    },
  },
  async buildEnd(siteConfig) {
    if (existsSync(screenshotsDir)) {
      await cp(screenshotsDir, path.join(siteConfig.outDir, 'screenshots'), { recursive: true });
    }
  },
  mermaid: {},
});
