import type {
  AppInfo,
  AssetRow,
  DeepLink,
  DocUpdateEvent,
  FolderInfo,
  MenuSpec,
  MergeReport,
  MirrorReport,
  Prefs,
  PrefsPatch,
  RegistryEntry,
  RegistryItem,
  ServerEntry,
  UpdateInfo,
  UpdateProgress,
  WorkspaceStatus,
} from './protocol';

/**
 * Everything the web side asks of the desktop shell, one method per Rust command
 * (`src-tauri/src/commands.rs`). The stores and the UI depend on this interface only, so tests can
 * run them on the fake Tauri runtime without a real app.
 */
export interface DesktopBackend {
  appInfo(): Promise<AppInfo>;
  quit(): Promise<void>;
  flushDone(): Promise<void>;
  openExternal(url: string): Promise<void>;
  takeLinks(): Promise<DeepLink[]>;

  setMenu(spec: MenuSpec): Promise<void>;
  setWindowTitle(title: string): Promise<void>;
  zoom(delta: -1 | 0 | 1): Promise<number>;
  toggleFullscreen(): Promise<void>;
  showMainWindow(): Promise<void>;
  getPrefs(): Promise<Prefs>;
  setPrefs(patch: PrefsPatch): Promise<Prefs>;
  markUpdatesChecked(): Promise<void>;
  showCapture(): Promise<void>;
  captureReady(): Promise<void>;
  hideCapture(): Promise<void>;

  listRegistry(): Promise<RegistryItem[]>;
  upsertRegistry(entry: RegistryEntry): Promise<void>;
  removeRegistry(id: string): Promise<void>;
  touchRegistry(id: string): Promise<RegistryEntry>;

  inspectFolder(path: string): Promise<FolderInfo>;
  suggestFolder(parent: string, name: string): Promise<string>;
  /** Native "choose a folder" dialog. Null when cancelled. */
  pickFolder(title: string, defaultPath?: string): Promise<string | null>;
  revealFolder(path: string): Promise<void>;

  attachWorkspace(workspaceId: string, path: string, name: string): Promise<WorkspaceStatus>;
  detachWorkspace(workspaceId: string): Promise<void>;
  workspaceStatus(workspaceId: string): Promise<WorkspaceStatus>;
  setWorkspaceName(workspaceId: string, name: string): Promise<void>;
  mergeConflict(workspaceId: string, fileName: string): Promise<MergeReport>;

  loadDoc(workspaceId: string, docName: string): Promise<{ maxSeq: number; updates: Uint8Array[] }>;
  storeUpdate(workspaceId: string, docName: string, update: Uint8Array): Promise<void>;
  compactDoc(workspaceId: string, docName: string, upto: number, merged: Uint8Array): Promise<void>;
  deleteDoc(workspaceId: string, docName: string): Promise<void>;
  listDocs(workspaceId: string, prefix: string): Promise<string[]>;

  putAsset(
    workspaceId: string,
    bytes: Uint8Array,
    options: { name?: string | null; mimeType?: string | null },
  ): Promise<AssetRow>;
  /** The file's bytes, or null when the asset doesn't exist. */
  getAsset(workspaceId: string, assetId: string): Promise<Uint8Array<ArrayBuffer> | null>;
  assetInfo(workspaceId: string, assetId: string): Promise<AssetRow | null>;
  listAssets(workspaceId: string): Promise<AssetRow[]>;
  deleteAsset(workspaceId: string, assetId: string): Promise<void>;
  /** A URL usable in `<img src>` while the workspace is attached. */
  assetUrl(workspaceId: string, assetId: string): string;

  mirrorBegin(workspaceId: string): Promise<void>;
  mirrorWrite(workspaceId: string, path: string, bytes: Uint8Array): Promise<boolean>;
  /**
   * Ends a run: removes the files an earlier run wrote and this one didn't write or `keep` (the
   * files an incremental run left as they were).
   */
  mirrorFinish(workspaceId: string, keep?: readonly string[]): Promise<MirrorReport>;

  getSecret(server: string): Promise<string | null>;
  setSecret(server: string, token: string): Promise<void>;
  deleteSecret(server: string): Promise<void>;
  listServers(): Promise<ServerEntry[]>;

  checkForUpdate(): Promise<UpdateInfo>;
  installUpdate(): Promise<void>;

  /** Subscriptions to events from the Rust side. Each returns an unsubscribe function. */
  onDocUpdate(listener: (event: DocUpdateEvent) => void): () => void;
  onRegistryChanged(listener: (origin: string) => void): () => void;
  onFlushRequest(listener: () => void): () => void;
  onMenu(listener: (id: string) => void): () => void;
  onDeepLink(listener: () => void): () => void;
  onCaptureShown(listener: () => void): () => void;
  onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void;

  /** The label of the window this page runs in (`main` or `capture`). */
  readonly windowLabel: string;
}
