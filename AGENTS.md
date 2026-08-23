# AGENTS.md

Guidance for coding agents working in this repository. This file defines the
design practices and the verification steps that must pass
before any change is declared complete.

## Repository layout

```text
backend/   Fastify API, Prisma schema, game engine, worker jobs   (TypeScript, Vitest)
frontend/  React SPA (Vite, PrimeReact, zustand)                  (TypeScript)
plans/     Product/implementation plans (source of truth for behavior)
```

The game is a **single global multiplayer world**. There is no separate
single-player/career mode. 
`backend/src/game/INVARIANTS.md` records the non-negotiable multiplayer invariants and must be preserved by any change.

## Definition of done

A change is **not** complete until every applicable item below passes. Never
declare a change complete based only on "it looks right".

## Concurrent agents and shared workspace

Assume that other agents may be editing and testing unrelated parts of the
repository at the same time. The working tree, generated files, database,
ports, and test resources are shared.

- Before editing, inspect `git status` and the relevant `git diff`; do not
  overwrite, revert, or reformat changes that another agent has made.
- Re-read a file immediately before patching it, and keep edits narrowly scoped
  to the requested change. If another agent changes the same lines, stop and
  resolve the conflict rather than guessing or discarding either change.
- Never use destructive commands such as `git reset`, `git checkout`, `git
  clean`, or broad cleanup commands to resolve a local problem. Do not delete
  generated files or test data that may belong to another running task.
- Do not commit, amend, stage, or otherwise alter another agent's work. Before
  handing off, inspect the diff and status so only the intended files changed.

## Shared test and build execution

Tests and builds can interfere with one another through shared databases,
ports, generated output, caches, and resource usage.

- Do not run the same test suite, build, migration, seed, or server-backed
  check concurrently with another agent. Check for an existing run and
  coordinate when possible; wait for it to finish instead of starting a
  duplicate run.
- Treat backend integration, calibration, and all-suite commands as exclusive
  shared resources. They may mutate shared database state or consume shared
  ports. Do not reset their database, kill their processes, or clean their
  artifacts while they are running.
- Backend and frontend builds can update generated output and TypeScript/Vite
  caches. Avoid overlapping builds and do not interpret transient generated
  file changes as application changes.
- If a test or build fails while another task may have been using the same
  resources, do not change production code to address the failure. Wait for
  the other run to finish and rerun the applicable command once in a stable
  workspace.

Tests and builds are slow. Run them **once at the end of all changes**, after
the full implementation is done — never after each individual step or edit.
Iterate on code without running the suite in between; only the final state of
the change needs to be verified.

### 1. Backend build

```bash
cd backend && npm run build
```

Must complete with zero TypeScript errors.

### 2. Backend tests

```bash
cd backend && npm test
```

The fast default unit suite must pass for every backend change. Run the
additional suites only when they are applicable to the change, as described
below. Do not weaken, delete, or scope-skip existing assertions to make a
change pass; update tests only when the plan intentionally changes the
behavior the test asserted, and add coverage for the new behavior.

### 2a. Test suite policy

`cd backend && npm test` is the fast default unit suite and should be run for
every backend change. Database, server, WebSocket, worker, scheduler,
persistence, and other integration tests are intentionally separate. The name
`integration` is conventional; it does not mean agents should run it for every
change.

Run `cd backend && npm run test:integration` only when the change affects the
database schema, Prisma services, persistence/save boundaries, workers,
schedulers, HTTP routes, server startup, WebSockets, or cross-cutting behavior
that requires the real application boundary. Run it before release or when
performing explicit full validation. High-volume statistical, Monte Carlo,
calibration, load, and long-running simulation tests must not run in the
default suite.

When a test needs population-level sampling to validate a distribution,
correlation, balance target, or long-term trajectory, mark its group as a
calibration test using `calibrationDescribe` from
`backend/tests/calibration.ts`. Keep deterministic examples and boundary cases
in the default suite whenever they provide useful regression coverage.

Calibration tests must preserve their assertions and sample sizes. Run
`cd backend && npm run test:calibration` only on demand when changing related
RNG, player-generation, development, match, economy, or balance logic, and
before release or full validation. Use `cd backend && npm run test:all` only for
release validation, broad cross-cutting changes, or when explicitly requested;
it runs the unit, integration, and calibration suites together. Do not add
future exhaustive, database-backed, server-backed, or long-running tests
directly to the default test path merely because they are new; place them in
the matching on-demand suite and document why if the classification is not
obvious.

