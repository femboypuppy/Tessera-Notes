# Contributing

Thanks for helping! Tessera welcomes code, docs, translations, bug reports, plugins and ideas.
First contributions are very welcome, and every pull request gets a friendly review.

The full guide is [CONTRIBUTING.md](https://github.com/femboypuppy/Tessera-Notes/blob/main/CONTRIBUTING.md)
in the repository. Here is the short version.

## Set up

You need Node.js 24 and pnpm 11 (Corepack installs it).

```bash
git clone https://github.com/femboypuppy/Tessera-Notes.git && cd Tessera-Notes
corepack enable
pnpm install
pnpm dev
```

On Windows, clone into a short folder such as `C:\src`, or run
`git config --global core.longpaths true` first: some test fixtures keep Notion's long file names,
and Git for Windows refuses paths over 260 characters.

## Everyday commands

| Command            | Does                                                 |
| ------------------ | ---------------------------------------------------- |
| `pnpm dev`         | Runs the web app and the sync server together, with hot reload. |
| `pnpm test`        | Runs every unit test (Vitest).                       |
| `pnpm test:e2e`    | Runs the end-to-end tests (Playwright).              |
| `pnpm typecheck`   | Type-checks every package.                           |
| `pnpm lint`        | ESLint and Prettier.                                 |
| `pnpm build`       | Builds everything.                                   |

Run one package with `pnpm --filter @tessera/<name> <script>`, for example
`pnpm --filter @tessera/editor test`.

## Find something to work on

- Issues labeled
  [good first issue](https://github.com/femboypuppy/Tessera-Notes/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  are small, well described and have a pointer to the code.
- Bigger ideas start as a
  [discussion](https://github.com/femboypuppy/Tessera-Notes/discussions) so we can agree on the approach
  before you write code.
- Comment on an issue to claim it, so nobody duplicates your work.

## Understand the code

Read the [architecture guide](./architecture) first. It explains the packages, how an edit flows
from a keystroke to the server, and how every feature plugs into the app.

## Write a plugin instead

Many ideas don't need to change Tessera itself. Plugins add commands, panels and custom blocks,
and you can publish them to the community registry. Scaffold one with:

```bash
pnpm create tessera-plugin my-plugin
```

The plugin guide in these docs walks through it.

## Improve the docs

Every page has an **Edit this page on GitHub** link at the bottom. [Writing docs](./docs) explains
how to preview your changes.
