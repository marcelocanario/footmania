# Footmania Calibration Master Plan

**Status:** Plan only. No recalibration run has started.

**Purpose:** Recalibrate the current player-generation, career, population,
economy, and match systems in dependency order after the player-generation and
growth/decay changes. The plan distinguishes outcome targets from tunable
parameters and prevents downstream match/economy tuning from compensating for
an upstream population error.

## 1. Authorities and non-negotiable rules

The controlling references are:

- `PLAYER_GENERATION_DEVELOPMENT_PLAN.md` for generation, career, population,
  economy, sample-size, and lifecycle requirements;
- `backend/config/game.config.jsonc` for current generation and career starting
  parameters;
- `backend/config/match-calibration-targets.json` for match outcome bands,
  tactical familiarity, and permanent player-loss contracts;
- production functions in `backend/src/game/playerGeneration.ts`,
  `careerCurves.ts`, `player.ts`, `population.ts`, and `matchSim.ts`.

Rules for every run:

1. Freeze the code and configuration snapshot before sampling.
2. Use committed fixed seeds and deterministic per-sample derivation.
3. Record both the configuration and the realized input population in every
   artifact.
4. Establish a baseline before changing any coefficient.
5. Tune one causal layer at a time: generation/career, population/economy, then
   match behavior.
6. Preserve paired-seed controls for symmetry, no-loss controls, and
   instant-vs-streamed determinism.
7. Do not add direct win-probability, score, or xG modifiers to compensate for
   an upstream distribution problem.

## 2. Target contract

### 2.1 Player generation outcomes

The current generation parameters are the starting candidate, not automatic
proof of balance:

| Metric | Target |
| --- | ---: |
| Full generated D1 senior population mean | 74 OVR |
| D1 senior quality spread | 5.5 OVR |
| Academy quality spread | 6 OVR |
| D1 automatic XI mean | about 80 OVR |
| D1 average weakest starter | about 73 OVR |
| D1 average strongest starter | about 87 OVR |
| D1-to-bottom-division population span | 18 OVR |
| Academy ages | 16, 17, 18, 19 only |

The documented five-division reference means are D1–D5: **74.0, 67.4,
62.6, 59.0, 56.0**, with ordered means and substantial adjacent-division
overlap. The illustrative D1 academy age means are approximately **60, 63,
65, 68** for ages 16–19, with P90/P99 approximately **69/76, 71/78, 73/80,
76/83**.

### 2.2 Career and development outcomes

The current `playerCareer` values are candidate model parameters:

- maximum growth budget: **30 OVR-equivalent points** at growth potential 1;
- maximum decline budget: **26 OVR-equivalent points** at decline potential 1;
- peak age: truncated-normal mean **27**, standard deviation **2.4**, bounds
  **23–33**;
- growth/decline potential and speed remain in **[0, 1]**;
- speed changes timing only, never total full-activity growth or decline;
- potential changes magnitude only;
- full starters develop more than rotation or inactive players;
- active veterans decline more slowly than inactive veterans;
- OVR is always recomputed from the seven skills;
- no second ceiling, growth tier, or development-rate capacity may add growth
  twice.

The piecewise densities and slow/fast curves in `game.config.jsonc` are the
reference distributions. There is no separate external numeric target for
every career trajectory; where the plan gives no empirical number, acceptance
is based on these invariants, the configured distributions, confidence bands,
and the resulting steady-state population.

### 2.3 Population and economy outcomes

- Target owned stock: **38 players per active persistent club**, senior plus
  academy.
- Minimum intake: **one academy player per active club per season**.
- Academy promotion: voluntary at **18–19**, mandatory at **20**.
- Academy-origin contract expiry: age **21**.
- No unexplained long-run population slope, ledger difference, or immediate
  dismissal reroll.
- Economy projections must derive from the accepted generation projection,
  including D1 full-squad/XI quality, representative meaningful and elite
  percentiles, wage bills, affordability, interventions, and insolvency.

### 2.4 Match outcomes and guardrails

The existing match target contract remains unchanged:

| Neutral D1-v-D1 population metric | Accepted band |
| --- | ---: |
| Goals | 2.4–3.0 |
| Shots | 22–27 |
| Shots on target | 7.5–10 |
| xG | 2.3–2.8 |
| Corners | 8.5–11.5 |
| Fouls | 22–31 |
| Yellows | 3.5–4.7 |
| Reds | 0.04–0.10 |
| Passes | 900–1050 |
| Injuries | 0.5–0.8 |