### 3. Frontend build

```bash
cd frontend && npm run build
```

Runs `tsc -b` plus the Vite build. Must complete with zero TypeScript errors.
There is currently no frontend test suite; the typecheck/build is the gate.

### 4. Lint/format hygiene

There is no configured linter or formatter command. Treat the existing code
style as the standard: match surrounding indentation, naming conventions, and
layout, and do not introduce dead code, unused imports, or commented-out
blocks.

### 5. Tests for new behavior

New game logic must ship with tests. The plans list required test cases per
feature (see "Testing requirements by plan" below). At minimum:

- pure calculation logic (finance, proxy bids, pricing, promotion math,
  subset selection, simulation regressions) gets unit tests;
- anything touching persistence, the worker, or the save boundary gets a
  persistence/round-trip test (reload state, assert no duplication);
- any adversarial/anti-abuse rule (multi-account funnels, privacy, FCFS races)
  gets an explicit adversarial test;
- cross-cutting changes get an integration test that builds a world with
  `backend/tests/helpers.ts` (`makeWorld`/`makeClub`) and drives the real
  domain functions.

## Design practices from the plans

These are project-wide guidelines, not per-feature trivia.

### Never hard-code tunables

Balance/economy/tuning values must live in centralized configuration, not be
scattered through business logic:

- `backend/config/game.config.jsonc`, parsed by the zod schema in
  `backend/src/config.ts`, for core game/economy settings (`gameConfig`);
- `MARKET_CONFIG` in `backend/src/config.ts` for every market multiplier,
  duration, floor, cap curve, salary kernel, relist stages, and loan window;
- `MP_CONFIG` in `backend/src/config.ts` for multiplayer settings (join
  threshold, kickoff, inactivity thresholds, budget curve, etc.).

Rules:

- No balance constant (multiplier, floor, rate, window, threshold, weight,
  duration) is hard-coded inside game modules. Read it from the config object.
- New tunables get sensible defaults in `MARKET_CONFIG`/`MP_CONFIG` or the
  config file; adding one must not require a config migration.
- Structural rules are the exception: domain invariants (bidder privacy,
  youth/academy market ineligibility, one listing per player, pre-claim-only
  loan cancellation, shared financial validator, AI never promoted) live in
  the domain services, not the config.

### One cause, one effect

The match engine and economy must not double-count an effect. Each causal
factor enters the probability/calculation pipeline exactly once along one
defined pathway.

### No hidden/misleading information

- AI decisions never use hidden data (data that they would not be able to see if they were a player).
- Deterministic "noise" (AI valuation, free-agent salary negotiation,
  replacement generation, intervention retry) is seeded from stable IDs so a
  restart or retry cannot reroll a different outcome.

### Financial rules

- Humans may make the cushion negative (with warnings); AI may never do so.
  Both use the same commitment calculator.
- Immediate new expenses require actual unreserved cash, never projected
  income.

### Multiplayer integrity

- Every scheduled/market mutation is idempotent, retry-safe, and lock-aware.
  All authenticated mutations and worker jobs run under `withGlobalLock()` with
  `Save.revision` optimistic concurrency and a single Prisma transaction
  (`backend/src/services/lock.ts`, `backend/src/services/saveService.ts`).
- Use timestamped due-event processing (indexed queries on `endsAt <= now`),
  not a scan of everything every tick. Events scheduled while the server is
  down must catch up after recovery.
- AI filler is only at the bottom edge and is never promoted. Completed
  fixtures and season history are immutable.

### Reuse existing authoritative logic

- Reuse the existing source of truth for any value or action instead of
  inventing a parallel implementation (ie. prices, salaries, generated players,
  financial decisions).
- Financial decision-making is centralized, not re-implemented inside
  domain logic.

## Conventions checklist

- Follow the code style of neighboring files; no unrelated refactors.
- Add comments, specially if they capture a non-obvious rule or domain
  invariant.
- Never expose or log secrets/keys; never commit credentials.
- Do not commit unless explicitly asked.
