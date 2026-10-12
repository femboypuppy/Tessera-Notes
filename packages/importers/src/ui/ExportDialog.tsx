import {
  AbortError,
  MemoryExportSink,
  toError,
  type ExportProgress,
  type ExportResult,
  type ExportScope,
  type Exporter,
  type SavedFile,
} from '@tessera/core';
import { useAppContext, usePages } from '@tessera/core/react';
import {
  Button,
  Callout,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Label,
  RadioCard,
  RadioGroup,
  Select,
} from '@tessera/ui';
import {
  Archive,
  CircleCheck,
  CircleX,
  FileCode,
  FileText,
  Printer,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createMarkdownExporter, EXPORTER_IDS } from '../exporters';
import { fileNameFor } from '../export/names';
import { SingleFileSink, ZipExportSink } from '../export/zip-sink';
import { t } from '../i18n';
import { basename } from '../paths';
import { blobPart } from './download';
import { exportContextFor } from './jobs';
import { formatBytes, groupIssues } from './labels';
import { printPath } from './routes';
import { closeExportDialog, useImportExportState } from './store';

type Format = 'markdown' | 'html' | 'pdf' | 'backup';
type ScopeKind = ExportScope['kind'];

interface FormatOption {
  id: Format;
  /** The registered exporter it runs (the PDF opens the print view instead). */
  exporterId: string | null;
  icon: LucideIcon;
  scopes: readonly ScopeKind[];
}

const FORMATS: readonly FormatOption[] = [
  {
    id: 'markdown',
    exporterId: EXPORTER_IDS.markdown,
    icon: FileText,
    scopes: ['page', 'subtree', 'workspace'],
  },
  { id: 'html', exporterId: EXPORTER_IDS.html, icon: FileCode, scopes: ['page'] },
  { id: 'pdf', exporterId: null, icon: Printer, scopes: ['page'] },
  { id: 'backup', exporterId: EXPORTER_IDS.backup, icon: Archive, scopes: ['workspace'] },
];

function formatLabel(option: FormatOption, exporter: Exporter | undefined): string {
  if (option.id === 'pdf') return t('exportPdfLabel');
  return exporter?.label ?? option.id;
}

function formatDescription(option: FormatOption, exporter: Exporter | undefined): string {
  if (option.id === 'pdf') return t('exportPdfDescription');
  return exporter?.description ?? '';
}

interface ExportedFile {
  blob: Blob;
  name: string;
}

/** Saving the exported file: downloading it, or the save dialog of the desktop app. */
type SaveState =
  | { kind: 'saving' }
  | { kind: 'saved'; saved: SavedFile }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

type Phase =
  | { kind: 'options' }
  | { kind: 'running'; progress: ExportProgress | null; controller: AbortController }
  | { kind: 'done'; result: ExportResult; file: ExportedFile; save: SaveState }
  | { kind: 'error'; message: string };

