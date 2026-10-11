# Installation

There are three ways to run Tessera. Pick one; you can connect them later.

| You want                                     | Use                                    |
| -------------------------------------------- | -------------------------------------- |
| A private notes app on your computer         | The [desktop app](#desktop-app)        |
| Sync between devices, or a shared workspace  | A [server](#docker) (plus any client)  |
| To hack on Tessera                           | [From source](#from-source)            |

## Desktop app

1. Open the [latest release](https://github.com/femboypuppy/Tessera-Notes/releases/latest).
2. Download the file for your system:

   | System                | File                                   |
   | --------------------- | -------------------------------------- |
   | macOS (Apple silicon) | `Tessera_<version>_aarch64.dmg`        |
   | macOS (Intel)         | `Tessera_<version>_x64.dmg`            |
   | Windows               | `Tessera_<version>_x64-setup.exe` or `Tessera_<version>_x64_en-US.msi` |
   | Linux                 | `Tessera_<version>_amd64.AppImage`, `.deb` or `.rpm` |

3. Install it and open Tessera. On first launch, choose a folder for your first workspace.

::: info The first launch asks for your permission
The apps aren't signed with a developer certificate yet, so your system checks with you once. On
macOS, open Tessera, then choose **Open Anyway** in System Settings → Privacy & Security. On
Windows, choose **More info** → **Run anyway**.
:::

The desktop app works fully offline. Each workspace is a folder on your disk holding a SQLite
database and your attachments. See [The desktop app](./desktop) for workspaces, quick capture and
updates.

::: tip Checksums
Every release lists SHA-256 checksums next to the downloads. On macOS and Linux,
`shasum -a 256 <file>` prints the checksum of the file you downloaded.
:::

## Docker

The Tessera server is one container: it syncs your workspaces and serves the web app.

```bash
docker run -d --name tessera -p 8787:8787 -v tessera-data:/data ghcr.io/femboypuppy/tessera:latest
```

The server prints a one-time setup code in its log (`docker logs tessera`). Open
`http://localhost:8787`, choose **Join a workspace on a server**, and create the owner account
with that code. Your data lives in the `tessera-data` volume.

For anything beyond a quick try, use Docker Compose. It sets a restart policy, keeps the
configuration in a `.env` file and can add automatic HTTPS:

```bash
mkdir tessera && cd tessera
curl -fsSLO https://raw.githubusercontent.com/femboypuppy/Tessera-Notes/main/docker-compose.yml
docker compose up -d
```

[Self-hosting](../self-hosting/) covers configuration, HTTPS, backups and upgrades.

## Web app

When a Tessera server is running, open its address in any modern browser (current Chrome, Edge,
Firefox or Safari). The web app stores your workspace in the browser (IndexedDB), so it keeps
working when the connection drops and syncs when it comes back.

::: warning Browser storage
Browsers can clear site data under storage pressure or when you clear your history. A workspace
that syncs to a server is safe; a local-only browser workspace is only as durable as the browser
profile. Use the desktop app or a server for anything you'd hate to lose, and
[export a backup](./import-export#backups) now and then.
:::

## From source

You need [Node.js 24](https://nodejs.org) and pnpm 11 (Corepack installs the right version).

```bash
git clone https://github.com/femboypuppy/Tessera-Notes.git && cd Tessera-Notes
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` starts the web app (with hot reload) and the sync server together, the app proxying
`/api` and `/sync` to the server. [CONTRIBUTING.md](https://github.com/femboypuppy/Tessera-Notes/blob/main/CONTRIBUTING.md)
explains how to run them separately, the desktop app and the tests. On Windows, clone into a short
folder such as `C:\src`, or run `git config --global core.longpaths true` first: some test
fixtures have long file names.

## Next

Take the [first steps](./first-steps): create a page, try the slash menu and link two pages.
