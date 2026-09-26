# Plugins handoff

## Plan

Milestones (each ends tested and committed), all done:

1. **SDK** (`packages/plugin-api`): the typed API (`definePlugin`, `PluginApi`, panel and block
   contexts, settings schema, errors), and a test harness with a mocked API that enforces
   permissions like the host (`@tessera/plugin-api/testing`).
2. **Host core** (`packages/plugins`): manifest and bundle parsing (zip, folder, URL), plugin
   stores (IndexedDB, memory), the plugin manager (install, enable, disable, update, uninstall,
   grant and revoke), the RPC protocol with zod validation, size limits and permission checks on
   every call, and the capability-scoped API handlers on top of `AppContext`. Lifecycle and fuzz
   tests.
3. **Sandbox and runtime**: sandboxed iframes (`allow-scripts` only) with a strict CSP; plugin logic
   in a Worker inside the sandbox with a heartbeat watchdog; panels and blocks in nested sandboxed
   frames; the per-session plugin host; the feature module (settings panel, `plugin:` block
   renderer, runtime commands, panels and slash-menu items).
4. **Host UI**: Settings → Plugins (installed list, permissions, settings form, console, README,
   uninstall), install from zip, folder and URL with a plain-language permission prompt, the
   registry browser, dev mode with live reload.
5. **Example plugins** (`examples/plugins`): word count, daily notes, pomodoro, random page,
   mermaid; each with a README and tests; a build script and `registry.json`.
6. **Tooling**: `create-tessera-plugin` and `examples/plugin-template` (kept identical by a test).
7. **e2e and screenshots** (`e2e/plugins`): install flows, sandbox isolation, the infinite loop
   watchdog, permission revocation, dev mode; screenshots in both themes.
8. **Docs** (`docs/plugins`): overview, getting started, API reference generated from TSDoc,
   permissions and security model, publishing.

## Built (what exists and where)

**`packages/plugin-api`: the SDK** (what plugin authors import; no host code, so bundles stay
small).

- `src/index.ts`: `definePlugin`, `defineBlock`, `isPluginDefinition`.
- `src/types.ts`: the whole API (`PluginApi` with `commands`, `ui`, `pages`, `databases`,
  `storage`, `settings`, `theme`), `PanelContext`, `BlockContext`, the settings schema types.
  Everything has TSDoc, and most methods have examples.
- `src/errors.ts`: `PluginError` (`instanceof` works across realms through `Symbol.hasInstance`).
- `src/permissions.ts`: copies of core's `PLUGIN_API_VERSION`, `PLUGIN_PERMISSIONS` and ID
  patterns (the SDK is published on its own); a test keeps them equal to core's.
- `src/query.ts`: `runRowQuery` and `resolveRowInput` (filters, sorts and writes by property and
  option *names*), shared by the host and the harness.
- `src/settings.ts`: setting validation and defaults, shared by the host and the harness.
- `src/testing/`: `createTestHarness`, an in-memory workspace that enforces permissions with the
  host's exact messages, renders panels and blocks into DOM elements, and has `flush()` that works
  with fake timers.
- `scripts/api-docs.ts`, `scripts/write-api-docs.ts`: generate `docs/plugins/api.md` from the TSDoc
  (`pnpm --filter @tessera/plugin-api docs:api`). `scripts/api-docs.test.ts` fails when the file is
  out of date, or when an export has no section in the reference.

**`packages/plugins`: the host.**

- `src/manifest.ts`: manifest validation on top of core's schema (API version, `minAppVersion`),
  plain-language permission descriptions with risk levels, and `network:` → CSP sources.
- `src/bundle.ts`: plugin bundles from a zip (size and file-count checks before inflating, so a
  zip bomb fails fast, and path traversal is refused), from folder files, or from a URL (a zip, or
  a `manifest.json` with its entry next to it).
- `src/registry.ts`: the `registry.json` format (zod), fetching, search, update detection, and
  `downloadRegistryPlugin`. It checks the SHA-256 when listed, and that the manifest's ID and
  version match the entry and ask for no unlisted permission.
