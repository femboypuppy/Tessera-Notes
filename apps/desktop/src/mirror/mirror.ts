import {
  normalizeImportPath,
  toError,
  type AppContext,
  type ExportContext,
  type Exporter,
  type ExportSession,
  type ExportSink,
} from '@tessera/core';
import type { DesktopBackend } from '../backend/backend';
import { createStore, type Store } from '../lib/store';

/** Device setting: IDs of the workspaces that keep a markdown copy on this computer. */
export const MIRROR_SETTING = 'desktop.markdownMirror';

/**
 * Exporters the mirror uses, best first. Agent 08's markdown exporter replaces core's
 * `markdown-basic` at merge; whichever is registered first in this list wins.
 */
export const MIRROR_EXPORTERS = ['markdown', 'markdown-folder', 'markdown-zip', 'markdown-basic'];

export interface MirrorStatus {
  enabled: boolean;
  running: boolean;
  lastRunAt: number | null;
  files: number;
  error: string | null;
}

/** Writes exported files into the workspace's `markdown/` folder (through Rust). */
export class FolderExportSink implements ExportSink {
  constructor(
    private readonly backend: DesktopBackend,
    private readonly workspaceId: string,
  ) {}

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const normalized = normalizeImportPath(path);
    if (!normalized) throw new TypeError(`Unsafe export path: ${path}`);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.backend.mirrorWrite(this.workspaceId, normalized, bytes);
  }
}

export function pickMirrorExporter(ctx: AppContext): Exporter | null {
  for (const id of MIRROR_EXPORTERS) {
    const exporter = ctx.exporters.get(id);
    if (exporter?.scopes.includes('workspace')) return exporter;
  }
  return null;
}

function enabledIds(ctx: AppContext): string[] {
  const value = ctx.settings.device.get(MIRROR_SETTING);
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Keeps `<workspace folder>/markdown/` in step with the workspace: after edits settle (a few
 * seconds, at most half a minute), the export runs again. With an exporter that keeps a session,
 * a run writes only what changed since the last one (the first run of a session writes
 * everything); otherwise the whole workspace is exported. Unchanged files are not rewritten and
 * files of deleted or renamed pages are removed (`mirror_finish`), so sync tools and file
 * watchers only see real changes.
 */
export class MarkdownMirror {
  readonly status: Store<MirrorStatus>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstChangeAt: number | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private readonly offs: Array<() => void> = [];
  private controller: AbortController | null = null;
  private stopped = false;
  /** The export the runs update, with the exporter that opened it. */
  private session: { exporter: Exporter; session: ExportSession } | null = null;
  /** Pages and databases whose docs changed since the last run. */
  private changed = new Set<string>();

  constructor(
    private readonly ctx: AppContext,
    private readonly backend: DesktopBackend,
    private readonly options: { delayMs?: number; maxWaitMs?: number } = {},
  ) {
    this.status = createStore<MirrorStatus>({
      enabled: this.isEnabled(),
      running: false,
      lastRunAt: null,
      files: 0,
      error: null,
    });
  }

  get workspaceId(): string {
    return this.ctx.workspace.info.id;
  }

  isEnabled(): boolean {
    return enabledIds(this.ctx).includes(this.workspaceId);
  }

  /** Starts listening for changes; runs once right away when enabled. */
  start(): void {
    const schedule = () => this.schedule();
    const events = this.ctx.events;
    this.offs.push(
      events.on('doc.changed', ({ pageId }) => {
        this.changed.add(pageId);
        this.schedule();
      }),
      events.on('database.changed', ({ databaseId }) => {
        this.changed.add(databaseId);
        this.schedule();
      }),
      events.on('page.created', schedule),
      events.on('page.updated', schedule),
      events.on('page.deleted', schedule),
      events.on('settings.changed', ({ scope, key }) => {
        if (scope !== 'device' || key !== MIRROR_SETTING) return;
        const enabled = this.isEnabled();
        this.status.set((status) => ({ ...status, enabled }));
        // The folder may change while the copy is off: the next run writes everything.
        this.session = null;
        if (enabled) void this.runNow();
      }),
    );
    if (this.isEnabled()) void this.runNow();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const ids = new Set(enabledIds(this.ctx));
    if (enabled) ids.add(this.workspaceId);
    else ids.delete(this.workspaceId);
    this.ctx.settings.device.set(MIRROR_SETTING, [...ids]);
  }

  private schedule(): void {
    if (this.stopped || !this.isEnabled()) return;
    const delay = this.options.delayMs ?? 4000;
    const maxWait = this.options.maxWaitMs ?? 30_000;
    const now = Date.now();
    this.firstChangeAt ??= now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(delay, this.firstChangeAt + maxWait - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.firstChangeAt = null;
      void this.runNow();
    }, wait);
  }

  /** Exports now (or right after the export in progress). */
  runNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.exportOnce().finally(() => {
      this.running = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.runNow();
      }
    });
    return this.running;
  }

  private async exportOnce(): Promise<void> {
    if (!this.isEnabled()) return;
    const exporter = pickMirrorExporter(this.ctx);
    if (!exporter) {
      this.status.set((s) => ({ ...s, error: 'No markdown exporter is registered' }));
      return;
    }
    const status = await this.backend.workspaceStatus(this.workspaceId).catch(() => null);
    if (!status?.exists) return; // Nothing to mirror before the first edit creates the folder.
    this.status.set((s) => ({ ...s, running: true }));
    const controller = new AbortController();
    this.controller = controller;
    // Docs that change from here on are the next run's.
    const changed = this.changed;
    this.changed = new Set();
    try {
      await this.backend.mirrorBegin(this.workspaceId);
      const sink = new FolderExportSink(this.backend, this.workspaceId);
      const context: ExportContext = {
        workspace: this.ctx.workspace,
        loadPageDoc: (id) => this.ctx.loadPageDoc(id),
        loadDatabaseDoc: (id) => this.ctx.loadDatabaseDoc(id),
        assets: this.ctx.services.assetStore,
        codec: this.ctx.services.markdownCodec,
      };
      let keep: string[] | undefined;
      if (exporter.session) {
        if (this.session?.exporter !== exporter)
          this.session = { exporter, session: exporter.session({ kind: 'workspace' }, context) };
        const result = await this.session.session.run(
          changed,
          sink,
          () => undefined,
          controller.signal,
        );
        keep = result.paths;
      } else {
        await exporter.run(
          { kind: 'workspace' },
          context,
          sink,
          () => undefined,
          controller.signal,
        );
      }
      if (controller.signal.aborted) {
        // A stopped run may have skipped files: removing what it didn't write would lose them.
        for (const id of changed) this.changed.add(id);
        this.status.set((s) => ({ ...s, running: false }));
        return;
      }
      const report = await this.backend.mirrorFinish(this.workspaceId, keep);
      this.status.set((s) => ({
        ...s,
        running: false,
        lastRunAt: Date.now(),
        files: report.files,
        error: null,
      }));
    } catch (error) {
      // The next run starts over and writes everything.
      this.session = null;
      for (const id of changed) this.changed.add(id);
      this.status.set((s) => ({ ...s, running: false, error: toError(error).message }));
    } finally {
      this.controller = null;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    for (const off of this.offs.splice(0)) off();
  }

  /** Runs a pending export before the window closes. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.firstChangeAt = null;
      await this.runNow();
    } else if (this.running) {
      await this.running;
    }
  }
}

/** The mirror of the workspace open in this window (the settings panel reads it). */
export const currentMirror = createStore<MarkdownMirror | null>(null);
