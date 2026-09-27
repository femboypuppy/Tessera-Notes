import {
  ID_PATTERN,
  isJsonValue,
  isValidIcon,
  MAX_EMBED_DATA_BYTES,
  PLUGIN_BLOCK_TYPE_PATTERN,
  type JsonValue,
  type StaticPluginPermission,
} from '@tessera/core';
import type { PluginSurface, SettingsSchema } from '@tessera/plugin-api';
import {
  SETTING_KEY_PATTERN,
  MAX_SETTINGS,
  MAX_STRING_SETTING_LENGTH,
} from '@tessera/plugin-api/settings';
import { z } from 'zod';

/**
 * The wire protocol between the host and a plugin's sandbox (its worker, panels and blocks). Every
 * message carries `v: 1`. The host validates everything a plugin sends with these schemas; the
 * sandbox runtime trusts the host.
 *
 * Plugin → host: `request` (an API call), `response` (to a host request), `notify` (fire and forget:
 * ready, log, resize, error, rendered, unresponsive). Host → plugin: `request` (ping, activate,
 * deactivate, command.run), `response`, `event` (pages, storage, settings, theme, surface state).
 */
export const PROTOCOL_VERSION = 1;

const messageId = z
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1);

/** A request from a plugin. `params` is validated per method. */
export const requestEnvelope = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('request'),
    id: messageId,
    method: z.string().min(1).max(64),
    params: z.unknown().optional(),
  })
  .strict();

/** A plugin's answer to a host request. */
export const responseEnvelope = z.union([
  z
    .object({
      v: z.literal(PROTOCOL_VERSION),
      type: z.literal('response'),
      id: messageId,
      ok: z.literal(true),
      result: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(PROTOCOL_VERSION),
      type: z.literal('response'),
      id: messageId,
      ok: z.literal(false),
      error: z.object({ code: z.string().max(40), message: z.string().max(4_000) }).strict(),
    })
    .strict(),
]);

export const NOTIFY_METHODS = [
  'ready',
  'log',
  'resize',
  'error',
  'rendered',
  'unresponsive',
] as const;
export type NotifyMethod = (typeof NOTIFY_METHODS)[number];

/** A notification from a plugin. `params` is validated per method. */
export const notifyEnvelope = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('notify'),
    method: z.enum(NOTIFY_METHODS),
    params: z.unknown().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Shared value schemas
// ---------------------------------------------------------------------------------------------

const itemId = z
  .string()
  .max(64)
  .regex(PLUGIN_BLOCK_TYPE_PATTERN, 'IDs are lowercase words separated by -');
const entityId = z.string().regex(ID_PATTERN, 'Invalid ID');
const text = (max: number) => z.string().max(max);
const label = (max: number) => z.string().trim().min(1).max(max);
const emoji = z.string().refine(isValidIcon, 'Must be a single emoji');
const keywords = z.array(label(50)).max(20);

/** Any JSON value (sizes were bounded by the inspector already). */
export const jsonValueSchema = z.custom<JsonValue>((value) => isJsonValue(value), 'Must be JSON');

/** Block data: JSON of at most 64 KB. */
export const blockDataSchema = jsonValueSchema.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).length <= MAX_EMBED_DATA_BYTES,
  'Block data is limited to 64 KB of JSON',
);

/** A document tree; the host validates it against the canonical schema before writing. */
const docJson = z.custom<{ type: 'doc' } & Record<string, JsonValue>>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === 'doc' &&
    isJsonValue(value),
  'Must be a document ({ type: "doc", content: [...] })',
);
const content = z.union([z.string().max(2_000_000), docJson]);

const rowInput = z
  .object({
    title: text(2_000).optional(),
    values: z.record(z.string().min(1).max(200), jsonValueSchema.nullable()).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input.values ?? {}).length <= 200, 'Too many values');

