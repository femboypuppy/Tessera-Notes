/**
 * @tessera/plugin-api — the SDK for writing Tessera plugins.
 *
 * A plugin is an ES module whose default export is `definePlugin({ … })`. Tessera runs it in a
 * sandbox: `activate` in a background worker, panels and blocks in their own frames. The only way
 * out is the `api` object, checked against the permissions the user granted.
 *
 * @example
 * import { definePlugin } from '@tessera/plugin-api';
 *
 * export default definePlugin({
 *   activate(api) {
 *     api.commands.register({ id: 'hello', title: 'Say hello', run: () => api.ui.notify('Hello!') });
 *   },
 * });
 */
import type {
  BlockRenderer,
  JsonValue,
  PluginDefinition,
  RenderFunctions,
  SettingsSchema,
} from './types';

export * from './types';
export * from './permissions';
export * from './errors';

/** Marks a plugin module's default export, so the host can recognize it. */
export const PLUGIN_DEFINITION_MARKER = '__tesseraPlugin';

/** What {@link definePlugin} returns: the definition, marked for the host. */
export type DefinedPlugin<S extends SettingsSchema = SettingsSchema> = PluginDefinition<S> & {
  readonly [PLUGIN_DEFINITION_MARKER]: 1;
};

/**
 * Defines a plugin. Export the result as the module's default export.
 *
 * @example
 * export default definePlugin({
 *   settings: { greeting: { type: 'string', label: 'Greeting', default: 'Hello' } },
 *   activate(api) {
 *     api.commands.register({
 *       id: 'greet',
 *       title: 'Greet me',
 *       run: () => api.ui.notify(api.settings.get('greeting')),
 *     });
 *   },
 * });
 */
export function definePlugin<const S extends SettingsSchema = SettingsSchema>(
  definition: PluginDefinition<S>,
): DefinedPlugin<S> {
  return { ...definition, [PLUGIN_DEFINITION_MARKER]: 1 };
}

/**
 * Types a block renderer's data. The host stores whatever JSON the block saved, so check it
 * before trusting it.
 *
 * @example
 * blocks: {
 *   diagram: defineBlock<{ code: string }>((ctx) => {
 *     ctx.root.textContent = ctx.data?.code ?? '';
 *   }),
 * }
 */
export function defineBlock<T extends JsonValue, S extends SettingsSchema = SettingsSchema>(
  render: BlockRenderer<T, S>,
): BlockRenderer<JsonValue, S> {
  // Block data is untrusted JSON at runtime; the type parameter only documents what the plugin
  // writes, so widening it here is sound as long as the renderer validates what it reads.
  return render as unknown as BlockRenderer<JsonValue, S>;
}

/** Marks a renderer module's default export, so the host can recognize it. */
export const RENDERER_DEFINITION_MARKER = '__tesseraRenderer';

/** What {@link defineRenderer} returns: the render functions, marked for the host. */
export interface DefinedRenderer<R extends RenderFunctions = RenderFunctions> {
  readonly [RENDERER_DEFINITION_MARKER]: 1;
  readonly renderers: R;
}

/**
 * Defines a plugin's renderer: the default export of the module the manifest names as
 * `renderer` (plugin API 2). Put heavy drawing code there, such as a diagram or chart library:
 * Tessera loads it once, in a hidden frame, when a panel or block first calls
 * `api.ui.render(name, input)`, and closes the frame after two minutes without calls. Keep the
 * library out of the main module, so panels and blocks stay light.
 *
 * @example
 * // renderer.ts, built into renderer.js next to main.js
 * export default defineRenderer({
 *   async diagram(input: { code: string }) {
 *     const { svg } = await library.render(input.code);
 *     return { svg };
 *   },
 * });
 */
export function defineRenderer<const R extends RenderFunctions>(renderers: R): DefinedRenderer<R> {
  return { [RENDERER_DEFINITION_MARKER]: 1, renderers };
}

/** True when `value` looks like a renderer module's `defineRenderer` export. */
export function isRendererDefinition(value: unknown): value is DefinedRenderer {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const renderers = candidate.renderers;
  return (
    candidate[RENDERER_DEFINITION_MARKER] === 1 &&
    typeof renderers === 'object' &&
    renderers !== null &&
    Object.values(renderers).every((item) => typeof item === 'function')
  );
}

/** True when `value` looks like a module's `definePlugin` export. */
export function isPluginDefinition(value: unknown): value is DefinedPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const optionalFunction = (key: string) =>
    candidate[key] === undefined || typeof candidate[key] === 'function';
  const optionalRecord = (key: string) =>
    candidate[key] === undefined ||
    (typeof candidate[key] === 'object' &&
      candidate[key] !== null &&
      Object.values(candidate[key]).every((item) => typeof item === 'function'));
  return (
    candidate[PLUGIN_DEFINITION_MARKER] === 1 &&
    optionalFunction('activate') &&
    optionalFunction('deactivate') &&
    optionalRecord('panels') &&
    optionalRecord('blocks')
  );
}
