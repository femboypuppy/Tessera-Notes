import {
  extractLinks,
  getCellValue,
  getPageProps,
  getRow,
  InvalidOperationError,
  listProperties,
  listRows,
  listViews,
  NotFoundError,
  readDocJSON,
  resolveRows,
  setRowValues,
  validateDocJSON,
  writeDocJSON,
  type AppContext,
  type DocJSON,
  type JsonValue,
  type PageMeta,
  type PagesSnapshot,
  type PropertyDefinition,
} from '@tessera/core';
import type { DatabaseProperty, DatabaseRow, DatabaseSchema, PageInfo } from '@tessera/plugin-api';
import { resolveRowInput, runRowQuery } from '@tessera/plugin-api/query';
import type * as Y from 'yjs';
import { PluginCallError } from '../errors';
import { t } from '../i18n';
import type { PluginManager } from '../manager';
import type { ApiHandlers } from '../rpc/endpoint';
import type { ApiParams, ConnectionSurface } from '../rpc/protocol';
import type { InstalledPlugin } from '../store/types';

/** Registrations a plugin makes from its worker (implemented by the plugin instance). */
export interface RegistrationApi {
  registerCommand(params: ApiParams<'commands.register'>): void;
  unregisterCommand(id: string): void;
  addPanel(params: ApiParams<'ui.addPanel'>): void;
  removePanel(id: string): void;
  openPanel(id: string): void;
  addBlock(params: ApiParams<'ui.addBlock'>): void;
  removeBlock(type: string): void;
}

/** One connection's subscriptions (the host forwards events only to subscribers). */
export interface ConnectionApi {
  surface: ConnectionSurface;
  subscribe(topic: 'pages' | 'storage', on: boolean): void;
}

/** What block and panel frames may do to their own surface. */
export interface SurfaceApi {
  setBlockData?(data: JsonValue): void;
  isReadOnly?(): boolean;
  removeBlock?(): void;
  closePanel?(): void;
}

/** Everything the API handlers of one connection need. */
export interface ApiContext {
  ctx: AppContext;
  manager: PluginManager;
  plugin(): InstalledPlugin;
  registrations: RegistrationApi;
  connection: ConnectionApi;
  surface: SurfaceApi;
  /** Rate limiting of notifications, shared by all of a plugin's connections. */
  allowNotification(): boolean;
  /** Runs one of the plugin's render functions in its renderer frame. */
  render(name: string, input: JsonValue): Promise<unknown>;
}

/** A page's metadata as plugins see it. */
export function toPageInfo(page: PageMeta, snapshot: PagesSnapshot): PageInfo {
  return {
    id: page.id,
    title: page.title,
    icon: page.icon ?? null,
    kind: page.kind,
    parentId: snapshot.effectiveParentId(page.id),
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    isRow: snapshot.isRow(page.id),
    trashed: snapshot.isTrashed(page.id),
  };
}

function toDatabaseProperty(property: PropertyDefinition): DatabaseProperty {
  const result: DatabaseProperty = { id: property.id, name: property.name, type: property.type };
  if (property.options)
    result.options = property.options.map((option) => ({
      id: option.id,
      name: option.name,
      color: option.color,
    }));
  return result;
}

/** Validates content from a plugin and turns it into a document. */
/**
 * Which block IDs of a page's markdown to keep: only those a link points at (`^id`), so the text
 * a plugin reads (and counts, or writes back) has no markers for blocks nobody links to.
 */
async function linkedBlocksOf(
  ctx: AppContext,
  pageId: string,
  doc: DocJSON,
): Promise<(blockId: string) => boolean> {
  const refs = new Set<string>();
  for (const link of await ctx.services.linkIndex.backlinks(pageId))
    if (link.blockRef) refs.add(link.blockRef);
  // Self-links aren't backlinks.
  for (const link of extractLinks(doc))
    if (link.targetPageId === pageId && link.blockRef) refs.add(link.blockRef);
  return (blockId) => refs.has(blockId);
}

function toDocument(ctx: AppContext, content: string | { type: 'doc' }): DocJSON {
  if (typeof content === 'string') return ctx.services.markdownCodec.parse(content).doc;
  const result = validateDocJSON(content);
  if (!result.ok)
    throw new PluginCallError(
      'invalid',
      `The document isn't valid: ${result.errors.slice(0, 3).join('; ')}`,
    );
  return result.doc;
}

async function writeContent(ctx: AppContext, pageId: string, doc: DocJSON): Promise<void> {
  const handle = await ctx.loadPageDoc(pageId);
  try {
    writeDocJSON(handle.doc, doc);
  } finally {
    handle.release();
  }
}

