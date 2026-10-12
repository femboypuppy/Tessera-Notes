import { toError } from '@tessera/core';
import { useAppContext } from '@tessera/core/react';
import { Button, Separator } from '@tessera/ui';
import { Archive, ArchiveRestore, FileDown, FileText, Gem, NotebookText } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { EXPORTER_IDS } from '../exporters';
import { SingleFileSink } from '../export/zip-sink';
import { t } from '../i18n';
import { IMPORTER_IDS } from '../importers';
import { basename } from '../paths';
import { blobPart } from './download';
import { exportContextFor } from './jobs';
import { openExportDialog, openImportDialog } from './store';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <p className="mt-0.5 max-w-prose text-ui text-fg-muted">{description}</p>
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

/** Settings → Import & export: start imports, export the workspace, back up and restore. */
export default function SettingsPanel() {
  const ctx = useAppContext();
  const [backingUp, setBackingUp] = useState(false);
  const backup = ctx.exporters.get(EXPORTER_IDS.backup);

  const downloadBackup = async () => {
    if (!backup) return;
    setBackingUp(true);
    try {
      const sink = new SingleFileSink();
      await backup.run(
        { kind: 'workspace' },
        exportContextFor(ctx),
        sink,
        () => undefined,
        new AbortController().signal,
      );
      if (!sink.name || sink.data === null) throw new Error(t('exportFailedTitle'));
      const data = typeof sink.data === 'string' ? sink.data : blobPart(sink.data);
      const saved = await ctx.services.fileSaver.save({
        name: basename(sink.name),
        data: new Blob([data], { type: 'application/json' }),
      });
      if (saved?.path)
        ctx.toast({ variant: 'success', title: t('backupSaved', { path: saved.path }) });
    } catch (error) {
      ctx.toast({
        title: t('exportFailedTitle'),
        description: toError(error).message,
        variant: 'error',
      });
    } finally {
      setBackingUp(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <Section title={t('settingsImportTitle')} description={t('settingsImportHint')}>
        <Button onClick={() => openImportDialog(IMPORTER_IDS.notion)}>
          <NotebookText aria-hidden="true" />
          {t('onboardingNotionTitle')}
        </Button>
        <Button onClick={() => openImportDialog(IMPORTER_IDS.obsidian)}>
          <Gem aria-hidden="true" />
          {t('onboardingObsidianTitle')}
        </Button>
        <Button onClick={() => openImportDialog(IMPORTER_IDS.markdown)}>
          <FileText aria-hidden="true" />
          {t('onboardingMarkdownTitle')}
        </Button>
      </Section>
      <Separator />
      <Section title={t('settingsExportTitle')} description={t('settingsExportHint')}>
        <Button onClick={() => openExportDialog(null)}>
          <FileDown aria-hidden="true" />
          {t('exportWorkspaceMarkdown')}
        </Button>
      </Section>
      <Separator />
      <Section title={t('settingsBackupTitle')} description={t('settingsBackupHint')}>
        {backup ? (
          <Button onClick={() => void downloadBackup()} loading={backingUp}>
            <Archive aria-hidden="true" />
            {ctx.services.fileSaver.mode === 'dialog' ? t('saveBackup') : t('downloadBackup')}
          </Button>
        ) : null}
        <Button onClick={() => openImportDialog(IMPORTER_IDS.backup)}>
          <ArchiveRestore aria-hidden="true" />
          {t('restoreBackup')}
        </Button>
      </Section>
    </div>
  );
}
