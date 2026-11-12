# Deployment runbook

One Ubuntu server, Docker Compose, one domain over HTTPS. Everything lives in `deploy/`:

| File                             | What it is                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `deploy/docker-compose.prod.yml` | `db` (PostgreSQL 17, no published port), `app` (this API, port 8080 inside), `caddy` (80, 443) |
| `deploy/Caddyfile`               | HTTPS, the static frontend with SPA fallback, `/api/*` to `app:8080`, security headers         |
| `deploy/.env.production.example` | Every setting, with a comment each. Copy to `deploy/.env.production` (git-ignored)             |
| `deploy/scripts/first-run.sh`    | Migrations, permissions and the first admin, then a health check                               |
| `deploy/scripts/backup.sh`       | Database dump and documents archive; 14 daily, 8 weekly, `latest-*` links                      |
| `deploy/scripts/restore.sh`      | Restore into the live database, or into a new one for a test restore                           |
| `deploy/scripts/update.sh`       | Backup, build, migrate, restart, wait for health. Never runs git                               |
| `Dockerfile`                     | The API image: Node 22 slim, non-root, production dependencies, Prisma CLI and migrations      |

Paths below assume the repositories in `/opt/asico` (`asico-server`, `asico-management`), the built frontend in
`/opt/asico/frontend-dist` and backups in `/opt/asico/backups`. All commands run as the `deploy` user.

## First install

```bash
cd /opt/asico
git clone git@github-asico-server:Ahmed0701/asico-server.git
git clone git@github-asico-management:Ahmed0701/asico-management.git
git -C asico-server config pull.ff only
git -C asico-management config pull.ff only

cd /opt/asico/asico-server
git check-ignore -v deploy/.env.production      # must print a rule
cd deploy
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production                            # replace every CHANGE_ME
```

Generate the secrets on the server: `openssl rand -base64 48 | tr '+/' '-_' | tr -d '='` for `JWT_ACCESS_SECRET`, and
`openssl rand -hex 24` for `POSTGRES_PASSWORD` (the same value goes inside `DATABASE_URL`). No `$` in any value.

```bash
cd /opt/asico/asico-server/deploy
./scripts/first-run.sh
```

It builds and starts `db` and `app`, runs `npx prisma migrate deploy` and `node dist/cli/seed.js` inside the app image,
starts Caddy and waits for `/api/v1/health`. It refuses to run while the env file still says `CHANGE_ME` or is readable
by others. Then build the frontend (`asico-management/docs/DEPLOY.md`) into `/opt/asico/frontend-dist`.

Production settings worth knowing:

- `AUTH_SIGNUP_ENABLED=false` (also the default when unset in production): `POST /auth/signup` answers
  `403 SIGNUP_DISABLED`; only an administrator creates users.
- `FILE_DELIVERY=stream`: the API sends documents itself. `accel` needs an nginx `X-Accel-Redirect` location, which
  Caddy does not have, and would send empty files.
- The API refuses to start while any of its settings contains `CHANGE_ME`, and lists the names.

## Update

```bash
cd /opt/asico/asico-server
git pull
cd deploy && ./scripts/update.sh
```

`update.sh` takes a backup, builds the image, applies migrations with the new image, restarts the services, waits for
health and prints the deployed commit. Frontend: run `/opt/asico/deploy-frontend.sh`.

Rollback: `git checkout <good commit>` and `./scripts/update.sh`. A migration that dropped or changed columns is not
undone by the old image; restore the backup taken at the start of the update first.

## Backup

```bash
crontab -e
15 2 * * * /opt/asico/asico-server/deploy/scripts/backup.sh >> /opt/asico/backups/backup.log 2>&1
```

Each run writes `daily/db_<stamp>.dump` (pg_dump custom format, checked with `pg_restore --list`) and
`daily/documents_<stamp>.tar.gz` (the documents volume, checked with `gzip -t`), links `latest-db.dump` and
`latest-documents.tar.gz`, keeps a weekly copy on Sundays, and prunes to 14 daily and 8 weekly. It exits non-zero on any
failure. Copy the latest files off the server at least weekly: `scp deploy@SERVER_IP:/opt/asico/backups/latest-db.dump .`

## Restore

```bash
cd /opt/asico/asico-server/deploy
# Test restore into a new database; the live one is untouched:
./scripts/restore.sh --db /opt/asico/backups/latest-db.dump --into asico_restore_test
# Real restore (stops the API while it runs):
./scripts/restore.sh --db /opt/asico/backups/daily/db_<stamp>.dump --documents /opt/asico/backups/daily/documents_<stamp>.tar.gz
```

Both ask you to type the target database name before anything changes.

## Rotate secrets

| Secret              | How                                                                                                                                                              | Effect                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `JWT_ACCESS_SECRET` | New value in `.env.production`, then `docker compose -f docker-compose.prod.yml --env-file .env.production up -d app`                                            | Everyone signs in again    |
| `POSTGRES_PASSWORD` | `docker compose ... exec db psql -U asico -c "ALTER USER asico PASSWORD 'new'"`, then the same value in `POSTGRES_PASSWORD` and `DATABASE_URL`, then `up -d app` | None if done in that order |
| `SMTP_PASS`         | New value, then `up -d app`                                                                                                                                      | None                       |
| `ADMIN_PASSWORD`    | Only used once by the seed. Change the admin password in the app (profile page)                                                                                  | None                       |
| Deploy keys         | `ssh-keygen` a new pair, add it on GitHub, remove the old one                                                                                                    | None                       |

## Cloudflare proxy (later)

Turn the DNS record to Proxied (orange), set SSL/TLS to Full (strict), and set `TRUST_PROXY=2` in `.env.production`,
then `up -d app`. With two proxies in front (Cloudflare, Caddy) the API must trust both hops, or every visitor shares
Cloudflare's IP for the rate limits and the audit log. If certificate renewal fails, set the record back to DNS only.

## Daily checks

```bash
cd /opt/asico/asico-server/deploy
docker compose -f docker-compose.prod.yml --env-file .env.production ps
docker compose -f docker-compose.prod.yml --env-file .env.production logs --tail=100 app
curl -fsS https://YOUR_DOMAIN/api/v1/health
df -h && free -h
```
