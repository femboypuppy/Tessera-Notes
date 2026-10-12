# Integration handoff

Agent 11 (the Architect again), on `main`. This file is the merge plan, the verdict on every
contract change request, every cross-agent follow-up and what became of it, and at the end
everything deferred and every known bug, each written as a ready-to-file GitHub issue.

## Plan

### History: replaying the branches onto the rewritten `main`

`main` was rewritten (author emails) after the feature branches were cut, so the `feat/*` branches
share no commit with it, although their starting trees are identical. Nothing is merged with
`--allow-unrelated-histories`. Instead each branch's own commits are replayed onto `main` in a new
local branch `rebased/<area>` with `git cherry-pick`, and `main` merges that branch with
`git merge --no-ff`. The `feat/*` branches and their worktrees are left untouched (the project's
`.claude/settings.json` denies `git rebase`, and nothing here needs to rewrite them).

| Branch | Old base | Commits replayed | Notes |
|---|---|---|---|
| `feat/ci` | `a30f580` (old "license" commit = `main`'s `ffde8e0`, same tree) | 12 | Skipped `3a846f7`, an `ours` merge of the rewritten `main` with no file changes (it would have brought the old-email history back). |
| `feat/sync`, `editor`, `search`, `databases`, `plugins`, `desktop` | `312265a` (old "SPEC and handoffs" = `ff8a7bf`) | 17, 18, 16, 11, 11, 7 | `main` adds only `ffde8e0` (LICENSE, `HANDOFF/architect.md`), which none of them touch. |
| `feat/importers`, `feat/docs` | `a30f580` | 10, 8 | |

Every replayed tree equals its `feat/*` tree (`git diff feat/<area> rebased/<area>` is empty), and
every replayed commit has the author email `276110381+femboypuppy@users.noreply.github.com` (none
had the old `12345678+…` address; the only such commits are the old base's, which are not replayed).

### Merge order

The suggested order holds; the handoffs give no reason to change it:

1. `feat/ci`: the testkit, journeys and CI scripts, so every later merge runs through them.
2. `feat/sync`: persistence, which reloading journeys and every later e2e depend on.
3. `feat/editor`: page bodies, which search, databases, plugins and importers exercise.
4. `feat/importers`: the real markdown codec (editor paste and copy, plugin READMEs).
5. `feat/search`, 6. `feat/databases`, 7. `feat/plugins`, 8. `feat/desktop`, 9. `feat/docs`.

After each merge: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`,
the app itself and the branch's screenshots, root causes fixed before the next merge.

## Contract change requests

Applied first, in one commit (`feat(core): apply the approved contract change requests`), with
`SPEC.md` updated (sections 4.3, 4.5, 6.2 to 6.5, 7, 8 and 13.3).

| # | From | Request | Verdict |
|---|---|---|---|
| 1 | sync | `SyncStatusInfo.readOnly`, and read-only pages for viewers in the shell | **Approved.** The shell's `useViewOnly()` makes the page, title, page menu, favorites, the page tree (drag, moves, row menus) and "New page" read-only, and hides `shell.newPage`; the server already refuses a viewer's updates. |
| 2 | sync | Optional `AssetStore.retainUrl` | **Approved** as proposed (optional, so no store breaks). |
| 3 | sync | `DocStore.storeUpdate(…, { remote })` so remote-only docs skip a background handshake | **Rejected.** `transaction.local` is false for more than server updates: importers and backup restore write with `Y.applyUpdate`, which is not local either, so their docs would never be marked dirty and would not reach the server when imported offline. The workaround is one extra, cheap state-vector handshake. |
| 4 | importers | `createPages(ws, inputs)`: many pages with one page index | **Approved, merged with databases' #6** into one helper: each input has its own `parentId` (an existing page or an earlier input, so no cycle can form), pages go after their parent's existing children, and every input is validated before the first write (the proposal validated inside the loop, which could leave half a batch behind). |
| 5 | importers | Quieter replacement of core's stub importer and exporter | **Approved** as `register(item, { replaceable: true })`: core registers `markdown-basic` that way, replacing it logs nothing, and unregistering the replacement brings the stub back. |
| 6 | databases | `createPages`, `addRows`, `checkRowValues`, `WorkspaceApi.addDatabaseRows` | **Approved** (with #4's `createPages`). `addRows` also refuses duplicate IDs within one call and an unknown `after` row, and falls back to appending when neighbours are tied. |
| 7 | search | `SearchHit.heading` and `SearchHit.blockId` | **Approved** as proposed (optional fields). |
| 8 | search | `Backlink.blockId` | **Approved** as proposed (required, `string \| null`; core's naive index fills it). |
| 9 | desktop | A `credentialStore` app service (keychain on the desktop) | **Approved** with `MemoryCredentialStore` as the stub and `credentialKey()` (origin normalization). Also exposed to storage services through `context.app.credentialStore`. |
| 10 | desktop | `workspaceMenuItems` contribution in the sidebar's workspace menu | **Approved** as proposed; errors from `run` become a toast. |
| 11 | desktop | `@source '../../desktop/src/**/*.{ts,tsx}'` in `apps/web/src/styles.css` | **Approved.** |

Architect-owned follow-ups done in the same pass, because they are shell changes other agents
asked for: `Suspense` around `pageTopSections` and `pageFooterSections` (search), and
`/p/<id>#block-<blockId>` or `#<heading-slug>` URLs as scroll targets (editor's "Copy link").

## Merge log

How each merge was checked on this machine (Windows 11, i5-10400F 6 cores/12 threads, shared
with a VMware VM and desktop apps that keep the CPU near 100% before any test starts). Unit tests:
`pnpm test`. End to end: Chromium with two workers and Firefox with one (the CI setting is two
workers per browser on dedicated runners; here, two parallel Firefox workers starve each other past
the 45 s test timeout). A failure is re-run alone before it counts as fixed or flaky.

| Merge | Adapted at the merge | Unit | e2e |
|---|---|---|---|
| `feat/ci` | Root `prepare` (git hooks), `.lighthouseci/` ignored, WCAG AA contrast tokens, Avatar text by contrast, focusable ScrollArea, empty accessibility baseline, SECURITY.md contact | 407 passed | 66 passed, 22 skipped (journeys waiting for features) |
| `feat/sync` | Credentials on core's `credentialStore` service (IndexedDB store at 50); the sync e2e server fixture gets its own 120 s budget | 531 passed | Chromium all passed; Firefox passes with one worker |
| `feat/editor` | Journey 08 runs for real: helpers follow the real Sync & account UI, Bob opens the invite link; the testkit server on `localhost` with the app's origin allowed (the Lax cookie is never sent to 127.0.0.1); seeded-harness fixture budget and warm-up; Firefox typing guard (24 ms); EmojiPicker query by label; test timeouts for busy machines | 682 passed | Chromium 60 + Firefox 60 passed after the fixes (9 skipped each, waiting for search, databases, importers) |
| `feat/importers` | `applyPlan` creates pages with `createPages` in batches of 200 and rows with `addRows` (the 2,000-note import's page phase: 11.8 s → 0.17 s); the shell prints bare routes on as many sheets as needed (the print view's override is gone); `serialize(…, { keepBlockId })`: the markdown export writes only block IDs a link points at, the editor's copy none (every editor block has an ID, so exports had ` ^id` on nearly every line); the clipboard spec starts each paste on a top-level line (with the real codec a pasted list kept the caret in it) and checks the plain flavor is markdown; journey 05 checks the report's real totals | 792 passed | Chromium 66 + Firefox 66 passed, 8 skipped each |
| `feat/search` | Search's rich hit and backlink types extend core's new fields instead of repeating them; the background replicator reports docs it pulled while closed (`onPulled`) and the sync feature re-indexes them with `searchIndex.upsert` (otherwise a collaborator's edit to a page this device never opened could stay stale in search and backlinks); journeys 03 and 06 run for real: 03 types its tag the way a person does (a space after it converts `#space`), 06 picks the export format and scope by their exact names (the backup format's description also says "workspace") | 866 passed | Chromium 83 passed + the two fixed journeys re-run; Firefox 85 passed; 1 skipped each (journey 04, waiting for databases) |
| `feat/databases` | `addRowsInBulk` is core's `checkRowValues` + `createPages` + `addRows` (the local workaround is gone; 10,000 five-column rows in about a second); `addRows` validates once; new databases focus their title even when the home view opened them first (with IndexedDB the database doc loads across a render, and the home view's "open the first page" won the race, so the title never got focus: seven specs failed); the inline-database spec always runs (its editor skip became an assertion); journey 04 uses the grid's own "New" row, names a property after picking its type, and opens a card's row page from the side peek; SPEC: formulas ship | 1082 passed | Chromium 95 passed (a first run hung at the perf spec overnight, then passed); Firefox: every databases spec and the first 64 passed, full re-run below |
| `feat/plugins` | **Plugins couldn't start in any self-hosted app**: plugin frames are `srcdoc` documents, which inherit the app's CSP (`script-src 'self'` from the server), so their nonce'd bootstrap never ran ("took too long to start"). The server now sends a fresh nonce per `index.html` response (`script-src 'self' 'nonce-…' blob:`, `font-src … blob:`) and writes it into `<meta property="csp-nonce">`; the plugin host reuses the app's nonce; the placeholder is Tauri's own nonce token, so the desktop app fills it the same way; the inner UI frame removes its bootstrap and policy text before plugin code loads, so a plugin can't read the nonce. The malicious fixture plugin (`e2e/plugins/fixtures/escape`, 20 probes from the worker and the panel, plus navigations; every request to the attacker's origin is recorded) runs under the preview server and under the server's CSP (`e2e/plugins/served.spec.ts`). `pages.get` markdown keeps only linked block IDs (Word count counted ` ^id` as a word). The plugin specs open panels from the top bar's "Panels" menu (more than three panels collapse into it), and the Mermaid and Word count specs use the real slash menu and editor. Also found by this merge's runs: the app's zod chunk probed `eval` (a CSP violation under the server's policy), so zod runs `jitless` everywhere (`apps/web/src/zod-config.ts`); a markdown round-trip bug (`\@`, `\:`, `\.` at the end of a text lost a backslash, found by the property test) is fixed with a regression test; `pnpm dev` now runs the server too, behind Vite's `/api` and `/sync` proxy; Firefox's test budget is 90 s (the same steps run two to three times slower there on this machine) | 1288 tests: 1286 passed, then the two failures fixed (the round-trip bug; a db-views property test at 8 s against the 5 s default, now 15 s); the server project's forked worker aborted (0xC0000409) in the full run, and passes alone (77), see the known issues | Plugins: Chromium 12/12, Firefox 12/12 (after the 90 s budget). Full Chromium: 105 passed; the three timing specs (10,000-row scroll at 33 ms frames, typing latency with one keystroke coalesced, a 5,000-page cold start of 17.7 s against 15 s) failed under the full parallel load and passed alone (typing p95 9.9 ms) |
| `feat/desktop` | The keychain is core's `credentialStore` on the desktop (priority 100; sync signs in and reconnects with it, Settings → Desktop lists and signs out through it); "Open folder…" and "Open workspace…" in the sidebar's workspace menu; the package's own stylesheet is gone (the web stylesheet scans `apps/desktop/src`); a folder workspace is "removed from the list" (not deleted) in Settings; the Tauri CSP allows `blob:` scripts and fonts for plugins, and Tauri fills the page's nonce token; the image sets `WEB_DIR`; **the server stopped only after 30 s when a peer never answered the WebSocket close frame** (ws's close timeout held the HTTP server open, past `docker stop`'s grace period): peers get 1 s, then are cut off, with a test; the container smoke test follows the real server (`create-owner --password-stdin`, `/api/auth/setup` with the logged setup code, `<workspace>/ws:<id>` doc names) and passes without `--allow-stub`; the real-app smoke test checks the keychain service and runs a nonce'd `srcdoc` bootstrap that loads a `blob:` module under Tauri's CSP (and its path argument works); the testkit can target a running server (`TESSERA_E2E_SERVER_URL`), which is how two people collaborated on the `docker compose up` stack; e2e for the native Undo/Redo menu items and the workspace menu | Desktop 75, web features 12, server 78 (with the new shutdown test), Rust 45 | Desktop: Chromium 10/10, Firefox 10/10 (one re-run alone); architect shell 12/12. Real Windows app (`smoke-app.mjs`): PASS. Container (`smoke-test.mjs --build`): PASS. `docker compose up` + journey 9 (two people typing in one page, live) against it: PASS |
| `feat/docs` | The final logo: favicon (`.svg`, `.ico`), touch icon and the sidebar mark from `assets/brand`, the desktop icons regenerated from it; the README's feature table swapped for the merge showcase (every image exists, `e2e/docs` checks it); plugin docs link repo files by URL (the docs build failed on four dead links); "Open demo workspace" imports `examples/demo-workspace` only (the importers' bundled demo is gone) and a test checks it imports with no issues: every one of its 200+ links resolves, images land in the asset store, both databases are typed; the demo's `[[Meeting notes]]` pointed at a folder (now a folder note) and "Every block type" promised an embedded note, which imports as a link (now an embedded database, which Tessera has); docs checked against the code (shortcuts, slash items, settings labels, sync statuses, server configuration and CLI, backup format, release file names, `pnpm dev`, the desktop's "Markdown copy") and corrected; every screenshot regenerated with the editor and all features (the shell, desktop and presence pictures now show real content and a live remote caret) | Importers 62 (with the new demo tests), docs checks 19 | `e2e/docs` 23/23; docs site builds with no dead links; full runs below |