const query = z
  .object({
    filters: z
      .array(
        z
          .object({
            property: label(200),
            operator: z.enum([
              'equals',
              'notEquals',
              'contains',
              'notContains',
              'greaterThan',
              'lessThan',
              'isEmpty',
              'isNotEmpty',
            ]),
            value: jsonValueSchema.optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    sorts: z
      .array(
        z
          .object({
            property: label(200),
            direction: z.enum(['ascending', 'descending']).optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    limit: z.number().int().min(0).max(1_000).optional(),
    offset: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();

const empty = z.object({}).strict().optional();

// ---------------------------------------------------------------------------------------------
// Settings schemas (declared by plugins, rendered by the host)
// ---------------------------------------------------------------------------------------------

const settingBase = { label: label(100), description: text(500).optional() };
const settingDefinition = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('string'),
      default: text(MAX_STRING_SETTING_LENGTH),
      placeholder: text(200).optional(),
      multiline: z.boolean().optional(),
      maxLength: z.number().int().min(1).max(MAX_STRING_SETTING_LENGTH).optional(),
      ...settingBase,
    })
    .strict()
    .refine((s) => s.default.length <= (s.maxLength ?? 1_000), 'The default is too long'),
  z
    .object({
      type: z.literal('number'),
      default: z.number().finite(),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
      step: z.number().finite().positive().optional(),
      unit: text(20).optional(),
      ...settingBase,
    })
    .strict()
    .refine(
      (s) =>
        (s.min === undefined || s.default >= s.min) && (s.max === undefined || s.default <= s.max),
      'The default is out of range',
    ),
  z.object({ type: z.literal('boolean'), default: z.boolean(), ...settingBase }).strict(),
  z
    .object({
      type: z.literal('select'),
      default: text(100),
      options: z
        .array(z.object({ value: label(100), label: label(100) }).strict())
        .min(1)
        .max(50),
      ...settingBase,
    })
    .strict()
    .refine((s) => s.options.some((o) => o.value === s.default), 'The default is not an option'),
]);

/** A plugin's settings declaration. */
export const settingsSchemaSchema = z
  .record(z.string().regex(SETTING_KEY_PATTERN, 'Setting keys are identifiers'), settingDefinition)
  .refine(
    (schema) => Object.keys(schema).length <= MAX_SETTINGS,
    `At most ${MAX_SETTINGS} settings`,
  )
  .transform((schema) => schema as SettingsSchema);

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

/** `ready` from the worker: what the module defines. */
export const workerReadySchema = z
  .object({
    panels: z.array(itemId).max(50),
    blocks: z.array(itemId).max(50),
    settings: settingsSchemaSchema.optional(),
    activate: z.boolean(),
  })
  .strict();

export const logSchema = z
  .object({
    level: z.enum(['debug', 'log', 'info', 'warn', 'error']),
    message: z.string().max(20_000),
  })
  .strict();

export const resizeSchema = z
  .object({ height: z.number().finite().min(0).max(1_000_000) })
  .strict();

export const errorSchema = z
  .object({
    message: z.string().max(20_000),
    stack: z.string().max(40_000).optional(),
    /** The plugin couldn't load or render at all. */
    fatal: z.boolean().optional(),
  })
  .strict();

/** `unresponsive` from a panel or block frame: its code ran this long without a break. */
export const unresponsiveSchema = z.object({ ms: z.number().finite().min(0).max(1e9) }).strict();

// ---------------------------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------------------------

interface MethodSpec<P extends z.ZodType> {
  params: P;
  /** Checked on every call against the permissions granted right now. */
  permission?: StaticPluginPermission;
  /** Where the method may be called from (default: everywhere). */
  surfaces?: readonly PluginSurface[];
}

const spec = <P extends z.ZodType>(value: MethodSpec<P>) => value;

/**
 * Every API method, its parameters, the permission it needs and where it may be called. The host
 * refuses anything not listed here.
 */
export const API_METHODS = {
  'commands.register': spec({
    params: z
      .object({
        id: itemId,
        title: label(200),
        keywords: keywords.optional(),
        shortcut: z.string().max(60).optional(),
      })
      .strict(),
    permission: 'ui:commands',
    surfaces: ['worker'],
  }),
  'commands.unregister': spec({
    params: z.object({ id: itemId }).strict(),
    permission: 'ui:commands',
    surfaces: ['worker'],
  }),
  'ui.addPanel': spec({
    params: z.object({ id: itemId, title: label(100), icon: emoji.optional() }).strict(),
    permission: 'ui:panels',
    surfaces: ['worker'],
  }),
  'ui.removePanel': spec({
    params: z.object({ id: itemId }).strict(),
    permission: 'ui:panels',
    surfaces: ['worker'],
  }),
  'ui.openPanel': spec({ params: z.object({ id: itemId }).strict(), permission: 'ui:panels' }),
  'ui.addBlock': spec({
    params: z
      .object({
        type: itemId,
        title: label(100),
        description: text(300).optional(),
        icon: emoji.optional(),
        keywords: keywords.optional(),
        initialData: blockDataSchema.optional(),
      })
      .strict(),
    permission: 'ui:blocks',
    surfaces: ['worker'],
  }),
  'ui.removeBlock': spec({
    params: z.object({ type: itemId }).strict(),
    permission: 'ui:blocks',
    surfaces: ['worker'],
  }),
  'ui.notify': spec({
    params: z
      .object({
        title: label(200),
        description: text(500).optional(),
        variant: z.enum(['default', 'success', 'warning', 'error']).optional(),
      })
      .strict(),
  }),
  'pages.list': spec({
    params: z
      .object({
        parentId: entityId.nullable().optional(),
        includeRows: z.boolean().optional(),
        includeTrashed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    permission: 'pages:read',
  }),
  'pages.get': spec({
    params: z.object({ id: entityId, format: z.enum(['markdown', 'doc']).optional() }).strict(),
    permission: 'pages:read',
  }),
  'pages.create': spec({
    params: z
      .object({
        title: text(2_000).optional(),
        parentId: entityId.nullable().optional(),
        icon: emoji.optional(),
        content: content.optional(),
      })
      .strict(),
    permission: 'pages:write',
  }),
  'pages.update': spec({
    params: z
      .object({
        id: entityId,
        title: text(2_000).optional(),
        icon: emoji.nullable().optional(),
        content: content.optional(),
      })
      .strict(),
    permission: 'pages:write',
  }),
  'pages.current': spec({ params: empty, permission: 'pages:read' }),
  'pages.open': spec({ params: z.object({ id: entityId }).strict(), permission: 'pages:read' }),
  'pages.subscribe': spec({ params: empty, permission: 'pages:read' }),
  'pages.unsubscribe': spec({ params: empty }),
  'databases.list': spec({ params: empty, permission: 'databases:read' }),
  'databases.get': spec({
    params: z.object({ id: entityId }).strict(),
    permission: 'databases:read',
  }),
  'databases.query': spec({
    params: z.object({ id: entityId, query: query.optional() }).strict(),
    permission: 'databases:read',
  }),
  'databases.addRow': spec({
    params: z.object({ id: entityId, input: rowInput.optional() }).strict(),
    permission: 'databases:write',
  }),
  'databases.updateRow': spec({
    params: z.object({ id: entityId, rowId: entityId, input: rowInput }).strict(),
    permission: 'databases:write',
  }),
  'storage.get': spec({ params: z.object({ key: z.string() }).strict(), permission: 'storage' }),
  'storage.set': spec({
    params: z.object({ key: z.string(), value: jsonValueSchema }).strict(),
    permission: 'storage',
  }),
  'storage.delete': spec({ params: z.object({ key: z.string() }).strict(), permission: 'storage' }),
  'storage.keys': spec({ params: empty, permission: 'storage' }),
  'storage.subscribe': spec({ params: empty, permission: 'storage' }),
  'storage.unsubscribe': spec({ params: empty }),
  'settings.set': spec({
    params: z
      .object({
        key: z.string().regex(SETTING_KEY_PATTERN),
        value: z.union([z.string(), z.number(), z.boolean()]),
      })
      .strict(),
  }),
  'block.setData': spec({
    params: z.object({ data: blockDataSchema }).strict(),
    permission: 'ui:blocks',
    surfaces: ['block'],
  }),
  'block.remove': spec({ params: empty, permission: 'ui:blocks', surfaces: ['block'] }),
  'panel.close': spec({ params: empty, surfaces: ['panel'] }),
} as const;

export type ApiMethod = keyof typeof API_METHODS;
export type ApiParams<M extends ApiMethod> = z.output<(typeof API_METHODS)[M]['params']>;

/** Returns true when `method` is an API method. */
export function isApiMethod(method: string): method is ApiMethod {
  return Object.hasOwn(API_METHODS, method);
}

/** Requests the host sends to a plugin. */
export type HostRequestMethod = 'ping' | 'activate' | 'deactivate' | 'command.run';

/** Events the host sends to a plugin. */
export type HostEventName =
  | 'pages.changed'
  | 'storage.changed'
  | 'settings.changed'
  | 'theme.changed'
  | 'panel.page'
  | 'block.state';
