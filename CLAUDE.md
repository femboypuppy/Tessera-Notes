# Tessera — working in this repo

Claude Code loads this file in every session in this repo.

**Tessera** is an open-source (MIT), local-first, self-hostable knowledge app: Notion-style blocks
and databases, Obsidian-style `[[wikilinks]]`, backlinks and a graph view, real-time
collaboration, a sandboxed plugin system, desktop apps and one-command self-hosting. It works fully
offline, imports from Notion and Obsidian, and exports to plain markdown at any time.

The bar: fast, calm and polished, and it never loses data.

## Where things are

| Path | What |
| --- | --- |
| `packages/core` | Contracts: types, the document schema, `FeatureModule` and extension points, the runtime, stub services |
| `packages/ui` | Components, design tokens, `t()` |
| `packages/editor` | The block editor (TipTap on Yjs) |
| `packages/sync`, `apps/server` | Storage, sync, collaboration, the server (Hocuspocus, SQLite) |
| `packages/db-views` | Databases: query engine, views, formulas, CSV |
| `packages/search` | Search index, palette, backlinks, graph |
| `packages/plugins`, `packages/plugin-api`, `packages/create-tessera-plugin` | Plugin host, SDK, scaffolder (`examples/plugins`, `examples/plugin-template`) |
| `packages/markdown`, `packages/importers` | Markdown codec, importers and exporters |
| `packages/testkit` | Seeded workspaces, the benchmark harness, Playwright fixtures, CI policy tests |
| `apps/web` | The app shell; `src/features/<area>/index.ts` registers each feature |
| `apps/desktop` | The Tauri desktop app |
| `docs/` | The VitePress site (its own pnpm project and lockfile) |
| `e2e/<area>`, `scripts/`, `.github/` | End-to-end specs, tooling (see `scripts/README.md`), CI and releases |

Read `SPEC.md` for the architecture, contracts and performance budgets.

- `HANDOFF/<area>.md` records how each area was built and why.
- `HANDOFF/integration.md` and `HANDOFF/polish.md` record the merge, the launch checks and the known gaps.
- `agents/` holds the prompts of the parallel build, as history.
- The backlog lives in GitHub issues, labeled by area (`area: editor`, …).

## Architecture rules

- **Plug in, don't patch.** The shell loads each feature through the `FeatureModule` exported from
  `apps/web/src/features/<area>/index.ts`. Routes, commands, panels, page bodies, block renderers,
  services and settings are registered there, not wired into the shell or another feature.
- **Keep feature folders thin.** `apps/web/src/features/<area>/` holds only the registration.
  Components and logic live in the area's package, with its dependencies in that package's
  `package.json`.
- **`packages/core` is the contract.** Change it deliberately: update `SPEC.md` in the same
  change, keep the stub implementations working, and update every implementation that the change
  affects.
- **Globs, not lists.** The build, tests and e2e pick up new packages and `e2e/<area>` folders by
  themselves; root configs rarely need an edit.
- **Dependencies:** prefer what's installed. A new one is small, maintained, MIT/Apache-2.0/BSD/ISC,
  pinned to an exact version, and added to the package that uses it. Say why in the commit.

## Engineering standards

- TypeScript `strict`. No `any` (use `unknown` and narrow). No `@ts-ignore` or `eslint-disable` without a comment explaining why.
- Tests test real behavior: Vitest for units, Playwright for user flows. Never skip, weaken or delete a test to make it pass. A bug fix comes with a test that failed before it.
- No placeholder code in finished work. Unfinished work goes in a GitHub issue, not behind a `TODO`.
- UI uses components and design tokens from `packages/ui`, works in light and dark themes, is fully keyboard-accessible (visible focus, correct ARIA via Radix primitives), respects `prefers-reduced-motion`, and works at phone width.
- All user-facing strings go through `t()` from `packages/ui`.
- Every async UI has loading, empty and error states. Destructive actions are undoable or confirmed.
- Security: sanitize any external HTML with DOMPurify, never render unsanitized HTML, never use `eval` or `new Function`, and validate data at trust boundaries with zod. Text from files, the clipboard, other users or the network is untrusted: no regex whose running time grows faster than its input (CodeQL checks for it).
- Performance: lazy-load heavy features with dynamic `import()` and respect the budgets in `SPEC.md` §10.
- Document state lives in Yjs. Never mirror document content into React state.

