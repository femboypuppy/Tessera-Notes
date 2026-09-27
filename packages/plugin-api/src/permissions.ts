/**
 * Version of the plugin API described by this SDK. Put it in your manifest as `apiVersion`. The
 * host refuses plugins built for a newer API and keeps older versions working. Version 2 added
 * renderers ({@link defineRenderer}, `api.ui.render`); Tessera 0.1 runs version 1.
 */
export const PLUGIN_API_VERSION = 2;

/**
 * Permissions a plugin can ask for in its manifest. `network:<domain>` (for example
 * `network:api.example.com` or `network:*.example.com`) is the only parameterized one.
 *
 * | Permission         | Allows                                                        |
 * |--------------------|---------------------------------------------------------------|
 * | `pages:read`       | `api.pages.list`, `get`, `current`, `open` and `onChange`     |
 * | `pages:write`      | `api.pages.create` and `update`                               |
 * | `databases:read`   | `api.databases.list`, `get` and `query`                       |
 * | `databases:write`  | `api.databases.addRow` and `updateRow`                        |
 * | `ui:commands`      | `api.commands.register`                                       |
 * | `ui:panels`        | `api.ui.addPanel` and `openPanel`                             |
 * | `ui:blocks`        | `api.ui.addBlock` (custom blocks)                             |
 * | `storage`          | `api.storage` (private to the plugin, cleared on uninstall)   |
 * | `network:<domain>` | `fetch` to that domain (everything else is blocked)           |
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

/** A permission without parameters. */
export type StaticPluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** A network permission: `network:api.example.com` or `network:*.example.com`. */
export type NetworkPermission = `network:${string}`;

/** Any permission a manifest can list. */
export type PluginPermission = StaticPluginPermission | NetworkPermission;

/** Plugin IDs: lowercase words separated by `-` or `.` (`word-count`, `com.example.pomodoro`). */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

/** IDs of commands, panels and block types inside a plugin: lowercase words separated by `-`. */
export const PLUGIN_ITEM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
