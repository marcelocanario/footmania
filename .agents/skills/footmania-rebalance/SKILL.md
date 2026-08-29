---
name: footmania-rebalance
description: Audit, Monte Carlo calibrate, tune, and verify Footmania match simulation, player generation, career development, population, economy, energy, and injury balance. Use when game-system changes may have shifted statistical outcomes, when a balance target needs diagnosis, or when the user asks to recalibrate one domain or all domains. Do not use for ordinary deterministic bug fixes that have no balance or distribution impact.
---

# Footmania Rebalance

Rebalance the current production model against the repository's authoritative contracts. Treat calibration as a controlled experiment: freeze inputs, measure before tuning, isolate causes, change the smallest justified centralized tunable, and rerun the affected controls with the same seeds.

## Select scope and intent

Infer a scope from the request, or accept it explicitly after `$footmania-rebalance`:

- `match`: match volume, scoring, xG, possession, passing, discipline, home advantage, tactics, familiarity, AI tactics/substitutions, fatigue during matches, and permanent player loss.
- `player-generation`: senior/academy generation, natural-position mix, OVR distributions, division overlap, lineup quality, cohort bands, initial club value, and generation determinism.
- `career-development`: growth/decline budgets and timing, peak age, playing-time effects, training focus, retirement, and position-neutral OVR movement.
- `population`: long-run active population, free-agent stock, retirement/replacement flow, academy intake, blocked slots, and idempotency.
- `economy`: player value, salary, academy wage ratio, tier-budget anchors, initial-club value/payroll, and contract-demand guardrails.
- `energy-injury`: match fatigue, recovery, injury frequency, training injuries, severity mixture, lasting setbacks, and injury/substitution coupling.
- `all`: every scope above in dependency order.

Combine scopes when changes cross boundaries. Natural-position, skill-weight, OVR, roster, season-length, or player-quality changes normally require at least `player-generation + match`; career-curve changes normally require `career-development + population + economy`, and may require `match` if they change the live player-quality distribution.

Respect the requested intent:

- `audit`, `check`, or `do we need`: inspect and diagnose; do not tune production values.
- `plan` or `prepare`: produce the experiment and stop before Monte Carlo unless the user also authorizes execution.
- `calibrate`, `rebalance`, `proceed`, or `until correct`: run, diagnose, tune when justified, and verify to completion.
- An explicit instruction to stop before a phase always wins.

## Load only the needed guidance

Always read [references/shared-method.md](references/shared-method.md).

Then read the references for the selected scope:

- Match: [references/match.md](references/match.md)
- Player generation: [references/player-generation.md](references/player-generation.md)
- Career, population, or economy: [references/career-population-economy.md](references/career-population-economy.md)
- Energy or injury: [references/energy-injury.md](references/energy-injury.md)
- All: read every reference above plus [references/all.md](references/all.md)

## Non-negotiable repository rules

Before acting, read the repository-root `AGENTS.md`. For any model change, read the relevant sections of `BUSINESS_RULES.md` and `backend/src/game/INVARIANTS.md` and preserve them.

- Assume other agents and the user are changing the shared worktree. Inspect `git status` and relevant diffs before editing; reread a file immediately before patching it.
- Never reset, checkout, clean, stage, commit, kill shared processes, delete another run's artifacts, or overwrite unrelated changes.
- Calibration and broad backend test runs are exclusive shared resources. Check for an active run and never launch overlapping calibrations or duplicate suites.
- Keep balance values in centralized configuration. Do not hard-code a coefficient inside game logic.
- Preserve one cause, one effect. Do not compensate for one imbalance by adding a second hidden pathway or direct win/score modifier.
- Reuse production generation, lineup, match, economy, development, and population authorities. A prototype or synthetic shortcut cannot certify production balance.
- New behavior needs tests, but do not weaken acceptance assertions merely to make a candidate pass.

## Evidence hierarchy

Use this order when evidence conflicts:

1. Current coded invariants and formulas in `BUSINESS_RULES.md` and `backend/src/game/INVARIANTS.md`.
2. Target contracts and configuration comments committed before the run.
3. Current calibration assertions and deterministic goldens.
4. Fresh same-revision production-path Monte Carlo artifacts with frozen seeds and input snapshots.
5. Historical artifacts, reports, or remembered results only as comparison context.

A stale JSON artifact never overrides current target bands or current code. If targets are missing or internally inconsistent, say so and establish or research a target before tuning; do not infer a target from the candidate output.

## Required calibration behavior

1. Map the code change to affected outputs and downstream domains.
2. Freeze the source revision, dirty-file inventory, configuration, target contract, seeds, scenario list, input mode, and sample counts. If source or config changes during a run, mark that artifact stale and rerun.
3. Start with deterministic invariants and low-cost smoke samples, then use production generated inputs and decision-grade samples.
4. Use identical or paired controls to remove quality, home/away, AI tactic-selection, season-state, and seed confounds.
5. Diagnose the causal stage that moved before selecting a tunable. Distinguish volume, quality, conversion, composition, symmetry, and long-run-flow failures.
6. Sweep candidates in memory where a harness supports overrides. Use the same seeds and change one causal coefficient family at a time.
7. Promote only a candidate supported by the full scorecard. A local improvement that breaks another target is not a solution.
8. Rerun the final configuration at a larger sample, then run affected calibration tests once at the end. Regenerate deterministic goldens only after an intentional accepted behavior change.
9. Record exact commands, samples, seeds/digests, metrics versus targets, changed files/values, failed candidates, verification results, caveats, and whether any target remains unresolved.

## Tuning stop conditions

Stop tuning when the final production-path run is inside all material target bands, symmetry/control contracts pass, secondary guardrails have not regressed, and remaining deviations are smaller than sampling uncertainty or explicitly accepted tolerances.

Do not tune to the last decimal. Increase the sample or rerun an adjacent seed block when a result sits near a boundary. If two runs disagree beyond expected sampling noise, investigate fixture/input drift before touching production logic.

If a target can be met only by violating an invariant, double-counting an effect, introducing a direct result modifier, or breaking another authoritative target, do not force it. Report the conflict and identify whether the target, model pathway, or evidence definition needs revision.

## Completion contract

Do not call the system balanced merely because a command completed. A complete handoff states separately whether each selected domain is:

- calibrated and verified;
- calibrated with a quantified watch item;
- not affected, with evidence;
- or unresolved/blocked, with the exact missing evidence or failing contract.

For `all`, use the matrix and final gates in [references/all.md](references/all.md). Do not claim `all` is complete if any domain is omitted.
