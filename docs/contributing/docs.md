# Writing docs

This site is built with [VitePress](https://vitepress.dev) from the `docs/` folder. It is its own
small pnpm project, separate from the app's workspace.

## Preview locally

```bash
pnpm --dir docs install
pnpm --dir docs dev
```

Open the address it prints. Pages reload as you save.

To check everything the way CI does, build the site. The build fails on any dead link:

```bash
pnpm --dir docs build
pnpm --dir docs preview
```

## Where things are

| Path                             | What                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `docs/index.md`                  | The home page.                                            |
| `docs/guide/`                    | User guides.                                              |
| `docs/self-hosting/`             | Server guides and the configuration reference.            |
| `docs/contributing/`             | Contributor pages, like this one.                         |
| `docs/plugins/`                  | The plugin guide and API reference. The sidebar lists every page in this folder automatically. |
| `docs/.vitepress/config.mts`     | Navigation, sidebar, search and site settings.            |
| `docs/.vitepress/theme/`         | Colors (from the app's design tokens) and components.     |
| `docs/public/`                   | Static files: favicon, logo, social image.                |

## Screenshots

Product screenshots live in `assets/screenshots/<area>/<name>-light.png` and `-dark.png`, and the
README uses the same files. Show one with:

```md
<Screenshot name="databases/board" alt="A project board grouped by status" />
```

It switches between the light and dark image with the site's theme, and hides itself if the image
doesn't exist yet. Regenerate screenshots from the app with `pnpm screenshots e2e/<area>`.

## Brand assets

The logo, favicon and social preview are generated from `docs/scripts/brand.ts` and the app's
design tokens:

```bash
pnpm --dir docs brand
```

It writes `assets/brand/`, copies the favicon set and the logo into `docs/public/` and
`apps/web/public/`, and regenerates the desktop app's icons with `tauri icon`. The mark is a leaf
of four mosaic tiles; `logo-mark.svg` and `favicon.svg` follow the system's color scheme, and
`logo-mark-light.svg` and `logo-mark-dark.svg` follow the docs site's theme toggle.

## Deploying (GitHub Pages)

GitHub Pages serves the site at `https://femboypuppy.github.io/Tessera-Notes/`, so the site is built
with the base path `/Tessera-Notes/` (set in `docs/.vitepress/config.mts`). To serve it somewhere else,
set `DOCS_BASE` when building:

```bash
DOCS_BASE=/ pnpm --dir docs build     # a custom domain, or the root of any static host
```

The output is `docs/.vitepress/dist`. The docs workflow in `.github/workflows` builds it on every
push to `main` and publishes it to GitHub Pages (enable Pages with "GitHub Actions" as the source
in the repository settings).

## Style

- Write for skimmers first: short sentences, one idea per paragraph, tables for reference.
- Say what the reader can do, in the words they see in the app ("Settings → Sync & account").
- Use <kbd>Mod</kbd> for the command key: `<kbd>Mod</kbd>+<kbd>K</kbd>`.
- Only document what exists. Plans go in the roadmap.
