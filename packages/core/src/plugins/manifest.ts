import { z } from 'zod';

/**
 * Version of the plugin API. A plugin declares the version it was built against in its manifest
 * (`apiVersion`); the host refuses plugins that need a newer version and keeps adapters for older
 * ones, so API changes never break installed plugins.
 *
 * Version 2 added renderers: the manifest's `renderer` module and `api.ui.render`.
 */
export const PLUGIN_API_VERSION = 2;

/**
 * Permissions without parameters. `network:<domain>` is the only parameterized permission.
 *
 * | permission        | allows                                                              |
 * |-------------------|---------------------------------------------------------------------|
 * | `pages:read`      | list pages, read titles, content (markdown or DocJSON) and props    |
 * | `pages:write`     | create pages, rename them, and replace content                     |
 * | `databases:read`  | read database schemas, views and rows                               |
 * | `databases:write` | add rows and update row values                                      |
 * | `ui:commands`     | register commands (palette and shortcuts)                           |
 * | `ui:panels`       | add side panels                                                     |
 * | `ui:blocks`       | add custom blocks (`embed` kind `plugin:<id>/<type>`)               |
 * | `storage`         | private key-value storage, cleared on uninstall                     |
 * | `network:<domain>`| fetch from that exact domain (`network:*.example.com` for subdomains) |
 */
export const PLUGIN_PERMISSIONS = [
  'pages:read',
  'pages:write',
  'databases:read',
  'databases:write',
  'ui:commands',
  'ui:panels',
  'ui:blocks',
  'storage',
] as const;

export type StaticPluginPermission = (typeof PLUGIN_PERMISSIONS)[number];
export type NetworkPermission = `network:${string}`;
export type PluginPermission = StaticPluginPermission | NetworkPermission;

/** Plugin IDs: lowercase words separated by `-` or `.` (`word-count`, `com.example.pomodoro`). */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

/** Custom block types inside a plugin: lowercase words separated by `-` (`mermaid`, `kanban-card`). */
export const PLUGIN_BLOCK_TYPE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A domain or `*.`-prefixed wildcard domain, optionally with a port. No schemes, paths or IPs-only checks. */
const NETWORK_DOMAIN_PATTERN =
  /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?$/;

/** Semantic version (`1.2.3`, `1.0.0-beta.1`). */
export const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** zod schema for one permission string. */
export const pluginPermissionSchema = z.union([
  z.enum(PLUGIN_PERMISSIONS),
  z.custom<NetworkPermission>(
    (value) =>
      typeof value === 'string' &&
      value.startsWith('network:') &&
      NETWORK_DOMAIN_PATTERN.test(value.slice(8)),
    'Network permissions look like network:api.example.com or network:*.example.com',
  ),
]);

/** A relative path inside the plugin bundle: no `..`, no absolute paths, no backslashes. */
const bundlePath = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').some((part) => part === '..' || part === '') &&
      !/^[a-z]+:/i.test(value),
    'Must be a relative path inside the plugin bundle',
  );

/**
 * zod schema for `manifest.json`. The host validates every manifest with it (never trust the SDK).
 *
 * @example
 * const result = pluginManifestSchema.safeParse(JSON.parse(text));
 * if (!result.success) showError(z.prettifyError(result.error));
 */
export const pluginManifestSchema = z.object({
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(PLUGIN_ID_PATTERN, 'Plugin IDs are lowercase words separated by - or .'),
  name: z.string().trim().min(1).max(60),
  version: z.string().regex(SEMVER_PATTERN, 'Versions follow semver, like 1.2.3'),
  apiVersion: z.number().int().min(1),
  author: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500),
  /** JavaScript entry (ES module) run inside the sandbox, relative to the manifest. */
  entry: bundlePath,
  /**
   * Optional second ES module (plugin API 2): render functions for heavy work, such as a diagram
   * library. It loads once, in a hidden frame shared by the plugin's panels and blocks, which
   * call it with `api.ui.render`, so they don't each load it.
   */
  renderer: bundlePath.optional(),
  permissions: z
    .array(pluginPermissionSchema)
    .max(32)
    .refine((list) => new Set(list).size === list.length, 'Permissions must be unique'),
  /** Optional emoji shown in the plugin list. */
  icon: z.string().min(1).max(16).optional(),
  homepage: z.url({ protocol: /^https$/ }).optional(),
  repository: z.url({ protocol: /^https$/ }).optional(),
  /** Lowest Tessera version the plugin supports (semver). */
  minAppVersion: z.string().regex(SEMVER_PATTERN).optional(),
});

/** A validated plugin manifest. */
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** Returns true when `permission` is granted by `granted`, including `network:*.domain` wildcards. */
export function hasPluginPermission(
  granted: readonly PluginPermission[],
  permission: PluginPermission,
): boolean {
  if (granted.includes(permission)) return true;
  if (!permission.startsWith('network:')) return false;
  const host = permission.slice(8).replace(/:\d+$/, '');
  return granted.some((entry) => {
    if (!entry.startsWith('network:*.')) return false;
    const suffix = entry.slice(10).replace(/:\d+$/, '');
    return host.endsWith(`.${suffix}`);
  });
}
