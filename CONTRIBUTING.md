# Contributing to Tessera

Thanks for being here! Tessera is built in the open, and contributions of every size are welcome:
a typo fix, a bug report, a translation, a plugin, or a whole feature.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

- [Ways to help](#ways-to-help)
- [Set up your machine](#set-up-your-machine)
- [A tour of the repository](#a-tour-of-the-repository)
- [Pick a first issue](#pick-a-first-issue)
- [Make a change](#make-a-change)
- [Commit messages](#commit-messages)
- [Pull request checklist](#pull-request-checklist)
- [Write a plugin](#write-a-plugin)
- [Security issues](#security-issues)

## Ways to help

- **Report a bug** with the [bug report form](https://github.com/femboypuppy/Tessera-Notes/issues/new?template=bug_report.yml).
  Steps to reproduce are the most useful thing you can give us.
- **Suggest a feature** with the [feature request form](https://github.com/femboypuppy/Tessera-Notes/issues/new?template=feature_request.yml).
- **Answer questions** in [Discussions](https://github.com/femboypuppy/Tessera-Notes/discussions).
- **Improve the docs.** Every docs page has an "Edit this page on GitHub" link.
- **Write code**: start with a [good first issue](#pick-a-first-issue).
- **Build a plugin** and share it in the community registry.

## Set up your machine

You need:

- [Node.js 24](https://nodejs.org) (the version is in `.nvmrc`, so `nvm use` works)
- pnpm 11, installed by Corepack
- Git

```bash
git clone https://github.com/femboypuppy/Tessera-Notes.git
cd Tessera-Notes
corepack enable
pnpm install
pnpm dev
```

On Windows, clone into a short folder such as `C:\src`. The Notion import fixtures keep Notion's
real file names, up to 184 characters inside the repository, and Git for Windows refuses paths
over 260 characters ("Filename too long"). To clone deeper than that, turn on long paths first:
`git config --global core.longpaths true`, or for this clone only,
`git clone -c core.longpaths=true https://github.com/femboypuppy/Tessera-Notes.git`.

`pnpm dev` starts the web app (hot reload) and the sync server together — the app proxies `/api`
and `/sync` to the server — and prints the web app's address.

### Everyday commands

| Command                      | Does                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                   | The web app and the sync server together, with hot reload.    |
| `pnpm test`                  | Every unit test (Vitest).                                     |
| `pnpm test:e2e`              | End-to-end tests (Playwright, Chromium and Firefox) against a production build. |
| `pnpm test:e2e:install`      | Installs the Playwright browsers (once per machine).          |
| `pnpm typecheck`             | Type-checks every package.                                    |
| `pnpm lint`                  | ESLint and Prettier. `pnpm lint:fix` fixes what it can.       |
| `pnpm build`                 | Builds every package and app.                                 |
| `pnpm screenshots e2e/<area>` | Regenerates the screenshots for one area.                    |

Run one package with `pnpm --filter @tessera/<name> <script>`, for example
`pnpm --filter @tessera/editor test`. Run one area's end-to-end tests with
`pnpm test:e2e e2e/<area>`; add `E2E_DEV=1` to test against the dev server instead of a build.

### The server alone, and the desktop app

`pnpm dev` already runs the server next to the web app. Run the server alone (with a particular
`DATA_DIR`, for example), or the desktop app, with:

```bash
DATA_DIR=./data pnpm --filter @tessera/server dev   # the sync server, alone
pnpm --filter @tessera/desktop dev:app              # the desktop app (needs Rust, see below)
```

The desktop app is built with [Tauri 2](https://v2.tauri.app/start/prerequisites/). Install Rust
and your platform's prerequisites from that page first.

### The docs site

```bash
pnpm --dir docs install
pnpm --dir docs dev
```

## A tour of the repository

```txt
apps/
  web/            The app shell (React). Loads every feature from src/features/<area>/index.ts
  server/         Sync and API server (Hocuspocus, SQLite, Hono)
  desktop/        Desktop app (Tauri 2)
packages/
  core/           The contract: data model, document schema, service interfaces, runtime
  ui/             Design tokens, components (Radix), i18n
  editor/         Block editor (TipTap)
  sync/           IndexedDB storage, sync provider, presence, version history
  db-views/       Database query engine and views
  search/         Search index, command palette, backlinks, graph
  markdown/       Markdown codec (unified/remark)
  importers/      Notion, Obsidian and markdown importers; exporters
  plugins/        Plugin host (sandboxed iframes)
  plugin-api/     Plugin SDK
  create-tessera-plugin/  Plugin scaffolder
  testkit/        Seeded workspace generator and test helpers
e2e/              Playwright tests, one folder per area
docs/             This project's documentation site (VitePress)
examples/         Example plugins, a plugin template and the demo workspace
assets/           Logo, social preview and screenshots
```

A few ideas make the codebase easy to work in:

- **`packages/core` is the contract.** Types, the document schema, service interfaces and the
  runtime live there. Everything else builds on it. Read [SPEC.md](SPEC.md) for the details and
  the [architecture guide](https://femboypuppy.github.io/Tessera-Notes/contributing/architecture) for
  the overview.
- **Features plug in; they don't patch.** Each feature registers routes, commands, panels, blocks
  and services through one `FeatureModule` in `apps/web/src/features/<area>/index.ts`. The code
  lives in the feature's package.
- **Document state lives in Yjs.** Never copy document content into React state; read it through
  the helpers in `packages/core`.
- **Packages don't import each other**, except `core`, `ui`, and a couple of natural pairs
  (`importers` → `markdown`, `plugins` → `plugin-api`). That keeps features independent.

## Pick a first issue

1. Browse [`good first issue`](https://github.com/femboypuppy/Tessera-Notes/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
   Each one says what to change, where, and how to check it works.
2. Comment "I'd like to take this" so nobody else starts on it. A maintainer assigns it to you.
3. Stuck? Ask in the issue. Questions are welcome; there are no silly ones.

For anything bigger than a small fix, open a
[discussion](https://github.com/femboypuppy/Tessera-Notes/discussions) or an issue first, so we can agree
on the approach before you spend time on code.

## Make a change

1. Fork the repository and create a branch: `git switch -c fix/palette-empty-state`.
2. Make your change, with tests.
3. Run `pnpm typecheck && pnpm lint && pnpm test`, and the end-to-end tests for the area you
   touched.
4. Push and open a pull request. Fill in the template.

### Standards

- **TypeScript strict.** No `any` (use `unknown` and narrow). No `@ts-ignore`; an
  `eslint-disable` needs a comment saying why.
- **Tests test behavior.** Vitest next to the code (`*.test.ts`), Playwright for user flows in
  `e2e/<area>/`. Never skip or weaken a test to make it pass.
- **UI** uses components and tokens from `packages/ui`, works in light and dark themes and at phone
  width, is fully keyboard-accessible, and respects reduced motion.
- **Every user-facing string goes through `t()`**, so it can be translated.
- **Async UI** has loading, empty and error states. Destructive actions are undoable or confirmed.
- **Security:** sanitize external HTML with DOMPurify, validate untrusted data with zod, never use
  `eval` or `new Function`.
- **Performance:** load heavy code with dynamic `import()`, and stay within the budgets in
  [SPEC.md](SPEC.md#10-performance-budgets).
- **Dependencies:** prefer what's already installed. A new one must be small, maintained,
  MIT/Apache-2.0/BSD/ISC-licensed, and pinned to an exact version. Say why in the PR.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org). The release changelog is
generated from them.

```txt
<type>(<scope>): <what changed, in the imperative>
```

- **Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `build`.
- **Scope:** the area, such as `editor`, `sync`, `databases`, `search`, `plugins`, `desktop`,
  `importers`, `core`, `ui`, `web`, `server` or `docs`.

Examples:

```txt
feat(editor): add a copy button to code blocks
fix(sync): retry uploads after a quota error
docs(self-hosting): explain SIGNUP_MODE
```

Small, focused commits are easier to review than one large one.

## Pull request checklist

Before you ask for a review:

- [ ] The PR does one thing, and its description says what and why (with screenshots for UI).
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass locally.
- [ ] New behavior has tests; bug fixes have a test that failed before the fix.
- [ ] UI changes work in light and dark themes, at phone width, and with the keyboard alone.
- [ ] User-facing strings go through `t()`.
- [ ] Docs are updated if behavior changed.
- [ ] Commits follow the convention above.

A maintainer reviews every pull request, usually within a few days. We may suggest changes; that's
normal and not a judgment of your work.

## Write a plugin

Plugins are the easiest way to add something to Tessera without changing its core. They run in a
sandbox, declare the permissions they need, and use a small typed SDK.

```bash
pnpm create tessera-plugin my-plugin
cd my-plugin
pnpm install
pnpm dev
```

The scaffold includes a manifest, source, a build, and tests with a mocked API. Then:

1. Load your plugin in Tessera from **Settings → Plugins** in dev mode, with live reload.
2. Read the plugin guide and API reference in the
   [docs](https://femboypuppy.github.io/Tessera-Notes/plugins/).
3. Look at the example plugins in [`examples/`](examples) for patterns.
4. Publish it to the community registry when it's ready.

## Security issues

Please don't report vulnerabilities in public issues. Follow the security policy in `SECURITY.md`
(or the repository's **Security** tab) to report one privately.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