/** Builds the handlers of every API method for one connection of one plugin. */
export function createApiHandlers(api: ApiContext): ApiHandlers {
  const { ctx, manager } = api;
  const id = () => api.plugin().id;
  const snapshot = () => ctx.workspace.pages.getSnapshot();
  const requirePage = (pageId: string): PageMeta => {
    const page = snapshot().get(pageId);
    if (!page) throw new NotFoundError('Page', pageId);
    return page;
  };
  const requireDatabase = (databaseId: string): PageMeta => {
    const page = snapshot().get(databaseId);
    if (!page || page.kind !== 'database') throw new NotFoundError('Database', databaseId);
    return page;
  };
  const withDatabase = async <T>(databaseId: string, run: (doc: Y.Doc) => T) => {
    requireDatabase(databaseId);
    const handle = await ctx.loadDatabaseDoc(databaseId);
    try {
      return run(handle.doc);
    } finally {
      handle.release();
    }
  };
  const readRows = (doc: Y.Doc) => {
    const properties = listProperties(doc);
    const plain = properties.map(toDatabaseProperty);
    const rows: DatabaseRow[] = resolveRows(listRows(doc), snapshot())
      .filter((row) => !row.trashed && !row.missingPage)
      .map((row) => {
        const values: Record<string, JsonValue> = {};
        for (const property of properties) values[property.id] = getCellValue(row, property);
        return {
          id: row.id,
          title: row.title,
          icon: row.icon ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          values,
        };
      });
    return { properties: plain, rows };
  };
  const readRow = async (databaseId: string, rowId: string): Promise<DatabaseRow> => {
    const row = await withDatabase(databaseId, (doc) =>
      readRows(doc).rows.find((candidate) => candidate.id === rowId),
    );
    if (!row) throw new NotFoundError('Row', rowId);
    return row;
  };
  const surfaceOnly = <T>(value: T | undefined, what: string): T => {
    if (value === undefined)
      throw new PluginCallError('invalid_operation', `${what} isn't available here`);
    return value;
  };

  return {
    'commands.register': (params) => api.registrations.registerCommand(params),
    'commands.unregister': ({ id: commandId }) => api.registrations.unregisterCommand(commandId),
    'ui.addPanel': (params) => api.registrations.addPanel(params),
    'ui.removePanel': ({ id: panelId }) => api.registrations.removePanel(panelId),
    'ui.openPanel': ({ id: panelId }) => api.registrations.openPanel(panelId),
    'ui.addBlock': (params) => api.registrations.addBlock(params),
    'ui.removeBlock': ({ type }) => api.registrations.removeBlock(type),
    'ui.notify': (params) => {
      if (!api.allowNotification()) throw new PluginCallError('unavailable', t('errNotifyRate'));
      const plugin = api.plugin().manifest.name;
      ctx.toast({
        title: params.title,
        description: [params.description, t('notificationFrom', { plugin })]
          .filter(Boolean)
          .join(' · '),
        variant: params.variant ?? 'default',
      });
    },
    'ui.render': ({ name, input }) => api.render(name, input ?? null),

    'pages.list': (params) => {
      const current = snapshot();
      return current
        .all()
        .filter(
          (page) =>
            (params?.includeRows || !current.isRow(page.id)) &&
            (params?.includeTrashed || !current.isTrashed(page.id)) &&
            (params?.parentId === undefined ||
              current.effectiveParentId(page.id) === params.parentId),
        )
        .map((page) => toPageInfo(page, current))
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    },
    'pages.get': async ({ id: pageId, format = 'markdown' }) => {
      const page = requirePage(pageId);
      const handle = await ctx.loadPageDoc(pageId);
      try {
        const doc = readDocJSON(handle.doc);
        const props = getPageProps(handle.doc);
        return {
          ...toPageInfo(page, snapshot()),
          format,
          content:
            format === 'doc'
              ? doc
              : ctx.services.markdownCodec.serialize(doc, {
                  keepBlockId: await linkedBlocksOf(ctx, pageId, doc),
                }),
          props,
        };
      } finally {
        handle.release();
      }
    },
    'pages.create': async ({ title, parentId, icon, content }) => {
      if (parentId) {
        const parent = requirePage(parentId);
        if (parent.kind === 'database')
          throw new InvalidOperationError('Add rows to a database with api.databases.addRow');
      }
      // Validate the content before creating anything.
      const doc = content === undefined ? null : toDocument(ctx, content);
      const input: { title: string; parentId: string | null; icon?: string } = {
        title: title ?? '',
        parentId: parentId ?? null,
      };
      if (icon) input.icon = icon;
      const page = ctx.workspace.createPage(input);
      if (doc) await writeContent(ctx, page.id, doc);
      return toPageInfo(ctx.workspace.getPage(page.id) ?? page, snapshot());
    },
    'pages.update': async ({ id: pageId, title, icon, content }) => {
      requirePage(pageId);
      const doc = content === undefined ? null : toDocument(ctx, content);
      if (title !== undefined) ctx.workspace.renamePage(pageId, title);
      if (icon !== undefined) ctx.workspace.setIcon(pageId, icon);
      if (doc) await writeContent(ctx, pageId, doc);
      return toPageInfo(requirePage(pageId), snapshot());
    },
    'pages.current': () => ctx.getCurrentPageId(),
    'pages.open': ({ id: pageId }) => {
      requirePage(pageId);
      ctx.navigate(pageId);
    },
    'pages.subscribe': () => api.connection.subscribe('pages', true),
    'pages.unsubscribe': () => api.connection.subscribe('pages', false),

    'databases.list': () => {
      const current = snapshot();
      return current
        .all()
        .filter((page) => page.kind === 'database' && !current.isTrashed(page.id))
        .map((page) => ({ id: page.id, title: page.title, icon: page.icon ?? null }))
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    },
    'databases.get': ({ id: databaseId }) =>
      withDatabase(databaseId, (doc): DatabaseSchema => {
        const page = requireDatabase(databaseId);
        return {
          id: databaseId,
          title: page.title,
          icon: page.icon ?? null,
          properties: listProperties(doc).map(toDatabaseProperty),
          views: listViews(doc).map((view) => ({ id: view.id, name: view.name, type: view.type })),
        };
      }),
    'databases.query': ({ id: databaseId, query }) =>
      withDatabase(databaseId, (doc) => {
        const { properties, rows } = readRows(doc);
        return runRowQuery(properties, rows, query ?? {});
      }),
    'databases.addRow': async ({ id: databaseId, input = {} }) => {
      const properties = await withDatabase(databaseId, (doc) =>
        listProperties(doc).map(toDatabaseProperty),
      );
      const resolved = resolveRowInput(properties, input);
      const values = Object.fromEntries(
        Object.entries(resolved.values).filter(([, value]) => value !== null),
      );
      const rowInput: { title?: string; values?: Record<string, JsonValue> } = { values };
      if (resolved.title !== undefined) rowInput.title = resolved.title;
      const page = await ctx.workspace.addDatabaseRow(databaseId, rowInput);
      return readRow(databaseId, page.id);
    },
    'databases.updateRow': async ({ id: databaseId, rowId, input }) => {
      await withDatabase(databaseId, (doc) => {
        if (!getRow(doc, rowId)) throw new NotFoundError('Row', rowId);
        const resolved = resolveRowInput(listProperties(doc).map(toDatabaseProperty), input);
        if (Object.keys(resolved.values).length)
          setRowValues(doc, rowId, resolved.values, { userId: ctx.currentUser.id });
        if (resolved.title !== undefined) ctx.workspace.renamePage(rowId, resolved.title);
      });
      return readRow(databaseId, rowId);
    },

    'storage.get': async ({ key }) => {
      const value = await manager.storageGet(id(), key);
      return value === undefined ? {} : { value };
    },
    'storage.set': ({ key, value }) => manager.storageSet(id(), key, value),
    'storage.delete': ({ key }) => manager.storageDelete(id(), key),
    'storage.keys': () => manager.storageKeys(id()),
    'storage.subscribe': () => api.connection.subscribe('storage', true),
    'storage.unsubscribe': () => api.connection.subscribe('storage', false),

    'settings.set': async ({ key, value }) => {
      await manager.setSetting(id(), key, value);
    },

    'block.setData': ({ data }) => {
      if (surfaceOnly(api.surface.isReadOnly, 'block.setData')())
        throw new PluginCallError('invalid_operation', t('errReadOnlyBlock'));
      surfaceOnly(api.surface.setBlockData, 'block.setData')(data);
    },
    'block.remove': () => {
      if (surfaceOnly(api.surface.isReadOnly, 'block.remove')())
        throw new PluginCallError('invalid_operation', t('errReadOnlyBlock'));
      surfaceOnly(api.surface.removeBlock, 'block.remove')();
    },
    'panel.close': () => surfaceOnly(api.surface.closePanel, 'panel.close')(),
  };
}
