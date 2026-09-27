/**
 * @tessera/plugin-api/testing — run a plugin against an in-memory workspace in unit tests.
 *
 * The harness gives the plugin the same API shape as the app, and enforces permissions the same
 * way: a call without permission rejects with `PluginError` (`permission_denied`). Panels and
 * blocks render into real DOM elements (use a DOM test environment such as jsdom).
 *
 * @example
 * import { createTestHarness } from '@tessera/plugin-api/testing';
 * import plugin from './main';
 *
 * const harness = createTestHarness(plugin, {
 *   permissions: ['pages:read', 'ui:commands'],
 *   pages: [{ title: 'Apollo', content: 'One small step' }],
 * });
 * await harness.activate();
 * await harness.runCommand('random-page');
 * expect(harness.openedPages).toHaveLength(1);
 */
import { PluginError } from '../errors';
import type { DefinedRenderer } from '../index';
import { PLUGIN_API_VERSION, PLUGIN_PERMISSIONS, type PluginPermission } from '../permissions';
import { resolveRowInput, runRowQuery } from '../query';
import { resolveSettingsValues, validateSettingValue, type SettingPrimitive } from '../settings';
import type {
  BlockContext,
  BlockOptions,
  BlockState,
  CommandDefinition,
  ContentFormat,
  CreatePageInput,
  DatabaseProperty,
  DatabasePropertyType,
  DatabaseRow,
  DocJSON,
  JsonValue,
  ListPagesOptions,
  NotifyOptions,
  PageChangeEvent,
  PageInfo,
  PanelContext,
  PanelOptions,
  PluginApi,
  PluginDefinition,
  PluginSurface,
  RenderFunction,
  RowInput,
  SettingsSchema,
  SettingsValues,
  ThemeInfo,
  UpdatePageInput,
} from '../types';
import { docToMarkdown, markdownToDoc } from './markdown';

export { docToMarkdown, markdownToDoc } from './markdown';

/** A page to start the harness with. */
export interface HarnessPageInput {
  id?: string;
  title: string;
  icon?: string;
  parentId?: string | null;
  /** Markdown. */
  content?: string;
  props?: Record<string, JsonValue>;
  trashed?: boolean;
}