function ExportForm({ pageId }: { pageId: string | null }) {
  const ctx = useAppContext();
  const snapshot = usePages();
  const page = pageId ? snapshot.get(pageId) : undefined;
  const hasChildren = page ? snapshot.children(page.id, { includeRows: true }).length > 0 : false;
  const formats = FORMATS.filter(
    (option) => option.exporterId === null || ctx.exporters.get(option.exporterId),
  ).filter((option) => page || option.scopes.includes('workspace'));
  const [format, setFormat] = useState<Format>('markdown');
  const [scope, setScope] = useState<ScopeKind>(
    page ? (hasChildren ? 'subtree' : 'page') : 'workspace',
  );
  const [linkStyle, setLinkStyle] = useState<'wikilink' | 'markdown'>('wikilink');
  const [phase, setPhase] = useState<Phase>({ kind: 'options' });
  const controllerRef = useRef<AbortController | null>(null);
  const option = formats.find((candidate) => candidate.id === format) ?? formats[0];

  // Closing the dialog cancels a running export.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const chooseFormat = (value: string) => {
    const next = formats.find((candidate) => candidate.id === value);
    if (!next) return;
    setFormat(next.id);
    if (!next.scopes.includes(scope)) {
      const [first = 'workspace'] = next.scopes;
      setScope(first);
    }
  };

  const scopeTitle = scope === 'workspace' ? ctx.workspace.info.name : page?.title || t('untitled');
  const fileSaver = ctx.services.fileSaver;

  /** Downloads the file, or asks where to save it (the desktop app's save dialog). */
  const save = async (result: ExportResult, file: ExportedFile) => {
    setPhase({ kind: 'done', result, file, save: { kind: 'saving' } });
    let state: SaveState;
    try {
      const saved = await fileSaver.save({ name: file.name, data: file.blob });
      state = saved ? { kind: 'saved', saved } : { kind: 'cancelled' };
    } catch (error) {
      state = { kind: 'failed', message: toError(error).message };
    }
    setPhase((current) =>
      current.kind === 'done' && current.file === file ? { ...current, save: state } : current,
    );
  };

  const run = async () => {
    if (!option) return;
    if (option.id === 'pdf') {
      if (!page) return;
      closeExportDialog();
      ctx.navigateTo(printPath(page.id, true));
      return;
    }
    const exporter =
      option.id === 'markdown'
        ? createMarkdownExporter(EXPORTER_IDS.markdown, { linkStyle })
        : option.exporterId
          ? ctx.exporters.get(option.exporterId)
          : undefined;
    if (!exporter) return;
    const target: ExportScope =
      scope === 'workspace' || !page ? { kind: 'workspace' } : { kind: scope, pageId: page.id };
    const controller = new AbortController();
    controllerRef.current = controller;
    setPhase({ kind: 'running', progress: null, controller });
    const onProgress = (progress: ExportProgress) => {
      if (!controller.signal.aborted)
        setPhase((current) => (current.kind === 'running' ? { ...current, progress } : current));
    };
    try {
      let result: ExportResult;
      let file: ExportedFile;
      if (option.id === 'markdown' && target.kind === 'page') {
        // One page: a plain `.md` file, or a zip when it has attachments to go with it.
        const memory = new MemoryExportSink();
        result = await exporter.run(
          target,
          exportContextFor(ctx),
          memory,
          onProgress,
          controller.signal,
        );
        const [only] = memory.files;
        if (memory.files.size === 1 && only) {
          const [path, data] = only;
          const content = typeof data === 'string' ? data : blobPart(data);
          file = { blob: new Blob([content], { type: 'text/markdown' }), name: basename(path) };
        } else {
          const zip = new ZipExportSink();
          for (const [path, data] of memory.files) await zip.writeFile(path, data);
          file = {
            blob: new Blob([blobPart(await zip.finish())], { type: 'application/zip' }),
            name: `${fileNameFor(scopeTitle)}.zip`,
          };
        }
      } else if (option.id === 'markdown') {
        const sink = new ZipExportSink();
        result = await exporter.run(
          target,
          exportContextFor(ctx),
          sink,
          onProgress,
          controller.signal,
        );
        const bytes = await sink.finish();
        file = {
          blob: new Blob([blobPart(bytes)], { type: 'application/zip' }),
          name: `${fileNameFor(scopeTitle)}.zip`,
        };
      } else {
        const sink = new SingleFileSink();
        result = await exporter.run(
          target,
          exportContextFor(ctx),
          sink,
          onProgress,
          controller.signal,
        );
        if (!sink.name || sink.data === null) throw new Error(t('exportFailedTitle'));
        const type = option.id === 'html' ? 'text/html' : 'application/json';
        const data = typeof sink.data === 'string' ? sink.data : blobPart(sink.data);
        file = { blob: new Blob([data], { type }), name: basename(sink.name) };
      }
      if (controller.signal.aborted) {
        setPhase({ kind: 'options' });
        return;
      }
      void save(result, file);
    } catch (error) {
      if (error instanceof AbortError || controller.signal.aborted) setPhase({ kind: 'options' });
      else setPhase({ kind: 'error', message: toError(error).message });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  if (phase.kind === 'running') {
    const progress = phase.progress;
    const fraction = progress && progress.total > 0 ? progress.done / progress.total : 0;
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t('exportingTitle')}</DialogTitle>
          <DialogDescription>{scopeTitle}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 py-6">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-fg">{progress?.currentPage ?? ''}</span>
            {progress && progress.total > 0 ? (
              <span className="shrink-0 text-ui text-fg-muted tabular-nums">
                {t('progressCount', { done: progress.done, total: progress.total })}
              </span>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-label={t('exportingTitle')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            className="h-2 overflow-hidden rounded-full bg-active"
          >
            <div
              className="duration-normal h-full rounded-full bg-accent transition-[width] ease-out"
              style={{ width: `${Math.max(2, fraction * 100)}%` }}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => phase.controller.abort()}>{t('cancelExport')}</Button>
        </DialogFooter>
      </>
    );
  }

  if (phase.kind === 'done' || phase.kind === 'error') {
    const done = phase.kind === 'done';
    const issues = done ? groupIssues(phase.result.issues) : [];
    const Icon = done ? CircleCheck : CircleX;
    let description = done ? '' : phase.message;
    if (phase.kind === 'done') {
      const name = phase.file.name;
      const size = formatBytes(phase.file.blob.size);
      const state = phase.save;
      if (state.kind === 'saving') description = t('exportSavingHint', { name });
      else if (state.kind === 'saved')
        description = state.saved.path
          ? t('exportSavedHint', { name: state.saved.name, size, path: state.saved.path })
          : t('exportDoneHint', { name, size });
      else description = t('exportNotSavedHint', { name });
    }
    const saveFailure = phase.kind === 'done' && phase.save.kind === 'failed' ? phase.save : null;
    return (
      <>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Icon
              className={done ? 'size-5 text-success-text' : 'size-5 text-danger-text'}
              aria-hidden="true"
            />
            <DialogTitle>{done ? t('exportDoneTitle') : t('exportFailedTitle')}</DialogTitle>
          </div>
          <DialogDescription aria-live="polite">{description}</DialogDescription>
        </DialogHeader>
        {issues.length || saveFailure ? (
          <DialogBody className="flex flex-col gap-3 pb-2">
            {saveFailure ? (
              <Callout tone="danger" title={t('saveFailedTitle')}>
                {saveFailure.message}
              </Callout>
            ) : null}
            {issues.length ? (
              <Callout tone="warning" title={t('exportIssuesTitle')}>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {issues.map((group) => (
                    <li key={group.label}>
                      {group.label} ({group.issues.length})
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : null}
          </DialogBody>
        ) : null}
        <DialogFooter>
          {phase.kind === 'done' ? (
            <Button
              loading={phase.save.kind === 'saving'}
              onClick={() => void save(phase.result, phase.file)}
            >
              {fileSaver.mode === 'dialog' ? t('saveAs') : t('downloadAgain')}
            </Button>
          ) : (
            <Button onClick={() => setPhase({ kind: 'options' })}>{t('tryAgain')}</Button>
          )}
          <Button variant="primary" onClick={closeExportDialog}>
            {t('done')}
          </Button>
        </DialogFooter>
      </>
    );
  }

  const scopes: Array<{ kind: ScopeKind; label: string; hint: string }> = [];
  if (page) {
    scopes.push({ kind: 'page', label: t('scopePage'), hint: page.title || t('untitled') });
    if (hasChildren)
      scopes.push({ kind: 'subtree', label: t('scopeSubtree'), hint: page.title || t('untitled') });
  }
  scopes.push({ kind: 'workspace', label: t('scopeWorkspace'), hint: ctx.workspace.info.name });
  const allowed = scopes.filter((candidate) => option?.scopes.includes(candidate.kind));

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('exportTitle')}</DialogTitle>
        <DialogDescription>{t('exportDescription')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-5 pb-4">
        <div className="flex flex-col gap-2">
          <Label id="export-format">{t('formatLabel')}</Label>
          <RadioGroup
            aria-labelledby="export-format"
            value={format}
            onValueChange={chooseFormat}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {formats.map((candidate) => {
              const Icon = candidate.icon;
              const exporter = candidate.exporterId
                ? ctx.exporters.get(candidate.exporterId)
                : undefined;
              return (
                <RadioCard
                  key={candidate.id}
                  value={candidate.id}
                  label={formatLabel(candidate, exporter)}
                  description={formatDescription(candidate, exporter)}
                  icon={<Icon />}
                />
              );
            })}
          </RadioGroup>
        </div>
        <div className="flex flex-col gap-2">
          <Label id="export-scope">{t('scopeLabel')}</Label>
          <RadioGroup
            aria-labelledby="export-scope"
            value={allowed.some((candidate) => candidate.kind === scope) ? scope : ''}
            onValueChange={(value) => setScope(value as ScopeKind)}
            className="grid grid-cols-1 gap-2 sm:grid-cols-3"
          >
            {allowed.map((candidate) => (
              <RadioCard
                key={candidate.kind}
                value={candidate.kind}
                label={candidate.label}
                description={<span className="line-clamp-1 break-all">{candidate.hint}</span>}
              />
            ))}
          </RadioGroup>
          {!page && formats.length < FORMATS.length ? (
            <p className="text-xs text-fg-muted">{t('exportNeedsPage')}</p>
          ) : null}
        </div>
        {format === 'markdown' ? (
          <Field label={t('linkStyleLabel')} description={t('linkStyleHint')}>
            {(props) => (
              <Select
                id={props.id}
                aria-describedby={props['aria-describedby']}
                value={linkStyle}
                onValueChange={(value) =>
                  setLinkStyle(value === 'markdown' ? 'markdown' : 'wikilink')
                }
                options={[
                  { value: 'wikilink', label: t('linkStyleWikilink') },
                  { value: 'markdown', label: t('linkStyleMarkdown') },
                ]}
                className="sm:max-w-xs"
              />
            )}
          </Field>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={closeExportDialog}>
          {t('cancel')}
        </Button>
        <Button variant="primary" onClick={() => void run()} disabled={!option || !allowed.length}>
          {format === 'pdf' ? t('exportPdfAction') : t('exportAction')}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The export dialog: format, scope and options, progress, then the download. */
export default function ExportDialog() {
  const open = useImportExportState((state) => state.exportOpen);
  const session = useImportExportState((state) => state.exportSession);
  const pageId = useImportExportState((state) => state.exportPageId);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closeExportDialog())}>
      <DialogContent size="lg" data-testid="export-dialog">
        {open ? <ExportForm key={session} pageId={pageId} /> : null}
      </DialogContent>
    </Dialog>
  );
}
