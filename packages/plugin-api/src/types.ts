import type { PluginPermission } from './permissions';

/** A JSON value: what crosses the sandbox boundary, and what storage and blocks hold. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** Stops a subscription or removes a registration. Calling it twice is harmless. */
export type Unsubscribe = () => void;

/** What a render function may return: nothing, or a cleanup that runs when the surface closes. */
export type Cleanup = void | (() => void);

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

interface SettingBase {
  /** Shown next to the control. */
  label: string;
  /** Help text under the control. */
  description?: string;
}

/** A text setting. */
export interface StringSetting extends SettingBase {
  type: 'string';
  default: string;
  placeholder?: string;
  /** A textarea instead of a single line. */
  multiline?: boolean;
  /** Longest accepted value (default 1,000; at most 10,000). */
  maxLength?: number;
}

/** A number setting. */
export interface NumberSetting extends SettingBase {
  type: 'number';
  default: number;
  min?: number;
  max?: number;
  /** Default 1. */
  step?: number;
  /** Shown after the field, for example `min`. */
  unit?: string;
}

/** An on/off setting (a switch). */
export interface BooleanSetting extends SettingBase {
  type: 'boolean';
  default: boolean;
}

/** One choice of a {@link SelectSetting}. */
export interface SelectSettingOption {
  value: string;
  label: string;
}

/** A setting with a fixed list of choices (a select box). */
export interface SelectSetting extends SettingBase {
  type: 'select';
  default: string;
  options: readonly SelectSettingOption[];
}

/** One setting. The host renders a control for it in Settings → Plugins. */
export type SettingDefinition = StringSetting | NumberSetting | BooleanSetting | SelectSetting;

/**
 * A plugin's settings, declared in {@link PluginDefinition.settings}. Keys are identifiers
 * (letters, digits and `_`, starting with a letter; at most 50 settings).
 *
 * @example
 * settings: {
 *   dateFormat: { type: 'string', label: 'Date format', default: 'YYYY-MM-DD' },
 *   autoCreate: { type: 'boolean', label: 'Create today’s note on startup', default: false },
 * }
 */
export type SettingsSchema = { readonly [key: string]: SettingDefinition };

/** The value type of one setting. */
export type SettingValue<D extends SettingDefinition> = D extends NumberSetting
  ? number
  : D extends BooleanSetting
    ? boolean
    : D extends { type: 'select'; options: readonly { value: infer V }[] }
      ? V
      : string;

/** Current values of every setting in a schema. */
export type SettingsValues<S extends SettingsSchema> = { [K in keyof S]: SettingValue<S[K]> };

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

/** A mark on text in {@link DocNode} content (`bold`, `italic`, `link`, …). */
export interface DocMark {
  type: string;
  attrs?: { [key: string]: JsonValue };
}

/**
 * A node of a Tessera document, as ProseMirror JSON (`paragraph`, `heading`, `text`, `embed`, …).
 * The host validates every document a plugin writes against the canonical schema.
 */
export interface DocNode {
  type: string;
  attrs?: { [key: string]: JsonValue };
  content?: DocNode[];
  text?: string;
  marks?: DocMark[];
}

/** A whole document: `{ type: 'doc', content: [...] }`. */
export interface DocJSON extends DocNode {
  type: 'doc';
}

/** How page content is read or written: markdown text, or the document tree. */
export type ContentFormat = 'markdown' | 'doc';

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

