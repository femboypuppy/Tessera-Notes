# Tessera on Railway

One service with a volume; Railway provides HTTPS on a `*.up.railway.app` domain.

## Option A: the published image (quickest)

1. **New project → Deploy a Docker Image**, image `ghcr.io/femboypuppy/tessera:latest` (pin a
   release like `ghcr.io/femboypuppy/tessera:0.1.2` for production).
2. **Variables** (the service's Variables tab):

   | Variable | Value |
   |---|---|
   | `RAILWAY_RUN_UID` | `0` |
   | `PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
   | `SIGNUP_MODE` | `invite` |
   | `DATA_DIR` | `/data` |

   `RAILWAY_RUN_UID=0` starts the container as root because Railway mounts volumes owned by
   root. The image's entrypoint hands `/data` to its `node` user and runs the server as `node`.
3. **Volume**: right-click the service → **Attach volume**, mount path `/data`.
4. **Networking** → **Generate Domain**. Railway routes to the port in `PORT`, which it sets
   for you and the server listens on.
5. **Settings → Deploy → Healthcheck path**: `/api/health`.
6. **Deploy**. Once it's up, open the service's shell (⋯ → **Shell** or `railway ssh`) and run
   `su-exec node tessera-server create-owner`.

## Option B: build from your fork

1. Fork the repository and create a service from it (**Deploy from GitHub repo**).
2. **Settings → Config-as-code**: set the path to `deploy/railway/railway.json`. It builds the
   repository's `Dockerfile`, runs one replica and checks `/api/health`.
3. Add the variables, the volume and the domain as in option A.

## Notes

- **One replica.** SQLite has one writer; `numReplicas` stays at 1.
- **Backups.** Railway volumes can be backed up from the volume's settings (Backups tab). You can
  also run `tessera-server backup` from the shell and download the file.
- **Custom domain.** Networking → Custom Domain, then set `PUBLIC_URL` to it.
