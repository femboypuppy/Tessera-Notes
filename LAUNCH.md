# Launch kit

Drafts for launch day. Edit freely; they're written to be humble, specific and easy to try.
Links assume the repository is `github.com/femboypuppy/Tessera-Notes` and the docs are on GitHub Pages.

The product is **Tessera Notes**: use the full name in titles and first mentions, since other
projects are called Tessera, and "Tessera" for short after that. The Docker image
(`ghcr.io/femboypuppy/tessera`), the `tessera-server` command and the `@tessera/*` packages keep
their names.

**Before you post anything:** the [launch-day checklist](#launch-day-checklist) at the bottom.

- [Show HN](#show-hn)
- [r/selfhosted](#rselfhosted)
- [r/opensource](#ropensource)
- [Product Hunt](#product-hunt)
- [X, Bluesky and Mastodon thread](#x-bluesky-and-mastodon-thread)
- [Blog post: Building a local-first Notion alternative with Yjs](#blog-post-building-a-local-first-notion-alternative-with-yjs)
- [Launch-day checklist](#launch-day-checklist)

---

## Show HN

**Title** (HN allows 80 characters; keep it plain, no superlatives):

> Show HN: Tessera Notes – a local-first, self-hosted Notion/Obsidian alternative

Alternatives:

- Show HN: Tessera Notes – databases, backlinks and real-time sync, open source
- Show HN: Tessera Notes – Notion-style databases that work offline, MIT licensed

**URL:** `https://github.com/femboypuppy/Tessera-Notes`

**Text:**

> Hi HN! Tessera Notes is an open-source (MIT) knowledge app: Notion-style blocks and databases,
> Obsidian-style [[wikilinks]], backlinks and a graph, plus real-time collaboration and sandboxed
> plugins.
>
> It's local-first: your workspace lives on your device and works fully offline. If you want sync
> or collaboration, you run the server yourself, one container:
>
>     docker run -d -p 8787:8787 -v tessera-data:/data ghcr.io/femboypuppy/tessera:latest
>
> There are also desktop apps for macOS, Windows and Linux (Tauri), and it imports Notion
> exports and Obsidian vaults, and exports plain markdown at any time.
>
> The fastest way to look around is "Open demo workspace" on the first screen: about 40 pages,
> a project board, a reading list, and a small knowledge garden about the history of space
> exploration, so the graph has something to show.
>
> It's 0.1, so there are rough edges, and there's no mobile app, E2E encryption or public sharing
> yet. I'd love feedback, especially on sync and on the import from your real Notion/Obsidian data.

**First comment** (post it yourself right after submitting):

> Some background on why and how.
>
> Why: I wanted Notion's databases and Obsidian's ownership in one app, and a server I control
> for sharing with a few people. The existing options each had most of it, but I kept missing one
> piece: fully open source, local-first, self-hostable collaboration, databases, or plugins.
>
> How it's built:
>
> - Every page is a Yjs document. Edits are written to local storage (IndexedDB in the browser,
>   SQLite on desktop) before they go anywhere, and sync over WebSocket to a Hocuspocus server
>   that stores updates in SQLite. Offline edits merge when you reconnect; there are no conflict
>   dialogs.
> - Page titles and the page tree live in a separate workspace document, so the sidebar and
>   search never load page contents. Database rows are pages too, but their property values live
>   in the database's own document, so views can filter and sort 10,000 rows without opening any
>   row.
> - The editor is TipTap/ProseMirror bound to Yjs. There's one canonical document schema, and a
>   test fails if the editor's schema drifts from it, which keeps the editor, the markdown codec
>   and the search indexer compatible.
> - Plugins run in sandboxed iframes (allow-scripts without allow-same-origin) and talk to the
>   app over a validated postMessage RPC, with permissions checked on every call.
> - Search is MiniSearch in a worker; the graph is sigma.js with ForceAtlas2 in a worker.
>
> The architecture doc is here: https://femboypuppy.github.io/Tessera-Notes/contributing/architecture
>
> Happy to go into any of it.

---

## r/selfhosted

Lead with the compose file and screenshots; r/selfhosted readers want to know what it takes to
run, what it stores, and how to back it up.

**Title:**

> Tessera Notes: a self-hosted, local-first alternative to Notion + Obsidian (docker compose, SQLite, MIT)

**Post:**

> Hi r/selfhosted! I've been building **Tessera Notes**, an open-source knowledge app: Notion-style
> pages and databases, Obsidian-style [[links]] and graph, and real-time collaboration, synced
> through a server you run.
>
> **Running it**
>
> ```yaml
> services:
>   tessera:
>     image: ghcr.io/femboypuppy/tessera:latest
>     restart: unless-stopped
>     ports:
>       - "8787:8787"
>     volumes:
>       - tessera-data:/data
>     environment:
>       PUBLIC_URL: https://notes.example.com
>       SIGNUP_MODE: invite
> volumes:
>   tessera-data:
> ```
>
> Or grab the repo's `docker-compose.yml`, which has an optional Caddy service for automatic
> HTTPS.
>
> **What you should know**
>
> - One container, one volume. SQLite for documents and accounts, a folder for attachments. No
>   Postgres, Redis or S3 needed. Images for amd64 and arm64.
> - Local-first: clients keep a full copy and work offline; the server syncs. If the server is
>   down, nobody loses anything, and edits sync when it's back.
> - Backups: `tessera-server backup <file>` writes a consistent snapshot while running; there's a
>   cron example in the docs.
> - Auth: accounts with argon2id, invite links, owner/editor/viewer roles enforced on the server.
>   `SIGNUP_MODE=invite` keeps sign-ups invite-only.
> - Desktop apps (Tauri) for macOS/Windows/Linux, and a web app that works at phone width.
> - Imports Notion exports and Obsidian vaults; exports plain markdown at any time.
>
> Screenshots: [link to the README or an album]
>
> Docs: https://femboypuppy.github.io/Tessera-Notes/self-hosting/ · Repo:
> https://github.com/femboypuppy/Tessera-Notes
>
> It's 0.1, so I'd especially love feedback on the deployment story: what's missing for your
> setup (Unraid/CasaOS templates, OIDC, S3 backups…)?

Attach 3–4 screenshots: the board (`databases/board`), the graph (`search/graph`), two people
editing (`sync/presence`) and the page in dark mode.

---

## r/opensource

**Title:**

> Tessera Notes: an MIT-licensed, local-first knowledge app (blocks, databases, backlinks, real-time sync)

**Post:**

> Hi all! Tessera Notes is a knowledge app I've been building in the open under the MIT license. Think
> Notion's blocks and databases plus Obsidian's links and graph, local-first, with a server you
> can self-host for sync and collaboration.
>
> Why another one? I wanted all of these at once: a permissive license, data on my own devices,
> real-time collaboration without a vendor, typed databases, and a plugin system that can't
> read my notes behind my back (plugins run in sandboxed iframes with explicit permissions).
>
> The stack is almost all TypeScript: Yjs, TipTap, Hocuspocus, SQLite, React, and Tauri (with a
> little Rust) for the desktop app.
>
> Contributions are very welcome. There are good first issues with pointers to the code, a
> contributor guide, and an architecture overview:
>
> - Repo: https://github.com/femboypuppy/Tessera-Notes
> - Good first issues: https://github.com/femboypuppy/Tessera-Notes/issues?q=label%3A%22good+first+issue%22
> - Architecture: https://femboypuppy.github.io/Tessera-Notes/contributing/architecture
>
> Feedback on the code and the docs is as welcome as feedback on the app.

---

## Product Hunt

| Field            | Draft                                                                               |
| ---------------- | ----------------------------------------------------------------------------------- |
| Name             | Tessera Notes                                                                       |
| Tagline (≤ 60)   | Your notes, your server. Notion's power, Obsidian's freedom.                        |
| Alt tagline      | Open-source notes and databases that work offline                                   |
| Topics           | Productivity, Note-taking, Open Source, Developer Tools                             |
| Links            | GitHub repository, docs, latest release                                             |
| Pricing          | Free (open source)                                                                  |
| Thumbnail        | `assets/brand/png/app-icon-512.png` (resize to 240×240)                             |
| Gallery          | `assets/brand/social-preview.png` first, then the README screenshots (1270×760 crops) and `assets/demo.gif` |

**Description (≤ 260 characters):**

> Tessera Notes is an open-source knowledge app with Notion-style blocks and databases,
> Obsidian-style links and a graph, and real-time collaboration. It's local-first and works
> offline; sync runs on a server you host in one container. MIT licensed.

**Maker's first comment:**

> Hi Product Hunt! 👋
>
> I built Tessera Notes because I wanted Notion's databases without giving up ownership of my notes.
> Everything lives on your device and works offline. When you want to share, you run the server
> yourself (one Docker container) and invite people.
>
> A few things I'm proud of:
> - 🧱 Blocks, slash menu, tables, callouts, toggles, embeds
> - 🗂️ Databases with table, board, calendar, gallery and list views
> - 🕸️ Backlinks, unlinked mentions and a graph view
> - 👥 Real-time collaboration and version history, on your own server
> - 🔌 Plugins in a sandbox with explicit permissions
> - 📦 One-click import from Notion and Obsidian, export to markdown any time
>
> It's free and MIT licensed. Try the demo workspace from the first screen. I'll be here all day
> answering questions!

---

## X, Bluesky and Mastodon thread

Each post fits 280 characters (Bluesky: 300, Mastodon: 500). Attach one image or GIF to each.

1. > I've been building Tessera Notes: an open-source, local-first knowledge app. Notion's blocks and
   > databases, Obsidian's [[links]] and graph, real-time collaboration, and a server you host
   > in one container. MIT licensed. 🧵
   >
   > github.com/femboypuppy/Tessera-Notes

   *Image: `assets/demo.gif`*

2. > Local-first, literally: your workspace lives on your device and works offline. Every edit is
   > saved locally before it goes anywhere. Sync is Yjs CRDTs over WebSocket, so offline edits
   > merge without conflict dialogs.

   *Image: `sync/presence`*

3. > Databases with table, board, calendar, gallery and list views. Filters, sorts, groups, and
   > 10,000 rows without breaking a sweat, all offline.

   *Image: `databases/board`*

4. > Every [[link]] works both ways: backlinks with context, unlinked mentions you can link in one
   > click, and a graph of everything.

   *Image: `search/graph`*

5. > Plugins run in sandboxed iframes and only get the permissions you approve. `pnpm create
   > tessera-plugin` scaffolds one in seconds.

   *Image: `plugins/mermaid-block`*

6. > Self-host with one line:
   >
   > docker run -d -p 8787:8787 -v tessera-data:/data ghcr.io/femboypuppy/tessera
   >
   > Or grab the desktop app for macOS, Windows and Linux. Import from Notion or Obsidian in one
   > click.

7. > It's 0.1 and I'd love your feedback, bug reports and first PRs. Docs:
   > femboypuppy.github.io/Tessera-Notes ⭐ if you'd like to follow along!

Hashtags (Mastodon, where they help discovery): #OpenSource #SelfHosted #LocalFirst #PKM
#NoteTaking.

---

## Blog post: Building a local-first Notion alternative with Yjs

*About 1,100 words. Publish on your blog or dev.to, and link it from the Show HN first comment
if people ask for details.*

---

### Building a local-first Notion alternative with Yjs

Most note apps make you choose. Notion has blocks, databases and real-time collaboration, but
your notes live on someone else's server. Obsidian keeps everything in files on your disk, but
collaboration and databases are afterthoughts. I wanted both, so I built
[Tessera Notes](https://github.com/femboypuppy/Tessera-Notes) (Tessera for short): open source,
local-first, and self-hostable.

This post is about the core decision that makes it work: every piece of content is a
[Yjs](https://github.com/yjs/yjs) document.

#### What "local-first" has to mean

"Local-first" is easy to claim and hard to mean. For Tessera it means three testable things:

1. **The app works with no network at all**, indefinitely, not just in a degraded read-only mode.
2. **Every keystroke is durable on your device before anything else happens.** Crash the browser
   mid-sentence and the sentence is still there.
3. **Sync converges.** Two people editing offline for a week end up with the same document when
   they reconnect, without a conflict dialog.

Point 3 rules out the usual "last write wins" sync, and it's where CRDTs come in.

#### Why a CRDT, and why Yjs

A CRDT (conflict-free replicated data type) is a data structure that every replica can change
independently; when replicas exchange their changes, in any order, they reach the same state.
Yjs is a fast, mature CRDT for JavaScript with shared types (maps, arrays, text and XML
fragments), a compact binary update format, and bindings for editors like ProseMirror.

The editor, TipTap, is built on ProseMirror, and y-prosemirror binds a ProseMirror editor to a
`Y.XmlFragment`. Typing produces a Yjs update, a few bytes describing the change. That update is
all we ever need to store or send.

#### One document per page, plus a workspace document

The first design question is granularity. One giant `Y.Doc` for the whole workspace would be
simple, but loading it means loading everything, and its history grows forever. One doc per
block would be too fine. Tessera uses three kinds of documents:

| Document    | Holds                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| `ws:<id>`   | Page metadata: title, icon, parent, order, trash state. Workspace settings. |
| `page:<id>` | One page's content (a ProseMirror fragment) and its properties.        |
| `db:<id>`   | A database's properties, views and every row's values.                 |

Titles live in the workspace document, not in the page, so the sidebar, the command palette and
link autocomplete never load page contents. Inside the workspace document, each page's metadata
is its own nested `Y.Map`, so one person renaming a page while another moves it merges cleanly
instead of one overwriting the other.

Database rows are pages (a row can have a body you write in, like in Notion), but their property
values live in the database document. That way a board view can group 10,000 rows without
opening 10,000 documents.

#### The write path: durable first, then sync

Here's what happens when you type a character:

1. TipTap updates the page's `Y.Doc` through y-prosemirror.
2. A small `DocManager` in the core runtime sees the update event and immediately calls
   `DocStore.storeUpdate(docName, update)`, which resolves only once the update is durable: an
   IndexedDB transaction in the browser, a SQLite write on desktop. Failures retry.
3. The sync provider sends the same update to the server over WebSocket (Hocuspocus), which
   stores it in SQLite and forwards it to everyone else with the page open.

Because the local write comes first, the network is never on the critical path. Offline, step 3
just waits. When the connection returns, Yjs exchanges state vectors (a summary of what each side
has seen) and sends only the missing updates, in both directions.

Appending every update forever would make documents slow to load, so busy documents are
compacted: many small updates are merged into one with `Y.encodeStateAsUpdate`. The tricky part
is doing it without racing new updates arriving at the same moment: compaction must never drop an
update that landed while it was running, so it has to be serialized with incoming writes.

Multiple tabs share the same local store. A `BroadcastChannel` tells other tabs about new updates,
so two tabs stay in sync without a server and without writing everything twice.

#### Swapping implementations: services with priorities

The same app runs in a browser, in a Tauri desktop window and in unit tests. Storage, sync,
search and the markdown codec are services with one interface each, and several implementations
register with a priority: in-memory stubs (0), browser implementations (50), desktop
implementations (100). At startup the runtime picks the highest-priority implementation that says
it's available. In Tauri, SQLite wins; in a browser, IndexedDB; in tests, the stubs. Features never
check where they're running.

#### What CRDTs don't give you for free

Yjs solves merging. Plenty of problems remain:

- **Tree integrity.** Two people moving pages concurrently can create a cycle (A inside B, B
  inside A). The CRDT happily stores it. Tessera repairs the tree deterministically when reading:
  the page with the smallest ID in a cycle becomes a root, so every client shows the same tree
  without writing anything back.
- **Schema drift.** If the editor, the markdown importer and the search indexer disagree about
  what a "callout" is, content breaks in subtle ways. There is one canonical schema in the core
  package, and a test fails if the editor's generated schema differs from it by a single
  attribute.
- **Undo.** In a shared document, undo must only undo your own changes. Yjs's `UndoManager`
  tracks changes by origin, so each client only undoes its own edits.
- **History.** Restoring an old version by rewinding the CRDT would fight every other replica.
  Instead, "Restore" writes the old content as a *new* edit, which syncs like any other change and
  can itself be undone.
- **Authorization.** A CRDT will merge anything it receives. The server has to enforce roles:
  viewers get read-only connections, and updates from them are rejected even if a modified client
  sends them anyway.

#### Presence is a different channel

Cursors and "who's here" avatars use Yjs *awareness*, a separate, ephemeral protocol. It is never
persisted, never merged into history, and disappears when a client disconnects. Mixing it with
document state is a classic mistake: you end up storing thousands of cursor positions forever.

#### Was it worth it?

The complexity is real, but it lives in a few places: the document layout, the write path, and the
server's authorization. Everything else, from the editor to databases to plugins, just edits
`Y.Doc`s through small typed helpers and gets offline support and collaboration for free.

If you want to dig in, the [architecture guide](https://femboypuppy.github.io/Tessera-Notes/contributing/architecture)
goes deeper, and the code is MIT licensed on
[GitHub](https://github.com/femboypuppy/Tessera-Notes). Try the demo workspace, break it, and tell me
what you find.

---

## Launch-day checklist

**Before**

- [ ] The README renders on GitHub with every screenshot and the demo GIF in place.
- [ ] The latest release has desktop binaries and checksums, and the Docker image pulls on amd64
      and arm64.
- [ ] The quickstart commands work when copy-pasted on a clean machine.
- [ ] The docs site is live, and search works.
- [ ] The social preview image is set (**Settings → General → Social preview**:
      `assets/brand/social-preview.png`, with the leaf logo and "Tessera Notes"; upload it again
      whenever it changes, since GitHub keeps its own copy).
- [ ] Discussions are enabled, with a pinned **Welcome** discussion (who you are, what feedback
      you want, where to report bugs) and a **Q&A** category.
- [ ] At least ten `good first issue`s are filed, each with a pointer to the code (drafts are in
      `HANDOFF/docs.md`), plus a `roadmap` label on the roadmap issues.
- [ ] Issue forms and the PR template work (open a test issue, then close it).
- [ ] A security contact is set (private vulnerability reporting enabled in the repository's
      Security settings).

**Posting**

- [ ] Post one community at a time, a few hours apart, so you can keep up with replies.
- [ ] Read each community's rules the same week you post; they change. Some limit self-promotion
      to certain days, require a flair, or ask that you take part in the community beyond your own
      project.
- [ ] Hacker News: submit once, as "Show HN", with a link people can try. Don't ask anyone to
      upvote or comment; HN penalizes it. Post the first comment yourself.
- [ ] Reddit: post from an account that participates in the subreddit; answer every question in
      the thread rather than linking elsewhere.
- [ ] Product Hunt: schedule for 12:01 a.m. Pacific. Tell your own followers it's live, but don't
      ask for upvotes.

**During the day**

- [ ] Reply to every comment, including critical ones. Thank people for bug reports and file them
      as issues right away, with a link back.
- [ ] Keep a running list of feature requests; answer with "noted, here's the issue" rather than
      promises.
- [ ] Watch the server-side logs of anything you host for the demo.
- [ ] Merge small fixes quickly and say so in the threads.

**After**

- [ ] Write a short thank-you post in Discussions with what you learned and what's next.
- [ ] Triage every new issue within a day or two for the first week.
- [ ] Label good first issues from what people asked for, and welcome first-time contributors.
