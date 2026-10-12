import type * as Y from 'yjs';
import type { addRow, initDatabaseDoc } from '../database/database-doc';
import { InvalidOperationError, NotFoundError, toError } from '../errors';
import { isValidId, newId } from '../ids';
import { databaseDocName, pageDocName, workspaceDocName } from '../model/doc-names';
import type { PagesChange } from '../model/observe-pages';
import { getPageProps, setPageProps } from '../model/page-doc';
import type { PageMeta } from '../model/page-meta';
import {
  createPage,
  createPages,
  deletePagePermanently,
  emptyTrash,
  getPage,
  movePage,
  renamePage,
  restorePage,
  setCover,
  setFavorite,
  setIcon,
  touchPage,
  trashPage,
  type CreatePagesInput,
  type MutationOptions,
} from '../model/pages';
import { MemoryAssetBackend, MemoryAssetStore } from '../services/asset-store';
import { MemoryDocStore, MemoryDocStoreBackend } from '../services/doc-store';
import {
  createBasicMarkdownExporter,
  createBasicMarkdownImporter,
  createExporterRegistry,
  createImporterRegistry,
} from '../services/import-export';
import {
  disposeService,
  resolveService,
  type AnyServiceRegistration,
  type AppServiceContext,
  type IndexServiceContext,
  type ServiceKey,
  type ServiceMap,
  type StorageServiceContext,
} from '../services/registry';
import { LocalSyncProvider } from '../services/sync-provider';
import { MemoryWorkspaceRegistry, type WorkspaceInfo } from '../services/workspace-registry';
import type { AppContext, ShellBridge, ToastOptions, WorkspaceApi } from './app-context';
import { createBlockRendererRegistry } from './blocks';
import { createCommandRegistry } from './commands';
import { createBatchDebouncer, createKeyedDebouncer } from './debounce';
import { DocManager, type DocHandle, type DocUpdateEvent } from './doc-manager';
import { createEventBus } from './events';
import {
  createContributionRegistry,
  type ContributionKind,
  type ContributionMap,
  type FeatureModule,
} from './feature';
import { createPagesStore, type PagesSnapshot } from './pages-store';
import { detectPlatform, type PlatformInfo } from './platform';
import {
  LocalStorageSettingsStore,
  SETTING_KEYS,
  WorkspaceSettingsStore,
  type SettingsStore,
} from './settings';
import { colorForId, type CurrentUser } from './user';

/** Where a runtime error happened (for logs and error reporting). */
export interface RuntimeErrorContext {
  area: 'service' | 'feature' | 'docs' | 'events' | 'command';
  /** Feature ID, service registration ID, doc name or command ID. */
  source: string;
}

export interface AppRuntimeOptions {
  /** Every feature module, in load order. Duplicate IDs are dropped (with an error). */
  features: readonly FeatureModule[];
  platform?: PlatformInfo;
  /** Defaults to localStorage (`tessera:device:*`). */
  deviceSettings?: SettingsStore;
  /** Name for a user who never set one (translated by the shell). Default `''`. */
  defaultUserName?: string;
  onError?: (error: Error, context: RuntimeErrorContext) => void;
  /** Close docs this long after their last release. Default 5000 ms. */
  releaseDelayMs?: number;
  /** Debounce of `doc.changed`/`database.changed`. Default 750 ms (max wait 3 s). */
  docChangeDebounceMs?: number;
  /** Debounce of `updatedAt` bumps on local edits. Default 1500 ms. */
  touchDebounceMs?: number;
}

