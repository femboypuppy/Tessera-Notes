# CI & quality handoff

Agent 09, branch `feat/ci`. Owns `.github/workflows`, `.github/dependabot.yml`,
`.github/CODEOWNERS`, `.github/labeler.yml` (and `.github/FUNDING.yml`, which the agent file asks
for), `packages/testkit`, `scripts/`, `e2e/journeys`, `e2e/support`, `e2e/ci`, `SECURITY.md`,
`assets/screenshots/ci`.

## Plan

All milestones of `agents/09-ci-quality.md` are done and committed:

1. **M1: CI workflows.** `ci.yml`, `desktop.yml`, `docker.yml`, `docs.yml`, `release.yml`,
   `codeql.yml`, `labeler.yml` (+ `.github/labeler.yml`), `bench.yml`, `dependabot.yml`; every
   action pinned to a commit SHA; least-privilege permissions; actionlint, a policy test and a
   local runner (`act` isn't installed here).
2. **M2: `packages/testkit`.** Deterministic seeded generator, runtime and React helpers,
   Playwright fixtures, and a seeded harness app.
3. **M3: journeys, performance, accessibility.** Eight journeys, the benchmark suite with
   `bench.yml`, the bundle report per route with the startup budget gate, axe checks, Lighthouse.
4. **M4: hygiene.** Commit-message linting (hook + CI), a lint-staged pre-commit hook,
   `CODEOWNERS`, `SECURITY.md`, `FUNDING.yml`.

## Built (what exists and where)

### Workflows (`.github/workflows`)

| Workflow | Triggers | What it does |
| --- | --- | --- |
| `ci.yml` | pull requests, pushes to `main`, merge queue, manual | `changes` (dorny/paths-filter: PRs skip jobs whose paths didn't change), `lint` (`pnpm lint`), `actionlint` (workflows + shellcheck), `typecheck`, `unit` (`pnpm test:coverage`, per-package coverage table in the job summary, `coverage` artifact), `build` (`pnpm build`, bundle report with the startup budget gate and JS per route, `web-dist` artifact), `e2e` (Chromium and Firefox × 2 shards, blob reports, traces and screenshots uploaded on failure), `e2e-report` (merged HTML report artifact), `lighthouse` (scores in the job summary, non-blocking), `commits` (PR commits and title against Conventional Commits), `audit` (`pnpm audit --prod --audit-level high`, non-blocking) and `ci`, the one aggregate check to require in branch protection. Concurrency cancels superseded runs. |
| `desktop.yml` | called by `release.yml` on `v*` tags; manual; PRs touching `apps/desktop` or the desktop feature | Tauri bundles for macOS arm64, macOS x64 (cross-compiled on Apple silicon), Windows x64 and Linux x64 (Ubuntu 22.04 for glibc compatibility) with rust-cache. Tag builds upload into the draft release (with `latest.json` for the updater when a signing key exists); other runs upload workflow artifacts. |
| `docker.yml` | called by `release.yml` on `v*` tags; manual (optional push); PRs touching the image | One native build per platform (amd64 on `ubuntu-24.04`, arm64 on `ubuntu-24.04-arm`, no QEMU: emulated arm64 installs could hang for the job's hour, #56), each with its own GHA cache scope and a 12-minute step timeout. When pushing, each build pushes by digest and `merge` tags one manifest list with `docker buildx imagetools create`. Releases push `ghcr.io/<owner>/tessera` for linux/amd64 and linux/arm64 tagged `X.Y.Z`, `X.Y`, `X` (from 1.0) and `latest` (stable only), with provenance and an SBOM. PRs build both platforms and never push. |
| `docs.yml` | pushes to `main` and PRs touching `docs/` or `assets/brand/`; manual | Builds the VitePress site (a standalone pnpm project in `docs/`; VitePress fails on dead links) and deploys it to GitHub Pages from `main`, passing the Pages base path as `DOCS_BASE`. |
| `release.yml` | `v*` tags | Checks the tag against `apps/desktop/src-tauri/tauri.conf.json`, writes the changelog from Conventional Commits since the previous tag, creates a draft release, runs `desktop.yml` and `docker.yml`, uploads `SHA256SUMS.txt`, then publishes. A failure leaves the draft for the owner. |
| `codeql.yml` | pushes and PRs to `main`, weekly, manual | CodeQL `security-extended` for TypeScript/JavaScript, the workflows (`actions`) and Rust (skipped until `apps/desktop/src-tauri/Cargo.toml` exists). |
| `labeler.yml` | PRs (`pull_request_target`, no checkout) | Area labels from `.github/labeler.yml` (one per agent area, plus documentation, tests, dependencies). |
| `bench.yml` | pushes to `main` and PRs touching app code, `scripts/bench` or the lockfile; manual | Runs `scripts/bench`. On `main` the results become the baseline (Actions cache); on PRs they're compared with the latest baseline and posted as one sticky comment. `continue-on-error`: never blocks. |

`dependabot.yml`: npm weekly for the workspace (`/`, `/apps/*`, `/packages/*`) with minor and
patch updates grouped by dependency type, npm weekly for `/docs`, GitHub Actions monthly
(grouped), cargo weekly for `apps/desktop/src-tauri` (Tauri crates grouped), Docker weekly.
Commit messages are Conventional (`build(deps): …`, `ci(deps): …`). No stale bot.

### Scripts (`scripts/`, see `scripts/README.md`)

- `ci/local.ts`: runs `ci.yml` locally (jobs in `needs` order, matrices, `if:`, outputs, env
  files, `continue-on-error`, artifacts through a local folder, path filters say "everything
  changed"). Engine in `packages/testkit/src/ci` (an Actions expression evaluator and runner).
- `ci/actionlint.ts` (pinned actionlint 1.7.12, checksum verified), `ci/commitlint.ts`,
  `ci/coverage-summary.ts`.
- `bundle/report.ts` + `analyze.ts` + `routes.ts` + `budgets.json`: startup JS (entry chunk, its
  static imports, and the boot module `apps/web/src/features/index.ts`, which `main.tsx` always
  awaits) against 250 kB gzip; lazy chunks; `--routes` measures each screen in Chromium.
- `bench/`: the suite (`run.ts`, `benchmarks.ts`, `report.ts`, `stats.ts`).
- `lighthouse/`: `lighthouserc.json` and `summary.ts`.
- `release/`: `changelog.ts`, `github-release.ts` (verify-version, draft, checksums, publish).
- `git-hooks/`: `hooks/commit-msg`, `hooks/pre-commit`, `install.ts`, `lint-staged.config.mjs`.
- `lib/`: `conventional-commits.ts` (parser and linter shared by the hook, CI and the changelog),
  `github.ts` (job summary and annotations).

### `packages/testkit`

| Entry | What it is |
| --- | --- |
| `@tessera/testkit` / `./generator` | `generateWorkspace(options)`: a deterministic workspace (same seed → byte-identical Y.Doc updates and markdown). Six topics from a bundled vocabulary (no network, no lorem ipsum), about √N top-level pages with rich-get-richer subtrees up to `maxDepth`, `[[links]]` with a power-law in-degree (Zipf over a popularity ranking, 60 % within the page's topic), inline and page tags, tasks, tables, callouts, toggles, code, quotes, inline database views, aliases, favorites, trash, covers, icons, and three database templates (project tracker, reading list, meeting notes) that together cover every property type but the reserved `formula`, every view type, and a consistent two-way relation. Output: `workspaceDoc()`, `pageDoc(id)`, `databaseDoc(id)`, `docUpdate(name, workspaceId)`, `markdownFiles()` (Obsidian-style folders, frontmatter, wikilinks, CSV per database), `largePages` with an exact block count and an end marker, `stats()`. 5,000 pages build in about 2 s. |
| `./runtime` | `createTestRuntime`, `createSeededAppContext` (a generated workspace open in an in-memory runtime), `GeneratedDocStore` (lazy, then a normal `MemoryDocStore`), `seedFeature` (a workspace registry and doc store at priority 1000, plugged in like any feature). |
| `./react` | `AppProviders` (app context, tooltips, a `MemoryRouter`, toasts, confirmations) and `renderWithApp(ui, { features, seed, path })`. |
| `./playwright` | Fixtures `app`, `freshWorkspace`, `seededWorkspace` (+ `seedOptions`), worker `syncServer` (a real `apps/server` on a free port, temp `DATA_DIR`, `createOwner`), `collaborators` (two browser contexts + the server); `TesseraApp` shell helpers; `FEATURE_CHECKS`, `requireFeatures` (skips with what's missing and who builds it); `scanAccessibility`/`formatViolations` (axe); `writeZip`/`readZip`; `startHarness`. |
| `./ci` | Workflow loader, expression evaluator, local runner. |
| `harness/` | The seeded harness: `apps/web`'s real `App`, i18n, theme, styles and every registered feature, plus `seedFeature`; `?seed=&pages=&databases=&rows=&large=&trashed=` pick the workspace; `window.__tesseraHarness` exposes timings, the page list, and the `AppContext`. `pnpm --filter @tessera/testkit harness` (dev), `harness:build`, `harness:preview`. |

### End-to-end (`e2e/`)

- `support/index.ts` re-exports the testkit Playwright helpers; `support/journeys.ts` holds the
  selectors for other agents' UIs (editor, palette, side panels, sync settings) in one place.
- `journeys/01-first-session` (onboarding, pages, keyboard nesting, rename, favorites, trash + undo,
  themes; **runs today**), `02-write-and-link` (editor, backlinks), `03-search` (palette: title,
  body text, tags), `04-database` (new database, rows, select property, board, row as page),
  `05-import` (a generated markdown vault as a zip from the first-run screen), `06-export`
  (markdown zip with wikilinks), `07-persistence` (reload, second tab), `08-collaborate-offline`
  (owner via the server CLI, upload and sync, invite link, Bob joins, live edits both ways, Alice
  offline and back online).
- `ci/accessibility.spec.ts`: axe on onboarding, empty workspace, page view, shortcuts overlay,
  trash, settings, the component gallery (both themes), phone width with the drawer, and the
  palette and graph once they exist. Fails on serious and critical issues; known issues in code
  owned by `packages/ui` are listed in `ci/accessibility-baseline.ts` (see Follow-ups).
- `ci/testkit.spec.ts`: the fixtures against the real app, including 5,000 seeded pages.
- `ci/ci.screenshots.ts`: the seeded workspace screenshots.

### Numbers today (skeleton app, this machine and Linux)

- Bundle: startup JS **214.1 kB gzip** of 250 kB (86 %); every screen loads 230–261 kB.
- Benchmarks: cold start with 5,000 pages **806 ms** (median of 3, budget 2 s); search p95
  **30 ms** on 5,000 pages with the naive stub index (budget 50 ms); import of 1,993 files with
  core's basic importer: 81 s in one 83 s main-thread block (the budget wants a worker); palette,
  large page, typing and graph skip until their features merge.
- Pre-commit hook on one staged file: **8.4–10 s** wall at 75–80 % CPU on this machine (i5-10400F,
  shared with eight agents), where ESLint is about 5 s: 4.9 s of CPU, nearly all of it loading
  `typescript-eslint` (2.2 s), `jsx-a11y` (1.1 s) and `react-hooks` (0.5 s); linting the file
  itself takes 0.2 s. Prettier is 0.5 s, lint-staged's backup and restaging about 1.5 s. Not
  measured idle: CPU times here run about 2× their idle cost (all-core clock 3.2 GHz against a
  4.3 GHz single-core boost, shared cores), so expect about 4 s. If contributors find it slow,
  drop the ESLint line from `lint-staged.config.mjs` (CI still lints) or run it through a daemon.

## How it plugs in (FeatureModule entries, services, extension points used)

No feature module: CI has nothing in `apps/web/src/features`. The testkit plugs into runtimes the
same way features do: `seedFeature` is a `FeatureModule` whose `services` register a
`workspaceRegistry` and a `docStore` at priority 1000 (above browser 50 and desktop 100), and its
`activate` hands the `AppContext` to the harness. Journeys and benchmarks detect features through
`window.__tessera.diagnostics()` (contributions, commands, service sources). The harness imports
`apps/web/src/app/App`, `FatalError`, `theme`, `i18n`, `features` and `styles.css` read-only.

## Decisions (and why)

- **Latest action majors, pinned by SHA** (checkout v7.0.1, setup-node v7.0.0, pnpm/action-setup
  v6.1.0, cache v6.1.0, upload-artifact v7.0.1, download-artifact v8.0.1, paths-filter v4.0.3,
  codeql-action v4.38.1, docker actions v4/v6/v7, pages v6/v5/v5, tauri-action v1.0.0,
  rust-cache v2.9.2, labeler v7.0.0, sticky-pull-request-comment v3.0.5). Inputs were checked
  against each version's `action.yml`. A Vitest policy test (`packages/testkit/src/ci/workflows.test.ts`)
  enforces SHA pins with version comments, one pin per action, read-only defaults with explicit
  job permissions, timeouts, `persist-credentials: false`, no inline `${{ github.event.* }}` in
  scripts, no checkout in `pull_request_target`, that every script a workflow runs exists, and
  that the `ci` gate needs every required job.
- **One required check.** Path filters skip jobs on PRs, which would leave required checks pending,
  so branch protection requires only the aggregate `ci` job, which fails on any failed or
  cancelled job and passes on skipped ones. Lighthouse, audit and the merged report inform only.
- **Reusable desktop and docker workflows.** `release.yml` calls them on tags, so one tag produces
  one draft with everything; standalone they also run on dispatch and on relevant PRs.
- **Scripts run with plain Node** where possible (Node 24 strips types), so jobs like actionlint,
  commits and release skip `pnpm install`. Scripts that need the testkit run with `tsx`.
- **actionlint through a script** (pinned version and checksums) instead of a third-party action:
  the same command locally and in CI.
- **A local runner instead of `act`** (not installed), which also runs on Windows; I also ran
  `ci.yml` through it inside a `node:24` Linux container (see Known gaps for results).
- **Generator speed.** `createPage` rebuilds the page index on every call (quadratic: 32 s for
  5,000 pages). The generator creates each subtree of more than 16 pages in a scratch Y.Doc seeded
  only with its root, whose creation uses a client ID of its own so its update stands alone (Yjs
  needs contiguous client histories), then merges the updates: the same data the helpers write,
  about 2 s for 5,000 pages. Databases over 400 rows get the same chunking.
- **Determinism.** Seeded sfc32 PRNG, `fork(label)` streams per page, IDs, timestamps and Y.Doc
  client IDs all derived from the seed; `initDatabaseDoc` mints random IDs, so the title property
  and first view are created first with seeded IDs (it then only stamps the version).
- **`formula` is not generated**: SPEC reserves it until a formula engine exists.
- **The seeded harness** is how benchmarks and seeded fixtures run the real app with 5,000 pages
  without a test hook in the shell (none exists, and the shell is the Architect's).
- **Startup budget counts boot modules.** The feature registrations are a dynamic import that
  `main.tsx` always awaits, so a static-only count would miss heavy registration modules. Gzip is
  zlib's default level; Vite 8's log (Rolldown) shows about 1 % more.
- **Per-route JS** holds back `requestIdleCallback` work during each visit, so Trash and
  Settings preloads don't count against other screens.
- **Benchmarks report budgets, they don't enforce them**: runners are noisy and each budget has an
  owner's test (SPEC §10). `--strict` enforces locally. The PR comparison flags ±10 % changes.
- **Accessibility baseline.** axe found WCAG AA contrast failures in `packages/ui` tokens (not
  mine to change). Instead of weakening the check, the spec fails on any *new* serious or
  critical violation and lists the known ones as annotations; the fix values are below.
- **Lighthouse** runs through `pnpm dlx @lhci/cli@0.15.1` (not a repo dependency: it's large),
  on `/` and `/dev/ui`, desktop preset, warn-level thresholds, scores in the job summary.
- **Git hooks without root changes**: `core.hooksPath` points at `scripts/git-hooks/hooks`;
  commit-msg uses the dependency-free linter, pre-commit runs lint-staged (a testkit dev
  dependency) with ESLint `--fix` and Prettier on staged files. Installing them on `pnpm install`
  needs a root `prepare` script (Follow-ups).
- **New dependencies** (testkit only, exact versions): `@axe-core/playwright` 4.13.0 (MPL-2.0: a
  test-only tool used unmodified, the standard engine behind every Playwright axe integration; no
  permissively licensed equivalent), `lint-staged` 17.5.1 (MIT). Everything else was already in
  the repo at the same versions (`yaml`, `fflate`, `vite`, `@vitejs/plugin-react`,
  `@tailwindcss/vite`, `tailwindcss`, `react`, `react-dom`, `react-router`, Testing Library,
  `@playwright/test`) and is declared by testkit because the harness and helpers import them.

## Contract change requests (exact proposed diff to packages/core, and why)

None. Everything plugs in through existing extension points (service registration, `activate`,
diagnostics).

## Known gaps and bugs

- **`main` was rewritten after this branch started** (same tree, new author email, new hashes,
  no common ancestor). To keep `git merge --no-ff feat/ci` working, `feat/ci` records the new
  `main` as a parent with an `ours` merge (`3a846f7`): nothing changes in the tree (`main` equals
  the old branch point exactly), and `git merge-tree main feat/ci` is clean. Other branches
  started from the old `main` need the same (or `git rebase --onto main a30f580`). A pull request
  from such a branch would show the original history, whose "add prompts" commit fails the
  commit-message check; merging locally, as the merge plan does, avoids that.

- **Journeys 2–8 skip** until their features merge. Their steps follow the feature agents' own
  strings (their `src/i18n/en.ts` as of this writing); after the merge, adjust selectors in
  `e2e/support/journeys.ts` where the final UI differs.
- **Architect-owned jsdom tests time out under load.** With other agents saturating this machine,
  `packages/ui` (EmojiPicker) and `apps/web` (`App.test.tsx`) tests hit Vitest's 5 s timeout,
  especially with coverage; they pass alone. See Follow-ups.
- **Windows-only flakes** (Linux CI unaffected): Playwright's Firefox sometimes hangs closing a
  context (after the test body finished); Lighthouse's chrome-launcher fails deleting its temp
  profile (`EPERM`).
- **The harness preloads what the generator needs** (the database and schema helpers the app
  normally loads lazily), and its doc store is in memory, so cold start measures the app's boot
  from memory, not an IndexedDB read. A persisted variant belongs after the sync merge.
- **Large generated databases** (over 400 rows) may interleave manual row order between chunks
  (still deterministic).
- **Verified on Linux**: `ci.yml` ran through `scripts/ci/local.ts` in a `node:24.15.0-bookworm`
  container (fresh clone, `pnpm install --frozen-lockfile`, browsers with system deps): lint,
  actionlint + shellcheck, typecheck, build with the bundle budget and JS per route, e2e in
  Chromium and Firefox (2 shards each, merged report), Lighthouse (`/`: 100/100/100/91,
  `/dev/ui`: 97/96/100/91 for performance, accessibility, best practices, SEO) and the audit all
  passed; the unit job then failed only on the two Architect jsdom timeouts above, which led to
  `--testTimeout=20000` in CI (see Follow-ups 3). A second Linux run at the final commit, meant to
  confirm that the unit job now passes, was stopped when the shared machine ran out of memory, so
  the first `ci.yml` run on GitHub after the merge is the confirmation.
- **Workflows that only run on GitHub** (desktop, docker, docs deploy, release, CodeQL, labeler,
  Dependabot) were verified with actionlint (+ shellcheck) and the policy test, not executed.
  `desktop.yml` expects `@tauri-apps/cli` in `apps/desktop` (it is) and Agent 07's
  `src-tauri`; `docs.yml` expects `docs/package.json` with a `build` script and `DOCS_BASE`
  (Agent 10's config reads it).

## Follow-ups for the merge (cross-agent wiring you couldn't finish alone)

1. **Install the git hooks on `pnpm install`** (root `package.json`, Architect):
   ```diff
    "scripts": {
   +  "prepare": "node scripts/git-hooks/install.ts",
      "dev": "pnpm --filter @tessera/web dev",
   ```
   (`install.ts` skips in CI, outside git, and when another hooks path is set.)
2. **Fix the contrast tokens, then empty `e2e/ci/accessibility-baseline.ts`** (`packages/ui`):
   light `--tess-fg-subtle: #8f8e8a → #72716d` (4.89:1 on white, 4.55:1 on the sidebar); dark
   `--tess-fg-subtle: #858481 → #8d8c89` (≥ 4.56:1); light `--tess-danger: #dc3e42 → #d93b3f`
   and dark `#e5484d → #d83b40` for white button text; `--tess-tag-green-fg #2f7a4e → #2b764a`,
   `--tess-info-text #0d74ce → #086fc9`, `--tess-tag-gray-fg #6b6a66 → #666561`,
   `--tess-tag-pink-fg #b3437a → #ad3d74`, `--tess-tag-red-fg #c4403a → #bd3933`,
   `--tess-tag-blue-fg #2b6fa8 → #2468a1`, `--tess-tag-orange-fg #b35c1c → #a34c0c`; in
   `feedback.tsx` (Avatar) use dark text (`#1c1c1a`, ≥ 5.6:1) on light user colors instead of
   `text-white`; give the ScrollArea viewport `tabIndex={0}`.
3. **Give the jsdom UI tests room**: `testTimeout: 15_000` in `packages/ui/vitest.config.ts`
   and `apps/web/vitest.config.ts` (or split the long App test).
4. **Journeys**: once every feature is in, remove the `requireFeatures` guards (they only skip
   when something is missing) and fix selectors in `e2e/support/journeys.ts`; the collaboration
   journey expects the sync feature's "Sync & account" panel, "Upload and sync", "Create invite
   link" and a "join" onboarding action.
5. **Benchmarks after the merge**: palette, large page, typing and graph start measuring
   automatically; add a persisted cold start (IndexedDB) once the sync stores exist; compare the
   import benchmark with Agent 08's worker importer.
6. **Regenerate `assets/screenshots/ci`** (`pnpm screenshots e2e/ci`) once the editor renders
   page bodies.
7. **Owner settings** (below).
8. Add `.lighthouseci/` to the root `.gitignore` (Lighthouse CI writes it in the working folder
   when run locally).
9. Optional: add `scripts` to the root `tsconfig.json` `include` (today testkit's `typecheck`
   covers it); the startup bundle already loads core's markdown codec stub on the onboarding
   screen (16 kB beyond the entry), which the Architect may want to defer.

### Owner settings and secrets

| Where | What |
| --- | --- |
| Settings → Branches | Protect `main`: require the **CI** check (the aggregate job) and, if wanted, **Analyze** (CodeQL). |
| Settings → Actions → General | Workflow permissions: "Read repository contents" (each workflow asks for what it needs). |
| Settings → Pages | Source: **GitHub Actions** (docs.yml deploys to the `github-pages` environment). A custom domain changes the base path automatically. |
| Settings → Code security | Enable **private vulnerability reporting** (SECURITY.md relies on it), Dependabot alerts and security updates. Keep CodeQL **default setup off** (codeql.yml is the advanced setup). |
| Packages (GHCR) | Nothing to create: `docker.yml` pushes with `GITHUB_TOKEN` (`packages: write`). After the first release, make the `tessera` package public and link it to the repository. |
| Secrets (optional) | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: signed updater bundles + `latest.json` (generate with `pnpm --filter @tessera/desktop exec tauri signer generate`; the public key goes in `tauri.conf.json`). `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`: macOS signing and notarization. Without them, bundles build unsigned. Windows signing isn't configured (add a certificate to `tauri.conf.json` when available). |
| Releases | Bump `apps/desktop/src-tauri/tauri.conf.json` (and `package.json`) to the version, then push `vX.Y.Z`; `release.yml` refuses mismatched tags. |
| Labels | Created on first use by the labeler; recolor them if you like. |

## Screenshots (list of files)

- `assets/screenshots/ci/seeded-workspace-light.png`, `seeded-workspace-dark.png`: a 300-page
  generated workspace in the real shell (nested pages, favorites, a database), from
  `pnpm screenshots e2e/ci`.