## Commands

`pnpm dev` · `pnpm build` · `pnpm test` · `pnpm test:e2e` · `pnpm typecheck` · `pnpm lint` · `pnpm format`

- `pnpm dev` runs the web app (http://localhost:5173) and the server (port 8787, data in `apps/server/data`) together; the app reaches the server through Vite's `/api` and `/sync` proxy. `pnpm --filter @tessera/web dev` runs the app alone.
- `pnpm build` builds every package, the web app, the server and, when Rust is installed, the desktop app (`tauri build --no-bundle`; `TESSERA_SKIP_DESKTOP=1` skips it; installers: `pnpm --filter @tessera/desktop build:app`).
- One package: `pnpm --filter @tessera/<name> <script>` (`test`, `typecheck`, `lint`, `build`). The plugin scaffolder's name is `create-tessera-plugin`.
- E2E: `pnpm test:e2e e2e/<area>` (add `--project=chromium` or `--project=firefox`). First time on a machine: `pnpm test:e2e:install`. `E2E_DEV=1` tests against the dev server instead of a production build.
- Specs that time frames or keystrokes are tagged `@perf` and run alone: `pnpm test:e2e --grep @perf --workers=1`. CI runs them after the rest.
- Screenshots: `pnpm screenshots e2e/<area>` writes `assets/screenshots/<area>/<name>-{light,dark}.png` at 1440×900 (SPEC.md §9.2); the README and docs use these files.
- Docs site: `pnpm --dir docs dev`, `pnpm --dir docs build` (runs its tests first).
- Budgets: `pnpm exec tsx scripts/bench/run.ts`, `node scripts/bundle/report.ts` (after a build), `pnpm exec tsx scripts/memory/soak.ts`; `scripts/README.md` lists the rest.
- `pnpm lint:fix` applies ESLint and Prettier fixes.
- On Windows, a full `pnpm test` sometimes loses the server project's worker (exit code 0xC0000409, issue #5). Rerun it, or run `pnpm --filter @tessera/server test`.

Keep this section accurate when scripts change.

## Git

- Conventional Commits (`fix(editor): keep the caret after undo`), small and focused. The git hooks check the message and run ESLint and Prettier on staged files.
- Never force-push or rewrite pushed history. Push `main` only after `pnpm typecheck`, `pnpm lint` and `pnpm test` pass, then check that CI and CodeQL pass on GitHub.
- Contributors work on branches with pull requests (`CONTRIBUTING.md`).

## Releases

1. Bump the version to `X.Y.Z` in:
   - the app's `package.json` files;
   - `apps/desktop/src-tauri/tauri.conf.json`, `Cargo.toml` and the `tessera-desktop` entry of `Cargo.lock`;
   - `SERVER_VERSION` in `apps/server/src/http/app.ts`;
   - `APP_VERSION` in `packages/plugins/src/constants.ts`;
   - the pinned image tags in `deploy/` and `docs/self-hosting/upgrading.md`.

   Leave `plugin-api` and `create-tessera-plugin` alone unless the plugin API changed.
2. Write the highlights in `.github/releases/vX.Y.Z.md`, each paragraph and list item on one line (GitHub's release page shows every newline as a line break; `scripts/release/changelog.test.ts` checks it). Add a section to `CHANGELOG.md`: the highlights, then `node scripts/release/changelog.ts --to HEAD --repo femboypuppy/Tessera-Notes`, with the compare link pointing at `vX.Y.Z`.
3. `node scripts/release/github-release.ts verify-version --tag vX.Y.Z` must pass. Commit, push, and wait for CI to pass.
4. `git tag vX.Y.Z && git push origin vX.Y.Z`. The Release workflow builds the desktop apps and the Docker image, adds `SHA256SUMS.txt` and publishes the release.

## Definition of done

- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass, and so do the e2e specs of the areas you touched (the `@perf` ones too if timing could change).
- [ ] The change is tested at the right level, and a bug fix has a test that failed before it.
- [ ] The feature is reachable in the running app, not just library code. UI changes were checked in both themes, at phone width and with the keyboard alone.
- [ ] When the UI changed visibly, its screenshots are retaken with realistic content (never lorem ipsum).
- [ ] Docs match the behavior: `docs/` for users, `SPEC.md` for contracts and budgets.
- [ ] Everything is committed, and CI and CodeQL pass after the push.
