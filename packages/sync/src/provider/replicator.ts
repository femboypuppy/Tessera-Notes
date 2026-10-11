import { HocuspocusProvider } from '@hocuspocus/provider';
import { parseDocName, workspaceDocName, type AssetStore, type DocStore } from '@tessera/core';
import * as Y from 'yjs';
import type { ServerApi } from '../client/api';
import { ServerApiError } from '../client/errors';
import { IndexedDbDocStore } from '../stores/doc-store';
import type { OutboxItem, SyncStateRecord, SyncStateStore } from '../stores/sync-state';
import { serverDocName } from './doc-names';
import type { HocuspocusSyncProvider } from './hocuspocus-provider';
import { onOutboxSignal } from './shared';

/** A version snapshot to upload (from the local version store). */
export interface UploadableVersion {
  id: string;
  docName: string;
  createdAt: number;
  kind: 'auto' | 'manual' | 'restore';
  label: string | null;
  state: Uint8Array;
}

/** A problem the person should hear about (an upload the server refuses for good). */
export interface ReplicatorProblem {
  kind: 'asset' | 'version' | 'delete';
  id: string;
  message: string;
}

export interface ReplicatorOptions {
  workspaceId: string;
  provider: HocuspocusSyncProvider;
  api: ServerApi;
  docStore: DocStore;
  syncState: SyncStateStore;
  assets?: Pick<AssetStore, 'get' | 'getInfo'>;
  /** Whether a page (or database) still exists in the workspace (deleted ones aren't fetched). */
  pageExists(pageId: string): boolean;
  /**
   * Pages the workspace records as deleted for good (`permanentlyDeletedPageIds`). Their docs are
   * dropped from this device on every pass, also when they have nothing to sync: a page deleted on
   * another device would otherwise stay here for good. Never a page that is only missing here.
   */
  deletedPageIds?(): ReadonlySet<string>;
  concurrency?: number;
  /** Full pass interval while connected. Default 5 minutes. */
  intervalMs?: number;
  /** Give up on one doc after this long (retried next pass). Default 60 s. */
  docTimeoutMs?: number;
  onProblem?(problem: ReplicatorProblem): void;
  /** A doc deleted for good (someone deleted the page, here or elsewhere): drop the local copy. */
  onDeletedOnServer?(docName: string): void | Promise<void>;
  /**
   * A closed doc received the server's changes, now in the doc store. Nothing else sees them
   * (no live doc, no `doc.changed`), so indexes re-read it from here.
   */
  onPulled?(docName: string): void;
}

/** Origin of the stored state loaded into a background doc (never stored again). */
const LOAD_ORIGIN = Symbol('tessera:background-load');

/**
 * Keeps every doc of the workspace in sync, not only the open ones:
 *
 * - **Pushes** docs changed on this device that the server hasn't acknowledged yet (the doc
 *   store marks them dirty in the same transaction as the write), including edits made offline
 *   to pages that were closed long before the connection came back.
 * - **Pulls** docs that changed on the server since this device last caught up (sequence
 *   numbers from `GET /api/workspaces/:id/docs`), so they're available offline.
 * - **Sends the outbox**: permanent deletions, asset uploads and version uploads queued while
 *   offline.
 *
 * Open docs are left to the live connection. Runs when the connection comes up, every few
 * minutes, and when new outbox work arrives.
 */
export class BackgroundReplicator {
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private wasReady = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private signalTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly offs: Array<() => void> = [];
  private versions: ((id: string) => Promise<UploadableVersion | null>) | null = null;

  constructor(private readonly options: ReplicatorOptions) {}

  /** Starts watching the connection. */
  start(): void {
    const { provider } = this.options;
    this.offs.push(
      provider.onStatus(() => {
        const ready = provider.isReady;
        if (ready && !this.wasReady) this.schedule();
        this.wasReady = ready;
      }),
      onOutboxSignal(this.options.workspaceId, () => {
        if (this.signalTimer) clearTimeout(this.signalTimer);
        this.signalTimer = setTimeout(() => this.schedule(), 300);
      }),
    );
    this.timer = setInterval(() => this.schedule(), this.options.intervalMs ?? 5 * 60_000);
    this.wasReady = provider.isReady;
    if (this.wasReady) this.schedule();
  }

