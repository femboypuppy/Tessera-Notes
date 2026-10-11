import 'fake-indexeddb/auto';
import { DocManager, type DocHandle } from '@tessera/core';
import { BackgroundReplicator, HocuspocusSyncProvider } from '@tessera/sync/provider';
import { ServerApi } from '@tessera/sync/client';
import { IndexedDbDocStore, SyncStateStore } from '@tessera/sync/stores';
import { IDBFactory } from 'fake-indexeddb';
import { NodeWebSocket, type TestServer } from './harness';

/**
 * A simulated device running the real client stack: the core `DocManager`, the IndexedDB doc
 * store (on its own fake IndexedDB, like a separate browser), the Hocuspocus provider and the
 * background sync. `goOffline`/`goOnline` fire the browser's connectivity events.
 */
export interface Device {
  name: string;
  manager: DocManager;
  provider: HocuspocusSyncProvider;
  store: IndexedDbDocStore;
  syncState: SyncStateStore;
  replicator: BackgroundReplicator;
  api: ServerApi;
  /** Docs the background sync pulled while closed (what indexes are told to re-read). */
  pulled: string[];
  open(docName: string): Promise<DocHandle>;
  goOffline(): void;
  goOnline(): void;
  /** Waits until the provider reports `synced` (every change acknowledged, background done). */
  settled(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

export async function createDevice(
  t: Pick<TestServer, 'url'>,
  options: {
    name: string;
    token: string;
    workspaceId: string;
    indexedDB?: IDBFactory;
    /** Pages the device's workspace doc records as deleted for good (none by default). */
    deletedPageIds?: () => ReadonlySet<string>;
  },
): Promise<Device> {
  const { workspaceId, token } = options;
  const indexedDB = options.indexedDB ?? new IDBFactory();
  const connectivity = new EventTarget();
  const store = await IndexedDbDocStore.open(workspaceId, {
    indexedDB,
    channel: null,
    trackSync: true,
  });
  const syncState = await SyncStateStore.open(workspaceId, { indexedDB });
  const getToken = async () => token;
  const provider = new HocuspocusSyncProvider({
    workspaceId,
    serverUrl: t.url,
    mode: 'bearer',
    getToken,
    WebSocketPolyfill: NodeWebSocket,
    connectivity,
    isOnline: () => true,
    retry: { delay: 50, minDelay: 50, maxDelay: 400 },
  });
  const manager = new DocManager({
    docStore: store,
    syncProvider: provider,
    releaseDelayMs: 0,
    getUser: () => ({ id: `user-${options.name}`, name: options.name, color: '#0090ff' }),
  });
  const api = new ServerApi(t.url, { mode: 'bearer', getToken });
  const pulled: string[] = [];
  const replicator = new BackgroundReplicator({
    workspaceId,
    provider,
    api,
    docStore: store,
    syncState,
    pageExists: () => true,
    deletedPageIds: options.deletedPageIds ?? (() => new Set()),
    intervalMs: 60_000,
    docTimeoutMs: 10_000,
    onPulled: (docName) => pulled.push(docName),
    onDeletedOnServer: async (docName) => {
      if (!provider.isOpen(docName)) await store.delete(docName);
    },
  });
  replicator.start();
  // The workspace doc is always open in the app; its connection authorizes the workspace.
  const wsHandle = await manager.load(`ws:${workspaceId}`);
  return {
    name: options.name,
    manager,
    provider,
    store,
    syncState,
    replicator,
    api,
    pulled,
    open: (docName) => manager.load(docName),
    goOffline: () => connectivity.dispatchEvent(new Event('offline')),
    goOnline: () => connectivity.dispatchEvent(new Event('online')),
    settled: async (timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (provider.getStatus().status !== 'synced') {
        if (Date.now() > deadline)
          throw new Error(`${options.name} not settled: ${JSON.stringify(provider.getStatus())}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    dispose: async () => {
      replicator.stop();
      wsHandle.release();
      await manager.dispose();
      provider.dispose();
      syncState.dispose();
      await store.dispose();
    },
  };
}