Additional match contracts remain:

- equal teams at equal familiarity (25, 50, 75, 90, 100) stay symmetric;
- familiarity affects the tactical component only and equal familiarity is
  neutral even away from 50;
- mirrored familiarity gaps reverse the effect without side bias;
- a zero player-loss control is bit-identical to its paired segmented control
  and remains inside the normal baseline;
- one-player loss uses the minute-15/30/45/60/75 outcome targets in
  `match-calibration-targets.json`;
- possession, passes, shots, and minute-60 xG follow the documented technical
  guardrails;
- two- and three-player loss severity is monotonic and heuristic relative to
  one-player loss;
- player loss affects outcomes through local formation/action/coverage and a
  capped workload mechanism, never through a direct win/xG modifier.

## 3. Phase 0 — freeze and instrument before sampling

1. Record the working-tree state, current configuration snapshot, target files,
   Node/runtime workaround if needed, and fixed seed set.
2. Verify that generated-player fixtures use `careerProfile`, current skills,
   current age, energy, and recent workload rather than legacy-only fields.
3. Keep two match harness modes:
   - **controlled-mechanics mode** with synthetic players for causal tests such
     as familiarity, player loss, and exact paired-seed behavior;
   - **production-population mode** built from the real generation functions.
4. Modernize `backend/scripts/match-calibration-next.ts` before official match
   sampling. It currently constructs fixed-strength, age-25 synthetic players,
   so its output cannot validate the new generated population by itself.
5. Make every artifact report sample count, seeds, generated population
   summary, division mix, age mix, energy state, and configuration digest.

**Gate:** no balance coefficient is changed and no official Monte Carlo run is
accepted until both harness modes reproduce deterministic paired controls.

## 4. Phase 1 — calibrate generation and hidden profiles

### Run matrix

- At least **500 complete generated clubs per division** for representative
  pyramid sizes.
- At least **50,000 career-profile draws** across fixed seeds.
- Measure full squads, automatic XI, weakest/strongest starters, position mix,
  age buckets, within-division spread, adjacent-division overlap, academy age
  cohorts, and elite-tail frequencies.

### Acceptance

- Apply the generation targets in §2.1.
- Verify ordered division means and the configured division curve.
- Verify the configured distributions, peak-age mean/spread/bounds/tails, and
  independence of raw birth-quality Z from career profile attributes.
- Tune only generation/career parameters here. Do not alter match coefficients
  to make generation metrics pass.

**Deliverables:** generation summary, profile-distribution summary, updated
golden only if the accepted behavior intentionally changes it, and a short
decision log for every parameter changed.

## 5. Phase 2 — calibrate career trajectories and development

### Run matrix

- At least **20,000 complete careers** across positions, activity archetypes,
  potential bands, speed bands, and peak-age bands.
- At least **10,000 player-period samples per position and training-focus
  family**, including skills near hard bounds and exhausted budgets.

### Acceptance

- Full-activity growth reaches the configured growth budget at the personal
  peak; speed changes timing only.
- Decline starts at the personal peak and reaches the configured decline budget
  under the reference activity; speed changes timing only.
- Growth not realized before the peak is not banked.
- Position/focus produces comparable OVR-equivalent movement without creating
  extra total growth.
- Skill-bound redistribution, fractional accumulators, and remaining-budget
  caps behave as documented.
- Active, rotation, inactive, and veteran activity orderings hold.
- The simulated steady-state age distribution matches the survival distribution
  used for initial senior generation.

**Gate:** no population, economy, or match calibration is interpreted until
this phase passes. A failed career trajectory is an upstream failure.

## 6. Phase 3 — calibrate population stability and economy

### Population run matrix

- At least **50 fixed-seed worlds for 100 active seasons**.
- Include changing active-club counts, retirements, free-agent retention and
  deletion, youth dismissal delay, senior replacements, blocked academies,
  dormant/reactivated clubs, provisional teams, and filler boundaries.

### Population acceptance

- Owned, free-agent, and total active stock stay statistically centered on the
  target.
- No unexplained slope or ledger residual exists.
- Every terminal event is compensated exactly once.
- Dormant, provisional, and filler boundaries contribute neither target stock
  nor correction.
