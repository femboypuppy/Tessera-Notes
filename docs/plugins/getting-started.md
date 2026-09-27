# Getting started

In five minutes you'll have a plugin running in Tessera with a command, a side panel and a custom
block, reloading every time you save, with tests. You need Node.js 24 and pnpm.

## 1. Create the project

```sh
pnpm create tessera-plugin hello-world
cd hello-world
pnpm install
```

`create-tessera-plugin` asks nothing: the ID comes from the folder name (`hello-world`), the name
from the ID (`Hello world`) and the author from `git config user.name`. Pass `--id`, `--name` or
`--author` to choose them. You get:

| File | What it is |
| --- | --- |
| `manifest.json` | ID, name, version, author, the permissions the plugin asks for, and an emoji icon. |
| `src/main.ts` | The plugin: `definePlugin({ settings, activate, panels, blocks })`. |
| `src/main.test.ts` | Tests against a mocked API that checks permissions like Tessera does. |
| `vite.config.ts` | Builds one file, `dist/main.js`, next to a copy of the manifest. |
| `scripts/dev.mjs` | A dev server for live reload. |
| `scripts/pack.mjs` | Zips `dist/` into a file anyone can install. |

The same project is in the repository as
[`examples/plugin-template`](https://github.com/femboypuppy/Tessera-Notes/tree/main/examples/plugin-template), if you'd rather copy it.

## 2. Run it in Tessera

```sh
pnpm dev
```

This rebuilds on every save and serves the plugin at `http://localhost:5199/`. In Tessera, open
**Settings → Plugins → Install plugin → Load a dev plugin…**, enter that address and select
**Connect**. Tessera shows the permissions the plugin asks for; approve them.

Now open the command palette (<kbd>Ctrl</kbd>+<kbd>K</kbd>, or <kbd>⌘</kbd>+<kbd>K</kbd> on a
Mac) and run **Hello world: Say hello**. Open a page and select the 👋 button in the top bar: the
panel shows the page you're on.

Change the greeting's default in `src/main.ts` and save. Tessera reloads the plugin within a
second, and the command says the new text. The plugin's page in Settings → Plugins has a
**Console** tab with everything it logs, and every error it throws.

## 3. How a plugin is put together

```ts
import { definePlugin } from '@tessera/plugin-api';

export default definePlugin({
  settings: {
    greeting: { type: 'string', label: 'Greeting', default: 'Hello from Hello world 👋' },
  },

  // Runs in a background worker when the plugin starts. Register everything here.
  activate(api) {
    api.commands.register({
      id: 'say-hello',
      title: 'Say hello',
      run: () => api.ui.notify(api.settings.get('greeting')),
    });
    api.ui.addPanel({ id: 'page', title: 'Hello world', icon: '👋' });
  },

  // Each panel renders in its own sandboxed frame. `ctx.root` is an empty, themed element.
  panels: {
    async page(ctx) {
      const show = async (pageId: string | null) => {
        const page = pageId ? await ctx.api.pages.get(pageId) : null;
        ctx.root.textContent = page ? `You are on ${page.title || 'Untitled'}` : 'Open a page';
      };
      await show(ctx.pageId);
      // Returning the unsubscribe function cleans up when the panel closes.
      return ctx.onPageChange((pageId) => void show(pageId));
    },
  },
});
```

Three things to know:

- **Everything goes through `api`.** Plugins never see the app's memory, DOM or storage. Each
  call is checked against the permissions the user granted, and one without permission rejects
  with a `PluginError` whose message you can show as is.
- **`activate`, each panel and each block run separately.** They share no variables. Share state
  through `api.storage` and its `onChange`, as the Pomodoro example does.
- **Panels and blocks are styled like the app.** Their frames load Tessera's fonts and design
  tokens as CSS variables (`var(--tess-accent)`, `var(--tess-fg-muted)`, …), and plain `button`,
  `input` and `select` elements already look native, in light and dark mode.

## 4. Add a custom block

Custom blocks are inserted from the slash menu (type `/`), live in the page with the rest of its
content, and sync with collaborators. Ask for the permission in `manifest.json`:

```json
"permissions": ["pages:read", "ui:commands", "ui:panels", "ui:blocks"]
```

Then register the block in `activate` and render it in `blocks`:

```ts
import { defineBlock, definePlugin } from '@tessera/plugin-api';

export default definePlugin({
  activate(api) {
    // …the command and panel from before
    api.ui.addBlock({
      type: 'counter',
      title: 'Counter',
      description: 'A button that counts its clicks',
      icon: '🔢',
      initialData: { count: 0 },
    });
  },
  blocks: {
    counter: defineBlock<{ count: number }>((ctx) => {
      let count = ctx.data?.count ?? 0;
      const button = ctx.root.ownerDocument.createElement('button');
      const show = () => {
        button.textContent = `Clicked ${count} ${count === 1 ? 'time' : 'times'}`;
        button.disabled = ctx.readOnly;
      };
      button.addEventListener('click', () => {
        count += 1;
        show();
        // One undoable edit, saved in the page.
        void ctx.setData({ count });
      });
      ctx.root.append(button);
      show();
      // Undo, redo and collaborators change the data too.
      return ctx.onChange((state) => {
        count = state.data?.count ?? 0;
        show();
      });
    }),
  },
});
```

Save. Because the plugin now asks for a new permission, Tessera asks you to approve it before
reloading. Type `/counter` in a page and press <kbd>Enter</kbd>. The block's frame grows and
shrinks with its content by itself.

Block data is JSON (at most 64 KB) and comes back exactly as you saved it, but treat it as
untrusted: anyone who can edit the page can change it. Check its shape before using it.

## 5. Test it

```sh
pnpm test
```

Tests run the plugin against [the test harness](./api.md#testing): an in-memory workspace with the
permissions you list, where calls without permission reject just like in Tessera. Panels and
blocks render into real DOM elements.

```ts
// @vitest-environment jsdom
import { createTestHarness } from '@tessera/plugin-api/testing';
import { expect, it } from 'vitest';
import plugin from './main';

it('counts clicks and saves them in the block', async () => {
  const harness = createTestHarness(plugin, {
    permissions: ['ui:commands', 'ui:panels', 'ui:blocks'],
  });
  await harness.activate();
  const block = await harness.renderBlock('counter', { data: { count: 2 } });
  block.root.querySelector('button')?.click();
  await harness.flush();
  expect(block.data).toEqual({ count: 3 });
  expect(block.root.textContent).toBe('Clicked 3 times');
});

it('needs permission to add blocks', async () => {
  const harness = createTestHarness(plugin, { permissions: ['ui:commands', 'ui:panels'] });
  await expect(harness.activate()).rejects.toThrow('doesn’t have permission to add custom blocks');
});
```

## 6. Share it

```sh
pnpm pack
```

This writes `hello-world-0.1.0.zip`. Anyone can install it with **Install plugin → From a file
(.zip)…**. To list it in the Browse tab, see [Publishing](./publishing.md).

## Working from a clone of the Tessera repository

Until `create-tessera-plugin` and `@tessera/plugin-api` are published to npm, create plugins
inside a clone of the repository, next to the examples:

```sh
pnpm --filter create-tessera-plugin build
node packages/create-tessera-plugin/dist/cli.js examples/plugins/hello-world
pnpm --filter @tessera/plugins build:examples hello-world
```

This builds `examples/plugins/hello-world/dist`: install that folder with **Install plugin →
From a folder…** (or the zip next to it with **From a file**). Root `pnpm test` runs the
plugin's tests with the others.

## Next

- The [API reference](./api.md) lists everything `api` can do.
- [Permissions and security](./permissions.md) explains what users are asked to allow.
- The [examples](https://github.com/femboypuppy/Tessera-Notes/tree/main/examples/plugins) show complete plugins: the Mermaid block is a good
  model for rich custom blocks, and for keeping a heavy library in a
  [renderer](./publishing.md#heavy-libraries-a-renderer) that all blocks share.
