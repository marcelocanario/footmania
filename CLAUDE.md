# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Required reading

Three documents are authoritative and must be consulted before non-trivial work:

- **`AGENTS.md`** — engineering conventions, the definition of done, the shared-workspace
  rules for concurrent agents, and the test-suite policy. Follow it; this file does not
  repeat it.
- **`BUSINESS_RULES.md`** — code-verified reference of every implemented rule, formula and
  algorithm (world structure, players, match sim, energy/injury, market, finance, calendar,
  multiplayer lifecycle). Documents behavior *as coded*.
- **`backend/src/game/INVARIANTS.md`** — 47 non-negotiable multiplayer invariants. Any change
  must preserve them; several (single OVR authority, single salary authority, hidden-quality
  privacy, one-cause-one-effect, ephemeral AI filler) are easy to violate accidentally.

Design plans live in `plans/`; calibration run outputs in `calibration/`. `Brasfoot/` and
`Elifoot/` are decompiled reference games, not part of the build.

## Commands

Backend (`cd backend`) — Postgres required; `DATABASE_URL` and `TEST_DATABASE_URL` in `.env`
(see `.env.example`):

```bash
npm run db:upgrade          # prisma migrate deploy + data migrations (natural positions, contract market)
npm run db:seed-name-pools  # import name pools (needed before first dev run)
npm run dev                 # tsx watch src/server.ts -> :3001
npm run build               # tsc + copy-game-data.mjs; must be zero-error
npm test                    # fast default unit suite — run for every backend change
npm run test:integration    # DB/server/worker/scheduler/persistence (serialized, shared "test" schema)
npm run test:calibration    # statistical / Monte Carlo balance suites
npm run test:all            # release validation only
```

Frontend (`cd frontend`): `npm run dev` (:3000, proxies `/api` and WS to :3001) and
`npm run build` (`tsc -b` + Vite; the typecheck *is* the gate — there is no frontend test suite).
On Windows, `run-backend.bat` / `run-frontend.bat` launch each side in its own console.

Running one test file or one test:

```bash
npx vitest run tests/market.test.ts -t "proxy bid"
```

Use the matching config for non-default suites: `npx vitest run --config vitest.integration.config.ts tests/persistence.test.ts`.
Suite membership is by explicit file list in `vitest.config.ts` / `vitest.integration.config.ts` /
`vitest.calibration.config.ts` — a new integration or calibration test must be added to the right
list (calibration groups additionally use `calibrationDescribe` from `tests/calibration.ts`, matched
by the `[calibration]` name pattern). There is no linter/formatter; match surrounding style.

## Architecture

**One global world, one Save row.** The game is a single always-on multiplayer world — there is
no single-player mode. All state lives in the `Save` row with `isGlobal = true`
(`backend/prisma/schema.prisma`). `Save.revision` is the optimistic-concurrency token and the
cross-process cache-invalidation signal.

**The world load/mutate/persist cycle** is the central pattern (`backend/src/services/saveService.ts`).
The database rows are deserialized into one in-memory `World` object (`game/types.ts`), game
functions mutate that plain object, and `persistWorld` diffs it against a cached baseline and
writes only the changed collections in a single transaction, bumping `revision`. Every
authenticated mutation and worker job runs inside `withGlobalLock()` (process mutex) plus
`withGlobalLease()` (DB-backed lease in `Setting`, so a second backend process cannot mutate
concurrently) — see `services/lock.ts`. `StaleWorldError` means the revision moved; callers
retry the whole load→mutate→persist attempt. `mutateGlobalWorld` and the `withWorld` helper in
`routes/game.ts` are the canonical wrappers — reuse them rather than hand-rolling a new cycle.

**Time is server-authoritative and event-driven.** `services/worker.ts` runs two loops: the
durable scheduler (`jobs/schedulerProcessor.ts`) and the live-match pacer
(`jobs/liveMatchProcessor.ts`). The scheduler materializes a season's `ScheduledEvent` rows
(`services/scheduler.ts`, `ScheduledEventType`) and claims those that are due either by real
time (`dueAt`) or by game day (`dueAbsoluteGameDay`), so downtime is caught up rather than
skipped and every handler is idempotent. Game-day advancement is owned by
`services/gameClockService.ts` (`GameClock`, UTC rollover hour); season rollover is a stepped
workflow in `services/seasonRolloverService.ts` committed as one atomic transition. Never
advance time or fire domain effects from a route — schedule an event.

**Reads are separate from writes.** `services/readService.ts` (lightweight queries for status,
public pages, lists) and `services/snapshot.ts` (the big per-club client snapshot, memoized per
`World`) build the wire views; routes should not serialize domain objects themselves. WebSockets
(`plugins/ws.ts`) push live-match state/deltas (`services/liveView.ts`, `liveMatchDiff.ts`) and
`invalidate` events that tell the client which cached scope to refetch.

**Game engine.** All rules live in `backend/src/game/` — `matchSim.ts` (the simulator),
`match.ts` (live match orchestration, subs, tactics), `playerGeneration.ts` / `careerCurves.ts` /
`generationModel.ts` (creation and development), `market.ts` / `freeAgents.ts` / `loans.ts`
(transfer system), `finance.ts` / `economy.ts` / `payroll.ts` (money), `multiplayer.ts` /
`season.ts` / `scheduling.ts` (divisions, promotion/relegation, fixtures), `population.ts`
(global population control). The frontend is presentation only — no rule may be reimplemented there.

**Determinism.** All randomness goes through the seeded PRNG in `game/rng.ts`. AI valuation,
free-agent negotiation, replacement generation and intake allocation are seeded from stable IDs
so a restart or retry cannot reroll a different outcome; several tests depend on this.

**Configuration.** Balance values are never hard-coded in game modules. `config/game.config.jsonc`
and `config/match-simulator.jsonc` are parsed and zod-validated by `src/config.ts` and
`src/matchSimulatorConfig.ts` into `gameConfig`, `MATCH_SIMULATOR_CONFIG`, `MARKET_CONFIG`,
`MP_CONFIG`, `ELO_CONFIG`, and friends. New tunables get a default there; structural domain
invariants stay in the domain services, not in config.

**Auth.** better-auth with Google as the only provider (`src/auth.ts`, `plugins/auth.ts`); the
verified email is the account key and the Google display name becomes the in-game manager name.
`ADMIN_EMAIL` grants admin at sign-in. Non-`/api/auth/*` routes are registered under `/api` in
`src/server.ts`.

## Testing notes

`tests/helpers.ts` (`makeWorld` / `makeClub`) builds an in-memory world for pure-domain tests
without a database — prefer it over touching Prisma. Integration suites share one Postgres
`test` schema and therefore run serialized with a single worker; do not start a second
integration/calibration run while one is in flight (see `AGENTS.md`, "Shared test and build
execution"). Tests and builds are slow — run them once at the end of a change, not after each edit.
