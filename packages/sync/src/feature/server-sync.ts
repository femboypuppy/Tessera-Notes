import {
  databaseDocName,
  pageDocName,
  parseDocName,
  permanentlyDeletedPageIds,
  SETTING_KEYS,
  type AppContext,
} from '@tessera/core';
import type { ServerApi } from '../client/api';
import { ServerApiError } from '../client/errors';
import type { SyncStateStore } from '../stores/sync-state';
import { authModeFor, serverApi } from '../client/connection';
import { t } from '../i18n';
import { HocuspocusSyncProvider } from '../provider/hocuspocus-provider';
import { BackgroundReplicator } from '../provider/replicator';
import { signalOutbox, syncStateFor } from '../provider/shared';
import { IndexedDbDocStore } from '../stores/doc-store';
import { TEMP_WORKSPACE_KEY } from './keys';

/** What a connected session exposes to the rest of the feature (history uploads). */
export interface ServerSyncSession {
  replicator: BackgroundReplicator;
  provider: HocuspocusSyncProvider;
  api: ServerApi;
  syncState: SyncStateStore;
}

/**
 * Starts syncing a workspace that has a server: the background sync, permanent deletions sent
 * to the server, the account's ID as the device's user ID, and display-name changes.
 */
export async function startServerSync(
  ctx: AppContext,
): Promise<{ session: ServerSyncSession | null; stop: () => void }> {
  const provider = ctx.services.syncProvider;
  if (!(provider instanceof HocuspocusSyncProvider))
    return { session: null, stop: () => undefined };
  const workspaceId = ctx.workspace.info.id;
  const api = serverApi(provider.serverUrl, authModeFor(ctx.platform));
  const syncState = await syncStateFor(workspaceId);
  const docStore = ctx.services.docStore;
  const offs: Array<() => void> = [];

  const replicator = new BackgroundReplicator({
    workspaceId,
    provider,
    api,
    docStore,
    syncState,
    assets: ctx.services.assetStore,
    pageExists: (pageId) => ctx.workspace.pages.getSnapshot().get(pageId) !== undefined,
    // Pages deleted for good, here or on another device: their local docs are dropped.
    deletedPageIds: () => permanentlyDeletedPageIds(ctx.workspace.doc),
    onProblem: (problem) =>
      ctx.toast({
        variant: 'warning',
        title:
          problem.kind === 'asset'
            ? t('uploadAssetFailed')
            : problem.kind === 'version'
              ? t('uploadVersionFailed')
              : t('deleteOnServerFailed'),
        description: problem.message,
        durationMs: 10_000,
      }),
    onDeletedOnServer: async (docName) => {
      if (!provider.isOpen(docName)) await docStore.delete(docName);
    },
    // A page or database pulled in the background: search and backlinks re-read it.
    onPulled: (docName) => {
      const parsed = parseDocName(docName);
      if (parsed && parsed.kind !== 'workspace')
        void ctx.services.searchIndex.upsert(parsed.id).catch(() => undefined);
    },
  });
  replicator.start();
  offs.push(() => replicator.stop());

  // Stores other than IndexedDB can't mark changed docs in their own transactions: mark them
  // from the provider instead (at most every few seconds per doc).
  if (!(docStore instanceof IndexedDbDocStore)) {
    const lastMarked = new Map<string, number>();
    provider.setLocalChangeHandler((docName) => {
      const now = Date.now();
      if (now - (lastMarked.get(docName) ?? 0) < 2000) return;
      lastMarked.set(docName, now);
      void syncState.markDirty([docName]);
    });
    offs.push(() => provider.setLocalChangeHandler(null));
  }

  // Permanent deletions made here reach the server (queued while offline).
  offs.push(
    ctx.events.on('page.deleted', ({ page, local }) => {
      if (!local) return;
      const names = [pageDocName(page.id)];
      if (page.kind === 'database') names.push(databaseDocName(page.id));
      void (async () => {
        for (const docName of names) await syncState.enqueue({ kind: 'deleteDoc', docName });
        signalOutbox(workspaceId);
      })().catch((error: unknown) => console.error('[sync] could not queue a deletion', error));
    }),
  );

  // The account ID becomes this device's user ID (authorship, presence).
  void api
    .me()
    .then((me) => {
      if (!me) return;
      if (ctx.settings.device.get(SETTING_KEYS.userId) !== me.user.id)
        ctx.settings.device.set(SETTING_KEYS.userId, me.user.id);
      if (!ctx.settings.device.get(SETTING_KEYS.userName))
        ctx.settings.device.set(SETTING_KEYS.userName, me.user.name);
    })
    .catch(() => undefined);

  // A new display name (Settings → General) renames the account, which is what others see.
  let renameTimer: ReturnType<typeof setTimeout> | null = null;
  offs.push(
    ctx.events.on('settings.changed', ({ scope, key }) => {
      if (scope !== 'device' || key !== SETTING_KEYS.userName) return;
      const name = ctx.settings.device.get(SETTING_KEYS.userName);
      if (typeof name !== 'string' || !name.trim()) return;
      if (renameTimer) clearTimeout(renameTimer);
      renameTimer = setTimeout(() => {
        api.renameMe(name.trim().slice(0, 80)).catch((error: unknown) => {
          if (!(error instanceof ServerApiError && (error.status === 401 || error.isNetworkError)))
            console.warn('[sync] could not rename the account', error);
        });
      }, 800);
    }),
    () => {
      if (renameTimer) clearTimeout(renameTimer);
    },
  );

  // Joined a server workspace from a fresh, empty one: forget the empty one.
  const temporary = ctx.settings.device.get(TEMP_WORKSPACE_KEY);
  if (typeof temporary === 'string' && temporary !== workspaceId) {
    ctx.settings.device.set(TEMP_WORKSPACE_KEY, undefined);
    ctx.services.workspaceRegistry.remove(temporary).catch(() => undefined);
  }

  return {
    session: { replicator, provider, api, syncState },
    stop: () => {
      for (const off of offs.splice(0).reverse()) off();
    },
  };
}
