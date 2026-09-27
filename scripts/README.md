# scripts

Tooling for CI, releases, benchmarks and git hooks. Every CI job calls one of these, so anything CI
checks can be checked on your machine the same way. Scripts under `ci/`, `release/`, `lib/`,
`bundle/`, `lighthouse/` and `git-hooks/` run with plain `node` (Node 24 runs TypeScript directly);
the ones that use the testkit need `pnpm exec tsx`. Their tests run with `pnpm test` (the
`@tessera/testkit` project picks up `scripts/**/*.test.ts`), and `pnpm --filter @tessera/testkit
typecheck` typechecks them.

| Script | What it does |
| --- | --- |
| `pnpm exec tsx scripts/ci/local.ts` | Runs `.github/workflows/ci.yml` on your machine: every job in order, every matrix combination, the same commands. `--event pull_request`, `--job <id>`, `--matrix first`, `--dry-run`, `--workflow <file>`. Summaries land in `node_modules/.cache/ci-local/summary.md`. |
| `node scripts/ci/actionlint.ts` | Lints every workflow with actionlint (downloaded once, checksum verified). Install shellcheck to lint `run:` scripts too. |
| `node scripts/ci/commitlint.ts` | Checks commit messages (`--from <base> --to <head>`), a pull request title (`--title`) or a message (`--message`, `--file`) against Conventional Commits. |
| `node scripts/ci/coverage-summary.ts` | Coverage per package from `pnpm test:coverage`, as a markdown table. |
| `node scripts/bundle/report.ts` | The bundle-size report of `apps/web/dist` (build it first): startup JS against the 250 kB budget from SPEC.md (exits with 1 above it), lazy chunks, and with `--routes` the JS each screen loads (Chromium). `--json <file>` writes the numbers. |
| `pnpm exec tsx scripts/bench/run.ts` | The benchmark suite (cold start with 5,000 pages, search, palette, opening a 2,000-block page, typing latency, graph, importing 2,000 files, and the first open of 5,000 imported notes from IndexedDB) against the real app with a generated workspace, or on its real storage. Prints a table, writes `results.{json,md}` to `node_modules/.cache/bench-results` (or `--out`). `--only <ids>`, `--runs <n>`, `--compare <results.json>`, `--strict`, `--headed` (a visible window, rendering with the GPU). |
| `pnpm record-demo` | Records the README demo (`scripts/record-demo/record.ts`): a scripted ~20 s tour of the demo workspace at 1280×720 in Chromium (a page written with a `[[link]]` and the slash menu, a card dragged on the board, the graph), then ffmpeg makes `assets/demo.mp4` and `assets/demo.gif` (palette generation, at most 8 MB). Builds and serves the app itself, or `--url` a running one; `--keep` keeps the raw video. Needs ffmpeg. |
| `pnpm exec tsx scripts/memory/soak.ts` | The memory soak (SPEC.md §10): edits the demo workspace in Chromium the way a person works (a page written with the slash menu and a `[[link]]`, the palette, the board, backlinks, undo and redo, the trash) for `--minutes` (10), and samples the JS heap after GC, DOM nodes and listeners every `--every` seconds (30). Passes when the heap slope stays under 0.25 MB/min and the DOM ends within 10% of where it started; `--strict` exits with 1 when it doesn't. Writes `results.{json,md}` to `node_modules/.cache/memory-soak`. |
| `node scripts/lighthouse/summary.ts` | Lighthouse scores as a table, after `pnpm dlx @lhci/cli@0.15.1 autorun --config=scripts/lighthouse/lighthouserc.json`. |
| `node scripts/release/changelog.ts` | Release notes from Conventional Commits since the previous `v*` tag (`--to <tag>`, `--heading` for CHANGELOG.md, `--intro <file>` for hand-written highlights above the list). |
| `node scripts/release/github-release.ts` | `verify-version`, `draft`, `checksums` and `publish` steps of `release.yml`. |
| `node scripts/git-hooks/install.ts` | Turns on the git hooks: Conventional Commits on commit messages and ESLint + Prettier on staged files. `git commit --no-verify` skips them. |
