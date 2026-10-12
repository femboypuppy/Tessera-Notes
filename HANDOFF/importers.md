# Importers handoff

Agent 08: markdown engine, import and export. Branch `feat/importers`.

## Plan

Milestones, in order, each ended tested and committed:

1. **M1: markdown engine (`packages/markdown`).** unified + remark-parse + remark-gfm +
   remark-frontmatter, plus my own micromark syntax extensions for `[[wikilinks]]`, `![[embeds]]`,
   `#tags`, `==highlights==` and `^block-ids`. mdast ↔ DocJSON converters, Obsidian callouts
   (foldable variants too), toggles as `<details>`, task lists, tables, lossless fallbacks for
   embeds, `parseHTML` (DOMPurify + a DOM walker with Notion, Google Docs and Word heuristics).
   Registered as the `markdownCodec` service (priority 50), loaded in the async `create`.
   Property-based round-trip tests with fast-check. ✅ `971e255`
2. **M2: importers (`packages/importers`).** A worker-safe *planner* turns files into an import plan
   (page tree, DocJSON with resolved links, databases from CSV with inferred types, attachment
   references), run in a Web Worker; the main thread stores assets and applies the plan in
   time-sliced batches (progress, cancel). Notion, Obsidian and markdown-folder importers, zip-slip
   protection, realistic fixtures, an import report. ✅ `b585cb1`
3. **M3: exporters.** Obsidian-compatible markdown zip, JSON backup and restore into a new
   workspace, standalone HTML, PDF through a print view. Registered in `ctx.exporters`. ✅ `3213e29`
4. **M4: UI.** Import dialog, export dialog, print view, settings panel, sidebar and page entry
   points, onboarding actions with a demo workspace, e2e specs and screenshots. ✅ `6d93261`,
   `7755074` and the commits after them.

## Built (what exists and where)

### `packages/markdown` (`@tessera/markdown`)

- `src/codec.ts`: `RemarkMarkdownCodec` / `createMarkdownCodec()`, the `MarkdownCodec` contract:
  `parse(markdown, options)` → `{ doc, frontmatter, warnings }`, `serialize(doc, options)`,
  `parseHTML(html, options)`. Deterministic; output goes through `normalizeDocJSON`.
- `src/syntax/`: micromark tokenizers (`micromark.ts`), mdast node types (`nodes.ts`) and the
  from/to-markdown handlers (`mdast.ts`) for wikilinks, embeds, tags, highlights and block IDs,
  plus escaping fixes found by the property tests.
- `src/to-doc.ts` (mdast → DocJSON) and `src/from-doc.ts` (DocJSON → mdast): every schema node and
  mark, callouts, toggles, colors, block IDs, images with widths, embeds, page links in both link
  styles, attachment paths.
- `src/callouts.ts` (Obsidian callout types ↔ tone and emoji), `src/wikilinks.ts`,
  `src/embeds.ts`, `src/frontmatter.ts` (YAML, core schema), `src/html/` (`parseHTML`: DOMPurify,
  then a walker with Notion, Google Docs, Word and web-page rules; a tokenizer fallback without a
  DOM).
- Tests: `codec.test.ts` (syntax, escaping, security), `html/parse-html.test.ts` (Notion, Google
  Docs, Word, web pages, sanitizing), `roundtrip.test.ts` (fast-check:
  `parse(serialize(doc))` equals `doc` for every schema feature; `serialize(parse(md))` is stable
  after one normalization pass; determinism; a kitchen-sink document).

### `packages/importers` (`@tessera/importers`, `@tessera/importers/ui`)

