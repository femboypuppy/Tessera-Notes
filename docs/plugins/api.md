# Plugin API reference

<!-- Generated from the TSDoc comments in packages/plugin-api by `pnpm --filter @tessera/plugin-api docs:api`. Don’t edit it by hand: a test fails when it is out of date. -->

`@tessera/plugin-api` — the SDK for writing Tessera plugins.

A plugin is an ES module whose default export is `definePlugin({ … })`. Tessera runs it in a
sandbox: `activate` in a background worker, panels and blocks in their own frames. The only way
out is the `api` object, checked against the permissions the user granted.

```ts
import { definePlugin } from '@tessera/plugin-api';

export default definePlugin({
  activate(api) {
    api.commands.register({ id: 'hello', title: 'Say hello', run: () => api.ui.notify('Hello!') });
  },
});
```

Everything below is exported from `@tessera/plugin-api`, except the test harness, which is in [`@tessera/plugin-api/testing`](#testing). See [Getting started](./getting-started.md) for a walkthrough and [Permissions and security](./permissions.md) for what each permission allows.

## Contents

- [Defining a plugin](#defining-a-plugin)
- [The api object](#the-api-object)
- [Commands](#commands)
- [Panels, blocks and notifications](#panels-blocks-and-notifications)
- [Renderers](#renderers)
- [Pages](#pages)
- [Databases](#databases)
- [Storage](#storage)
- [Settings](#settings)
- [Theme](#theme)
- [Documents and JSON](#documents-and-json)
- [Errors](#errors)
- [Permissions and IDs](#permissions-and-ids)
- [Testing](#testing)

## Defining a plugin

A plugin module’s default export is `definePlugin({ … })`. `activate` runs in a background worker; `panels` and `blocks` render in their own sandboxed frames.

### definePlugin

Defines a plugin. Export the result as the module's default export.

```ts
function definePlugin<const S extends SettingsSchema = SettingsSchema>(
  definition: PluginDefinition<S>,
): DefinedPlugin<S>
```

```ts
export default definePlugin({
  settings: { greeting: { type: 'string', label: 'Greeting', default: 'Hello' } },
  activate(api) {
    api.commands.register({
      id: 'greet',
      title: 'Greet me',
      run: () => api.ui.notify(api.settings.get('greeting')),
    });
  },
});
```

### PluginDefinition

A plugin: what `definePlugin` takes and the plugin module's default export.

`activate` runs in a background worker when the plugin is enabled; it registers commands,
panels and blocks. `panels` and `blocks` render in their own sandboxed frames. They share no
memory with `activate`: use `api.storage` (and its `onChange`) to share state.

```ts
interface PluginDefinition<S extends SettingsSchema = SettingsSchema> {
  /** Settings the host shows in Settings → Plugins. */
  settings?: S;
  /** Runs when the plugin starts (enabled, installed, updated, or Tessera opened). */
  activate?(api: PluginApi<S>): void | Promise<void>;
  /** Runs before the plugin stops (disabled, updated, uninstalled). Registrations are removed for you. */
  deactivate?(): void | Promise<void>;
  /** Panel renderers, by panel ID (see UiApi.addPanel). */
  panels?: { readonly [id: string]: PanelRenderer<NoInfer<S>> };
  /** Block renderers, by block type (see UiApi.addBlock). */
  blocks?: { readonly [type: string]: BlockRenderer<JsonValue, NoInfer<S>> };
}
```

### defineBlock

Types a block renderer's data. The host stores whatever JSON the block saved, so check it
before trusting it.

```ts
function defineBlock<T extends JsonValue, S extends SettingsSchema = SettingsSchema>(
  render: BlockRenderer<T, S>,
): BlockRenderer<JsonValue, S>
```

```ts
blocks: {
  diagram: defineBlock<{ code: string }>((ctx) => {
    ctx.root.textContent = ctx.data?.code ?? '';
  }),
}
```

### PanelRenderer

Renders a panel. May return a cleanup.

```ts
type PanelRenderer<S extends SettingsSchema = SettingsSchema> = (
  ctx: PanelContext<S>,
) => Cleanup | Promise<Cleanup>;
```

### BlockRenderer

Renders a block. May return a cleanup. Use [`defineBlock`](#defineblock) to type its data.

```ts
type BlockRenderer<
  T extends JsonValue = JsonValue,
  S extends SettingsSchema = SettingsSchema,
> = (ctx: BlockContext<T, S>) => Cleanup | Promise<Cleanup>;
```

### Cleanup

What a render function may return: nothing, or a cleanup that runs when the surface closes.

```ts
type Cleanup = void | (() => void);
```

### PanelContext

What a panel's render function receives. It runs in the panel's own sandboxed frame; `root` is
an empty element styled with the app's theme.

```ts
interface PanelContext<S extends SettingsSchema = SettingsSchema> {
  root: HTMLElement;
  api: PluginApi<S>;
  panelId: string;
  /** The page open in the main view, or null. */
  readonly pageId: string | null;
  /** Called when the user opens another page while the panel stays open. */
  onPageChange(listener: (pageId: string | null) => void): Unsubscribe;
  /** Closes the panel. */
  close(): void;
}
```

### BlockContext

What a block's render function receives. It runs in the block's own sandboxed frame, which
grows and shrinks with `root`'s content.

```ts
interface BlockContext<
  T extends JsonValue = JsonValue,
  S extends SettingsSchema = SettingsSchema,
> {
  root: HTMLElement;
  api: PluginApi<S>;
  blockType: string;
  /** The page the block is on. */
  pageId: string;
  blockId: string | null;
  /** The block's data (null for a block inserted without data). */
  readonly data: T | null;
  readonly readOnly: boolean;
  readonly selected: boolean;
  /**
   * Replaces the block's data: one undoable edit, synced with collaborators. At most 64 KB of JSON.
   * Rejects when the block is read-only.
   */
  setData(data: T): Promise<void>;
  /** Called when the data (undo, collaborators), `readOnly` or `selected` change. */
  onChange(listener: (state: BlockState<T>) => void): Unsubscribe;
  /** Removes the block from the page. */
  remove(): Promise<void>;
}
```

### BlockState

A block's changing state.

```ts
interface BlockState<T extends JsonValue = JsonValue> {
  data: T | null;
  /** True in the trash, or for readers without edit rights. */
  readOnly: boolean;
  /** True while the block is selected in the editor. */
  selected: boolean;
}
```

### DefinedPlugin

What [`definePlugin`](#defineplugin) returns: the definition, marked for the host.

```ts
type DefinedPlugin<S extends SettingsSchema = SettingsSchema> = PluginDefinition<S> & {
  readonly [PLUGIN_DEFINITION_MARKER]: 1;
};
```

### isPluginDefinition

True when `value` looks like a module's `definePlugin` export.

```ts
function isPluginDefinition(value: unknown): value is DefinedPlugin
```

### PLUGIN_DEFINITION_MARKER

Marks a plugin module's default export, so the host can recognize it.

```ts
const PLUGIN_DEFINITION_MARKER = '__tesseraPlugin';
```

## The api object

`activate(api)` receives it, and panels and blocks get the same object as `ctx.api`. Each call is checked against the permissions the user granted, by the host, every time.

### PluginApi

Everything a plugin can do. `activate` receives it in the plugin's worker; panels and blocks
get the same API in `ctx.api`. Every call is checked against the permissions the user granted,
and rejects with a [`PluginError`](#pluginerror) (`code: 'permission_denied'`) when one is missing.

```ts
interface PluginApi<S extends SettingsSchema = SettingsSchema> {
  readonly apiVersion: number;
  readonly plugin: PluginInfo;
  readonly surface: PluginSurface;
  readonly commands: CommandsApi;
  readonly ui: UiApi;
  readonly pages: PagesApi;
  readonly databases: DatabasesApi;
  readonly storage: StorageApi;
  readonly settings: SettingsApi<S>;
  readonly theme: ThemeApi;
  /** True when the user granted this permission. */
  hasPermission(permission: PluginPermission): boolean;
}
```

### PluginInfo

About the running plugin.

```ts
interface PluginInfo {
  id: string;
  name: string;
  version: string;
  /** The API version the host runs the plugin with. */
  apiVersion: number;
  /** Permissions the user granted (a subset of the manifest's). */
  permissions: readonly PluginPermission[];
}
```

### PluginSurface

Where plugin code is running.

```ts
type PluginSurface = 'worker' | 'panel' | 'block';
```

### Unsubscribe

Stops a subscription or removes a registration. Calling it twice is harmless.

```ts
type Unsubscribe = () => void;
```

## Commands

### CommandsApi

Commands. Needs `ui:commands`; register them in `activate`.

<a id="api-commands-register"></a>

#### `api.commands.register`

Registers a command. It appears as "&lt;plugin name&gt;: &lt;title&gt;" in the palette.

```ts
register(command: CommandDefinition): Unsubscribe
```

```ts
api.commands.register({ id: 'say-hello', title: 'Say hello', run: () => api.ui.notify('Hello!') });
```

### CommandDefinition

A command, shown in the command palette and optionally bound to a shortcut.

```ts
interface CommandDefinition {
  /** Unique within the plugin: lowercase words separated by `-`. */
  id: string;
  title: string;
  keywords?: readonly string[];
  /**
   * A shortcut like `Mod+Shift+D` (`Mod` is ⌘ on Apple devices, Ctrl elsewhere). The host ignores
   * shortcuts that another command already uses and says so in the plugin's console.
   */
  shortcut?: string;
  run(context: CommandRunContext): void | Promise<void>;
}
```

### CommandRunContext

What a command receives when it runs.

```ts
interface CommandRunContext {
  /** The page open in the main view, or null. */
  pageId: string | null;
}
```

## Panels, blocks and notifications

### UiApi

Panels, custom blocks and notifications.

<a id="api-ui-addpanel"></a>

#### `api.ui.addPanel`

Adds a side panel with a button in the top bar. Needs `ui:panels`; call it in `activate`.

```ts
addPanel(panel: PanelOptions): Unsubscribe
```

```ts
api.ui.addPanel({ id: 'word-count', title: 'Word count', icon: '🔢' });
```

<a id="api-ui-openpanel"></a>

#### `api.ui.openPanel`

Opens one of the plugin's panels. Needs `ui:panels`.

```ts
openPanel(id: string): Promise<void>
```

<a id="api-ui-addblock"></a>

#### `api.ui.addBlock`

Adds a custom block to the slash menu. Its data lives in the page, so it syncs and exports
with it. Needs `ui:blocks`; call it in `activate`.

```ts
addBlock(block: BlockOptions): Unsubscribe
```

```ts
api.ui.addBlock({ type: 'diagram', title: 'Mermaid diagram', icon: '🧜', initialData: { code: 'graph TD; A-->B' } });
```

<a id="api-ui-notify"></a>

#### `api.ui.notify`

Shows a notification. No permission needed (at most 5 every 10 seconds).

```ts
notify(options: string | NotifyOptions): Promise<void>
```

<a id="api-ui-render"></a>

#### `api.ui.render`

Runs one of the plugin's render functions (see [`defineRenderer`](#definerenderer)) and returns its result.
They run in one hidden frame per plugin, shared by all its panels and blocks, so a heavy
library loads once instead of in every block. Input and result are JSON (at most 4 million
characters). Needs a `renderer` in the manifest; no permission needed.

```ts
render<T extends JsonValue = JsonValue>(name: string, input?: JsonValue): Promise<T>
```

```ts
const { svg } = await ctx.api.ui.render<{ svg: string }>('diagram', { code: 'graph TD; A-->B' });
```

### PanelOptions

A side panel. Its content comes from `panels[id]` in [`PluginDefinition`](#plugindefinition).

```ts
interface PanelOptions {
  /** Must match a key of `panels`. */
  id: string;
  title: string;
  /** One emoji, shown on the panel's button in the top bar. */
  icon?: string;
}
```

### BlockOptions

A custom block. Its content comes from `blocks[type]` in [`PluginDefinition`](#plugindefinition).

```ts
interface BlockOptions {
  /** Must match a key of `blocks`. */
  type: string;
  /** Shown in the slash menu. */
  title: string;
  description?: string;
  /** One emoji, shown in the slash menu. */
  icon?: string;
  keywords?: readonly string[];
  /** The data a new block starts with (at most 64 KB of JSON). */
  initialData?: JsonValue;
}
```

### NotifyOptions

A notification (a toast).

```ts
interface NotifyOptions {
  title: string;
  description?: string;
  variant?: 'default' | 'success' | 'warning' | 'error';
}
```

## Renderers

Plugin API 2. Heavy drawing code (a diagram or chart library) goes in a second module, named by `renderer` in the manifest. It loads once, in a hidden frame shared by the plugin’s panels and blocks, which call it with `api.ui.render`.

### defineRenderer

Defines a plugin's renderer: the default export of the module the manifest names as
`renderer` (plugin API 2). Put heavy drawing code there, such as a diagram or chart library:
Tessera loads it once, in a hidden frame, when a panel or block first calls
`api.ui.render(name, input)`, and closes the frame after two minutes without calls. Keep the
library out of the main module, so panels and blocks stay light.

```ts
function defineRenderer<const R extends RenderFunctions>(renderers: R): DefinedRenderer<R>
```

```ts
// renderer.ts, built into renderer.js next to main.js
export default defineRenderer({
  async diagram(input: { code: string }) {
    const { svg } = await library.render(input.code);
    return { svg };
  },
});
```

### RenderFunction

A render function: turns JSON input into a JSON result, with the DOM of the plugin's hidden
renderer frame (styled with the app's theme and fonts, so text measures as it will show). It
gets no `api`: pass what it needs in `input`.

```ts
type RenderFunction<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue> = (
  input: I,
) => O | Promise<O>;
```

### RenderFunctions

Render functions by name: what [`defineRenderer`](#definerenderer) takes.

```ts
type RenderFunctions = {
  readonly [name: string]: RenderFunction<never, JsonValue>;
};
```

### DefinedRenderer

What [`defineRenderer`](#definerenderer) returns: the render functions, marked for the host.

```ts
interface DefinedRenderer<R extends RenderFunctions = RenderFunctions> {
  readonly [RENDERER_DEFINITION_MARKER]: 1;
  readonly renderers: R;
}
```

### isRendererDefinition

True when `value` looks like a renderer module's `defineRenderer` export.

```ts
function isRendererDefinition(value: unknown): value is DefinedRenderer
```

### RENDERER_DEFINITION_MARKER

Marks a renderer module's default export, so the host can recognize it.

```ts
const RENDERER_DEFINITION_MARKER = '__tesseraRenderer';
```

## Pages

### PagesApi

Reading and writing pages. Reads need `pages:read`, writes `pages:write`.

<a id="api-pages-list"></a>

#### `api.pages.list`

Lists pages, sorted by title.

```ts
list(options?: ListPagesOptions): Promise<PageInfo[]>
```

```ts
const pages = await api.pages.list();
```

<a id="api-pages-get"></a>

#### `api.pages.get`

Reads a page with its content as markdown (default) or as a document tree.

```ts
get(id: string): Promise<PageContent<'markdown'>>
get<F extends ContentFormat>(id: string, options: { format: F }): Promise<PageContent<F>>
```

```ts
const page = await api.pages.get(pageId);
const words = page.content.split(/\s+/).filter(Boolean).length;
```

<a id="api-pages-create"></a>

#### `api.pages.create`

Creates a page. Needs `pages:write`.

```ts
create(input: CreatePageInput): Promise<PageInfo>
```

<a id="api-pages-update"></a>

#### `api.pages.update`

Renames a page, changes its icon or replaces its content. Needs `pages:write`.

```ts
update(id: string, input: UpdatePageInput): Promise<PageInfo>
```

<a id="api-pages-current"></a>

#### `api.pages.current`

The page open in the main view, or null.

```ts
current(): Promise<string | null>
```

<a id="api-pages-open"></a>

#### `api.pages.open`

Opens a page in the main view.

```ts
open(id: string): Promise<void>
```

<a id="api-pages-onchange"></a>

#### `api.pages.onChange`

Calls `listener` whenever a page changes (content changes are batched, about once a second).

```ts
onChange(listener: (event: PageChangeEvent) => void): Unsubscribe
```

```ts
const stop = api.pages.onChange((event) => { if (event.pageId === pageId) refresh(); });
```

### PageInfo

A page's metadata.

```ts
interface PageInfo {
  id: string;
  /** Empty for untitled pages. */
  title: string;
  /** An emoji, or null. */
  icon: string | null;
  /** `database` pages hold a database; their rows are pages too. */
  kind: 'page' | 'database';
  parentId: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  /** True for database rows. */
  isRow: boolean;
  /** True when the page or one of its ancestors is in the trash. */
  trashed: boolean;
}
```

### PageContent

A page with its content (see [`PagesApi.get`](#api-pages-get)).

```ts
interface PageContent<F extends ContentFormat = 'markdown'> extends PageInfo {
  format: F;
  /** Markdown text, or the document tree for `format: 'doc'`. */
  content: F extends 'doc' ? DocJSON : string;
  /** Page properties (`tags`, `aliases`, imported frontmatter, …). */
  props: { [key: string]: JsonValue };
}
```

### ContentFormat

How page content is read or written: markdown text, or the document tree.

```ts
type ContentFormat = 'markdown' | 'doc';
```

### ListPagesOptions

Options for [`PagesApi.list`](#api-pages-list).

```ts
interface ListPagesOptions {
  /** Only children of this page (null = top level). */
  parentId?: string | null;
  /** Include database rows. Default false. */
  includeRows?: boolean;
  /** Include pages in the trash. Default false. */
  includeTrashed?: boolean;
}
```

### CreatePageInput

Input for [`PagesApi.create`](#api-pages-create).

```ts
interface CreatePageInput {
  title?: string;
  /** Parent page; null or missing = top level. */
  parentId?: string | null;
  /** One emoji. */
  icon?: string;
  /** Markdown text or a document tree. */
  content?: string | DocJSON;
}
```

### UpdatePageInput

Input for [`PagesApi.update`](#api-pages-update). Missing fields stay as they are.

```ts
interface UpdatePageInput {
  title?: string;
  /** One emoji, or null to remove it. */
  icon?: string | null;
  /** Replaces the whole content (markdown text or a document tree). */
  content?: string | DocJSON;
}
```

### PageChangeEvent

Something changed on a page. `content` means the body changed; the other types are metadata
(title, icon, parent, trash). `local` is false for changes that arrived from collaborators.

```ts
interface PageChangeEvent {
  type: 'created' | 'updated' | 'content' | 'trashed' | 'restored' | 'deleted';
  pageId: string;
  local: boolean;
}
```

## Databases

### DatabasesApi

Databases. Reads need `databases:read`, writes `databases:write`.

<a id="api-databases-list"></a>

#### `api.databases.list`

Every database in the workspace, sorted by title.

```ts
list(): Promise<DatabaseInfo[]>
```

<a id="api-databases-get"></a>

#### `api.databases.get`

Columns and views of one database.

```ts
get(id: string): Promise<DatabaseSchema>
```

<a id="api-databases-query"></a>

#### `api.databases.query`

Rows matching a query (trashed rows are left out).

```ts
query(id: string, query?: DatabaseQuery): Promise<DatabaseQueryResult>
```

```ts
const { rows } = await api.databases.query(id, {
  filters: [{ property: 'Status', operator: 'equals', value: 'Done' }],
  sorts: [{ property: 'Due', direction: 'ascending' }],
});
```

<a id="api-databases-addrow"></a>

#### `api.databases.addRow`

Adds a row. Needs `databases:write`.

```ts
addRow(id: string, input?: RowInput): Promise<DatabaseRow>
```

<a id="api-databases-updaterow"></a>

#### `api.databases.updateRow`

Changes a row's title or values. Needs `databases:write`.

```ts
updateRow(id: string, rowId: string, input: RowInput): Promise<DatabaseRow>
```

### DatabaseInfo

A database (a page of kind `database`).

```ts
interface DatabaseInfo {
  id: string;
  title: string;
  icon: string | null;
}
```

### DatabaseSchema

A database's columns and views.

```ts
interface DatabaseSchema extends DatabaseInfo {
  properties: DatabaseProperty[];
  views: DatabaseView[];
}
```

### DatabaseProperty

A column.

```ts
interface DatabaseProperty {
  id: string;
  name: string;
  type: DatabasePropertyType;
  /** For `select` and `multiSelect`. */
  options?: DatabaseSelectOption[];
}
```

### DatabasePropertyType

A database's property types.

```ts
type DatabasePropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'multiSelect'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'relation'
  | 'createdTime'
  | 'updatedTime'
  | 'formula';
```

### DatabaseSelectOption

One option of a `select` or `multiSelect` property.

```ts
interface DatabaseSelectOption {
  id: string;
  name: string;
  color: string;
}
```

### DatabaseView

A saved view of a database.

```ts
interface DatabaseView {
  id: string;
  name: string;
  type: 'table' | 'board' | 'calendar' | 'gallery' | 'list';
}
```

### DatabaseRow

A row. `values` is keyed by property ID and holds every column: the title for `title`, epoch
milliseconds for `createdTime` and `updatedTime`, option IDs for selects, `{ start, end? }`
for dates, and null for empty cells.

```ts
interface DatabaseRow {
  id: string;
  title: string;
  icon: string | null;
  createdAt: number;
  updatedAt: number;
  values: { [propertyId: string]: JsonValue };
}
```

### DatabaseQuery

A query: every filter must match; sorts apply in order.

```ts
interface DatabaseQuery {
  filters?: RowFilter[];
  sorts?: RowSort[];
  /** Default 100, at most 1,000. */
  limit?: number;
  offset?: number;
}
```

### RowFilter

A condition on one property (matched by ID or by name, case-insensitively).

```ts
interface RowFilter {
  property: string;
  operator:
    | 'equals'
    | 'notEquals'
    | 'contains'
    | 'notContains'
    | 'greaterThan'
    | 'lessThan'
    | 'isEmpty'
    | 'isNotEmpty';
  /** For selects, an option ID or name. Not needed for `isEmpty` and `isNotEmpty`. */
  value?: JsonValue;
}
```

### RowSort

A sort on one property (by ID or name).

```ts
interface RowSort {
  property: string;
  direction?: 'ascending' | 'descending';
}
```

### DatabaseQueryResult

Rows that matched a query.

```ts
interface DatabaseQueryResult {
  rows: DatabaseRow[];
  /** Matches before `limit` and `offset`. */
  total: number;
}
```

### RowInput

Values to write. Keys are property IDs or names; select values may be option IDs or names.
null clears a cell.

```ts
interface RowInput {
  title?: string;
  values?: { [property: string]: JsonValue | null };
}
```

## Storage

### StorageApi

Key-value storage private to the plugin, on this device. Needs `storage`. Keys are at most 200
characters, each value at most 1 MB of JSON, 10 MB in total. Uninstalling clears it.

<a id="api-storage-get"></a>

#### `api.storage.get`

```ts
get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined>
```

<a id="api-storage-set"></a>

#### `api.storage.set`

```ts
set(key: string, value: JsonValue): Promise<void>
```

<a id="api-storage-delete"></a>

#### `api.storage.delete`

```ts
delete(key: string): Promise<void>
```

<a id="api-storage-keys"></a>

#### `api.storage.keys`

```ts
keys(): Promise<string[]>
```

<a id="api-storage-onchange"></a>

#### `api.storage.onChange`

Called when a key changes, also from the plugin's other panels, blocks or its worker. Use it to
share state between them.

```ts
onChange(listener: (key: string, value: JsonValue | undefined) => void): Unsubscribe
```

## Settings

Declare settings in `definePlugin({ settings })`: Tessera renders the form in Settings → Plugins, validates what the user enters, and types `api.settings.get` from the schema.

### SettingsApi

The plugin's settings (declared in [`PluginDefinition.settings`](#plugindefinition)). No permission needed.

<a id="api-settings-get"></a>

#### `api.settings.get`

The current value (the default until the user changes it).

```ts
get<K extends keyof S & string>(key: K): SettingsValues<S>[K]
```

<a id="api-settings-getall"></a>

#### `api.settings.getAll`

```ts
getAll(): SettingsValues<S>
```

<a id="api-settings-set"></a>

#### `api.settings.set`

Changes a value. Invalid values are rejected.

```ts
set<K extends keyof S & string>(key: K, value: SettingsValues<S>[K]): Promise<void>
```

<a id="api-settings-onchange"></a>

#### `api.settings.onChange`

Called when the user (or the plugin) changes a setting.

```ts
onChange(listener: (values: SettingsValues<S>, key: keyof S & string) => void): Unsubscribe
```

### SettingsSchema

A plugin's settings, declared in [`PluginDefinition.settings`](#plugindefinition). Keys are identifiers
(letters, digits and `_`, starting with a letter; at most 50 settings).

```ts
type SettingsSchema = { readonly [key: string]: SettingDefinition };
```

```ts
settings: {
  dateFormat: { type: 'string', label: 'Date format', default: 'YYYY-MM-DD' },
  autoCreate: { type: 'boolean', label: 'Create today’s note on startup', default: false },
}
```

### SettingDefinition

One setting. The host renders a control for it in Settings → Plugins.

```ts
type SettingDefinition = StringSetting | NumberSetting | BooleanSetting | SelectSetting;
```

### SettingBase

```ts
interface SettingBase {
  /** Shown next to the control. */
  label: string;
  /** Help text under the control. */
  description?: string;
}
```

### StringSetting

A text setting.

```ts
interface StringSetting extends SettingBase {
  type: 'string';
  default: string;
  placeholder?: string;
  /** A textarea instead of a single line. */
  multiline?: boolean;
  /** Longest accepted value (default 1,000; at most 10,000). */
  maxLength?: number;
}
```

### NumberSetting

A number setting.

```ts
interface NumberSetting extends SettingBase {
  type: 'number';
  default: number;
  min?: number;
  max?: number;
  /** Default 1. */
  step?: number;
  /** Shown after the field, for example `min`. */
  unit?: string;
}
```

### BooleanSetting

An on/off setting (a switch).

```ts
interface BooleanSetting extends SettingBase {
  type: 'boolean';
  default: boolean;
}
```

### SelectSetting

A setting with a fixed list of choices (a select box).

```ts
interface SelectSetting extends SettingBase {
  type: 'select';
  default: string;
  options: readonly SelectSettingOption[];
}
```

### SelectSettingOption

One choice of a [`SelectSetting`](#selectsetting).

```ts
interface SelectSettingOption {
  value: string;
  label: string;
}
```

### SettingValue

The value type of one setting.

```ts
type SettingValue<D extends SettingDefinition> = D extends NumberSetting
  ? number
  : D extends BooleanSetting
    ? boolean
    : D extends { type: 'select'; options: readonly { value: infer V }[] }
      ? V
      : string;
```

### SettingsValues

Current values of every setting in a schema.

```ts
type SettingsValues<S extends SettingsSchema> = { [K in keyof S]: SettingValue<S[K]> };
```

## Theme

### ThemeApi

The current theme, and changes to it. No permission needed.

<a id="api-theme-get"></a>

#### `api.theme.get`

```ts
get(): ThemeInfo
```

<a id="api-theme-onchange"></a>

#### `api.theme.onChange`

```ts
onChange(listener: (theme: ThemeInfo) => void): Unsubscribe
```

### ThemeInfo

The app's theme. `tokens` holds every design token without its `--tess-` prefix (`bg`,
`fg-muted`, `accent`, `radius-md`, `font-sans`, …). Panels and blocks also get them as CSS
variables (`var(--tess-accent)`), so plugin UIs match the app in light and dark mode.

```ts
interface ThemeInfo {
  mode: 'light' | 'dark';
  tokens: { [name: string]: string };
  /** True when the user asked for reduced motion. */
  reducedMotion: boolean;
}
```

## Documents and JSON

### DocJSON

A whole document: `{ type: 'doc', content: [...] }`.

```ts
interface DocJSON extends DocNode {
  type: 'doc';
}
```

### DocNode

A node of a Tessera document, as ProseMirror JSON (`paragraph`, `heading`, `text`, `embed`, …).
The host validates every document a plugin writes against the canonical schema.

```ts
interface DocNode {
  type: string;
  attrs?: { [key: string]: JsonValue };
  content?: DocNode[];
  text?: string;
  marks?: DocMark[];
}
```

### DocMark

A mark on text in [`DocNode`](#docnode) content (`bold`, `italic`, `link`, …).

```ts
interface DocMark {
  type: string;
  attrs?: { [key: string]: JsonValue };
}
```

### JsonValue

A JSON value: what crosses the sandbox boundary, and what storage and blocks hold.

```ts
type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
```

### JsonObject

A JSON object.

```ts
type JsonObject = { [key: string]: JsonValue };
```

## Errors

### PluginError

The error every API call rejects with. `message` is written for people: show it as is.
`instanceof PluginError` works for errors created by the sandbox runtime too.

```ts
class PluginError extends Error {
  readonly code: PluginErrorCode;
  /** The missing permission, for `permission_denied`. */
  readonly permission?: PluginPermission;
  constructor(code: PluginErrorCode, message: string, permission?: PluginPermission);
}
```

```ts
try {
  await api.pages.get(pageId);
} catch (error) {
  if (error instanceof PluginError && error.code === 'permission_denied') showHint(error.message);
}
```

### PluginErrorCode

Why an API call failed.

```ts
type PluginErrorCode =
  /** The user didn't grant the permission this call needs (see `error.permission`). */
  | 'permission_denied'
  /** The page, database, row, panel or block doesn't exist. */
  | 'not_found'
  /** The input was invalid (too large, wrong shape, unknown option…). */
  | 'invalid'
  /** The call isn't allowed right now (a read-only block, a registration outside `activate`…). */
  | 'invalid_operation'
  /** Too many calls at once, or the host is shutting the plugin down. */
  | 'unavailable'
  /** The host didn't answer in time. */
  | 'timeout'
  | 'conflict'
  | 'aborted'
  | 'internal';
```

### isPluginError

True for any error the API rejected with. Errors come from the sandbox runtime, not from your
bundle's copy of the SDK, so this checks their shape (`name` and `code`) instead of the class.

```ts
function isPluginError(value: unknown): value is PluginError
```

### isPluginErrorCode

Returns true when `value` is a known [`PluginErrorCode`](#pluginerrorcode).

```ts
function isPluginErrorCode(value: unknown): value is PluginErrorCode
```

## Permissions and IDs

### PLUGIN_API_VERSION

Version of the plugin API described by this SDK. Put it in your manifest as `apiVersion`. The
host refuses plugins built for a newer API and keeps older versions working. Version 2 added
renderers ([`defineRenderer`](#definerenderer), `api.ui.render`); Tessera 0.1 runs version 1.

```ts
const PLUGIN_API_VERSION = 2;
```

### PLUGIN_PERMISSIONS

Permissions a plugin can ask for in its manifest. `network:<domain>` (for example
`network:api.example.com` or `network:*.example.com`) is the only parameterized one.

| Permission         | Allows                                                        |
|--------------------|---------------------------------------------------------------|
| `pages:read`       | `api.pages.list`, `get`, `current`, `open` and `onChange`     |
| `pages:write`      | `api.pages.create` and `update`                               |
| `databases:read`   | `api.databases.list`, `get` and `query`                       |
| `databases:write`  | `api.databases.addRow` and `updateRow`                        |
| `ui:commands`      | `api.commands.register`                                       |
| `ui:panels`        | `api.ui.addPanel` and `openPanel`                             |
| `ui:blocks`        | `api.ui.addBlock` (custom blocks)                             |
| `storage`          | `api.storage` (private to the plugin, cleared on uninstall)   |
| `network:<domain>` | `fetch` to that domain (everything else is blocked)           |

```ts
const PLUGIN_PERMISSIONS = [
  'pages:read',
  'pages:write',
  'databases:read',
  'databases:write',
  'ui:commands',
  'ui:panels',
  'ui:blocks',
  'storage',
] as const;
```

### PluginPermission

Any permission a manifest can list.

```ts
type PluginPermission = StaticPluginPermission | NetworkPermission;
```

### StaticPluginPermission

A permission without parameters.

```ts
type StaticPluginPermission = (typeof PLUGIN_PERMISSIONS)[number];
```

### NetworkPermission

A network permission: `network:api.example.com` or `network:*.example.com`.

```ts
type NetworkPermission = `network:${string}`;
```

### PLUGIN_ID_PATTERN

Plugin IDs: lowercase words separated by `-` or `.` (`word-count`, `com.example.pomodoro`).

```ts
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
```

### PLUGIN_ITEM_ID_PATTERN

IDs of commands, panels and block types inside a plugin: lowercase words separated by `-`.

```ts
const PLUGIN_ITEM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
```

## Testing

`@tessera/plugin-api/testing` — run a plugin against an in-memory workspace in unit tests.

The harness gives the plugin the same API shape as the app, and enforces permissions the same
way: a call without permission rejects with `PluginError` (`permission_denied`). Panels and
blocks render into real DOM elements (use a DOM test environment such as jsdom).

```ts
import { createTestHarness } from '@tessera/plugin-api/testing';
import plugin from './main';

const harness = createTestHarness(plugin, {
  permissions: ['pages:read', 'ui:commands'],
  pages: [{ title: 'Apollo', content: 'One small step' }],
});
await harness.activate();
await harness.runCommand('random-page');
expect(harness.openedPages).toHaveLength(1);
```

### createTestHarness

Runs a plugin against an in-memory workspace. See the module documentation for an example.

```ts
function createTestHarness<S extends SettingsSchema>(
  plugin: PluginDefinition<S>,
  options: TestHarnessOptions = {},
): TestHarness<S>
```

### TestHarnessOptions

Options of [`createTestHarness`](#createtestharness).

```ts
interface TestHarnessOptions {
  /** Granted permissions. Default: every permission except network ones. */
  permissions?: readonly PluginPermission[];
  pages?: HarnessPageInput[];
  databases?: HarnessDatabaseInput[];
  /** Stored setting values (defaults fill the rest). */
  settings?: Record<string, SettingPrimitive>;
  storage?: Record<string, JsonValue>;
  /** The page open in the main view. */
  currentPageId?: string | null;
  theme?: Partial<ThemeInfo>;
  plugin?: { id?: string; name?: string; version?: string };
  /** The plugin's renderer module (its `defineRenderer` export), for `api.ui.render`. */
  renderer?: DefinedRenderer;
  /** The clock for timestamps. Default `Date.now`. */
  now?: () => number;
}
```

### TestHarness

What [`createTestHarness`](#createtestharness) returns.

```ts
interface TestHarness<S extends SettingsSchema = SettingsSchema> {
  /** The API `activate` receives. */
  api: PluginApi<S>;
  activate(): Promise<void>;
  deactivate(): Promise<void>;
  /** Commands registered so far. */
  readonly commands: ReadonlyArray<Omit<CommandDefinition, 'run'>>;
  runCommand(id: string, context?: { pageId?: string | null }): Promise<void>;
  readonly panels: readonly PanelOptions[];
  readonly blocks: readonly BlockOptions[];
  readonly notifications: readonly NotifyOptions[];
  /** Pages opened with `api.pages.open`. */
  readonly openedPages: readonly string[];
  /** Panels opened with `api.ui.openPanel`. */
  readonly openedPanels: readonly string[];
  readonly workspace: HarnessWorkspace;
  readonly storage: ReadonlyMap<string, JsonValue>;
  /** Changes a setting as if the user did (fires `onChange`). */
  setSetting(key: string, value: SettingPrimitive): void;
  /** Opens another page in the main view (fires panels' `onPageChange`). */
  setCurrentPage(pageId: string | null): void;
  setTheme(theme: Partial<ThemeInfo>): void;
  renderPanel(id: string, options?: { root?: HTMLElement }): Promise<RenderedPanel>;
  renderBlock<T extends JsonValue = JsonValue>(
    type: string,
    options?: {
      data?: T | null;
      readOnly?: boolean;
      selected?: boolean;
      pageId?: string;
      root?: HTMLElement;
    },
  ): Promise<RenderedBlock<T>>;
  /** Waits for pending promises (works with fake timers; advance timers yourself). */
  flush(): Promise<void>;
}
```

### HarnessPageInput

A page to start the harness with.

```ts
interface HarnessPageInput {
  id?: string;
  title: string;
  icon?: string;
  parentId?: string | null;
  /** Markdown. */
  content?: string;
  props?: Record<string, JsonValue>;
  trashed?: boolean;
}
```

### HarnessDatabaseInput

A database to start the harness with. Row values are keyed by property name or ID.

```ts
interface HarnessDatabaseInput {
  id?: string;
  title: string;
  properties: Array<{
    id?: string;
    name: string;
    type: Exclude<DatabasePropertyType, 'title'>;
    options?: Array<{ id?: string; name: string; color?: string }>;
  }>;
  rows?: Array<{ id?: string; title?: string; values?: Record<string, JsonValue | null> }>;
}
```

### HarnessWorkspace

The in-memory workspace, as the test sees it.

```ts
interface HarnessWorkspace {
  /** Every page, with markdown content. */
  all(): Array<PageInfo & { content: string; props: Record<string, JsonValue> }>;
  get(id: string): (PageInfo & { content: string }) | undefined;
  /** Creates a page as if the user did (fires `created`). */
  create(input: HarnessPageInput): PageInfo;
  /** Replaces a page's content as if the user typed (fires `content`). */
  setContent(id: string, markdown: string): void;
  rename(id: string, title: string): void;
  trash(id: string): void;
  /** Rows of a database, values keyed by property ID. */
  rows(databaseId: string): DatabaseRow[];
}
```

### RenderedPanel

A rendered panel.

```ts
interface RenderedPanel {
  root: HTMLElement;
  /** True after the plugin called `ctx.close()`. */
  readonly closedByPlugin: boolean;
  /** Runs the panel's cleanup, like closing it in the app. */
  close(): Promise<void>;
}
```

### RenderedBlock

A rendered block.

```ts
interface RenderedBlock<T extends JsonValue = JsonValue> {
  root: HTMLElement;
  /** The data the block holds now (after `setData`). */
  readonly data: T | null;
  /** True after the plugin called `ctx.remove()`. */
  readonly removed: boolean;
  /** Changes the block's state from the outside (undo, collaborators, selection). */
  update(state: Partial<BlockState<T>>): void;
  close(): Promise<void>;
}
```

### SettingPrimitive

A setting value: settings are strings, numbers or booleans.

```ts
type SettingPrimitive = string | number | boolean;
```

### markdownToDoc

A deliberately small markdown ⇄ document conversion for the test harness: headings (`#` to
`###`) and paragraphs. The real app uses a full markdown codec; tests of plugin logic rarely
need more.

```ts
function markdownToDoc(markdown: string): DocJSON
```

### docToMarkdown

The inverse of [`markdownToDoc`](#markdowntodoc): headings and paragraphs, other blocks as plain text.

```ts
function docToMarkdown(doc: DocNode): string
```
