/**
 * The seeded harness: the real web app (the shell and every registered feature from `apps/web`)
 * with one extra feature that opens a generated workspace. Benchmarks and seeded end-to-end
 * fixtures load it; nothing in the shipped app depends on it.
 *
 * Boot mirrors `apps/web/src/main.tsx`, plus generating the workspace first. Timings go to
 * `window.__tesseraHarness.timings` (and `performance` marks).
 *
 * `?store=indexeddb` runs the app on its real storage instead (IndexedDB, onboarding in a new
 * profile), with the generated workspace only as markdown files to import; `&index=fresh` deletes
 * the saved search indexes first, as on a device that opens a workspace for the first time.
 */
import {
  createAppRuntime,
  defineFeature,
  LocalStorageSettingsStore,
  workspaceDocName,
} from '@tessera/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../../apps/web/src/app/App';
import { renderFatalError } from '../../../apps/web/src/app/FatalError';
import { followTheme } from '../../../apps/web/src/app/theme';
import { initI18n, t } from '../../../apps/web/src/i18n';
import './styles.css';
import { generateWorkspace, type GeneratedWorkspace } from '../src/generator';
import { resolveOptions } from '../src/generator/plan';
import type { HarnessState } from '../src/harness-state';
import { seedFeature } from '../src/runtime/seed';
import { optionsFromSearch } from './params';

const WORKSPACE_ID = 'seeded';

/** Resolves after the next frame has painted and the main thread has run a task. */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
  });
}

/** Resolves when the sidebar's page tree shows its first row. */
function sidebarRendered(): Promise<void> {
  const selector = '[role="tree"] [role="treeitem"]';
  return new Promise((resolve) => {
    if (document.querySelector(selector)) {
      resolve();
      return;
    }
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/** Deletes an IndexedDB database (waiting while another connection holds it open). */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Could not delete ${name}`));
  });
}

/** `?store=indexeddb`: the real app on real storage (see the file comment). */
async function startOnRealStorage(container: HTMLElement, startedAt: number): Promise<void> {
  const params = new URLSearchParams(location.search);
  const options = optionsFromSearch(location.search);
  // Planned only when the markdown files are asked for: reopening does no generating.
  let generated: GeneratedWorkspace | null = null;
  const state: HarnessState = {
    ready: false,
    error: null,
    options: resolveOptions(options),
    workspaceId: '',
    pages: [],
    databases: [],
    largePages: [],
    timings: { start: startedAt, seeded: startedAt, sidebarReady: null },
    ctx: null,
    markdownFiles: () => (generated ??= generateWorkspace(options)).markdownFiles(),
  };
  window.__tesseraHarness = state;
  // The search and link indexes' saved state (`@tessera/search`'s IdbPersistence).
  if (params.get('index') === 'fresh') await deleteDatabase('tessera-search');
  performance.mark('harness:seeded');

  const settings = new LocalStorageSettingsStore();
  followTheme(settings);
  await initI18n(settings);
  const { features } = await import('../../../apps/web/src/features');
  const capture = defineFeature({
    id: 'testkit-capture',
    activate: (ctx) => {
      state.ctx = ctx;
      state.workspaceId = ctx.workspace.info.id;
      return () => {
        if (state.ctx === ctx) state.ctx = null;
      };
    },
  });
  const runtime = await createAppRuntime({
    features: [...features, capture],
    deviceSettings: settings,
    defaultUserName: t('defaultUserName'),
    onError: (error, context) =>
      console.error(`[tessera] ${context.area} ${context.source}:`, error),
  });
  createRoot(container).render(
    <StrictMode>
      <App runtime={runtime} />
    </StrictMode>,
  );
  await afterPaint();
  // Onboarding in a new profile, or the last workspace: the sidebar shows up with a workspace.
  state.ready = true;
  await sidebarRendered();
  await afterPaint();
  state.timings.sidebarReady = performance.now();
  performance.mark('harness:sidebar-ready');
}

async function start(): Promise<void> {
  const startedAt = performance.now();
  performance.mark('harness:start');
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing #root element');
  if (new URLSearchParams(location.search).get('store') === 'indexeddb') {
    await startOnRealStorage(container, startedAt);
    return;
  }

  const generated = generateWorkspace(optionsFromSearch(location.search));
  const largePages = generated.pages.filter((page) => page.role === 'large');
  const state: HarnessState = {
    ready: false,
    error: null,
    options: generated.options,
    workspaceId: WORKSPACE_ID,
    pages: generated.pages.map((page) => ({
      id: page.id,
      title: page.title,
      role: page.role,
      parentId: page.parentId,
      depth: page.depth,
      trashed: page.trashed,
    })),
    databases: generated.databases.map((database) => ({
      id: database.id,
      title: database.title,
      views: database.views.map((view) => ({ id: view.id, name: view.name, type: view.type })),
    })),
    largePages: largePages.map((page) => ({
      id: page.id,
      title: page.title,
      blocks: page.blockCount ?? 0,
      marker: generated.largePageMarker(page.id) ?? '',
    })),
    timings: { start: startedAt, seeded: 0, sidebarReady: null },
    ctx: null,
    markdownFiles: () => generated.markdownFiles(),
  };
  window.__tesseraHarness = state;

  // Build the workspace doc and the large pages now, so booting measures loading, not generating.
  const seed = seedFeature(generated, {
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Seeded workspace',
    preload: [workspaceDocName(WORKSPACE_ID), ...largePages.map((page) => `page:${page.id}`)],
    onActivate: (ctx) => {
      state.ctx = ctx;
      return () => {
        if (state.ctx === ctx) state.ctx = null;
      };
    },
  });
  await afterPaint();
  state.timings.seeded = performance.now();
  performance.mark('harness:seeded');

  const settings = new LocalStorageSettingsStore();
  followTheme(settings);
  await initI18n(settings);
  const { features } = await import('../../../apps/web/src/features');
  const runtime = await createAppRuntime({
    features: [...features, seed],
    deviceSettings: settings,
    defaultUserName: t('defaultUserName'),
    onError: (error, context) =>
      console.error(`[tessera] ${context.area} ${context.source}:`, error),
  });
  createRoot(container).render(
    <StrictMode>
      <App runtime={runtime} />
    </StrictMode>,
  );
  await sidebarRendered();
  await afterPaint();
  state.timings.sidebarReady = performance.now();
  performance.mark('harness:sidebar-ready');
  state.ready = true;
}

start().catch((error: unknown) => {
  if (window.__tesseraHarness)
    window.__tesseraHarness.error = error instanceof Error ? error.message : String(error);
  renderFatalError(error);
});