- `src/importers.ts`: `createNotionImporter`, `createObsidianImporter`, `createMarkdownImporter`
  (also registered under core's `markdown-basic` ID), `createBackupImporter`. Each has `detect`
  (Notion: share of 32-hex IDs in names; Obsidian: `.obsidian/`, wikilinks, callouts; markdown:
  share of text files; backup: the JSON's `format`).
- `src/run.ts`: the import pipeline. Unpacks archives (`files.ts`: nested and multi-part zips,
  size limits, zip slip rejected), stores attachments, plans in a worker (`worker/`: client,
  worker, DOM shim, protocol with the plan streamed in chunks), applies the plan
  (`apply.ts`: sliced page creation, databases and rows, content), builds the report.
- `src/plan/`: `planner.ts` (titles, frontmatter, folder notes, Notion title headings and
  property lines, databases from CSV with typed columns, row matching, relations, unreferenced
  attachments) and `resolver.ts` (Obsidian link rules: exact path, relative path, shortest unique
  name, case-insensitive, aliases, Notion IDs and `%20` paths).
- `src/csv.ts`: CSV parsing and writing, type inference (checkbox, number with formats, date and
  date ranges, created/updated time, URL, email, relation, select vs multi-select vs text).
- `src/exporters.ts` + `src/export/`: `markdown.ts` (Obsidian markdown folder: page files, child
  folders, frontmatter, shortest-path wikilinks or relative links, databases as CSV plus row
  pages, attachments folder), `html.ts` (standalone HTML, images inlined, print stylesheet),
  `backup.ts` (versioned JSON backup of every Y.Doc state and asset, zod-validated restore),
  `zip-sink.ts` (streaming zip `ExportSink`, single-file sink), `names.ts`, `csv-values.ts`.
- `src/ui/` (the `./ui` subpath): `entry.tsx` (light startup pieces: overlay host, sidebar item,
  page action, commands, routes, settings panel entry, onboarding actions, activation),
  `store.ts` (dialog and import-job state), `ImportDialog.tsx`, `ExportDialog.tsx`,
  `PrintView.tsx`, `SettingsPanel.tsx`, `jobs.ts` (runs imports outside the dialog's lifetime),
  `pick.ts` (file inputs and dropped folders), `preview.ts`, `labels.ts`, `download.ts`,
  `demo.ts` (demo workspace loader), `routes.ts`.
- `demo/`: the bundled demo workspace (markdown with wikilinks, callouts, tasks, tables, a toggle
  and a `Reading list.csv` database with a row page), used until `examples/demo-workspace`
  exists.
- `fixtures/`: `obsidian-vault/` (folder notes, deep nesting, duplicate titles, aliases, unicode
  and emoji names, `%20` links, broken links, embeds, callouts, block refs, attachments, a CSV,
  `.obsidian/` and `.trash/`), `notion-export/` (Notion IDs, nested pages, `_all.csv` databases
  with every property type, relations as notion.so URLs, emoji H1 icons, asides, untitled pages,
  images), `markdown-folder/` (relative links, a CSV with row pages, images).
- Tests: `importers.test.ts` (tree, links, typed properties, contents and report counts for all
  three importers; zips, nested and multi-part zips, zip slip, broken archives, detection,
  cancellation, preserved source timestamps), `exporters.test.ts` (files, frontmatter, links,
  CSV, both link styles, HTML, backup and restore, and the round trip vault → import → export →
  import compared page by page), `csv.test.ts`, `performance.test.ts`, `worker/client.test.ts`,
  `ui/dialogs.test.tsx` (import preview → report, undoable trash, empty state, export zip, `.md`
  and HTML downloads, PDF, commands), `ui/restore.test.tsx` (a backup restored through the dialog
  into a new workspace), `ui/views.test.tsx` (print view, settings panel), `ui/preview.test.ts`
  (preview summary, dropped folders, backup detection), `ui/demo.test.ts`.

### `apps/web/src/features/import-export`

`index.ts` only registers (see below); `index.test.ts` checks the codec and the registrations.

### `e2e/importers`

- `import-export.spec.ts`: imports the Obsidian fixture through the dialog (preview, report
  counts, issues), opens the imported pages, follows imported links through the print view
  (alias link, heading link) and back to the page; drops a Notion export zip on the drop zone
  (detected as Notion, two databases); exports a workspace as a zip and checks its files and
  contents.
- `responsiveness.spec.ts`: a 2,000-note vault (zip) imports while an in-page heartbeat measures
  the longest main-thread gap and records the phases the dialog showed.
- `access.spec.ts`: at phone width, "Import from Obsidian" from onboarding opens the dialog in a
  new workspace; it fits the screen, traps focus, works by keyboard (Tab, Enter, Escape).
- `importers.screenshots.ts`, `helpers.ts` (fixtures, a zip reader and writer on `node:zlib`, a
  realistic research-vault generator).

## How it plugs in (FeatureModule entries, services, extension points used)

`importExportFeature` (`apps/web/src/features/import-export/index.ts`):

| Field | What |
| --- | --- |
| `services` | `markdownCodec`, id `remark`, priority 50 (`SERVICE_PRIORITY.browser`), created by a dynamic `import('@tessera/markdown')` so unified stays out of the startup bundle |
| `importers` | `notion`, `obsidian`, `markdown`, `tessera-backup`, and `markdown-basic` (the markdown importer again, replacing core's stub; its `detect` returns 0 so it never competes) |
| `exporters` | `markdown` (Obsidian markdown), `html`, `tessera-backup`, and `markdown-basic` (the Obsidian markdown exporter, replacing core's, for the desktop mirror) |
| `commands` | `COMMANDS.openImport` (args `{ importerId? }`), `COMMANDS.openExport` (args `{ pageId? }`, defaults to the open page), group `workspace` |
| `overlays` | `import-export`: renders nothing until a dialog opens, then lazy-loads it |
| `routes` | `/print/:pageId`, `layout: 'bare'` (the print view; the PDF export opens it with `?print=1`) |
| `sidebarSections` | `import`, position `bottom`: an "Import" row |
| `pageHeaderActions` | `export`: an "Export page" button |
| `settingsPanels` | `import-export`: import from each source, export the workspace, download a backup, restore a backup |
| `onboardingActions` | Import from Notion / Obsidian / markdown (open the dialog with that source), Open the demo workspace (imports the demo and opens its welcome page) |
| `activate` | restores a backup waiting for the workspace the dialog just created; the cleanup cancels a running import when the workspace closes |

Services used: `assetStore` (`put` with name and MIME type, `get`, `getUrl`, `getInfo`),
`markdownCodec`, `workspaceRegistry.create` + `ctx.switchWorkspace` (backup restore). Core helpers:
`createPage`, `writeDocJSON`, `setPageProps`, `normalizeDocJSON`, `createDatabase`,
`addProperty`, `addRow`, `normalizeImportPath`, `sanitizeFileName`, `MemoryExportSink`.

Bundle: the startup chunks (entry plus static imports) measure 218.5 KB gzip against the 250 KB
budget (214.8 KB before M4). The codec, importers, exporters, dialogs and print view are lazy
chunks; the import worker is its own ~509 KB chunk loaded only when an import runs.

## Decisions (and why)

**Markdown**

- Soft line breaks inside a paragraph become `hardBreak`s: Obsidian shows them as line breaks
  (its default), and notes written that way should look the same.
- Bare URLs are linked on import (GFM autolink literals), and literal text that would autolink is
  kept as text on the way back, so round trips stay exact.
- Empty paragraphs are written as a `&nbsp;` line; empty list items too (an empty item cannot
  interrupt a paragraph, and a blank line after it would end the item).
- Block, list item and quote colors ride along as HTML comments (`<!--color:red-->`), invisible
  in Obsidian and GitHub. Block IDs use Obsidian's ` ^id`.
- Callouts map to `callout {emoji, tone}` through a table of Obsidian types (note, info, tip,
  success, question, warning, failure, danger, bug, example, quote and their aliases); unknown
  types become notes. A foldable callout (`[!note]-`) becomes a callout holding a toggle.
- Content markdown cannot express (database views, embeds without a URL form) is written as a
  fenced `tessera-embed` block of JSON, so nothing is lost on a round trip.
- In a list item, the item's block ID is kept; a block ID on the item's first paragraph is not
  written (one `^id` per line).
- `parseHTML` always runs DOMPurify first (no scripts, styles, forms, iframes); images keep only
  `http(s)` and `data:` sources.

**Importing**

- Planning (parsing, link resolution, CSV inference) runs in a Web Worker. The worker loads
  micromark, whose entity decoder calls `document.createElement` on load, so the worker installs a
  tiny DOM shim first (`worker/dom-shim.ts`, listed in `sideEffects` so Vite keeps it).
- The plan comes back in chunks of 100 pages: one message with every page took the main thread
  about 350 ms to read.
- The main thread yields between 12 ms slices through a `MessageChannel`, not
  `scheduler.yield()`: a yielded continuation runs before tasks already waiting, which starved
  React's renders, so the progress dialog froze for the whole import.
- Page content is written from a scratch Y.Doc and applied as one update. That transaction is not
  "local", so the runtime does not touch each page (which replaced the source's updated time with
  now and cost one workspace transaction per page). Tested:
  `importers.test.ts › dates as timestamps`.
- Everything lands under one new root page; its title is suggested from the vault or folder name
  ("Notion import" for Notion) and can be edited in the dialog.
- Titles: frontmatter `title` wins (an empty one included, so untitled pages round-trip), then the
  file name; Notion's IDs are stripped and its duplicate title headings removed.
- CSV dates without a time zone are read as UTC, so a date means the same day everywhere.
- A running import outlives its dialog: closing the dialog keeps it going, and a toast says when
  it ends.
- Reports list issues grouped by code with translated headings; the per-issue message is the
  importer's English detail (`TransferIssue.message`), as the contract allows.

**Exporting**

- Wikilinks use the shortest unique name and fall back to the vault path when names collide
  (Obsidian's "shortest path when possible").
- Every database row is written as a `.md` file in the database's folder (even without content),
  so row pages and their properties survive a round trip; the CSV holds the columns. Relations in
  the CSV are `Title (relative/path.md)`, which the importer resolves back.
- One page exported as markdown downloads as a plain `.md` file; a zip only when it has
  attachments.
- The PDF export is the browser's own "Save as PDF" on a print view (`/print/:pageId`), not a PDF
  library: no dependency, real text, and the same print stylesheet as the HTML export. The print
  view renders sanitized HTML (DOMPurify) in a shadow root, so its styles and the app's never mix;
  it follows the app theme on screen and prints light.
- Backups are one versioned JSON file (every Y.Doc as a base64 update, every asset), validated
  with zod on restore. Restoring needs an empty workspace, so the dialog creates one, switches to
  it, and `activate` restores the pending backup there.

**Tests**

- The Node benchmark runs 500 notes (`TESSERA_IMPORT_BENCH_NOTES=2000` runs 2,000). At 2,000 it
  took 37 s of CPU and made other packages' tests time out when the whole suite ran together. The
  2,000-note import is checked where freezing matters, in a browser
  (`e2e/importers/responsiveness.spec.ts`).
- My package's Vitest config gives tests 30 s and Testing Library 10 s for async queries: they
  run real imports, and other worktrees' suites often share this machine.

**Dependencies** (all pinned, only in my `package.json`s)

- `@tessera/markdown`: `unified`, `remark-parse`, `remark-stringify`, `remark-gfm`,
  `remark-frontmatter`, `micromark-extension-*`, `micromark-util-*`, `mdast-util-*`,
  `unist-util-visit` (MIT, the unified ecosystem the brief asks for), `yaml` (ISC, frontmatter),
  `dompurify` (Apache-2.0/MPL-2.0, required for HTML), `character-entities` (MIT, entity decoding
  without a DOM), `fast-check` (MIT, dev).
- `@tessera/importers`: `fflate` (MIT, small and fast zip with streaming and async unzip),
  `papaparse` (MIT, CSV), `yaml` (ISC), `zod` (MIT, backup validation; already in core),
  `dompurify` (print view), `character-entities` (worker DOM shim), `yjs` (backups and content
  writes; already in core), `lucide-react` and `react-router` (same versions as the shell);
  dev: Testing Library and `jsdom` at the root's versions.

## Contract change requests (exact proposed diff to packages/core, and why)

### 1. `createPages`: create many pages with one page index

`createPage` builds a full page index on every call (`indexPages(ws)`, O(n)), so creating n pages
is O(n²). It dominates large imports: in the profile of a 2,000-note import, `createPageIndex`
was the top function, the "Creating pages" phase took 11.8 s in Node and most of a 40 s import in
Firefox, and it slows as the workspace grows. The importer works around it by slicing, so the UI
stays responsive, but the total time stays quadratic. Proposed (in
`packages/core/src/model/pages.ts`; exported through `model/pages`):

```diff
@@ export function createPage(
   if (!created) throw new InvalidOperationError('Failed to create page');
   return created;
 }
+
+/**
+ * Creates many pages in one transaction, indexing the workspace once (importers create
+ * thousands; `createPage` re-indexes every page on each call). Inputs are created in order, so a
+ * page can be the parent of a later one. Each input is placed at the end of its parent's
+ * children (`position` is not supported). Validation is the same as `createPage`'s.
+ */
+export function createPages(
+  ws: Y.Doc,
+  inputs: readonly Omit<CreatePageInput, 'position'>[],
+  options: MutationOptions = {},
+): PageMeta[] {
+  const created: PageMeta[] = [];
+  ws.transact(() => {
+    const pages = pagesMapOf(ws);
+    const index = indexPages(ws);
+    const createdIds = new Set<string>();
+    /** The last order key under each parent, for parents that get new children. */
+    const lastOrder = new Map<string | null, string>();
+    const now = options.now ?? Date.now();
+    for (const input of inputs) {
+      const id = input.id ?? newId();
+      if (!isValidId(id)) throw new ValidationError('Invalid page ID', [id]);
+      const kind = input.kind ?? 'page';
+      if (!PAGE_KINDS.includes(kind)) throw new ValidationError('Invalid page kind', [String(kind)]);
+      if (input.icon !== undefined && !isValidIcon(input.icon))
+        throw new ValidationError('Page icons must be a single emoji', [input.icon]);
+      if (input.cover !== undefined && !parsePageCover(input.cover))
+        throw new ValidationError('Invalid page cover');
+      const parentId = input.parentId ?? null;
+      if (parentId === id) throw new InvalidOperationError('A page cannot be its own parent');
+      if (pages.has(id)) throw new InvalidOperationError(`Page "${id}" already exists`, { id });
+      if (parentId !== null && !createdIds.has(parentId)) assertParentUsable(index, parentId);
+      const previous =
+        lastOrder.get(parentId) ??
+        (parentId !== null && createdIds.has(parentId)
+          ? null
+          : orderAfterAllOrNull(index.children(parentId, { includeRows: true, includeTrashed: true })));
+      const order = orderBetween(previous, null);
+      lastOrder.set(parentId, order);
+      const map = new Y.Map<unknown>();
+      map.set('kind', kind);
+      map.set('title', normalizeTitle(input.title ?? ''));
+      map.set('parentId', parentId);
+      map.set('order', order);
+      map.set('createdAt', input.createdAt ?? now);
+      map.set('updatedAt', input.updatedAt ?? input.createdAt ?? now);
+      if (options.userId) {
+        map.set('createdBy', options.userId);
+        map.set('updatedBy', options.userId);
+      }
+      if (input.icon) map.set('icon', input.icon);
+      if (input.cover) map.set('cover', { ...input.cover });
+      if (input.favorite) map.set('favorite', true);
+      pages.set(id, map);
+      createdIds.add(id);
+      const meta = readPageMeta(id, map);
+      if (meta) created.push(meta);
+    }
+  }, options.origin);
+  return created;
+}
+
+/** The largest valid order key among siblings, or null when there is none. */
+function orderAfterAllOrNull(siblings: readonly PageMeta[]): string | null {
+  let last: string | null = null;
+  for (const sibling of siblings)
+    if (isValidOrderKey(sibling.order) && (last === null || sibling.order > last)) last = sibling.order;
+  return last;
+}
```

(plus `orderBetween` and `isValidOrderKey` added to the existing `'../order'` import). Once it
lands, `packages/importers/src/apply.ts` replaces its per-page `createPage` loop with one
`createPages` call per slice of about 200 pages.

### 2. (Optional) quieter replacement of stub importers and exporters

`createListRegistry.register` warns "registered twice; the last one wins" when my feature replaces
core's `markdown-basic` importer and exporter, which `HANDOFF/architect.md` asks for. Every app
start logs two warnings for an intended replacement. Proposed: skip the warning when the earlier
item was registered by core (for example, core registers its stubs with a `replaceable: true`
flag, or `register(item, { replace: true })`). Not required; noted so nobody chases the warning.

## Known gaps and bugs

- **Stretch importers** (Logseq, Bear, Evernote `.enex`, HTML files) are not built.
- **Import speed** on very large vaults is bound by core's per-page index (CCR 1): 2,000 notes
  take ~17 s in Chromium and ~41 s in Firefox on this machine, without freezing.
- **The print view is a snapshot**: it renders the page when opened and does not follow live
  edits. Databases print as tables (every column, rows in stored order), not their views.
- **Exports drop what markdown and CSV cannot hold**: database views and formulas, comments,
  version history. Formula columns are left out of the CSV.
- **HTML tables with merged cells** (`colspan`/`rowspan`) from paste lose the merge.
- **Backups are built in memory** as one JSON string (limit 2 GB); a streaming format would suit
  very large workspaces.
- **The Notion fixture is flatter than real exports** on disk: Windows' path length limit broke
  git checkouts of the deepest folders, so the test builds a deep `Stage one → four` chain inside
  a generated zip instead.
- **Downloads and printing in the desktop app** go through the `fileSaver` service (#30): the
  browser stub downloads through a link and prints with `window.print()`; the desktop app saves
  through the native save dialog (`file_save`) and prints through the webview (`window_print`).
- In this branch the editor does not exist yet, so an imported page's body shows the shell's
  placeholder; the imported content is visible in the print view (Export → PDF).

## Follow-ups for the merge (cross-agent wiring you couldn't finish alone)

- **Architect / core:** apply CCR 1 (`createPages`), then switch `applyPlan` to it (a small,
  local change in `packages/importers/src/apply.ts`). Optional CCR 2.
- **Architect / shell:** the bare layout's `#main` is a full-height scroll container, which would
  print only one screen; the print view overrides it with an `@media print` rule. The shell could
  own that rule for every bare route.
- **Agent 02 (editor):** paste should call `ctx.services.markdownCodec.parseHTML(html)` (and
  `parse` for plain-text markdown). The editor's page menu can offer "Export…" with
  `ctx.commands.execute(COMMANDS.openExport, { args: { pageId } })`. `embed` nodes of kind `file`
  and `web` and the `tessera-embed` fences are what imports produce.
- **Agent 03 (sync):** implement `AssetStore.getInfo` in the IndexedDB and server stores: exports
  use it to keep attachments' original file names. Backup restore relies on the doc store
  persisting non-local updates (the DocManager does today).
- **Agent 05 (search):** the palette gets "Import…" and "Export…" (group `workspace`). The search
  index sees imported pages through `doc.changed` events (non-local).
- **Agent 07 (desktop):** the markdown mirror can use `ctx.exporters.get('markdown')` (or
  `'markdown-basic'`, the same exporter) with a folder `ExportSink`. In Tauri, replace the
  `<a download>` save with a native save dialog if the webview ignores downloads, and check that
  `window.print()` opens the system print dialog for the PDF export.
- **Agent 10 (docs):** `examples/demo-workspace` is picked up automatically: "Open the demo
  workspace" imports its `.md` and `.csv` files (and images or PDFs, fetched by URL) with the
  markdown importer, then opens the first top-level page named "Start here", "Welcome" or
  "README". Stay within what `packages/importers/demo` uses. My bundled demo can then be deleted.
  Screenshot names are listed below.
- **Agent 09 (CI):** `pnpm test:e2e e2e/importers` includes a 2,000-note import per browser
  (`test.slow()`); the Node benchmark takes `TESSERA_IMPORT_BENCH_NOTES` for a nightly 2,000-note
  run.

## Timing: a 2,000-file vault

| Where | Total | Longest main-thread gap | Notes |
| --- | --- | --- | --- |
| Chromium (e2e, 2,000 notes in a zip, one test at a time) | 17.4 s | 147 ms | reading → planning in the worker → pages → content, all shown by the progress dialog |
| Firefox (e2e, same) | 41.2 s | 114 ms | up to 97 s (gap 263 ms) when six browser tests ran at once on this machine |
| Both, final run on a quieter machine (`pnpm test:e2e e2e/importers`) | Chromium 16.2 s, Firefox 19.1 s | 157 ms, 96 ms | the other worktrees' agents load this machine unevenly, hence the spread |
| Node (`TESSERA_IMPORT_BENCH_NOTES=2000`, planning inline) | 36.8 s | CPU between yields: pages 32 ms, content 16 ms | reading 0.2 s, planning 16.3 s, pages 11.8 s, content 6.4 s |

Before the M4 fixes the same Chromium import blocked the main thread for about 5 s (no progress
rendered after planning) and bumped every page's updated time.

## Screenshots (list of files)

In `assets/screenshots/importers/`, 1440×900, each as `-light.png` and `-dark.png`:

- `import-dialog`: the import dialog after picking a vault (detected source, preview, root page).
- `import-progress`: a 1,500-note vault importing ("Creating pages", count, current file).
- `import-report`: the report (counts, grouped issues with links to pages).
- `export-dialog`: the export dialog on a page (formats, scope, link style).
- Extras: `print-view` (the PDF export's print view), `settings` (Settings → Import & export),
  `onboarding` (first run with the import and demo actions), `import-phone` (the import dialog
  at 390×844).
