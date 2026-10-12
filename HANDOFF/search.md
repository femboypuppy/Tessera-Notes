# Search & graph handoff

Agent 05 (`feat/search`): the search index, the command palette, the search page, backlinks and
unlinked mentions, and the global and local graph views. Everything lives in `packages/search`; the
three feature folders (`apps/web/src/features/{search,graph,backlinks}`) only register.

## Plan

All four milestones of `agents/05-search-graph.md` are done and committed.

1. **M1 Indexing.** One index worker per workspace session holds MiniSearch and the link graph.
   A main-thread host feeds it from `EventBus` events and sends Yjs state as bytes; parsing
   (`readDocJSON`, the `extract*` utilities) happens in the worker. The index is persisted to
   IndexedDB with version stamps and per-page fingerprints. Two services (priority 50) share it.
2. **M2 Palette and search page.** Mod+K palette (an `overlays` entry that lazy-loads the dialog),
   `/search?q=` with filters, counts and pagination, `COMMANDS.search`.
3. **M3 Backlinks.** Side panel with linked references and unlinked mentions (one-click Link with
   Undo), optional footer behind the workspace setting `backlinks.showFooter`.
4. **M4 Graph.** `/graph` (sigma.js + graphology, ForceAtlas2 in our own module worker) and the
   local-graph side panel (depth 1–3).

## Built (what exists and where)

`packages/search/src`:

| Folder | What |
|---|---|
| `engine/` | Runs in the index worker (or in-process): `index-core.ts` (`IndexCore`: MiniSearch over title, aliases, tags, headings, row values and body; filters; ranking; snippets; backlinks, outgoing links, edges, mentions, orphans, tags, tag co-occurrence, graph snapshots and neighborhoods; persistence snapshot), `extract.ts` (page docs and database docs to records), `query.ts` (query syntax), `text.ts` (tokens, folding, highlights, snippets), `runtime.ts` (ordered request handling and debounced saves), `persistence.ts` (IndexedDB and memory), `transport.ts` (worker and in-process transports), `protocol.ts`, `index.worker.ts`, `types.ts` |
| `services/` | Main thread: `index-host.ts` (`IndexHost`: follows events, reads docs from the `DocStore` or the live doc, prioritized and time-sliced queue, trash filtering, `whenIdle`, status), `minisearch-index.ts` (`MiniSearchIndex`), `graph-link-index.ts` (`GraphLinkIndex`), `create-transport.ts` (`DeferredTransport`: the worker, with an in-process fallback; never blocks opening a workspace), `guards.ts`, `index.ts` (`createSearchIndex`, `createLinkIndex`) |
| `palette/` | `host.tsx` (overlay host, idle preload), `store.ts`, `command-palette.tsx` (the dialog), `match-commands.ts`, `recent.ts`, `index.ts` (the light entry) |
| `search-page/` | `search-page.tsx` (`/search`), `location.ts` (URL state without a router dependency) |
| `backlinks/` | `panel.tsx`, `footer.tsx`, `settings.tsx`, `shared.tsx` (data hooks, live-titled context, `linkMention` with a scoped `Y.UndoManager`), `index.tsx` (light hosts) |
| `graph/` | `graph-view.tsx` (`/graph`), `local-graph-panel.tsx`, `graph-canvas.tsx` (sigma wrapper: reducers, themed labels and hover card, resize observer, `kill()` on unmount), `build.ts` (filters, sizes, seeding, colors, legend), `layout-engine.ts` (ForceAtlas2 with cooling and a settle test), `layout.worker.ts`, `layout-runner.ts` (worker plus main-thread fallback), `use-layout.ts` (frame-batched updates), `theme.ts` (colors from the CSS tokens), `data.ts`, `location.ts`, `index.tsx` |
| `ui/` | `common.tsx` (highlighting, page glyphs, paths, relative times, `focusSnippet`), `doc-preview.tsx` (read-only preview blocks) |
| `bench/` | `generator.ts` (seeded realistic workspaces), `seed.ts` (writes one into a session), `search.bench.ts` (the benchmark) |
| `dev/` | `test-hooks.ts` (e2e and screenshot seeding, off unless enabled) |
| `i18n/` | `en.ts`, `index.ts` (`t` for the `search` namespace) |

