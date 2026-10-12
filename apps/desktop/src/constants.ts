/**
 * Names shared across the desktop package, kept in a module with no imports so the feature
 * registration (`feature.ts`) stays light.
 */

/** Service IDs, as `ctx.serviceSources` and the diagnostics report them. */
export const TAURI_REGISTRY_ID = 'tauri-folders';
export const TAURI_DOC_STORE_ID = 'tauri-sqlite';
export const TAURI_ASSET_STORE_ID = 'tauri-files';
export const TAURI_CREDENTIAL_STORE_ID = 'keychain';
export const TAURI_FILE_SAVER_ID = 'native-dialog';

/** Commands of the desktop feature. */
export const DESKTOP_COMMANDS = {
  openWorkspaces: 'desktop.openWorkspaces',
  newWorkspace: 'desktop.newWorkspace',
  openFolder: 'desktop.openFolder',
  revealWorkspace: 'desktop.revealWorkspace',
  quickCapture: 'desktop.quickCapture',
  checkForUpdates: 'desktop.checkForUpdates',
  copyDeepLink: 'desktop.copyDeepLink',
  zoomIn: 'desktop.zoomIn',
  zoomOut: 'desktop.zoomOut',
  resetZoom: 'desktop.resetZoom',
  toggleFullscreen: 'desktop.toggleFullscreen',
  openDocs: 'desktop.openDocs',
  openReleases: 'desktop.openReleases',
  reportIssue: 'desktop.reportIssue',
} as const;

/** Menu-only actions (no web shortcut: the editor and text fields handle the keys themselves). */
export const MENU_ONLY = { undo: 'desktop.undo', redo: 'desktop.redo' } as const;

/** Window labels (`src-tauri/src/state.rs`). */
export const WINDOWS = { main: 'main', capture: 'capture' } as const;

/** Events the Rust side emits. */
export const EVENTS = {
  docUpdate: 'desktop://doc-update',
  registryChanged: 'desktop://registry-changed',
  flushRequest: 'desktop://flush-request',
  menu: 'desktop://menu',
  deepLink: 'desktop://deep-link',
  captureShown: 'desktop://capture-shown',
  updateProgress: 'desktop://update-progress',
} as const;

interface TauriInternals {
  metadata?: { currentWindow?: { label?: string } };
}

/** The label of the current window, read without loading the window API. */
export function currentWindowLabel(): string {
  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label ?? WINDOWS.main;
}
