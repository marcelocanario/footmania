# Player-generation calibration

Use this reference for senior and academy generation, new natural positions, skill/OVR weighting, roster templates, initial cohorts, and any change that can alter the quality or composition of generated players.

## Authorities and implementation map

Read current versions of:

- `backend/config/game.config.jsonc` and the corresponding schema/defaults in `backend/src/config.ts`;
- `backend/src/game/positions.ts`, `rating.ts`, `playerGeneration.ts`, `careerCurves.ts`, and `generationProjection.ts`;
- `backend/src/game/economy.ts` when generation quality feeds value or salary;
- `backend/scripts/generation-calibration.ts` and `backend/scripts/generation-sweep.ts`;
- `backend/tests/playerGeneration.test.ts`, `generationGolden.test.ts`, `naturalPositions.test.ts`, `rng.test.ts`, `contractEconomy.test.ts`, and relevant world-generation tests;
- the generation, natural-position, OVR, and initial-world sections of `BUSINESS_RULES.md` and `backend/src/game/INVARIANTS.md`.

Treat current config comments and calibration assertions as the target contract. Numeric values can change; reread them rather than copying values from an old report. In particular, distinguish:

- the mean of the complete generated senior population from peak-age quality;
- marginal skill distributions from position-weighted OVR;
- initial conditioned cohorts from ordinary replacement/youth draws;
- a historical comparison baseline from a current acceptance target.

## Required scorecard

For every affected division and cohort, measure at least the applicable items below.

### Senior generation

- complete-population OVR mean, standard deviation, quantiles, minimum/maximum, and division separation;
- adjacent-division overlap and monotonic ordering;
- age-bucket means and the implied standing-population age mix;
- raw-Z mean, spread, clipping/tail behavior, and independence from unrelated draws;
- natural-position counts versus configured roster-template weights;
- per-position OVR and skill means, with enough samples to detect a newly introduced position being systematically advantaged or starved;
- automatic-XI mean, weakest starter, strongest starter, and position completeness through the production lineup shape;
- deterministic equality for fixed seeds when the intended change is representational only.

### Academy and replacement generation

- current and projected peak quality by pedigree/division;
- age, position, profile, and raw-Z distributions;
- conditioned initial-academy cohort bands separately from recurring academy intake;
- survival/activity reconstruction used to derive current quality from a target peak;
- no impossible skill/OVR values and no unintended concentration at clamps.

### Initial-club guardrails

- senior and academy counts;
- full-club value, senior value, and payroll against configured targets;
- lineup completeness and legal position coverage;
- reproducibility through the production batch/blueprint-pairing path.

Do not certify only the aggregate mean. A correct mean can hide wrong tails, position mix, lineup strength, division overlap, or economy.

## Harness procedure

From `backend`, inspect the scripts before running because their arguments and report sections may evolve.

The production report currently has this shape:

```powershell
npx tsx scripts/generation-calibration.ts 500 5
```

The first argument is clubs per division and the second is the number of divisions. Use a small count for smoke validation, then a larger fixed count and seeds for the decision artifact. Certification must call production generation paths, not a hand-written Gaussian proxy.

The current candidate sweep has this shape:

```powershell
npx tsx scripts/generation-sweep.ts 250
```

Use it only for the coefficient family it actually sweeps. Inspect whether it mutates the in-memory config and whether every derived value is recomputed per candidate. Keep candidate inputs fixed and record the resulting production parameters before promotion.

`backend/scripts/capture-generation-baseline.ts` is a one-shot pre-change oracle capture, not a routine recalibration command. Do not run it after a behavior change to bless the new output. Regenerate a deterministic generation golden only when the contract intentionally changes, the statistical scorecard passes, and the old oracle is no longer the intended behavior.

If a new position is introduced, extend the harness and scorecard before tuning. A report that silently omits the position cannot prove balance.

## Causal tuning map

- **Population mean wrong at every position:** inspect the configured top-division mean, division projection, standing-age reconstruction, and derived senior peak offset.
- **Mean correct, XI/tails wrong:** inspect quality spread, roster composition, pairing/conditioning, clipping, and lineup selection. Do not move the mean to repair spread.
- **Only one position's OVR is biased:** inspect that position's authoritative OVR weights and generated skill covariance. Do not add a position-specific final-OVR correction unless the design explicitly defines one.
- **New position is too rare or common:** change centralized natural-position/template weights and verify both senior and academy paths.
- **Initial cohorts fail but marginal generation passes:** inspect cohort conditioning, blueprint pairing, roster slots, and initial activity assumptions.
- **Academy current quality fails but peak quality passes:** inspect age/activity reconstruction and career curves, not the peak anchor.
- **Raw-Z or profile correlations appear:** inspect RNG stream separation and pairing. Do not tune away a deterministic coupling with distribution means.
- **Value/payroll moves while quality is correct:** treat it as an economy consequence; do not distort generated OVR to recover money targets.

`seniorPeakOverallOffset` is derived when the configured population mean is the definition. Solve it from the standing age mix after choosing the population mean and spread; do not treat all three as independent free knobs.

## Cross-domain triggers

After accepting a generation change:

- run `match` whenever OVR scale, skill weights, position availability, lineup composition, energy/athletic inputs, or player-quality spread changed;
- run `career-development` when current quality reconstruction, profile generation, age mix, or peak assumptions changed;
- run `population` when roster size, academy intake, retirement lifetime, or generation flow changed;
- run `economy` when quality, age, career output, initial cohorts, or roster composition changed.

A fixed-seed match golden can change after generation changes even when match probabilities did not. First show that the match engine is unchanged for identical explicit player inputs, then decide whether a generated-input golden should intentionally move.

## Acceptance and final verification

Promote only centralized config or an intentional formula correction. Rerun the full production report with a larger independent seed/sample block and verify all positions and divisions, not just the tuned D1 row.

At the end, run the affected calibration tests once, including player generation and RNG/position tests where applicable, plus the backend build/default suite required by `AGENTS.md`. Report separately:

- distribution and lineup acceptance;
- deterministic golden status;
- economy and match downstream status;
- any tail or rare-position watch item whose uncertainty remains material.
