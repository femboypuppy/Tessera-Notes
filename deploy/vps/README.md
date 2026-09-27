# Tessera on a VPS with Docker and Caddy

About 15 minutes on any Linux server (Hetzner, DigitalOcean, OVH, a home server). The steps use
Ubuntu 24.04; any distribution with Docker works.

## 1. Point a domain at the server

Create a DNS `A` record (and `AAAA` for IPv6) for your domain, for example
`notes.example.com`, with the server's public IP. Check it:

```bash
dig +short notes.example.com
```

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # log out and back in afterwards
docker compose version            # Compose v2.24 or newer
```

## 3. Open the firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp   # HTTP/3
sudo ufw enable
```

Docker publishes ports around `ufw`. The steps below bind Tessera's own port to `127.0.0.1`, so
only Caddy is reachable from outside.

## 4. Get the Compose files

```bash
sudo mkdir -p /opt/tessera && sudo chown "$USER" /opt/tessera && cd /opt/tessera
base=https://raw.githubusercontent.com/femboypuppy/Tessera-Notes/main
curl -fsSLO "$base/docker-compose.yml"
curl -fsSL "$base/.env.example" -o .env
mkdir -p deploy/caddy deploy/backup
curl -fsSL "$base/deploy/caddy/Caddyfile" -o deploy/caddy/Caddyfile
curl -fsSL "$base/deploy/backup/backup.sh" -o deploy/backup/backup.sh
curl -fsSL "$base/deploy/backup/restore.sh" -o deploy/backup/restore.sh
chmod +x deploy/backup/*.sh
```

Or clone the repository and use it in place: `git clone https://github.com/femboypuppy/Tessera-Notes /opt/tessera`.

## 5. Configure

Edit `.env`:

```bash
TESSERA_VERSION=0.1.2              # pin a release; see UPGRADING.md
PUBLIC_URL=https://notes.example.com
TESSERA_DOMAIN=notes.example.com
TESSERA_BIND=127.0.0.1             # only Caddy is exposed
SIGNUP_MODE=invite
```

## 6. Start

```bash
docker compose --profile https up -d
docker compose ps        # wait until tessera is "healthy"
docker compose logs caddy | grep -i certificate
```

Caddy gets a Let's Encrypt certificate on the first request (a few seconds).

## 7. Create the owner

```bash
docker compose exec tessera tessera-server create-owner
```

It asks for an email and a password. Open `https://notes.example.com`, sign in, then invite
people from Settings. In the desktop app: Settings → Sync & account → connect to
`https://notes.example.com`.

## 8. Back up every night

```bash
crontab -e
# 03:15 every night, keep 14 days:
15 3 * * * cd /opt/tessera && KEEP=14 deploy/backup/backup.sh /var/backups/tessera >> /var/log/tessera-backup.log 2>&1
```

Copy `/var/backups/tessera` off the machine too (restic, rclone, borg). Details:
[backup and restore](../backup/README.md).

## Caddy installed on the host instead

If Caddy (or another proxy) already runs on the server, skip the `https` profile and publish
Tessera on localhost only (`TESSERA_BIND=127.0.0.1`, then `docker compose up -d`). Add a site to
`/etc/caddy/Caddyfile`:

```caddy
notes.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8787
}
```

and `sudo systemctl reload caddy`. With nginx, proxy to `127.0.0.1:8787` and pass the WebSocket
upgrade headers (`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`,
`proxy_read_timeout 1h;`).

## Updates

See [UPGRADING.md](../UPGRADING.md): back up, change `TESSERA_VERSION`, then
`docker compose pull && docker compose --profile https up -d`.
