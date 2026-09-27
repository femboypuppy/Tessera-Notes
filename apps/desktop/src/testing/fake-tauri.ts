/**
 * A fake Tauri runtime for tests: it installs `window.__TAURI_INTERNALS__` and answers every
 * command of `src-tauri/src/commands.rs` from memory, with the same rules (lazy workspace
 * folders, compaction up to a sequence number, content-addressed assets, registry statuses,
 * conflicted copies, the markdown mirror, events).
 *
 * `installFakeTauri` is self-contained (no imports, no outer variables), so Playwright can inject
 * it before the app loads: `page.addInitScript(installFakeTauri, options)`. Unit tests call it
 * directly in jsdom. With `persist: true`, state survives reloads (localStorage), and windows of
 * the same browser context relay doc updates to each other like the Rust side does.
 *
 * Test hooks live on `window.__fakeTauri` ({@link FakeTauriHandle}).
 */

export interface FakeFolder {
  /** The workspace in the folder (its `tessera.db`), if any. */
  workspace?: { id: string; name: string; createdAt: number; formatVersion: number };
  /** Other files in the folder. */
  entries?: number;
  cloud?: { provider: string; root: string } | null;
  conflicts?: string[];
}

export interface FakeTauriOptions {
  /** `main` (default) or `capture`. */
  windowLabel?: string;
  /** `macos`, `windows` (default) or `linux`. */
  os?: string;
  /** The home folder; new workspaces go to `<home>/Tessera`. */
  home?: string;
  /** Keep state in localStorage across reloads and share it between pages. */
  persist?: boolean;
  /** Folders that exist on the fake disk. */
  folders?: Record<string, FakeFolder>;
  /** Answers of the next native folder dialogs (null = cancelled). */
  pickFolder?: Array<string | null>;
  /** Registry entries present at start. */
  registry?: Array<Record<string, unknown>>;
  update?: { configured: boolean; version?: string; notes?: string };
}

export interface FakeTauriHandle {
  readonly state: Record<string, unknown> & {
    registry: Array<Record<string, unknown>>;
    folders: Record<string, FakeFolder>;
    dbs: Record<
      string,
      { path: string; updates: Array<{ seq: number; doc: string; data: string }> }
    >;
    menu: unknown;
    title: string | null;
    zoom: number;
    revealed: string[];
    opened: string[];
    capture: { visible: boolean; ready: boolean };
    mirror: Record<string, Record<string, string>>;
    secrets: Record<string, string>;
    pendingLinks: unknown[];
  };
  readonly calls: Array<{ cmd: string; args: unknown }>;
  emit(event: string, payload?: unknown): void;
  queuePick(path: string | null): void;
  addFolder(path: string, folder: FakeFolder): void;
  queueLink(link: { pageId: string; workspaceId?: string | null }): void;
  save(): void;
}

