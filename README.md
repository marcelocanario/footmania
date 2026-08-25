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

# Frontend — http://localhost:3000 (see Google OAuth note below)
cd frontend
npm run dev
```

## Google Sign-In setup

Authentication is handled by [better-auth](https://www.better-auth.com) with
**Google as the only sign-in method** — there is no username/password login.
The verified Google email is the account key; the Google display name becomes
the in-game manager (club coach) name.

1. Create a **Web application** OAuth client at
   https://console.cloud.google.com/apis/credentials.
2. Add `http://localhost:3000/api/auth/callback/google` as an **Authorized
   redirect URI** and `http://localhost:3000` as a **JavaScript origin**.
3. Copy the client id/secret into `backend/.env`:
   ```env
   GOOGLE_CLIENT_ID="..."
   GOOGLE_CLIENT_SECRET="..."
   PUBLIC_ORIGIN="http://localhost:3000"
   ADMIN_EMAIL="your@email.com"   # optional: grants admin on sign-in
   ```
4. The frontend dev server must run on the origin registered with Google
   (`PUBLIC_ORIGIN`); the Vite proxy forwards `/api` (including the OAuth
   callback) to the backend.

To add another provider later (e.g. Facebook) just add its
`socialProviders.*` entry in `backend/src/auth.ts` — better-auth's default
account linking joins it to the existing account via the verified email.

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
