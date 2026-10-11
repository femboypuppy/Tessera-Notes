/**
 * @tessera/desktop: the Tauri 2 desktop app (Agent 07). This entry is what the web app imports
 * statically, so it stays tiny: `isTauri()` and the feature definition, whose services, UI and
 * strings all load on demand, and only inside the desktop app.
 */
import {
  defineFeature,
  defineService,
  SERVICE_PRIORITY,
  type FeatureModule,
  type OnboardingActionContribution,
} from '@tessera/core';
import { t } from '@tessera/ui';
import { FolderOpen } from 'lucide-react';
import {
  TAURI_ASSET_STORE_ID,
  TAURI_CREDENTIAL_STORE_ID,
  TAURI_DOC_STORE_ID,
  TAURI_FILE_SAVER_ID,
  TAURI_REGISTRY_ID,
} from './constants';

export const DESKTOP_PACKAGE = '@tessera/desktop';

/** True when running inside a Tauri webview. */
export function isTauri(): boolean {
  return typeof globalThis === 'object' && '__TAURI_INTERNALS__' in globalThis;
}

const services = () => import('./services');

/**
 * "Open a workspace folder" on the first-run screen. Its strings are read when the screen renders:
 * the `desktop` strings are registered when the workspace registry starts (`services.ts`).
 */
const openFolderAction: OnboardingActionContribution = {
  id: 'desktop-open-folder',
  get title() {
    return t('desktop:openFolderAction');
  },
  get description() {
    return t('desktop:openFolderActionDescription');
  },
  get workspaceName() {
    return t('desktop:defaultWorkspaceName');
  },
  icon: FolderOpen,
  order: 10,
  run: async (ctx) => {
    const [{ openFolderFromOnboarding }, { getBackend }] = await Promise.all([
      import('./workspace/flows'),
      import('./runtime'),
    ]);
    await openFolderFromOnboarding(getBackend(), ctx);
  },
};

/**
 * The desktop feature (`apps/web/src/features/desktop`). Inside Tauri it swaps in folder-based
 * storage, the OS keychain for sign-in tokens and native save and print for exports (priority 100) and, when a workspace opens, registers the workspace picker, quick
 * capture, Settings → Desktop, native menus and deep links. In a browser it's just `{ id }`.
 */
export function createDesktopFeature(): FeatureModule {
  if (!isTauri()) return defineFeature({ id: 'desktop' });
  return defineFeature({
    id: 'desktop',
    services: [
      defineService({
        provides: 'workspaceRegistry',
        id: TAURI_REGISTRY_ID,
        priority: SERVICE_PRIORITY.desktop,
        isAvailable: () => isTauri(),
        create: async () => (await services()).createWorkspaceRegistry(),
      }),
      defineService({
        provides: 'credentialStore',
        id: TAURI_CREDENTIAL_STORE_ID,
        priority: SERVICE_PRIORITY.desktop,
        isAvailable: () => isTauri(),
        create: async () => {
          const [{ KeychainCredentialStore }, { getBackend }] = await Promise.all([
            import('./stores/credential-store'),
            import('./runtime'),
          ]);
          return new KeychainCredentialStore(getBackend());
        },
      }),
      defineService({
        provides: 'fileSaver',
        id: TAURI_FILE_SAVER_ID,
        priority: SERVICE_PRIORITY.desktop,
        isAvailable: () => isTauri(),
        create: async () => {
          const [{ TauriFileSaver }, { getBackend }] = await Promise.all([
            import('./files/file-saver'),
            import('./runtime'),
          ]);
          return new TauriFileSaver(getBackend());
        },
      }),
      defineService({
        provides: 'docStore',
        id: TAURI_DOC_STORE_ID,
        priority: SERVICE_PRIORITY.desktop,
        isAvailable: ({ workspace }) => isTauri() && Boolean(workspace.path),
        create: async (context) => (await services()).openDocStore(context),
      }),
      defineService({
        provides: 'assetStore',
        id: TAURI_ASSET_STORE_ID,
        priority: SERVICE_PRIORITY.desktop,
        isAvailable: ({ workspace }) => isTauri() && Boolean(workspace.path),
        create: async (context) => (await services()).openAssetStore(context),
      }),
    ],
    onboardingActions: [openFolderAction],
    activate: async (ctx) => (await import('./activate')).activateDesktop(ctx),
  });
}
