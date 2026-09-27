# Changelog

Every release of Tessera, newest first. Each one opens with what matters to people using it,
followed by every change, generated from the commit history
([Conventional Commits](https://www.conventionalcommits.org/)).

## 0.1.2 (2026-09-27)

**Tessera Notes 0.1.2 makes the plugin browser work, fixes the editor's rough edges when several
people type at once, and makes large workspaces faster.** It also brings a new logo and the new
name: the project is now **Tessera Notes**, at
[github.com/femboypuppy/Tessera-Notes](https://github.com/femboypuppy/Tessera-Notes) (old links
redirect). Your data and settings carry over unchanged. Upgrading is recommended.

### Highlights

- **The plugin browser works.** Settings → Plugins → Browse lists the example plugins and installs
  them in one click. In 0.1.1 it pointed at a registry that was never published, so it only said
  “Couldn’t load the plugin registry”. The registry is now published with the documentation site, and each plugin is installed
  only if its download matches the registry's SHA-256 checksum.
- **Writing together is reliable.**
  - Undo and redo no longer knock the editor out of step with the shared document, and a
    collaborator's keystroke right after your undo no longer lands where your caret used to be.
  - Two people typing the same letter at the same spot keep their own words.
  - Your caret stays where you're typing when someone else's edits arrive, even when they add or
    move blocks at the same time.
- **Faster with large workspaces.**
  - A keystroke on a long page costs the same as on a short one; typing in Firefox no longer slows
    down as a page grows.
  - Creating, renaming or moving a page redraws only what shows that page, not the whole sidebar and
    every open database. Imports stay smoother too.
  - Another open tab shows your edit right away instead of waiting for it to be saved to disk.
  - With **Keep a markdown copy** on, the desktop app rewrites only the pages that changed.
- **Plugins can't freeze the app.** A plugin's panel or block that runs in an endless loop is
  stopped after two seconds, and the app keeps working. The Mermaid plugin loads once and draws
  every diagram block through a shared renderer: 9 KB per block instead of 5.2 MB. (Plugins can use
  renderers too: plugin API version 2.)
- **Search keeps up with renames.** Pages that link to a renamed page are found by its new title
  right away, not after their next edit.
- **A new logo**: a leaf made of four mosaic tiles, in the app, the desktop icons, the favicon and
  the docs.

Also fixed: a link that GitHub-flavored markdown finds in plain text (like `+@.a`) no longer gains
another pair of angle brackets each time the page is saved.

### Closed issues

- [#1](https://github.com/femboypuppy/Tessera-Notes/issues/1) Firefox typing latency grows with page size (y-tiptap selection mapping)
- [#2](https://github.com/femboypuppy/Tessera-Notes/issues/2) Undo or redo can desync ProseMirror and Yjs (`@tiptap/y-tiptap` 3.0.9)
- [#4](https://github.com/femboypuppy/Tessera-Notes/issues/4) Two people typing the same character at the same spot at the same instant can swap those characters
- [#6](https://github.com/femboypuppy/Tessera-Notes/issues/6) A loop in a plugin's panel or block freezes the app in Firefox and headless Chromium
- [#9](https://github.com/femboypuppy/Tessera-Notes/issues/9) Search: linked titles in page text catch up only on the next edit
- [#12](https://github.com/femboypuppy/Tessera-Notes/issues/12) Measure first-open indexing of a large workspace in the real app
- [#13](https://github.com/femboypuppy/Tessera-Notes/issues/13) Every page change re-renders every `usePages()` subscriber
- [#14](https://github.com/femboypuppy/Tessera-Notes/issues/14) The Mermaid plugin loads 5.2 MB per block frame
- [#15](https://github.com/femboypuppy/Tessera-Notes/issues/15) Cross-tab sync waits for the durable IndexedDB commit
- [#16](https://github.com/femboypuppy/Tessera-Notes/issues/16) Desktop: the markdown copy re-exports the whole workspace after edits
- [#50](https://github.com/femboypuppy/Tessera-Notes/issues/50) CodeQL fails on every push: code scanning is not enabled
- [#51](https://github.com/femboypuppy/Tessera-Notes/issues/51) Docs deploy fails: GitHub Pages is not enabled
- [#52](https://github.com/femboypuppy/Tessera-Notes/issues/52) Desktop builds: the first run of `desktop.yml`
- [#53](https://github.com/femboypuppy/Tessera-Notes/issues/53) Docker image: the first run of `docker.yml` (arm64 never built)
- [#54](https://github.com/femboypuppy/Tessera-Notes/issues/54) Release workflow: the first tagged release

### Upgrade

- **Desktop:** download the file for your system below and install it over 0.1.1. (0.1.x releases
  don't update themselves yet.)
- **Docker:** `docker pull ghcr.io/femboypuppy/tessera:0.1.2`, then recreate the container with the
  same volume; your data stays. The image keeps its name, and `latest` points to 0.1.2 too.
- **In the browser:** once your server runs 0.1.2, reload Tessera.
- **Plugins:** plugins made for 0.1.1 keep working. A plugin that declares plugin API version 2
  (a renderer) needs 0.1.2.

| System | File |
| --- | --- |
| macOS (Apple silicon) | `Tessera_0.1.2_aarch64.dmg` |
| macOS (Intel) | `Tessera_0.1.2_x64.dmg` |
| Windows | `Tessera_0.1.2_x64-setup.exe` or `Tessera_0.1.2_x64_en-US.msi` |
| Linux | `Tessera_0.1.2_amd64.AppImage`, `.deb` or `.rpm` |

`SHA256SUMS.txt` lists every file's checksum. The desktop apps aren't signed with a developer
certificate yet, so the first launch asks for your permission: on macOS, choose **Open Anyway** in
System Settings → Privacy & Security; on Windows, **More info** → **Run anyway**.

### Features

- **brand:** a leaf of four mosaic tiles replaces the T logo (#60) ([`f952233`](https://github.com/femboypuppy/Tessera-Notes/commit/f9522330d07504e18d6c45b30dd1b90a8c687fd1))
- **plugins:** generate the default registry from the example plugins ([`ac7c63c`](https://github.com/femboypuppy/Tessera-Notes/commit/ac7c63ca6cc2d394bf7345b74e64bf05becd9602))
- **plugins:** the default registry's plugins install only with a matching SHA-256 ([`6a2f4a2`](https://github.com/femboypuppy/Tessera-Notes/commit/6a2f4a2d90380ea7fbe1ec742e2aed8d2ba3ccef))

### Bug fixes

- **editor:** a caret after someone else's change lands where Yjs puts it, or back in its moved block (#69) ([`6ddc0a0`](https://github.com/femboypuppy/Tessera-Notes/commit/6ddc0a0ae9f401c5484d87851b0ccd0d0f1f3eb9))
- **editor:** a character typed next to an identical one stays with its typist (#68) ([`a1564a0`](https://github.com/femboypuppy/Tessera-Notes/commit/a1564a03d9c6632d11cf054b744e3ab4f2fd530f))
- **plugins:** load Mermaid once in a shared renderer, not in every block frame (#62) ([`93c2862`](https://github.com/femboypuppy/Tessera-Notes/commit/93c2862790e1b34e50a6c7bcc0aa153cc5297faf))
- **search:** pages show a renamed link target's new title in search (#61) ([`a50c8e0`](https://github.com/femboypuppy/Tessera-Notes/commit/a50c8e0596fabb38ed1a2bcc203549e3776175b2))
- **plugins:** stop a loop in a panel or block instead of freezing the app (#59) ([`2797fbc`](https://github.com/femboypuppy/Tessera-Notes/commit/2797fbc86a94788b8020758e380d5a748396a793))
- **editor:** an undo step's saved caret no longer reaches the next change (#58) ([`22501cc`](https://github.com/femboypuppy/Tessera-Notes/commit/22501cc6399331805ebaa16672d545b110c73128))
- **markdown:** a link GFM finds in looser text no longer gains brackets on every save ([`9106583`](https://github.com/femboypuppy/Tessera-Notes/commit/9106583631f6235196128e951427c44ac3c7184c))

### Performance

- **editor:** a keystroke on a long page no longer costs work in proportion to it (#64) ([`b6d89cb`](https://github.com/femboypuppy/Tessera-Notes/commit/b6d89cb8fee53a47b5241c5bac39768052090bbe))
- **desktop:** the markdown copy writes only the pages that changed (#65) ([`0b26089`](https://github.com/femboypuppy/Tessera-Notes/commit/0b2608974ff86ff19000f158b54f36d3eefdf4e8))
- **sync:** other tabs see an edit before its IndexedDB commit finishes (#63) ([`33dc11a`](https://github.com/femboypuppy/Tessera-Notes/commit/33dc11ab75f8b9a353bc8d75901fe8071a9be371))
- re-render page consumers only when the pages they show change (#57) ([`f20237c`](https://github.com/femboypuppy/Tessera-Notes/commit/f20237c4f0c59edbb12aa949c40fa122e61a56b7))

### Documentation

- plugin screenshots load on the site, and the home page's title says Tessera Notes ([`4a76081`](https://github.com/femboypuppy/Tessera-Notes/commit/4a760819d6a4f26cbaee248dfd3c41da3ee17e27))
- **claude:** day-to-day rules instead of the parallel-build ones ([`c4419ea`](https://github.com/femboypuppy/Tessera-Notes/commit/c4419eadf43d7735a5782fd9f6f35728d75a1635))

<details>
<summary><strong>Maintenance</strong> (7)</summary>

- **bench:** measure the first open of 5,000 notes from IndexedDB (#67) ([`f11c721`](https://github.com/femboypuppy/Tessera-Notes/commit/f11c721c7f72efaed46059df6c6418b7b40757ef))
- **docs:** publish the plugin registry with the site, and check it after each deploy ([`2b2f02b`](https://github.com/femboypuppy/Tessera-Notes/commit/2b2f02bbdc32ef0e4004b0429224fb8e5a92c7e6))
- **plugins:** browse and install from the published registry, and refuse a tampered zip ([`c5ee436`](https://github.com/femboypuppy/Tessera-Notes/commit/c5ee43658da364b2aae65f297a981cf583717682))
- **plugins:** load only the translator from `@tessera/ui` ([`a2219e3`](https://github.com/femboypuppy/Tessera-Notes/commit/a2219e3e57fe71d000401b77961ed9ddca2ff3f0))
- the repository is femboypuppy/Tessera-Notes ([`1163bae`](https://github.com/femboypuppy/Tessera-Notes/commit/1163bae98182c77ee9ff9cbcae21e905e3b589a1))
- **docker:** keep publishing `ghcr.io/<owner>/tessera` after the rename ([`dd0fd2c`](https://github.com/femboypuppy/Tessera-Notes/commit/dd0fd2c8c4fcf4a10e578cf42386db7da46811f4))
- **search:** wait for the palette's lazy chunk under a full test run ([`660c9c6`](https://github.com/femboypuppy/Tessera-Notes/commit/660c9c636d15e93d91b44b7546c2f59110d56506))

</details>

**Full changelog:** https://github.com/femboypuppy/Tessera-Notes/compare/v0.1.1...v0.1.2

## 0.1.1 (2026-09-26)

**Tessera 0.1.1 fixes the problems a code scan found in 0.1.0.** A few checks that read text
worked harder the longer the text got, so a single crafted cell, title or query of a few tens of
thousands of characters could keep Tessera busy for seconds or even minutes. Everything else is
unchanged, including your data and settings. Upgrading is recommended.

### Fixes

- **Long, crafted text no longer freezes the app.** These now take milliseconds, with the same
  results as before:
  - number, date, URL and email cells when you import a CSV file or filter a database;
  - a very long query pasted into search;
  - exporting a page whose title is a long run of dots and spaces;
  - reading HTML and markdown when the full markdown engine isn't available.
- **Server setup codes** are drawn with `crypto.randomInt`, which keeps every character equally
  likely whatever characters the code uses. (0.1.0's codes were already uniform; this keeps them
  so.)

### Bug fixes

- **search:** tokenize queries with a forward scan instead of one regex ([`0342bf5`](https://github.com/femboypuppy/Tessera-Notes/commit/0342bf58ab189899c9f82d585e7052e961526942))
- **server:** draw setup code characters with crypto.randomInt ([`08fa1ee`](https://github.com/femboypuppy/Tessera-Notes/commit/08fa1eec83b0b724ab5e6202b1938216073c5bd5))
- **core:** file names and the fallback markdown codec in linear time ([`ac1fc7d`](https://github.com/femboypuppy/Tessera-Notes/commit/ac1fc7dd5f276e7cce79736d0716efdd23697cff))
- **search:** tokenize pasted queries in linear time ([`3c18a3d`](https://github.com/femboypuppy/Tessera-Notes/commit/3c18a3dc719cbc86063797875dc685e468b45e63))
- **importers:** reject a long, hostile CSV number cell in linear time ([`d40059b`](https://github.com/femboypuppy/Tessera-Notes/commit/d40059b06dfd1f6a00dda6f54e364b046c36b033))
- **db-views:** read numbers, dates, emails and URLs in cells in linear time ([`4a427db`](https://github.com/femboypuppy/Tessera-Notes/commit/4a427db56e375e1cfda579f8d181e0c6c1ce3d60))

### Documentation

- the desktop app updates itself only from releases with signed update files ([`19ef694`](https://github.com/femboypuppy/Tessera-Notes/commit/19ef69466a87ef0713068a44eae2bc56d48efbd4))

<details>
<summary><strong>Maintenance</strong> (2)</summary>

- **release:** version 0.1.1 ([`054a55c`](https://github.com/femboypuppy/Tessera-Notes/commit/054a55c00d4b1d89aa381b49ca7443f52dfd8a27))
- **release:** the tag must match every version the app reports ([`ae8cda1`](https://github.com/femboypuppy/Tessera-Notes/commit/ae8cda1d4feff882de543b809648d62c525d8d55))

</details>

**Full changelog:** https://github.com/femboypuppy/Tessera-Notes/compare/v0.1.0...v0.1.1

## 0.1.0 (2026-09-25)

**Tessera 0.1.0 is the first release.** Tessera is an open-source, local-first knowledge app:
Notion-style blocks and databases, Obsidian-style `[[links]]` and a graph, real-time
collaboration and sandboxed plugins, on your own device and, if you want one, your own server.
Everything works offline; the server only syncs.

### Highlights

- **Write in blocks.** A slash menu, markdown shortcuts, drag handles, tables, callouts, toggles,
  code with syntax highlighting, images and embeds. `[[Links]]` follow renames, `#tags` search,
  and copy and paste keep their formatting.
- **Databases with real views.** Table, board, calendar, gallery and list views over typed
  properties (select, date, number, relation, formula and more), with filters, sorts, grouping,
  summaries, row templates, CSV import and export, and databases inside any page.
- **Links and a graph.** Backlinks with the sentence around each link, unlinked mentions that
  become links in one click, and a global and a local graph.
- **Find anything.** <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> searches pages, full text, tags and
  commands, offline, in a worker.
- **Your device first, your server if you like.** Every edit is saved on your device before
  anything else. Connect a server (one container with SQLite) to sync devices and write together
  with live cursors, roles and version history; offline edits merge without conflicts.
- **Plugins in a sandbox.** Commands, panels and custom blocks run in sandboxed frames with the
  permissions you approve. Five example plugins, a typed SDK and `pnpm create tessera-plugin`.
- **Move in, move out.** Import a Notion export, an Obsidian vault or a markdown folder; export
  Obsidian-compatible markdown, HTML, PDF or a full JSON backup at any time.
- **Desktop apps** for macOS, Windows and Linux keep each workspace in a folder you choose, with
  quick capture from anywhere.

### Features

- **scripts:** record the README demo, and put it at the top of the README ([`3115275`](https://github.com/femboypuppy/Tessera-Notes/commit/3115275c834d2d84f3e953905d8bbebc272d8424))
- **web:** report a crash on GitHub from the error screens ([`9e2e5cf`](https://github.com/femboypuppy/Tessera-Notes/commit/9e2e5cf012d4480138fce7f6ce2016be508fdb9d))
- **importers:** the demo opens at the top level on a project board ([`b741607`](https://github.com/femboypuppy/Tessera-Notes/commit/b741607d0316eb6221c7371d9145ba6f97870816))
- **web:** the app starts offline after one visit (service worker) ([`47b76f8`](https://github.com/femboypuppy/Tessera-Notes/commit/47b76f874b95bb46b482d557aee454b8b9309f0b))
- **integration:** editor previews, live collaboration journey, literal links ([`fc13acb`](https://github.com/femboypuppy/Tessera-Notes/commit/fc13acbfa14d2090623bc9380d8176eda0c8c3e6))
- **core:** apply the approved contract change requests ([`a4624f7`](https://github.com/femboypuppy/Tessera-Notes/commit/a4624f77cf6f25c2f5e29b5cea3a175eb97fba13))
- **docs:** demo workspace and checks for docs, forms and brand ([`62cd8f7`](https://github.com/femboypuppy/Tessera-Notes/commit/62cd8f7022dbf92f24231843dc817a061c3bdde6))
- **docs:** VitePress docs site and community files ([`248c7a7`](https://github.com/femboypuppy/Tessera-Notes/commit/248c7a747cbaeb2c39f5d42f581c4d921b71a16e))
- **docs:** brand assets rendered from tokens with Playwright ([`628fc98`](https://github.com/femboypuppy/Tessera-Notes/commit/628fc9810f7a402886895471f4d685ed2aff1353))
- **importers:** single-page markdown download, screenshots and handoff ([`cafbe79`](https://github.com/femboypuppy/Tessera-Notes/commit/cafbe79147688c12e5d27e6b201f793c855501e8))
- **importers:** import and export dialogs, print view, settings and onboarding ([`226bb7f`](https://github.com/femboypuppy/Tessera-Notes/commit/226bb7fc153bcac1d541c9ca96536bcf4a5582e3))
- **importers:** markdown zip, HTML and JSON backup exporters with restore ([`cdedd54`](https://github.com/femboypuppy/Tessera-Notes/commit/cdedd546f6ab844d14425f774e280e54f434b0e2))
- **importers:** Notion, Obsidian and markdown importers with a worker planner ([`2200b3a`](https://github.com/femboypuppy/Tessera-Notes/commit/2200b3a21b666b4323f7ac91c88ba6728ad02362))
- **markdown:** remark codec with Obsidian syntax, HTML paste and property tests ([`d7f0b11`](https://github.com/femboypuppy/Tessera-Notes/commit/d7f0b1133d4f16a30bddc745d4cb874876c1b048))
- **desktop:** runtime registration, package styles, keychain credential store, screenshots ([`f3e8ff0`](https://github.com/femboypuppy/Tessera-Notes/commit/f3e8ff05c68857eb79ecd96d301bd2720df04e32))
- **deploy:** Docker image, Compose with Caddy, deploy guides and smoke test ([`4422c94`](https://github.com/femboypuppy/Tessera-Notes/commit/4422c943305444a1f5b2ea127c859092330b5db9))
- **desktop:** real-app smoke test, env overrides for data folders, calmer quick capture ([`fc63d21`](https://github.com/femboypuppy/Tessera-Notes/commit/fc63d21f6e18af6e4f480534b1f67836ff98907d))
- **desktop:** Tauri 2 app with folder workspaces on SQLite ([`a3f479e`](https://github.com/femboypuppy/Tessera-Notes/commit/a3f479e42af487c2677880262af610a7d5bcce8f))
- **plugins:** README on the About tab, and Restart from the crash notification ([`9bf9441`](https://github.com/femboypuppy/Tessera-Notes/commit/9bf944160bf3151e2c215a19c1cb84662fed1404))
- **plugins:** create-tessera-plugin scaffolder and the plugin template ([`a64595a`](https://github.com/femboypuppy/Tessera-Notes/commit/a64595a0ea8c8836c0e782152d451a865ba9165c))
- **plugins:** five example plugins, their build tooling and the example registry ([`7804b16`](https://github.com/femboypuppy/Tessera-Notes/commit/7804b165eb9bdc4f45ba568cb0c9182997b7beac))
- **plugins:** sandboxed plugin host with validated RPC, permissions, watchdog and settings UI ([`061f56a`](https://github.com/femboypuppy/Tessera-Notes/commit/061f56af4770cb03be5b2d516bc2781c0f857b81))
- **plugin-api:** typed plugin SDK, row query engine and a test harness with a mocked API ([`58e5f8f`](https://github.com/femboypuppy/Tessera-Notes/commit/58e5f8f64c1256c50637e96a06f3ce4ac29b2bf2))
- **databases:** formula properties with an editor, previews and live errors ([`47b377d`](https://github.com/femboypuppy/Tessera-Notes/commit/47b377d079de0a9ade4f9309796bb46527b4c2cd))
- **databases:** formula engine with a real parser and evaluator ([`2bbbc5d`](https://github.com/femboypuppy/Tessera-Notes/commit/2bbbc5dd5eef25abaf3165f204e8d11a182e5b65))
- **databases:** screenshots, unit tests for views and CSV, calmer table focus ([`8d524bb`](https://github.com/femboypuppy/Tessera-Notes/commit/8d524bb7367d0bbb39f1db65e3d3d59617f11bac))
- **databases:** table, board, calendar, gallery and list views ([`dd6d49f`](https://github.com/femboypuppy/Tessera-Notes/commit/dd6d49f410eb4adeec0aae65cf8aca56b08c0a96))
- **databases:** pure query engine with filters, sorting, grouping and summaries ([`028adb4`](https://github.com/femboypuppy/Tessera-Notes/commit/028adb4a92256a75264e60f78b7b6ce393c4be5e))
- **graph:** a Graph view entry in the sidebar ([`8bc165f`](https://github.com/femboypuppy/Tessera-Notes/commit/8bc165f4b3e6dcdb3bfe5877643ad18889d5c157))
- **graph:** global and local graph views with sigma.js ([`02ee7e4`](https://github.com/femboypuppy/Tessera-Notes/commit/02ee7e453df5e58769c3a281ed9f6c4ada0ca330))
- **backlinks:** backlinks panel, unlinked mentions and optional footer ([`c7343c5`](https://github.com/femboypuppy/Tessera-Notes/commit/c7343c582b3204c523086a90d3d50e0d35dbf884))
- **search:** command palette, search page and test hooks ([`f9a8355`](https://github.com/femboypuppy/Tessera-Notes/commit/f9a8355b0ab6fbf29d90903695863b318bc78120))
- **search:** MiniSearch and graph link indexes in a persisted worker ([`e0cfa1c`](https://github.com/femboypuppy/Tessera-Notes/commit/e0cfa1c302764db623df5a0b071d30fa31bc7768))
- **editor:** remote cursors, selection toolbar and reliable undo ([`4729a24`](https://github.com/femboypuppy/Tessera-Notes/commit/4729a247bdab75f5c9b1fa21c5bc15f02787fa17))
- **editor:** copy as HTML and markdown, paste through the markdown codec ([`233f002`](https://github.com/femboypuppy/Tessera-Notes/commit/233f00245313c1e50e99703d6c56f6198f654333))
- **editor:** page links, tags, link previews and URL paste ([`2a3d158`](https://github.com/femboypuppy/Tessera-Notes/commit/2a3d158da4897f3e45561a29c8d34a14d02f931f))
- **editor:** slash menu, block handle with drag, block menu and rich blocks ([`a02aa4f`](https://github.com/femboypuppy/Tessera-Notes/commit/a02aa4fec5abc84570449201a3637bfdb90e3356))
- **editor:** TipTap editor on the page doc with the canonical schema ([`2d6ff7e`](https://github.com/femboypuppy/Tessera-Notes/commit/2d6ff7e19329f19f99fe0e7dccfef75a620948a6))
- **sync:** Hocuspocus sync provider, background replication, presence, settings and version history ([`0eb26fd`](https://github.com/femboypuppy/Tessera-Notes/commit/0eb26fd64fd202c323813da8943e2df8f9634feb))
- **server:** Hocuspocus sync server with SQLite, auth, roles, invites and assets ([`76c7300`](https://github.com/femboypuppy/Tessera-Notes/commit/76c7300e5e643a93544024b6248e0a694c139bc3))
- **sync:** IndexedDB doc, asset and workspace stores with multi-tab sync ([`f08b08e`](https://github.com/femboypuppy/Tessera-Notes/commit/f08b08e247d51ad628a24addb6c1ceeb2de6f3bd))
- **testkit:** seeded workspace generator, runtime and React helpers, Playwright fixtures ([`3af8a92`](https://github.com/femboypuppy/Tessera-Notes/commit/3af8a928a973ead18011e9c7250450bb056cb688))
- **core:** extension points for overlays, page footers, bare routes and workspace switching ([`c9d4867`](https://github.com/femboypuppy/Tessera-Notes/commit/c9d4867d07f617d457d1713e3fcaa85889bcce58))
- **web:** app shell, ui components, e2e specs and screenshots ([`6181b22`](https://github.com/femboypuppy/Tessera-Notes/commit/6181b228b6721b15fdd872cb01aaa13556c61e0c))
- **core:** service interfaces, stubs, runtime and service resolution ([`dbaf31d`](https://github.com/femboypuppy/Tessera-Notes/commit/dbaf31d1e7f99bfc871f102aafc4ebbf9a86ea37))
- **core:** canonical document schema and DocJSON utilities ([`7355fbb`](https://github.com/femboypuppy/Tessera-Notes/commit/7355fbbea7143fd87f85826fed5d20ae566e6f1b))
- **core:** data model helpers for pages, databases and plugins ([`19830ca`](https://github.com/femboypuppy/Tessera-Notes/commit/19830caa76857c8bb90186f90a50de5ebcd1e519))

### Bug fixes

- **docs:** vitepress dev renders again (pre-bundle mermaid) ([`0ef3004`](https://github.com/femboypuppy/Tessera-Notes/commit/0ef3004af4ad1df47d02772ba4e391b07ccd4a08))
- **docs:** move the docs site to Vite 6.4.3 and esbuild 0.25 ([`11aeb7a`](https://github.com/femboypuppy/Tessera-Notes/commit/11aeb7a9bd9f2a329cfadce04f308ae6b91da59f))
- **release:** the notes put @-words in code instead of mentioning users ([`1ed1f04`](https://github.com/femboypuppy/Tessera-Notes/commit/1ed1f04a6aaee8cf99d3ba80a9ea4abc7bc162a6))
- **web:** answer /robots.txt with rules instead of the app's page ([`f86990b`](https://github.com/femboypuppy/Tessera-Notes/commit/f86990b8e0cebf52cce84c671443f44be556c7f3))
- **ui:** reduced motion turns transitions off instead of shortening them ([`ced5e6a`](https://github.com/femboypuppy/Tessera-Notes/commit/ced5e6a86d9f04ae2a2c86ac8f5407992d59b9aa))
- **search:** graph labels never run into each other ([`7326e9b`](https://github.com/femboypuppy/Tessera-Notes/commit/7326e9bb21529fa0210f19206aec2c2a085635a9))
- **search:** the fitted graph stays clear of the controls over it ([`9484239`](https://github.com/femboypuppy/Tessera-Notes/commit/948423903b33002f9c6d96b67c25566f3bdd97a8))
- **editor:** a page link's icon never ends a line on its own ([`8da00e6`](https://github.com/femboypuppy/Tessera-Notes/commit/8da00e6396a955da03a8b312f1d3824483e1068f))
- **web:** the demo workspace appears when it's ready ([`93cfc95`](https://github.com/femboypuppy/Tessera-Notes/commit/93cfc95d9808161955c1c83898e96d30fb542192))
- **importers:** a damaged zip says so instead of "nothing to import" ([`25277b0`](https://github.com/femboypuppy/Tessera-Notes/commit/25277b0260ddd77a88eb42a0e3354c4ff6e671e1))
- **editor:** the caret follows the text when others type in its block ([`7159ae1`](https://github.com/femboypuppy/Tessera-Notes/commit/7159ae107ced1e01d2514d0beaaab213d4e358cd))
- **a11y:** every demo screen meets WCAG AA in both themes ([`c711f9b`](https://github.com/femboypuppy/Tessera-Notes/commit/c711f9b6afbd1e6a03766fba959a02c6558e44f2))
- **web:** a phone top bar with room for the title, wide database pages ([`abdff1e`](https://github.com/femboypuppy/Tessera-Notes/commit/abdff1ea65d69587f577a7b356abfdd0a0ce6720))
- **search:** keep what is typed while the palette loads ([`d342c47`](https://github.com/femboypuppy/Tessera-Notes/commit/d342c4771e18221535752f99e5f648e757dcca0b))
- **search:** open the chosen palette result when the list refreshes ([`b07feb1`](https://github.com/femboypuppy/Tessera-Notes/commit/b07feb1a3ad9c2820bdb37106be6e157a7e48399))
- **markdown:** read the line endings of a code span as spaces ([`7022066`](https://github.com/femboypuppy/Tessera-Notes/commit/702206646eb3637060c81efbb313fecd7dc4c9e0))
- **editor:** run key commands at the caret the browser just moved ([`4cbfd55`](https://github.com/femboypuppy/Tessera-Notes/commit/4cbfd55243a6449ae5019880f07b0cfc215e1517))
- **search:** list the pages when the graph can't use WebGL ([`ade3907`](https://github.com/femboypuppy/Tessera-Notes/commit/ade3907c94c6e42a3ecfd5d94353631c5a05f7ea))
- **sync:** keep versions saved in the same millisecond in save order ([`55f3779`](https://github.com/femboypuppy/Tessera-Notes/commit/55f3779da5a058907a6141c3f378ecfc99d7febb))
- **integration:** search batches, import worker in dev, full build, journeys ([`e04561b`](https://github.com/femboypuppy/Tessera-Notes/commit/e04561b24de7b1369e866fa4ed5abf83f1d13fdc))
- **importers:** keep the page responsive and source times intact during imports ([`9bec645`](https://github.com/femboypuppy/Tessera-Notes/commit/9bec6453c5353bfa3c7acafba74f5b8d35f70afc))
- **desktop:** quick capture follows the workspace open in the main window ([`fcdc1b3`](https://github.com/femboypuppy/Tessera-Notes/commit/fcdc1b393435544fc8e7081beb4213d8b8c80146))
- **plugin-api:** infer settings types from the schema only ([`fa8e1b8`](https://github.com/femboypuppy/Tessera-Notes/commit/fa8e1b8a0c17481fa567cde5805fe7478f2349da))
- **plugins:** measure correctly under reduced motion and match the frame color scheme ([`bff4314`](https://github.com/femboypuppy/Tessera-Notes/commit/bff4314b125bcbe386282ac646c36188eb3009f5))
- **search:** one clear button in the search field; panels explain themselves off a page ([`9d900cb`](https://github.com/femboypuppy/Tessera-Notes/commit/9d900cb2f36add7bde5b3909afcb38f96520d948))
- **backlinks:** highlight the exact mention, and complete the handoff ([`98646a5`](https://github.com/femboypuppy/Tessera-Notes/commit/98646a52a34016ab1fe0ba4b0fdcd78ba9005fc7))
- **editor:** make block operations undo steps of their own ([`2434d24`](https://github.com/femboypuppy/Tessera-Notes/commit/2434d24d2045822b654317474e669ea814900592))
- **editor:** fall back to plain text when HTML paste would lose words ([`803fca3`](https://github.com/femboypuppy/Tessera-Notes/commit/803fca3bdf34585f5b8932f336e4ee1051282285))
- **editor:** keep menu rows while suggestions load and steady the block handle ([`986ce6b`](https://github.com/femboypuppy/Tessera-Notes/commit/986ce6b83bb0007214cbba819f50177cacd083e0))
- **sync:** pull a doc after it closes instead of trusting its live copy ([`250a79d`](https://github.com/femboypuppy/Tessera-Notes/commit/250a79dac5592d94cef29256a6158df7a2fc9ef5))
- **sync:** destroyed or offline sockets no longer reconnect on their own ([`c3180f4`](https://github.com/femboypuppy/Tessera-Notes/commit/c3180f4e62edde535156b1b81dc14de49e30af6c))
- **testkit:** rephrase generator sentences that read awkwardly ([`418bfc3`](https://github.com/femboypuppy/Tessera-Notes/commit/418bfc3a66f41c27ba3cad3e9ee0e3612d9a946e))
- **ci:** pass the lint-staged config as a path ([`b884972`](https://github.com/femboypuppy/Tessera-Notes/commit/b8849726bd42d536269d585a94ce8742419bb9b3))
- **core:** type errors in the sync stub signature and a hook test ([`e7c4824`](https://github.com/femboypuppy/Tessera-Notes/commit/e7c482470bd25632c3b2a1bb6000d7e92e50f330))

### Performance

- **importers:** smaller page batches, and the root page renders on its own ([`f92daee`](https://github.com/femboypuppy/Tessera-Notes/commit/f92daee147681b83b7c8402718e96983c6f14a31))
- **importers:** load the import's code while the dialog shows what it found ([`e7a2390`](https://github.com/femboypuppy/Tessera-Notes/commit/e7a23908ee7813f3f70c08398834281c0a58c454))
- **web:** page tree rows re-render only when what they show changes ([`8ce2d4c`](https://github.com/femboypuppy/Tessera-Notes/commit/8ce2d4ccf1b77d6a6192cf820349e4e3581d99cf))
- **web:** keep Radix tabs, radio groups and the importers' strings out of startup ([`3c8ad9f`](https://github.com/femboypuppy/Tessera-Notes/commit/3c8ad9ff7f2451a2e54e64c1e5397a816654ea2f))
- **db-views:** stick frozen columns only when the table scrolls sideways ([`40c486f`](https://github.com/femboypuppy/Tessera-Notes/commit/40c486fb8d7595fdedc7000b0d8a272440f0922c))
- **web:** keep zod, Radix form controls and full string tables out of startup ([`ace62a7`](https://github.com/femboypuppy/Tessera-Notes/commit/ace62a78d1d07c40207ce224ca99ba18a9aa2194))
- **core:** touch the pages edited in a burst in one transaction ([`244666f`](https://github.com/femboypuppy/Tessera-Notes/commit/244666fc05b52c7ab85a2479d2ed37d1230b003a))
- **core:** validate bulk row values once ([`cb32f8b`](https://github.com/femboypuppy/Tessera-Notes/commit/cb32f8becaee6061a2e3afac419a299a35472a57))
- **plugins:** start the host when the browser is idle, and read the theme only when it changed ([`0edb537`](https://github.com/femboypuppy/Tessera-Notes/commit/0edb53711f552ca7a99f06ca0889476c4d3e1943))
- **databases:** scroll 10k-row tables at 60 fps ([`cd51152`](https://github.com/femboypuppy/Tessera-Notes/commit/cd511528f4ef8515946a8fea7e2b52085b0491a5))
- **graph:** keep 10,000-node graphs fluid, and add performance runs ([`4f8984f`](https://github.com/femboypuppy/Tessera-Notes/commit/4f8984fa0a3a7da11e56372301d6176ad516baf8))
- **editor:** don't re-render the editor while the page title is typed ([`9f429b9`](https://github.com/femboypuppy/Tessera-Notes/commit/9f429b97f2dc3cd9184331b9c92a58adb3785e55))
- **editor:** keep typing and dragging fast on long pages ([`961a6c2`](https://github.com/femboypuppy/Tessera-Notes/commit/961a6c22d696b246764b27c7b50914f8d6ef4dd5))
- **sync:** local workspaces load no sync-provider code; heavy tests run last ([`5cffcf3`](https://github.com/femboypuppy/Tessera-Notes/commit/5cffcf3194063d930700df4e4280cf382c664493))

### Documentation

- how to allow the unsigned desktop apps on their first launch ([`e0c5737`](https://github.com/femboypuppy/Tessera-Notes/commit/e0c57374a40d8e5d22e07d55a5818d588b523923))
- the issues are filed (#1–#55), so ISSUES_TO_FILE.md goes ([`1ce757f`](https://github.com/femboypuppy/Tessera-Notes/commit/1ce757f4d3d536b8db2bce1218c6cf86bfab0bea))
- **polish:** handoff with the first-run audit, checks, release checklist and notes ([`c0d1fc0`](https://github.com/femboypuppy/Tessera-Notes/commit/c0d1fc0927e115728e478693b495aa3e2875752a))
- the changelog for 0.1.0, highlights first ([`8f9ef47`](https://github.com/femboypuppy/Tessera-Notes/commit/8f9ef4743bce890a0990c732fc914ccdf5a32245))
- **demo:** record the README demo again with the final graph ([`edec8ef`](https://github.com/femboypuppy/Tessera-Notes/commit/edec8ef77fa95a5cd43fed16040c4c295c3bab6d))
- name the demo button as the app does, and retake the docs site shots ([`5fc5feb`](https://github.com/femboypuppy/Tessera-Notes/commit/5fc5febcf7e7cc4f4241106f591ef191adb1f239))
- **screenshots:** retake every screenshot, and the first-run audit ([`49fe4a5`](https://github.com/femboypuppy/Tessera-Notes/commit/49fe4a5a97997bdea87c9d1fbb1a5f09aa7245f0))
- **readme:** feature pictures from the demo workspace ([`8b0bda8`](https://github.com/femboypuppy/Tessera-Notes/commit/8b0bda8a049c6c18a5b98e057e0ff0e068fdd59b))
- **spec:** motion at 150–200 ms and the contrast rule ([`705fd93`](https://github.com/femboypuppy/Tessera-Notes/commit/705fd93c718f9388f3475de45788e1f2e4e12424))
- the issues to file after the first release ([`700db4c`](https://github.com/femboypuppy/Tessera-Notes/commit/700db4c5f1d5b6d7abee2cabd5f244c713f8eed3))
- **scripts:** the memory soak and the changelog's --intro ([`b891724`](https://github.com/femboypuppy/Tessera-Notes/commit/b891724740132c3251afda31494347df5dbb6e4d))
- the quickstart says where the owner's setup code is ([`057f398`](https://github.com/femboypuppy/Tessera-Notes/commit/057f3987305cc93c5dfc5b839961b709b4b3e3b8))
- **demo:** unwrap the demo notes and drop titles repeated as headings ([`f8e6dc5`](https://github.com/femboypuppy/Tessera-Notes/commit/f8e6dc5fc39b72d7ddeb0b11c506f73cef9f6925))
- **integration:** the timed specs, frozen columns and the Firefox COOP hang ([`136c1a7`](https://github.com/femboypuppy/Tessera-Notes/commit/136c1a788a8c2ef5fbda5bfbf465cf5ad4465b64))
- **integration:** what the first CI runs on GitHub found ([`7094eb0`](https://github.com/femboypuppy/Tessera-Notes/commit/7094eb0781f44ba101be404a467d008ab4063057))
- **integration:** final verification ([`b82827a`](https://github.com/femboypuppy/Tessera-Notes/commit/b82827adb49ab9906ab3551b968b5d2878b4a76c))
- **integration:** the palette regression and the graph numbers ([`ea14918`](https://github.com/femboypuppy/Tessera-Notes/commit/ea14918f49fe40afbee4e9dce0d7538335069059))
- **integration:** handoff, security review, benchmarks and issues ([`2e84361`](https://github.com/femboypuppy/Tessera-Notes/commit/2e8436146c927988812af509cddcba2c0770d2dd))
- **screenshots:** retake the editor shots with sync merged ([`853ac8d`](https://github.com/femboypuppy/Tessera-Notes/commit/853ac8d10cbf2b66e15b0b48b814f5e6e70dc24d))
- **integration:** merge plan, contract change verdicts and follow-ups ([`02a3ace`](https://github.com/femboypuppy/Tessera-Notes/commit/02a3acee1fd98e9813871ea498a73429e4b42b46))
- **readme:** GitHub-native README ([`85a3298`](https://github.com/femboypuppy/Tessera-Notes/commit/85a3298c01a1e12c1210e0c6e67cd7449ea53283))
- **readme:** honest alt text for the demo placeholder and a calmer plugins heading ([`07be8fb`](https://github.com/femboypuppy/Tessera-Notes/commit/07be8fb740d30b2c5b3929564c9ac810dab6c178))
- **handoff:** complete the docs handoff; strict screenshot mode for the README spec ([`43976d6`](https://github.com/femboypuppy/Tessera-Notes/commit/43976d665d8493568012de50fc6d7656f19c0681))
- launch kit and the built-with-agents write-up ([`1a6c3a0`](https://github.com/femboypuppy/Tessera-Notes/commit/1a6c3a0cb91769dc140bd245f49246c21d6bfeae))
- README with features, quickstart, comparison and roadmap ([`39c0da6`](https://github.com/femboypuppy/Tessera-Notes/commit/39c0da68937c5bae5fe54d9a561f4197f693ee40))
- **importers:** record the final 2,000-note timings ([`c0279d5`](https://github.com/femboypuppy/Tessera-Notes/commit/c0279d5e5d5a09bbacd6bd512a3b366c807cfb1c))
- **importers:** list the restore and drop tests in the handoff ([`d472d15`](https://github.com/femboypuppy/Tessera-Notes/commit/d472d1542e2b2da0c2194ea429d76b58cb8efb77))
- **desktop:** handoff with Windows installers, capture follow and merge notes ([`b46bb8f`](https://github.com/femboypuppy/Tessera-Notes/commit/b46bb8f11cce3c4874bfcd0652b1959ca2f55b1d))
- **plugins:** getting started, permissions, publishing and a generated API reference ([`9270f96`](https://github.com/femboypuppy/Tessera-Notes/commit/9270f96044b68a9509ad5eafc268c0f7620c7f36))
- **databases:** exact results of the run with the editor merged ([`39c81ab`](https://github.com/femboypuppy/Tessera-Notes/commit/39c81abfdc8cde29401b76af2df3a46b6790eeb3))
- **databases:** complete the handoff ([`1c61c7b`](https://github.com/femboypuppy/Tessera-Notes/commit/1c61c7bbee8b735d01d9533559dff7b42a15b48f))
- **search:** record the green root test run ([`a126ff1`](https://github.com/femboypuppy/Tessera-Notes/commit/a126ff153057480847dc9303f38ada1eb3cededc))
- **search:** note slow shell tests for the merge ([`9496aa2`](https://github.com/femboypuppy/Tessera-Notes/commit/9496aa2ec9f9d4346a300e55d4851fb16b41faca))
- **search:** record the last full e2e run ([`951224c`](https://github.com/femboypuppy/Tessera-Notes/commit/951224ce418e752682f9438fff7f2e0e7e004ffd))
- **search:** final screenshots and handoff ([`ef2206d`](https://github.com/femboypuppy/Tessera-Notes/commit/ef2206d3883cf48b96fe4d0f85f4d227fc258e30))
- **search:** correct the test file count ([`b9ad879`](https://github.com/femboypuppy/Tessera-Notes/commit/b9ad8797526944eb3c2a2fb6451da5d51c008d1d))
- **search:** update the handoff ([`855fe07`](https://github.com/femboypuppy/Tessera-Notes/commit/855fe07ec1b4e220c078d8f9d9c1669e0756537a))
- **editor:** measured typing ranges in the handoff ([`6c1e496`](https://github.com/femboypuppy/Tessera-Notes/commit/6c1e49687fd883425a645c0a74dc522c95d20c44))
- **editor:** complete the handoff ([`9af3366`](https://github.com/femboypuppy/Tessera-Notes/commit/9af336676257c147d706b9d493ecfc6040b8b4a4))
- **editor:** screenshots of the slash menu, a rich page, link preview and toolbar ([`7ce7d19`](https://github.com/femboypuppy/Tessera-Notes/commit/7ce7d193a9f1b0e695129fffc9fd90c76b06db32))
- **sync:** note that cross-tab latency is the durable-commit latency ([`46a69b9`](https://github.com/femboypuppy/Tessera-Notes/commit/46a69b9a2af68283c058530c50a50c53957d31cf))
- **sync:** record SyncSocket and the open-doc replication rule ([`cab3b0f`](https://github.com/femboypuppy/Tessera-Notes/commit/cab3b0f7efb0fdd96ed3f0ccb750736872712254))
- **sync:** record the load-sensitive Architect tests seen in full runs ([`3787694`](https://github.com/femboypuppy/Tessera-Notes/commit/3787694a0227643c9af7bf9aeb2ccd3e8fc1a629))
- **sync:** complete the handoff; stop shadowing vitest's test in history tests ([`cd2cb9e`](https://github.com/femboypuppy/Tessera-Notes/commit/cd2cb9e7245136202ea2653e469b352dca82c06e))
- **sync:** screenshots of sync status, presence, history and connecting a server ([`e545d54`](https://github.com/femboypuppy/Tessera-Notes/commit/e545d546a6d58abf8a2c7c92a359e68b0cb01fd4))
- **ci:** record the pre-commit hook timing in the handoff ([`2983e8d`](https://github.com/femboypuppy/Tessera-Notes/commit/2983e8daaedd7838b14352452f7002430bc098b8))
- **ci:** record the history merge and the Linux verification in the handoff ([`71e739a`](https://github.com/femboypuppy/Tessera-Notes/commit/71e739ac1f9370ce57daedab4865f90bdb2dbd2e))
- **testkit:** usage README; keep local bench results out of the working tree ([`ebd159b`](https://github.com/femboypuppy/Tessera-Notes/commit/ebd159b0fc0644475b23fb968a82062bc2e34294))
- **ci:** CODEOWNERS, security policy, funding placeholder and seeded screenshots ([`be95a0e`](https://github.com/femboypuppy/Tessera-Notes/commit/be95a0ebbaf3b2bfe020f6d3c643ac0b3065d318))
- SPEC, handoff notes for every agent, and accurate commands ([`ff8a7bf`](https://github.com/femboypuppy/Tessera-Notes/commit/ff8a7bf224af15a5286b54000620711840640b0e))

<details>
<summary><strong>Maintenance</strong> (49)</summary>

- **desktop:** pass only the signing secrets that are set, and ad-hoc sign macOS ([`b14add9`](https://github.com/femboypuppy/Tessera-Notes/commit/b14add9123757778a7d72d3a93561cbddbb54e71))
- **desktop:** wait for the picker's lazy chunk under a full test run ([`e3f2475`](https://github.com/femboypuppy/Tessera-Notes/commit/e3f2475271f532b31a29bf2641c9aa5012b6dff8))
- **polish:** type after a link the way people do, and no hover in the last shot ([`11e0c6f`](https://github.com/femboypuppy/Tessera-Notes/commit/11e0c6f4b6b3fd432e2f057b1ad837a599bf9d5f))
- **importers:** give the demo import a minute in the screenshots ([`842965b`](https://github.com/femboypuppy/Tessera-Notes/commit/842965b8e738f0ec39a560bbacff129de793fb6f))
- **desktop:** embed the updater's public key when update bundles are signed ([`54c0cca`](https://github.com/femboypuppy/Tessera-Notes/commit/54c0ccaca94904750cbdfd763ed51bf7c1197afc))
- **scripts:** a ten-minute memory soak of editing the demo workspace ([`029bd2d`](https://github.com/femboypuppy/Tessera-Notes/commit/029bd2d80a5e083803e3144351e1311095046d4e))
- **release:** hand-written highlights above the generated release notes ([`26238c6`](https://github.com/femboypuppy/Tessera-Notes/commit/26238c6931dbdbfd61c614b47493d5ffca3d52d1))
- **release:** version 0.1.0 ([`629c33a`](https://github.com/femboypuppy/Tessera-Notes/commit/629c33a7620a26c8a39f67512aaf4c96081231b9))
- **bench:** time the graph and the import the way people meet them ([`97e1232`](https://github.com/femboypuppy/Tessera-Notes/commit/97e123219c5274f7dee5cda5017acb3e2d0a0ff3))
- **polish:** the first-run audit, design and robustness specs ([`416db9d`](https://github.com/femboypuppy/Tessera-Notes/commit/416db9da5c56c18f3ca954f5c6f546a5d051c952))
- **testkit:** kill the test server and bring it back with its data ([`446492e`](https://github.com/femboypuppy/Tessera-Notes/commit/446492ebfac2964fd0f9c5ccbcd6afca8e6f3206))
- **ui:** motion takes 150 to 200 ms and eases out ([`06e428f`](https://github.com/femboypuppy/Tessera-Notes/commit/06e428fad8cd404e4c79bae5e3b885da80641726))
- **e2e:** keep Firefox from swapping browsing contexts for COOP ([`d5346c0`](https://github.com/femboypuppy/Tessera-Notes/commit/d5346c0a517f3db3df2d874773f31741a2bdb56d))
- **e2e:** time the `@perf` specs alone, after the rest ([`888e253`](https://github.com/femboypuppy/Tessera-Notes/commit/888e253b7bfe0668c83bbd8cae613f101841d1d0))
- **e2e:** let Chromium fall back to SwiftShader on its own ([`6957c1d`](https://github.com/femboypuppy/Tessera-Notes/commit/6957c1daaad9f2e7e1aae63ff9200692f2a0fdb9))
- **e2e:** software WebGL only for the specs that draw the graph ([`621c183`](https://github.com/femboypuppy/Tessera-Notes/commit/621c1835ed97b9f58cd8f3fe228cd4ec69522869))
- **e2e:** draw WebGL in software on the Linux runners ([`7c4c2d9`](https://github.com/femboypuppy/Tessera-Notes/commit/7c4c2d907dc586e88e4275f5127b09022ffb3eac))
- **importers:** map demo attachment URLs to files with URL APIs ([`2b540ee`](https://github.com/femboypuppy/Tessera-Notes/commit/2b540eed1e0eaf6ca9c2d9aeec6bf6cef6e6116c))
- **testkit:** a server of its own for each collaboration test ([`2248969`](https://github.com/femboypuppy/Tessera-Notes/commit/224896927e641550295b5f3b46cb24e16a6d0d25))
- **journeys:** enter the server address after the app's own pre-fill ([`1943870`](https://github.com/femboypuppy/Tessera-Notes/commit/19438703bfc3a2b8d418edf8744342514c39b6e6))
- give the jsdom-heavy test projects a 15 s timeout ([`cc6f0dc`](https://github.com/femboypuppy/Tessera-Notes/commit/cc6f0dc60ccb2de75af9791258223d63a080b98e))
- **import-export:** check the feature's commands, overlay, route and entry points ([`b86d163`](https://github.com/femboypuppy/Tessera-Notes/commit/b86d163463f417cd88606e6e1f21c4e0b80cae91))
- **importers:** restore a backup through the dialog, drop a Notion zip in the browser ([`ec604ca`](https://github.com/femboypuppy/Tessera-Notes/commit/ec604ca2b6da52d9fe5c114f8354ceadb8465e73))
- **desktop:** e2e with Tauri mocked, component tests, Linux build in Docker ([`da75173`](https://github.com/femboypuppy/Tessera-Notes/commit/da75173770e034dda68d875c422d018a67d8dbd6))
- **plugins:** folder install in both browsers, the crash notification's Restart; complete handoff ([`97de755`](https://github.com/femboypuppy/Tessera-Notes/commit/97de7556d6815c25290464322a9bc4dc17d91a2f))
- **plugins:** e2e journeys, sandbox checks and screenshots ([`222f6a9`](https://github.com/femboypuppy/Tessera-Notes/commit/222f6a9b1dc3ba3fc05278447e20049c47b25c19))
- **databases:** wait for the editor before typing the slash command ([`3f68bdc`](https://github.com/femboypuppy/Tessera-Notes/commit/3f68bdcc0c06e96cfc30ba1f18157b9621ed56bf))
- **databases:** drop the unused table library and tidy view plumbing ([`ecb0a64`](https://github.com/femboypuppy/Tessera-Notes/commit/ecb0a6435975570253eedbcaea6071f766802d5e))
- **databases:** e2e specs for tables, views, CSV, inline databases and scroll performance ([`39eb2b9`](https://github.com/femboypuppy/Tessera-Notes/commit/39eb2b90b40bae02e6bc552cf4138eef068114e3))
- **search:** feature registration tests for search, graph and backlinks ([`3a32629`](https://github.com/femboypuppy/Tessera-Notes/commit/3a32629475825569553722a69747fbf54f90b0d8))
- **search:** graph, layout, palette, backlinks and search page tests ([`c4206d8`](https://github.com/femboypuppy/Tessera-Notes/commit/c4206d87b12d1461c200b5fc07f4e1ba5987a10e))
- **editor:** keep Home clear of ProseMirror's post-focus selection reset ([`8d02964`](https://github.com/femboypuppy/Tessera-Notes/commit/8d0296402032ba01f0d8b501affda3d70f210713))
- **editor:** drop unused TipTap and y-prosemirror dependencies ([`3e0950f`](https://github.com/femboypuppy/Tessera-Notes/commit/3e0950f567f7aa0953e1f47fc852dda868664583))
- **editor:** keyboard block operations, toolbar keyboard access and phone width ([`21baaa4`](https://github.com/femboypuppy/Tessera-Notes/commit/21baaa45095aa419e01ede823973958e494b4bcc))
- **editor:** performance test on a 2,000-block page ([`7138978`](https://github.com/femboypuppy/Tessera-Notes/commit/713897821fe56070c3181b0bc1a63af35d271c82))
- **editor:** e2e for slash menu, drag, links and clipboard ([`579d0f0`](https://github.com/femboypuppy/Tessera-Notes/commit/579d0f0d223fae33682eb6b7a1fc25706f17d527))
- **server:** use tsdown's deps.alwaysBundle instead of deprecated noExternal ([`af7fa78`](https://github.com/femboypuppy/Tessera-Notes/commit/af7fa78f7bf20082183f32a3c3583d93025c67f7))
- **server:** converge through background passes; allow slow server starts ([`0fe02fd`](https://github.com/femboypuppy/Tessera-Notes/commit/0fe02fdd08b7488a0f0bf2f0104135aff0eb74c5))
- **sync:** phone width and keyboard access of the sync settings and status ([`676f16c`](https://github.com/femboypuppy/Tessera-Notes/commit/676f16cd10e02e4ea242bdbd89de69a151cc60c8))
- **server:** load test with 50 concurrent clients editing shared pages ([`b609148`](https://github.com/femboypuppy/Tessera-Notes/commit/b6091487d810746dc240b8503f4770c4b978ba02))
- **sync:** drop an unused import in the screenshot script ([`01bfa40`](https://github.com/femboypuppy/Tessera-Notes/commit/01bfa4021ce965a828968de8c0d7be730bc6a60e))
- **sync:** e2e for two-person sync and presence, offline, reload, tabs and history ([`26db00f`](https://github.com/femboypuppy/Tessera-Notes/commit/26db00f4af1d4ec81c39a1528d7aea6d98e4e477))
- **testkit:** give process-spawning setup room on busy machines ([`a3b0e3d`](https://github.com/femboypuppy/Tessera-Notes/commit/a3b0e3d60edb8bdee9201b8352f459c4a52881ee))
- give jsdom tests room under coverage, document the scripts and the handoff ([`df3a99b`](https://github.com/femboypuppy/Tessera-Notes/commit/df3a99b54dda6492f36aba98977690d2cd02d8be))
- **ci:** commit-msg and lint-staged pre-commit hooks ([`e7e1c9d`](https://github.com/femboypuppy/Tessera-Notes/commit/e7e1c9d7e31bde4e14a253b544a0d4f5836e4749))
- **ci:** journeys, benchmarks, per-route bundle report, axe checks and Lighthouse ([`187e424`](https://github.com/femboypuppy/Tessera-Notes/commit/187e424da29387225002cf9993d2f03a679e9641))
- add CI, desktop, docker, docs, release, CodeQL and labeler workflows ([`48e174b`](https://github.com/femboypuppy/Tessera-Notes/commit/48e174bca50f65b0975687cf78239a7c119e90f2))
- license Tessera under MIT ([`ffde8e0`](https://github.com/femboypuppy/Tessera-Notes/commit/ffde8e0da35d1004f4cd80e7d4915dabe1027d92))
- scaffold the pnpm monorepo skeleton ([`58718b0`](https://github.com/femboypuppy/Tessera-Notes/commit/58718b06e65443aecfb704650ddb84e5fbc12fb5))

</details>

### Other changes

- add prompts ([`af57fbe`](https://github.com/femboypuppy/Tessera-Notes/commit/af57fbe1429fef436c74eab52b1632e0e5f5330a))

**Full changelog:** https://github.com/femboypuppy/Tessera-Notes/commits/v0.1.0