Feature folders: `apps/web/src/features/search/index.ts` (+ `index.test.ts` covering all three
features), `apps/web/src/features/graph/index.ts`, `apps/web/src/features/backlinks/index.ts`.

Tests: 11 Vitest files in `packages/search` (71 tests) and 1 in `apps/web/src/features/search`
(4 tests). e2e in `e2e/search/`: `palette.spec.ts` (5), `backlinks.spec.ts` (3), `graph.spec.ts` (4),
`search.screenshots.ts`, and an opt-in performance run (`search.perf.ts`, `perf.config.ts`).

## How it plugs in (FeatureModule entries, services, extension points used)

**`search` feature**

- `services`: `searchIndex` → `minisearch` (priority 50), created with `import('@tessera/search/services')`.
- `overlays`: `palette` (`PaletteHost`, a few hundred bytes; the dialog loads on first open or on idle).
- `routes`: `/search` (lazy).
- `commands`: `search.openPalette` (`COMMANDS.openPalette`, Mod+K, toggles), `search.open`
  (`COMMANDS.search`, Mod+Shift+F, args `{ query }`; a tag click with `#tag` opens
  `/search?q=%23tag`, which filters by that tag), `search.rebuildIndex`.
- `activate`: records recently opened pages from `navigation.changed` (device setting
  `search.recent.<workspaceId>`), closes the palette on session close, and installs the test hooks
  when the device setting `search.testHooks` is true.

**`backlinks` feature**

- `services`: `linkIndex` → `graph` (priority 50). It shares the index worker with the search index
  (one host per workspace doc), so each doc is read and parsed once for both.
- `pageSidePanels`: `PANELS.backlinks` (no `when`: off a page it says "Open a page…" instead of the
  shell's generic empty panel). `pageFooterSections`: `backlinks` (a light host that renders
  nothing unless `backlinks.showFooter` is on). `settingsPanels`: `backlinks` (the footer switch).
- `commands`: `backlinks.show`.

**`graph` feature**

- `routes`: `/graph` (lazy; `/graph?focus=<pageId>` focuses a page). `pageSidePanels`:
  `PANELS.localGraph` (no `when`, like backlinks). `sidebarSections`: `graph` (a "Graph view"
  entry at the top). `commands`: `graph.open` (`COMMANDS.openGraph`), `graph.showLocal`.

**Settings keys**: workspace `backlinks.showFooter`; device `graph.options` (color mode, orphans,
rows, depth), `graph.localDepth`, `search.recent.<workspaceId>`, `search.testHooks`.

**Query syntax** (palette, search page and `SearchIndex.query`): free words (fuzzy and prefix, all
words required), `tag:name` or `#name` (nested tags match their parents), `in:Title` or
`in:"Two words"` (pages inside that page), `type:page|database`, `is:task`. In the palette, `>`
lists commands; Mod+Enter opens the search page for the current text.

**Core used**: `SearchIndex`, `LinkIndex`, `IndexServiceContext`, `readDocJSON`, `extractTextBlocks`,
`extractLinks`, `extractTags`, `extractTasks`, `findTextOccurrences`, `replaceTextWithPageLink`,
`updateDocJSON`, `getPageProps`, `listProperties`, `listRows`, `validatePropertyValue`, `tagKey`,
`tagHierarchy`, `normalizeTagName`, `DOC_SCHEMA_VERSION`, `DATA_MODEL_VERSION`, `COMMANDS`, `PANELS`,
`useSetting`, `usePages`, `useAppContext`.

## Decisions (and why)

- **One worker, bytes in.** Page docs live on the main thread (`DocManager`), so the host sends
  `Y.encodeStateAsUpdate` (or the stored update) to the worker, which parses it. Parsing 5,000 docs
  takes ~5–10 s of CPU; none of it runs on the main thread. Docs changed in this session are read
  from the live doc; everything else straight from the `DocStore`, without opening docs (no sync
  connections). Stored bytes are copied before being transferred, so the store's buffers are never
  detached.
- **The workspace never waits for the index.** `DeferredTransport` returns at once and queues
  requests until the worker answers; a worker that cannot start (strict CSP, old browser) falls
  back to the same code in-process.
