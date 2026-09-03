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

The migration command uses `prisma migrate deploy` and then the idempotent
data-migration helpers (natural positions, contract market, game-day
boundary). It does not reset, truncate, or seed the production schema. On a
brand-new schema, the running backend creates the global multiplayer world on
first startup; that initialization is not part of the CI test process.

The game-day boundary migration must complete BEFORE the long-lived backend
starts (the deploy job already runs `db:upgrade` as a one-shot container
first): the first worker tick after startup reads `mp.lastBoundaryAt` and the
`GameClock.lastBoundaryAt` row, and a pending day-advance row racing the repair
would be re-derived by the migration only if the migration runs first. The
migration is safe to run while the world is live — Tier A only repairs clock
bookkeeping; kickoff re-alignment is report-only unless
`FOOTMANIA_REALIGN_KICKOFFS=1` is set while the world is paused.

## Server clock contract

The server runs on UTC. Every game-day boundary, kickoff-slot grid and payroll
instant is a UTC wall-clock instant (`services/dayBoundary.ts`); the container
pins `TZ=UTC` in the `backend` stage of the `Dockerfile` and in
`compose.yaml`. No timezone is ever stored or configured per player — clients
convert from/to their browser timezone at the edges.

Pushes and pull requests targeting `main` run the unit, integration,
migration, and image-build checks. Calibration is intentionally not part of
CI: it runs locally, enforced by the pre-push hook (`.githooks/pre-push`)
which blocks any push to `main` until `npm run test:calibration` passes
(activate once per clone with `git config core.hooksPath .githooks`). A push
to `production` runs the same non-destructive checks, then the self-hosted
runner pulls that exact branch, applies pending migrations, and restarts the
containers. The expected flow is code -> local calibration (enforced) ->
`main` validation -> `production` deployment.

## Keeping the branches in sync

`production` must always be a fast-forward of `main` — never commit deployment
fixes directly on `production`, or the two branches drift and the next deploy
reuses stale, already-fixed files. Promote with:

```bash
git push origin main:production
```

This fails loudly if the remote `production` has diverged, which is exactly the
signal that something was committed out of band.