/** A database to start the harness with. Row values are keyed by property name or ID. */
export interface HarnessDatabaseInput {
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

/** Options of {@link createTestHarness}. */
export interface TestHarnessOptions {
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

/** A rendered panel. */
export interface RenderedPanel {
  root: HTMLElement;
  /** True after the plugin called `ctx.close()`. */
  readonly closedByPlugin: boolean;
  /** Runs the panel's cleanup, like closing it in the app. */
  close(): Promise<void>;
}

/** A rendered block. */
export interface RenderedBlock<T extends JsonValue = JsonValue> {
  root: HTMLElement;
  /** The data the block holds now (after `setData`). */
  readonly data: T | null;
  /** True after the plugin called `ctx.remove()`. */
  readonly removed: boolean;
  /** Changes the block's state from the outside (undo, collaborators, selection). */
  update(state: Partial<BlockState<T>>): void;
  close(): Promise<void>;
}

interface HarnessPage {
  id: string;
  title: string;
  icon: string | null;
  kind: 'page' | 'database';
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  trashed: boolean;
  content: string;
  props: Record<string, JsonValue>;
}

interface HarnessDatabase {
  properties: DatabaseProperty[];
  rows: Array<{ id: string; values: Record<string, JsonValue> }>;
}

/** The in-memory workspace, as the test sees it. */
export interface HarnessWorkspace {
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

/** What {@link createTestHarness} returns. */
export interface TestHarness<S extends SettingsSchema = SettingsSchema> {
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

const PERMISSION_TEXT: Record<string, string> = {
  'pages:read': 'read your pages',
  'pages:write': 'create and edit pages',
  'databases:read': 'read your databases',
  'databases:write': 'edit your databases',
  'ui:commands': 'add commands',
  'ui:panels': 'add side panels',
  'ui:blocks': 'add custom blocks',
  storage: 'store data',
};

const DEFAULT_THEME: ThemeInfo = {
  mode: 'light',
  reducedMotion: false,
  tokens: {
    bg: '#ffffff',
    fg: '#1f1e1d',
    'fg-muted': '#6b6a66',
    border: '#e9e9e7',
    accent: '#5b5bd6',
    'font-sans': 'system-ui, sans-serif',
    'font-mono': 'ui-monospace, monospace',
  },
};

/**
 * Runs a plugin against an in-memory workspace. See the module documentation for an example.
 */
export function createTestHarness<S extends SettingsSchema>(
  plugin: PluginDefinition<S>,
  options: TestHarnessOptions = {},
): TestHarness<S> {
  const now = options.now ?? (() => Date.now());
  const granted: PluginPermission[] = [...(options.permissions ?? PLUGIN_PERMISSIONS)];
  const info = {
    id: options.plugin?.id ?? 'test-plugin',
    name: options.plugin?.name ?? 'Test plugin',
    version: options.plugin?.version ?? '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    permissions: granted,
  };
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${(counter += 1)}`;

  const pages = new Map<string, HarnessPage>();
  const databases = new Map<string, HarnessDatabase>();
  const storage = new Map<string, JsonValue>(Object.entries(options.storage ?? {}));
  const schema = (plugin.settings ?? {}) as S;
  let settingsValues = resolveSettingsValues(schema, options.settings ?? {});
  let theme: ThemeInfo = {
    ...DEFAULT_THEME,
    ...options.theme,
    tokens: { ...DEFAULT_THEME.tokens, ...options.theme?.tokens },
  };
  let currentPageId = options.currentPageId ?? null;

  const commands = new Map<string, CommandDefinition>();
  const panels = new Map<string, PanelOptions>();
  const blocks = new Map<string, BlockOptions>();
  const notifications: NotifyOptions[] = [];
  const openedPages: string[] = [];
  const openedPanels: string[] = [];

  const pageListeners = new Set<(event: PageChangeEvent) => void>();
  const storageListeners = new Set<(key: string, value: JsonValue | undefined) => void>();
  const settingsListeners = new Set<(values: SettingsValues<S>, key: keyof S & string) => void>();
  const themeListeners = new Set<(theme: ThemeInfo) => void>();
  const pageChangeListeners = new Set<(pageId: string | null) => void>();

  const emit = <A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A) => {
    for (const listener of [...listeners]) listener(...args);
  };
  const emitPage = (type: PageChangeEvent['type'], pageId: string, local: boolean) =>
    emit(pageListeners, { type, pageId, local });

  const requirePermission = (permission: PluginPermission) => {
    if (!granted.includes(permission))
      throw new PluginError(
        'permission_denied',
        // Same wording as the app, so tests can assert what users will see.
        `${info.name} doesn’t have permission to ${PERMISSION_TEXT[permission] ?? permission}. You can allow it in Settings → Plugins.`,
        permission,
      );
  };
  const isTrashed = (page: HarnessPage): boolean => {
    let current: HarnessPage | undefined = page;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (current.trashed) return true;
      seen.add(current.id);
      current = current.parentId ? pages.get(current.parentId) : undefined;
    }
    return false;
  };
  const toInfo = (page: HarnessPage): PageInfo => ({
    id: page.id,
    title: page.title,
    icon: page.icon,
    kind: page.kind,
    parentId: page.parentId,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    isRow: page.parentId !== null && pages.get(page.parentId)?.kind === 'database',
    trashed: isTrashed(page),
  });
  const requirePage = (id: string): HarnessPage => {
    const page = pages.get(id);
    if (!page) throw new PluginError('not_found', `Page "${id}" was not found`);
    return page;
  };
  const toMarkdown = (content: string | DocJSON): string =>
    typeof content === 'string' ? content : docToMarkdown(content);

  const addPage = (input: HarnessPageInput, kind: 'page' | 'database' = 'page'): HarnessPage => {
    const time = now();
    const page: HarnessPage = {
      id: input.id ?? nextId('page'),
      title: input.title,
      icon: input.icon ?? null,
      kind,
      parentId: input.parentId ?? null,
      createdAt: time,
      updatedAt: time,
      trashed: input.trashed ?? false,
      content: input.content ?? '',
      props: { ...input.props },
    };
    pages.set(page.id, page);
    return page;
  };
  for (const page of options.pages ?? []) addPage(page);

  const validateValue = (property: DatabaseProperty, value: JsonValue): void => {
    const fail = () => {
      throw new PluginError('invalid', `Invalid value for "${property.name}"`);
    };
    switch (property.type) {
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) fail();
        break;
      case 'checkbox':
        if (typeof value !== 'boolean') fail();
        break;
      case 'text':
      case 'url':
      case 'email':
      case 'select':
        if (typeof value !== 'string') fail();
        break;
      case 'multiSelect':
      case 'relation':
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail();
        break;
      case 'date':
        if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
        else if (typeof value.start !== 'string') fail();
        break;
      default:
        fail();
    }
  };
  const databaseOf = (id: string): HarnessDatabase => {
    const database = databases.get(id);
    if (!database || pages.get(id)?.kind !== 'database')
      throw new PluginError('not_found', `Database "${id}" was not found`);
    return database;
  };
  const rowsOf = (id: string, includeTrashed = false): DatabaseRow[] => {
    const database = databaseOf(id);
    const titleProperty = database.properties.find((property) => property.type === 'title');
    return database.rows.flatMap((row) => {
      const page = pages.get(row.id);
      if (!page || (!includeTrashed && isTrashed(page))) return [];
      const values: Record<string, JsonValue> = {};
      for (const property of database.properties) {
        if (property.type === 'title') values[property.id] = page.title;
        else if (property.type === 'createdTime') values[property.id] = page.createdAt;
        else if (property.type === 'updatedTime') values[property.id] = page.updatedAt;
        else values[property.id] = row.values[property.id] ?? null;
      }
      if (titleProperty) values[titleProperty.id] = page.title;
      return [
        {
          id: row.id,
          title: page.title,
          icon: page.icon,
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
          values,
        },
      ];
    });
  };
  const writeRow = (databaseId: string, rowId: string, input: RowInput) => {
    const database = databaseOf(databaseId);
    const resolved = resolveRowInput(database.properties, input);
    for (const [propertyId, value] of Object.entries(resolved.values)) {
      const property = database.properties.find((candidate) => candidate.id === propertyId);
      if (property && value !== null) validateValue(property, value);
    }
    const row = database.rows.find((candidate) => candidate.id === rowId);
    const page = pages.get(rowId);
    if (!row || !page) throw new PluginError('not_found', `Row "${rowId}" was not found`);
    for (const [propertyId, value] of Object.entries(resolved.values)) {
      if (value === null) delete row.values[propertyId];
      else row.values[propertyId] = value;
    }
    if (resolved.title !== undefined) page.title = resolved.title;
    page.updatedAt = now();
  };
  for (const input of options.databases ?? []) {
    const page = addPage({ title: input.title, ...(input.id ? { id: input.id } : {}) }, 'database');
    const properties: DatabaseProperty[] = [
      { id: nextId('prop'), name: 'Name', type: 'title' },
      ...input.properties.map((property) => ({
        id: property.id ?? nextId('prop'),
        name: property.name,
        type: property.type,
        ...(property.options
          ? {
              options: property.options.map((option) => ({
                id: option.id ?? nextId('opt'),
                name: option.name,
                color: option.color ?? 'default',
              })),
            }
          : {}),
      })),
    ];
    databases.set(page.id, { properties, rows: [] });
    for (const row of input.rows ?? []) {
      const rowPage = addPage({
        title: row.title ?? '',
        parentId: page.id,
        ...(row.id ? { id: row.id } : {}),
      });
      databases.get(page.id)?.rows.push({ id: rowPage.id, values: {} });
      writeRow(page.id, rowPage.id, { values: row.values ?? {} });
    }
  }

  const registrationOnly = (surface: PluginSurface, what: string) => {
    if (surface !== 'worker')
      throw new PluginError(
        'invalid_operation',
        `${what} is only available in activate(), not in ${surface}s`,
      );
  };

  const createApi = (surface: PluginSurface): PluginApi<S> => {
    const api: PluginApi<S> = {
      apiVersion: PLUGIN_API_VERSION,
      plugin: info,
      surface,
      hasPermission: (permission) => granted.includes(permission),
      commands: {
        register(command) {
          registrationOnly(surface, 'Registering commands');
          requirePermission('ui:commands');
          commands.set(command.id, command);
          return () => {
            if (commands.get(command.id) === command) commands.delete(command.id);
          };
        },
      },
      ui: {
        addPanel(panel) {
          registrationOnly(surface, 'Adding panels');
          requirePermission('ui:panels');
          if (!plugin.panels?.[panel.id])
            throw new PluginError('invalid', `No renderer for panel "${panel.id}" in panels`);
          panels.set(panel.id, panel);
          return () => {
            if (panels.get(panel.id) === panel) panels.delete(panel.id);
          };
        },
        async openPanel(id) {
          requirePermission('ui:panels');
          if (!panels.has(id)) throw new PluginError('not_found', `Panel "${id}" isn't registered`);
          openedPanels.push(id);
        },
        addBlock(block) {
          registrationOnly(surface, 'Adding blocks');
          requirePermission('ui:blocks');
          if (!plugin.blocks?.[block.type])
            throw new PluginError('invalid', `No renderer for block "${block.type}" in blocks`);
          blocks.set(block.type, block);
          return () => {
            if (blocks.get(block.type) === block) blocks.delete(block.type);
          };
        },
        async notify(input) {
          notifications.push(typeof input === 'string' ? { title: input } : input);
        },
        async render(name, input) {
          // Like the app: JSON in and out, and the same errors.
          const renderers = options.renderer?.renderers;
          if (!renderers)
            throw new PluginError(
              'not_found',
              `${info.name} has no renderer: its manifest names none.`,
            );
          const render = Object.hasOwn(renderers, name)
            ? (renderers[name] as RenderFunction | undefined)
            : undefined;
          if (typeof render !== 'function')
            throw new PluginError('not_found', `The renderer has no function "${name}".`);
          const output = await render(structuredClone(input ?? null));
          return JSON.parse(JSON.stringify(output ?? null)) as never;
        },
      },
      pages: {
        async list(listOptions: ListPagesOptions = {}) {
          requirePermission('pages:read');
          return [...pages.values()]
            .map(toInfo)
            .filter(
              (page) =>
                (listOptions.includeRows || !page.isRow) &&
                (listOptions.includeTrashed || !page.trashed) &&
                (listOptions.parentId === undefined || page.parentId === listOptions.parentId),
            )
            .sort((a, b) => a.title.localeCompare(b.title));
        },
        get: (async (id: string, getOptions?: { format: ContentFormat }) => {
          requirePermission('pages:read');
          const page = requirePage(id);
          const format = getOptions?.format ?? 'markdown';
          return {
            ...toInfo(page),
            format,
            content: format === 'doc' ? markdownToDoc(page.content) : page.content,
            props: structuredClone(page.props),
          };
        }) as PluginApi['pages']['get'],
        async create(input: CreatePageInput) {
          requirePermission('pages:write');
          if (input.parentId) requirePage(input.parentId);
          const page = addPage({
            title: input.title ?? '',
            parentId: input.parentId ?? null,
            content: input.content === undefined ? '' : toMarkdown(input.content),
            ...(input.icon ? { icon: input.icon } : {}),
          });
          emitPage('created', page.id, true);
          return toInfo(page);
        },
        async update(id: string, input: UpdatePageInput) {
          requirePermission('pages:write');
          const page = requirePage(id);
          if (input.title !== undefined) page.title = input.title;
          if (input.icon !== undefined) page.icon = input.icon;
          if (input.content !== undefined) page.content = toMarkdown(input.content);
          page.updatedAt = now();
          if (input.title !== undefined || input.icon !== undefined) emitPage('updated', id, true);
          if (input.content !== undefined) emitPage('content', id, true);
          return toInfo(page);
        },
        async current() {
          requirePermission('pages:read');
          return currentPageId;
        },
        async open(id) {
          requirePermission('pages:read');
          requirePage(id);
          openedPages.push(id);
          currentPageId = id;
        },
        onChange(listener) {
          requirePermission('pages:read');
          pageListeners.add(listener);
          return () => pageListeners.delete(listener);
        },
      },
      databases: {
        async list() {
          requirePermission('databases:read');
          return [...pages.values()]
            .filter((page) => page.kind === 'database' && !isTrashed(page))
            .map((page) => ({ id: page.id, title: page.title, icon: page.icon }))
            .sort((a, b) => a.title.localeCompare(b.title));
        },
        async get(id) {
          requirePermission('databases:read');
          const database = databaseOf(id);
          const page = requirePage(id);
          return {
            id,
            title: page.title,
            icon: page.icon,
            properties: structuredClone(database.properties),
            views: [{ id: `${id}-table`, name: 'Table', type: 'table' }],
          };
        },
        async query(id, query) {
          requirePermission('databases:read');
          return runRowQuery(databaseOf(id).properties, rowsOf(id), query);
        },
        async addRow(id, input = {}) {
          requirePermission('databases:write');
          const database = databaseOf(id);
          const page = addPage({ title: '', parentId: id });
          database.rows.push({ id: page.id, values: {} });
          try {
            writeRow(id, page.id, input);
          } catch (error) {
            database.rows.pop();
            pages.delete(page.id);
            throw error;
          }
          const row = rowsOf(id).find((candidate) => candidate.id === page.id);
          if (!row) throw new PluginError('internal', 'The row disappeared');
          return row;
        },
        async updateRow(id, rowId, input) {
          requirePermission('databases:write');
          writeRow(id, rowId, input);
          const row = rowsOf(id, true).find((candidate) => candidate.id === rowId);
          if (!row) throw new PluginError('not_found', `Row "${rowId}" was not found`);
          return row;
        },
      },
      storage: {
        async get<T extends JsonValue = JsonValue>(key: string) {
          requirePermission('storage');
          const value = storage.get(key);
          return value === undefined ? undefined : (structuredClone(value) as T);
        },
        async set(key, value) {
          requirePermission('storage');
          storage.set(key, structuredClone(value));
          emit(storageListeners, key, value);
        },
        async delete(key) {
          requirePermission('storage');
          storage.delete(key);
          emit(storageListeners, key, undefined);
        },
        async keys() {
          requirePermission('storage');
          return [...storage.keys()].sort();
        },
        onChange(listener) {
          requirePermission('storage');
          storageListeners.add(listener);
          return () => storageListeners.delete(listener);
        },
      },
      settings: {
        get: (key) => settingsValues[key] as SettingsValues<S>[typeof key],
        getAll: () => ({ ...settingsValues }) as SettingsValues<S>,
        async set(key, value) {
          const definition = schema[key];
          if (!definition) throw new PluginError('invalid', `Unknown setting "${key}"`);
          const result = validateSettingValue(definition, value);
          if (!result.ok) throw new PluginError('invalid', result.error);
          settingsValues = { ...settingsValues, [key]: result.value };
          emit(settingsListeners, api.settings.getAll(), key);
        },
        onChange(listener) {
          settingsListeners.add(listener);
          return () => settingsListeners.delete(listener);
        },
      },
      theme: {
        get: () => structuredClone(theme),
        onChange(listener) {
          themeListeners.add(listener);
          return () => themeListeners.delete(listener);
        },
      },
    };
    return api;
  };

