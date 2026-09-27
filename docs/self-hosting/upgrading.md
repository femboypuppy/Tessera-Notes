# Upgrading

Tessera follows [semantic versioning](https://semver.org). Read the
[release notes](https://github.com/femboypuppy/Tessera-Notes/releases) before upgrading: they call out
anything you need to do.

## Docker Compose

```bash
docker exec tessera tessera-server backup /data/backups/before-upgrade.tar.gz
docker compose pull
docker compose up -d
docker compose logs -f tessera
```

## docker run

```bash
docker exec tessera tessera-server backup /data/backups/before-upgrade.tar.gz
docker pull ghcr.io/femboypuppy/tessera:latest
docker rm -f tessera
docker run -d --name tessera -p 8787:8787 -v tessera-data:/data ghcr.io/femboypuppy/tessera:latest
```

Your data is in the volume, so removing the container doesn't touch it.

## Pinning a version

`latest` follows every release. To upgrade on your own schedule, pin a version in
`docker-compose.yml`:

```yaml
services:
  tessera:
    image: ghcr.io/femboypuppy/tessera:0.1.2
```

## Clients

The desktop app updates itself (it asks first) when a release includes signed update files;
otherwise install the new version from the releases page. Web browsers load the new app the next
time you open or reload it. Clients a version behind keep syncing; the release notes say when an
update is required.

## Going back

If an upgrade goes wrong, stop the server, restore the backup you took (see
[Backups and restore](./backups)) and run the previous image tag. Then
[open an issue](https://github.com/femboypuppy/Tessera-Notes/issues/new/choose) so we can fix it.
