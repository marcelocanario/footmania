# Career, population, and economy calibration

Use this reference when player development, aging, retirement, contracts, roster stock/flow, academy intake, value, salary, or budget anchors may have moved. These domains share inputs but have separate contracts; never use one domain's target as a compensating knob for another.

## Authorities and dependency order

Read current versions of:

- `backend/config/game.config.jsonc` and `backend/src/config.ts`;
- `backend/src/game/careerCurves.ts`, `player.ts`, `development.ts`, and season-end development/aging orchestration;
- `backend/src/game/population.ts`, `season.ts`, `worldgen.ts`, `clubGenerator.ts`, and population analytics;
- `backend/src/game/economy.ts`, `generationProjection.ts`, and authoritative contract/salary/value services;
- `backend/tests/development.test.ts`, `playerCareer.test.ts`, `playerGeneration.test.ts`, `population.test.ts`, `populationAnalytics.test.ts`, `economy.test.ts`, and `contractEconomy.test.ts`;
- persistence/integration tests when a ledger, rollover, replacement, or contract boundary changes;
- the relevant sections of `BUSINESS_RULES.md` and `backend/src/game/INVARIANTS.md`.

Calibrate in this order:

1. career curves and player-quality trajectories;
2. population stock/flow using the accepted career lifetime;
3. economy using accepted public quality, age, career, and population inputs.

Reversing this order encourages compensating values: for example, changing salary to hide an inflated OVR curve or changing intake to hide an incorrect retirement lifetime.

## Career-development contract

Measure production trajectories over enough seeded players to cover profile tails, positions, activity histories, and ages.

Required checks include:

- generated profile marginals, bounds, means, tails, and independence;
- growth and decline budget maxima and population distributions;
- peak-age distribution and the exact transition rule at peak age;
- slow/fast timing changing cadence without granting extra lifetime budget;
- activity/minutes/training-focus ordering and configured caps;
- no growth after the defined peak and no decline before it unless explicitly designed;
- cumulative consumed budgets surviving save/reload without duplication;
- position-neutral OVR movement: applying equivalent weighted skill progress must not structurally favor a position;
- representative percentile trajectories, peak OVR/age, late-career OVR, and retirement age;
- public inputs only for AI/economy decisions.

Separate budget from timing. Potential controls how much can be gained or lost; speed controls when it is consumed. Do not tune both to repair one percentile until the failing stage is identified.

When generation constructs a standing-age population, verify that career reconstruction and simulated forward development agree. A cohort can pass a one-season growth test while still producing the wrong standing population.

## Population contract

Population is a durable stock-and-flow system, not merely a per-club roster-size assertion.

Freeze and report:

- counted active clubs and the exact population boundary;
- owned-player target and free-agent target as separate components;
- initial stock, season-by-season target, actual stock, and error;
- academy entries/promotions, retirements, terminal deletions, replacements, club joins/leaves, and signed corrections;
- eligible expected retirements versus realized retirements;
- age and natural-position mix through time;
- blocked slots, roster-cap effects, and pending compensation;
- idempotency and persistence across each rollover/save boundary.

Use multiple world seeds and enough seasons to expose drift, oscillation, and accumulation. Report both mean error and worst/terminal error; a mean near zero can hide alternating overshoot. Inspect the population ledger reconciliation whenever a run diverges.

Important distinctions:

- academy-to-senior promotion reclassifies an existing active player and is not a new population inflow;
- a free-agent pool included in the population target is not surplus outside the boundary;
- replacement generation must use the resolved production allocation, not independently recalculate demand;
- a join/leave or AI-filler transition must record one durable signed boundary change;
- retirement variance correction uses the population actually eligible at the authoritative point in season rollover.

Do not tune a per-season intake constant around a wrong expected lifetime. Derive the baseline from accepted career survival and terminal-drain rules first.

## Economy contract

Measure economy with generated production cohorts and current authoritative calculators. Include:

- player value versus OVR, age/career state, position treatment, and expected remaining output;
- monotonicity in public quality and contract term where the rules require it;
- senior salary demand and academy salary fraction;
- division/tier budget anchors and initial-club full value/payroll;
- release clauses and promoted-academy guardrails;
- affordability/commitment calculations through the shared financial authority;
- distribution quantiles, not only means, so tails do not make ordinary clubs insolvent.

Keep value, salary, and affordability conceptually separate. Do not add hidden career potential to a public valuation if the invariant requires current public attributes. Do not duplicate a salary or commitment formula inside calibration code.

If quality is correct but the economy misses, adjust the centralized economy coefficient family whose definition matches the failed metric. If value and salary both move, determine whether they share an intended quality anchor before changing both.

## Experimental designs

### Career

- deterministic boundary examples at entry age, peak, first decline year, and budget exhaustion;
- fixed-profile trajectories varying one of potential, speed, activity, or position;
- seeded population samples for percentile and distribution checks;
- save/reload or repeated season-step controls for exactly-once consumption.

### Population

- exact unit flows for every ledger event;
- multi-season Monte Carlo over several seeds and club counts;
- club-count changes and filler/human transitions;
- low/high retirement seasons to test variance correction;
- repeated rollover invocation to prove idempotency.

### Economy

- monotonic grids over OVR, age, term, and division;
- production generated initial clubs for value/payroll bands;
- paired before/after cohorts with the same players when testing formula changes;
- boundary fixtures for affordability, academy ratios, floors, caps, and release clauses.

## Causal tuning map

- **Peak OVR wrong, lifetime budget correct:** timing/profile reconstruction or entry/current target, not maximum growth.
- **Career gain/loss budget wrong:** configured maximum or consumption accounting; verify no duplicated pathway first.
- **One position develops differently:** OVR weighting/skill allocation, not a position-specific career multiplier.
- **Population drifts steadily:** expected lifetime, missing/unbalanced flow, or target boundary.
- **Population oscillates around target:** correction timing/gain, blocked capacity, or double application.
- **Only free-agent stock misses:** terminal/relist/free-agent residence rules, not owned-player target.
- **Initial club value misses after generation passes:** value curve or cohort economy conditioning.
- **Salary demand misses while value passes:** salary kernel/academy ratio/contract term path.
- **Both economy and match quality move:** generation/career inputs are upstream; accept them before tuning downstream domains.

## Acceptance and verification

Career acceptance requires deterministic budget/timing invariants plus statistical trajectory bands. Population acceptance requires multi-seed long-run stability, complete ledger reconciliation, and idempotent boundaries. Economy acceptance requires configured bands and monotonic/public-information guardrails on accepted cohorts.

Run focused calibration tests once after the final candidate. Add integration/persistence coverage when the save boundary or season rollover changed. Then run the backend build and default tests required by `AGENTS.md`.

Report the three statuses independently. `career-development: PASS` does not imply `population: PASS`, and neither implies `economy: PASS`.
