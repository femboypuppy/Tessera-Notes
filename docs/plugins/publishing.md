# Publishing a plugin

A Tessera plugin is a folder, or a `.zip` of it, with three files:

| File | Required | What it is |
| --- | --- | --- |
| `manifest.json` | Yes | ID, name, version, API version, author, description, entry and permissions. |
| `main.js` (the manifest's `entry`) | Yes | One ES module whose default export is `definePlugin({ … })`, with its dependencies bundled in. |
| `README.md` | No | Shown on the plugin's **About** tab in Settings → Plugins. |

`pnpm pack` in a project made with `create-tessera-plugin` builds exactly that into
`<id>-<version>.zip`. The manifest may sit at the root of the zip or inside one top-level
folder. Limits: 32 MB zipped, 64 MB and 500 files unzipped, 24 MB for the entry.

## The manifest

```json
{
  "id": "word-count",
  "name": "Word count",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "Tessera",
  "description": "Words, characters and reading time of the page you are on.",
  "entry": "main.js",
  "permissions": ["pages:read", "ui:panels"],
  "icon": "🔢",
  "repository": "https://github.com/you/word-count",
  "minAppVersion": "0.1.0"
}
```

| Field | Rules |
| --- | --- |
| `id` | 2–64 characters: lowercase words separated by `-` or `.` (`word-count`, `com.example.timer`). Never change it: it's how Tessera recognizes updates and keeps the plugin's storage. |
| `name` | Up to 60 characters. |
| `version` | Semver (`1.2.3`). Bump it for every release. |
| `apiVersion` | The plugin API version you built against (`PLUGIN_API_VERSION` in the SDK, currently `1`). Tessera refuses plugins that need a newer API and keeps older ones working. |
| `author`, `description` | Up to 100 and 500 characters. |
| `entry` | A path inside the bundle, usually `main.js`. |
| `permissions` | What the plugin needs; see [Permissions and security](./permissions.md). Ask for as little as you can: users see this list before installing. |
| `icon` | Optional: one emoji. |
| `homepage`, `repository` | Optional HTTPS URLs, shown on the About tab. |
| `minAppVersion` | Optional: the oldest Tessera version the plugin works with. |

## Sharing a plugin directly

Anyone can install your zip with **Settings → Plugins → Install plugin → From a file (.zip)…**,
or from a URL with **From a URL…**. The URL can point at the zip, or at a `manifest.json` with
its entry and README next to it.

Tessera downloads from the browser, so whatever serves the file must allow cross-origin requests
(`Access-Control-Allow-Origin: *`) over HTTPS. GitHub Pages and `raw.githubusercontent.com` do;
GitHub release downloads don't.

## Registries

The **Browse** tab of Settings → Plugins lists the plugins of a registry: one `registry.json`
file that anyone can host. The default registry is published with this site, at
`https://femboypuppy.github.io/Tessera-Notes/plugins/registry.json`: every time the docs deploy,
the example plugins are built, zipped and listed there with the SHA-256 of each zip, from
[`examples/plugins/registry.source.json`](https://github.com/femboypuppy/Tessera-Notes/blob/main/examples/plugins/registry.source.json).
Users can switch to another registry with **Change registry**, next to the search box.

```json
{
  "$schema": "https://femboypuppy.github.io/Tessera-Notes/plugins/registry.schema.json",
  "version": 1,
  "name": "My plugins",
  "updatedAt": "2026-09-24",
  "plugins": [
    {
      "id": "word-count",
      "name": "Word count",
      "author": "Tessera",
      "description": "Words, characters and reading time of the page you are on.",
      "repo": "https://github.com/you/word-count",
      "version": "1.0.0",
      "apiVersion": 1,
      "download": "https://you.github.io/plugins/word-count-1.0.0.zip",
      "sha256": "9f2c…64 hex characters…",
      "permissions": ["pages:read", "ui:panels"],
      "icon": "🔢",
      "tags": ["writing", "stats"]
    }
  ]
}
```

The top level has `version` (always `1`), an optional `name` and `updatedAt`, and `plugins`.
Each entry has:

| Field | Required | Rules |
| --- | --- | --- |
| `id`, `name`, `author`, `description`, `version` | Yes | The same as in the manifest, which must match `id` and `version`. |
| `repo` | Yes | The source code (HTTPS). Shown as a link on the plugin's card. |
| `download` | Yes | The zip, or the `manifest.json` (with the entry next to it). |
| `permissions` | Yes | Everything the plugin asks for. The card shows them before anyone installs. |
| `sha256` | No, but recommended | The SHA-256 of the zip, in lowercase hex. |
| `apiVersion`, `minAppVersion`, `homepage` | No | As in the manifest. |
| `icon` | No | One emoji. |
| `tags` | No | Up to 10 words, used by search. |

The format has a JSON Schema,
[`registry.schema.json`](https://github.com/femboypuppy/Tessera-Notes/blob/main/examples/plugins/registry.schema.json): editors validate the file
as you type when it links the schema with `$schema`. Entries that aren't valid are left out of
the Browse tab (it says how many), so one broken entry never hides the others.

### What Tessera checks when installing from a registry

- The download's SHA-256 matches `sha256`, when the entry has one. Entries of the default
  registry must have one: Tessera refuses to install one without it.
- The manifest's `id` and `version` match the entry.
- The manifest asks for **no permission the entry doesn't list**. A plugin can't show one list on
  its card and ask for more once downloaded.
- Then, as for every install: the manifest is valid, the bundle is within its limits, the API
  version is supported, and the user approves the permissions.

Compute the checksum of your zip with:

```sh
shasum -a 256 word-count-1.0.0.zip            # macOS, Linux
certutil -hashfile word-count-1.0.0.zip SHA256  # Windows
```

### Updates

Publish the new zip under a new file name (`word-count-1.1.0.zip`), then update the entry's
`version`, `download` and `sha256`. The Browse tab shows **Update to 1.1.0** to everyone who has
an older version. Updating keeps the plugin's settings and storage. If the new version asks for
more permissions, the user approves them first.

### Hosting a registry

Any static host that serves files over HTTPS with `Access-Control-Allow-Origin: *` works. The
simplest is a GitHub repository with GitHub Pages turned on: put `registry.json` and the zips in
it, push, and share `https://<you>.github.io/<repo>/registry.json`.

To list a plugin in the default registry, open a pull request on the Tessera repository that adds
its complete entry to `community` in `examples/plugins/registry.source.json`, with a `sha256`,
a public source repository, and the smallest set of permissions the plugin needs.
