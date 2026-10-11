import { extractAssetIds, readDocJSON, toError, type DocJSON, type PageMeta } from '@tessera/core';
import { useAppContext, usePage } from '@tessera/core/react';
import { Button, EmptyState, Spinner } from '@tessera/ui';
import DOMPurify from 'dompurify';
import { ArrowLeft, FileX, Printer } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { PAGE_STYLES, renderDatabaseTables, renderDocHtml } from '../export/html';
import { htmlLabels } from '../exporters';
import { t } from '../i18n';
import { PRINT_ROUTE, printPath } from './routes';

/**
 * The export stylesheet, scoped to the print view's shadow root and following the app's theme
 * (its design tokens) on screen. Printing always uses the light, ink-friendly colors.
 */
const PRINT_VIEW_STYLES = [
  PAGE_STYLES.replace(/@media \(prefers-color-scheme:dark\)\{[^{}]*\{[^{}]*\}\}/g, '')
    .replace(/:root/g, ':host')
    .replace(/\bbody\{margin:0;/, ':host{display:block;'),
  ':host{--bg:var(--tess-bg);--fg:var(--tess-fg);--muted:var(--tess-fg-muted);--border:var(--tess-border);--subtle:var(--tess-bg-subtle);--accent:var(--tess-accent-text);--mark:var(--tess-tag-yellow-bg)}',
  ':host([data-theme="dark"]) [class^="highlight-"],:host([data-theme="dark"]) [class*="-background"]{color:#16171b}',
  '@media print{:host{--bg:#fff;--fg:#000;--muted:#555;--border:#ccc;--subtle:#f4f4f4;--accent:#1d4ed8;--mark:#fff3a3}}',
].join('\n');

/** Object URLs (`blob:`) are how the asset store serves images in the browser. */
const ALLOWED_URI =
  /^(?:(?:https?|mailto|tel|blob):|data:image\/|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

type State =
  { kind: 'loading' } | { kind: 'ready'; html: string } | { kind: 'error'; message: string };

function useDocumentTheme(): string {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light');
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme ?? 'light'),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Renders sanitized page HTML in a shadow root, so its styles and the app's never mix. */
function PageHtml({ html, onOpenPage }: { html: string; onOpenPage: (pageId: string) => void }) {
  const host = useRef<HTMLDivElement | null>(null);
  const theme = useDocumentTheme();
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const root = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    // `html` went through DOMPurify; the stylesheet is ours.
    root.innerHTML = `<style>${PRINT_VIEW_STYLES}</style>${html}`;
    const onClick = (event: Event) => {
      if (!(event instanceof MouseEvent) || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest('a.page-link[data-page-id]');
      const pageId = link?.getAttribute('data-page-id');
      if (!pageId) return;
      event.preventDefault();
      onOpenPage(pageId);
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [html, onOpenPage]);
  return <div ref={host} data-theme={theme} data-testid="print-page" />;
}

/** Waits until the images in the rendered page have loaded (or failed), at most a few seconds. */
async function imagesLoaded(host: Element | null): Promise<void> {
  const images = [...(host?.shadowRoot?.querySelectorAll('img') ?? [])];
  const pending = images
    .filter((image) => !image.complete)
    .map(
      (image) =>
        new Promise<void>((resolve) => {
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => resolve(), { once: true });
        }),
    );
  await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

async function renderPage(ctx: ReturnType<typeof useAppContext>, page: PageMeta): Promise<string> {
  let doc: DocJSON;
  if (page.kind === 'database') {
    doc = { type: 'doc', content: [{ type: 'embed', attrs: { kind: 'database', ref: page.id } }] };
  } else {
    const handle = await ctx.loadPageDoc(page.id);
    try {
      doc = readDocJSON(handle.doc);
    } finally {
      handle.release();
    }
  }
  const labels = htmlLabels();
  const urls = new Map<string, string>();
  for (const assetId of extractAssetIds(doc)) {
    const url = await ctx.services.assetStore.getUrl(assetId);
    if (url) urls.set(assetId, url);
  }
  const databases = await renderDatabaseTables(doc, ctx, labels);
  const snapshot = ctx.workspace.pages.getSnapshot();
  const html = renderDocHtml(doc, {
    title: page.title,
    ...(page.icon ? { icon: page.icon } : {}),
    labels,
    pageTitle: (pageId) => snapshot.get(pageId)?.title ?? null,
    pageHref: (pageId) => (snapshot.get(pageId) ? printPath(pageId) : null),
    assetUrl: (assetId) => urls.get(assetId) ?? null,
    databases,
  });
  return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: ALLOWED_URI });
}

/**
 * `/print/:pageId`: a page as a clean document for printing and "Save as PDF" (the PDF export).
 * Links between pages stay clickable. With `?print=1` it opens the print dialog once rendered.
 */
export default function PrintView() {
  const ctx = useAppContext();
  const location = useLocation();
  // The shell renders bare routes outside its <Routes>, so the path is matched here.
  const pageId = matchPath(PRINT_ROUTE, location.pathname)?.params.pageId ?? null;
  const page = usePage(pageId);
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const host = useRef<HTMLDivElement | null>(null);
  const autoPrint = new URLSearchParams(location.search).get('print') === '1';

  useEffect(() => {
    if (!page) return undefined;
    let cancelled = false;
    setState({ kind: 'loading' });
    renderPage(ctx, page).then(
      (html) => {
        if (!cancelled) setState({ kind: 'ready', html });
      },
      (error: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: toError(error).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ctx, page]);

  // The browser suggests the document title as the PDF's file name.
  const title = page?.title || t('untitled');
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);

  const openPage = useCallback((target: string) => ctx.navigateTo(printPath(target)), [ctx]);
  // The platform's print: `window.print()` in browsers, the webview's native print on the desktop.
  const print = useCallback(() => {
    ctx.services.fileSaver.print().catch((error: unknown) =>
      ctx.toast({
        variant: 'error',
        title: t('printFailedToast'),
        description: toError(error).message,
      }),
    );
  }, [ctx]);

  useEffect(() => {
    if (state.kind !== 'ready' || !autoPrint || !pageId) return undefined;
    let cancelled = false;
    void imagesLoaded(host.current?.querySelector('[data-testid="print-page"]') ?? null).then(
      () => {
        if (cancelled) return;
        void navigate(printPath(pageId), { replace: true });
        print();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state, autoPrint, pageId, navigate, print]);


  let content;
  if (!page) {
    content = (
      <EmptyState
        className="mt-16"
        icon={<FileX />}
        title={t('printMissingTitle')}
        description={t('printMissingHint')}
      />
    );
  } else if (state.kind === 'loading') {
    content = (
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  } else if (state.kind === 'error') {
    content = (
      <EmptyState
        className="mt-16"
        tone="danger"
        icon={<FileX />}
        title={t('printFailedTitle')}
        description={state.message}
      />
    );
  } else {
    content = <PageHtml html={state.html} onOpenPage={openPage} />;
  }

  return (
    <div ref={host} className="min-h-full bg-bg">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg/90 px-3 py-2 backdrop-blur print:hidden">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => (page ? ctx.navigate(page.id) : ctx.navigateTo('/'))}
        >
          <ArrowLeft aria-hidden="true" />
          {t('backToPage')}
        </Button>
        <p className="min-w-0 flex-1 truncate text-center text-ui font-medium text-fg-muted">
          {t('printViewTitle')}
        </p>
        <Button
          variant="primary"
          size="sm"
          onClick={print}
          disabled={state.kind !== 'ready'}
        >
          <Printer aria-hidden="true" />
          {t('printAction')}
        </Button>
      </div>
      {page?.kind === 'database' ? (
        <p className="mx-auto max-w-[720px] px-6 pt-6 text-ui text-fg-muted print:hidden">
          {t('printDatabaseHint')}
        </p>
      ) : null}
      {content}
    </div>
  );
}