- Seeded remainder allocation has exact totals, deterministic replay, and
  approximately uniform recipient frequency within a predeclared confidence
  band.

### Economy acceptance

- Recompute D1 and lower-division wage/value projections from the accepted
  generation projection.
- Sample generated, renewed, transferred, and free-agent contracts across OVR,
  age, term, season fraction, and current-salary bands.
- Measure wage bills, affordability, renewal rejection, transfers,
  interventions, insolvency, and release-clause behavior over multiple seasons.
- Tune economy parameters only after player-quality and population outputs pass.

**Gate:** the player population and wage economy must be stable before match
results are treated as representative of a season.

## 7. Phase 4 — recalibrate matches using production-generated populations

### Reference population construction

Build a deterministic representative world population from the production
generator, with accepted D1–D5 squads, academy players, position mix, age mix,
and current energy/recent-load states. Use the same reference population for
paired scenario comparisons so normalization does not become a hidden source
of variance.

### Match matrix

1. **Neutral baseline:** generated D1 vs generated D1 with identical or
   matched-strength squads; measure all §2.4 bands.
2. **Division strength:** D1/D1, D3/D3, D5/D5, D1/D5, and mirrored pairings;
   verify ordered strength response without inventing an unapproved result
   target for mixed divisions.
3. **Age and career state:** fresh generated squads, steady-state squads, and
   post-development squads with realistic energy and recent workload.
4. **Tactical familiarity:** equal 25/50/75/90/100, mirrored gaps 25 and 40,
   and all three styles.
5. **Energy/fatigue:** current energy scenarios plus repeated-match schedules
   using the new age and development distributions.
6. **Substitution behavior:** injury auto-sub, AI tactical substitution, no
   eligible substitute, and substitution-cap exhaustion.
7. **Permanent player loss:** no-loss controls; one loss at 15/30/45/60/75;
   two and three losses at early and mid-match times; role-local losses;
   substitution versus no remaining substitute.
8. **Determinism:** instant versus streamed execution, paired seeds, save/reload
   continuation, and regenerated golden fixtures.

### Match sample sizes

- Preflight: **100 samples per scenario** to catch harness and directionality
  failures.
- Official neutral baseline: **20,000 samples**.
- Official non-neutral scenarios: **5,000 samples per scenario**, unless a
  documented paired-control or high-cost long-run test has a separate approved
  size.
- Use confidence intervals and paired-seed comparisons; do not retune to move a
  metric by less than its sampling uncertainty.

### Match tuning order

1. Neutral tempo/action volume and global goals/xG/shots.
2. Cards, fouls, corners, passes, and injury rate.
3. Home advantage and division-strength response.
4. Energy/fatigue and age interaction.
5. Familiarity and tactical response.
6. Substitution and permanent player-loss response.

At each step, rerun the neutral control and the nearest affected scenarios.
Only after the focused result improves should the full confirmation matrix run.

## 8. Decision rules for tuning

- If generation metrics fail, tune generation/career only.
- If generation passes but generated neutral matches fail while the old
  synthetic harness passes, treat that as a population-integration issue first;
  do not immediately retune the engine.
- If both generated and controlled baselines fail, tune the match coefficient
  responsible for the shared metric.
- If neutral metrics pass but familiarity/loss/substitution metrics fail, tune
  only that causal subsystem.
- Preserve the 40/35/25 team/tactics/luck influence contract.
- Preserve identical-team neutrality at every equal familiarity level.
- Preserve one cause/one effect: no duplicated fatigue, injury, familiarity, or
  player-loss pathway.
- Keep every exploratory sweep in a candidate artifact. Only a confirmation
  run may update an authoritative report or golden.

## 9. Final acceptance and handoff

After all phases pass:

1. Run `cd backend && npm run build`.
2. Run `cd backend && npm test`.
3. Run `cd backend && npm run test:integration`.
4. Run `cd backend && npm run test:calibration`.
5. Run `cd frontend && npm run build`.
6. Run `git diff --check` and inspect status/diff for unrelated changes.
7. Update the target contract, calibration report, configuration comments,
   fixtures, and the next-run plan with exact seeds, sample sizes, means,
   confidence intervals, and remaining caveats.

The recalibration is complete only when the accepted parameters, generated
population, economy, and match engine have all passed their own gates and the
cross-system match run has passed using the production-generated population.
