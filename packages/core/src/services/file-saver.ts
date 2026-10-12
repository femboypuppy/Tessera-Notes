/** A file the user exports. */
export interface FileToSave {
  /** The suggested file name, with its extension (`Library.zip`). */
  name: string;
  data: Blob;
}

/** Where a saved file went. */
export interface SavedFile {
  /** The file's name (the user may have changed it in a save dialog). */
  name: string;
  /** Its full path when the platform knows it (the desktop app), null for browser downloads. */
  path: string | null;
}

/**
 * Where exports go: the files the user saves, and printing (where "Save as PDF" lives). Browsers
 * download through a link and print with `window.print()` (the stub, priority 0). The desktop app
 * asks where to save with the native save dialog, writes the file itself and prints through the
 * webview's native print (`@tessera/desktop`, priority 100): webviews ignore downloads, and
 * WKWebView ignores `window.print()`.
 *
 * @example
 * const saved = await ctx.services.fileSaver.save({ name: 'Notes.zip', data: blob });
 * if (saved === null) return; // the user cancelled the save dialog
 */
export interface FileSaver {
  /** `download`: files go to the browser's downloads. `dialog`: a save dialog asks where. */
  readonly mode: 'download' | 'dialog';
  /** Saves a file. Null when the user cancelled the save dialog. */
  save(file: FileToSave): Promise<SavedFile | null>;
  /** Opens the system print dialog for the current page. */
  print(): Promise<void>;
}

/** The browser's {@link FileSaver} (priority 0): a download link, and `window.print()`. */
export class DownloadFileSaver implements FileSaver {
  readonly mode = 'download';

  async save({ name, data }: FileToSave): Promise<SavedFile> {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function')
      throw new Error('Files can only be downloaded in a browser');
    const url = URL.createObjectURL(data);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    // Some browsers read the URL after `click` returns, so it is revoked a little later.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { name, path: null };
  }

  async print(): Promise<void> {
    window.print();
  }
}