## Follow-ups from the handoffs

✅ done (with where), ➡️ deferred (an issue below).

### Architect / shell
- Read-only for viewers (sync CCR 1). ✅ `useViewOnly()`; `App.test.tsx` › "makes pages read-only
  for viewers".
- `Suspense` for lazy page sections (search). ✅
- Block and heading links from the URL hash (editor). ✅ `bridge.ts` `targetFromHash`, with tests.
- Test timeouts for the jsdom tests (ci, sync, editor, search, desktop). ✅ 15 s for `ui`, `web`,
  `core`, `editor` and `db-views`, 20 s for the testkit (measured: one `getAllByRole` over the
  emoji picker's ~1,870 buttons takes 9.9 s in jsdom; nothing hangs).
- Root `prepare` (git hooks), `.lighthouseci/` ignored, contrast tokens, focusable ScrollArea,
  empty accessibility baseline (ci). ✅ With the CI merge.
- Print rule for bare routes (importers). ✅ `AppLayout.tsx` (`print:h-auto print:overflow-visible`).
- Desktop wording for "Delete workspace". ✅ "Remove from the list" for folder workspaces;
  `App.test.tsx` › "removes a folder workspace from the list instead of deleting it".
- Final logo and favicon (docs). ✅
- Service worker for offline cold starts (sync). ✅ `apps/web/service-worker.js` (built to
  `/sw.js`) and `apps/web/src/offline.ts`; `e2e/architect/offline.spec.ts` (Chromium and Firefox):
  after one visit, offline, the app, the page tree, the editor and the page's text load and stay
  editable.

### Sync (03)
- Remote cursors in the editor, checked with two browsers against the real server. ✅ Journey 9
  (`e2e/journeys/09-live-collaboration.spec.ts`), also against `docker compose up`; the presence
  screenshot shows the labeled caret.
- History previews with the editor instead of `DocPreview`. ✅ The `docViewers` contribution
  (`@tessera/editor/doc-viewer`) in `VersionContent`; `ui.test.tsx` › "version previews".
- Desktop tokens in the keychain. ✅ The `credentialStore` service `keychain` (priority 100); the
  real-app smoke test checks it.
- The server's CSP against plugin frames. ✅ See the plugins merge.
- The Tauri doc store with the replicator's transactional dirty flag. ➡️ Issue "Desktop: a
  transactional dirty flag in the SQLite doc store".
- Nightly load test (`pnpm --filter @tessera/server load-test`). ➡️ Issue "CI: nightly
  performance and load jobs".
- Screenshots retaken with the editor. ✅

### Editor (02)
- Clipboard with the real codec (lists, tasks, quotes, code, marks). ✅ `e2e/editor/clipboard.spec.ts`
  (its stub-codec branches are gone).
- Plugin and database blocks in the slash menu. ✅ `e2e/plugins/plugins.spec.ts` › Mermaid and
  `e2e/databases/inline.spec.ts`.
- Tag clicks run search with `#tag`. ✅ The search command takes `args.query`.
- "Copy link" hash → `target.blockId`. ✅
- Upstream y-tiptap work. ➡️ Issues "Firefox typing latency…" and "Undo or redo can desync…".
- The Firefox typing budget, measured but not enforced (owner note). ✅ Profiled: y-tiptap's
  selection mapping (4.5 ms per keystroke) and undo state (1.2 ms); the editor's own plugins take
  under 0.3 ms. `performance.spec.ts` enforces < 16 ms p95 in Chromium and < 24 ms in Firefox
  (SPEC.md §10).

### Importers (08)
- `createPages` and `addRows` in `applyPlan`. ✅ The 2,000-note page phase went from 11.8 s to
  0.17 s.
- Paste through the codec; "Export…" in the top bar and the palette. ✅
- `AssetStore.getInfo` in the IndexedDB and server stores. ✅ Both implement it, and the desktop's.
- The desktop mirror through the exporter. ✅ `MIRROR_EXPORTERS` picks `markdown`; Settings →
  Desktop shows "Updated now · 7 files" in the screenshot run.
- Downloads and printing inside the desktop webview. ✅ In 0.1.3 (#30), through the `fileSaver`
  service: the native save dialog and the webview's own print.
- "Open demo workspace" from `examples/demo-workspace`; the bundled demo deleted. ✅ `demo.test.ts`
  (no import issues, 200+ links resolve, images in the asset store, typed databases).
- Nightly 2,000-note benchmark. ➡️ Issue "CI: nightly performance and load jobs".

### Search (05)
- Collaborators' edits pulled in the background get re-indexed. ✅ `onPulled` →
  `searchIndex.upsert`.
- Database row values indexed. ✅ And fixed: a batch holding pages and databases detached the
  databases' buffers, so they went unindexed (`services.test.ts` › "indexes pages and databases
  read in the same batch", through a `postMessage`-like transport).
- `perf.config.ts` and the search bench in CI. ➡️ Issue "CI: nightly performance and load jobs".

### Databases (04)
- The inline database e2e runs. ✅ Its skip became an assertion.
- `addRowsInBulk` on core's helpers. ✅
- The query engine's 95% coverage gate in CI. ✅ A new step in `ci.yml` (98.7% lines, 95.9%
  branches).
- Plugin database queries with the views' engine. ➡️ Issue "Plugin API: database queries with
  date ranges and relative dates".

### Plugins (06)
- The slash-menu path end to end, and live Word count while typing. ✅
- The malicious test plugin (owner note). ✅ `e2e/plugins/fixtures/escape` (20 probes; it stays in
  the test suite), `sandbox.spec.ts` and `served.spec.ts` › "a malicious plugin reaches nothing
  outside its sandbox" (preview and server CSP, Chromium and Firefox).
- CSP for self-hosting and the desktop. ✅ A per-response nonce, Tauri's nonce token, `blob:`.
- Publish the registry, the example zips and the npm packages. ➡️ Owner checklist (release).
- Plugin docs in the docs sidebar. ✅ Listed from `docs/plugins`, no dead links.

### Desktop (07)
- The CCRs (credential store, workspace menu items, stylesheet). ✅
- The container smoke test without `--allow-stub`. ✅ `node deploy/smoke/smoke-test.mjs --build`:
  PASS.
- Undo and Redo from the native menu reach the editor. ✅ `desktop.spec.ts` › "Edit → Undo and
  Redo…".
- Plugin iframes and workers in the desktop app. ✅ `smoke-app.mjs` › "plugin sandboxes run under
  the app CSP".
- Desktop icons from the final logo. ✅

### Docs (10)
- The README showcase, the logo swap, the demo workspace checks, plugin docs, CONTRIBUTING
  commands, server configuration and self-hosting pages checked against the code. ✅
- Owner tasks before launch. ➡️ The checklist at the end.

### CI (09)
- The journeys' `requireFeatures` guards removed. ✅ They became `expectFeatures`, which fails and
  never skips.
- Benchmarks after the merge. ✅ Below.
- `assets/screenshots/ci` retaken. ✅
- Workflows that only run on GitHub. ➡️ Checked with actionlint; the first GitHub run confirms.

### Owner notes for this merge
- History replayed with cherry-picks, no `--allow-unrelated-histories`, author emails checked. ✅
- The approved contract changes applied first. ✅
- The malicious test plugin, as a test fixture. ✅
- Tests that skipped without the editor now run for real. ✅
- The README screenshot table swapped once every image existed; `femboypuppy@tutanota.de` in
  `SECURITY.md`. ✅
- EmojiPicker and `App.test.tsx`: they still passed 5 s alone on this machine, so their timeouts
  were raised as the handoffs suggested. ✅
- The Firefox typing-latency budget. ✅

## Cross-feature wiring (agents/11-merge.md)

| Flow | How it's wired | Checked by |
|---|---|---|
| Collaboration cursors | The editor's remote cursors from the sync provider's awareness | Journey 9 in two browsers, also on `docker compose up` |
| Copy and paste through the codec | Editor clipboard → `markdownCodec` (remark), `keepBlockId: () => false` | `e2e/editor/clipboard.spec.ts` |
| Search indexing of database rows | Row values from the database doc; background pulls re-indexed | `services.test.ts`, journey 3 |
| Inline databases | `embed` of kind `database` through the block registry | `e2e/databases/inline.spec.ts` |
| Plugin blocks in the slash menu | Registered block kinds become slash items | `plugins.spec.ts` › Mermaid |
| Importers writing to the asset store | Attachments go to `assetStore`, image nodes get an `assetId` | `demo.test.ts`, `e2e/importers` |
| Desktop mirror through the exporter | The `markdown` exporter into a folder sink | Desktop e2e, Settings → Desktop |
| "Open demo workspace" | The markdown importer over `examples/demo-workspace` | `demo.test.ts`, the importers screenshots |
| History preview with the editor | The `docViewers` contribution | `ui.test.tsx`, `doc-viewer.test.tsx` |
| Plugin docs in the docs sidebar | `docs/.vitepress/config.mts` lists `docs/plugins` | `pnpm --dir docs build` |

## Integration work

- **Every stub replaced.** With every feature registered, the app resolves `workspaceRegistry`
  (IndexedDB; `tauri-folders` on the desktop), `markdownCodec` `remark`, `credentialStore`
  (`indexeddb`; `keychain`), `docStore` and `assetStore` (IndexedDB; `tauri-sqlite` and
  `tauri-files`), `syncProvider`, `searchIndex` `minisearch` and `linkIndex` `graph`. The real-app
  smoke test prints them, and `e2e/architect/shell.spec.ts` checks the list.
- **Journeys** all run for real, none skipped; journey 9 (two people typing in one page) is new.
- **`pnpm dev`** runs the web app and the server; the app reaches the server through Vite's `/api`
  and `/sync` proxy. Checked on a fresh clone: `pnpm install && pnpm dev`, then journey 9 against
  it (`TESSERA_E2E_SERVER_URL=http://localhost:5173` with the setup code the dev server logged):
  two people typing in one page, live. PASS. (The journey's server-address helper now waits out the
  app's own pre-fill of the address field, which could land in the middle of typing.)
- **`pnpm build`** builds every package, the web app, the server and the desktop app
  (`scripts/build-desktop.mjs`: `tauri build --no-bundle`, when Rust is installed).
- **`docker compose up`** (the repository's `docker-compose.yml`, built from this checkout): the
  server serves the app. With `TESSERA_E2E_SERVER_URL=http://localhost:8787`, journey 9 ran against
  it: two browsers and two accounts (the owner created with the logged setup code, the second
  through an invite link), both typing in one page and seeing each other live. PASS.
- **Dead code removed:** the importers' bundled demo, the desktop's own stylesheet, the clipboard
  spec's stub-codec branches, the journeys' skip guards, stale "until the storage feature lands"
  comments.
- **SPEC.md and CLAUDE.md** updated: the CSP and its nonce, offline, validation, the e2e
  environment, `pnpm dev` and `pnpm build`, the contract changes and the budgets.

## Security review

| Area | What was checked | Evidence |
|---|---|---|
| Authentication | argon2id hashes; httpOnly SameSite=Lax cookies, Secure over https; bearer tokens only for the desktop, kept in the OS keychain; rate limits on setup, sign-up and login; CSRF: a cookie-authenticated write must come from an allowed origin; sessions expire, and revoking one closes its sockets; viewers are read-only on the server, even for hand-crafted messages | `apps/server/src/http/auth.test.ts`, `sync/sync.test.ts` |
| Plugin sandbox | `sandbox="allow-scripts"` frames without `allow-same-origin`, a strict CSP per frame, nested UI frames against navigation, host-side permission checks and schema validation. A hostile fixture plugin probes the app document, the top window, cookies, storage, IndexedDB, fetch, beacons, images, scripts, WebSockets, `importScripts`, `eval`, popups, forged messages, the CSP nonce and navigations: all blocked, and no request reaches the attacker's origin | `e2e/plugins/sandbox.spec.ts`, `served.spec.ts`, `host.test.ts`, `endpoint.test.ts` |
| CSP | The server's policy: `script-src 'self' 'nonce-…' blob:` with a fresh nonce per page, no `unsafe-inline` scripts, no `eval` (zod runs jitless), `frame-ancestors 'none'`. The desktop's is the same, with Tauri's nonce | `auth.test.ts` › "serves the web app with a CSP…", `served.spec.ts` (no CSP violation) |
| XSS through import, paste and embeds | HTML is sanitized (DOMPurify) and simplified, unsafe links and images are dropped, embeds come only from allowlisted providers, plugin READMEs are sanitized | `markdown/src/html/parse-html.test.ts`, `codec.test.ts`, `editor/src/clipboard/clipboard.test.ts` and the clipboard e2e's `__pwned` trap, `embeds/providers.test.ts`, `ReadmeView.test.tsx`, `sync/src/ui/ui.test.tsx` |
| Path traversal | The static server, asset routes, backup and restore archives, import paths | `auth.test.ts` (four traversal attempts), `assets.test.ts`, `cli/backup.test.ts`, `importers.test.ts` |
| Upload limits | Declared and chunked uploads over `MAX_UPLOAD_MB` answer 413 | `assets/assets.test.ts` |
| Dependencies | `pnpm audit --prod`: no known vulnerabilities. `pnpm audit`: two advisories in `lodash-es` ≤ 4.17.23 (through mermaid, in the Mermaid example plugin), fixed with an override to 4.18.1. The docs site's VitePress 1.6.4 brings Vite 5 advisories that affect its dev server only | `pnpm audit` |

## Benchmarks

`pnpm exec tsx scripts/bench/run.ts --runs 3` (the seeded harness, headless Chromium, this machine):

| Benchmark | Result | Budget |
|---|---|---|
| Cold start, 5,000 pages → interactive sidebar | 1,090 ms | < 2,000 ms ✅ |
| Search, 5,000 pages: query p95 | 14.4 ms | < 50 ms ✅ |
| Command palette: keystroke → results p95 | 15.4 ms | < 50 ms ✅ |
| Open a 2,000-block page | 1,284 ms | – |
| Typing, keystroke → next frame p95 (end to end) | 46 ms | Reported only. The budget is the editor's processing: 9.9 ms p95, enforced by `e2e/editor/performance.spec.ts` ✅ |
| Graph view, 5,000 pages: frame time p95 | 415 ms | < 33.4 ms ❌ Headless software rendering (see the issue) |
| Import 2,000 files: longest main-thread block | 129 ms (222 ms before) | < 100 ms ❌ The dev-mode harness (see the issue) |

The owners' browser checks on a production build (`pnpm exec playwright test -c
e2e/search/perf.config.ts`, GPU flags): the graph with 10,000 nodes pans and hovers at p95 16.8 ms
frames once laid out ✅ (during layout, one run measured p95 100 ms); the bench's graph row is its
dev-mode, headless harness (102 ms p95 with `--headed`, 415 ms without a GPU).

**A regression found and fixed:** the palette's keystroke latency on 5,000 pages was p95 95–100 ms
right after the pages were created, against 26.8 ms before the merge. Every local page edit
scheduled its own `updatedAt` touch, one workspace transaction per page, and each rebuilt the page
index and re-rendered the page tree: O(pages²) of work that kept the main thread busy for tens of
seconds after any bulk write (an import too). The touches of a burst now share one transaction
(`createBatchDebouncer` in core, with tests): the palette measured p95 30.4, 33.4 and 44.8 ms
(one run at 58.8 ms while an orphaned full-disk `find` loaded the machine), and seeding 5,000 pages
through the app went from 161 s to 53 s.

Found on the way: in the dev harness the import worker never started (its DOM shim broke a browser
check in `prosemirror-view`, which the dev server loads), so imports were planned on the main
thread in dev. That is fixed; production was fine (checked by wrapping `Worker` in a production
build). Pages are now created 50 per batch.

## Final verification

On `main` at `ea14918` (the last code change, `244666f`), on this machine:

| Check | Result |
|---|---|
| `pnpm typecheck` | every package and app, exit 0 |
| `pnpm lint` | ESLint with no warnings, Prettier clean, exit 0 |
| `pnpm test` | 160 files, 1,371 tests passed |
| `pnpm test:e2e`, Chromium (2 workers) | 142 passed |
| `pnpm test:e2e`, Firefox (1 worker) | 141 passed, 1 skipped (the 10,000-row frame timing, Chromium-only by design) |
| `node scripts/ci/actionlint.ts` | every workflow valid (shellcheck not installed here) |
| `pnpm build` | every package, the web app, the server and the desktop app (release) |
| `pnpm --dir docs build` | builds, no dead links, 19 checks passed |
| Container smoke test, `docker compose up` + journey 9 | PASS, PASS |
| Fresh clone: `pnpm install && pnpm dev` + journey 9 | PASS |
| Real desktop app (`smoke-app.mjs`) | PASS |
| Rust (`cargo test`) | 45 passed |

## First CI runs on GitHub

The first run on GitHub's Linux runners (`b82827a`) failed on things this Windows machine couldn't
show. Each was reproduced in a Linux container (`mcr.microsoft.com/playwright:v1.63.0-noble`,
Xvfb, `CI=true`) and fixed at its cause; no budget, timeout or assertion was loosened.

- **Startup JS 265.7 kB of 250 kB.** Three things reached the entry chunk: zod (through
  `zod-config.ts`, which now sets zod's shared `globalThis.__zod_globalConfig` without importing
  it), Radix Select, Checkbox, Switch, RadioGroup, Tabs and ScrollArea (all in `forms.tsx`, now one
  module each in `packages/ui/src/components/`), and the full string tables of the editor, search
  and plugins (the feature registrations now import only the strings startup uses, from
  `<package>/i18n/registration`, tested to match `en.ts`). Now 244.8 kB.
- **`demo.test.ts` ENOENT.** The fetch stub stripped `/@fs/` and with it the leading `/` of POSIX
  paths; it now maps URLs to files with `URL` and `fileURLToPath`.
- **Version history order.** Versions saved in the same millisecond sorted arbitrarily: each
  version now carries a per-device save sequence (`seq`, `newestFirst` in `version-store.ts`),
  and the server orders by `created_at DESC, rowid DESC`.
- **Graph specs without a GPU.** Headless Firefox on Linux has no WebGL at all. The graph now
  shows a proper fallback without WebGL or after a lost context (why, how to turn it on, Try
  again, and the most connected pages as a keyboard-friendly list; `graph-fallback.tsx`, specs
  under "without WebGL"). On Linux CI, the specs that draw the graph (`e2e/search/graph.spec.ts`,
  `e2e/ci/accessibility-graph.spec.ts`) `test.use(softwareWebGL)` (`e2e/support/webgl.ts`), which
  runs Firefox headed under `xvfb-run` (Mesa llvmpipe), so the WebGL specs really run; the other
  Firefox specs stay headless (headed, the 2,000-block typing latency went over its budget).
  Chromium needs nothing: Playwright passes `--enable-unsafe-swiftshader`, so WebGL falls back to
  SwiftShader by itself. Forcing it with `--use-angle=swiftshader` put all of Chromium's drawing
  through SwiftShader: the 10,000-row table scrolled at 30 fps instead of 60, the graph specs ran
  twice as slow, and a first local graph could stall 7 s.
  The flaky node click came from `useGraphLayout` reporting "settled" before the layout had
  started; it now tracks which graph and settings the finished layout belongs to.
- **Backspace spec (`markdown-shortcuts.spec.ts:107`) on a busy runner.** Not a Linux behavior:
  the browser reports End's caret move with a `selectionchange` event that comes after the key,
  and on a busy main thread Chromium runs the next key (Enter) first, so Enter split the line at
  the old caret. That can happen to a person on a busy page too. `LiveSelection`
  (`packages/editor/src/extensions/live-selection.ts`) checks the DOM selection before any key
  command and lets ProseMirror read it first; unit and e2e tests reproduce the race
  deterministically and fail without it.
- **Markdown round trip property** (found in the container, a random seed): a code span across
  lines kept its line ending, so a heading holding one was written setext once and ATX the next
  time. Line endings in code spans now become spaces, as CommonMark specifies.
- **Palette: Enter opened the wrong page** (flaky `palette.spec.ts:19`). When the index changed
  while the palette was open (a page created a moment before), the same query ran again, and an
  Enter pressed meanwhile waited for it and then opened the *first* result, not the one chosen
  with the arrows. Enter now waits only when the list shows an older text's results.
- **Journeys 8 and 9 hung in Firefox** at `page.goto(invite)`: the page had loaded and rendered,
  but Playwright never heard of the navigation. The Tessera server sends
  `Cross-Origin-Opener-Policy: same-origin`, so opening it from a blank tab makes Firefox swap
  the browsing context, and Playwright 1.63's Firefox driver can lose a message then
  (microsoft/playwright#42731, fixed in 1.64, still an alpha). The Firefox project sets
  `browser.tabs.remote.useCrossOriginOpenerPolicy: false` (checked in the container: without it a
  COOP navigation clears `window.name`, with it the tab keeps its context). The app and the
  server keep COOP. ✅ Playwright 1.64 fixed it, and the pref is gone since 0.1.3 (#35).
- **Timed specs measured the runner.** The 10,000-row table spec scrolled at 60 fps on one run
  and 30 fps on the next with the same code, and the 2,000-block typing p95 swung between 7 and
  25 ms in one run. A scrolled frame of that table costs about 33 ms of CPU across Chromium's
  threads (profiled in the container: software compositing alone takes about 12.5 ms), so two
  browsers on a four-core runner compete for every core. The specs that time frames and
  keystrokes are tagged `@perf` and CI runs them after the rest, one at a time ("Playwright,
  timed specs alone"); their budgets and assertions are unchanged. Locally:
  `pnpm test:e2e --grep @perf --workers=1`.
- **Frozen columns stick only when the table can scroll sideways.** Each sticky cell is a
  compositor layer, two in every row (153 layers for 33 rows); a table that fits its scroller
  now skips them (`data-scrolls-x` on the grid, `STICKY`/`FROZEN` in `table/layout.ts`), which
  took about 3 ms off the main thread per scrolled frame. `table.spec.ts` covers both cases.

## Known bugs and deferred work (ready-to-file issues)

Each entry is a GitHub issue: the heading is its title, the first line its labels.

### Bugs

#### Firefox typing latency grows with page size (y-tiptap selection mapping)
Labels: `bug`, `performance`, `editor`, `upstream`

In Firefox, the editor's processing per keystroke on a 2,000-block page is 12–21 ms p95, against
7–11 ms in Chromium (`e2e/editor/performance.spec.ts` prints both). A profile puts the time in
dependencies: `@tiptap/y-tiptap` converts the selection to Yjs relative positions three times per
keystroke (undo plugin state, `beforeAllTransactions`, `_prosemirrorChanged`), each walking the
fragment up to the caret, and diffs every top-level child (`updateYFragment`); ProseMirror's view
update walks every top-level child. The editor's own plugins take under 0.3 ms.
**Expected:** under 16 ms in every browser. **Now:** the spec enforces 16 ms in Chromium and 24 ms
in Firefox (SPEC.md §10). **Next:** report upstream with the profile; cache relative positions per
transaction.

#### Undo or redo can desync ProseMirror and Yjs (`@tiptap/y-tiptap` 3.0.9)
Labels: `bug`, `editor`, `upstream`

After an undo or redo step, y-tiptap keeps absolute positions from an older document, which can
throw a `RangeError` and leave ProseMirror out of sync with Yjs (a redo that never shows up).
Worked around in `packages/editor/src/extensions/history-guard.ts`, with tests. Report upstream,
then remove the guard.

#### Vitest's server worker sometimes aborts (0xC0000409) in a full Windows run
Labels: `bug`, `tests`, `windows`

In a full `pnpm test` on Windows 11 (Node 24), the forked worker running
`apps/server/src/sync/sync.test.ts` or `crash.test.ts` exits with code 3221226505 (0xC0000409,
how Windows reports Node's `abort()`), and Vitest reports "Worker exited unexpectedly". The server
project passes alone (`pnpm --filter @tessera/server test`: 10 files, 78 tests), memory was not
exhausted, and the project runs last (`sequence.groupOrder: 2`). **Next:** run with Node's
`--report-on-fatalerror` in the fork's `execArgv` to get the fatal report; the native addons
(`better-sqlite3`, `argon2`) are the suspects. Linux CI has not shown it.

#### A loop in a plugin's panel or block freezes the app in Firefox and headless Chromium
Labels: `bug`, `plugins`

UI frames run on the app's main thread where the browser has no out-of-process iframes (Firefox,
headless Chromium), so a panel or block stuck in a loop freezes the app. Worker loops, where plugin
logic runs, are detected and stopped in both browsers (`e2e/plugins/sandbox.spec.ts`). Documented
in `docs/plugins/permissions.md` › Limits. **Next:** a watchdog ping from the outer frame, and
unloading the frame when it stops answering.

#### Relation cleanup can leave dangling IDs if the tab closes right after a permanent delete
Labels: `bug`, `databases`

Relation cleanup after a permanent deletion runs on the deleting client; if it closes in the few
milliseconds before the cleanup runs, dangling IDs stay in the data. Cells and "Linked from"
ignore pages that don't exist, so nothing shows. **Next:** clean up in the same transaction, or
lazily when a relation is read.

#### Escape during a popover's exit animation needs a second press
Labels: `bug`, `databases`, `accessibility`

Pressing Escape during a closing popover's exit animation (about 150 ms) reaches the closing
popover (Radix keeps it mounted while it animates), so a second press is needed to close the next
one.

#### The top bar squeezes the page title at phone width
Labels: `bug`, `mobile`, `shell`

At 390 px the top bar shows seven icon buttons (sync status, export, favorite, copy link, local
graph, history, the page menu), and the title shrinks to "Apollo pro…"
(`assets/screenshots/architect/phone-light.png`). **Expected:** below 768 px, keep the sync status
and the page menu and move the rest into the page menu.

#### Search: linked titles in page text catch up only on the next edit
Labels: `bug`, `search`

Renaming a link target updates titles live in panels and results, but the source page's
searchable text keeps the old title until that page is next edited.

### Performance

#### Benchmarks run against a development build of the app
Labels: `performance`, `ci`, `tests`

`scripts/bench` measures the seeded harness (`packages/testkit/harness`), which runs on the Vite
dev server with React's development build, so every render-heavy number is inflated. The import
benchmark's longest main-thread block is 129 ms against a 100 ms budget (it was 222 ms before this
merge's fixes), mostly synchronous React re-renders of the page tree as batches of pages arrive.
**Next:** build the harness in production mode for benchmarks; then, if the import still blocks
over 100 ms, render the page tree with `useDeferredValue` during bulk changes.

#### Graph view: frames while the layout runs, and without a GPU
Labels: `performance`, `search`

On a production build with the GPU, a 10,000-node graph pans and hovers at p95 16.8 ms frames once
laid out, but one run measured p95 100 ms while the layout was still running
(`e2e/search/perf.config.ts`). Without a GPU (headless Chromium, SwiftShader), `scripts/bench`
measures 415 ms p95 at 5,000 pages (102 ms with `--headed`, in its dev-mode harness). Laying out
10,000 nodes takes about 40 s to settle (in a worker). Since #96, a large graph pans without
redrawing on software renderers (`HANDOFF/search.md`). **Next:** send positions less often during
layout.

#### The Mermaid plugin loads 5.2 MB per block frame
Labels: `performance`, `plugins`

Each Mermaid block frame loads the whole bundle (from a blob, so no network). A page with dozens
of diagrams uses a lot of memory. **Next:** share one renderer frame per page, or render SVG in
the worker.

#### Cross-tab sync waits for the durable IndexedDB commit
Labels: `performance`, `sync`

A tab broadcasts an update only after its `durability: 'strict'` commit: usually well under a
second, once over 2 s in Firefox on a saturated machine.

### Deferred features and gaps

#### Plugin API: database queries with date ranges and relative dates
Labels: `enhancement`, `plugins`, `databases`

`api.databases.query` uses the SDK's own engine (`@tessera/plugin-api/query`), so plugins tested
in the SDK harness get the same results as in the app. Its filters lack the views' date ranges and
relative dates ("this week"). Add them to the SDK engine, matching `packages/db-views/src/query`.

#### Plugin storage is per device and shared across workspaces
Labels: `enhancement`, `plugins`

A plugin that stores page IDs sees IDs from other workspaces. Add a workspace ID to the plugin API
(compatible through `apiVersion`) and scope storage by workspace.

#### Version history for database structure
Labels: `enhancement`, `sync`, `databases`

Version history covers pages, not database docs (no core helper replaces a database doc's
structure as a new edit); the panel says so for databases.

#### Server: account administration and asset garbage collection
Labels: `enhancement`, `server`

No admin UI for accounts (a password reset is `create-owner` for the first account only), and
asset files are never garbage-collected.

#### Search: index collaborators' pages this device never pulled
Labels: `enhancement`, `search`, `sync`

A doc never stored on this device is indexed by title only. Background pulls are re-indexed now
(`onPulled`), but a page nobody on this device has pulled stays title-only.

#### Search: phrase queries
Labels: `enhancement`, `search`

Quotes group words for `in:"…"`, but quotes in free text are plain words.

#### Formulas: lists, regular expressions and date formats
Labels: `enhancement`, `databases`

No lists or list functions (`map`, `filter`), no regular expressions (on purpose, for safety), and
`formatDate` has no format codes (it uses the viewer's locale).

#### Importers for Logseq, Bear, Evernote and HTML
Labels: `enhancement`, `importers`

The stretch importers (Logseq, Bear, Evernote `.enex`, HTML files) are not built.

#### Exports: what markdown and CSV can't hold
Labels: `enhancement`, `importers`

Exports drop database views and formulas, comments and version history; formula columns are left
out of CSV. Pasted HTML tables with merged cells lose the merge. Backups are one in-memory JSON
string (2 GB limit); a streaming format would suit very large workspaces.

#### The print view doesn't follow live edits
Labels: `enhancement`, `importers`

The print view renders the page when opened; databases print as tables (every column, rows in
stored order), not as their views.

#### Drag blocks by touch
Labels: `enhancement`, `editor`, `mobile`

Dragging blocks by touch isn't supported; on touch screens the handle opens the block menu (Move
up, Move down).

#### Link previews for bookmark cards
Labels: `enhancement`, `editor`, `server`

Bookmark cards show a title, description and host from the embed's data, or the URL. The app is
offline-first and never contacts the linked site; the server could offer a preview endpoint.

#### Orphaned local docs after a permanent delete on another device
Labels: `bug`, `sync`

A page deleted permanently elsewhere leaves its local docs until the replicator meets the server's
tombstone for a dirty doc; clean orphans stay on disk (invisible, small).

#### Desktop: a transactional dirty flag in the SQLite doc store
Labels: `enhancement`, `desktop`, `sync`

The browser's IndexedDB store marks a doc dirty in the same transaction as its update; the
desktop's SQLite store relies on the replicator's change handler. Doing it in the store's
transaction closes the window where a crash between the two loses the "needs upload" mark.

#### Desktop: export downloads and printing in the webview
Labels: `desktop`, `importers`

The export dialog downloads through `<a download>` and the PDF export uses `window.print()`; both
depend on the webview. Check them in the real app on each OS, and use a native save dialog where a
webview ignores downloads.

#### Desktop: builds and paths not verified on this machine
Labels: `desktop`, `release`

Verified here: the Windows app (debug, `smoke-app.mjs` end to end) and, by the desktop team, the
Linux packages in Docker. Not verified: macOS (no Mac), the updater's install path (needs a signed
release), global shortcuts on Wayland, the keychain on Linux CI (no Secret Service). The markdown
copy re-exports the whole workspace after edits settle; an incremental exporter would suit very
large workspaces.

#### Self-hosting templates not verified on their platforms
Labels: `self-hosting`

The Fly.io, Railway and Render configs and the Unraid, CasaOS and Umbrel templates follow each
platform's documented format but were not deployed (no accounts). The root-owned-volume path they
rely on was tested locally. The arm64 image was not built locally.

#### CI: nightly performance and load jobs
Labels: `ci`, `performance`

Not scheduled yet: the server load test (`pnpm --filter @tessera/server load-test`, exits non-zero
on lost deliveries or divergence), the 2,000-note import benchmark (`TESSERA_IMPORT_BENCH_NOTES`),
the search benchmark (`pnpm --filter @tessera/search bench`) and browser checks
(`e2e/search/perf.config.ts`, `PERF_SOFTWARE_GL=1` on Linux), and `scripts/bench --compare`.

#### CI: workflows that only run on GitHub
Labels: `ci`

`desktop.yml`, `docker.yml`, the docs deploy, `release.yml`, CodeQL, the labeler and Dependabot
were checked with actionlint (every workflow valid) and the workflow policy tests, not executed;
shellcheck wasn't installed here. The first run on GitHub confirms them.

#### Docs: VitePress 1.x brings dev-server advisories
Labels: `docs`, `security`, `dependencies`

`pnpm --dir docs audit` reports Vite 5 advisories (`server.fs.deny` bypass on Windows, path
traversal in optimized deps, esbuild's dev server) through VitePress 1.6.4. They affect `vitepress
dev` only, not the built site. Move to VitePress 2 (Vite 6+) once it is stable.

#### Windows: long fixture paths need `core.longpaths` to clone into deep folders
Labels: `bug`, `windows`, `contributing`

`packages/importers/fixtures/notion-export` keeps Notion's real folder names (a title plus a
32-character ID per level). Cloned into a deep folder on Windows, some paths pass 260 characters
and `git clone` fails with "Filename too long" unless `git config --global core.longpaths true`.
**Next:** shorten the fixture's folder names (the test builds its deepest chain in a zip already),
or note it in CONTRIBUTING.

#### Screen readers: check with real ones
Labels: `accessibility`

ARIA roles, names and keyboard paths are checked with Playwright role queries and axe
(`e2e/ci/accessibility.spec.ts`), not with NVDA, VoiceOver or Orca.

## Owner checklist before launch

- Push `main` (nothing is pushed yet), and watch the first CI run on GitHub.
- Repository settings: upload `assets/brand/social-preview.png`; enable Discussions with a Q&A
  category; create the labels `bug`, `enhancement`, `question`, `triage`, `roadmap`,
  `good first issue`; enable private vulnerability reporting.
- Release: the updater signing key (`TAURI_SIGNING_PRIVATE_KEY`, its password, and
  `TAURI_SIGNING_PUBLIC_KEY` as a variable); publish `examples/plugins/registry.json`,
  `registry.schema.json` and the example zips to GitHub Pages under `/plugins/`; publish
  `@tessera/plugin-api` and `create-tessera-plugin` to npm (both `private` for now).
- Content: pick a tagline; fill `LAUNCH.md`'s `[link to the README or an album]`; the
  `assets/demo.gif` placeholder is replaced in the polish phase (`agents/12-polish.md`); decide
  whether to keep the `BUILT_WITH_AGENTS.md` link in the README footer.
