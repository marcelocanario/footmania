# Full-system (`all`) recalibration

Use this reference only when the user requests `all` or when the impact map genuinely spans every balance domain. `all` means every domain is audited and assigned an evidence-backed status; it does not mean every domain must be tuned.

## Freeze one campaign

Before any expensive run, create a campaign manifest in a task-unique artifact/report location containing:

- source revision and relevant dirty-file inventory;
- target/config/harness digests;
- selected production input snapshot and seed blocks;
- per-domain scenario/sample ladder;
- expected commands, artifacts, and runtime scale;
- domain dependency map and stop-before boundaries from the user;
- shared-resource check showing no conflicting calibration/test/build is active.

If code, config, targets, or production inputs change during the campaign, identify exactly which completed artifacts became stale. Do not rerun unaffected domains automatically; do rerun every downstream certification that consumed the changed input.

## Dependency order

Run the campaign in this order unless the impact map proves a narrower dependency:

1. **Deterministic contracts and harness dry runs** — schemas, fixed seeds, scenario discovery, target snapshots, exact no-op controls.
2. **Player generation** — accepted quality scale, natural-position composition, initial cohorts, lineup completeness.
3. **Career development** — accepted trajectories, peak/lifetime budgets, age-quality reconstruction.
4. **Population** — accepted lifetime-derived intake and long-run stock/flow.
5. **Economy** — value, salary, payroll, and budget anchors using accepted production players.
6. **Energy/injury** — exposure, fatigue, recovery, injury frequency/severity/consequences.
7. **Match** — production generated inputs after upstream player quality, positions, energy, availability, and injury exposure are stable.
8. **Final cross-domain verification** — focused calibration tests, deterministic goldens, build/default tests, and applicable integration tests.

Match is deliberately late because it consumes player distributions and energy/injury behavior. Economy follows generation/career because it prices their output. Population follows career because expected active lifetime is an input to replacement demand.

Within a domain, use dry/smoke/screening/confirmation stages from `shared-method.md`; do not launch all full-size suites at once. Never overlap exclusive calibration, integration, build, or broad test runs with another agent.

## Campaign decision matrix

Maintain one row per domain:

| Domain | Trigger/impact path | Authority/targets | Baseline artifact | Controls | Candidate/final artifact | Downstream reruns | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Player generation | | | | | | | |
| Career development | | | | | | | |
| Population | | | | | | | |
| Economy | | | | | | | |
| Energy/injury | | | | | | | |
| Match | | | | | | | |

Allowed statuses are:

- `PASS` — in contract with required controls and final verification;
- `PASS — WATCH` — accepted, with a quantified near-boundary or rare-event uncertainty;
- `NOT AFFECTED` — fixed-seed/aggregate evidence shows the domain did not move and no downstream target was consumed differently;
- `UNRESOLVED` — a contract, evidence source, environment, or invariant conflict remains.

Do not mark a domain `NOT AFFECTED` merely because no file in its directory changed. Use the impact chain and production-path evidence.

## Tuning and invalidation rules

- Tune one causal coefficient family at a time and preserve same-seed candidate comparability.
- An upstream promotion invalidates downstream artifacts that consumed that upstream output.
- A match-only config promotion normally does not invalidate generation/career/population/economy, but can invalidate match injury exposure and energy outcomes.
- A generation or OVR-weight promotion normally invalidates generation-dependent economy and match certification.
- A career/lifetime promotion normally invalidates population and economy, and may invalidate match if the standing quality distribution changes.
- A season/calendar promotion can invalidate career cadence, population flow, economy timing, injury opportunities, energy recovery, and match scheduling assumptions.
- A deterministic golden is regenerated only after the corresponding statistical and invariant contract is accepted.

If one domain fails, continue safe independent audits when useful, but do not certify a downstream domain against known-invalid upstream inputs. Label such runs diagnostic.

## Final gates

After all production values are promoted and no further tuning is planned:

1. reread the final relevant diffs and confirm values live in authoritative config/formulas;
2. run the affected calibration suite once at the final state;
3. run `npm run build` and `npm test` in `backend` as required by `AGENTS.md`;
4. run `npm run test:integration` when persistence, season rollover, workers, or real application boundaries changed;
5. use `npm run test:all` only for explicit release/broad validation and only when the shared workspace is clear;
6. build the frontend only when changed types/contracts/UI require it;
7. inspect git status/diff and confirm no unrelated file was staged, reverted, overwritten, or committed.

Follow the current `backend/package.json`; script names in this reference are not permission to bypass updated repository policy.

## Required final report

Lead with whether every domain is balanced now. Include:

- the completed campaign matrix;
- exact current targets used and where they came from;
- baseline/final commands, samples, seeds or digests, and artifact paths;
- compact result-versus-target scorecards per domain;
- exact no-op, symmetry, monotonic, determinism, persistence, and stock/flow controls;
- candidates rejected and causal reason;
- every production file/value/formula changed, including documentation/goldens;
- final tests/builds with pass, assertion failure, timeout, or environment failure distinguished;
- quantified watch items and the next sample that would resolve them;
- confirmation that shared/user changes were preserved.

Do not say “all calibrated” if a matrix row is missing, only smoke-tested, tested with synthetic inputs alone, based on stale artifacts, or unresolved.
