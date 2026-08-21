# Code Review: Footmania (2026-08-20)

> **Status: ADDRESSED.** All accepted findings were implemented on 2026-08-20;
> the implementation spec is in **"Implemented Fixes"** at the end of this
> document. Iteration notes referencing this review were appended to plans 1,
> 2, 4 and 5. A2 (join inheritance) was intentionally kept as-is. The
> stale/dead-code list (section D) remains open as future cleanup, except
> `playFixtureInstant` and the legacy match strength model, which were removed
> with these fixes.

Scope: full backend review — game engine, transfer/loan/free-agent markets, economy,
multiplayer pyramid, scheduler/worker, routes — focused on gameplay exploits
(player-facing rigging/unfair advantage), economy/inflation health, bugs, and
stale/dead code.

### Summary

The codebase is architecturally strong: centralized tunables, durable idempotent
scheduling, lock + revision-based persistence, proxy-bid privacy, and
well-documented invariants. However, this review found **one critical gameplay
exploit (collusive loan laundering)**, several fairness holes (mid-season join
inheritance, financial-intervention farming, no squad-size limit), a
mathematically broken ticket-pricing feature, a stadium-upgrade bug that
permanently locks the feature, and a substantial amount of stale/dead code left
behind by the durable-scheduler and possession-engine rewrites. The economy is
*not* runaway-broken (player values are formula-pinned and FA fees/stadium
upgrades act as sinks), but money faucets exceed sinks over time, which will
produce power creep rather than price inflation.

---

## Issues Found

| Severity | File:Line | Issue |
|----------|-----------|-------|
| CRITICAL | `backend/src/game/loans.ts:72-113` | Loan market has zero fee, zero financial check, FCFS claims → free star-player laundering between colluding accounts |
| WARNING | `backend/src/game/multiplayer.ts:98-109, 484-499` | Mid-season join replaces the *best-ranked* AI and inherits its standings points |
| WARNING | `backend/src/game/season.ts:467` | Stadium upgrade eligibility compares season-relative day indices → permanently blocked after first upgrade |
| WARNING | `backend/src/game/finance.ts:240-244, 585-700` | Financial intervention can be farmed as a free player/cash printer |
| WARNING | `backend/src/game/club.ts:359` | Ticket-price elasticity formula is exactly `ref/p`, making revenue price-invariant — pricing minigame degenerate |
| WARNING | `backend/src/services/seasonCalendar.ts:88-90` | `payrollDayIndices()` hard-codes `7`, ignoring `payrollIntervalDays` |
| WARNING | `backend/src/game/market.ts:428` vs `config.ts:163-186` | Transfer auctions use legacy `auctionDurationDays` (7 days), contradicting documented/replaced 24h `durationHours` |
| WARNING | `backend/src/game/season.ts:43,57` | Senior squad limit (35) enforced only on youth promotion — transfers/FA/loans unlimited |
| WARNING | `backend/src/routes/saves.ts:335-340` | `PUT /settings` allowed for any authenticated user, mutates global config in memory |
| WARNING | `backend/src/game/season.ts:281` | AI contract renewals require `demand > salary` → permanent AI wage ratchet vs fixed budgets |
| SUGGESTION | `backend/src/services/snapshot.ts:21` | `playerView` exposes hidden `tier` (birth-quality/potential-growth proxy) via API |
| SUGGESTION | `backend/src/routes/game.ts:223-241` | `/matches/:id/finish` lets either participant force-finish instantly, denying opponent halftime adjustments |
| SUGGESTION | `backend/src/config.ts:381-388` + soft-close cap | After 30 min of extensions, auctions are pure last-second sniping contests |

---

## Detailed Findings

### A. Gameplay exploits & fairness

**A1. Loan laundering — CRITICAL (95%)**

- **File:** `backend/src/game/loans.ts:72-113` (`claimLoan`), `config.ts:333-338`
- **Problem:** Loans have **no fee** (§55), the borrower pays only 100% of
  salary, claims are FCFS with a 30-min exposure window, and there is **no
  immediate-cash check** ("no immediate-cash check for the claim itself",
  lines 95-99). Two colluding accounts can move a star (e.g., OVR 85, worth
  ~$4M) for **only his salary** — bypassing the 150–300% transfer cap, the
  same-season cooldown, and the FA fee-to-system sink entirely. Repeatable every
  season (loans end at rollover). Solo variant: an insolvent club can hoard
  loaned stars because (a) claims cost nothing upfront, (b)
  `interventionCandidatePool` (`finance.ts:308-331`) **excludes loaned-in
  players from liquidation**, so interventions only ever sell your own players
  while the borrowed stars keep playing.
