import type * as Y from 'yjs';
import { toError } from '../errors';
import type { DocHandle } from '../runtime/doc-manager';
import type { EventBus } from '../runtime/events';
import type { PagesStore } from '../runtime/pages-store';
import type { PlatformInfo } from '../runtime/platform';
import type { SettingsStore } from '../runtime/settings';
import type { CurrentUser } from '../runtime/user';
import type { AssetStore } from './asset-store';
import type { CredentialStore } from './credential-store';
import type { DocStore } from './doc-store';
import type { FileSaver } from './file-saver';
import type { LinkIndex } from './link-index';
import type { MarkdownCodec } from './markdown-codec';
import type { SearchIndex } from './search-index';
import type { SyncProvider } from './sync-provider';
import type { WorkspaceInfo, WorkspaceRegistry } from './workspace-registry';

/**
 * Service priorities. At startup the runtime picks, for each service, the available registration
 * with the highest priority, and falls back to the in-memory stub (priority 0).
 */
export const SERVICE_PRIORITY = {
  /** In-memory stubs in `@tessera/core`. */
  memory: 0,
  /** Browser implementations (IndexedDB, MiniSearch, the remark codec, Hocuspocus). */
  browser: 50,
  /** Desktop implementations (Tauri: SQLite and files). */
  desktop: 100,
} as const;

/** Every replaceable service. */
export interface ServiceMap {
  workspaceRegistry: WorkspaceRegistry;
  markdownCodec: MarkdownCodec;
  credentialStore: CredentialStore;
  fileSaver: FileSaver;
  docStore: DocStore;
  assetStore: AssetStore;
  syncProvider: SyncProvider;
  searchIndex: SearchIndex;
  linkIndex: LinkIndex;
}

export type ServiceKey = keyof ServiceMap;

/**
 * When each service is resolved:
 * - `app`: once at startup (before any workspace is open);
 * - `storage`: when a workspace opens, before its docs load;
 * - `index`: after the workspace doc is loaded, with access to pages and docs.
 */
export const SERVICE_PHASES = {
  workspaceRegistry: 'app',
  markdownCodec: 'app',
  credentialStore: 'app',
  fileSaver: 'app',
  docStore: 'storage',
  assetStore: 'storage',
  syncProvider: 'storage',
  searchIndex: 'index',
  linkIndex: 'index',
} as const satisfies Record<ServiceKey, 'app' | 'storage' | 'index'>;

export type ServicePhase = (typeof SERVICE_PHASES)[ServiceKey];

/** Context for `app` services. */
export interface AppServiceContext {
  platform: PlatformInfo;
  /** Device settings (per device, not synced). */
  settings: SettingsStore;
}

/** Context for `storage` services: the workspace being opened. */
export interface StorageServiceContext extends AppServiceContext {
  workspace: WorkspaceInfo;
  app: Pick<ServiceMap, 'workspaceRegistry' | 'markdownCodec' | 'credentialStore'>;
  currentUser: CurrentUser;
  events: EventBus;
}

/** Context for `index` services: storage is ready and the workspace doc is loaded. */
export interface IndexServiceContext extends StorageServiceContext {
  storage: Pick<ServiceMap, 'docStore' | 'assetStore' | 'syncProvider'>;
  workspaceDoc: Y.Doc;
  pages: PagesStore;
  loadPageDoc(pageId: string): Promise<DocHandle>;
  loadDatabaseDoc(databaseId: string): Promise<DocHandle>;
}

interface PhaseContexts {
  app: AppServiceContext;
  storage: StorageServiceContext;
  index: IndexServiceContext;
}

/** The context a service's `create` receives. */
export type ServiceContextFor<K extends ServiceKey> = PhaseContexts[(typeof SERVICE_PHASES)[K]];

/**
 * A service implementation offered by a feature (`FeatureModule.services`).
 *
 * @example
 * // apps/web/src/features/sync/index.ts
 * services: [
 *   defineService({
 *     provides: 'docStore',
 *     id: 'indexeddb',
 *     priority: SERVICE_PRIORITY.browser,
 *     isAvailable: () => typeof indexedDB !== 'undefined',
 *     create: async ({ workspace }) => (await import('@tessera/sync')).IndexedDbDocStore.open(workspace.id),
 *   }),
 * ]
 */
