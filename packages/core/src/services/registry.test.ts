import { describe, expect, it, vi } from 'vitest';
import { BasicMarkdownCodec } from './markdown-codec';
import {
  defineService,
  disposeService,
  resolveService,
  SERVICE_PHASES,
  SERVICE_PRIORITY,
  type AnyServiceRegistration,
  type AppServiceContext,
  type ServiceMap,
} from './registry';
import { MemorySettingsStore } from '../runtime/settings';

const context: AppServiceContext = {
  platform: { os: 'linux', isApple: false, isDesktopApp: false, isTouch: false },
  settings: new MemorySettingsStore(),
};

class NamedCodec extends BasicMarkdownCodec {
  constructor(readonly name: string) {
    super();
  }
}

const codec = (id: string, priority: number, extra: Partial<AnyServiceRegistration> = {}) =>
  ({
    ...defineService({ provides: 'markdownCodec', id, priority, create: () => new NamedCodec(id) }),
    ...extra,
  }) as AnyServiceRegistration;

const fallback = { id: 'fallback', create: () => new NamedCodec('fallback') };
const nameOf = (service: ServiceMap['markdownCodec']) => (service as NamedCodec).name;

describe('resolveService', () => {
  it('picks the highest priority available registration', async () => {
    const result = await resolveService(
      'markdownCodec',
      [
        codec('memory-plugin', SERVICE_PRIORITY.memory),
        codec('desktop', SERVICE_PRIORITY.desktop),
        codec('browser', SERVICE_PRIORITY.browser),
      ],
      context,
      fallback,
    );
    expect(result.source).toBe('desktop');
    expect(nameOf(result.service)).toBe('desktop');
    expect(result.priority).toBe(100);
    expect(result.attempts.map((a) => [a.id, a.outcome])).toEqual([
      ['desktop', 'selected'],
      ['browser', 'not-tried'],
      ['memory-plugin', 'not-tried'],
    ]);
  });

  it('skips unavailable registrations (sync, async and throwing checks)', async () => {
    const onError = vi.fn();
    const result = await resolveService(
      'markdownCodec',
      [
        codec('desktop', 100, { isAvailable: () => false }),
        codec('broken-check', 90, {
          isAvailable: () => {
            throw new Error('no tauri');
          },
        }),
        codec('async-no', 80, { isAvailable: async () => false }),
        codec('browser', 50, { isAvailable: async () => true }),
      ],
      context,
      fallback,
      { onError },
    );
    expect(result.source).toBe('browser');
    expect(result.attempts.map((a) => a.outcome)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
      'selected',
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('falls through when create throws, then to the fallback', async () => {
    const onError = vi.fn();
    const failing = codec('failing', 50, {
      create: () => {
        throw new Error('IndexedDB blocked');
      },
    });
    const result = await resolveService('markdownCodec', [failing], context, fallback, { onError });
    expect(result.source).toBe('fallback');
    expect(result.priority).toBe(0);
    expect(nameOf(result.service)).toBe('fallback');
    expect(result.attempts).toEqual([
      { id: 'failing', priority: 50, outcome: 'failed', error: 'IndexedDB blocked' },
      { id: 'fallback', priority: 0, outcome: 'selected' },
    ]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      id: 'failing',
      provides: 'markdownCodec',
    });
  });

  it('uses the fallback when nothing is registered and ignores other services', async () => {
    const other = defineService({
      provides: 'workspaceRegistry',
      id: 'other',
      priority: 100,
      create: () => {
        throw new Error('must not be called');
      },
    }) as AnyServiceRegistration;
    const result = await resolveService('markdownCodec', [other], context, fallback);
    expect(result.source).toBe('fallback');
  });

  it('keeps registration order for equal priorities and supports async create', async () => {
    const result = await resolveService(
      'markdownCodec',
      [codec('first', 50, { create: async () => new NamedCodec('first') }), codec('second', 50)],
      context,
      fallback,
    );
    expect(result.source).toBe('first');
  });

  it('documents the phase of every service', () => {
    expect(SERVICE_PHASES).toEqual({
      workspaceRegistry: 'app',
      markdownCodec: 'app',
      credentialStore: 'app',
      fileSaver: 'app',
      docStore: 'storage',
      assetStore: 'storage',
      syncProvider: 'storage',
      searchIndex: 'index',
      linkIndex: 'index',
    });
    expect(SERVICE_PRIORITY).toEqual({ memory: 0, browser: 50, desktop: 100 });
  });
});

describe('disposeService', () => {
  it('calls dispose when present and reports errors', async () => {
    const dispose = vi.fn();
    await disposeService({ dispose });
    expect(dispose).toHaveBeenCalledTimes(1);
    const onError = vi.fn();
    await disposeService(
      {
        dispose: () => {
          throw new Error('boom');
        },
      },
      onError,
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    await disposeService(null);
    await disposeService({});
  });
});