  const workerApi = createApi('worker');
  // Microtasks only, so it also works under fake timers (every harness API call is a promise).
  const flush = async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  };
  const newRoot = () => {
    if (typeof document === 'undefined')
      throw new Error('Rendering panels and blocks needs a DOM (use a jsdom test environment)');
    const root = document.createElement('div');
    document.body.append(root);
    return root;
  };
  const cleanupOf = async (value: unknown): Promise<() => void> => {
    const resolved: unknown = await value;
    return typeof resolved === 'function' ? (resolved as () => void) : () => undefined;
  };

  const harness: TestHarness<S> = {
    api: workerApi,
    async activate() {
      await plugin.activate?.(workerApi);
    },
    async deactivate() {
      await plugin.deactivate?.();
      commands.clear();
      panels.clear();
      blocks.clear();
    },
    get commands() {
      return [...commands.values()].map(({ run: _run, ...rest }) => rest);
    },
    async runCommand(id, context = {}) {
      const command = commands.get(id);
      if (!command) throw new Error(`No command "${id}" is registered`);
      await command.run({ pageId: context.pageId === undefined ? currentPageId : context.pageId });
    },
    get panels() {
      return [...panels.values()];
    },
    get blocks() {
      return [...blocks.values()];
    },
    notifications,
    openedPages,
    openedPanels,
    workspace: {
      all: () =>
        [...pages.values()].map((page) => ({
          ...toInfo(page),
          content: page.content,
          props: page.props,
        })),
      get(id) {
        const page = pages.get(id);
        return page ? { ...toInfo(page), content: page.content } : undefined;
      },
      create(input) {
        const page = addPage(input);
        emitPage('created', page.id, false);
        return toInfo(page);
      },
      setContent(id, markdown) {
        const page = requirePage(id);
        page.content = markdown;
        page.updatedAt = now();
        emitPage('content', id, false);
      },
      rename(id, title) {
        requirePage(id).title = title;
        emitPage('updated', id, false);
      },
      trash(id) {
        requirePage(id).trashed = true;
        emitPage('trashed', id, false);
      },
      rows: (databaseId) => rowsOf(databaseId, true),
    },
    storage,
    setSetting(key, value) {
      const definition = schema[key];
      if (!definition) throw new Error(`Unknown setting "${key}"`);
      const result = validateSettingValue(definition, value);
      if (!result.ok) throw new Error(result.error);
      settingsValues = { ...settingsValues, [key]: result.value };
      emit(settingsListeners, workerApi.settings.getAll(), key);
    },
    setCurrentPage(pageId) {
      currentPageId = pageId;
      emit(pageChangeListeners, pageId);
    },
    setTheme(next) {
      theme = { ...theme, ...next, tokens: { ...theme.tokens, ...next.tokens } };
      emit(themeListeners, structuredClone(theme));
    },
    async renderPanel(id, renderOptions = {}) {
      const render = plugin.panels?.[id];
      if (!render) throw new Error(`The plugin has no panel "${id}"`);
      const root = renderOptions.root ?? newRoot();
      let closedByPlugin = false;
      const listeners = new Set<(pageId: string | null) => void>();
      const forward = (pageId: string | null) => emit(listeners, pageId);
      pageChangeListeners.add(forward);
      const ctx: PanelContext<S> = {
        root,
        api: createApi('panel'),
        panelId: id,
        get pageId() {
          return currentPageId;
        },
        onPageChange(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close() {
          closedByPlugin = true;
        },
      };
      const cleanup = await cleanupOf(render(ctx));
      await flush();
      return {
        root,
        get closedByPlugin() {
          return closedByPlugin;
        },
        async close() {
          pageChangeListeners.delete(forward);
          cleanup();
          await flush();
        },
      };
    },
    async renderBlock<T extends JsonValue = JsonValue>(
      type: string,
      renderOptions: Parameters<TestHarness<S>['renderBlock']>[1] = {},
    ): Promise<RenderedBlock<T>> {
      const render = plugin.blocks?.[type];
      if (!render) throw new Error(`The plugin has no block "${type}"`);
      const root = renderOptions.root ?? newRoot();
      let state: BlockState<T> = {
        data: (renderOptions.data ?? null) as T | null,
        readOnly: renderOptions.readOnly ?? false,
        selected: renderOptions.selected ?? false,
      };
      let removed = false;
      const listeners = new Set<(state: BlockState<T>) => void>();
      const ctx: BlockContext<T, S> = {
        root,
        api: createApi('block'),
        blockType: type,
        pageId: renderOptions.pageId ?? currentPageId ?? 'page-with-block',
        blockId: 'block-1',
        get data() {
          return state.data;
        },
        get readOnly() {
          return state.readOnly;
        },
        get selected() {
          return state.selected;
        },
        async setData(data) {
          if (state.readOnly) throw new PluginError('invalid_operation', 'This block is read-only');
          if (JSON.stringify(data).length > 64 * 1024)
            throw new PluginError('invalid', 'Block data is limited to 64 KB');
          state = { ...state, data: structuredClone(data) };
          emit(listeners, state);
        },
        onChange(listener) {
          listeners.add(listener);
          return (): void => {
            listeners.delete(listener);
          };
        },
        async remove() {
          removed = true;
        },
      };
      const cleanup = await cleanupOf(
        (render as unknown as (context: BlockContext<T, S>) => unknown)(ctx),
      );
      await flush();
      return {
        root,
        get data() {
          return state.data;
        },
        get removed() {
          return removed;
        },
        update(patch) {
          state = { ...state, ...patch };
          emit(listeners, state);
        },
        async close() {
          cleanup();
          await flush();
        },
      };
    },
    flush,
  };
  return harness;
}

/** Re-exported for convenience in tests. */
export { PluginError } from '../errors';
