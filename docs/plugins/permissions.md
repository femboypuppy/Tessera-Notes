# Permissions and security

Installing a plugin means running code someone else wrote next to your notes. Tessera's rule is
simple: **a plugin can only do what you allowed, and Tessera checks it on every call.** This page
explains what each permission allows, how the sandbox enforces it, and where its limits are.

## Permissions

A plugin lists the permissions it needs in its `manifest.json`. Before installing, Tessera shows
them in plain words, riskiest first. After installing, each one can be turned off in
**Settings → Plugins → the plugin → Permissions**. The plugin restarts, and calls that need the
missing permission fail with a message that says what to allow and where.

| Permission | What the plugin can do | Shown as | Risk |
| --- | --- | --- | --- |
| `pages:read` | List pages; read titles, content (markdown or document tree) and properties; follow changes; see and change which page is open | Read your pages | Low |
| `pages:write` | Create pages, rename them, change their icon, replace their content | Create and edit pages | Can change your data |
| `databases:read` | List databases; read their columns, views and rows | Read your databases | Low |
| `databases:write` | Add rows and change their values | Edit your databases | Can change your data |
| `ui:commands` | Add commands to the command palette, with keyboard shortcuts | Add commands | Low |
| `ui:panels` | Add side panels next to the page | Add side panels | Low |
| `ui:blocks` | Add custom blocks to the slash menu; their data is saved in the page | Add custom blocks | Low |
| `storage` | Keep its own data on this device, deleted on uninstall | Store data on this device | Low |
| `network:api.example.com` | Connect (`fetch`, `WebSocket`) to that domain over HTTPS or WSS | Connect to api.example.com | Can send data off this device |
| `network:*.example.com` | The same, for a domain and its subdomains | Connect to example.com and its subdomains | Can send data off this device |

Without any permission, a plugin can still show notifications, read its own settings and read
the theme. Notifications always name the plugin that sent them, and a plugin can send at most five
every ten seconds.

Think about combinations. A plugin that can read your pages **and** connect to a domain can send
what it reads to that domain. That is sometimes the point (a sync or AI plugin), but only install
such a plugin if you trust its author.

## How plugins are isolated

Plugin code never runs in the app. Each plugin gets:

- **A hidden, sandboxed frame running a Worker** for `activate`, commands and everything that
  isn't UI.
- **One sandboxed frame per open panel or block**, for the UI the plugin draws.
- **One hidden, sandboxed frame for its renderer**, if it has one (`renderer` in the manifest):
  heavy drawing code that its panels and blocks share. It opens on the first `api.ui.render`
  call, gets no API (only JSON in and out), and closes after two minutes without calls.

Every frame is an `iframe` with `sandbox="allow-scripts"` and never `allow-same-origin`. It has an
opaque origin, so it can't reach the app's page, cookies, `localStorage`, IndexedDB or any other
storage, and the app can't be reached through it. Each frame's document carries a strict Content
Security Policy:

```
default-src 'none'; script-src 'nonce-…' blob:; worker-src blob:;
connect-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline';
font-src data: blob:; frame-src 'none'; object-src 'none'; manifest-src 'none';
form-action 'none'; base-uri 'none'
```

Only the frame's own bootstrap script and the plugin's code (loaded from a `blob:` URL) run. No
`eval`, no remote scripts, no forms, no network. Each granted `network:` permission adds exactly
`https://` and `wss://` for its domain to `connect-src` (and its `https://` origin to `img-src`
and `media-src`), so everything else stays blocked by the browser itself.

