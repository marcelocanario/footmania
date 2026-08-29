# Shared calibration method

Read this reference for every invocation.

## 1. Frame the question before running anything

State four things explicitly:

1. **Scope:** which balance domains can plausibly move.
2. **Change:** what source/config/data change triggered the audit.
3. **Proof:** which metrics and controls would show the model is still correct.
4. **Authority:** where the target was defined before the candidate output existed.

Build an impact chain from changed input to downstream outputs. Typical chains:

- natural positions or skill weights -> generated composition/OVR -> lineup quality -> match action quality -> value/salary/population projections;
- career curves -> standing age/OVR distribution -> retirement flow -> population target -> value and payroll -> match quality;
- match timing/action volume -> shots/passes/fouls/corners -> injury exposure -> fatigue/substitutions;
- season length -> payroll and training/injury opportunities -> economy and career cadence.

Do not assume a large refactor changes calibration, and do not assume a formula-preserving refactor is neutral. Prove neutrality with fixed-seed controls and aggregate checks.

## 2. Preflight the shared workspace

Before edits or expensive commands:

- Read root `AGENTS.md` and the relevant diff.
- Record `git status --short` and the exact changed files in scope.
- Check for active Node/Vitest/calibration/build processes. Never kill or replace another run.
- Treat backend calibration, integration tests, database tests, builds, generated output, ports, and caches as shared/exclusive resources.
- Reread every file immediately before patching it.
- Preserve all unrelated dirty and untracked files.

If the user changes source/config while Monte Carlo is running, let the current process finish only if useful as an explicitly stale diagnostic; do not promote its artifact. Rebuild the input snapshot and rerun the decisive comparison.

## 3. Establish the evidence contract

Read current authorities; never copy a historical report's targets forward without checking them.

- Rules/formulas: `BUSINESS_RULES.md`.
- Multiplayer and model invariants: `backend/src/game/INVARIANTS.md`.
- Core tunables and comments: `backend/config/game.config.jsonc` plus its schema in `backend/src/config.ts`.
- Match tunables and validation: `backend/config/match-simulator.jsonc` and `backend/src/matchSimulatorConfig.ts`.
- Match target contract: `backend/config/match-calibration-targets.json`.
- Statistical acceptance: `[calibration]` tests selected by `backend/vitest.calibration.config.ts`.
- Deterministic behavior: current golden tests/fixtures.

When a target is absent:

1. Search code, comments, plans, tests, and prior accepted reports.
2. Distinguish a real-world target from a game-design choice and from a structural invariant.
3. For real-world claims, research primary empirical sources when current data is actionable and record the source, population, definition, and uncertainty.
4. Write/freeze the target contract before seeing tuning results.
5. If no defensible numeric target exists, use a directional/monotonic guardrail and label it heuristic.

Never redefine a target because the current output misses it.

## 4. Freeze inputs

Every decision-grade artifact must identify:

- date and source revision when available;
- dirty files relevant to the run;
- target schema/version and target file content or digest;
- complete relevant configuration or digest;
- harness version;
- production versus synthetic input mode;
- generated population parameters;
- scenarios, seeds, start offset, and sample counts;
- command and environment overrides;
- output file path.

Prefer harnesses that embed an input snapshot and digest. Use task-unique output names; never overwrite the last accepted artifact during exploration.

## 5. Experimental design

Use the smallest experiment that isolates the suspected cause:

- **Exact no-op:** same seed and inputs must be bit-identical when the tested factor is neutral.
- **Identical-side control:** clone team/player quality and vary only venue, tactics, familiarity, energy, or player availability.
- **Mirrored pair:** run A-vs-B and B-vs-A with the same seed family to detect side bias.
- **Paired candidate:** baseline and candidate use the same seeds; compare per-seed deltas when raw rows exist.
- **Production-path population:** certification uses generated players, real lineup selection, real formulas, and the real save/domain boundary when relevant.
- **Synthetic fixture:** use only to isolate a mechanism or reproduce a regression. It cannot certify population balance.

Prevent common confounds:

- AI tactic selection replacing requested tactics;
- two independently generated squads in a tactical-symmetry test;
- home advantage in a neutral comparison;
- regenerated clubs/players between candidates;
- different seed blocks or sample sizes;
- substitutions masking permanent player loss;
- a nominal zero-loss match using a different tick cadence;
- changing several coefficient families together;
- evaluating goals without checking xG, shots, and conversion.