/** A page's metadata. */
export interface PageInfo {
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

/** A page with its content (see {@link PagesApi.get}). */
export interface PageContent<F extends ContentFormat = 'markdown'> extends PageInfo {
  format: F;
  /** Markdown text, or the document tree for `format: 'doc'`. */
  content: F extends 'doc' ? DocJSON : string;
  /** Page properties (`tags`, `aliases`, imported frontmatter, …). */
  props: { [key: string]: JsonValue };
}

/** Options for {@link PagesApi.list}. */
export interface ListPagesOptions {
  /** Only children of this page (null = top level). */
  parentId?: string | null;
  /** Include database rows. Default false. */
  includeRows?: boolean;
  /** Include pages in the trash. Default false. */
  includeTrashed?: boolean;
}

/** Input for {@link PagesApi.create}. */
export interface CreatePageInput {
  title?: string;
  /** Parent page; null or missing = top level. */
  parentId?: string | null;
  /** One emoji. */
  icon?: string;
  /** Markdown text or a document tree. */
  content?: string | DocJSON;
}

/** Input for {@link PagesApi.update}. Missing fields stay as they are. */
export interface UpdatePageInput {
  title?: string;
  /** One emoji, or null to remove it. */
  icon?: string | null;
  /** Replaces the whole content (markdown text or a document tree). */
  content?: string | DocJSON;
}

/**
 * Something changed on a page. `content` means the body changed; the other types are metadata
 * (title, icon, parent, trash). `local` is false for changes that arrived from collaborators.
 */
export interface PageChangeEvent {
  type: 'created' | 'updated' | 'content' | 'trashed' | 'restored' | 'deleted';
  pageId: string;
  local: boolean;
}

/** Reading and writing pages. Reads need `pages:read`, writes `pages:write`. */
export interface PagesApi {
  /**
   * Lists pages, sorted by title.
   *
   * @example
   * const pages = await api.pages.list();
   */
  list(options?: ListPagesOptions): Promise<PageInfo[]>;
  /**
   * Reads a page with its content as markdown (default) or as a document tree.
   *
   * @example
   * const page = await api.pages.get(pageId);
   * const words = page.content.split(/\s+/).filter(Boolean).length;
   */
  get(id: string): Promise<PageContent<'markdown'>>;
  get<F extends ContentFormat>(id: string, options: { format: F }): Promise<PageContent<F>>;
  /** Creates a page. Needs `pages:write`. */
  create(input: CreatePageInput): Promise<PageInfo>;
  /** Renames a page, changes its icon or replaces its content. Needs `pages:write`. */
  update(id: string, input: UpdatePageInput): Promise<PageInfo>;
  /** The page open in the main view, or null. */
  current(): Promise<string | null>;
  /** Opens a page in the main view. */
  open(id: string): Promise<void>;
  /**
   * Calls `listener` whenever a page changes (content changes are batched, about once a second).
   *
   * @example
   * const stop = api.pages.onChange((event) => { if (event.pageId === pageId) refresh(); });
   */
  onChange(listener: (event: PageChangeEvent) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------------------------

/** A database's property types. */
export type DatabasePropertyType =
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

/** A database (a page of kind `database`). */
export interface DatabaseInfo {
  id: string;
  title: string;
  icon: string | null;
}

/** One option of a `select` or `multiSelect` property. */
export interface DatabaseSelectOption {
  id: string;
  name: string;
  color: string;
}

/** A column. */
export interface DatabaseProperty {
  id: string;
  name: string;
  type: DatabasePropertyType;
  /** For `select` and `multiSelect`. */
  options?: DatabaseSelectOption[];
}

/** A saved view of a database. */
export interface DatabaseView {
  id: string;
  name: string;
  type: 'table' | 'board' | 'calendar' | 'gallery' | 'list';
}

/** A database's columns and views. */
export interface DatabaseSchema extends DatabaseInfo {
  properties: DatabaseProperty[];
  views: DatabaseView[];
}

/**
 * A row. `values` is keyed by property ID and holds every column: the title for `title`, epoch
 * milliseconds for `createdTime` and `updatedTime`, option IDs for selects, `{ start, end? }`
 * for dates, and null for empty cells.
 */
export interface DatabaseRow {
  id: string;
  title: string;
  icon: string | null;
  createdAt: number;
  updatedAt: number;
  values: { [propertyId: string]: JsonValue };
}

/** A condition on one property (matched by ID or by name, case-insensitively). */
export interface RowFilter {
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

/** A sort on one property (by ID or name). */
export interface RowSort {
  property: string;
  direction?: 'ascending' | 'descending';
}

/** A query: every filter must match; sorts apply in order. */
export interface DatabaseQuery {
  filters?: RowFilter[];
  sorts?: RowSort[];
  /** Default 100, at most 1,000. */
  limit?: number;
  offset?: number;
}

/** Rows that matched a query. */
export interface DatabaseQueryResult {
  rows: DatabaseRow[];
  /** Matches before `limit` and `offset`. */
  total: number;
}

/**
 * Values to write. Keys are property IDs or names; select values may be option IDs or names.
 * null clears a cell.
 */
export interface RowInput {
  title?: string;
  values?: { [property: string]: JsonValue | null };
}

/** Databases. Reads need `databases:read`, writes `databases:write`. */
export interface DatabasesApi {
  /** Every database in the workspace, sorted by title. */
  list(): Promise<DatabaseInfo[]>;
  /** Columns and views of one database. */
  get(id: string): Promise<DatabaseSchema>;
  /**
   * Rows matching a query (trashed rows are left out).
   *
   * @example
   * const { rows } = await api.databases.query(id, {
   *   filters: [{ property: 'Status', operator: 'equals', value: 'Done' }],
   *   sorts: [{ property: 'Due', direction: 'ascending' }],
   * });
   */
  query(id: string, query?: DatabaseQuery): Promise<DatabaseQueryResult>;
  /** Adds a row. Needs `databases:write`. */
  addRow(id: string, input?: RowInput): Promise<DatabaseRow>;
  /** Changes a row's title or values. Needs `databases:write`. */
  updateRow(id: string, rowId: string, input: RowInput): Promise<DatabaseRow>;
}

// ---------------------------------------------------------------------------------------------
// Storage, settings, theme
// ---------------------------------------------------------------------------------------------

/**
 * Key-value storage private to the plugin, on this device. Needs `storage`. Keys are at most 200
 * characters, each value at most 1 MB of JSON, 10 MB in total. Uninstalling clears it.
 */
export interface StorageApi {
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  /**
   * Called when a key changes, also from the plugin's other panels, blocks or its worker. Use it to
   * share state between them.
   */
  onChange(listener: (key: string, value: JsonValue | undefined) => void): Unsubscribe;
}

/** The plugin's settings (declared in {@link PluginDefinition.settings}). No permission needed. */
export interface SettingsApi<S extends SettingsSchema> {
  /** The current value (the default until the user changes it). */
  get<K extends keyof S & string>(key: K): SettingsValues<S>[K];
  getAll(): SettingsValues<S>;
  /** Changes a value. Invalid values are rejected. */
  set<K extends keyof S & string>(key: K, value: SettingsValues<S>[K]): Promise<void>;
  /** Called when the user (or the plugin) changes a setting. */
  onChange(listener: (values: SettingsValues<S>, key: keyof S & string) => void): Unsubscribe;
}

/**
 * The app's theme. `tokens` holds every design token without its `--tess-` prefix (`bg`,
 * `fg-muted`, `accent`, `radius-md`, `font-sans`, …). Panels and blocks also get them as CSS
 * variables (`var(--tess-accent)`), so plugin UIs match the app in light and dark mode.
 */
export interface ThemeInfo {
  mode: 'light' | 'dark';
  tokens: { [name: string]: string };
  /** True when the user asked for reduced motion. */
  reducedMotion: boolean;
}

/** The current theme, and changes to it. No permission needed. */
export interface ThemeApi {
  get(): ThemeInfo;
  onChange(listener: (theme: ThemeInfo) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------------------------
// Commands and UI
// ---------------------------------------------------------------------------------------------

/** What a command receives when it runs. */
export interface CommandRunContext {
  /** The page open in the main view, or null. */
  pageId: string | null;
}

/** A command, shown in the command palette and optionally bound to a shortcut. */
export interface CommandDefinition {
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

/** Commands. Needs `ui:commands`; register them in `activate`. */
export interface CommandsApi {
  /**
   * Registers a command. It appears as "<plugin name>: <title>" in the palette.
   *
   * @example
   * api.commands.register({ id: 'say-hello', title: 'Say hello', run: () => api.ui.notify('Hello!') });
   */
  register(command: CommandDefinition): Unsubscribe;
}

/** A side panel. Its content comes from `panels[id]` in {@link PluginDefinition}. */
export interface PanelOptions {
  /** Must match a key of `panels`. */
  id: string;
  title: string;
  /** One emoji, shown on the panel's button in the top bar. */
  icon?: string;
}

/** A custom block. Its content comes from `blocks[type]` in {@link PluginDefinition}. */
export interface BlockOptions {
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

/** A notification (a toast). */
export interface NotifyOptions {
  title: string;
  description?: string;
  variant?: 'default' | 'success' | 'warning' | 'error';
}

/** Panels, custom blocks and notifications. */
export interface UiApi {
  /**
   * Adds a side panel with a button in the top bar. Needs `ui:panels`; call it in `activate`.
   *
   * @example
   * api.ui.addPanel({ id: 'word-count', title: 'Word count', icon: '🔢' });
   */
  addPanel(panel: PanelOptions): Unsubscribe;
  /** Opens one of the plugin's panels. Needs `ui:panels`. */
  openPanel(id: string): Promise<void>;
  /**
   * Adds a custom block to the slash menu. Its data lives in the page, so it syncs and exports
   * with it. Needs `ui:blocks`; call it in `activate`.
   *
   * @example
   * api.ui.addBlock({ type: 'diagram', title: 'Mermaid diagram', icon: '🧜', initialData: { code: 'graph TD; A-->B' } });
   */
  addBlock(block: BlockOptions): Unsubscribe;
  /** Shows a notification. No permission needed (at most 5 every 10 seconds). */
  notify(options: string | NotifyOptions): Promise<void>;
  /**
   * Runs one of the plugin's render functions (see {@link defineRenderer}) and returns its result.
   * They run in one hidden frame per plugin, shared by all its panels and blocks, so a heavy
   * library loads once instead of in every block. Input and result are JSON (at most 4 million
   * characters). Needs a `renderer` in the manifest; no permission needed.
   *
   * @example
   * const { svg } = await ctx.api.ui.render<{ svg: string }>('diagram', { code: 'graph TD; A-->B' });
   */
  render<T extends JsonValue = JsonValue>(name: string, input?: JsonValue): Promise<T>;
}

/**
 * A render function: turns JSON input into a JSON result, with the DOM of the plugin's hidden
 * renderer frame (styled with the app's theme and fonts, so text measures as it will show). It
 * gets no `api`: pass what it needs in `input`.
 */
export type RenderFunction<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue> = (
  input: I,
) => O | Promise<O>;

/** Render functions by name: what {@link defineRenderer} takes. */
export type RenderFunctions = {
  readonly [name: string]: RenderFunction<never, JsonValue>;
};

// ---------------------------------------------------------------------------------------------
// The API object
// ---------------------------------------------------------------------------------------------

/** Where plugin code is running. */
export type PluginSurface = 'worker' | 'panel' | 'block';

/** About the running plugin. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  /** The API version the host runs the plugin with. */
  apiVersion: number;
  /** Permissions the user granted (a subset of the manifest's). */
  permissions: readonly PluginPermission[];
}

/**
 * Everything a plugin can do. `activate` receives it in the plugin's worker; panels and blocks
 * get the same API in `ctx.api`. Every call is checked against the permissions the user granted,
 * and rejects with a {@link PluginError} (`code: 'permission_denied'`) when one is missing.
 */
export interface PluginApi<S extends SettingsSchema = SettingsSchema> {
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

// ---------------------------------------------------------------------------------------------
// Panels and blocks
// ---------------------------------------------------------------------------------------------

/**
 * What a panel's render function receives. It runs in the panel's own sandboxed frame; `root` is
 * an empty element styled with the app's theme.
 */
export interface PanelContext<S extends SettingsSchema = SettingsSchema> {
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

/** A block's changing state. */
export interface BlockState<T extends JsonValue = JsonValue> {
  data: T | null;
  /** True in the trash, or for readers without edit rights. */
  readOnly: boolean;
  /** True while the block is selected in the editor. */
  selected: boolean;
}

/**
 * What a block's render function receives. It runs in the block's own sandboxed frame, which
 * grows and shrinks with `root`'s content.
 */
export interface BlockContext<
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

/** Renders a panel. May return a cleanup. */
export type PanelRenderer<S extends SettingsSchema = SettingsSchema> = (
  ctx: PanelContext<S>,
) => Cleanup | Promise<Cleanup>;

/** Renders a block. May return a cleanup. Use {@link defineBlock} to type its data. */
export type BlockRenderer<
  T extends JsonValue = JsonValue,
  S extends SettingsSchema = SettingsSchema,
> = (ctx: BlockContext<T, S>) => Cleanup | Promise<Cleanup>;

/**
 * A plugin: what `definePlugin` takes and the plugin module's default export.
 *
 * `activate` runs in a background worker when the plugin is enabled; it registers commands,
 * panels and blocks. `panels` and `blocks` render in their own sandboxed frames. They share no
 * memory with `activate`: use `api.storage` (and its `onChange`) to share state.
 */
export interface PluginDefinition<S extends SettingsSchema = SettingsSchema> {
  /** Settings the host shows in Settings → Plugins. */
  settings?: S;
  /** Runs when the plugin starts (enabled, installed, updated, or Tessera opened). */
  activate?(api: PluginApi<S>): void | Promise<void>;
  /** Runs before the plugin stops (disabled, updated, uninstalled). Registrations are removed for you. */
  deactivate?(): void | Promise<void>;
  /** Panel renderers, by panel ID (see {@link UiApi.addPanel}). */
  panels?: { readonly [id: string]: PanelRenderer<NoInfer<S>> };
  /** Block renderers, by block type (see {@link UiApi.addBlock}). */
  blocks?: { readonly [type: string]: BlockRenderer<JsonValue, NoInfer<S>> };
}
