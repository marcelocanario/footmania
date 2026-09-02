# Production deployment

Footmania runs on the homelab as two host-networked containers behind the
existing system-wide Cloudflare Tunnel:

- backend: `127.0.0.1:18085`
- frontend/reverse proxy: `127.0.0.1:8084`
- Cloudflare public hostname: `https://footmania.app`

PostgreSQL remains external to Compose. The live backend must use the dedicated
`footmania_prod` role and the `production` schema. The CI workflow uses a
disposable PostgreSQL service and a `test` schema; integration tests are
guarded in `backend/tests/testDbUrl.ts` so they refuse the production role or
any schema other than `test`.

## One-time homelab setup

1. Create `/srv/apps/footmania/container` and clone this repository there.
2. Copy `deploy/production.env.example` to `.env` in that directory. Replace
   every `REPLACE_WITH_...` value. Do not commit `.env`.
3. In the existing `/etc/cloudflared/config.yml`, configure the public
   hostname `footmania.app` to the service `http://127.0.0.1:8084`, then create
   the corresponding DNS route with `cloudflared tunnel route dns`.
4. Register the homelab GitHub Actions runner with labels `self-hosted` and
   `footmania`.
5. Ensure the database's `production` schema already contains the expected
   application state, or take a backup and perform a read-only audit before
   the first migration. Never use `prisma db push` or `prisma migrate reset`
   against production.

The Google OAuth application must have this authorized JavaScript origin:

```text
https://footmania.app
```

and this authorized redirect URI:

```text
https://footmania.app/api/auth/callback/google
```

## Manual first deployment

From the homelab checkout:

```bash
docker compose build
docker compose run --rm backend npm run db:upgrade
docker compose up -d --build --remove-orphans --wait --wait-timeout 300
curl --fail http://127.0.0.1:18085/api/health
curl --fail http://127.0.0.1:8084/healthz
```

The migration command uses `prisma migrate deploy` and then the two existing
idempotent data-migration helpers. It does not reset, truncate, or seed the
production schema. On a brand-new schema, the running backend creates the
global multiplayer world on first startup; that initialization is not part of
the CI test process.

Pushes and pull requests targeting `main` run the full validation gate,
including calibration. A push to `production` runs the non-destructive unit,
integration, migration, and image-build checks, then the self-hosted runner
pulls that exact branch, applies pending migrations, and restarts the
containers. Calibration is intentionally not repeated during this promotion;
the expected flow is code/PR -> `main` validation -> `production` deployment.