The frames are `srcdoc` documents, so the browser applies the app's own policy on top of theirs.
When a Tessera server serves the app, its policy trusts a fresh nonce per page load and `blob:`
scripts, and the frames' bootstraps carry that nonce (the desktop app does the same with its own
nonce). The inner frame removes its bootstrap and its policy's text before plugin code loads, so
a plugin can't read the nonce. Don't add a second `Content-Security-Policy` in a reverse proxy:
it can't know the nonce, so plugins wouldn't start (the server's policy is already strict).

Panels and blocks use **nested** frames: a trusted outer frame, which runs no plugin code, holds
the inner frame that does. The outer frame's `frame-src 'none'` blocks every navigation of the
inner frame. Without it, a plugin could navigate its own frame to a URL with your data in it,
which a CSP alone can't prevent. If a plugin tries, Tessera stops it and says so in its console.

Panels, blocks and renderers need the page's DOM, so their code can't run in a worker, and
Firefox and Chromium without site isolation run their frames on the app's own thread. Nothing outside such a
frame can interrupt it, so Tessera checks the code before it runs: it rewrites the plugin's
module so that every function and every loop iteration first asks the frame whether the code has
run too long without a break. The first check, at the top of the module, adds `script-src 'none'`
to the frame's policy, so from then on no script can load at all: the only code that runs is the
code Tessera checked. Tessera prepares each plugin version once, in the background, and keeps the
result on this device.

## Every call goes through the host

The only way out of the sandbox is a message channel to the host: the part of Tessera that owns
the plugin. The SDK's `api` object is a convenience that turns calls into messages. The host is
the security boundary and trusts nothing the plugin sends:

- **Every message is inspected before it is parsed**: nesting depth (48), number of values
  (100,000), total characters (4 million), cycles, and types that can't be JSON are refused.
- **Every call is validated with a schema** for its exact parameters. Unknown methods, extra
  fields, wrong types and malformed IDs are refused.
- **Every call checks the permissions granted at that moment**, not the ones granted at
  startup, and whether the call is allowed from where it came from. Registering commands, panels
  and blocks is only possible from `activate`; changing a block's data only from that block, and
  never when the block is read-only.
- **Everything a plugin writes is validated**: documents against the editor's schema, block data
  and stored values as JSON within size limits (64 KB per block, 1 MB per stored value, 10 MB of
  storage per plugin).
- **A plugin can have at most 64 calls in flight.** Responses to unknown or finished calls are
  ignored.

The API never hands out live objects: pages come back as markdown or JSON snapshots, never as the
app's documents.

## When a plugin misbehaves

- **Errors** in `activate`, commands, panels and blocks are caught and shown in the plugin's
  **Console** (Settings → Plugins → the plugin). A panel or block that fails shows the error in
  its place; the rest of the app is unaffected.
- **A plugin stuck in a loop** stops answering the host's heartbeat (a ping every second). After
  four seconds the host stops it: its frames are removed, which ends its worker, and a
  notification says so, with a **Restart** button. The app stays responsive the whole time,
  because the loop runs in the worker's own thread.
- **A panel or block stuck in a loop** (or in endless recursion, or in a promise chain that never
  ends) is stopped by its frame after two seconds without a break. The app waits at most that
  long, the panel or block says the plugin stopped responding and offers **Reload**, and the rest
  of the plugin keeps running. A renderer that does the same is closed: the calls waiting for it
  fail with a message saying so, and the next call opens a new one.
- **Startup is time-limited**: a plugin has 20 seconds to load and 20 seconds for `activate`.
- **Uninstalling** stops the plugin, removes everything it registered, and deletes its storage.

## Limits

The sandbox is strong, but it isn't magic. What it doesn't do:

- **A single long call into the browser can't be interrupted.** Tessera stops panel and block code
  between its own steps, not inside the browser's functions. One call that runs for a long time,
  such as a regular expression that backtracks for minutes, holds the app until it returns in
  Firefox and in Chromium without site isolation for sandboxed frames (desktop Chromium runs them
  in their own process). Plugin authors: do heavy work in `activate`, which always runs in a
  worker, and keep panels and blocks light.
- **A plugin draws whatever it wants inside its own panels and blocks**, including things that
  look like Tessera. It can't draw outside them, and it can't read or click anything outside
  them.
- **Granted data is the plugin's to use.** A plugin with `pages:read` sees your pages, and with a
  `network:` permission it can send them to that domain. Permissions limit what a plugin can
  reach, not what it does with what it can reach.
- **CPU and memory aren't capped** beyond the heartbeat and the two-second limit for panels,
  blocks and renderers. If a plugin slows Tessera down, turn it off in Settings → Plugins.

## How this is tested

- Unit and integration tests in `packages/plugins` run real plugins through the sandbox runtime
  and the host: install, enable, disable, update, uninstall (storage cleared), revoking
  permissions, calls without permission from a runtime that skips the SDK's own checks, and a
  plugin that stops answering.
- Fuzz tests send the host malformed, oversized, deeply nested, cyclic and out-of-order messages.
- End-to-end tests in `e2e/plugins` run in Chromium and Firefox. They check that plugin frames are
  sandboxed, unreadable from the app and carry the CSP above, and that a plugin, a panel or a
  block stuck in an infinite loop is stopped while the app keeps working. A hostile test plugin
  probes the sandbox from inside, including loading code Tessera didn't check and switching the
  check off.
- Before any code was written, a spike in both browsers checked the design. A worker in a
  sandboxed frame can't open IndexedDB; the CSP blocks requests to other domains; a looping worker
  doesn't stop the app's timers. And plugin code that tries to leak data by navigating its frame
  (16 different ways) sends nothing once it is in a nested frame.

Found a way around the sandbox? Please report it privately; see the repository's
[security policy](https://github.com/femboypuppy/Tessera-Notes/blob/main/SECURITY.md).
