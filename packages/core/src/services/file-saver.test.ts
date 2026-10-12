// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadFileSaver } from './file-saver';

describe('DownloadFileSaver', () => {
  afterEach(() => vi.restoreAllMocks());

  it('downloads through a temporary link and revokes its URL later', async () => {
    vi.useFakeTimers();
    try {
      const blob = new Blob(['# Notes\n'], { type: 'text/markdown' });
      const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:notes');
      const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
      const links: Array<{ href: string; download: string; attached: boolean }> = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        links.push({ href: this.href, download: this.download, attached: this.isConnected });
      });
      const saver = new DownloadFileSaver();
      expect(saver.mode).toBe('download');
      expect(await saver.save({ name: 'Notes.md', data: blob })).toEqual({
        name: 'Notes.md',
        path: null,
      });
      expect(created).toHaveBeenCalledWith(blob);
      expect(links).toEqual([{ href: 'blob:notes', download: 'Notes.md', attached: true }]);
      expect(document.querySelector('a[download]')).toBeNull();
      expect(revoked).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(revoked).toHaveBeenCalledWith('blob:notes');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prints with window.print()', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    await new DownloadFileSaver().print();
    expect(print).toHaveBeenCalledTimes(1);
  });
});
