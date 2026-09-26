import type { PluginPermission } from '@tessera/core';
import { useAppContext } from '@tessera/core/react';
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
  Input,
  Spinner,
} from '@tessera/ui';
import { ShieldCheck } from 'lucide-react';
import { useCallback, useState, type FormEvent } from 'react';
import {
  bundleFromFiles,
  bundleFromUrl,
  bundleFromZip,
  parseInstallUrl,
  type PluginBundle,
} from '../../bundle';
import { DEFAULT_REGISTRY_URL } from '../../constants';
import { t } from '../../i18n';
import type { InstallPlan, PluginManager } from '../../manager';
import { sortPermissionsByRisk } from '../../manifest';
import { downloadRegistryPlugin, type RegistryEntry } from '../../registry';
import type { PluginSource } from '../../store/types';
import { PermissionSummary, PluginIcon } from './parts';
import { pickFolder, pickZipFile } from './pickers';

type InstallState =
  | { step: 'idle' }
  | { step: 'loading'; label: string }
  | { step: 'prompt'; plan: InstallPlan; source: PluginSource }
  | { step: 'error'; message: string };

/** Starts installs from every source and renders the dialogs they need. */
export interface Installer {
  fromFile(): void;
  fromFolder(): void;
  openUrlDialog(): void;
  openDevDialog(): void;
  fromRegistry(entry: RegistryEntry, registryUrl: string): void;
  /** The registry entry being downloaded right now. */
  pendingId: string | null;
  element: React.ReactElement;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The install flow shared by every source: read the bundle, show the permission prompt, install.
 * `onInstalled` receives the plugin ID (the settings page opens its details).
 */
export function useInstaller(
  manager: PluginManager | null,
  onInstalled: (id: string) => void,
): Installer {
  const ctx = useAppContext();
  const [state, setState] = useState<InstallState>({ step: 'idle' });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [urlDialog, setUrlDialog] = useState<'url' | 'dev' | null>(null);

  const load = useCallback(
    async (label: string, source: PluginSource, read: () => Promise<PluginBundle | null>) => {
      if (!manager) return;
      setState({ step: 'loading', label });
      try {
        const bundle = await read();
        if (!bundle) {
          setState({ step: 'idle' });
          return;
        }
        setState({ step: 'prompt', plan: manager.plan(bundle), source });
      } catch (error) {
        setState({ step: 'error', message: errorText(error) });
      }
    },
    [manager],
  );

  const confirm = async (plan: InstallPlan, source: PluginSource) => {
    if (!manager) return;
    const previous = plan.existing;
    // Updates keep what the user decided before and add what they just approved.
    const granted: PluginPermission[] = previous
      ? [...previous.granted.filter((p) => plan.requested.includes(p)), ...plan.added]
      : plan.requested;
    try {
      const installed = await manager.install(plan.bundle, { granted, source });
      setState({ step: 'idle' });
      ctx.toast({
        title: t(previous ? 'updatedToast' : 'installedToast', { plugin: installed.manifest.name }),
        variant: 'success',
      });
      onInstalled(installed.id);
    } catch (error) {
      setState({ step: 'error', message: errorText(error) });
    }
  };

  const installer: Installer = {
    fromFile() {
      void (async () => {
        const file = await pickZipFile();
        if (!file) return;
        await load(t('readingPlugin'), { kind: 'file', name: file.name }, async () =>
          bundleFromZip(file.bytes),
        );
      })().catch((error: unknown) => setState({ step: 'error', message: errorText(error) }));
    },
    fromFolder() {
      void (async () => {
        const folder = await pickFolder();
        if (!folder) return;
        await load(t('readingPlugin'), { kind: 'folder', name: folder.name }, async () =>
          bundleFromFiles(folder.files),
        );
      })().catch((error: unknown) => setState({ step: 'error', message: errorText(error) }));
    },
    openUrlDialog: () => setUrlDialog('url'),
    openDevDialog: () => setUrlDialog('dev'),
    fromRegistry(entry, registryUrl) {
      setPendingId(entry.id);
      // The default registry publishes a checksum for every zip, so none may be missing there.
      void load(t('readingPlugin'), { kind: 'registry', url: entry.download, registryUrl }, () =>
        downloadRegistryPlugin(entry, { requireChecksum: registryUrl === DEFAULT_REGISTRY_URL }),
      ).finally(() => setPendingId(null));
    },
    pendingId,
    element: (
      <>
        <UrlDialog
          mode={urlDialog}
          onClose={() => setUrlDialog(null)}
          onSubmit={(url, mode) => {
            setUrlDialog(null);
            void load(
              t('readingPlugin'),
              mode === 'dev' ? { kind: 'dev', url } : { kind: 'url', url },
              () => bundleFromUrl(url),
            );
          }}
        />
        <Dialog
          open={state.step === 'loading' || state.step === 'error'}
          onOpenChange={(open) => {
            if (!open) setState({ step: 'idle' });
          }}
        >
          <DialogContent size="sm" showClose={state.step === 'error'}>
            {state.step === 'loading' ? (
              <DialogHeader className="flex-row items-center gap-3 pb-5">
                <Spinner />
                <DialogTitle>{state.label}</DialogTitle>
                <DialogDescription className="sr-only">{state.label}</DialogDescription>
              </DialogHeader>
            ) : state.step === 'error' ? (
              <>
                <DialogHeader>
                  <DialogTitle>{t('installFailed')}</DialogTitle>
                  <DialogDescription>{state.message}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button onClick={() => setState({ step: 'idle' })}>{t('cancel')}</Button>
                </DialogFooter>
              </>
            ) : null}
          </DialogContent>
        </Dialog>
        {state.step === 'prompt' ? (
          <PermissionPrompt
            plan={state.plan}
            source={state.source}
            onCancel={() => setState({ step: 'idle' })}
            onConfirm={() => void confirm(state.plan, state.source)}
          />
        ) : null}
      </>
    ),
  };
  return installer;
}

function describeSource(source: PluginSource): string {
  switch (source.kind) {
    case 'file':
      return t('sourceFile', { name: source.name ?? '' });
    case 'folder':
      return t('sourceFolder', { name: source.name ?? '' });
    case 'registry':
      return t('sourceRegistry');
    case 'dev':
      return t('sourceDev', { url: source.url ?? '' });
    case 'url':
      return t('sourceUrl', { url: source.url ?? '' });
  }
}

/** Asks the user to approve a plugin's permissions, in plain language. */
export function PermissionPrompt({
  plan,
  source,
  onCancel,
  onConfirm,
}: {
  plan: InstallPlan;
  source: PluginSource;
  onCancel(): void;
  onConfirm(): void;
}) {
  const [busy, setBusy] = useState(false);
  const { manifest } = plan.bundle;
  const title =
    plan.kind === 'install'
      ? t('promptInstallTitle', { plugin: manifest.name })
      : plan.kind === 'update'
        ? t('promptUpdateTitle', { plugin: manifest.name, version: manifest.version })
        : plan.kind === 'downgrade'
          ? t('promptDowngradeTitle', { plugin: manifest.name, version: manifest.version })
          : t('promptReinstallTitle', { plugin: manifest.name, version: manifest.version });
  const added = new Set(plan.added);
  const shown = sortPermissionsByRisk(plan.requested);
  const network = plan.requested.some((permission) => permission.startsWith('network:'));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent size="md" aria-describedby="plugin-prompt-description">
        <DialogHeader className="flex-row items-start gap-3.5">
          <PluginIcon icon={manifest.icon} size="lg" />
          <div className="min-w-0 flex-1">
            <DialogTitle className="break-words">{title}</DialogTitle>
            <p className="mt-0.5 text-ui text-fg-muted">
              {t('version', { version: manifest.version })} ·{' '}
              {t('byAuthor', { author: manifest.author })}
            </p>
            <p className="mt-0.5 truncate text-xs text-fg-subtle">
              {t('promptFrom', { source: describeSource(source) })}
            </p>
          </div>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-1">
          {manifest.description ? (
            <p id="plugin-prompt-description" className="text-sm text-fg">
              {manifest.description}
            </p>
          ) : (
            <span id="plugin-prompt-description" className="sr-only">
              {title}
            </span>
          )}
          {shown.length ? (
            <section aria-labelledby="plugin-prompt-permissions">
              <h3
                id="plugin-prompt-permissions"
                className="mb-2.5 text-ui font-medium text-fg-muted"
              >
                {t('promptCanDo')}
              </h3>
              <ul className="flex flex-col gap-3" data-testid="permission-list">
                {shown.map((permission) => (
                  <li key={permission}>
                    <PermissionSummary
                      permission={permission}
                      badge={
                        plan.kind !== 'install' && added.has(permission) ? t('newBadge') : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <Callout tone="success">{t('promptNoPermissions')}</Callout>
          )}
          {network ? (
            <Callout tone="warning">
              {t('promptNetworkWarning', { author: manifest.author })}
            </Callout>
          ) : null}
          <p className="flex items-start gap-2 text-xs text-fg-muted">
            <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {t('promptSandboxNote')}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onCancel}>{t('cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              setBusy(true);
              onConfirm();
            }}
          >
            {plan.kind === 'install' ? t('install') : t('update')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DEFAULT_DEV_URL = 'http://localhost:5199/';

function UrlDialog({
  mode,
  onClose,
  onSubmit,
}: {
  mode: 'url' | 'dev' | null;
  onClose(): void;
  onSubmit(url: string, mode: 'url' | 'dev'): void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dev = mode === 'dev';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = parseInstallUrl(value || (dev ? DEFAULT_DEV_URL : ''));
    if (!url || !mode) {
      setError(t('invalidUrl'));
      return;
    }
    setError(null);
    setValue('');
    onSubmit(url.href, mode);
  };
  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent size="md">
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>{dev ? t('devDialogTitle') : t('urlDialogTitle')}</DialogTitle>
            <DialogDescription>{dev ? t('devDialogText') : t('urlDialogText')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label={dev ? t('devUrlLabel') : t('urlLabel')} error={error ?? undefined}>
              {(props) => (
                <Input
                  {...props}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={dev ? DEFAULT_DEV_URL : t('urlPlaceholder')}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" variant="primary">
              {dev ? t('connect') : t('continue')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