- **Persistence**: one IndexedDB entry per workspace (`tessera-search` / `indexes`) with the MiniSearch
  JSON, content records, row values and fingerprints (`PageMeta.updatedAt` at read time), stamped
  with `INDEX_FORMAT_VERSION`, `DOC_SCHEMA_VERSION` and `DATA_MODEL_VERSION`: any mismatch starts
  empty and re-indexes. On start, only pages whose `updatedAt` differs are re-read. Saving
  serializes the whole index (~1 s of worker time at 5,000 pages), so it waits for 10 s of quiet,
  and also runs when the tab is hidden and when the session closes.
- **Trash disappears at once**: trash and restore flush metadata synchronously, and the host also
  drops hits for pages that are trashed or deleted by the time the worker answers.
- **Linked titles are part of a page's text** (as of indexing time), so "apollo" finds pages that
  link to Apollo, and snippets read naturally.
- **Ranking**: MiniSearch BM25 with field boosts (title 6, aliases 4, tags 3, headings 2.5, row values
  1.5, body 1), prefix matching for words of two letters or more, fuzzy matching (1 edit from 4
  letters, 2 from 9), AND semantics, then × recency (30-day half-life), × backlinks
  (1 + 0.15·log2(1 + inbound)), × 0.85 for rows, × 3 for an exact title and × 1.6 for a title
  prefix. One- and two-letter queries only prefix-match titles, aliases, tags and headings (plus
  exact words anywhere): a two-letter prefix matches most of any body.
- **`in:` means descendants** (not the page itself), matching the core stub; titles resolve exactly,
  then by prefix; several pages with the title all count.
- **Unlinked mentions**: the worker finds candidate pages with a regular expression over indexed
  text (a superset), then the precise check (`findTextOccurrences`) runs on the candidates' current
  content, so positions always match the doc the Link button changes. The worker also returns
  where each mention sits in the displayed block text (links show as titles there), so the panel
  highlights the exact word. Titles and aliases shorter than two characters never count.
- **Link is undoable exactly**: the change is written with its own transaction origin and a
  `Y.UndoManager` scoped to it; Undo reverts only that change even if the page was edited since.
  Stale mentions (text changed) are refused with a message and the list refreshes.
- **The search page has no router dependency**: `/search` params live in a tiny store updated by
  `openSearch` (every navigation to `/search` goes through it) and `popstate`.
- **Palette details**: keeps the last results on screen while the next query runs (no flicker);
  Enter pressed before the typed text's results arrive waits for them (so a fast Enter opens the
  match instead of "Create page"); focus stays in the palette while it is open (a menu closing just
  before would otherwise pull focus out); the preview loads 70 ms after the highlight settles.
