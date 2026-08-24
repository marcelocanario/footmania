# Footmania

A browser-based football management game. Every human and AI club competes in one
single, always-on, global multiplayer world — there is no separate single-player mode.

## Repository layout

```text
backend/   Fastify API, Prisma schema, game engine, background worker  (TypeScript, Vitest)
frontend/  React SPA (Vite, PrimeReact, zustand)                        (TypeScript)
```

All game logic — match simulation, player generation/development, the transfer
market, finance, scheduling, promotion/relegation — lives in `backend/src/game/` and
`backend/src/services/`. The frontend is presentation only.

See **[BUSINESS_RULES.md](./BUSINESS_RULES.md)** for a complete, code-verified
reference of every rule, formula, and algorithm the game implements, and
**[AGENTS.md](./AGENTS.md)** for the engineering conventions and verification steps
expected of any change to this repository.

## Getting started

Requires [Node.js](https://nodejs.org).

```bash
cd backend && npm install
cd ../frontend && npm install
```

On Windows, `run-backend.bat` and `run-frontend.bat` each launch their service in its
own console window (backend runs its DB migration and name-pool seed first). Otherwise, run each side manually:

```bash
# Backend — http://localhost:3001
cd backend
npm run db:upgrade
npm run db:seed-name-pools
npm run dev

# Frontend — http://localhost:5173
cd frontend
npm run dev
```

## Testing & building

From `backend/`:

| Command | Purpose |
|---|---|
| `npm run build` | TypeScript build; must be zero-error |
| `npm test` | Fast default unit suite — run for every backend change |
| `npm run test:integration` | DB/server/worker/scheduler/persistence tests — run when those boundaries are touched |
| `npm run test:calibration` | Statistical/Monte Carlo balance tests — run on demand for RNG/generation/match/economy changes |
| `npm run test:all` | Everything above — release validation |

From `frontend/`:

| Command | Purpose |
|---|---|
| `npm run build` | `tsc -b` + Vite build; must be zero-error (there is no separate frontend test suite) |

See [AGENTS.md](./AGENTS.md) for the full definition of done, including when each
suite is required and the project's core design practices (centralized tunables,
"one cause one effect" in the match/economy engines, no hidden information for AI
decisions, and more).
