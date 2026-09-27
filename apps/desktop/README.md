# @tessera/desktop

The Tessera desktop app: a [Tauri 2](https://v2.tauri.app) window running the web app
(`apps/web`), where every workspace is a folder on your computer. It works offline from the first
second, and syncs with a Tessera server when you connect one. **Owner: Agent 07.**

## What it does

- **Workspaces are folders.** `tessera.db` (SQLite: every Yjs update of every page, database and
  the workspace itself), `assets/` (attachments, named by their SHA-256), and an optional
  `markdown/` copy of every page, kept up to date. New workspaces go to `~/Tessera/<name>` (outside
  the folders cloud services sync by default); any folder can be opened or used.
- **Never loses a write.** Every update is committed with `synchronous = FULL` before the editor
  moves on; quitting flushes every window and checkpoints every database first.
- **Cloud-synced folders** (Dropbox, iCloud Drive, OneDrive, Google Drive, Box, Syncthing,
  Nextcloud, pCloud, MEGA) are detected: Tessera warns before using one, switches SQLite to a
  rollback journal there, and finds the "conflicted copies" those services create. Because the
  database is a CRDT update log, a conflicted copy **merges back losslessly** (Settings → Desktop).
- **Native app**: menus (File, Edit, View, Window, Help, plus the app menu on macOS) translated
  with the app's strings, window size and position remembered, single instance, a tray icon,
  `tessera://open/<pageId>` links, zoom, full screen.
- **Quick capture**: a global shortcut (default `Ctrl/Cmd+Shift+Space`, configurable) opens a
  small always-on-top window that appends to an Inbox page; `[ ] item` lines become tasks.
- **Updates** from GitHub Releases, signed; **server tokens** in the OS keychain.

## How it fits together

```
apps/desktop
├── src-tauri/                 Rust: the Tauri app
│   ├── src/lib.rs             plugins, windows, events, the exit flush, deep links
│   ├── src/commands.rs        every command the web side calls (IPC)
│   ├── src/db.rs              tessera.db: update log, compaction, assets, merge
│   ├── src/workspace.rs       open workspaces (lazy folder creation), assets, markdown mirror
│   ├── src/config.rs          workspaces.json, preferences.json, servers.json (atomic writes)
│   ├── src/cloud.rs           cloud-sync detection, conflicted copies
│   ├── src/menu.rs            menus from the web side's description
│   ├── src/windows.rs         main window, quick-capture window, tray, global shortcut
│   ├── src/protocol.rs        tessera-asset:// (attachments of open workspaces)
│   ├── src/secrets.rs         keychain
│   ├── src/updater.rs         GitHub Releases updater
│   ├── capabilities/          what each window may call (main, capture)
│   ├── icons/                 app icons (generated from icons/source.svg)
│   └── tauri.conf.json        app config (CSP, bundles, deep links, updater)
└── src/                       TypeScript, loaded by apps/web/src/features/desktop
    ├── feature.ts             the FeatureModule (services, routes, commands, panels)
    ├── backend/               the typed IPC layer (tauri-backend.ts ↔ commands.rs)
    ├── stores/                TauriDocStore, TauriAssetStore, TauriWorkspaceRegistry
    ├── picker/ settings/ sidebar/ capture/   UI
    ├── menu/ mirror/ updates/ workspace/     menus, markdown mirror, updates, folder flows
    └── testing/fake-tauri.ts  a fake Tauri runtime (unit tests and e2e)
```

`apps/web/src/features/desktop/index.ts` imports `src/feature.ts` only when `isTauri()`; in a
browser the desktop feature is empty and nothing of this package is downloaded.

Storage uses **the app's own Rust commands over `rusqlite`**, not the SQL plugin: updates travel
as raw bytes (the plugin would send JSON arrays of numbers), compaction replaces rows up to a
sequence number in one transaction, and merging a conflicted copy is a single SQL pass.

## Develop

Prerequisites: Node 24, pnpm 11, Rust (stable), and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
pnpm --filter @tessera/desktop dev:app      # tauri dev: Vite dev server + the app
pnpm --filter @tessera/desktop test         # TypeScript unit tests (Vitest, Tauri faked)
pnpm --filter @tessera/desktop test:rust    # Rust unit tests (cargo test)
pnpm test:e2e e2e/desktop                   # the web side in a browser, Tauri faked
```

Environment variables (portable setups and tests): `TESSERA_CONFIG_DIR` (where the app keeps
`workspaces.json`, `preferences.json`, `servers.json`), `TESSERA_WORKSPACES_DIR` (where new
workspaces go instead of `~/Tessera`).

## Build

```bash
pnpm --filter @tessera/desktop build:app    # tauri build: installers for this OS
```

The bundles land in `src-tauri/target/release/bundle/`.

| OS | Needs | Produces |
|---|---|---|
| **Linux** | `libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev build-essential file` | `.deb`, `.rpm`, `.AppImage` |
| **macOS** | Xcode command line tools. Universal build: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`, then `pnpm tauri build --target universal-apple-darwin` | `.app`, `.dmg` |
| **Windows** | Visual Studio Build Tools (C++), WebView2 (preinstalled on Windows 11) | `.msi`, NSIS `-setup.exe` |

**Linux from any machine with Docker:** `pnpm --filter @tessera/desktop build:linux-docker`
builds the `.deb`, `.rpm`, AppImage and the bare binary in a clean Debian image
(`docker/linux-build.Dockerfile`); they land in `dist/linux/`.

**Smoke test of the real app (Windows):** after
`pnpm --filter @tessera/desktop exec tauri build --debug --no-bundle`, run
`node apps/desktop/scripts/smoke-app.mjs`. It drives the WebView2 window over the DevTools
protocol: onboarding, a page, `tessera.db` on disk, quick capture into the Inbox seen live by the
main window, a `tessera://` link through a second launch, quit and relaunch with the data intact.

### Release builds, signing and updates

Releases are built by CI (`tauri-apps/tauri-action` in `.github/workflows/desktop.yml`, owned by
Agent 09) on tags, with these secrets:

| Secret | What |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The updater key. Generate once with `pnpm --filter @tessera/desktop tauri signer generate -w ~/.tauri/tessera.key`; keep the private key out of the repository. |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | macOS code signing and notarization (optional; unsigned apps need right-click → Open). |
| Windows code signing | Optional: `bundle.windows.certificateThumbprint` or a `signCommand` (Azure Trusted Signing). |

The committed `tauri.conf.json` has a placeholder updater key
(`REPLACE_WITH_TAURI_SIGNING_PUBLIC_KEY`): builds with it report "updates not configured" instead
of failing. For releases, CI merges a config that sets the public key and turns on updater
artifacts:

```bash
pnpm --filter @tessera/desktop tauri build --config '{"bundle":{"createUpdaterArtifacts":true},"plugins":{"updater":{"pubkey":"<contents of tessera.key.pub>"}}}'
```

`tauri-action` with `includeUpdaterJson: true` uploads `latest.json`, which the app reads from
`https://github.com/femboypuppy/Tessera-Notes/releases/latest/download/latest.json`.

## Icons

`src-tauri/icons/` is generated from `src-tauri/icons/source.svg`, the app icon (the leaf mark on
a white rounded square) that `pnpm --dir docs brand` writes from `docs/scripts/brand.ts` before it
runs:

```bash
pnpm --filter @tessera/desktop icons    # tauri icon + removes the mobile sizes
```

Change the icon in `docs/scripts/brand.ts`, not here: `pnpm --dir docs brand` rewrites
`source.svg` (1024×1024, transparent corners) and regenerates every size.