- **Suggestion:** Add a loan fee or wage premium (e.g., borrower pays >100%
  wage share, or a deposit equal to a fraction of player value held against the
  borrower's cushion); enforce `borrowerWageShare` from config (currently
  decorative); cap loaned-in players per squad; include contingent loan-wage
  commitments in the human warning path; consider blocking loan claims for clubs
  whose cushion is deeply negative.

**A2. Mid-season join inherits the best AI record — WARNING (90%)**

- **File:** `multiplayer.ts:98-109` (`highestRankedReplaceableAI`),
  `484-499` (`replaceClubInDivision`)
- **Problem:** A new club replaces the **top-ranked filler** in the lowest
  division and inherits its standings row (points/GD). Joining just before the
  join-lock with a dominant filler available means inheriting 1st place with
  half the season still to play — skipping the hard part of the season.
- **Suggestion:** Replace the *lowest-ranked* (or a median) filler, or reset the
  inherited row's points for the joining club, or make mid-season joiners
  provisional always.

**A3. Financial-intervention farming — WARNING (85%)**

- **File:** `finance.ts:240-244` (`systemLiquidationPrice`), `475-740`
  (`runFinancialIntervention`)
- **Problem:** Deliberately staying cash-negative triggers one intervention per
  payroll cycle: the system **pays the club up to 100% of player value** (cash
  printed from nothing) and generates **free same-position replacement players**
  (fresh, young, division-scaled). Replacements are immune to re-liquidation
  only within the same season. Net effect: convert an aging/expensive squad into
  young generated players + full-value cash without finding buyers — a "free
  youth academy + liquidity pump" that also injects new money each cycle.
- **Suggestion:** Pay liquidation at a discount (e.g., ≤60% of opening price),
  count replacements' value against future recovery targets, or make
  intervention payouts a loan charged back at rollover.

**A4. No senior roster limit outside academy promotion — WARNING (85%)**

- **File:** `season.ts:43,57`; `freeAgents.ts:204-333`; `market.ts`
- **Problem:** `SENIOR_SQUAD_LIMIT=35` applies only to `promoteYouthPlayer`.
  Transfers, FA signings, and loan claims are unlimited. A rich club can hoard
  all market supply (AI desired size is only a sell-score nudge), starving
  rivals — especially strong combined with FA having **no value cap**
  (`applyFreeAgentBid`, §43): money alone wins every signing competition
  deterministically.
- **Suggestion:** Enforce a senior roster cap on acquisitions
  (transfers/FA/loan claims), or add diminishing-cost roster tax above a
  threshold.

**A5. Multi-account funnels remain cheap — WARNING (80%)**

- Registration is open (`auth.ts:19-57`, invite optional); each account gets a
  club, $9M starting cash (`worldgen.ts:130`) and a season budget. The 150–300%
  cap + cooldown + FA-fee-to-system design is good, but the loan hole (A1)
  bypasses all of it. Abandonment cleanup takes 28+ days — long enough to join,
  extract, abandon.
- **Suggestion:** Close A1 first; consider delaying budget issuance for
  brand-new accounts, or requiring the account to play N rounds before transfers
  unlock.

**A6. Ticket pricing minigame is degenerate — WARNING (92%)**

- **File:** `club.ts:359`
- **Problem:** `elasticity = 1/(1+(p-ref)/ref)` simplifies to exactly `ref/p`,
  so `tickets × price` is **constant** across the whole legal price range; only
  above ~2.06× reference does the 0.35 floor kick in and make max price strictly
  better. Rational play is always "set maximum price"; the feature does nothing
  else.
- **Suggestion:** Use a genuinely convex elasticity, e.g.
  `1/(1+k·((p-ref)/ref)²)` or exponential demand, so revenue has an interior
  optimum.

**A7. Live-match force-finish — SUGGESTION (78%)**

- **File:** `game.ts:223-241`
- Either participant can `POST /matches/:id/finish`, which ticks 200 minutes
  through and finalizes. The winning side can deny the opponent's halftime
  lineup rebuild (`rebuildLiveHumanLineup` only works pregame/halftime).
  Consider restricting finish to after regulation or requiring both sides.

