# Match calibration

Use this reference for match engine, tactics, familiarity, substitutions, match fatigue/injuries, and permanent-player-loss work.

## Authorities and implementation map

Read current versions of:

- `backend/config/match-calibration-targets.json` — pre-run aggregate, familiarity, and player-loss contract.
- `backend/config/match-simulator.jsonc` — match tunables.
- `backend/src/matchSimulatorConfig.ts` — schema and validation.
- `backend/src/game/matchSim.ts` — action/shot/formation/fatigue implementation.
- `backend/src/game/match.ts` and `backend/src/game/club.ts` — live/instant orchestration, lineup and AI tactic selection.
- `backend/scripts/match-calibration-next.ts` — current controlled harness; inspect its `HARNESS_VERSION`, scenario lists, and environment interface before running.
- `backend/tests/engine.test.ts`, `backend/tests/matchSimulator.test.ts`, `backend/tests/familiarity.test.ts`, AI tactic/substitution tests, live-match tests, and `backend/tests/matchNeutrality.test.ts`.
- `backend/tests/fixtures/match-golden.json` and `backend/scripts/regenerate-match-golden.mts`.
- Match, fatigue, player-loss, and familiarity sections of `BUSINESS_RULES.md` and `backend/src/game/INVARIANTS.md`.

The JSON target contract controls even when an older artifact is named `final`. Confirm its status/version before the run.

## Required scenario matrix

Choose the affected rows; `all` match calibration includes every category.

### Core production balance

- generated `identical-neutral` at the reference division;
- generated `identical-home-away` for home advantage;
- stronger-versus-weaker quality signal;
- neutral and non-neutral volume metrics;
- deterministic instant/live replay.

Score goals, shots, shots on target, xG, corners, fouls, yellows, reds, passes, injuries, possession, home/away splits, result distribution, and relevant energy/load diagnostics against the current contract/tests.

### Tactics and familiarity

- CONTROL/PRESS/COUNTER matrix with fixed identical player quality;
- pressing/card and turnover signatures;
- equal familiarity at every configured target level;
- mirrored 25- and 40-point familiarity gaps or the current configured gaps;
- equal familiarity must be neutral at any absolute level;
- familiarity may scale only the tactical component, never team strength or result directly.

Use human/fixed-tactic controls when the test is intended to measure a requested tactic. Otherwise AI pre-match selection can replace the fixture and invalidate the conclusion.

### Energy, deployment, and substitutions

- energy levels and fatigue-performance direction;
- out-of-position deployment through production lineup/role logic;
- planned substitution versus no substitution;
- AI tactic/substitution behavior with only information the AI can observe;
- instant versus streamed live-match equivalence.

### Permanent player loss

- paired zero-loss rows at every tested minute: exact no-op;
- one average player lost at minutes 15, 30, 45, 60, and 75;
- role-local losses where the contract calls for them;
- two and three players lost at representative early/late minutes;
- injury with no available substitute uses the same departure mechanism;
- remaining-player workload is separately capped and exactly neutral at eleven players.

Clear the bench after an injected permanent loss when the scenario means no remaining substitutes. Use the same tick cadence and added-time handling for zero-loss and loss rows.

Win probability must emerge from formation support, local action execution, progression, shot quality, and fatigue. Never add a direct win/score modifier. Multiple losses reuse the same local mechanism and must worsen monotonically.

## Harness procedure

From `backend`, first inspect the script's current environment variables. The current harness supports:

- `MATCH_SIM_INPUT_MODE=generated|synthetic`;
- `MATCH_SIM_ONLY=<comma-separated scenarios>|all`;
- `MATCH_SIM_DRY_RUN=1`;
- `MATCH_SIM_BASELINE_COUNT`, `MATCH_SIM_COUNT`, and `MATCH_SIM_START`;
- generated population/division controls;
- `MATCH_SIM_OUTPUT=<task-unique artifact>`;
- `MATCH_SIM_OVERRIDE="path=value,..."` for in-memory candidate sweeps.

Run a dry input freeze before Monte Carlo. Use `generated` for certification. Keep the generated population and seed block fixed across candidates.

Typical PowerShell shape, adapted to the current request:

```powershell
$env:MATCH_SIM_INPUT_MODE = "generated"
$env:MATCH_SIM_ONLY = "identical-neutral"
$env:MATCH_SIM_COUNT = "200"
$env:MATCH_SIM_DRY_RUN = "1"
$env:MATCH_SIM_OUTPUT = "F:\Projects\Footmania\plans\match-calibration-<task>-dry.json"
npm run calibrate:match
```

Remove `MATCH_SIM_DRY_RUN` for the simulation. For a candidate, add a narrow `MATCH_SIM_OVERRIDE`; do not edit production config between sweep points. Clear task-specific environment variables after the run when the shell will be reused.

Do not run `MATCH_SIM_ONLY=all` at the harness defaults without estimating the total match count and runtime. Stage category runs and preserve one input digest.

## Causal tuning map

Diagnose with the full metric vector before choosing a field:

- **All action counts high/low:** timing/tempo and quality-volume normalization. Check passes, shots, fouls, corners, possession time, and match duration together.
- **Passes only:** tactical pass intent or pass execution; do not use shot conversion.
- **Corners only:** restart/corner calibration after confirming shot/restart volume.
- **Fouls/cards:** foul exposure first, then card conditional probabilities. Do not tune cards to hide a foul-rate error.
- **Shots correct, xG wrong:** shot location/pressure/finisher-GK/density quality.
- **xG correct, goals marginally wrong:** quantify Bernoulli sampling uncertainty before tuning conversion.
- **Generated inputs fail but synthetic pass:** generation quality, lineup selection, role suitability, or high-quality normalization.
- **Home/away asymmetry:** separate venue advantage from fixture/team/seed bias.
- **Familiarity:** adjust only its tactical influence path and verify equal-level neutrality plus mirrored gaps.
- **Player loss:** formation support/local density/progression for possession and xG; capped workload for fatigue. Avoid global coefficients that damage eleven-player neutral balance.
- **Match injuries:** first confirm action/exposure volume. Use the centralized injury target rather than embedding a hazard correction in match logic.

When changing a shared coefficient, rerun neutral volume plus every special scenario that uses the same pathway.

## Acceptance and promotion

The final production-path neutral run must satisfy the current target bands or have a quantified near-boundary watch item smaller than sampling uncertainty. Exact controls, symmetry limits, monotonic player-loss rules, and deterministic replay are hard gates.

For player-loss outcomes, compare the correct definitions:

- disadvantaged possession/passes/shots relative to the paired zero-loss baseline;
- disadvantaged-minus-advantaged xG difference or the exact definition documented in the target contract/report;
- eleven-player win/draw/ten-player win at each minute;
- two/three-player severity relative to one-player severity using one consistent metric and paired baseline.

Do not silently switch definitions to make a row pass.

## Final verification

After promotion:

1. Run a decision-size generated neutral sample.
2. Rerun affected familiarity/loss/tactical rows with the final config.
3. Run the focused match calibration tests once.
4. If accepted behavior changes fixed-seed outputs, regenerate the match golden intentionally and run `tests/matchNeutrality.test.ts`.
5. Run the backend build and required default tests according to `AGENTS.md`.

Never regenerate a golden to conceal an unexplained mismatch. First show that the behavior change is intentional and statistically accepted.