## 6. Sample ladder and uncertainty

Preserve existing test sample sizes. For new Monte Carlo work, use staged samples:

1. **Dry run / deterministic checks:** zero simulations; validate scenarios, paths, target snapshot, and digest.
2. **Smoke:** roughly 25-100 observations per scenario to catch gross direction or harness errors.
3. **Screening:** roughly 100-300 paired observations per candidate for broad sweeps.
4. **Confirmation:** usually 500-1,000+ production-path observations for primary aggregate metrics; increase for rare events such as red cards, injuries, retirements, or tails.
5. **Long-run flow:** use multiple seeds and enough seasons/worlds to expose accumulation and boundary drift.

These are starting points, not universal constants. Use the configured calibration tests and observed variance to choose larger samples.

Quantify uncertainty when a point estimate is near a band:

- proportion standard error: `sqrt(p * (1 - p) / n)`;
- mean standard error: sample standard deviation divided by `sqrt(n)`;
- for paired experiments, calculate uncertainty on paired deltas, not two independent means;
- exact-control failures are not sampling noise.

Do not tune a metric by less than its plausible sampling uncertainty. Rerun a larger or adjacent seed block first.

## 7. Diagnose before tuning

Locate the first causal stage that diverged:

1. deterministic input/config/target;
2. generated composition or player quality;
3. lineup/role assignment and out-of-position penalties;
4. opportunity or event volume;
5. action/shot quality;
6. conversion/outcome sampling;
7. long-run stock/flow accumulation;
8. presentation/report aggregation.

Examples:

- Goals low, xG and shots correct: likely sampling or conversion, not tempo.
- Goals and xG low, shots correct: shot quality pathway.
- Goals, xG, shots, and passes all high: event volume/tempo.
- Only generated teams fail while synthetic controls pass: generation scale, lineup, normalization, or role composition.
- Tactics fail only with AI clubs: pre-match AI selection confound.
- Population misses while per-event counters pass: stock/flow residence, target boundary, or seasonal accumulation.
- Injury frequency moves after match-volume tuning while severity stays correct: exposure hazard, not severity distribution.

## 8. Candidate sweeps and promotion

- Prefer in-memory/environment overrides where supported; do not edit production config for each sweep point.
- Use coarse bracketing, then narrow around the best region.
- Change one causal coefficient family at a time. Two values may move together only when they are a documented coupled parameterization and the run can identify both effects.
- Track every candidate's primary target, secondary guardrails, symmetry, and causal plausibility.
- Reject candidates that fix one metric by moving another out of band or by weakening the intended team/tactics/position signal.
- Promote the smallest stable change in centralized config.
- Add a schema field and config comment when a genuinely new tunable is required; never bury a balance literal in game code.
- Update `BUSINESS_RULES.md` only when implemented behavior changes, not to rationalize a failed candidate.

Do not introduce direct win, score, xG, value, or population modifiers when the model contract requires those outcomes to emerge from lower-level pathways.

## 9. Runtime fallback without changing semantics

Use repository scripts normally. If `tsx` cannot start because of a host/runtime error such as `uv_os_get_passwd ... ENOMEM`, do not change production code and do not kill unrelated Node processes.

When local `esbuild` is already installed, bundle the existing script to a task-unique temporary `.mjs`, preserving Node externals, run it with Node, and remove only that exact temporary bundle after all dependent runs finish. Record the fallback command. The bundled script must use the same source/config revision as the artifact.

## 10. Verification and reporting

After the final promotion, run applicable builds/tests once, following root `AGENTS.md`. Do not run the broad suite after every candidate.

The final report must include:

- scope and trigger;
- authorities and targets used;
- baseline and final sample sizes/seeds/digests;
- compact target-versus-result scorecard;
- symmetry/no-op/monotonic controls;
- candidates tried and why they were rejected;
- exact production changes and causal rationale;
- golden regeneration, if any, and why it was legitimate;
- build/test results, separating assertion failures from environment failures/timeouts;
- watch metrics and unresolved target conflicts;
- artifact paths;
- confirmation that unrelated work was not staged, reverted, or committed.

Classify the outcome per domain: `PASS`, `PASS — WATCH`, `NOT AFFECTED`, or `UNRESOLVED`.
