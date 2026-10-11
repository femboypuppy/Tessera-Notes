/**
 * @tessera/core — the contracts every Tessera package builds on: the data model and its typed
 * helpers, the canonical document schema, service interfaces with in-memory stubs, service
 * resolution, the runtime (events, commands, blocks, contributions, doc handles) and the types
 * features plug into. React bindings live in `@tessera/core/react`, test helpers in
 * `@tessera/core/testing`. See SPEC.md.
 */
export * from './json';
export * from './json-schema';
export * from './ids';
export * from './errors';
export * from './order';

// Data model
export * from './model/doc-names';
export * from './model/page-meta';
export * from './model/page-meta-schema';
export * from './model/page-index';
export * from './model/pages';
export * from './model/observe-pages';
export * from './model/page-doc';
export {
  DATA_MODEL_VERSION,
  initWorkspaceDoc,
  getWorkspaceSchemaVersion,
  getWorkspaceSetting,
  setWorkspaceSetting,
  listWorkspaceSettingKeys,
  observeWorkspaceSettings,
} from './model/workspace-doc';
export * from './database/types';
export * from './database/views';
export * from './database/database-doc';
export * from './plugins/manifest';

// Document schema
export * from './schema/index';

// Services
export * from './services/doc-store';
export * from './services/asset-store';
export * from './services/credential-store';
export * from './services/file-saver';
export * from './services/sync-provider';
export * from './services/workspace-registry';
export * from './services/search-index';
export * from './services/link-index';
export * from './services/markdown-codec';
export * from './services/import-export';
export * from './services/registry';

// Runtime
export * from './runtime/user';
export * from './runtime/events';
export * from './runtime/keyboard';
export * from './runtime/commands';
export * from './runtime/blocks';
export * from './runtime/settings';
export * from './runtime/platform';
export * from './runtime/pages-store';
export * from './runtime/doc-manager';
export * from './runtime/debounce';
export * from './runtime/feature';
export * from './runtime/app-context';
export * from './runtime/runtime';