  /** Where version uploads come from (the version store, once history is loaded). */
  setVersionSource(source: (id: string) => Promise<UploadableVersion | null>): void {
    this.versions = source;
  }

  /** Runs a pass now (or right after the current one). Resolves when it is done. */
  runNow(): Promise<void> {
    this.schedule();
    return this.running ?? Promise.resolve();
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    if (this.timer) clearInterval(this.timer);
    if (this.signalTimer) clearTimeout(this.signalTimer);
    this.options.provider.setBackgroundPending(0);
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        if (!this.options.provider.isReady) break;
        try {
          await this.pass();
        } catch (error) {
          if (!(error instanceof ServerApiError && error.isNetworkError))
            console.warn('[sync] background sync pass failed', error);
        }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
      if (!this.stopped) this.options.provider.setBackgroundPending(0);
    });
  }

  private async pass(): Promise<void> {
    const { api, workspaceId, syncState, docStore, provider } = this.options;
    await this.drainOutbox();
    if (this.stopped) return;

    const [serverDocs, states, localNames] = await Promise.all([
      api.docs(workspaceId),
      syncState.all(),
      docStore.list(),
    ]);
    const local = new Set(localNames);
    await this.dropDeleted(localNames, states);
    if (this.stopped) return;
    const seqs = new Map(serverDocs.map((doc) => [doc.name, doc.seq]));
    const wsDoc = workspaceDocName(workspaceId);
    const wanted = (name: string): boolean => {
      if (name === wsDoc) return true;
      const parsed = parseDocName(name);
      if (!parsed || parsed.kind === 'workspace') return false;
      return this.options.pageExists(parsed.id);
    };

    const push = [...states.values()]
      .filter((record) => record.dirty && local.has(record.docName) && wanted(record.docName))
      .map((record) => record.docName);
    // Open docs are live: they are pulled by the first pass after they close (see `syncDoc`).
    const pull = serverDocs
      .filter(
        (doc) =>
          (states.get(doc.name)?.serverSeq ?? -1) < doc.seq &&
          wanted(doc.name) &&
          !provider.isOpen(doc.name),
      )
      .map((doc) => doc.name)
      .filter((name) => !push.includes(name));
    const queue = [...push, ...pull];
    let remaining = queue.length;
    provider.setBackgroundPending(remaining);

    const worker = async () => {
      for (;;) {
        const docName = queue.shift();
        if (!docName || this.stopped) return;
        try {
          await this.syncDoc(docName, seqs.get(docName) ?? null, states.get(docName));
        } catch (error) {
          console.warn(`[sync] background sync of ${docName} failed`, error);
        }
        remaining -= 1;
        if (!this.stopped) provider.setBackgroundPending(remaining);
      }
    };
    const workers = Array.from({ length: this.options.concurrency ?? 3 }, () => worker());
    await Promise.all(workers);
  }

  /** Forgets the local docs (and sync records) of pages deleted for good. */
  private async dropDeleted(
    localNames: readonly string[],
    states: ReadonlyMap<string, SyncStateRecord>,
  ): Promise<void> {
    const deleted = this.options.deletedPageIds?.();
    if (!deleted?.size) return;
    const { provider, syncState } = this.options;
    for (const docName of new Set([...localNames, ...states.keys()])) {
      const parsed = parseDocName(docName);
      if (!parsed || parsed.kind === 'workspace' || !deleted.has(parsed.id)) continue;
      // An open doc is someone's live editor: the next pass after it closes drops it.
      if (provider.isOpen(docName)) continue;
      if (states.has(docName)) await syncState.remove(docName);
      await this.options.onDeletedOnServer?.(docName);
    }
  }

  private async syncDoc(
    docName: string,
    serverSeq: number | null,
    record: SyncStateRecord | undefined,
  ): Promise<void> {
    const { provider, docStore, syncState, workspaceId } = this.options;
    const observed = record?.version ?? 0;
    if (provider.isOpen(docName)) {
      // Live: the runtime's connection pushes it, so the local changes seen are acknowledged once
      // it is in sync. The server sequence number is not recorded: a broadcast counted in it may
      // still be on its way, and if the doc closes first, only a pull would bring it back.
      if (provider.isDocSynced(docName)) await syncState.markSynced(docName, observed, null);
      return;
    }
    const state = await docStore.load(docName);
    const doc = new Y.Doc({ guid: docName });
    if (state) Y.applyUpdate(doc, state, LOAD_ORIGIN);
    const writes: Array<Promise<void>> = [];
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD_ORIGIN) return;
      writes.push(
        docStore instanceof IndexedDbDocStore
          ? docStore.storeRemoteUpdate(docName, update)
          : docStore.storeUpdate(docName, update),
      );
    });
    const token = await provider.token();
    const connection = new HocuspocusProvider({
      name: serverDocName(workspaceId, docName),
      document: doc,
      awareness: null,
      token,
      websocketProvider: provider.socket,
      sessionAwareness: true,
    });
    const outcome = await new Promise<'ok' | 'deleted' | 'failed'>((resolve) => {
      const timer = setTimeout(() => resolve('failed'), this.options.docTimeoutMs ?? 60_000);
      const done = (value: 'ok' | 'deleted' | 'failed') => {
        clearTimeout(timer);
        resolve(value);
      };
      const check = () => {
        if (connection.isSynced && !connection.hasUnsyncedChanges) done('ok');
      };
      connection.on('synced', check);
      connection.on('unsyncedChanges', check);
      connection.on('authenticationFailed', ({ reason }: { reason: string }) =>
        done(reason === 'document-deleted' ? 'deleted' : 'failed'),
      );
      connection.attach();
    });
    connection.destroy();
    const stored = await Promise.allSettled(writes);
    doc.destroy();
    if (stored.some((result) => result.status === 'fulfilled')) this.options.onPulled?.(docName);
    if (outcome === 'ok') await syncState.markSynced(docName, observed, serverSeq);
    else if (outcome === 'deleted') {
      await syncState.remove(docName);
      await this.options.onDeletedOnServer?.(docName);
    }
  }

  private async drainOutbox(): Promise<void> {
    const { syncState } = this.options;
    for (const { key, item } of await syncState.outbox()) {
      if (this.stopped) return;
      try {
        await this.send(item);
        await syncState.removeOutbox(key);
      } catch (error) {
        const permanent =
          error instanceof ServerApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![401, 408, 429].includes(error.status);
        if (!permanent) return; // Offline, signed out or a server problem: try again later.
        await syncState.removeOutbox(key);
        this.options.onProblem?.({
          kind:
            item.kind === 'deleteDoc'
              ? 'delete'
              : item.kind === 'uploadAsset'
                ? 'asset'
                : 'version',
          id:
            item.kind === 'deleteDoc'
              ? item.docName
              : item.kind === 'uploadAsset'
                ? item.assetId
                : item.versionId,
          message: error.message,
        });
      }
    }
  }

  private async send(item: OutboxItem): Promise<void> {
    const { api, workspaceId, assets } = this.options;
    if (item.kind === 'deleteDoc') {
      await api.deleteDoc(workspaceId, item.docName);
    } else if (item.kind === 'uploadAsset') {
      const [blob, info] = await Promise.all([
        assets?.get(item.assetId) ?? null,
        assets?.getInfo?.(item.assetId) ?? null,
      ]);
      // Deleted locally meanwhile: nothing to upload.
      if (!blob || !info) return;
      await api.uploadAsset(workspaceId, info, blob);
    } else {
      if (!this.versions) throw new ServerApiError(0, 'not_ready', 'History is not loaded yet.');
      const version = await this.versions(item.versionId);
      if (!version) return;
      await api.uploadVersion(workspaceId, version);
    }
  }
}