**A8. Hidden-info leak via `tier` — SUGGESTION (75%)**

- **File:** `snapshot.ts:21` (`playerView` exposes `p.tier`), displayed in
  `frontend/src/screens/Squad.tsx:325`.
- `tier` is derived from birth-quality Z and directly drives potential-growth
  rate (`player.ts:170-175`) and thus the development ceiling. The AI is
  forbidden from using it ("no star flag", `aiMarket.ts:12-18`), but humans see
  it for any listed/loaned/free-agent player — perfect scouting info that
  presumably was meant to be fuzzy/hidden. Decide: either hide `tier` publicly
  or document it as public scouting info.

**A9. Sniping after soft-close cap — SUGGESTION (76%)**

- `market.ts:188-212`: total extensions capped at 30 min; afterwards a bid never
  extends again, so scripted last-second bids win. With a 1% increment this
  rewards bots. Consider uncapped-but-decaying extensions, or randomized close
  within a window after the cap.

**A10. `PUT /settings` authorization gap — WARNING (88%)**

- **File:** `saves.ts:335-340`. Any logged-in user can mutate the global
  `gameConfig.humanMatchDurationMinutes` in memory. Impact today is low (the
  engine actually uses `MP_CONFIG.matchDurationMinutes`, see D-section), but it
  should be admin-gated like `routes/admin.ts`.

### B. Economy & inflation

