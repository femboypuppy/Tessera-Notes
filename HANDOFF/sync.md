# Sync handoff

Agent 03 (Storage & sync), branch `feat/sync`. Owns `packages/sync`, `apps/server`,
`apps/web/src/features/sync`, `e2e/sync`, `assets/screenshots/sync`.

## Plan

Milestones from `agents/03-sync.md`, in order; each ended typechecked, linted, tested and committed.

1. **M1 Browser persistence**: IndexedDB doc store (durable group commits, race-free compaction,
   background compaction, multi-tab `watch`, quota toasts), asset store (content addressed,
   revoked object URLs), workspace registry; registered at priority 50. ✅ `8fd786c`
2. **M2 Server**: Hocuspocus + SQLite (every update stored before it is acknowledged), accounts,
   sessions, first run, invites, roles enforced on the server, HTTP API, assets, config, security,
   serves the web app, backup/restore, graceful shutdown. ✅ `8ed1d07`
3. **M3 Client sync**: Hocuspocus provider (one socket, backoff with jitter, statuses), background
   replication of closed docs and an outbox, presence, status indicator, "Sync & account". ✅ `4e79493`
4. **M4 Version history**: automatic and saved versions, local and on the server, history panel with
   preview, restore as a new edit with undo, deletion with the page. ✅ `4e79493`
5. **Acceptance**: fuzz test, restart/crash/compaction/restore tests, auth and asset tests, e2e,
   load test, screenshots. ✅ `370b617`…`bd02b58`

## Built (what exists and where)

### `packages/sync` (the browser side)