- **Graph layout**: our own module worker drives `graphology-layout-forceatlas2/iterate.js` (the
  package's own worker builds a blob from a stringified function, which a strict CSP rejects).
  LinLog mode separates communities; a cooling schedule plus a settle test (mean movement relative
  to the layout's extent) stops it; nodes start clustered by top-level page, so it converges fast
  and communities stay together. Positions carry over when data or filters change.
- **Graph colors** come from the CSS tokens (accent and the tag `-fg` colors, background, borders,
  text) and follow theme changes live; dimmed nodes mix into the background. The local graph keeps
  the accent for the page it is about. Color by tag uses each page's most common tag.
- **Big graphs** (more than 3,000 nodes or 6,000 links) hide edges and labels while the camera moves,
  debounce hover highlighting (140 ms) and skip it while dragging; layout updates apply once per
  frame.
- **Test hooks in the app**: `window.__tesseraSearch` (seed a generated workspace, write paragraphs
  with links and tags, read a doc, wait for the index, a synthetic 10,000-node graph) and
  `window.__tesseraGraph` (node positions, layout settled). Installed only when the device setting
  `search.testHooks` is true, which only the specs set; my specs don't depend on the editor's UI.
- **Test timeout**: the package's Vitest project allows 20 s per test. Its integration tests run
  the real runtime, index and UI, and on a saturated machine (other agents' builds) some needed a
  little over the 5 s default; the assertions are unchanged.
- **Dependencies**: only `fake-indexeddb` 6.2.5 (Apache-2.0, dev only, already in the lockfile for
  `packages/sync`) to test the IndexedDB persistence. Everything else was pre-installed.

## Contract change requests (exact proposed diff to packages/core, and why)

Both are optional additions; my code works with the current contract (the extra fields are on my
own `RichSearchHit` and `RichBacklink` types) and would simply move them into core.

1. **`SearchHit` can say where to scroll.** Palette and search results navigate to the matching
   heading or block; other consumers (plugins, the editor's link search) would benefit too.

   `packages/core/src/services/search-index.ts`:
   ```diff
      /** A short excerpt around the best body match, with highlights into `snippet.text`. */
      snippet?: { text: string; highlights: HighlightRange[] };
   +  /** Text of the heading that matched best, for `ctx.navigate(pageId, { heading })`. */
   +  heading?: string;
   +  /** Block ID of the block that matched best, for `ctx.navigate(pageId, { blockId })`. */
   +  blockId?: string;
    }
   ```
2. **`Backlink` keeps the block ID** that `ExtractedLink` already has, so a backlink can scroll to
   its block.

   `packages/core/src/services/link-index.ts`:
   ```diff
      /** Path of that block in the source document, and the link's inline offset. */
      path: number[];
      offset: number;
   +  /** Block ID of the containing block (or its nearest container), or null. */
   +  blockId: string | null;
    }
   ```
   and in `NaiveLinkIndex.backlinks`: `blockId: link.blockId,`.

## Known gaps and bugs

- **Only local content is indexed.** A doc that was never stored on this device (a collaborator's
  page not opened yet) is indexed by title only until it arrives; a remote `updatedAt` change
  re-reads what the store has. See the sync follow-up.
- **No phrase search**: quotes group words for `in:"…"` but free-text quotes are plain words.
- **Linked titles in page text** are as of indexing time: renaming a target updates live titles in
  panels and results, but the source page's searchable text catches up when it is next edited.
- **The first full index of a large workspace** takes ~1–2 ms per page in the worker (5,000 pages:
  ~5–10 s on this machine) with "Indexing N of M" in the palette; titles are searchable at once.
- **Graph layout of 10,000 nodes** takes ~40 s to settle (in the worker; the page stays at 60 fps).
- **Without a GPU** (headless browsers use SwiftShader, Linux without a driver uses llvmpipe),
  redrawing a 10,000-node graph takes about 220 ms: with software compositing every frame reads
  each WebGL layer back, and the readback waits for the nodes to be drawn on the CPU. So a large
  graph (over 3,000 pages or 6,000 links) on a software renderer pans by moving the drawn layers
  with a CSS transform and is redrawn once on release (`image-pan.ts`, #96): panning, settled,
  p95 33 ms instead of 267 ms. Zooming and highlighting still redraw, so each wheel step or hover
  highlight takes a fifth of a second there. 300-page graphs are fine either way.
- **Firefox e2e under heavy load**: with many parallel workers on a busy machine, Firefox runs hit
  context-close timeouts (Firefox logs `RenderCompositorSWGL failed mapping default framebuffer`);
  this affected the Architect's shell, smoke and page-tree specs as well. The last full run
  (`--workers=2`, both browsers) passed 49 of 50; the one failure was the Architect's Firefox
  page-tree spec timing out while closing its browser context. Every `e2e/search` spec passed in
  both browsers.
- The palette preview shows a simplified read-only rendering (tables and images as labels).
- **Root `pnpm test` on a saturated machine**: two of the Architect's tests (`packages/ui`
  EmojiPicker, `apps/web` App shell) hit the 5 s default timeout while 20 other agents' Node
  processes kept the CPU at 100%; they pass with a longer timeout and don't touch this branch's code
  (the App shell test runs with no features). Nothing in this branch changes them. Once the
  machine was quieter, the full root run passed: 46 files, 342 tests.
- Checked at phone width (390 px): palette, backlinks sheet, graph with focus, search page.

## Follow-ups for the merge (cross-agent wiring you couldn't finish alone)

- **Editor (02)**: tag clicks run `COMMANDS.search` with `#tag` (works: `/search?q=%23tag`).
  Palette, search and backlinks navigate with `ctx.navigate(id, { heading })` or `{ blockId }`, which
  the editor's `target` handling scrolls to. Journeys can create links with `[[` in the editor;
  my specs use the test hooks on purpose.
- **Sync (03)**: with the IndexedDB `DocStore` the persisted index pays off across reloads (restart
  re-reads only changed pages). If the sync provider stores remote updates for docs that are not
  open (background sync) without going through `DocManager`, please fire `page.updated`
  (`updatedAt`) or open the doc so `doc.changed` fires; the index then re-reads it.
- **Databases (04)**: row values are indexed from the database doc (text, numbers, select and
  multi-select option names, dates, checkbox names when checked, URLs, emails, relation titles);
  formulas are not.
- **Importers (08)**: nothing required (every written doc fires `doc.changed`); `search.rebuildIndex`
  exists for manual rebuilds.
- **CI (09)**: `pnpm --filter @tessera/search bench` runs the benchmark (exits non-zero over budget);
  `pnpm exec playwright test -c e2e/search/perf.config.ts` runs the browser performance checks
  (they pass GPU flags for Windows; `PERF_SOFTWARE_GL=1` keeps the software renderer, as on
  Linux CI, where the Nightly workflow runs them).
- **Docs (10)**: query syntax above; screenshots below.
- **Architect**: `PageView` renders `pageFooterSections` and `pageTopSections` without a `Suspense`
  boundary, so a lazy section would suspend the page; mine is a light host with its own
  `Suspense`. Wrapping them in the shell would make lazy sections safe. If a CSP is added, the two
  module workers need `worker-src 'self'`.
- **Architect (tests)**: on this machine, with nine other agents building at once, three shell
  tests exceed Vitest's 5 s default (`packages/ui` EmojiPicker ~8.6 s, `apps/web` App shell
  "onboards…" ~6.9 s and "nests…" ~4.8–5.2 s); they pass with more time. A per-test timeout for
  those integration tests would keep `pnpm test` green on busy CI runners.
- **Bundle**: startup JS measured at 213 KB gzip (entry plus static imports) with every feature of
  this branch registered.

## Benchmark results

`pnpm --filter @tessera/search bench` (5,000 generated pages, 3.5 MB of Yjs updates; Node 24 on
Windows, a 12-thread machine shared with other agents' builds, so absolute times are pessimistic;
latencies are the median of 5 runs of each query):

| Measure | Result |
|---|---|
| Initial index (parse and index every doc, in the worker) | 5.5–10.8 s (1.1–2.2 ms per doc) |
| Persist (serialize and structured-clone the index) | 0.7–1.1 s |
| Persisted startup (load and reconcile) | 230–260 ms, 0 docs re-read |
| Query p50 / p95 (300 queries: words, prefixes, typos, two words, filters) | 3.3 / 16.4 ms |
| Palette keystroke p50 / p95 (156 keystrokes) | 2.7 / 10.5 ms |
| Filter-only query (`tag:`) p95 | 18.4 ms |
| Backlinks p95 | 0.02 ms |
| Unlinked-mention candidates p95 | 11.9 ms |
| Graph snapshot | 69–250 ms (5,000 nodes, 10,610 links) |

In the browser (`perf.config.ts`, Chromium, production build):

| Measure | Result |
|---|---|
| Palette keystroke on 5,000 pages (input event to rendered results, worker round trip included) | p50 13.6 ms, p95 26.8 ms, max 56.9 ms (150 keystrokes) |
| Seeding and indexing 5,000 pages through the app | 146 s (seeding dominates: `createPage` is O(n)) |
| Graph, 10,000 nodes and 21,222 links (RTX 3060): first render | 1.8 s |
| Frame time while panning during layout | p50 16.7 ms, p95 16.7 ms |
| Frame time while panning, settled | p50 16.7 ms, p95 16.7 ms |
| Frame time while hovering, settled | p50 16.7 ms, p95 16.7 ms |

## Screenshots (list of files)

`assets/screenshots/search/`, 1440×900, each as `-light.png` and `-dark.png`
(`pnpm screenshots e2e/search`):

- `palette`: the palette over a generated workspace, a query with title and content hits and the
  preview pane.
- `backlinks`: the backlinks panel on "Europa": linked references with context and unlinked mentions
  with Link buttons.
- `graph`: the global graph of a generated ~300-page workspace, colored by tag, with the legend.
- `local-graph`: the local graph panel at depth 2.