/** An open workspace. */
export interface WorkspaceSession {
  readonly ctx: AppContext;
  readonly workspace: WorkspaceInfo;
  /** Features whose `activate` threw (their contributions are removed). */
  readonly featureErrors: ReadonlyMap<string, Error>;
  /** Runs pending debounced events now (tests, and before closing). */
  flushEvents(): void;
  /** Runs pending events and waits until every doc write is stored. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The app runtime: resolves app-wide services once and opens workspace sessions. The web shell,
 * the desktop app and `createTestAppContext` all use it, so they behave the same.
 */
export interface AppRuntime {
  readonly features: readonly FeatureModule[];
  readonly platform: PlatformInfo;
  readonly deviceSettings: SettingsStore;
  readonly workspaceRegistry: ServiceMap['workspaceRegistry'];
  readonly markdownCodec: ServiceMap['markdownCodec'];
  readonly credentialStore: ServiceMap['credentialStore'];
  readonly fileSaver: ServiceMap['fileSaver'];
  /** Which implementation each app service resolved to. */
  readonly appServiceSources: Readonly<Partial<Record<ServiceKey, string>>>;
  getCurrentUser(): CurrentUser;
  updateCurrentUser(patch: { name?: string; color?: string }): CurrentUser;
  openWorkspace(workspace: WorkspaceInfo, bridge: ShellBridge): Promise<WorkspaceSession>;
  dispose(): Promise<void>;
}

/**
 * The database doc helpers, loaded the first time a database is touched. They validate with zod,
 * which the shell bundle doesn't otherwise need.
 */
const loadDatabaseHelpers = () => import('../database/database-doc');

/** Creates the {@link AppRuntime}: validates features and resolves the app-phase services. */
export async function createAppRuntime(options: AppRuntimeOptions): Promise<AppRuntime> {
  const report = (error: unknown, context: RuntimeErrorContext) => {
    const err = toError(error);
    if (options.onError) options.onError(err, context);
    else console.error(`[runtime] ${context.area} ${context.source}:`, err);
  };
  const seen = new Set<string>();
  const features = options.features.filter((feature) => {
    if (!feature.id || seen.has(feature.id)) {
      report(new Error(`Duplicate or empty feature ID "${feature.id}"`), {
        area: 'feature',
        source: feature.id,
      });
      return false;
    }
    seen.add(feature.id);
    return true;
  });
  const registrations: AnyServiceRegistration[] = features.flatMap(
    (feature) => feature.services ?? [],
  );
  const platform = options.platform ?? detectPlatform();
  const deviceSettings = options.deviceSettings ?? new LocalStorageSettingsStore();

  // The user ID is a device setting: a nanoid on first run, replaced by the account ID when the
  // sync feature signs in (it sets SETTING_KEYS.userId, and `user.changed` follows).
  const savedUserId = deviceSettings.get(SETTING_KEYS.userId);
  const deviceUserId = isValidId(savedUserId) ? savedUserId : newId();
  if (savedUserId !== deviceUserId) deviceSettings.set(SETTING_KEYS.userId, deviceUserId);
  const getCurrentUser = (): CurrentUser => {
    const savedId = deviceSettings.get(SETTING_KEYS.userId);
    const id = isValidId(savedId) ? savedId : deviceUserId;
    const name = deviceSettings.get(SETTING_KEYS.userName);
    const color = deviceSettings.get(SETTING_KEYS.userColor);
    return {
      id,
      name: typeof name === 'string' ? name : (options.defaultUserName ?? ''),
      color: typeof color === 'string' ? color : colorForId(id),
    };
  };

  // In-memory data survives closing and reopening a workspace within one app run.
  const memoryDocs = new Map<string, MemoryDocStoreBackend>();
  const memoryAssets = new Map<string, MemoryAssetBackend>();
  const backend = <T>(map: Map<string, T>, id: string, create: () => T): T => {
    let value = map.get(id);
    if (!value) {
      value = create();
      map.set(id, value);
    }
    return value;
  };

  const appContext: AppServiceContext = { platform, settings: deviceSettings };
  const onServiceError = (error: Error, registration: { id: string }) =>
    report(error, { area: 'service', source: registration.id });
  const registry = await resolveService(
    'workspaceRegistry',
    registrations,
    appContext,
    {
      id: 'memory',
      create: () =>
        new MemoryWorkspaceRegistry({
          onRemove: (id) => {
            memoryDocs.delete(id);
            memoryAssets.delete(id);
          },
        }),
    },
    { onError: onServiceError },
  );
  const codec = await resolveService(
    'markdownCodec',
    registrations,
    appContext,
    {
      id: 'basic',
      // The stubs load on demand, so their helpers (and ProseMirror) stay out of the shell bundle.
      create: async () => new (await import('../services/markdown-codec')).BasicMarkdownCodec(),
    },
    { onError: onServiceError },
  );
  const credentials = await resolveService(
    'credentialStore',
    registrations,
    appContext,
    {
      id: 'memory',
      create: async () =>
        new (await import('../services/credential-store')).MemoryCredentialStore(),
    },
    { onError: onServiceError },
  );
  const files = await resolveService(
    'fileSaver',
    registrations,
    appContext,
    {
      id: 'download',
      create: async () => new (await import('../services/file-saver')).DownloadFileSaver(),
    },
    { onError: onServiceError },
  );

  const sessions = new Set<WorkspaceSession>();

  const runtime: AppRuntime = {
    features,
    platform,
    deviceSettings,
    workspaceRegistry: registry.service,
    markdownCodec: codec.service,
    credentialStore: credentials.service,
    fileSaver: files.service,
    appServiceSources: {
      workspaceRegistry: registry.source,
      markdownCodec: codec.source,
      credentialStore: credentials.source,
      fileSaver: files.source,
    },
    getCurrentUser,
    updateCurrentUser(patch) {
      if (patch.name !== undefined)
        deviceSettings.set(SETTING_KEYS.userName, patch.name.trim().slice(0, 80));
      if (patch.color !== undefined) deviceSettings.set(SETTING_KEYS.userColor, patch.color);
      return getCurrentUser();
    },
    async openWorkspace(workspace, bridge) {
      const session = await openWorkspaceSession({
        runtime,
        workspace,
        bridge,
        registrations,
        memoryDocs: () => backend(memoryDocs, workspace.id, () => new MemoryDocStoreBackend()),
        memoryAssets: () => backend(memoryAssets, workspace.id, () => new MemoryAssetBackend()),
        report,
        options,
      });
      sessions.add(session);
      const close = session.close.bind(session);
      return Object.assign(session, {
        close: async () => {
          sessions.delete(session);
          await close();
        },
      });
    },
    async dispose() {
      await Promise.all([...sessions].map((session) => session.close()));
      await disposeService(registry.service);
      await disposeService(codec.service);
    },
  };
  return runtime;
}

interface SessionInput {
  runtime: AppRuntime;
  workspace: WorkspaceInfo;
  bridge: ShellBridge;
  registrations: AnyServiceRegistration[];
  memoryDocs: () => MemoryDocStoreBackend;
  memoryAssets: () => MemoryAssetBackend;
  report: (error: unknown, context: RuntimeErrorContext) => void;
  options: AppRuntimeOptions;
}

/**
 * The context a feature's `activate` receives: the session context, with registrations (commands,
 * blocks, contributions, importers, exporters, event handlers) recorded in `offs` so the runtime
 * can undo them if activation fails. Everything else is the shared context.
 */
function scopeContext(context: AppContext, offs: Array<() => void>): AppContext {
  const track = (off: () => void) => {
    offs.push(off);
    return off;
  };
  const scoped: Partial<AppContext> = {
    commands: {
      ...context.commands,
      register: (command) => track(context.commands.register(command)),
      registerMany: (list) => track(context.commands.registerMany(list)),
    },
    blocks: {
      ...context.blocks,
      register: (registration) => track(context.blocks.register(registration)),
      registerSlashMenuItems: (items) => track(context.blocks.registerSlashMenuItems(items)),
    },
    contributions: {
      ...context.contributions,
      register: (kind, item, featureId) =>
        track(context.contributions.register(kind, item, featureId)),
    },
    importers: {
      ...context.importers,
      register: (importer, options) => track(context.importers.register(importer, options)),
    },
    exporters: {
      ...context.exporters,
      register: (exporter, options) => track(context.exporters.register(exporter, options)),
    },
    events: {
      ...context.events,
      on: (type, handler) => track(context.events.on(type, handler)),
      once: (type, handler) => track(context.events.once(type, handler)),
    },
  };
  // Inherit everything else (including the live `currentUser` getter) from the session context.
  return Object.assign(Object.create(context) as AppContext, scoped);
}

function affectedByTrash(snapshot: PagesSnapshot, pageId: string): string[] {
  const result = [pageId];
  const stack = [...snapshot.children(pageId, { includeTrashed: true, includeRows: true })];
  while (stack.length) {
    const page = stack.pop();
    if (!page || page.trashedAt !== undefined) continue;
    result.push(page.id);
    stack.push(...snapshot.children(page.id, { includeTrashed: true, includeRows: true }));
  }
  return result;
}

async function openWorkspaceSession(input: SessionInput): Promise<WorkspaceSession> {
  const { runtime, workspace, bridge, registrations, report, options } = input;
  const events = createEventBus({
    onError: (error, type) => report(error, { area: 'events', source: String(type) }),
  });
  const onServiceError = (error: Error, registration: { id: string }) =>
    report(error, { area: 'service', source: registration.id });
  const serviceSources: Partial<Record<ServiceKey, string>> = { ...runtime.appServiceSources };
  const disposers: Array<() => void | Promise<void>> = [];

  // 1. Storage services.
  const storageContext: StorageServiceContext = {
    platform: runtime.platform,
    settings: runtime.deviceSettings,
    workspace,
    app: {
      workspaceRegistry: runtime.workspaceRegistry,
      markdownCodec: runtime.markdownCodec,
      credentialStore: runtime.credentialStore,
    },
    currentUser: runtime.getCurrentUser(),
    events,
  };
  const docStore = await resolveService(
    'docStore',
    registrations,
    storageContext,
    {
      id: 'memory',
      create: () => new MemoryDocStore(input.memoryDocs()),
    },
    { onError: onServiceError },
  );
  const assetStore = await resolveService(
    'assetStore',
    registrations,
    storageContext,
    {
      id: 'memory',
      create: () => new MemoryAssetStore(input.memoryAssets()),
    },
    { onError: onServiceError },
  );
  const syncProvider = await resolveService(
    'syncProvider',
    registrations,
    storageContext,
    {
      id: 'local',
      create: () => new LocalSyncProvider(),
    },
    { onError: onServiceError },
  );
  serviceSources.docStore = docStore.source;
  serviceSources.assetStore = assetStore.source;
  serviceSources.syncProvider = syncProvider.source;

  // 2. Docs.
  let wsDoc: Y.Doc | null = null;
  const touchOptions = (): MutationOptions => ({ userId: runtime.getCurrentUser().id });
  const docChanged = createKeyedDebouncer<{
    docName: string;
    local: boolean;
    kind: 'page' | 'database';
  }>(
    (id, info) => {
      if (info.kind === 'page')
        events.emit('doc.changed', { pageId: id, docName: info.docName, local: info.local });
      else
        events.emit('database.changed', {
          databaseId: id,
          docName: info.docName,
          local: info.local,
        });
    },
    {
      delayMs: options.docChangeDebounceMs ?? 750,
      maxWaitMs: 3000,
      merge: (a, b) => ({ ...b, local: a.local || b.local }),
    },
  );
  // Every page edited in a burst is touched in one workspace transaction, so an import or a
  // script that writes thousands of pages rebuilds the page index and re-renders the page tree
  // once, not once per page (that was O(pages²) of work after a bulk write).
  const touch = createBatchDebouncer(
    (pageIds) => {
      const ws = wsDoc;
      if (!ws) return;
      ws.transact(() => {
        for (const pageId of pageIds)
          if (getPage(ws, pageId)) touchPage(ws, pageId, touchOptions());
      });
    },
    { delayMs: options.touchDebounceMs ?? 1500, maxWaitMs: 10_000 },
  );
  const docs = new DocManager({
    docStore: docStore.service,
    syncProvider: syncProvider.service,
    getUser: runtime.getCurrentUser,
    releaseDelayMs: options.releaseDelayMs ?? 5000,
    onDocUpdate: (event: DocUpdateEvent) => {
      if (event.kind === 'workspace') return;
      docChanged.call(event.id, { docName: event.docName, local: event.local, kind: event.kind });
      if (event.local) touch.call(event.id);
    },
    onError: (error, context) =>
      report(error, { area: 'docs', source: `${context.operation} ${context.docName}` }),
  });

  const wsHandle = await docs.load(workspaceDocName(workspace.id));
  const workspaceDoc = wsHandle.doc;
  wsDoc = workspaceDoc;

  // 3. Page events.
  const emitPageEvents = (change: PagesChange) => {
    const snapshot = pages.getSnapshot();
    const { local } = change;
    for (const page of change.added) events.emit('page.created', { page, local });
    for (const { page, previous, fields } of change.updated) {
      events.emit('page.updated', { page, previous, fields, local });
      if (fields.includes('title')) {
        events.emit('page.renamed', {
          pageId: page.id,
          title: page.title,
          previousTitle: previous.title,
          local,
        });
      }
      if (fields.includes('parentId')) {
        events.emit('page.moved', {
          pageId: page.id,
          parentId: page.parentId,
          previousParentId: previous.parentId,
          local,
        });
      }
      if (fields.includes('trashedAt')) {
        const affectedPageIds = affectedByTrash(snapshot, page.id);
        if (page.trashedAt !== undefined && previous.trashedAt === undefined) {
          events.emit('page.trashed', { pageId: page.id, affectedPageIds, local });
        } else if (page.trashedAt === undefined && previous.trashedAt !== undefined) {
          events.emit('page.restored', { pageId: page.id, affectedPageIds, local });
        }
      }
    }
    for (const page of change.removed)
      events.emit('page.deleted', { pageId: page.id, page, local });
  };
  const pages = createPagesStore(workspaceDoc, { onChange: emitPageEvents });
  disposers.push(() => pages.dispose());

  const loadPageDoc = (pageId: string): Promise<DocHandle> => docs.load(pageDocName(pageId));
  const loadDatabaseDoc = (databaseId: string): Promise<DocHandle> =>
    docs.load(databaseDocName(databaseId));

  // 4. Index services.
  const indexContext: IndexServiceContext = {
    ...storageContext,
    storage: {
      docStore: docStore.service,
      assetStore: assetStore.service,
      syncProvider: syncProvider.service,
    },
    workspaceDoc,
    pages,
    loadPageDoc,
    loadDatabaseDoc,
  };
  const indexSources = { pages, loadPageDoc, events };
  const searchIndex = await resolveService(
    'searchIndex',
    registrations,
    indexContext,
    {
      id: 'naive',
      create: async () =>
        new (await import('../services/search-index')).NaiveSearchIndex(indexSources),
    },
    { onError: onServiceError },
  );
  const linkIndex = await resolveService(
    'linkIndex',
    registrations,
    indexContext,
    {
      id: 'naive',
      create: async () => new (await import('../services/link-index')).NaiveLinkIndex(indexSources),
    },
    { onError: onServiceError },
  );
  serviceSources.searchIndex = searchIndex.source;
  serviceSources.linkIndex = linkIndex.source;

  const services: ServiceMap = {
    workspaceRegistry: runtime.workspaceRegistry,
    markdownCodec: runtime.markdownCodec,
    credentialStore: runtime.credentialStore,
    fileSaver: runtime.fileSaver,
    docStore: docStore.service,
    assetStore: assetStore.service,
    syncProvider: syncProvider.service,
    searchIndex: searchIndex.service,
    linkIndex: linkIndex.service,
  };

  // 5. Workspace API.
  const opts = (): MutationOptions => ({ userId: runtime.getCurrentUser().id });
  const removeRowEntries = async (
    removed: PageMeta[],
    parentsBefore: Map<string, string | null>,
  ) => {
    const snapshot = pages.getSnapshot();
    const byDatabase = new Map<string, string[]>();
    for (const page of removed) {
      const parentId = parentsBefore.get(page.id) ?? null;
      if (parentId && snapshot.get(parentId)?.kind === 'database') {
        byDatabase.set(parentId, [...(byDatabase.get(parentId) ?? []), page.id]);
      }
    }
    if (byDatabase.size === 0) return;
    const { deleteRow, getRow } = await loadDatabaseHelpers();
    for (const [databaseId, rowIds] of byDatabase) {
      const handle = await loadDatabaseDoc(databaseId);
      try {
        handle.doc.transact(() => {
          for (const rowId of rowIds) if (getRow(handle.doc, rowId)) deleteRow(handle.doc, rowId);
        });
      } finally {
        handle.release();
      }
    }
  };
  const deleteDocsOf = async (removed: PageMeta[]) => {
    for (const page of removed) {
      await docs.deleteDoc(pageDocName(page.id));
      if (page.kind === 'database') await docs.deleteDoc(databaseDocName(page.id));
    }
  };
  const parentsOf = (): Map<string, string | null> => {
    const snapshot = pages.getSnapshot();
    return new Map(snapshot.all().map((page) => [page.id, snapshot.effectiveParentId(page.id)]));
  };

  const workspaceApi: WorkspaceApi = {
    info: workspace,
    doc: workspaceDoc,
    pages,
    getPage: (id) => pages.getSnapshot().get(id) ?? getPage(workspaceDoc, id),
    createPage: (pageInput = {}) => createPage(workspaceDoc, pageInput, opts()),
    renamePage: (id, title) => renamePage(workspaceDoc, id, title, opts()),
    movePage: (id, target) => movePage(workspaceDoc, id, target, opts()),
    setIcon: (id, icon) => setIcon(workspaceDoc, id, icon, opts()),
    setCover: (id, cover) => setCover(workspaceDoc, id, cover, opts()),
    setFavorite: (id, favorite) => setFavorite(workspaceDoc, id, favorite, opts()),
    trashPage: (id) => trashPage(workspaceDoc, id, opts()),
    restorePage: (id) => restorePage(workspaceDoc, id, opts()),
    async deletePagePermanently(id) {
      const parents = parentsOf();
      const removed = deletePagePermanently(workspaceDoc, id, opts());
      await removeRowEntries(removed, parents);
      await deleteDocsOf(removed);
      return removed;
    },
    async emptyTrash() {
      const parents = parentsOf();
      const removed = emptyTrash(workspaceDoc, opts());
      await removeRowEntries(removed, parents);
      await deleteDocsOf(removed);
      return removed;
    },
    async duplicatePage(id) {
      const original = workspaceApi.getPage(id);
      if (!original) throw new NotFoundError('Page', id);
      if (original.kind !== 'page')
        throw new InvalidOperationError('Duplicating databases is not supported yet');
      const snapshot = pages.getSnapshot();
      if (snapshot.isRow(id))
        throw new InvalidOperationError('Duplicate database rows from the database');
      const pageInput: Parameters<typeof createPage>[1] = {
        title: original.title,
        parentId: snapshot.effectiveParentId(id),
        position: { after: id },
      };
      if (original.icon) pageInput.icon = original.icon;
      if (original.cover) pageInput.cover = original.cover;
      const copy = createPage(workspaceDoc, pageInput, opts());
      const [source, target, { readDocJSON, writeDocJSON }] = await Promise.all([
        loadPageDoc(id),
        loadPageDoc(copy.id),
        import('../schema/ydoc'),
      ]);
      try {
        target.doc.transact(() => {
          writeDocJSON(target.doc, readDocJSON(source.doc));
          setPageProps(target.doc, getPageProps(source.doc));
        });
      } finally {
        source.release();
        target.release();
      }
      return copy;
    },
    async createDatabase({ titlePropertyName, viewName, viewType, ...pageInput }) {
      const page = createPage(workspaceDoc, { ...pageInput, kind: 'database' }, opts());
      const [handle, helpers] = await Promise.all([
        loadDatabaseDoc(page.id),
        loadDatabaseHelpers(),
      ]);
      try {
        const init: Parameters<typeof initDatabaseDoc>[1] = { titlePropertyName, viewName };
        if (viewType) init.viewType = viewType;
        const ids = helpers.initDatabaseDoc(handle.doc, init, opts());
        return { page, ...ids };
      } finally {
        handle.release();
      }
    },
    async addDatabaseRow(databaseId, rowInput = {}) {
      const database = workspaceApi.getPage(databaseId);
      if (!database || database.kind !== 'database')
        throw new NotFoundError('Database', databaseId);
      const pageInput: Parameters<typeof createPage>[1] = {
        title: rowInput.title ?? '',
        parentId: databaseId,
      };
      if (rowInput.icon) pageInput.icon = rowInput.icon;
      const page = createPage(workspaceDoc, pageInput, opts());
      let handle: DocHandle | undefined;
      try {
        const [loaded, helpers] = await Promise.all([
          loadDatabaseDoc(databaseId),
          loadDatabaseHelpers(),
        ]);
        handle = loaded;
        const row: Parameters<typeof addRow>[1] = { id: page.id };
        if (rowInput.values) row.values = rowInput.values;
        if (rowInput.position) row.position = rowInput.position;
        helpers.addRow(handle.doc, row, opts());
      } catch (error) {
        deletePagePermanently(workspaceDoc, page.id, opts());
        throw error;
      } finally {
        handle?.release();
      }
      return page;
    },
    async addDatabaseRows(databaseId, rowInputs, rowOptions = {}) {
      const database = workspaceApi.getPage(databaseId);
      if (!database || database.kind !== 'database')
        throw new NotFoundError('Database', databaseId);
      if (rowInputs.length === 0) return [];
      const [handle, helpers] = await Promise.all([
        loadDatabaseDoc(databaseId),
        loadDatabaseHelpers(),
      ]);
      let created: PageMeta[] = [];
      try {
        // addRows validates every value before writing; on an error the pages go again.
        created = createPages(
          workspaceDoc,
          rowInputs.map((input) => {
            const pageInput: CreatePagesInput = { title: input.title ?? '', parentId: databaseId };
            if (input.icon) pageInput.icon = input.icon;
            return pageInput;
          }),
          opts(),
        );
        helpers.addRows(
          handle.doc,
          created.map((page, i) => {
            const values = rowInputs[i]?.values;
            return values ? { id: page.id, values } : { id: page.id };
          }),
          { ...opts(), after: rowOptions.after ?? null },
        );
        return created;
      } catch (error) {
        if (created.length) {
          workspaceDoc.transact(() => {
            for (const page of created) deletePagePermanently(workspaceDoc, page.id, opts());
          });
        }
        throw error;
      } finally {
        handle.release();
      }
    },
  };

  // 6. Registries and context.
  const workspaceSettings = new WorkspaceSettingsStore(workspaceDoc);
  disposers.push(
    workspaceSettings.subscribe((key) =>
      events.emit('settings.changed', { scope: 'workspace', key }),
    ),
    runtime.deviceSettings.subscribe((key) => {
      events.emit('settings.changed', { scope: 'device', key });
      if (key.startsWith('user.')) {
        const user = runtime.getCurrentUser();
        docs.setUser(user);
        events.emit('user.changed', { user });
      }
    }),
  );
  const contributions = createContributionRegistry();
  const blocks = createBlockRendererRegistry();
  const importers = createImporterRegistry();
  const exporters = createExporterRegistry();
  let ctx: AppContext | null = null;
  const commands = createCommandRegistry({
    getContext: () => {
      if (!ctx) throw new Error('The workspace session is not ready');
      return { app: ctx, pageId: bridge.getCurrentPageId() };
    },
    isApple: runtime.platform.isApple,
    onError: (error, command) => report(error, { area: 'command', source: command.id }),
  });

  const context: AppContext = {
    workspace: workspaceApi,
    acquirePageDoc: (pageId) => docs.acquirePageDoc(pageId),
    acquireDatabaseDoc: (databaseId) => docs.acquireDatabaseDoc(databaseId),
    loadPageDoc,
    loadDatabaseDoc,
    services,
    serviceSources: serviceSources as Record<ServiceKey, string>,
    events,
    commands,
    blocks,
    contributions,
    importers,
    exporters,
    settings: { device: runtime.deviceSettings, workspace: workspaceSettings },
    get currentUser() {
      return runtime.getCurrentUser();
    },
    platform: runtime.platform,
    navigate: (pageId, navigateOptions) => bridge.navigate(pageId, navigateOptions),
    navigateTo: (path, navigateOptions) => bridge.navigateTo(path, navigateOptions),
    switchWorkspace: (workspaceId) => bridge.switchWorkspace(workspaceId),
    getCurrentPageId: () => bridge.getCurrentPageId(),
    openSidePanel: (id) => bridge.openSidePanel(id),
    closeSidePanel: () => bridge.closeSidePanel(),
    toast: (toastOptions: ToastOptions | string) =>
      bridge.toast(typeof toastOptions === 'string' ? { title: toastOptions } : toastOptions),
    confirm: (confirmOptions) => bridge.confirm(confirmOptions),
  };
  ctx = context;

  // 7. Features: static contributions, then activation.
  // Core's stubs: a feature registering the same ID replaces them quietly.
  importers.register(createBasicMarkdownImporter(), { replaceable: true });
  exporters.register(createBasicMarkdownExporter(), { replaceable: true });
  const registrationsByFeature = new Map<string, Array<() => void>>();
  const featureErrors = new Map<string, Error>();
  const cleanups: Array<{ featureId: string; cleanup: () => void }> = [];
  for (const feature of runtime.features) {
    const offs: Array<() => void> = [];
    const add = <K extends ContributionKind>(
      kind: K,
      list: ReadonlyArray<ContributionMap[K]> | undefined,
    ) => {
      for (const item of list ?? []) offs.push(contributions.register(kind, item, feature.id));
    };
    try {
      add('routes', feature.routes);
      add('sidebarSections', feature.sidebarSections);
      add('pageTopSections', feature.pageTopSections);
      add('pageFooterSections', feature.pageFooterSections);
      add('pageHeaderActions', feature.pageHeaderActions);
      add('pageSidePanels', feature.pageSidePanels);
      add('topBarItems', feature.topBarItems);
      add('settingsPanels', feature.settingsPanels);
      add('onboardingActions', feature.onboardingActions);
      add('editorExtensions', feature.editorExtensions);
      add('overlays', feature.overlays);
      add('workspaceMenuItems', feature.workspaceMenuItems);
      add('docViewers', feature.docViewers);
      for (const [kind, component] of Object.entries(feature.pageBodies ?? {})) {
        if (component)
          offs.push(
            contributions.register(
              'pageBodies',
              { kind: kind as PageMeta['kind'], component },
              feature.id,
            ),
          );
      }
      if (feature.commands) offs.push(commands.registerMany(feature.commands));
      for (const renderer of feature.blockRenderers ?? []) offs.push(blocks.register(renderer));
      for (const importer of feature.importers ?? []) offs.push(importers.register(importer));
      for (const exporter of feature.exporters ?? []) offs.push(exporters.register(exporter));
    } catch (error) {
      report(error, { area: 'feature', source: feature.id });
    }
    registrationsByFeature.set(feature.id, offs);
  }
  for (const feature of runtime.features) {
    if (!feature.activate) continue;
    // Whatever the feature registers while activating is tracked, so a failure removes it all.
    const offs = registrationsByFeature.get(feature.id) ?? [];
    registrationsByFeature.set(feature.id, offs);
    try {
      const cleanup = await feature.activate(scopeContext(context, offs));
      if (typeof cleanup === 'function') cleanups.push({ featureId: feature.id, cleanup });
    } catch (error) {
      const err = toError(error);
      featureErrors.set(feature.id, err);
      report(err, { area: 'feature', source: feature.id });
      for (const off of registrationsByFeature.get(feature.id) ?? []) off();
      registrationsByFeature.set(feature.id, []);
    }
  }

  events.emit('workspace.opened', { workspace });

  let closed = false;
  const session: WorkspaceSession = {
    ctx: context,
    workspace,
    featureErrors,
    flushEvents: () => {
      touch.flush();
      docChanged.flush();
    },
    async flush() {
      session.flushEvents();
      await docs.flush();
    },
    async close() {
      if (closed) return;
      closed = true;
      session.flushEvents();
      events.emit('workspace.closed', { workspaceId: workspace.id });
      for (const { featureId, cleanup } of cleanups.reverse()) {
        try {
          cleanup();
        } catch (error) {
          report(error, { area: 'feature', source: featureId });
        }
      }
      for (const offs of registrationsByFeature.values()) for (const off of offs) off();
      docChanged.cancel();
      touch.cancel();
      const onDisposeError = (error: Error) =>
        report(error, { area: 'service', source: 'dispose' });
      await disposeService(searchIndex.service, onDisposeError);
      await disposeService(linkIndex.service, onDisposeError);
      for (const dispose of disposers.reverse()) await dispose();
      wsHandle.release();
      await docs.dispose();
      await disposeService(syncProvider.service, onDisposeError);
      await disposeService(assetStore.service, onDisposeError);
      await disposeService(docStore.service, onDisposeError);
      events.clear();
    },
  };
  return session;
}