- `src/store/`: `IndexedDbPluginStore` (database `tessera-plugins`: plugins, code, storage) and
  `MemoryPluginStore` (fallback and tests).
- `src/manager.ts`: `PluginManager`. It plans and runs installs and updates (updates keep what the
  user decided and add what they just approved), handles enable and disable, granting and
  revoking, settings, and plugin storage with quotas. Operations are serialized per plugin, and
  changes reach other tabs through a `BroadcastChannel`.
- `src/rpc/`:
  - `inspect.ts`: depth, value count, characters, types and cycles, checked before parsing.
  - `protocol.ts`: the `API_METHODS` table, with the zod params, required permission and allowed
    surfaces of each method.
  - `endpoint.ts`: `HostEndpoint`, with the in-flight limit, timeouts, and out-of-order and
    invented responses ignored.
- `src/sandbox/`: everything that runs inside the frames, shipped as source text, and the frame
  factory.
  - `runtime-kit.ts`, `runtime-worker.ts`, `runtime-ui.ts`: the in-sandbox runtime. It builds `api`
    over RPC and applies the base styles and theme variables.
  - `bootstraps.ts`: the worker frame, the outer UI frame and the inner UI frame.
  - `sources.ts`: the documents and the CSP.
  - `frames.ts`: `domSandboxFactory`.
  - `instrument.ts` (run by `instrument.worker.ts`) and `prepare.ts`: panel and block code is
    instrumented so a loop can be stopped, once per plugin version, and kept in IndexedDB
    (`tessera-plugin-prepared-code`). The frame's side is `installGuard` in `runtime-kit.ts`.
- `src/host/`:
  - `plugin-host.ts`: one per workspace session. It starts the enabled plugins, forwards page,
    storage, settings and theme events, and runs dev watchers.
  - `instance.ts`: one per plugin. It handles the lifecycle, the heartbeat watchdog, the
    registrations and `mountSurface` for panels and blocks.
  - `api.ts`: the handlers, one per API method, on top of `AppContext`.
  - Also `dev.ts` (dev mode polling), `console.ts` (per-plugin console) and `theme.ts` (tokens,
    fonts, reduced motion).
- `src/ui/`:
  - `PluginPanel`, `PluginBlock` and `SurfaceFrame`: frames that size to their content, with
    loading and error states.
  - `settings/`: Settings → Plugins, made of:
    - installed list;
    - details with tabs: What it adds (with a live block preview), Settings, Permissions, Console,
      About (with the README);
    - install flow (zip, folder, URL, dev) and permission prompt;
    - registry browser.
- `src/entry.tsx`: the light, statically imported pieces. Everything else loads with dynamic
  `import()`.
- `scripts/build-examples.ts`: builds the examples with Vite (one minified ES module each) and zips
  them reproducibly (`pnpm --filter @tessera/plugins build:examples [id…]`).

**`apps/web/src/features/plugins/index.ts`**: the feature registration (below).

**`examples/plugins`**: Word count, Daily notes, Pomodoro, Random page, Mermaid diagrams (each
with `manifest.json`, `src`, tests and a README), `registry.json`, `registry.schema.json` and
a README. Their tests run in root `pnpm test` (through `packages/plugins/vitest.config.ts`), and
they are typechecked by `packages/plugins/tsconfig.examples.json`.

**`examples/plugin-template` and `packages/create-tessera-plugin`**: the template, including its
dev server with live reload (`scripts/dev.mjs`) and packer (`scripts/pack.mjs`). The CLI embeds
the template as `src/template.json` (`pnpm --filter create-tessera-plugin sync-template`). A test
fails when they differ, and another scaffolds a project and builds it with Vite.

**`docs/plugins`**: `index.md`, `getting-started.md`, `api.md` (generated), `permissions.md` and
`publishing.md`. The guide's code was run for real: scaffolded with the CLI, built, tested, and
typechecked.

**`e2e/plugins`**:

- `plugins.spec.ts`, 6 journeys: registry install and panel; Mermaid block; revoking a permission;
  zip install and uninstall; dev-mode live reload; URL refusals.
- `sandbox.spec.ts`: frame isolation and CSP checked from the host, the infinite-loop watchdog
  (a command, a panel, a block), and a hostile plugin probing from inside.
- `plugins.screenshots.ts`, plus fixtures (plugins that loop forever in a command, and in a panel
  and a block; a hostile plugin; a live-reload plugin).

## How it plugs in (FeatureModule entries, services, extension points used)

- **FeatureModule** (`pluginsFeature`, id `plugins`):
  - `settingsPanels`: Plugins (icon `Puzzle`, order 50) → `PluginsSettingsEntry`, lazy.
  - `blockRenderers`: the `plugin:` prefix → `PluginBlockEntry` (lazy). It renders every
    `embed` of kind `plugin:<id>/<type>` in a sandboxed frame. The block shows a friendly
    placeholder when the plugin is missing, disabled or lacks `ui:blocks`.
  - `commands`: `plugins.openSettings`.
  - `activate(ctx)`: once the browser is idle (`requestIdleCallback`, at most 2 s after the
    workspace opens), lazy-loads the host and starts it for the workspace session. Plugins start in
    the background; the workspace never waits for them, and they never compete with its first
    paint.
- **At runtime, per enabled plugin** (removed on disable, uninstall, crash or permission change):
  - Commands: `ctx.commands.register`, ID `plugins.<pluginId>/<commandId>`, with shortcut
    collisions refused and logged.
  - Panels: `ctx.contributions.register('pageSidePanels', { id: 'plugin:<id>/<panel>', … },
    'plugins')`.
  - Slash-menu items: `ctx.blocks.registerSlashMenuItems`. Items are in group `plugins`, and
    `create` returns `{ kind: 'plugin:<id>/<type>', data }`.
- **Services and APIs used**:
  - `ctx.workspace` for pages, rows and databases.
  - `ctx.loadPageDoc` and `ctx.loadDatabaseDoc` with core's `readDocJSON`/`writeDocJSON`,
    `resolveRows`, `listRows`, `getCellValue` and `setRowValue`.
  - `ctx.services.markdownCodec` for markdown in and out, and for README rendering.
  - `ctx.events` (`page.*`, `doc.changed`), `ctx.toast`, `ctx.navigateTo`, `ctx.openSidePanel` and
    `ctx.getCurrentPageId`.
  - `ctx.settings.device` for the registry URL (`plugins.registryUrl`).
- **Core contracts used**:
  - `pluginManifestSchema`, `PLUGIN_PERMISSIONS`, `hasPluginPermission`, `PLUGIN_API_VERSION`.
  - `pluginBlockKind`, `PLUGIN_BLOCK_TYPE_PATTERN`, `SEMVER_PATTERN`, `pluginPermissionSchema`.
- **Device storage**: IndexedDB database `tessera-plugins` (installed plugins, their code and
  their storage). It is separate from workspace data, because plugins are installed per device.

## Decisions (and why)

- **Spike results (before any code), Playwright 1.63, Chromium 1243 and Firefox 1543:**
  - A sandboxed `srcdoc` iframe (`allow-scripts`, no `allow-same-origin`) can start a **classic**
    Worker from a blob URL in both browsers, and `import()` a blob ES module inside it. **Module**
    workers from blob URLs never start in Chromium (no error event), so plugin logic runs in a
    classic worker that imports the plugin's ES module.
  - Inside the worker: IndexedDB throws `SecurityError`, fetches to domains outside `connect-src`
    are blocked by the CSP inherited from the frame, and a `while (true) {}` stops heartbeats while
    the app's main thread keeps running (29–30 timer ticks in 1.5 s in both browsers).
  - A plugin running in a sandboxed frame can **navigate its own frame** (`location.href`, link
    clicks, `location.replace`, meta refresh) and leak data in the URL; the Navigation API cannot
    stop it (disabled for opaque origins). Fix: UI surfaces use **nested** frames. A trusted outer
    frame (CSP `frame-src 'none'`) hosts an inner frame that runs plugin code, and the outer
    frame's `frame-src` blocks every navigation of the inner frame. Verified against a local
    "evil" server: zero requests from 16 exfiltration attempts in both browsers.
  - Plugin code that loops forever **in a UI frame** freezes the app in Firefox and headless
    Chromium (same process); headful Chromium isolates sandboxed frames in their own process and
    stays responsive.
