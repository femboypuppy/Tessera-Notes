/**
 * `@tessera/search/services`: the MiniSearch search index and the graph link index. Feature
 * modules load this subpath with a dynamic `import()` from their service registrations, so none
 * of it (MiniSearch, the worker glue) lands in the startup bundle.
 */
import type { IndexServiceContext } from '@tessera/core';
import type { IndexTransport } from '../engine/transport';
import { createBrowserTransport } from './create-transport';
import { GraphLinkIndex } from './graph-link-index';
import { IndexHost } from './index-host';
import { MiniSearchIndex } from './minisearch-index';

export { GraphLinkIndex } from './graph-link-index';
export { isGraphLinkIndex, isMiniSearchIndex } from './guards';
export { IndexHost, type IndexStatus, type IndexHostContext } from './index-host';
export { MiniSearchIndex, type RichSearchResults } from './minisearch-index';

/** Options for tests and special hosts. */
export interface IndexServiceOptions {
  /** Defaults to the browser worker (with an in-process fallback). */
  transport?: () => IndexTransport | Promise<IndexTransport>;
  /** Persist the index between sessions. Default true. */
  persist?: boolean;
  /** Delay before the pages that show a changed title are read again. Default 1000 ms. */
  retitleDelayMs?: number;
}

function acquire(context: IndexServiceContext, options: IndexServiceOptions) {
  return IndexHost.acquire(context, {
    transport: options.transport ?? createBrowserTransport,
    persist: options.persist ?? true,
    ...(options.retitleDelayMs !== undefined ? { retitleDelayMs: options.retitleDelayMs } : {}),
  });
}

/** Creates the search index for a workspace session (`services` registration, priority 50). */
export async function createSearchIndex(
  context: IndexServiceContext,
  options: IndexServiceOptions = {},
): Promise<MiniSearchIndex> {
  return new MiniSearchIndex(await acquire(context, options));
}

/** Creates the link index for a workspace session (`services` registration, priority 50). */
export async function createLinkIndex(
  context: IndexServiceContext,
  options: IndexServiceOptions = {},
): Promise<GraphLinkIndex> {
  return new GraphLinkIndex(await acquire(context, options));
}