**B1. Verdict: no hyperinflation, but structural power creep.** Player
values/prices are deterministic formulas (`economy.ts:106-117`), so money supply
growth doesn't raise prices directly. Faucets: season budgets (every club,
every season), gate revenue created from nothing each match, $9M per new
account, intervention payouts (A3). Sinks: FA signing fees (to system), stadium
upgrades, release-clause payments (destroyed). Over seasons, cash accumulates
faster than sinks absorb it → transfer caps bind permanently, FA fees escalate
(they're capped only by immediate cash), and the richest club converts surplus
directly into stars (A4). Gate revenue deserves a specific look: a 60k-seat
top-tier club can plausibly out-earn its entire seasonal budget from 7 home
gates, making stadium size the dominant economic factor and entrenching old
clubs vs newcomers.

**B2. Slow wage drift loop — SUGGESTION (75%).** `marketSalaryForPlayer`
(`freeAgents.ts:53-110`) derives FA salary baselines from the current
population's salaries; new signings set those salaries via
`calculateContractDemand` with a minimum 2% raise. This is a mild positive
feedback (bounded by the 5–95% percentile clamps) — wages will creep upward over
many seasons. Watch it via calibration tests.

**B3. AI wage ratchet — WARNING (85%).** `season.ts:281`: AI renews only when
`demand > player.salary`, i.e., salaries only ever rise for AI squads, while
budgets are fixed per tier. Long-run effect: AI clubs progressively drown in
payroll → more interventions (feeding A3) → weaker AI competition over time.
Allow AI to walk away / release players proactively, or accept equal-salary
renewals when financially tight.

**B4. Contract-renewal timing quirk — SUGGESTION (72%).**
`calculateRenewalDemandWithCurrentSeason` divides by `fraction + n`: renewing on
day 0 yields a lower average salary than renewing later for identical terms.
Optimal play becomes "always renew at season start." If unintended, exclude the
current-season fraction from the denominator.

### C. Bugs

**C1. Stadium upgrades permanently locked after first use — WARNING (93%)**

- **File:** `season.ts:467`:
  `u.startedDay >= world.dayIndex - (DAYS_PER_YEAR - 1)`
- `startedDay` is a **season-relative** index but `dayIndex` resets to 0 at
  rollover (`commitSeasonRollover`). For any past upgrade with
  `startedDay = s ≥ 0`, the condition `s >= d - 34` holds for all `d ∈ [0,34]` —
  so after one upgrade the club can **never** upgrade again. Should compare
  absolute game days (`mp.absoluteGameDay`), which already exist for stadiums
  (`stadiumCompletionAbsoluteGameDays`).

**C2. Payroll/weekly calendar hard-codes 7 — WARNING (90%)**

- **File:** `services/seasonCalendar.ts:88-90`: `payrollDayIndices()` uses
  literal `7` instead of `gameConfig.payrollIntervalDays`; the scheduler
  materializes `PAYROLL_RUN`/`WEEKLY_SIM_UPDATE` only on those days while the
  handlers check `% payrollIntervalDays` / `% weeklyIntervalDays`
  (`daily.ts:200-220`). Works today (both are 7) but silently breaks if either
  knob changes — and violates the repo's own "no hard-coded tunables" rule.

**C3. Transfer auction duration contradiction — WARNING (88%)**

- `market.ts:428` uses `gameConfig.auctionDurationDays` (= **7 days** in
  `game.config.jsonc:47`, whose own comment says "Real 24-hour periods"), while
  `MARKET_CONFIG.transferAuction.durationHours: 24` claims to be the replacement
  ("replaces legacy auctionDurationDays") and is never read for transfers.
  Either auctions are 7× longer than designed, or the config is stale. Pick one
  source of truth.

**C4. Resale anchor fade mis-anchors — SUGGESTION (80%)**

- `market.ts:268-281`: `roundForDay(last.seasonDayIndex) ?? 1` snaps any
  non-match-day trade to round 1, so the recent-trade base fades based on wrong
  round arithmetic (most trades happen off match-days). Use
  `completedRounds`-style monotonic counters for both endpoints.

**C5. Invariant #19 unimplemented; records/trophies/awards dead — WARNING (85%)**

- `world.seasonHistory` is initialized empty and **never written** anywhere;
  `club.trophies` is never incremented; `updateCareerRecords` /
  `computeSeasonAwards` (the only writers of `world.records` / `seasonAwards`)
  are dead code. INVARIANTS.md #19 promises archived standings at rollover, and
  the UI reads `records` / `trophies` / `seasonSummary` — all permanently empty.
  Implement at rollover or remove the surfaces.

**C6. Hard-coded 14 rounds in join proration — SUGGESTION (85%)**

- `saves.ts:144-149`: `const total = 14` instead of `ROUNDS_PER_SEASON`.

**C7. Loan length inconsistency — SUGGESTION (78%)**

- Human listings end at season end (`loans.ts:39`), AI listings use
  `DAYS_PER_YEAR * loanDurationSeasons` (`season.ts:381`), and
  `reconcileLoansAtRollover` kills everything at rollover anyway — making
  `loanDurationSeasons` meaningless and the two listing paths inconsistent.

### D. Stale / dead / obsolete code

Verified unreferenced in `src` (some kept alive only by tests).

**Superseded worker/jobs layer (biggest chunk):**

- `services/jobs/dailyProcessor.ts`, `notificationProcessor.ts`,
  `matchScheduler.ts`, `auctionProcessor.ts`, `aiMarketProcessor.ts`,
  `seasonScheduler.ts` — `worker.ts` wires **only** `schedulerProcessor`; the
  rest are unreachable in production (kept alive only by
  `tests/worker.test.ts`). The whole civil-calendar daily path they depend on
  (`daily.ts`: `processDailyDate`, `missingDailyDates`, `utcDateKey` /
  `parseDateKey`, plus `world.ts:runDailyTick`) is production-dead too.

**Unreferenced exports:**

- `world.ts`: `playFixtureInstant`, `processDueFixtures`, `syncCompletedRounds`,
  `allDivisionsFinished`, `nextId`, `fixturesForDay`, `applyMatchToStandings`,
  `runDailyTick`
- `season.ts`: `rolloverSeason`, `updateCareerRecords`, `computeSeasonAwards`
- `multiplayer.ts`: `timezoneCluster` (+`coordOf`/`midpoint`),
  `issueSeasonBudget`, `seasonKeyFromId`
- `budget.ts`: `performanceModifier` — note this silently drops plan §17A's
  "small performance modifier by previous finish"; budgets no longer vary by
  placement
- `club.ts`: `squadByPosition`, `squadStrength`, `weeklySalary`
- `match.ts`: the entire legacy Brasfoot strength model — `RatingContext`,
  `matchRepsForDivisions` (voided at every call site), `matchRating`, `bestN`,
  `midfieldStrength`, `defenseStrength`, `attackStrength`, `gkRating`
- `clock.ts`: `isMatchDay`, `seasonKickoffs`, `lastMatchDayOfMonth`,
  `completedRounds` alias
- `lock.ts`: `withSaveLock`; `snapshot.ts`: `bracketView`
- `rng.ts`: `nextBoolean`, `uniformInt`, `chanceDenom`

**Dead constants (Brasfoot legacy tables, defined but never read):**

`constants.ts`: `BENCH_POSITIONS`, `SUB_POSITION_WEIGHTS`, `POSITION_ROLL`,
`POSITION_GROUP`, `COUNTRY_GROUPS`, `REPUTATION_ATTENDANCE`,
`FORMATION_SUB_BONUS`, `SHOTTER_WEIGHTS`, `ASSISTER_WEIGHTS`,
`OWN_GOAL_WEIGHTS`, `PRESSING_POSSESSION`, `GOAL_DAMPING`, `CARD_YELLOW*`,
`CARD_RED_*`, `INJURY_FIRST/SECOND`

**Dead config/tunables (defined, never consumed):**

- `MARKET_CONFIG.transferAuction.durationHours` (see C3)
- `MARKET_CONFIG.freeAgents.startMultiplier` (duplicate of
  `relistMultipliers[0]`)
- `MARKET_CONFIG.loans.borrowerWageShare` / `.cancellation` /
  `.allowAcrossSeasonRollover` (rules enforced structurally, config never read)
- `gameConfig.transferIntervalDays` (never read)
- `gameConfig.humanMatchDurationMinutes` + `PUT/GET /settings` — the engine
  paces live matches with `MP_CONFIG.matchDurationMinutes`; the endpoint mutates
  a value nothing consumes

**Dead data model fields:**

- `FreeAgentListing.demandedSalary` — legacy field kept alive only through
  fallback chains (`?? demandedSalary ??`) and save migration
- `World.contractWarnings` — always `[]`, never written
- `World.managerHistory` — persisted round-trip but nothing appends
- `World.seasonHistory` / `World.seasonSummary` — never written (see C5)
- `Club.inactivityWarningStage` — persisted, defaulted, never used by
  `evaluateInactivity`

---

## Implemented Fixes (2026-08-20)

The accepted findings were implemented as specified below. This section is the
source of truth for the changed behavior; where older plans conflict, this
document wins for these topics. Iteration notes referencing it were appended to
plans 1 (multiplayer), 2 (transfer market, Iteration 14), 4 (player-generation)
and 5 (financial-control).

Decisions taken with the owner: A2 kept as-is; season-budget formula unchanged
after gate removal; roster cap = 35 (shared `SENIOR_SQUAD_LIMIT`); the sell
lock covers both transfer auctions and loan listings; stadium name survives as
cosmetic identity while capacity is deleted.

### Fix 1 — Loan fee and borrowed-player cap (resolves A1)

1. `MARKET_CONFIG.loans` gains `feeMinValueRatio: 0.1`, `feeMaxValueRatio: 0.3`
   (the lender-chosen claim fee is a fraction of player value inside this band)
   and `maxLoanedInPerClub: 5`. The decorative `borrowerWageShare`,
   `cancellation` and `allowAcrossSeasonRollover` entries are removed (wage
   share 100% remains hard-wired in `finance.remainingSalaryCommitments`;
   pre-claim-only cancellation and no-cross-rollover remain structural).
2. `offerPlayerForLoan` accepts an optional `feeRatio`, clamped to the band,
   defaulting to the minimum. The fee is snapshotted in absolute currency
   (`Loan.feeAmount`) at listing time so later value drift cannot move it.
3. `claimLoan` enforces, in order: existing eligibility → shared senior-roster
   cap (Fix 2) → borrowed-player cap → contract fit → **immediate-cash rule**
   (`feeAmount <= getImmediateAvailableCash(borrower)`, financial-control §9).
4. On claim the borrower pays the lender immediately (ledger code 16 both
   sides) and a `LOAN` row is appended to `playerMarketHistory` (audit-only per
   transfer-market-overhaul §72). The fee is non-refundable; pre-claim
   cancellation and season-end return are unchanged.
5. AI clubs use the same path: `loanCycle` lists at the minimum ratio and its
   claim candidates pass `immediateCost: feeAmount` into the shared
   `evaluateAIDecision` cushion rule before claiming through `claimLoan`.
6. Persistence: `Loan.feeAmount Int @default(0)` (legacy rows read as 0 and
   remain claimable). API/views expose `feeAmount`; the offer endpoint accepts
   `feeRatio`.

### Fix 2 — Single senior-roster cap (resolves A4)

1. `SENIOR_SQUAD_LIMIT = 35` moves to `game/constants.ts` and becomes the one
   cap for youth promotions, transfer-auction wins, free-agent signings and
   loan claims alike.
2. `seniorRosterCount(world, clubId)` counts non-youth players whose `clubId`
   is the club: loaned-in players occupy slots and count; loaned-out players do
   not.
3. Bid-time checks fail early (`applyMaxBid`, `applyFreeAgentBid`,
   `claimLoan`) with "Senior squad is full (35)".
4. Settlement re-checks fail closed: `settleTransferAuction` /
   `settleFreeAgentListing` return `{ ok: false, terminal: true }` when the
   winner is full (covers two simultaneous settlements racing past the bid-time
   check). Terminal failures cancel the listing, release all reservations and
   keep the player at the seller (`cancelUnsettleableAuction` / FA equivalent)
   instead of retrying forever.
5. AI buying records a durable PASS when the squad is full instead of retrying
   every tick.

### Fix 3 — New-club economy (resolves A5)

1. `MP_CONFIG.newClubStartingCash = 0`: a new human club is funded exclusively
   by its season allocation. `constants.STARTING_CASH` is deleted (filler AI
   keeps its own tier curve).
2. `MP_CONFIG.newClubSellLockMatches = 3`: a human-owned club may buy players
   and release players immediately, but may not list players for transfer
   auction or loan until it has played that many of its OWN league fixtures.
3. `matchesPlayedByClub` counts played fixtures in current-season active
   divisions involving the club — deliberately NOT `StandingsRow.played` /
   `MpClubSeason.played`, which a mid-season joiner inherits from the replaced
   AI. Historical fixtures keep the retired AI's id, so a joiner starts at 0.
4. Filler AI is exempt (ephemeral market supply, not a funnel participant).
5. Enforcement lives in the domain entry points (`createTransferAuction`,
   `offerPlayerForLoan`), so the intervention engine and AI paths are unaffected
   by construction. See INVARIANTS #10/#22.

### Fix 4 — Financial intervention pays the floor (resolves A3)

1. `systemLiquidationPrice` returns the auction opening-range MINIMUM (60% of
   the recent-trade base value) instead of the base value. Deliberate
   insolvency now converts players to cash at a discount and can no longer be
   farmed as a full-value liquidity pump.
2. Replacement generation is unchanged: replacements already come from the
   canonical division-driven generator with the same senior age distribution as
   new-club rosters (mixed ages by design). A parity test pins this.

### Fix 5 — Server-clock-only matches (resolves A7)

1. The REST endpoints `POST /matches/:id/tick` and `POST /matches/:id/finish`
   are deleted; the WebSocket `finish` message handler is deleted.
2. The WS `tick` message stays as a strictly elapsed-time catch-up for viewers
   (`advanceLiveMatches(Date.now())`): spamming it can never advance play
   beyond what real time has consumed.
3. The worker (`advanceLiveMatches`, `MATCH_COMPLETE` events) is the only
   authority; a match takes exactly `MP_CONFIG.matchDurationMinutes` of real
   time and auto-plays through half-time. The frontend loses its Finish button;
   ended matches simply navigate back to the dashboard.

### Fix 6 — Player quality flag removal (resolves A8)

1. `Player.tier` is removed end to end (type, generator, persistence column,
   API views, Squad UI). There are no stars or quality flags.
2. Behavior is preserved: `potentialGrowth` derives the hidden growth tier on
   the fly via `tierFromZ(player.rawZ ?? 0)` from the already-persisted
   server-private birth-quality Z. Legacy rows without `rawZ` map to Z=0 (mid
   tier). The value is never stored on the player nor exposed through any API.

### Fix 7 — Soft close resets to a fixed window (resolves A9)

1. `MARKET_CONFIG.transferAuction` replaces `softCloseMinutes` /
   `extensionMinutes` / `maxSoftCloseExtensionMinutes` with a single
   `softCloseWindowMinutes: 30`.
2. `extendDeadline`: a competitive bid (leader or price change) with less than
   the window remaining resets the deadline to `now + window`. There is no
   extension cap or accumulator; scripted last-second bids cannot snipe because
   every competitive bid pushes the close a full window away.
3. `softCloseExtensions` is dropped from types/persistence/schema; the
   `softClosed` display flag remains.
4. Free-agent parity: the scheduler materializer cancels pending FREE_AGENT
   `AUCTION_END` events queued for a superseded deadline (payload deadline ≠
   listing deadline), so extensions cannot strand early-firing events.

### Fix 8 — Settings write path removed (resolves A10)

1. `PUT /settings` is deleted; `GET /settings` stays read-only and returns
   `{ maxContractSeasons, matchDurationMinutes: MP_CONFIG.matchDurationMinutes }`.
2. `humanMatchDurationMinutes` is removed from the config schema, defaults and
   `game.config.jsonc` — the engine paces live matches with
   `MP_CONFIG.matchDurationMinutes` only.

### Fix 9 — Stadium / ticket / gate / fan removal (resolves A6; C1 moot)

Removed end to end:

* `calcGate`, `sectorCapacity`, `divisionTicketTier`, attendance tables,
  `TICKET_PRICES` / `TICKET_PRICE_NOISE` / `TICKET_SPLIT`,
  `REPUTATION_ATTENDANCE`, `MARKET_CONFIG.ticketTier`.
* `startStadiumUpgrade`, `stadiumCycle`, the `STADIUM_UPGRADE_COMPLETE` event
  type, `END_GAME_DAY` materialization, and
  `mp.stadiumCompletionAbsoluteGameDays`.
* `World.ticketPrices`, `World.stadiumUpgrades`, `Match.attendance`,
  `Match.gateRevenue`, `Club.stadiumCapacity` (schema columns/models dropped;
  `prisma db push` applied).
* Routes `/club/tickets`, `/club/stadium-upgrade`; ticket/stadium parts of
  `/club/finance-details`; frontend ticket/stadium UI, capacity displays and
  match attendance/gate fields.
* Fan-support traces: dead `board`/`fans` UI strings (the fan-confidence
  mechanic itself was already removed in transfer-market-overhaul Iteration 1).

Kept: `Club.stadiumName` as cosmetic identity (Join/Dashboard/Finances).

The season-budget formula is intentionally unchanged (owner decision): clubs
lose gate income and the budget remains the primary funding source. The
misleading gate-revenue comment in `budget.ts` was corrected. Existing worlds
keep their initialized `FIRST_DIVISION_SEASON_BUDGET` setting row; admins can
raise it via `setBudgetSettings`. C1 (the stadium-upgrade lockout bug) is
resolved by removal rather than repair.

### Invariants

INVARIANTS.md updated: #10 reworded (outbound markets additionally require the
sell lock) and new invariants #22 (new-club sell lock), #23 (single roster cap),
#24 (loan fee band + borrowed cap), #25 (server-clock-only matches), #26 (no
hidden quality flags), #27 (interventions pay the floor).

