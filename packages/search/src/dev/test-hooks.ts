import {
  build as b,
  extractLinks,
  readDocJSON,
  setPageProps,
  tagKey,
  writeDocJSON,
  type AppContext,
  type DocJSON,
  type InlineJSON,
  type JsonValue,
  type LinkEdge,
} from '@tessera/core';
import type { GraphSnapshot } from '../engine/types';
import { generateWorkspace, type GeneratedWorkspace } from '../bench/generator';
import { applyGeneratedWorkspace } from '../bench/seed';
import { isGraphLinkIndex, isMiniSearchIndex } from '../services/guards';

/** Device setting that turns the hooks on (e2e specs set it before the app loads). */
export const TEST_HOOKS_SETTING = 'search.testHooks';

/** Inline content for {@link SearchTestHooks.writeParagraphs}. */
export type InlineSpec = string | { link: string; label?: string } | { tag: string };

/**
 * Hooks for end-to-end specs and screenshot runs, installed on `window.__tesseraSearch` only when
 * the device setting `search.testHooks` is true. They seed content without depending on the
 * editor's UI (which another feature owns) and wait for the index. Never used by the app itself.
 */
export interface SearchTestHooks {
  /** Generates and writes a workspace; returns its pages. */
  seed(options: { pages: number; seed?: number }): Promise<Array<{ id: string; title: string }>>;
  /** Replaces a page's content with paragraphs of text, links and tags, and sets page props. */
  writeParagraphs(
    pageId: string,
    paragraphs: InlineSpec[][],
    props?: Record<string, JsonValue>,
  ): Promise<void>;
  /** A page's content as DocJSON. */
  readDoc(pageId: string): Promise<DocJSON>;
  /** Resolves once the search and link indexes caught up. */
  whenIndexed(): Promise<void>;
  /**
   * Makes the graph view show a generated graph of `pages` nodes instead of the workspace (for
   * performance runs with more pages than the in-memory workspace can hold quickly). Returns its
   * size and its most linked page; `clearGraphStress` undoes it.
   */
  stressGraph(pages: number, seed?: number): { nodes: number; edges: number; hub: string };
  clearGraphStress(): void;
}

declare global {
  interface Window {
    __tesseraSearch?: SearchTestHooks;
  }
}

function inline(spec: InlineSpec): InlineJSON {
  if (typeof spec === 'string') return b.text(spec);
  if ('tag' in spec) return b.tag(spec.tag);
  return b.pageLink(spec.link, spec.label ? { label: spec.label } : {});
}

/** The graph of a generated workspace, as the link index would report it. */
function generatedSnapshot(workspace: GeneratedWorkspace): GraphSnapshot {
  const parents = new Map(workspace.pages.map((page) => [page.id, page.parentId]));
  const rootOf = (id: string) => {
    let current = id;
    for (let parent = parents.get(current); parent; parent = parents.get(current)) current = parent;
    return current;
  };
  const edges: LinkEdge[] = [];
  const tagCounts = new Map<string, number>();
  const nodes = workspace.pages.map((page) => {
    const counts = new Map<string, number>();
    for (const link of extractLinks(page.doc)) {
      if (link.targetPageId !== page.id)
        counts.set(link.targetPageId, (counts.get(link.targetPageId) ?? 0) + 1);
    }
    for (const [target, count] of counts) edges.push({ source: page.id, target, count });
    const tags = page.tags.map((tag) => tagKey(tag));
    for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    return {
      id: page.id,
      title: page.title,
      kind: 'page' as const,
      icon: page.icon,
      isRow: false,
      rootId: rootOf(page.id),
      tags,
      updatedAt: 0,
    };
  });
  const tags = [...tagCounts].map(([key, count]) => ({ key, name: key, count }));
  return { nodes, edges, tags: tags.sort((a, b) => b.count - a.count) };
}

/** Installs the hooks for a session. Returns a cleanup. */
export function installTestHooks(ctx: AppContext): () => void {
  const hooks: SearchTestHooks = {
    async seed({ pages, seed = 1 }) {
      const workspace = generateWorkspace({ pages, seed });
      await applyGeneratedWorkspace(ctx, workspace);
      return workspace.pages.map((page) => ({ id: page.id, title: page.title }));
    },
    async writeParagraphs(pageId, paragraphs, props) {
      const handle = await ctx.loadPageDoc(pageId);
      try {
        handle.doc.transact(() => {
          writeDocJSON(
            handle.doc,
            b.doc(...paragraphs.map((parts) => b.paragraph(...parts.map(inline)))),
          );
          if (props) setPageProps(handle.doc, props);
        });
      } finally {
        handle.release();
      }
    },
    async readDoc(pageId) {
      const handle = await ctx.loadPageDoc(pageId);
      try {
        return readDocJSON(handle.doc);
      } finally {
        handle.release();
      }
    },
    stressGraph(pages, seed = 7) {
      const snapshot = generatedSnapshot(generateWorkspace({ pages, seed }));
      (globalThis as { __tesseraGraphStress?: GraphSnapshot }).__tesseraGraphStress = snapshot;
      const degree = new Map<string, number>();
      for (const { source, target } of snapshot.edges) {
        degree.set(source, (degree.get(source) ?? 0) + 1);
        degree.set(target, (degree.get(target) ?? 0) + 1);
      }
      let hub = snapshot.nodes[0]?.id ?? '';
      for (const [id, count] of degree) if (count > (degree.get(hub) ?? 0)) hub = id;
      return { nodes: snapshot.nodes.length, edges: snapshot.edges.length, hub };
    },
    clearGraphStress() {
      delete (globalThis as { __tesseraGraphStress?: GraphSnapshot }).__tesseraGraphStress;
    },
    async whenIndexed() {
      const { searchIndex, linkIndex } = ctx.services;
      if (isMiniSearchIndex(searchIndex)) await searchIndex.whenIdle();
      if (isGraphLinkIndex(linkIndex)) await linkIndex.whenIdle();
    },
  };
  window.__tesseraSearch = hooks;
  return () => {
    hooks.clearGraphStress();
    if (window.__tesseraSearch === hooks) delete window.__tesseraSearch;
  };
}