export interface ServiceRegistration<K extends ServiceKey = ServiceKey> {
  provides: K;
  /** Name for logs and diagnostics (`indexeddb`, `hocuspocus`, `tauri-sqlite`). */
  id: string;
  /** See {@link SERVICE_PRIORITY}. */
  priority: number;
  /** Defaults to available. Errors count as unavailable. */
  isAvailable?(context: ServiceContextFor<K>): boolean | Promise<boolean>;
  /** Creates the service. Errors fall through to the next registration. Heavy code: dynamic `import()`. */
  create(context: ServiceContextFor<K>): ServiceMap[K] | Promise<ServiceMap[K]>;
}

/** Any service registration (what `FeatureModule.services` holds). */
export type AnyServiceRegistration = { [K in ServiceKey]: ServiceRegistration<K> }[ServiceKey];

/** Identity helper that infers the service type from `provides`. */
export function defineService<K extends ServiceKey>(
  registration: ServiceRegistration<K>,
): ServiceRegistration<K> {
  return registration;
}

/** One candidate considered during resolution. */
export interface ServiceAttempt {
  id: string;
  priority: number;
  outcome: 'selected' | 'unavailable' | 'failed' | 'not-tried';
  error?: string;
}

/** The chosen implementation of a service, and how it was chosen. */
export interface ResolvedService<K extends ServiceKey> {
  key: K;
  service: ServiceMap[K];
  /** Registration ID, or the fallback's ID. */
  source: string;
  priority: number;
  attempts: ServiceAttempt[];
}

/** The built-in stub used when nothing else is available. */
export interface ServiceFallback<K extends ServiceKey> {
  id: string;
  create(context: ServiceContextFor<K>): ServiceMap[K] | Promise<ServiceMap[K]>;
}

/**
 * Resolves one service: tries registrations for `key` from the highest priority down (equal
 * priorities keep registration order), skipping unavailable ones and ones whose `create` throws,
 * and falls back to `fallback`.
 *
 * @example
 * const { service, source } = await resolveService('docStore', registrations, context, memoryFallback);
 */
export async function resolveService<K extends ServiceKey>(
  key: K,
  registrations: readonly AnyServiceRegistration[],
  context: ServiceContextFor<K>,
  fallback: ServiceFallback<K>,
  options: {
    onError?: (error: Error, registration: { id: string; provides: ServiceKey }) => void;
  } = {},
): Promise<ResolvedService<K>> {
  const candidates = registrations
    .filter(
      (registration): registration is ServiceRegistration<K> & AnyServiceRegistration =>
        registration.provides === key,
    )
    .map((registration, index) => ({ registration: registration as ServiceRegistration<K>, index }))
    .sort((a, b) => b.registration.priority - a.registration.priority || a.index - b.index);
  const attempts: ServiceAttempt[] = candidates.map(({ registration }) => ({
    id: registration.id,
    priority: registration.priority,
    outcome: 'not-tried',
  }));
  for (const [i, { registration }] of candidates.entries()) {
    const attempt = attempts[i];
    if (!attempt) continue;
    try {
      const available = registration.isAvailable ? await registration.isAvailable(context) : true;
      if (!available) {
        attempt.outcome = 'unavailable';
        continue;
      }
    } catch (error) {
      attempt.outcome = 'unavailable';
      attempt.error = toError(error).message;
      options.onError?.(toError(error), { id: registration.id, provides: key });
      continue;
    }
    try {
      const service = await registration.create(context);
      attempt.outcome = 'selected';
      return { key, service, source: registration.id, priority: registration.priority, attempts };
    } catch (error) {
      attempt.outcome = 'failed';
      attempt.error = toError(error).message;
      options.onError?.(toError(error), { id: registration.id, provides: key });
    }
  }
  const service = await fallback.create(context);
  attempts.push({ id: fallback.id, priority: SERVICE_PRIORITY.memory, outcome: 'selected' });
  return { key, service, source: fallback.id, priority: SERVICE_PRIORITY.memory, attempts };
}

/** Disposes a service if it has a `dispose` method, swallowing (and reporting) errors. */
export async function disposeService(
  service: unknown,
  onError?: (error: Error) => void,
): Promise<void> {
  const dispose = (service as { dispose?: () => void | Promise<void> } | null)?.dispose;
  if (typeof dispose !== 'function') return;
  try {
    await dispose.call(service);
  } catch (error) {
    onError?.(toError(error));
  }
}