| Path | What |
|---|---|
| `src/idb/` | Promise helpers over IndexedDB (`transactionDone` resolves only on commit), the per-workspace database schema (`tessera-ws-<id>`: `updates`, `assets`, `versions`, `syncState`, `outbox`), `BroadcastChannel` wrapper. |
| `src/stores/doc-store.ts` | `IndexedDbDocStore` (see Decisions). `storeRemoteUpdate` for server-originated updates; `onStorageError`/`storageError()` for the UI. |
| `src/stores/asset-store.ts` | `IndexedDbAssetStore`: SHA-256 IDs (dedup), ArrayBuffer storage, object URLs pinned by `getUrl` for the session or leased by `retainUrl` (revoked when the last lease ends), revoked on `delete`/`dispose`; with a `RemoteAssets` it queues uploads and downloads missing assets once, then keeps them. |
| `src/stores/workspace-registry.ts` | `IndexedDbWorkspaceRegistry` (`tessera-registry` DB, cross-tab notifications, `remove` deletes the workspace database). Also hosts the desktop credential store's object store. |
| `src/stores/sync-state.ts` | `SyncStateStore`: per-doc `{ dirty, version, serverSeq }` and the persistent outbox; `markDirtyInTransaction` for the doc store. |
| `src/client/` | `ServerApi` (typed, every response validated with zod, `ServerApiError` with `status 0` = unreachable/CORS), URL helpers, `CredentialStore` (IndexedDB by default, replaceable with `setCredentialStore`). |
| `src/provider/hocuspocus-provider.ts` | `HocuspocusSyncProvider` (see Decisions): per-doc `SyncHandle`s with awareness, aggregate status (`TesseraSyncStatus` adds `readOnly`, `serverUrl`, `backgroundPending`), `retry()`, `setLocalChangeHandler`. |
| `src/provider/socket.ts` | `SyncSocket` (also `@tessera/sync/socket`): Hocuspocus's shared WebSocket without zombie reconnects (see Decisions). |
| `src/provider/replicator.ts` | `BackgroundReplicator`: pushes dirty docs, pulls docs whose server `seq` moved, drains the outbox (deletions, asset uploads, version uploads). |
| `src/history/` | `LocalVersionStore` (IndexedDB), snapshot helpers (`contentOf`, `restoreInto` with a `Y.UndoManager` on the restore origin), `HistoryService` (auto versions 3 min after edits start, dedup, list merged with the server's, restore). |
| `src/feature/` | `syncServices` (registrations), `activateSync` (storage health, server sync, history, `sync.saveVersion` command, debug hooks), `startJoin` (onboarding), invite-link capture, `window.__tesseraSync` test hooks (device setting `sync.debug` only). |
| `src/ui/` | `entry.tsx` (Suspense + `lazy` wrappers, the only UI code in the startup path), `SyncStatusIndicator`, `PresenceAvatars`, `history/HistoryPanel` + `DocPreview` (read-only renderer of the whole schema), `settings/*` (connect flow, account forms, connected workspace, storage protection). |
| `src/i18n/` | `en.ts` (whole namespace, lazy) and `registration.ts` (6 strings the registration needs at startup). |

### `apps/server`

| Path | What |
|---|---|
| `src/config.ts` | zod-validated environment with plain-language errors (every variable documented in `README.md`). |
| `src/db/database.ts` | better-sqlite3, WAL, `synchronous=NORMAL`, migrations; tables for users, sessions, workspaces, members, invites, docs, doc_updates, deleted_docs (tombstones), versions, assets. |
| `src/sync/persistence.ts` | `DocPersistence`: append-only update log, compaction in one transaction, compaction sweep, doc listing with sequence numbers, deletion with tombstone. |
| `src/sync/sync-server.ts` | `SyncServer`: Hocuspocus over `ws` on the shared HTTP server; auth, read-only viewers, per-message session checks, socket closing on revocation/role change, awareness identity rewrite and client-ID ownership, synchronous persistence in `afterLoadDocument`. |
| `src/auth/` | argon2id (OWASP parameters), hashed random tokens, `AuthService` (sliding sessions, timing-equalized login, revocation events), `RateLimiter`. |
| `src/workspaces/workspace-service.ts` | Workspaces, members, roles (last owner protected), invites (expiry, max uses, revoke, atomic accept that never downgrades). |
| `src/assets/` | `AssetService` (streaming upload with a byte limit, SHA-256 check, atomic rename, strict paths) and `sniff.ts` (magic-byte allowlist, HTML and executables refused). |
| `src/versions/version-service.ts` | Server-side versions (validated as Yjs updates, idempotent, newest 100 automatic kept). |
| `src/http/` | Hono app: request log, security headers, CORS, auth, CSRF, routes (`auth`, `workspaces`, `invites`, `assets`), static web app with CSP and SPA fallback. |
| `src/cli/` | `backup`/`restore` (tar.gz, online SQLite backup, safe extraction, previous data kept aside), `create-owner`, prompts. |
| `src/main.ts`, `src/server.ts`, `src/lock.ts`, `src/logger.ts` | CLI, assembly, `DATA_DIR` lock, pino. |
| `scripts/load-test.ts` | The load test (results below). |
| `README.md` | Everything an operator needs: every variable, first run, roles, API, sync, backup, security. |

### Tests

- `packages/sync` (47): doc store (durability, crash, group commit, exact compaction, concurrent
  compaction from two tabs, background compaction, deletion, quota, DocManager retry, multi-tab with
  no duplicate writes, load/watch race), asset store, registry, runtime persistence across a reload,
  quota toast, history (auto/dedup/manual/restore/undo/concurrent undo/deletion/pruning), API client,
  UI (status, presence, preview safety, user agents).
- `apps/server` (77): config, HTTP/auth (18), workspaces and invites (8), assets (9), sync
  authorization (13), persistence (6), **crash** (kills the server process), client integration
  with the real provider and DocManager (9), `SyncSocket` against a real server (2), **convergence fuzz** (3 seeds × 4 devices × 160 random
  steps with random disconnects and doc closes), backup/restore and create-owner (4).
- `e2e/sync/sync.spec.ts` (7 specs, Chromium and Firefox): reload persistence; two tabs without a
  server; two people seeing each other's changes and presence within a second; offline and back
  online; status popover; history save/preview/restore/undo; phone width and keyboard.

### Load test (`pnpm --filter @tessera/server load-test`)

Windows 11, 12 CPUs, Node 24.15, server from source as its own process, 50 clients in the load
generator process, each on its own WebSocket:

| Measure | Result |
|---|---|
| Clients / shared pages | 50 / 5 (10 per page) |
| Edits made | 4474 in 30.4 s (147 edits/s, about 1,330 deliveries/s) |
| Deliveries measured | 40266 of 40266 expected (none lost) |
| Propagation latency p50 / p95 / p99 / max | 120 / 502 / 1042 / 1521 ms |
| Time to acknowledge everything after the last edit | 139 ms |
| Pages identical on every client | 5 of 5 |
| Pages identical on the server (fresh reader) | 5 of 5 |
| Authentication errors | 0 |
| Database size after the run | 0.36 MB (compaction kept it small) |
| Load generator CPU | 15.5 s over 30 s |

The latency includes the load generator itself: all 50 clients share one Node event loop, which
was about half busy, so the numbers are pessimistic for real clients. Every edit reached every
other client and everything converged.

## How it plugs in (FeatureModule entries, services, extension points used)

`apps/web/src/features/sync/index.ts` registers only:

- **services** (`@tessera/sync` → `syncServices`), priority 50, all through dynamic imports:
  `workspaceRegistry` `indexeddb`, `docStore` `indexeddb` (`trackSync` when the workspace has a
  `serverUrl`), `assetStore` `indexeddb` (with the server as remote when connected), `syncProvider`
  `hocuspocus` (`isAvailable` only when `workspace.serverUrl` is set and `WebSocket` exists).
- **topBarItems** `sync-status`; **pageHeaderActions** `presence`; **pageSidePanels**
  `PANELS.history` (pages only); **settingsPanels** `sync` ("Sync & account");
  **onboardingActions** `join-server`.
- **activate**: storage-health toasts, silent persistent-storage request (Chromium only), server
  sync (replicator, deletions, account ID as `SETTING_KEYS.userId`, account rename on display-name
  change), history service, command `sync.saveVersion`, test hooks.
- Events used: `page.deleted` (server deletions, local history), `doc.changed` (auto versions),
  `settings.changed`. `ctx.switchWorkspace` after connecting, uploading, opening or disconnecting.
- Diagnostics show `workspaceRegistry: indexeddb`, `docStore: indexeddb`, `assetStore: indexeddb`,
  `syncProvider: local` (local workspace) or `hocuspocus` (connected).

## Decisions (and why)

- **Every stored update is durable before it is acknowledged, on both sides.** The browser store
  resolves `storeUpdate` from the transaction's `complete` event with `durability: 'strict'`, and
  group-commits updates of one tick. The server writes each update to SQLite synchronously inside
  the Yjs transaction, before Hocuspocus sends the acknowledgement; `crash.test.ts` kills the server
  process and finds every acknowledged update. SQLite runs WAL + `synchronous=NORMAL`: an OS crash
  could drop the newest commits, and clients resend anything the server lacks on reconnect.
- **Compaction can't race writes.** Browser: read, merge (GC through a scratch doc), delete and
  rewrite inside one readwrite IndexedDB transaction, which IndexedDB serializes against every other
  writer (also other tabs). Server: one synchronous SQLite transaction on the single JS thread.
  Tested with interleaved writes from two tabs and 2,000 random writes with random compactions.
- **Multi-tab**: broadcast only after commit (never before durability); receivers apply with
  `STORE_ORIGIN`, so they never write twice. Messages that arrive between `load` and `watch` are
  buffered and replayed. With a server, a tab can still receive the server's copy of another tab's
  edit before the broadcast and store it once more; Yjs merges it idempotently and compaction removes
  it (documented rather than solved with a cross-tab leader).
- **Background replication.** Offline edits to docs that were closed before the connection came
  back would otherwise wait until someone reopened them. Every stored local update marks its doc
  dirty in the same transaction; the replicator pushes dirty docs and pulls docs whose server
  sequence number moved (so the device has everything offline), with compare-and-set so an edit
  made during a sync is never marked synced. A doc that is open is left to the live connection and
  its sequence number is not recorded: a broadcast counted in it may still be in flight when the
  doc closes, so the first pass after it closes pulls it (a cheap state-vector handshake).
- **`SyncSocket` instead of the bare `HocuspocusProviderWebsocket`.** When a connection drops,
  Hocuspocus 4.7 schedules `setTimeout(() => this.connect())`, and `connect()` sets
  `shouldConnect` back to true. A socket destroyed (workspace switch, sign-out) or disconnected for
  going offline before that timer fires reconnected anyway and retried forever (found through a
  leaked timer in the crash test; tested in `client.test.ts` `SyncSocket`). `SyncSocket` ignores
  `connect()` after `disconnect()`/`destroy()`; the provider reconnects with `resume()`. Worth
  reporting upstream.
- **Server doc names are `<workspaceId>/<docName>`**: membership of the workspace in the name is
  the authorization, and page IDs can't collide across workspaces.
- **Auth**: the web app uses the httpOnly `SameSite=Lax` cookie (only accepted on WebSockets and
  unsafe requests from allowed origins: CSWSH and CSRF); the desktop app gets a bearer token. The
  first run needs a setup code printed in the server log, so a stranger can't claim a fresh server.
- **Viewers** get Hocuspocus read-only connections; the server refuses their updates including
  hand-crafted ones (tested with raw protocol messages). Sessions are re-checked on every message;
  revoking a session or changing a role closes the affected sockets at once.
- **Presence identity** is rewritten by the server to the signed-in account, and a connection may
  only speak for awareness client IDs it introduced.
- **Deleted docs get a tombstone** on the server, so a straggling client can't recreate them.
- **Assets**: the server serves the sniffed type, never HTML or executables; everything but media
  downloads as an attachment with a sandboxing CSP. Asset IDs stay content hashes end to end.
- **History** snapshots are Yjs states (exact, compact) read back with `readDocJSON`. Restore is a
  minimal-diff `writeDocJSON` plus page props as one transaction with its own origin; undo uses a
  `Y.UndoManager` tracking only that origin (other people's later edits survive), and the
  pre-restore content is saved as a "Before restore" version first. Versions upload through the
  outbox, so offline versions reach the server later.
- **Persistent storage** is requested silently only where the browser never asks the person
  (Chromium). Firefox would show a permission prompt on first load (and, in automation, an open
  prompt blocks closing the browser context), so everywhere else it is a button in Settings.
- **Hono + `ws`** share one HTTP server with Hocuspocus (the Hocuspocus `Server` class wasn't used).
- **The server serves the web build** from `WEB_DIR` or `apps/web/dist` next to it, with a CSP whose
  `connect-src` allows other servers (a workspace may sync with a server other than the one serving
  the app).
- **`start` builds then runs** (`tsdown && node dist/main.js`) so it works from a clean checkout
  with only `DATA_DIR`; production images run `node apps/server/dist/main.js`.
- **Dependencies**: added `ws` (8.21.3, MIT, already in the lockfile) as a server runtime
  dependency; dev-only `@hocuspocus/provider`, `@tessera/sync`, `fake-indexeddb`, `lib0` for server
  tests; `@testing-library/react`/`user-event` for sync UI tests. Removed the unused
  `@hocuspocus/extension-database` and `y-indexeddb` (a doc-bound provider that doesn't fit the
  `DocStore` contract).
- **Bundle**: the registration imports only tiny wrappers, 6 strings and two icons; everything else
  is lazy. Startup JS (entry + its static imports) measured 220.7 KB gzip after `vite build`
  (budget 250). `activate` loads the Hocuspocus provider, the replicator and the zod schemas only
  for workspaces that have a server; local workspaces load the stores and history only.
- **Test ordering**: the `sync` and `server` Vitest projects set `sequence.groupOrder` (1 and 2),
  so their real servers, child processes and fuzzing run after the other projects instead of
  competing with their timing-sensitive tests. Their own timeouts are raised (20 s, 30 s) in their
  own configs because they start real servers and IndexedDB-backed runtimes.

## Contract change requests (exact proposed diff to packages/core, and why)

1. **Read-only pages for viewers.** Viewers can type locally; the server refuses the changes, so
   they stay on that device. The provider already reports `readOnly`; the contract and the shell
   should make pages read-only. Workaround now: the status shows "View only" and explains it.

   ```diff
   --- a/packages/core/src/services/sync-provider.ts
   +++ b/packages/core/src/services/sync-provider.ts
   @@ export interface SyncStatusInfo {
      /** Local updates not yet acknowledged by the server. */
      pendingUpdates?: number;
   +  /** The server gave this device a read-only connection (viewer role): edits stay local. */
   +  readOnly?: boolean;
    }
   --- a/apps/web/src/app/pages/PageView.tsx
   +++ b/apps/web/src/app/pages/PageView.tsx
   -  const readOnly = trashed;
   +  const syncStatus = useSyncStatus(ctx.services.syncProvider);
   +  const readOnly = trashed || syncStatus.readOnly === true;
   --- a/apps/web/src/app/TopBar.tsx
   +++ b/apps/web/src/app/TopBar.tsx
   -  const readOnly = usePages().isTrashed(pageId ?? '');
   +  const viewOnly = useSyncStatus(ctx.services.syncProvider).readOnly === true;
   +  const readOnly = usePages().isTrashed(pageId ?? '') || viewOnly;
   ```
   (The title textarea and page menu actions should follow `readOnly` too.) Delete nothing on my
   side: `TesseraSyncStatus` then simply narrows the core type.

2. **Releasing asset URLs.** `getUrl` URLs live for the session; a way to release them lets
   long sessions with many images free memory. `IndexedDbAssetStore.retainUrl` already implements it.

   ```diff
   --- a/packages/core/src/services/asset-store.ts
   +++ b/packages/core/src/services/asset-store.ts
      getUrl(assetId: string): Promise<string | null>;
   +  /** A URL held until `release()` (object URLs are revoked once nobody holds them). */
   +  retainUrl?(assetId: string): Promise<{ url: string; release(): void } | null>;
      getInfo?(assetId: string): Promise<AssetInfo | null>;
   ```

3. **Tell the store where an update came from** (optimization). The `DocManager` stores remote
   updates like local ones, so docs that only received remote changes are handshaken once more by
   the background sync. Workaround: harmless extra handshake.

   ```diff
   --- a/packages/core/src/services/doc-store.ts
   +++ b/packages/core/src/services/doc-store.ts
   -  storeUpdate(docName: string, update: Uint8Array): Promise<void>;
   +  storeUpdate(docName: string, update: Uint8Array, options?: { remote?: boolean }): Promise<void>;
   --- a/packages/core/src/runtime/doc-manager.ts
   +++ b/packages/core/src/runtime/doc-manager.ts
   -        if (origin !== STORE_ORIGIN) this.persist(entry, update);
   +        if (origin !== STORE_ORIGIN) this.persist(entry, update, !transaction.local);
   ```
   (and `persist` passes `{ remote }` to `storeUpdate`; retries merge local and remote as local).

## Known gaps and bugs

- **Offline cold start**: the app shell isn't cached (no service worker), so reloading while offline
  shows the browser's offline page; all data is in IndexedDB and appears on the next online load.
- **Cross-tab latency is the durable-commit latency**: a tab broadcasts an update only after its
  `durability: 'strict'` IndexedDB commit. Usually well under a second; once, on a machine whose
  disk and CPU were saturated by other jobs, Firefox took over the e2e spec's 2 s (8 repeats
  afterwards all passed).
  A service worker belongs to the shell (see follow-ups). The e2e offline test therefore doesn't
  reload while offline.
- Viewers can still type locally (see contract change 1); their changes never reach the server.
- A page deleted permanently on another device: each replication pass drops the local docs of every
  page the workspace records as deleted for good (`deletedPageIds`, from `permanentlyDeletedPageIds`),
  also when they have nothing to sync, and never a page that is only missing here (#10).
- Version history covers pages, not database docs (no core helper replaces a database doc's
  structure as a new edit); the panel says so for databases.
- Version previews use `DocPreview` (my read-only renderer), not the editor.
- Desktop bearer tokens are stored in IndexedDB until Agent 07 registers a keychain store.
- The server has no admin UI for accounts (password reset is `create-owner` for the first account
  only); asset files are never garbage-collected on the server.
- Pre-existing, not mine: the Architect's `packages/ui` `EmojiPicker … picks` and
  `apps/web` `App.test.tsx` (`onboards, then creates, renames, trashes and restores a page`, run
  with `features: []`, so no sync code) run close to Vitest's 5 s default and time out
  (5.1 to 5.7 s) whenever the machine's CPU is saturated, even with only the `ui` and `web`
  projects running. Neither file differs from the Architect's handoff. Suggest a `testTimeout`
  for those projects or a longer timeout on those two tests. Firefox e2e likewise can hang on a
  first navigation or `newPage` when several workers share a saturated machine (Architect and
  sync specs alike); `--project=firefox --workers=1` passes all of them (13 + 7).
- Test hooks: `window.__tesseraSync` exists only when the device setting `sync.debug` is `true`
  (the e2e fixture sets it); it reads and writes page content through the normal doc handles.

## Follow-ups for the merge (cross-agent wiring you couldn't finish alone)

- **Editor (Agent 02)**: render remote cursors from `handle.sync.awareness` (`user.{id,name,color}`
  and `cursor.{anchor,head}` as y-prosemirror relative positions; the server rewrites `user` to the
  account). Then add the full-editor version of `e2e/sync/sync.spec.ts` "two people…" (type in the
  editor instead of `appendParagraph`), and replace `packages/sync/src/ui/history/DocPreview.tsx`
  with the editor's read-only view in `HistoryPanel`.
- **Shell (Architect)**: apply contract change 1 (read-only for viewers); consider a service worker
  that caches the built shell for offline cold starts.
- **Desktop (Agent 07)**: call `setCredentialStore(keychainStore)` from `@tessera/sync/client`
  early in the desktop feature (tokens in the OS keychain). The Tauri doc store wins at priority 100;
  the replicator then marks docs dirty through `setLocalChangeHandler` automatically (no change
  needed), but the Tauri store could implement the same transactional dirty flag for crash safety.
  Docker: build `apps/web` and `apps/server`, run `node apps/server/dist/main.js` with
  `DATA_DIR=/data` (and `WEB_DIR` if the web build isn't at `apps/web/dist` next to the server).
- **Plugins (Agent 06)**: the server's web-app CSP (`apps/server/src/http/static.ts`,
  `WEB_APP_CSP`) has `script-src 'self'` and `frame-src 'self' blob: https:`; check it against the
  plugin iframes (srcdoc iframes inherit the parent CSP) and adjust there.
- **CI (Agent 09)**: the sync e2e starts a real server per worker (`e2e/sync/fixtures.ts`, needs
  `tsx`); `pnpm --filter @tessera/server load-test` can run as a nightly job (exits non-zero on
  lost deliveries or divergence).
- **Docs (Agent 10)**: `apps/server/README.md` documents every variable and the API.
- Re-take `assets/screenshots/sync/*` once the editor is merged (the page body shows the shell's
  placeholder today).

## Screenshots (list of files)

`assets/screenshots/sync/`, 1440×900, each `-light.png` and `-dark.png`
(`pnpm screenshots e2e/sync`):

- `sync-status`: the top bar's status popover of a synced workspace.
- `presence`: Grace Hopper on the same page, with the presence list open.
- `history-panel`: the history panel previewing a saved version.
- `connect-server`: Settings → Sync & account, choosing to upload the workspace or open one.
