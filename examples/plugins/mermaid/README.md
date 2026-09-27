# Mermaid diagrams

Type `/mermaid` in a page to insert a diagram written in [Mermaid](https://mermaid.js.org):
flowcharts, sequence diagrams, timelines (Gantt), class and state diagrams, pie charts and mind
maps. Click **Edit** for a live preview next to the source; `Mod+Enter` or `Esc` closes the
editor. Diagrams follow the app’s light and dark theme.

![A Mermaid diagram block](../../../assets/screenshots/plugins/mermaid-block-light.png)

## Permissions

| Permission | Why |
|---|---|
| `ui:blocks` | To add the diagram block. |

That’s all: the diagram’s source is saved in the page (the block’s data), so it syncs, exports
and works offline. The plugin can’t read other pages or reach the internet; Mermaid is bundled.

## How it works

- `activate` registers the block with `api.ui.addBlock`, which puts it in the slash menu with a
  starting diagram (`initialData`).
- `blocks.diagram` renders each block in its own sandboxed frame (`src/block.ts`). It saves edits
  with `ctx.setData({ code })` and follows undo and collaborators with `ctx.onChange`.
- Mermaid isn't in the block's code. The block asks the plugin's **renderer** to draw
  (`ctx.api.ui.render('diagram', { code, theme, width })`), and gets SVG back. The renderer
  (`src/renderer.ts`, `"renderer": "renderer.js"` in the manifest) runs in one hidden frame that
  draws for every block, so a page of diagrams loads Mermaid once, not once per block.
- `src/render.ts` turns Tessera’s design tokens (`api.theme`) into Mermaid theme variables, and
  draws one diagram at a time.
- The build makes two single-file modules (`codeSplitting: false` in `vite.config.ts`):
  `main.js` (about 9 KB) and `renderer.js` (with Mermaid, about 5 MB).

## Develop

```sh
pnpm install
pnpm test    # the renderer is mocked: jsdom can't lay out SVG
pnpm build   # dist/main.js, then dist/renderer.js
```