export function installFakeTauri(options: FakeTauriOptions = {}): void {
  type Json = Record<string, unknown>;
  interface Update {
    seq: number;
    doc: string;
    data: string;
  }
  interface Asset {
    row: {
      assetId: string;
      name: string | null;
      mimeType: string;
      size: number;
      createdAt: number;
    };
    data: string;
  }
  interface Db {
    path: string;
    name: string;
    createdAt: number;
    nextSeq: number;
    updates: Update[];
    assets: Record<string, Asset>;
  }
  interface State {
    registry: Json[];
    folders: Record<string, FakeFolder>;
    dbs: Record<string, Db>;
    prefs: Json;
    menu: unknown;
    title: string | null;
    zoom: number;
    revealed: string[];
    opened: string[];
    pickQueue: Array<string | null>;
    pickTitles: string[];
    capture: { visible: boolean; ready: boolean };
    mirror: Record<string, Record<string, string>>;
    mirrorRuns: Record<string, string[] | null>;
    secrets: Record<string, string>;
    servers: Array<{ server: string; savedAt: number }>;
    pendingLinks: Json[];
    quit: boolean;
  }

  const STORAGE_KEY = '__fakeTauriState';
  const label = options.windowLabel ?? 'main';
  const os = options.os ?? 'windows';
  const home = options.home ?? (os === 'windows' ? 'C:/Users/ada' : '/home/ada');
  const defaultRoot = `${home}/Tessera`;
  const g = globalThis as unknown as Record<string, unknown> & {
    localStorage?: Storage;
    BroadcastChannel?: typeof BroadcastChannel;
  };

  const fresh = (): State => ({
    registry: options.registry ?? [],
    folders: options.folders ?? {},
    dbs: {},
    prefs: {
      closeToTray: true,
      captureEnabled: true,
      captureShortcut: 'CommandOrControl+Shift+Space',
      zoom: 1,
      checkUpdates: true,
      lastUpdateCheck: null,
    },
    menu: null,
    title: null,
    zoom: 1,
    revealed: [],
    opened: [],
    pickQueue: options.pickFolder ?? [],
    pickTitles: [],
    capture: { visible: false, ready: false },
    mirror: {},
    mirrorRuns: {},
    secrets: {},
    servers: [],
    pendingLinks: [],
    quit: false,
  });

  const load = (): State => {
    if (!options.persist || !g.localStorage) return fresh();
    try {
      const saved = g.localStorage.getItem(STORAGE_KEY);
      return saved ? (JSON.parse(saved) as State) : fresh();
    } catch {
      return fresh();
    }
  };
  let state = load();
  const save = () => {
    if (!options.persist || !g.localStorage) return;
    g.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  };
  const reload = () => {
    if (options.persist) state = load();
  };
  save();

  const calls: Array<{ cmd: string; args: unknown }> = [];
  const callbacks = new Map<number, (payload: unknown) => void>();
  let nextCallback = 1;
  const listeners = new Map<string, Array<{ id: number; handler: number }>>();
  let nextListener = 1;

  const emitLocal = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) {
      callbacks.get(listener.handler)?.({ event, id: listener.id, payload });
    }
  };

  // Windows of one browser context relay doc and registry changes, like the Rust side.
  const channel =
    options.persist && g.BroadcastChannel ? new g.BroadcastChannel('fake-tauri') : null;
  channel?.addEventListener('message', (message: MessageEvent) => {
    const data = message.data as { event: string; payload: unknown; state?: State };
    // The sender's state comes with the message: localStorage can reach this page later.
    if (data.state) {
      state = data.state;
      save();
    } else reload();
    emitLocal(data.event, data.payload);
  });
  // A channel left open keeps the old document alive after a navigation (Firefox then hangs
  // closing the browser context).
  (g as unknown as Window).addEventListener?.('pagehide', () => channel?.close(), { once: true });
  /** Tells the other pages, after the current command's changes (a microtask runs later). */
  const relay = (event: string, payload: unknown) => {
    if (!channel) return;
    queueMicrotask(() => {
      try {
        channel.postMessage({ event, payload, state });
      } catch {
        // The page is going away and closed the channel.
      }
    });
  };
  const emitAll = (event: string, payload: unknown) => {
    emitLocal(event, payload);
    relay(event, payload);
  };

  const fail = (code: string, message: string) => ({ code, message });
  const now = () => Date.now();
  const toBase64 = (bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const fromBase64 = (text: string) => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  const isId = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  const isAbsolute = (path: unknown): path is string =>
    typeof path === 'string' && (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/'));
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
  const folderOf = (path: string): FakeFolder | undefined => state.folders[norm(path)];
  const header = (opts: unknown, name: string): string | null => {
    const headers = (opts as { headers?: Record<string, string> } | undefined)?.headers ?? {};
    const value = headers[name];
    return value === undefined ? null : decodeURIComponent(value);
  };
  // `ArrayBuffer.isView`, not `instanceof`: bytes can come from another realm (jsdom in tests).
  const bytesOf = (payload: unknown): Uint8Array => {
    if (ArrayBuffer.isView(payload))
      return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (Array.isArray(payload)) return Uint8Array.from(payload as number[]);
    throw fail('invalid', 'expected a binary body');
  };
  const cloudFor = (path: string) => {
    const folder = folderOf(path);
    if (folder?.cloud !== undefined) return folder.cloud;
    const match = /\/(Dropbox|OneDrive|iCloud Drive)(\/|$)/i.exec(norm(path));
    if (!match) return null;
    const name = (match[1] ?? '').toLowerCase();
    const provider = name === 'icloud drive' ? 'icloud' : name;
    return {
      provider,
      root: norm(path).slice(0, (match.index ?? 0) + (match[1]?.length ?? 0) + 1),
    };
  };
  const registryItem = (entry: Json) => {
    const db = folderOf(String(entry.path))?.workspace;
    const status = db ? 'ready' : entry.initializedAt ? 'missing' : 'new';
    return { ...entry, status };
  };
  const dbFor = (workspaceId: string): Db | null => {
    const db = state.dbs[workspaceId];
    return db && folderOf(db.path)?.workspace?.id === workspaceId ? db : null;
  };
  const attached = new Map<string, { path: string; name: string; refs: number }>();
  const requireAttached = (workspaceId: unknown) => {
    const entry = typeof workspaceId === 'string' ? attached.get(workspaceId) : undefined;
    if (!entry) throw fail('not_found', `workspace ${String(workspaceId)} is not open`);
    return entry;
  };
  const createDb = (workspaceId: string): Db => {
    const existing = dbFor(workspaceId);
    if (existing) return existing;
    const { path, name } = requireAttached(workspaceId);
    const createdAt = now();
    const db: Db = { path: norm(path), name, createdAt, nextSeq: 1, updates: [], assets: {} };
    state.dbs[workspaceId] = db;
    const folder = folderOf(path) ?? { entries: 0 };
    folder.workspace = { id: workspaceId, name, createdAt, formatVersion: 1 };
    state.folders[norm(path)] = folder;
    const entry = state.registry.find((candidate) => candidate.id === workspaceId);
    if (entry && !entry.initializedAt) entry.initializedAt = createdAt;
    emitAll('desktop://registry-changed', { origin: '' });
    return db;
  };
  const status = (workspaceId: string) => {
    const { path } = requireAttached(workspaceId);
    const folder = folderOf(path);
    return {
      id: workspaceId,
      path,
      exists: Boolean(folder?.workspace),
      journal: cloudFor(path) ? 'delete' : 'wal',
      cloud: cloudFor(path),
      conflicts: folder?.conflicts ?? [],
      manifest: folder?.workspace ?? null,
    };
  };
  const frame = (maxSeq: number, updates: Uint8Array[]) => {
    const size = 12 + updates.reduce((sum, update) => sum + 4 + update.byteLength, 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, BigInt(maxSeq), true);
    view.setUint32(8, updates.length, true);
    let offset = 12;
    for (const update of updates) {
      view.setUint32(offset, update.byteLength, true);
      offset += 4;
      bytes.set(update, offset);
      offset += update.byteLength;
    }
    return bytes.buffer;
  };
  const sanitize = (name: string) => {
    const cleaned = name
      // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
      .replace(/[\u0000-\u001f/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');
    return cleaned || 'Workspace';
  };
  const sha256 = async (bytes: Uint8Array) => {
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const PAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

  const commands: Record<string, (args: Json, opts: unknown, payload: unknown) => unknown> = {
    'plugin:event|listen': (args) => {
      const id = nextListener;
      nextListener += 1;
      const event = String(args.event);
      listeners.set(event, [
        ...(listeners.get(event) ?? []),
        { id, handler: Number(args.handler) },
      ]);
      return id;
    },
    'plugin:event|unlisten': (args) => {
      const event = String(args.event);
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((listener) => listener.id !== Number(args.eventId)),
      );
      return null;
    },
    'plugin:event|emit': (args) => {
      emitLocal(String(args.event), args.payload);
      return null;
    },
    'plugin:window|start_dragging': () => null,
    app_info: () => ({
      version: '0.1.2',
      windowLabel: label,
      os,
      arch: 'x86_64',
      debug: true,
      defaultRoot,
      updatesConfigured: options.update?.configured ?? false,
    }),
    app_quit: () => {
      state.quit = true;
      return null;
    },
    flush_done: () => null,
    open_external: (args) => {
      const url = String(args.url);
      if (!/^(https|mailto):/.test(url)) throw fail('invalid', 'only https and mailto links');
      state.opened.push(url);
      return null;
    },
    links_take: () => {
      const links = state.pendingLinks;
      state.pendingLinks = [];
      return links;
    },
    menu_set: (args) => {
      if (label !== 'main') throw fail('invalid', 'only the main window sets the menus');
      state.menu = args.spec;
      return null;
    },
    window_set_title: (args) => {
      state.title = String(args.title);
      return null;
    },
    window_zoom: (args) => {
      const delta = Number(args.delta);
      state.zoom =
        delta === 0
          ? 1
          : Math.min(2, Math.max(0.5, Math.round((state.zoom + 0.1 * Math.sign(delta)) * 10) / 10));
      return state.zoom;
    },
    window_toggle_fullscreen: () => null,
    window_show_main: () => null,
    prefs_get: () => ({ ...state.prefs, shortcutError: null }),
    prefs_set: (args) => {
      const patch = (args.patch ?? {}) as Json;
      for (const key of ['closeToTray', 'captureEnabled', 'captureShortcut', 'checkUpdates'])
        if (patch[key] !== undefined) state.prefs[key] = patch[key];
      return { ...state.prefs, shortcutError: null };
    },
    updates_mark_checked: () => {
      state.prefs.lastUpdateCheck = now();
      return null;
    },
    capture_show: () => {
      state.capture.visible = true;
      emitAll('desktop://capture-shown', null);
      return null;
    },
    capture_ready: () => {
      state.capture = { visible: true, ready: true };
      return null;
    },
    capture_hide: () => {
      state.capture.visible = false;
      return null;
    },
    registry_list: () => state.registry.map(registryItem),
    registry_upsert: (args) => {
      const entry = args.entry as Json;
      if (!isId(entry.id) || !isAbsolute(entry.path) || !String(entry.name ?? '').trim())
        throw fail('invalid', 'invalid registry entry');
      const clash = state.registry.find(
        (other) => other.id !== entry.id && norm(String(other.path)) === norm(String(entry.path)),
      );
      if (clash)
        throw fail(
          'conflict',
          `${String(entry.path)} is already the folder of "${String(clash.name)}"`,
        );
      const index = state.registry.findIndex((other) => other.id === entry.id);
      if (index >= 0) state.registry[index] = entry;
      else state.registry.push(entry);
      emitAll('desktop://registry-changed', { origin: label });
      return null;
    },
    registry_remove: (args) => {
      const before = state.registry.length;
      state.registry = state.registry.filter((entry) => entry.id !== args.id);
      if (state.registry.length === before) throw fail('not_found', 'not in the list');
      emitAll('desktop://registry-changed', { origin: label });
      return null;
    },
    registry_touch: (args) => {
      const entry = state.registry.find((candidate) => candidate.id === args.id);
      if (!entry) throw fail('not_found', 'not in the list');
      const latest = Math.max(0, ...state.registry.map((e) => Number(e.lastOpenedAt ?? 0)));
      entry.lastOpenedAt = Math.max(now(), latest + 1);
      emitAll('desktop://registry-changed', { origin: label });
      return entry;
    },
    folder_inspect: (args) => {
      const path = String(args.path);
      if (!isAbsolute(path)) throw fail('invalid', 'not an absolute folder path');
      const folder = folderOf(path);
      const name = norm(path).split('/').pop() ?? '';
      return {
        path,
        name,
        exists: Boolean(folder),
        workspace: folder?.workspace ?? null,
        entries: folder ? (folder.entries ?? 0) + (folder.workspace ? 2 : 0) : 0,
        cloud: cloudFor(path),
        conflicts: folder?.conflicts ?? [],
      };
    },
    folder_suggest: (args) => {
      const parent = norm(String(args.parent));
      const base = sanitize(String(args.name));
      const taken = (path: string) =>
        Boolean(folderOf(path)) ||
        state.registry.some((entry) => norm(String(entry.path)) === path);
      for (let n = 1; n < 1000; n += 1) {
        const candidate = `${parent}/${n === 1 ? base : `${base} ${n}`}`;
        if (!taken(candidate)) return candidate;
      }
      throw fail('conflict', 'no free folder name');
    },
    folder_pick: (args) => {
      state.pickTitles.push(String(args.title));
      return state.pickQueue.length ? state.pickQueue.shift() : null;
    },
    folder_reveal: (args) => {
      state.revealed.push(String(args.path));
      return null;
    },
    workspace_attach: (args) => {
      const workspaceId = String(args.workspaceId);
      const path = String(args.path);
      if (!isId(workspaceId) || !isAbsolute(path)) throw fail('invalid', 'invalid workspace');
      const existing = folderOf(path)?.workspace;
      if (existing && existing.id !== workspaceId)
        throw fail('conflict', `${path} holds another workspace (${existing.name})`);
      const slot = attached.get(workspaceId);
      if (slot && norm(slot.path) !== norm(path)) throw fail('conflict', 'already open elsewhere');
      attached.set(workspaceId, { path, name: String(args.name), refs: (slot?.refs ?? 0) + 1 });
      return status(workspaceId);
    },
    workspace_detach: (args) => {
      const slot = attached.get(String(args.workspaceId));
      if (slot && --slot.refs <= 0) attached.delete(String(args.workspaceId));
      return null;
    },
    workspace_status: (args) => status(String(args.workspaceId)),
    workspace_set_name: (args) => {
      const slot = requireAttached(args.workspaceId);
      slot.name = String(args.name);
      const folder = folderOf(slot.path);
      if (folder?.workspace) folder.workspace.name = slot.name;
      return null;
    },
    workspace_merge_conflict: (args) => {
      const { path } = requireAttached(args.workspaceId);
      const folder = folderOf(path);
      const file = String(args.fileName);
      if (!folder?.conflicts?.includes(file)) throw fail('not_found', `${file} no longer exists`);
      folder.conflicts = folder.conflicts.filter((name) => name !== file);
      return { docs: 1, updates: 3, assets: 0 };
    },
    doc_load: (args) => {
      requireAttached(args.workspaceId);
      const db = dbFor(String(args.workspaceId));
      const rows = (db?.updates ?? []).filter((update) => update.doc === args.docName);
      const maxSeq = rows.reduce((max, row) => Math.max(max, row.seq), 0);
      return frame(
        maxSeq,
        rows.map((row) => fromBase64(row.data)),
      );
    },
    doc_store: (_args, opts, payload) => {
      const workspaceId = header(opts, 'x-tessera-workspace') ?? '';
      const doc = header(opts, 'x-tessera-doc') ?? '';
      requireAttached(workspaceId);
      const bytes = bytesOf(payload);
      if (bytes.byteLength === 0) throw fail('invalid', 'empty update');
      const db = createDb(workspaceId);
      const data = toBase64(bytes);
      db.updates.push({ seq: db.nextSeq, doc, data });
      db.nextSeq += 1;
      save();
      relay('desktop://doc-update', { workspaceId, docName: doc, update: data, origin: label });
      return null;
    },
    doc_compact: (_args, opts, payload) => {
      const workspaceId = header(opts, 'x-tessera-workspace') ?? '';
      const doc = header(opts, 'x-tessera-doc') ?? '';
      const upto = Number(header(opts, 'x-tessera-upto'));
      requireAttached(workspaceId);
      const db = dbFor(workspaceId);
      if (!db) return null;
      db.updates = db.updates.filter((update) => update.doc !== doc || update.seq > upto);
      db.updates.push({ seq: db.nextSeq, doc, data: toBase64(bytesOf(payload)) });
      db.nextSeq += 1;
      return null;
    },
    doc_delete: (args) => {
      requireAttached(args.workspaceId);
      const db = dbFor(String(args.workspaceId));
      if (db) db.updates = db.updates.filter((update) => update.doc !== args.docName);
      return null;
    },
    doc_list: (args) => {
      requireAttached(args.workspaceId);
      const db = dbFor(String(args.workspaceId));
      const prefix = String(args.prefix ?? '');
      return [...new Set((db?.updates ?? []).map((update) => update.doc))]
        .filter((doc) => doc.startsWith(prefix))
        .sort();
    },
    asset_put: async (_args, opts, payload) => {
      const workspaceId = header(opts, 'x-tessera-workspace') ?? '';
      requireAttached(workspaceId);
      const bytes = bytesOf(payload);
      const assetId = await sha256(bytes);
      const db = createDb(workspaceId);
      const existing = db.assets[assetId];
      if (existing) return existing.row;
      const mime = header(opts, 'x-tessera-mime');
      const row = {
        assetId,
        name: header(opts, 'x-tessera-name'),
        mimeType: mime && /^[\w.+-]+\/[\w.+-]+/.test(mime) ? mime : 'application/octet-stream',
        size: bytes.byteLength,
        createdAt: now(),
      };
      db.assets[assetId] = { row, data: toBase64(bytes) };
      return row;
    },
    asset_get: (args) => {
      requireAttached(args.workspaceId);
      const asset = dbFor(String(args.workspaceId))?.assets[String(args.assetId)];
      if (!asset) throw fail('not_found', `asset ${String(args.assetId)} not found`);
      return fromBase64(asset.data).buffer;
    },
    asset_info: (args) => {
      requireAttached(args.workspaceId);
      return dbFor(String(args.workspaceId))?.assets[String(args.assetId)]?.row ?? null;
    },
    asset_list: (args) => {
      requireAttached(args.workspaceId);
      return Object.values(dbFor(String(args.workspaceId))?.assets ?? {}).map((asset) => asset.row);
    },
    asset_delete: (args) => {
      requireAttached(args.workspaceId);
      const db = dbFor(String(args.workspaceId));
      if (db) delete db.assets[String(args.assetId)];
      return null;
    },
    mirror_begin: (args) => {
      const workspaceId = String(args.workspaceId);
      requireAttached(workspaceId);
      if (!dbFor(workspaceId)) throw fail('unavailable', 'the workspace has no folder yet');
      state.mirrorRuns[workspaceId] = [];
      state.mirror[workspaceId] ??= {};
      return null;
    },
    mirror_write: (_args, opts, payload) => {
      const workspaceId = header(opts, 'x-tessera-workspace') ?? '';
      const path = header(opts, 'x-tessera-path') ?? '';
      const run = state.mirrorRuns[workspaceId];
      if (!run) throw fail('invalid', 'no mirror run in progress');
      if (
        !path ||
        path.split('/').some((part) => part === '..' || part === '') ||
        /^[A-Za-z]:|^\//.test(path)
      )
        throw fail('invalid', `unsafe relative path ${path}`);
      run.push(path);
      const text = new TextDecoder().decode(bytesOf(payload));
      const files = (state.mirror[workspaceId] ??= {});
      const changed = files[path] !== text;
      files[path] = text;
      return changed;
    },
    mirror_finish: (args) => {
      const workspaceId = String(args.workspaceId);
      const run = state.mirrorRuns[workspaceId];
      if (!run) throw fail('invalid', 'no mirror run in progress');
      const files = state.mirror[workspaceId] ?? {};
      // Kept: files an earlier run wrote that this one left as they were.
      const keep = Array.isArray(args.keep) ? args.keep.map(String) : [];
      const kept = new Set([...run, ...keep.filter((path) => path in files)]);
      let removed = 0;
      for (const path of Object.keys(files)) {
        if (!kept.has(path)) {
          delete files[path];
          removed += 1;
        }
      }
      state.mirrorRuns[workspaceId] = null;
      return { files: kept.size, removed };
    },
    secret_get: (args) => state.secrets[new URL(String(args.server)).origin] ?? null,
    secret_set: (args) => {
      const origin = new URL(String(args.server)).origin;
      state.secrets[origin] = String(args.token);
      state.servers = [
        ...state.servers.filter((s) => s.server !== origin),
        { server: origin, savedAt: now() },
      ];
      return null;
    },
    secret_delete: (args) => {
      const origin = new URL(String(args.server)).origin;
      delete state.secrets[origin];
      state.servers = state.servers.filter((s) => s.server !== origin);
      return null;
    },
    secret_servers: () => state.servers,
    updater_check: () => {
      const update = options.update;
      return {
        configured: update?.configured ?? false,
        available: Boolean(update?.configured && update.version),
        currentVersion: '0.1.2',
        version: update?.version ?? null,
        notes: update?.notes ?? null,
        date: null,
      };
    },
    updater_install: () => {
      if (!options.update?.configured) throw fail('unavailable', 'updates are not configured');
      emitLocal('desktop://update-progress', { downloaded: 50, total: 100 });
      emitLocal('desktop://update-progress', { downloaded: 100, total: 100 });
      return null;
    },
  };

  const internals = {
    metadata: {
      currentWindow: { label },
      currentWebview: { windowLabel: label, label },
    },
    plugins: {
      path: { sep: os === 'windows' ? '\\' : '/', delimiter: os === 'windows' ? ';' : ':' },
    },
    transformCallback(callback: (payload: unknown) => void, once = false) {
      const id = nextCallback;
      nextCallback += 1;
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id);
        callback(payload);
      });
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    runCallback(id: number, payload: unknown) {
      callbacks.get(id)?.(payload);
    },
    callbacks,
    convertFileSrc(path: string, protocol = 'asset') {
      // The real scheme is served by Rust; here a data URL shows the same bytes in `<img>`.
      const [workspaceId, assetId] = path.split('/');
      const asset = workspaceId && assetId ? state.dbs[workspaceId]?.assets[assetId] : undefined;
      if (protocol === 'tessera-asset' && asset) {
        return `data:${asset.row.mimeType};base64,${asset.data}`;
      }
      return os === 'windows'
        ? `http://${protocol}.localhost/${encodeURIComponent(path)}`
        : `${protocol}://localhost/${encodeURIComponent(path)}`;
    },
    async invoke(cmd: string, args: unknown = {}, opts?: unknown) {
      calls.push({ cmd, args });
      const handler = commands[cmd];
      if (!handler) throw `command ${cmd} not found`;
      const plain = ArrayBuffer.isView(args) || Array.isArray(args) ? {} : ((args ?? {}) as Json);
      // Handlers can trigger listeners that invoke again: save right after the synchronous part,
      // and never reload in between (only messages from other pages reload the state).
      const result = handler(plain, opts, args);
      save();
      const value = await result;
      save();
      return value;
    },
  };

  g.__TAURI_INTERNALS__ = internals;
  g.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, id: number) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((listener) => listener.id !== id),
      );
    },
  };
  const handle: FakeTauriHandle = {
    get state() {
      return state as unknown as FakeTauriHandle['state'];
    },
    calls,
    emit: emitLocal,
    queuePick(path) {
      state.pickQueue.push(path);
      save();
    },
    addFolder(path, folder) {
      state.folders[norm(path)] = folder;
      save();
    },
    queueLink(link) {
      if (!PAGE_ID.test(link.pageId)) return;
      state.pendingLinks.push({
        pageId: link.pageId,
        workspaceId: link.workspaceId ?? null,
        heading: null,
        blockId: null,
      });
      save();
      emitLocal('desktop://deep-link', null);
    },
    save,
  };
  g.__fakeTauri = handle;
}

/** Removes the fake (unit tests). */
export function uninstallFakeTauri(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__TAURI_INTERNALS__;
  delete g.__TAURI_EVENT_PLUGIN_INTERNALS__;
  delete g.__fakeTauri;
}

/** The test hooks of the installed fake. */
export function fakeTauri(): FakeTauriHandle {
  const handle = (globalThis as unknown as { __fakeTauri?: FakeTauriHandle }).__fakeTauri;
  if (!handle) throw new Error('installFakeTauri() has not run');
  return handle;
}
