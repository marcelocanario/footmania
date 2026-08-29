# Energy and injury calibration

Use this reference for match fatigue, between-match recovery, recent load, match/training injury frequency, injury severity, lasting setbacks, and the interaction among injuries, substitutions, player availability, and match volume.

## Authorities and model layers

Read current versions of:

- energy, calendar, substitution, and injury settings in `backend/config/game.config.jsonc` and `backend/src/config.ts`;
- `backend/src/game/data/energy-injury-model.json` and its schema/loader in `backend/src/game/energyInjury.ts`;
- match exposure and fatigue paths in `backend/src/game/matchSim.ts`, `match.ts`, and daily recovery/training injury logic in `daily.ts`;
- AI/automatic substitution code where injury removal changes availability;
- `backend/tests/energyInjury.test.ts`, `calibration.energyInjury.test.ts`, `skillSemantics.test.ts`, AI substitution tests, match tests, and persistence tests for injury resume behavior;
- injury and energy sections of `BUSINESS_RULES.md`, `backend/src/game/INVARIANTS.md`, and the current match target contract.

Separate four layers before tuning:

1. **Exposure:** minutes/actions/load opportunities.
2. **Hazard:** probability of an injury given exposure and player risk factors.
3. **Severity:** duration distribution conditional on an injury.
4. **Consequence:** missed availability, recovery ceiling, auto-substitution/permanent loss, lasting setback, and match-performance effects.

A change in match duration or action volume can move realized injury frequency without changing hazard or severity code. Diagnose that coupling before editing the injury model.

## Required scorecard

### Energy and fatigue

- energy cost by minutes, role/action load, tactics/pressing, extra time, and substitution minute;
- halftime/end-match behavior and instant/live equivalence;
- between-match recovery by spacing and injury recovery ceiling;
- recent-load accumulation/decay and season cadence;
- performance monotonicity at representative energy levels;
- exact neutrality at full/no-added load;
- remaining-player workload after permanent player loss, with the eleven-player multiplier exactly neutral and configured caps respected.

Do not allow a skill irrelevant to athletic workload to enter fatigue or injury risk merely because it exists on every player. Preserve the current semantic exclusion rules, including Playmaking where documented.

### Injury frequency

- match injuries per match on production match inputs;
- training injuries per club-season/day opportunity;
- risk ratios for energy, recent load, age, and any other documented public factor;
- no event when hazard is zero and monotonic response to each risk factor;
- exposure-normalized hazard as well as raw observed frequency.

### Severity and lasting effects

- configured severity-bucket shares and uncertainty;
- mean, median, upper quantiles, minimum/maximum, and heavy-tail visibility;
- game-day versus real-day conversion under the current calendar;
- fatigue/load neutrality of severity if those factors are defined to affect incidence only;
- lasting-setback frequency, duration threshold, magnitude, affected skill weights, and rarity;
- no lasting setback at or below the configured short-injury threshold.

Rare severe injuries and lasting setbacks need substantially larger samples than common match-volume metrics. Do not tune their point estimates from a smoke run.

## Experimental design

- Hold severity RNG inputs fixed while varying exposure/hazard factors; conditional duration should remain unchanged when required.
- Hold match fixtures/seeds fixed while varying match injury target or match-volume candidate.
- Compare substituted injury removals with no-bench permanent-loss scenarios; do not mix the two consequences.
- Test the same player at controlled energy/load/age levels for risk monotonicity.
- Use deterministic boundary rows for injury expiry, recovery ceiling, auto-substitution, and persistence resume.
- Pair standard-time and extra-time fixtures when match duration is the suspected trigger.
- For season frequency, use production schedule spacing and multiple seeds; a daily synthetic rate alone does not certify the seasonal target.

## Causal tuning map

- **Match injury count moves with shots/passes/fouls:** exposure/action volume first; do not compensate by changing severity.
- **Exposure-normalized match hazard wrong:** centralized match injury target or hazard normalization.
- **Training frequency wrong, match frequency correct:** training opportunity denominator or training target, not shared severity.
- **Severity bucket shares wrong but incidence correct:** versioned severity mixture/scale.
- **Only real-time duration wrong:** calendar conversion, not injury event probability.
- **Low energy raises severity unexpectedly:** unintended coupling between hazard inputs and conditional duration.
- **Permanent loss causes excessive fatigue:** remaining-player workload redistribution/cap; preserve exact eleven-player neutrality.
- **Injury removals distort results beyond loss controls:** substitution availability, local formation support, or permanent-loss mechanism; use the match guide rather than adding a direct result penalty.
- **Lasting setbacks too frequent:** threshold/probability path and event denominator. Do not weaken all injury incidence.

Keep frequency targets in centralized game config and the conditional injury shape in the versioned injury model where that is the established authority. Avoid a second correction in match orchestration.

## Acceptance and verification

Accept only when frequency targets, risk-factor direction, severity mixture, recovery behavior, and consequence controls all pass together. A correct overall injury count can hide a wrong severity mix or risk distribution.

After promotion:

1. rerun the focused energy/injury calibration sample with an independent seed block;
2. rerun affected production match rows, including extra time, substitutions, and player loss;
3. run focused deterministic and calibration tests once;
4. run persistence/integration tests when injury state or resume boundaries changed;
5. run the backend build/default suite required by `AGENTS.md`.

Report match and training frequencies separately, and label severity/lasting-setback uncertainty when rare-event sample size remains limited.
