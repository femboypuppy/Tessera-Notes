import type { FileSaver } from '@tessera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDesktopRuntime } from '../runtime';
import { fakeTauri, installFakeTauri, uninstallFakeTauri } from '../testing/fake-tauri';

/** The desktop feature's `fileSaver` service, created like the runtime does. */
async function desktopFileSaver(): Promise<FileSaver> {
  const { createDesktopFeature } = await import('../index');
  const service = createDesktopFeature().services?.find((entry) => entry.provides === 'fileSaver');
  expect(service).toMatchObject({ id: 'native-dialog', priority: 100 });
  return (await service?.create({} as never)) as FileSaver;
}

const decode = (base64: string | undefined) =>
  new TextDecoder().decode(Uint8Array.from(atob(base64 ?? ''), (c) => c.charCodeAt(0)));

describe('saving and printing exports in the desktop app', () => {
  beforeEach(() => installFakeTauri({ os: 'windows', home: 'C:/Users/ada' }));
  afterEach(() => {
    resetDesktopRuntime();
    uninstallFakeTauri();
  });

  it('asks where to save with the native dialog and writes the file there', async () => {
    const saver = await desktopFileSaver();
    expect(saver.mode).toBe('dialog');
    fakeTauri().queueSave('C:/Users/ada/Documents/Launch plan.md');
    const saved = await saver.save({
      name: 'Launch plan.md',
      data: new Blob(['# Launch plan\n\nT-minus 10 ✓\n'], { type: 'text/markdown' }),
    });
    expect(saved).toEqual({
      name: 'Launch plan.md',
      path: 'C:/Users/ada/Documents/Launch plan.md',
    });
    const { saveDialogs, savedFiles } = fakeTauri().state;
    expect(saveDialogs).toEqual([{ title: 'Save as', name: 'Launch plan.md', filter: 'MD file' }]);
    expect(decode(savedFiles['C:/Users/ada/Documents/Launch plan.md'])).toBe(
      '# Launch plan\n\nT-minus 10 ✓\n',
    );
  });

  it('writes binary files byte for byte', async () => {
    const saver = await desktopFileSaver();
    fakeTauri().queueSave('D:/Backups/Library.zip');
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 255, 128]);
    await saver.save({ name: 'Library.zip', data: new Blob([bytes]) });
    const written = Uint8Array.from(atob(fakeTauri().state.savedFiles['D:/Backups/Library.zip'] ?? ''), (c) =>
      c.charCodeAt(0),
    );
    expect([...written]).toEqual([...bytes]);
    expect(fakeTauri().state.saveDialogs[0]?.filter).toBe('ZIP file');
  });

  it('returns null and writes nothing when the dialog is cancelled', async () => {
    const saver = await desktopFileSaver();
    fakeTauri().queueSave(null);
    expect(await saver.save({ name: 'Notes', data: new Blob(['x']) })).toBeNull();
    expect(fakeTauri().state.savedFiles).toEqual({});
    // No extension: no file-type filter.
    expect(fakeTauri().state.saveDialogs[0]?.filter).toBeNull();
  });

  it('prints through the webview, not window.print()', async () => {
    const saver = await desktopFileSaver();
    let browserPrints = 0;
    const original = window.print;
    window.print = () => {
      browserPrints += 1;
    };
    try {
      await saver.print();
    } finally {
      window.print = original;
    }
    expect(fakeTauri().state.printed).toBe(1);
    expect(browserPrints).toBe(0);
  });
});