### Verification

New `tests/reviewFixes.test.ts` (15 tests): fee band validation/default/
snapshot; fee charge borrower→lender with ledger rows; insufficient-cash
rejection; borrowed-cap rejection; roster-cap rejection on bid/claim; terminal
settlement failure keeping the player at the seller; sell lock blocked →
unlocked by own played fixtures; inherited standings not counted; AI exempt;
zero starting cash; liquidation price equals the opening floor.

Updated suites: soft-close reset semantics (`market.test.ts`), legacy
strength-model tests removed (`engine.test.ts`), gate/ticket tests removed,
tier-flag absence assertions (`playerGeneration.test.ts`), live REST tests
rewritten for the server-clock model (`live.test.ts`). All five integration
test databases re-synced with the schema.

Definition-of-done verified 2026-08-20: backend build OK - unit suite 340/340 OK -
integration suite 55/55 OK - calibration suite 35/35 OK - frontend build OK -
acceptance greps clean OK.

### Still open (not part of this fix round)

* **B2** slow wage-drift loop, **B3** AI wage ratchet, **B4** renewal-timing
  quirk — balance watch-items.
* **C2** `payrollDayIndices()` hard-coded 7, **C3** auction-duration
  config contradiction (`auctionDurationDays` vs unused `durationHours`),
  **C5** invariant #19 unimplemented (seasonHistory/trophies/records dead),
  **C6** hard-coded 14 rounds in join proration, **C7** loan-length
  inconsistency between human and AI listing paths.
* **Section D** stale/dead-code purge (jobs layer, Brasfoot tables,
  `timezoneCluster`, `issueSeasonBudget`/`performanceModifier`, dead world
  fields) — except `playFixtureInstant` and the legacy strength model, which
  were removed with these fixes.
