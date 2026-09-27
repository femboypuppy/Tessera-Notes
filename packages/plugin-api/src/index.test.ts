import {
  PLUGIN_API_VERSION as CORE_API_VERSION,
  PLUGIN_BLOCK_TYPE_PATTERN,
  PLUGIN_ID_PATTERN as CORE_ID_PATTERN,
  PLUGIN_PERMISSIONS as CORE_PERMISSIONS,
} from '@tessera/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  defineBlock,
  definePlugin,
  defineRenderer,
  isPluginDefinition,
  isRendererDefinition,
  isPluginError,
  PLUGIN_API_VERSION,
  PLUGIN_DEFINITION_MARKER,
  PLUGIN_ID_PATTERN,
  PLUGIN_ITEM_ID_PATTERN,
  PLUGIN_PERMISSIONS,
  PluginError,
  RENDERER_DEFINITION_MARKER,
  type PluginApi,
} from './index';

describe('the SDK stays in step with @tessera/core', () => {
  // The SDK is published on its own, so it copies these instead of importing core.
  it('declares the same API version, permissions and ID patterns', () => {
    expect(PLUGIN_API_VERSION).toBe(CORE_API_VERSION);
    expect([...PLUGIN_PERMISSIONS]).toEqual([...CORE_PERMISSIONS]);
    expect(PLUGIN_ID_PATTERN.source).toBe(CORE_ID_PATTERN.source);
    expect(PLUGIN_ITEM_ID_PATTERN.source).toBe(PLUGIN_BLOCK_TYPE_PATTERN.source);
  });
});

describe('definePlugin', () => {
  it('marks the definition and keeps every field', () => {
    const activate = () => undefined;
    const render = () => undefined;
    const plugin = definePlugin({ activate, panels: { count: render } });
    expect(plugin[PLUGIN_DEFINITION_MARKER]).toBe(1);
    expect(plugin.activate).toBe(activate);
    expect(plugin.panels?.count).toBe(render);
    expect(isPluginDefinition(plugin)).toBe(true);
  });

  it('types settings from the schema', () => {
    definePlugin({
      settings: {
        format: { type: 'string', label: 'Format', default: 'YYYY-MM-DD' },
        minutes: { type: 'number', label: 'Minutes', default: 25 },
        auto: { type: 'boolean', label: 'Auto', default: false },
        mode: {
          type: 'select',
          label: 'Mode',
          default: 'a',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
      },
      activate(api) {
        expectTypeOf(api.settings.get('format')).toEqualTypeOf<string>();
        expectTypeOf(api.settings.get('minutes')).toEqualTypeOf<number>();
        expectTypeOf(api.settings.get('auto')).toEqualTypeOf<boolean>();
        expectTypeOf(api.settings.get('mode')).toEqualTypeOf<'a' | 'b'>();
        expectTypeOf(api).toMatchTypeOf<PluginApi>();
      },
    });
  });

  it('types settings from the schema alone, next to typed panels and blocks', () => {
    // Renderers built with defineBlock carry the default schema; they must not widen `S`.
    const plugin = definePlugin({
      settings: { greeting: { type: 'string', label: 'Greeting', default: 'Hello' } },
      activate(api) {
        expectTypeOf(api.settings.get('greeting')).toEqualTypeOf<string>();
      },
      panels: { side: () => undefined },
      blocks: { counter: defineBlock<{ count: number }>(() => undefined) },
    });
    expect(isPluginDefinition(plugin)).toBe(true);
  });

  it('types block data with defineBlock', () => {
    const renderer = defineBlock<{ code: string }>((ctx) => {
      expectTypeOf(ctx.data).toEqualTypeOf<{ code: string } | null>();
    });
    expect(isPluginDefinition(definePlugin({ blocks: { diagram: renderer } }))).toBe(true);
  });
});

describe('isPluginDefinition', () => {
  it.each([
    ['null', null],
    ['a function', () => undefined],
    ['an unmarked object', { activate: () => undefined }],
    ['a non-function activate', { [PLUGIN_DEFINITION_MARKER]: 1, activate: 'run' }],
    ['a panel that is not a function', { [PLUGIN_DEFINITION_MARKER]: 1, panels: { a: 1 } }],
    ['blocks that are not an object', { [PLUGIN_DEFINITION_MARKER]: 1, blocks: 'x' }],
  ])('rejects %s', (_label, value) => {
    expect(isPluginDefinition(value)).toBe(false);
  });
});

describe('defineRenderer', () => {
  it('marks the render functions and keeps their types', async () => {
    const renderer = defineRenderer({
      diagram: async (input: { code: string }) => ({ svg: `<svg>${input.code}</svg>` }),
      size: () => 3,
    });
    expect(renderer[RENDERER_DEFINITION_MARKER]).toBe(1);
    expect(isRendererDefinition(renderer)).toBe(true);
    await expect(renderer.renderers.diagram({ code: 'A' })).resolves.toEqual({
      svg: '<svg>A</svg>',
    });
    expectTypeOf(renderer.renderers.diagram).parameter(0).toEqualTypeOf<{ code: string }>();
    expectTypeOf(renderer.renderers.size).returns.toEqualTypeOf<number>();
  });

  it.each([
    ['null', null],
    ['an unmarked object', { renderers: { a: () => 1 } }],
    ['no functions', { [RENDERER_DEFINITION_MARKER]: 1 }],
    ['a function that is not one', { [RENDERER_DEFINITION_MARKER]: 1, renderers: { a: 1 } }],
    ['a plugin definition', definePlugin({ activate: () => undefined })],
  ])('isRendererDefinition rejects %s', (_label, value) => {
    expect(isRendererDefinition(value)).toBe(false);
  });
});

describe('PluginError', () => {
  it('carries a code and the missing permission', () => {
    const error = new PluginError('permission_denied', 'No access', 'pages:read');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('permission_denied');
    expect(error.permission).toBe('pages:read');
    expect(error.message).toBe('No access');
  });

  it('recognizes errors built by the sandbox runtime (another realm or bundle)', () => {
    const foreign = Object.assign(new Error('Nope'), { name: 'PluginError', code: 'not_found' });
    expect(foreign instanceof PluginError).toBe(true);
    expect(isPluginError(foreign)).toBe(true);
    const unrelated = Object.assign(new Error('x'), { name: 'PluginError', code: 'weird' });
    expect(unrelated instanceof PluginError).toBe(false);
    expect(new TypeError('x') instanceof PluginError).toBe(false);
  });
});