- **Panel and block code is instrumented, so a loop there can be stopped (issue #6).** UI frames
  share the app's thread in Firefox and headless Chromium, and nothing outside a frame can stop
  its code there; a cross-site frame origin isn't available to a self-hosted or desktop app, and
  rendering from the worker would break every plugin that measures or draws. So before a UI frame
  runs, the host parses the plugin's module (acorn, in a worker) and adds a call to a guard at the
  top of the module, of every function body (`(guard(), expression)` for expression arrows) and
  of every loop body. The guard (`installGuard`) throws once the code has run for
  `PLUGIN_TIMINGS.frameRunLimitMs` (2 s) without the event loop turning (a `MessageChannel`
  message it posts marks the turn), keeps throwing after that so the code unwinds, and tells the
  host (`unresponsive`), which closes the frame. Its name is one no identifier of the code uses,
  and it's defined non-writable and non-configurable before the module loads. Its first call adds
  `script-src 'none'` to the frame's policy, so no code the host didn't check can load afterwards
  (a blob script or `import()`); the lock's element is removed at once, the policy stays in force.
  Parsing Mermaid takes 2–5 s, so code is prepared in the background when a plugin with panels or
  blocks starts, once per version, and kept in IndexedDB. What it can't stop: one long call into
  the browser (a regular expression that backtracks for minutes).
- **Sandbox code ships as source text** (`Function.prototype.toString()`), so the runtime needs no
  separate build step and no URL. Every shipped function is tested for self-containment in a fresh
  `vm` realm. The module loader stays a string (`LOAD_MODULE_SOURCE`), because Vite dev rewrites
  `import(variable)`.
- **Renderers are declared, not passed over RPC.** `panels` and `blocks` in the definition are
  looked up by ID in each UI frame. `api.ui.addPanel` and `addBlock` only register metadata, and
  refuse IDs that have no renderer. Functions can't cross `postMessage`, and this keeps UI code out
  of the worker.
- **Permissions are checked against the grant at the moment of each call**, and each method lists
  the surfaces it may come from. Registration happens only in the worker. `block.setData` comes
  only from the block's own frame, and never when the block is read-only (checked on the host with
  the editor's own `isReadOnly`).
- **Changing a permission restarts the plugin.** Network access is a CSP property of the frame, so
  it can't change in a running frame, and a restart keeps the rules simple.
- **Plugins are installed per device**, not per workspace (like Obsidian's community plugins,
  like browser extensions). Their storage is per plugin, on this device.
- **Registry**: one static `registry.json` (any host with CORS), zod-validated per entry. Invalid
  entries are skipped and counted, never fatal. The optional `sha256` is checked, and a manifest
  may not ask for permissions its entry doesn't list. The default URL is
  `https://femboypuppy.github.io/Tessera-Notes/plugins/registry.json`: the repository's Pages site,
  which serves with `Access-Control-Allow-Origin: *`. Community listings go through pull requests
  to `examples/plugins/registry.source.json` (documented in `docs/plugins/publishing.md`).
  *Later:* the docs workflow generates and publishes the registry (every example built, every URL
  from the site's address, a SHA-256 per zip, which the app requires for the default registry) and
  checks it after each deploy (`build:registry`, `check:registry`).
- **Dev mode polls** the dev server's `manifest.json` and entry every second and reinstalls on a
  hash change. There is no websocket and nothing to install on the author's side beyond the
  template's tiny static server. New permissions in a dev reload are prompted like an update.
- **Example builds** use each example's own `vite.config.ts` through Vite's Node API (a single
  minified ES module, rolldown `codeSplitting: false`). Zips use a fixed mtime, so rebuilding
  gives the same bytes.
- **Theme**: frames get every `--tess-*` token plus the app's UI fonts (as `FontFace` data), and
  follow theme and reduced-motion changes live. The host watches `<html>` attributes and only
  reads computed tokens when `data-theme`, `class`, `style` or reduced motion changed. The outer frame follows the app's
  `color-scheme` over its control port: browsers paint an opaque backdrop behind a frame whose
  color scheme differs from its embedder's, which showed at the rounded corners of blocks in dark
  mode.
- **Reduced motion in frames turns transitions off (`0s`), rather than shortening them to
  `.01ms`.** With `transition-property: all` as the default, any duration turns every style change
  into a transition, and code that measures right after a change reads stale values. This made
  Mermaid lay out diagrams four times too big, or clipped.
- **`api.databases.query`** uses the SDK's own small engine (`runRowQuery`) on top of core's
  `getCellValue`, as the Architect asked. Agent 04's engine is a merge follow-up.
- **The README** is rendered from the markdown codec's document tree into React elements one by
  one (no HTML strings). Links are limited to http(s) and mailto. Images are left out, because
  their paths point into the author's repository.
- **`NoInfer<S>` on `panels` and `blocks`** in `PluginDefinition`, so a typed `defineBlock`
  renderer can't widen the settings type inferred from `settings`. Typechecking the
  getting-started guide's code found this.
- **Dependencies** (exact versions):
  - `packages/plugins`:
    - `acorn` 8.18.0: parses panel and block code to instrument it; MIT, already in the
      workspace (ESLint's parser), loaded only in the instrumenting worker.
    - `fflate` 0.8.3: zip read and write; small, MIT.
    - `react-router` 8.4.0: `useSearchParams` for deep links such as
      `/settings/plugins?plugin=<id>`. It is already the app's router.
    - `yjs` and `zod`: already in the workspace.
    - Dev only: `fake-indexeddb` 6.2.5 (store tests), `fast-check` 4.10.2 (RPC fuzzing),
      `mermaid` 12.0.0 (building and testing the Mermaid example), `vite` 8.3.0 (example builds).
  - `packages/plugin-api` dev: `typescript` 6.0.3, for the docs generator (the root version).
  - `mermaid` is a dependency of the Mermaid example only. It's bundled into that plugin
    (5.2 MB), never into the app.

## Contract change requests (exact proposed diff to packages/core, and why)

None. Everything the plugin system needs was already in `packages/core`.

## Known gaps and bugs

- **Acceptance criterion "sandbox escape tests with a malicious test plugin" is only partly
  covered.** The fixture plugin that actively probes `parent`, `top`, cookies, `localStorage`,
  IndexedDB and a non-allowlisted fetch from inside the sandbox was **not written in this
  session**. What exists instead:
  - `e2e/plugins/sandbox.spec.ts` checks from the host, in both browsers, that every plugin frame
    is `sandbox="allow-scripts"` only, can't be read by the app (opaque origin), and carries the
    strict CSP (`default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`, `form-action
    'none'`, nonce'd scripts, no `unsafe-eval`).
  - `host.test.ts` › "the host refuses calls without permission even when the runtime is
    bypassed" sends raw RPC for every permission-gated method.
  - `endpoint.test.ts` fuzzes the RPC with malformed, oversized, cyclic and out-of-order messages.
  - The pre-code spike (above) measured IndexedDB, CSP fetch blocking and the navigation leak in
    both browsers.
  - Follow-up: an in-sandbox probe fixture for the e2e suite (Agent 09's security review is a
    good owner).
- **One long call into the browser from a panel or block holds the app** in Firefox and headless
  Chromium until it returns (a runaway regular expression, say). Loops, recursion and promise
  chains are stopped after 2 s (see Decisions); `docs/plugins/permissions.md` › Limits says so.
- **The editor slash-menu path is untested end to end on this branch.** The editor isn't merged,
  so the Mermaid e2e inserts the block through the details page's preview. The preview uses the
  same slash-menu item `create()` and the same `plugin:` renderer. The e2e tests switch to the
  real slash menu automatically once a `page` body exists (`hasEditor`). Word count's typing
  check works the same way.
- **README rendering needs Agent 08's codec.** Core's stub codec only knows paragraphs and
  headings, so until the merge READMEs show markdown syntax (`**`, tables) as text.
- **The Mermaid plugin bundle is 5.2 MB**, loaded once per block frame (from a blob, so no network).
  This is fine for a handful of diagrams; a page with dozens would use a lot of memory.
- **Plugin storage is per device and shared across workspaces.** A plugin that stores page IDs
  should expect IDs from another workspace. `api` has no workspace ID yet (a possible API
  addition, compatible through `apiVersion`).
- `api.databases.query` filters don't cover every operator Agent 04's views have (no date ranges
  or relative dates).

## Follow-ups for the merge (cross-agent wiring you couldn't finish alone)

- **After the editor merges (Agent 02):** run `pnpm test:e2e e2e/plugins`. The Mermaid spec then
  goes through `/mermaid` in a page, and Word count checks live counts while typing. Regenerate
  the screenshots (`pnpm screenshots e2e/plugins`): `mermaid-block` then shows the block inside a
  page instead of the preview.
- **Agent 04:** swap `runRowQuery` in `packages/plugins/src/host/api.ts` (`databases.query`) for
  `packages/db-views/src/query`, keeping the name-based property and option matching of
  `resolveRowInput`.
- **Agent 07 (desktop and self-host), CSP:** `srcdoc` frames inherit the embedding page's CSP. If
  the app is ever served with a CSP (nginx headers, Tauri `security.csp`), it must allow the
  following, or plugins won't start:
  - the sandbox bootstrap inline scripts, with `'unsafe-inline'` or their hashes;
  - `blob:` in `script-src` and `worker-src`;
  - `'unsafe-inline'` in `style-src`;
  - `data:` and `blob:` fonts and images;
  - `connect-src` wide enough for the plugins' granted domains.

  Ask me (or read `packages/plugins/src/sandbox/sources.ts`) before tightening it.
- **Agent 09 (CI):**
  - ~~Publish the registry, `registry.schema.json` and the example zips to GitHub Pages under
    `/plugins/`.~~ Done: `.github/workflows/docs.yml` builds and checks them on every deploy.
  - Publish `@tessera/plugin-api` and `create-tessera-plugin` to npm. Both are `private` for now;
    `create-tessera-plugin` builds with `tsdown` to `dist/cli.js`.
  - Run `pnpm --filter @tessera/plugin-api docs:api` in the docs job, or rely on the test that
    fails when `docs/plugins/api.md` is stale.
- **Agent 10 (docs):**
  - Link `docs/plugins/index.md`, `getting-started.md`, `api.md`, `permissions.md` and
    `publishing.md` in the sidebar.
  - `api.md` uses explicit `<a id>` anchors for methods, and escapes `<` in prose, so VitePress
    doesn't read it as HTML.
  - `docs/plugins/permissions.md` links `../../SECURITY.md` (Agent 09's).
- **Agent 05 (command palette):** plugin commands register as `plugins.<id>/<command>` with titles
  "<Plugin name>: <title>". Nothing else is needed.

## Screenshots (list of files)

All at 1440×900, light and dark, in `assets/screenshots/plugins/` (`pnpm screenshots e2e/plugins`):

- `registry-light.png`, `registry-dark.png`: Settings → Plugins → Browse, the example registry.
- `permission-prompt-light.png`, `permission-prompt-dark.png`: installing Daily notes.
- `plugin-settings-light.png`, `plugin-settings-dark.png`: five plugins installed and running.
- `mermaid-block-light.png`, `mermaid-block-dark.png`: the Mermaid block (in its preview until the
  editor merges).
- `pomodoro-light.png`, `pomodoro-dark.png`: the Pomodoro panel with a running timer.
