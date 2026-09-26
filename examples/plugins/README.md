# Example plugins

Five complete plugins, each with a README and tests. Copy one to start your own, or start from
[`examples/plugin-template`](../plugin-template) with `pnpm create tessera-plugin my-plugin`.

| Plugin | Shows off | Permissions |
|---|---|---|
| [Word count](word-count) 🔢 | A side panel that follows the open page and its edits, a setting | `pages:read`, `ui:panels` |
| [Daily notes](daily-notes) 📅 | Commands with shortcuts, creating pages from markdown, work at startup, settings | `pages:read`, `pages:write`, `ui:commands` |
| [Pomodoro](pomodoro) 🍅 | State shared between a panel and the worker through storage, notifications | `ui:panels`, `ui:commands`, `storage` |
| [Random page](random-page) 🎲 | The smallest useful plugin: one command | `pages:read`, `ui:commands` |
| [Mermaid diagrams](mermaid) 🧜 | A custom block with an editor, data saved in the page, theme-aware rendering | `ui:blocks` |

## Build, test and install

Inside this repository:

```sh
pnpm --filter @tessera/plugins build:examples          # every example
pnpm --filter @tessera/plugins build:examples mermaid  # one
pnpm test                                              # includes the examples' tests
```

Each example builds to `dist/` (`manifest.json`, `main.js`, `README.md`) plus
`dist/<id>-<version>.zip`. Install either in Tessera with Settings → Plugins → Install plugin
(from a file or from a folder).

Outside this repository, each folder is a standalone project: `pnpm install`, `pnpm test`,
`pnpm build`.

## The registry

The docs workflow builds these plugins and publishes their zips with a `registry.json` (in the
[registry format](registry.schema.json)) to `https://femboypuppy.github.io/Tessera-Notes/plugins/`,
the default registry of Settings → Plugins → Browse. Nothing in it is written by hand: each entry
comes from the plugin's `manifest.json`, its tags from [`registry.source.json`](registry.source.json),
its download URL from where the site is published, and its `sha256` from the zip. To try it
locally: `pnpm --filter @tessera/plugins build:registry --out <folder>`. See
[docs/plugins/publishing.md](../../docs/plugins/publishing.md) to list your own plugin.
