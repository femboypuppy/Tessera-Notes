import { describe, expect, it } from 'vitest';
import { hasPluginPermission, pluginManifestSchema, type PluginPermission } from './manifest';

const valid = {
  id: 'com.example.word-count',
  name: 'Word count',
  version: '1.2.0-beta.1',
  apiVersion: 1,
  author: 'Ada',
  description: 'Shows the number of words on the current page.',
  entry: 'dist/main.js',
  permissions: [
    'pages:read',
    'ui:panels',
    'network:api.example.com',
    'network:*.githubusercontent.com',
  ],
  icon: '🔢',
  homepage: 'https://example.com/word-count',
};

describe('pluginManifestSchema', () => {
  it('accepts a complete manifest', () => {
    expect(pluginManifestSchema.parse(valid)).toMatchObject({
      id: 'com.example.word-count',
      permissions: valid.permissions,
    });
    expect(pluginManifestSchema.parse({ ...valid, renderer: 'dist/renderer.js' })).toMatchObject({
      renderer: 'dist/renderer.js',
    });
  });

  it.each([
    ['uppercase id', { id: 'WordCount' }],
    ['id with slash', { id: 'word/count' }],
    ['non-semver version', { version: '1.0' }],
    ['api version zero', { apiVersion: 0 }],
    ['absolute entry', { entry: '/main.js' }],
    ['entry escaping the bundle', { entry: '../main.js' }],
    ['entry with a scheme', { entry: 'https://evil.example/main.js' }],
    ['renderer escaping the bundle', { renderer: '../renderer.js' }],
    ['renderer with a scheme', { renderer: 'data:text/javascript,1' }],
    ['unknown permission', { permissions: ['pages:delete'] }],
    ['network permission with scheme', { permissions: ['network:https://api.example.com'] }],
    ['network permission with path', { permissions: ['network:api.example.com/v1'] }],
    ['duplicate permissions', { permissions: ['storage', 'storage'] }],
    ['http homepage', { homepage: 'http://example.com' }],
    ['empty name', { name: '  ' }],
  ])('rejects %s', (_label, patch) => {
    expect(pluginManifestSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe('hasPluginPermission', () => {
  const granted: PluginPermission[] = [
    'pages:read',
    'network:api.example.com',
    'network:*.cdn.example.org',
  ];

  it('checks static and network permissions, with subdomain wildcards', () => {
    expect(hasPluginPermission(granted, 'pages:read')).toBe(true);
    expect(hasPluginPermission(granted, 'pages:write')).toBe(false);
    expect(hasPluginPermission(granted, 'network:api.example.com')).toBe(true);
    expect(hasPluginPermission(granted, 'network:evil.example.com')).toBe(false);
    expect(hasPluginPermission(granted, 'network:img.cdn.example.org')).toBe(true);
    expect(hasPluginPermission(granted, 'network:cdn.example.org')).toBe(false);
    expect(hasPluginPermission(granted, 'network:notcdn.example.org')).toBe(false);
  });
});
