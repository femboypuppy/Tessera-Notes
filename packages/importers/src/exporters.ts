import type {
  ExportContext,
  Exporter,
  ExportProgress,
  ExportScope,
  ExportSession,
  ExportSink,
} from '@tessera/core';
import type { HtmlLabels } from './export/html';
import type { MarkdownExportOptions } from './export/markdown';
import { t } from './i18n/registration';

/** IDs of the exporters this package registers. */
export const EXPORTER_IDS = {
  markdown: 'markdown',
  html: 'html',
  backup: 'tessera-backup',
} as const;

function htmlLabels(): HtmlLabels {
  return { untitled: t('untitled'), needsPlugin: t('needsPlugin'), database: t('database') };
}

/**
 * Obsidian-compatible markdown (a folder or zip of `.md` files, attachments, CSV databases).
 * Registered as `markdown`, and under core's `markdown-basic` ID to replace the basic exporter
 * (the desktop mirror uses whichever it finds).
 */
export function createMarkdownExporter(
  id: string = EXPORTER_IDS.markdown,
  options: MarkdownExportOptions = {},
): Exporter {
  return {
    id,
    label: t('exportMarkdownLabel'),
    description: t('exportMarkdownDescription'),
    scopes: ['workspace', 'subtree', 'page'],
    async run(
      scope: ExportScope,
      context: ExportContext,
      sink: ExportSink,
      onProgress: (progress: ExportProgress) => void,
      signal: AbortSignal,
    ) {
      const { exportMarkdown } = await import('./export/markdown');
      return exportMarkdown(scope, context, sink, onProgress, signal, id, options);
    },
    session(scope: ExportScope, context: ExportContext): ExportSession {
      // The export's code loads with the first run, like `run`.
      let session: Promise<ExportSession> | null = null;
      return {
        async run(changed, sink, onProgress, signal) {
          session ??= import('./export/markdown').then(
            ({ MarkdownExportSession }) => new MarkdownExportSession(scope, context, id, options),
          );
          return (await session).run(changed, sink, onProgress, signal);
        },
      };
    },
  };
}

/** One page as a standalone, styled HTML file. */
export function createHtmlExporter(): Exporter {
  return {
    id: EXPORTER_IDS.html,
    label: t('exportHtmlLabel'),
    description: t('exportHtmlDescription'),
    scopes: ['page'],
    fileExtension: '.html',
    async run(scope, context, sink, onProgress) {
      onProgress({ done: 0, total: 1 });
      const { exportHtml } = await import('./export/html');
      const result = await exportHtml(scope, context, sink, EXPORTER_IDS.html, htmlLabels());
      onProgress({ done: 1, total: 1 });
      return result;
    },
  };
}

/** A JSON backup of the whole workspace, restorable into a new workspace. */
export function createBackupExporter(): Exporter {
  return {
    id: EXPORTER_IDS.backup,
    label: t('exportBackupLabel'),
    description: t('exportBackupDescription'),
    scopes: ['workspace'],
    fileExtension: '.json',
    async run(_scope, context, sink, onProgress, signal) {
      const { exportBackup } = await import('./export/backup');
      return exportBackup(context, sink, onProgress, signal, EXPORTER_IDS.backup);
    },
  };
}

export { htmlLabels };
