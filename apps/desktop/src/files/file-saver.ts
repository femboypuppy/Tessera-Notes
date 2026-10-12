import type { FileSaver, FileToSave, SavedFile } from '@tessera/core';
import type { DesktopBackend } from '../backend/backend';
import { t } from '../i18n';

/** The extension of a file name (`zip` for `Notes.zip`), when it has a short, plain one. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1);
  return extension.length <= 10 && /^[A-Za-z0-9]+$/.test(extension) ? extension : null;
}

/**
 * Exports in the desktop app. Webviews ignore `<a download>` (and WKWebView `window.print()`), so
 * files go through the native save dialog and are written by the Rust side (`file_save`), and
 * printing uses the webview's native print (`window_print`). The desktop feature registers it as
 * the `fileSaver` service (priority 100).
 */
export class TauriFileSaver implements FileSaver {
  readonly mode = 'dialog';

  constructor(private readonly backend: DesktopBackend) {}

  async save({ name, data }: FileToSave): Promise<SavedFile | null> {
    const bytes = new Uint8Array(await data.arrayBuffer());
    const extension = extensionOf(name);
    return this.backend.saveFile(bytes, {
      name,
      title: t('saveDialogTitle'),
      filter: extension ? t('saveFileFilter', { extension: extension.toUpperCase() }) : null,
    });
  }

  print(): Promise<void> {
    return this.backend.print();
  }
}
