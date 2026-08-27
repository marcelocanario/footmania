# Footmania — Player Match Ratings & Performance History Plan

## 1. Goal

Add a SofaScore-inspired player performance rating to Footmania without changing match outcomes and without adding any tunable settings.

The system must:

- produce a **3.0–10.0 grade** for a player after a competitive match;
- judge **what the player actually did**, not directly add OVR, potential, age, salary, value, or hidden career data;
- value actions by their **difficulty and effect on scoring threat**, rather than assigning arbitrary fixed points such as `goal = +1.0` or `tackle = +0.2`;
- be **position-balanced by construction**, so goalkeepers, defenders, midfielders, and forwards have the same opportunity to obtain high or low grades;
- use the position/role the player actually occupied in the match, not merely his natural position;
- expose no new knobs in `game.config.jsonc`;
- persist ratings so they become durable player history;
- show a compact summary in the **player popout**;
- add a **Performance** tab to the player area of the Squad page, alongside the existing customization/career information;
- provide two history tabs:
  - **Last 10 games**
  - **Last 10 seasons**
- restrict another club's player-performance information to **Pro/admin users**.

This is post-match analytics only. It must never feed back into match probabilities, player development, value, salary, transfers, awards, or AI decisions unless a future plan explicitly says otherwise.

---

## 1A. Architecture Adaptation (authoritative)

The current Footmania engine is not an individual event simulator. `backend/src/game/matchSim.ts` is a seeded team/zone possession engine. Most decisions use weighted local player inputs (`actionQualityFor` and `defensiveResistanceFor`), while `LiveBallAction` is a stable visual attribution for the pitch and is explicitly not a causal player-action log. The human-readable `MatchEvent` feed is also intentionally condensed.

The implementation must therefore use **read-only match instrumentation**, not replay and not a second football simulator:

1. Capture the probabilities and resolved outcomes that the existing engine already computes at its decision points. Probability normalization and arithmetic capture must happen without an RNG call.
2. Keep a pure analytics observer beside the engine. It may evaluate the existing probability expressions with one player's quality input replaced by a same-role benchmark, but it must never write to the live engine or draw an outcome.
3. Treat one `stepPossession` resolution as the atomic rating observation. Do not add separate bonuses for intent, outcome, progression, shot, card, or headline event when they describe the same step. This prevents double-counting one causal effect.
4. Do not use `LiveBallAction.fromPlayerId`, `targetPlayerId`, `interceptorId`, or `foulerId` as proof of causal involvement. They are presentation selections unless the engine's probability calculation actually consumed that player's input.
5. Do not build the matrix of every reachable match state or introduce a new PV/EPV solver for ratings. The engine already has a neutral EPV table (`computeEpv`/`stateValue`) used by commentary and card risk. Ratings may read that existing threat value, but must not alter its calculation or its match-engine callers.
6. Do not change `MATCH_SIMULATOR_CONFIG`, `game.config.jsonc`, existing probability formulas, action order, timing draws, fatigue, cards, substitutions, or the RNG stream. A probability observer is allowed only if the match with the observer enabled is outcome-equivalent to the match without it.
7. Persist a compact per-match analytics accumulator in `LiveMatchState`, because the live state is rebuilt and saved between worker ticks. Do not persist the full action trace in the live JSON or extend `lastBallAction` with analytics fields. Final ratings are copied into the normal `World` persistence boundary at full time.
8. Track rating playing time separately from the engine's per-player minutes map (`eng.playerMinutes`/`LiveMatchState.playerMinutes`). AI substitution logic reads `eng.playerMinutes` via `minOnPitchMinutes`, and `st.playerMinutes` is the persisted copy; changing its meaning or adding analytics fields to it would risk match behavior. A rating-only on-pitch seconds counter must be used for the 10-minute rule and role durations.
9. Use the repository's global `World`/`Save` architecture: rating rows and calibration snapshots have a domain mirror, are loaded with the global world, and are written by `persistWorld` in the same transaction as the finalized match. Rating keys must not consume `World.nextId`, because changing that sequence could affect later game entity IDs and seeded generation.
10. Scope the counterfactual to the usable-Z terms and probabilities that the engine actually uses. The engine's `attributeWeights[action]` (and its defensive counterpart) define exactly which attribute keys each weighted-mean aggregate consumes; shots read `zFinishing`/`zGk` directly. The counterfactual substitutes only those consumed terms (per §6.2), never the engine's own configuration, formulas, or draw order.

The original mathematical sections below remain the product intent, but the items above override any instruction that would require a second state model, a stochastic replay, synthetic player actions, or a change to match behavior. If a simulator action does not expose a causal player input, leave that contribution at zero rather than inventing an event or a fixed weight.

This rollout starts after a game reset. There is no legacy rating backfill, replay, or compatibility path in scope.

---

## 2. Inspiration from SofaScore

The implementation should copy the useful principles, not the proprietary formula.

Public SofaScore documentation currently establishes several useful design anchors:

- a rating is based on the context and impact of recorded player actions;
- its current explanatory categories are Shooting, Passing, Dribbling, Defending, and Goalkeeping;
- progressive/risky passes matter more than harmless safe passes;
- difficult/high-impact defensive or goalkeeper actions matter more than routine ones;
- the system uses a Gaussian-distribution approach;
- the published scale is 3.0–10.0;
- 6.5 is the published starting rating;
- a player needs 10 minutes to receive a rating;
- SofaScore states that roughly 1 in 3000 performances reaches 10.0;
- match ratings are displayed to one decimal and average ratings to two decimals.

Footmania should use those public properties as fixed product semantics, not as configurable parameters.

---

## 3. Absolutely no rating tunables

Do **not** add a `ratings`, `performance`, or similar section to `game.config.jsonc`.

There must be no configurable:

- event weights;
- positional weights;
- goal bonuses;
- assist bonuses;
- save bonuses;
- card penalties;
- clean-sheet bonuses;
- minimum/maximum grade;
- grade mean;
- grade standard deviation;
- role multipliers;
- minute multipliers;
- form windows;
- normalization strengths;
- smoothing constants.

The only numeric constants in the implementation are fixed semantic definitions:

1. **3.0 and 10.0** — the selected public rating scale.
2. **6.5** — the neutral/central rating.
3. **10 minutes** — the fixed minimum playing time for a match grade.
4. **10 games and 10 seasons** — the requested UI history windows.
5. **1 in 3000** — used only to mathematically determine the Gaussian scale so a 10.0 remains exceptionally rare.

These are not designer knobs. Changing the rating methodology later requires a new `RATING_MODEL_VERSION`, not retuning config values.

---

# 4. Core principle: rate excess football value, not raw stats

A fixed scoring table would inevitably favor some positions.

Examples of what **not** to do:

```text
goal       +1.00
assist     +0.60
save       +0.15
tackle     +0.10
yellow     -0.20
red        -1.00
```

That would force somebody to decide how many saves equal a goal, how many tackles equal an assist, etc. It would also cause role bias as the simulator evolves.

Instead, every meaningful player-involved simulator action is valued in a common unit:

> **change in expected goal threat**

The match engine already knows the state of the possession, pitch zone, phase, players involved, tactics, fatigue, opposition, and outcome probabilities. The rating layer must reuse that same probability model.

No second football model is introduced.

---

# 5. Possession Value model

## 5.1 Definition

For a current possession state `s`, define:

```text
PV(s) = probability that the team in possession scores
        before that possession ends
```

A possession ends when:

- the opposition gains possession;
- play reaches a neutral dead-ball state that starts a new possession;
- a goal is scored;
- the half/match ends.

`PV(s)` is therefore between 0 and 1 and is expressed directly in expected-goal units.

## 5.2 Read threat value from the simulator

Do not fit arbitrary coefficients and do not build a second state graph.

The current engine precomputes a static EPV table in `computeEpv()` and reads the current state value through `stateValue()`. The table is based on the existing `MS.probabilityModel`, `MS.shotModel`, and configured EPV convergence. It is not a per-match Markov chain containing every reachable fatigue, card, score, tactic, and lineup state. Ratings must use this existing threat-value source rather than pretending that such a chain is available.

At each instrumented decision, capture the frozen context and the already computed normalized outcome probabilities. The observer may read:

- current phase and zone;
- action family and possession side;
- the actual lineup, on-pitch players, fatigue/readiness, cards, and organisation;
- tactics, familiarity, home/away state, score, and match clock;
- the existing EPV/state value before the step;
- the resolved outcome and the next state/terminal classification;
- any player inputs that the probability expression actually consumed.

If a contribution needs a value for the next state, expose a pure read-only helper around the existing `stateValue()`/EPV lookup or the exact next-state value already calculated by that resolution path. The helper must be shared with the current formula and must not change its callers. If the engine cannot provide a threat value for a state, do not substitute a hand-authored event weight; record no informative contribution for that component.

The original full-system equation is useful product rationale:

```text
PV = r + Q * PV
```

It is not an implementation requirement for the current engine. A matrix/linear-solver implementation would be in scope only after the engine intentionally exposes a behavior-equivalent transition API and proves that it does not alter the live simulation. That prerequisite is not needed for the first rating implementation.

The observer must not call `nextDouble`, `choice`, `weightedPick`, or any other RNG helper. Enabling it must leave the RNG state and all match outputs byte-for-byte equivalent.

## 5.3 Value of a concrete action outcome

For an action outcome `k`, from the rated player's team's perspective:

```text
U(k) =
  +1                               if his team scores
  -1                               if his team concedes an own-goal-type terminal outcome
  +PV_own(nextState)               if his team retains/receives possession
  -PV_opponent(nextState)          if the opponent gains possession
   0                               if play ends in a neutral state with no next possession
```

If a restart belongs to one of the teams, use the corresponding positive or negative `PV` of the restart state instead of zero.

This automatically makes:

- a progressive action into a dangerous zone worth more than a sideways action;
- losing the ball in a dangerous area worse than losing it harmlessly;
- a high-xG miss more damaging than a speculative miss;
- saving a dangerous shot more valuable than saving a routine shot;
- blocking/clearing imminent danger more valuable than doing so far from goal.

There are still **no event weights**.

---

# 6. Same-role counterfactual benchmark (observer substitution)

This is the first mechanism that prevents striker/GK/defender bias.

For every rating-relevant decision, calculate what the existing engine's own probability expressions would have produced if the rated player's individual quality contribution were replaced by that of a **typical player in the same deployed role**, in the exact same situation.

Roles are the existing Footmania roles: the engine's `tacPosRole` (matchSim.ts) maps a deployed `tacPos` to one of eleven fine roles:

- GK
- LB
- RB
- SW
- LW
- RW
- LM
- RM
- ST
- CB
- CM

The rating system uses these eleven fine deployed roles for action-time benchmarks. (The five labels `GK/FB/CB/MF/FW` in `POSITION_NAMES` are natural-position groups used by `positionFit` and `COMPATIBILITY`; they are not deployed-role taxonomies and must not be used here.)

For distributional calibration (§10), the eleven fine roles may be coarse-grouped by a documented mapping (e.g. GK; LB/RB → FB; CB/SW → CB; LM/RM/CM → MID; LW/RW/ST → FWD), applied consistently and stored with the calibration snapshot so the grouping never changes retroactively.

Use the player's **deployed role at that instant** (from `tacPosRole(ps.tacPos)`), not his natural position.

## 6.1 What "player quality contribution" means in the current engine

The engine does not evaluate one player at a time. At each decision it computes side-level aggregates over the zone-involved players:

- `actionQualityFor(side, zone, action)` — weighted mean of usable attribute Z across `involvedPlayers(side, zone)` using `MS.actionQuality.attributeWeights[action]`, scaled by local density;
- `defensiveResistanceFor(side, zone, action)` — the same for the defending side using the defensive weight vector.

Each player's usable Z (`playerUsableZ`) is `robustZ(attribute, centers) * positionFit * readiness`. The probability expressions (control failure, intentional-action selection, outcome resolution, shot resolution, card risk) consume these aggregates plus the current context and normalize them with the existing logistic/softmax formulas. They are pure functions of those inputs; only the draws on top of them consume RNG.

The rating observer therefore reuses the exact expressions as pure functions. The benchmark for attribute `a` and fine role `r` is the **median usable-Z value** (`playerUsableZ`) across the world's active senior players whose deployed role is `r`, computed deterministically at match start (no RNG). Use the median rather than the mean because it is robust to elite and terrible outliers and requires no distributional tuning.

## 6.2 Counterfactual evaluation at a decision

The engine's decision inputs are **weighted means over the zone-involved set**, so there is no standalone per-player attribute term to swap. The counterfactual must therefore be defined as a **weighted-mean substitution**:

For player `i` participating in decision `e`:

1. capture the exact context the engine used: phase, zone, lane, score, clock, on-pitch players, fatigue/readiness, cards, organisation, tactics, familiarity, home/away, possession side, and the existing EPV/state value;
2. identify every attribute key of `i` that the decision's weight vector actually consumes (`attributeWeights[action]` for the attacking side, defensive weights for the defending side, `zFinishing`/`zGk` for shots and saves, `zDiscipline`/readiness for card risk);
3. re-run the same pure probability expression with player `i`'s usable-Z replaced by the role benchmark, **only inside the weighted-mean aggregate**, leaving every other player's Z, the involvement weights, the local-density scaling, and all other context exactly as the engine computed them;
4. treat the normalized result as the counterfactual distribution `q_i,e(k)`.

Concretely, this requires exposing a helper that mirrors `actionQualityFor`/`defensiveResistanceFor` exactly but accepts an override of one player's usable-Z term before the weighted mean:

```text
weightedQualityWithOverride(
  side, zone, attributeKey,
  playerId, replacementUsableZ
) = sum(w_j * z_j for j != playerId) + w_i * replacementUsableZ,
  normalized by the same weight sum and multiplied by the same localDensity
```

The engine keeps calling the original functions with the actual values; only the observer calls the override helper. Because the helper is a pure re-computation of the same arithmetic, identical inputs yield identical outputs and no RNG is consumed.

Only the rated player's usable-Z term is replaced: opponent quality, teammates, tactics, fatigue, score/zone/phase, home advantage, familiarity, and organisation remain exactly the engine's values.

If the player is not in the zone-involved set for the decision (`involvedPlayers(side, zone)` weight 0), or no attribute he provides appears in that decision's weight vector, the decision carries no counterfactual information for him (`c = 0`, `v = 0`).

The counterfactual asks:

> "What distribution of outcomes would the engine's own probability model produce here if this player's individual quality contribution were replaced, for this action only, by a typical player occupying the same role?"

This is not a replacement-player simulation of the whole match.

## 6.3 Required refactor: pure probability evaluation

Before the counterfactual can exist, the probability expressions must be factored into exported pure functions that take explicit inputs and return the same normalized probabilities, without touching engine state and without RNG:

- control-failure probability;
- intentional-action selection utilities (softmax probabilities);
- outcome resolution probabilities (continue/turnover/foul/retained-restart);
- next-zone destination probabilities;
- shot outcome probabilities (goal/save/block/woodwork/miss) from the captured geometry, the shooter's `zFinishing`, and the goalkeeper's `zGk` (the shot model reads these directly, not through a weighted mean — see `resolveShot`/`finalXg`/`pOnTarget`);
- card probabilities for a foul (yellow/red) when the fouler's discipline and readiness are causally consumed.

The engine continues to call these functions with the actual values; the observer calls the same functions with the substituted contribution. Because the functions are pure, identical inputs yield identical outputs and no RNG is consumed. Any sub-decision that is presentation-only (lane selection, shot-location jitter, presentation fouler/carrier picks) is excluded from the counterfactual or evaluated only from the already-resolved values the engine captured (for example the exact shot geometry), never by re-drawing.

If a decision cannot be expressed this way without changing the engine's behavior, that decision produces no rating contribution. Do not invent a parallel probability model.

## 6.4 Determinism and no feedback

- The observer must not call `nextDouble`, `choice`, `weightedPick`, or any other RNG helper.
- Enabling rating capture must leave the RNG state and every match output byte-for-byte equivalent.
- Benchmarks are computed once per match from the frozen world population and reused for the whole match; they never depend on the match's own RNG stream.

---

# 7. Per-action contribution

For decision `e` involving player `i`, with counterfactual distribution `q_i,e(k)` and outcome utility `U_i,e(k)` from §5.3, calculate the counterfactual expected value:

```text
mu_i,e = Σ_k q_i,e(k) * U_i,e(k)
```

and its counterfactual variance:

```text
v_i,e = Σ_k q_i,e(k) * (U_i,e(k) - mu_i,e)^2
```

If the actual resolved outcome was `k*`, the player's observed excess contribution is:

```text
c_i,e = U_i,e(k*) - mu_i,e
```

Interpretation:

- `c > 0`: the realized outcome was better than a typical same-position player was expected to produce in that exact situation;
- `c < 0`: worse;
- `c ≈ 0`: roughly expected.

Decisions with `v = 0` carry no rating information and are ignored.

This has several useful consequences automatically:

- a difficult goal is worth more than an easy goal;
- an easy miss is worse than missing a low-probability shot;
- a penalty save is naturally very valuable;
- a difficult progressive pass is worth more than a routine safe pass;
- an assist does not need an arbitrary "+assist" bonus — the pass that creates the high-value state already receives its value;
- a last-man intervention can be extremely valuable because it destroys a high-threat opposition state;
- routine goalkeeper work does not inflate GK ratings;
- forwards do not receive an automatic positional advantage simply because goals are conspicuous.

---

# 8. Multi-player decisions

Some simulator decisions consume more than one player's quality contribution, e.g.:

- shot resolution: shooter (`zFinishing`) vs goalkeeper (`zGk`);
- outcome resolution: the attacking side's action-quality aggregate vs the defending side's defensive resistance;
- card risk for a foul: the fouler's discipline and readiness.

For each decision, every player whose usable-Z term the probability expression actually consumed is evaluated with a **one-player-at-a-time counterfactual**:

- when grading the shooter, replace only the shooter's finishing term (direct `zFinishing` in `resolveShot`);
- when grading the goalkeeper, replace only the goalkeeper's goalkeeping term (direct `zGk` in `resolveShot`);
- when grading the fouler, replace only the fouler's discipline/readiness terms (`cardLogitShift`);
- when grading a defender on a pressed/tackled action, replace only that defender's usable-Z terms inside the defending side's weighted-mean aggregate;
- etc.

The observed outcome is shared, but each player's benchmark distribution is different.

This gives intuitive results without hand-authored attribution weights.

A player receives a contribution only if the decision's weight vector actually consumed that player's usable-Z. Do not award passive team-wide credit just because a player happened to be on the pitch, and do not attribute to the presentation-selected `fromPlayerId`/`interceptorId`/`foulerId` any probability that did not consume that player's inputs. If a player is not in `involvedPlayers(side, zone)` for the decision (weight 0), his contribution for it is zero.

---

# 9. Aggregate one player's match performance

For player `i`:

```text
C_i = Σ_e c_i,e
V_i = Σ_e v_i,e
```

The raw standardized performance is:

```text
Z_raw_i =
    C_i / sqrt(V_i)        if V_i > 0
    0                      otherwise
```

This is an information-standardized score.

Why this matters:

- a goalkeeper may have only a handful of high-information actions;
- a midfielder may have dozens of lower-information actions;
- a striker may have relatively few but high-leverage actions.

`V_i` normalizes the amount of statistical opportunity. The rating therefore does not simply reward whoever touches the ball most.

A player with no informative actions receives the neutral raw score `Z_raw = 0`.

Do **not** divide by minutes or multiply to a per-90 number.

That would make short substitute appearances excessively volatile.

---

# 10. Explicit positional equalization

The same-position counterfactual above should already remove most role bias. Add a second, automatic calibration layer so persistent simulator-specific role effects cannot creep in over time.

This is data-derived and contains no coefficients.

## 10.1 Freeze calibration at season start

At the start of each season, create a calibration snapshot from **all previously finalized rated player-match performances using the same `RATING_MODEL_VERSION`**.

The calibration is applied at the **coarse role grouping** (e.g. GK / FB / CB / MID / FWD, mapping the fine `tacPosRole` outputs as documented in §6). Each fine role's `Z_raw` values are assigned to their coarse group for the empirical-percentile step.

For each coarse role `r`, collect its historical `Z_raw` values.

A player's primary role for one match is derived from his fine-role seconds:

```text
the fine role in which he spent the greatest number of match seconds,
then mapped to its coarse group
```

If two fine roles have exactly equal seconds, use the role occupied earlier in the match.

Action-level counterfactuals still use the exact fine role at each action. The primary/coarse role exists only for this distributional calibration.

## 10.2 Gaussianize each role independently

For a new raw score `z` in role `r`, use the frozen historical role distribution.

Let:

- `N` = number of prior ratings in role `r`;
- `nLess` = number strictly less than `z`;
- `nEqual` = number exactly equal to `z`.

If `N < 2`, use:

```text
Z_balanced = Z_raw
```

because fewer than two observations cannot define a distribution.

Otherwise calculate the finite empirical percentile:

```text
u = (nLess + 0.5*nEqual + 0.5) / (N + 1)
```

Then:

```text
Z_balanced = Φ^(-1)(u)
```

where `Φ^(-1)` is the inverse standard-normal CDF.

This forces every deployed role onto the same statistical scale automatically.

No striker/GK/CB multiplier exists.

No role can drift into being "the high-rating position" merely because its events are structurally different.

## 10.3 Stability

The calibration snapshot is frozen for the entire season.

Therefore:

- ratings never change retrospectively;
- later matches cannot change an earlier grade;
- a player's history is stable;
- there is no future-data leakage.

When the rating algorithm materially changes, increment `RATING_MODEL_VERSION`. The new version starts with the raw standardized model until it has historical data of its own.

---

# 11. Convert the balanced Z score to a 3.0–10.0 grade

Use the public SofaScore-inspired anchors mathematically.

Neutral performance:

```text
Z_balanced = 0  ->  rating = 6.5
```

SofaScore states that approximately 1 in 3000 rated performances reaches 10.0.

For a standard normal:

```text
z_10 = Φ^(-1)(1 - 1/3000)
     = 3.402932835...
```

The scale coefficient is therefore derived, not tuned:

```text
scale = (10.0 - 6.5) / z_10
      = 1.028524561...
```

Final exact rating:

```text
ratingExact =
  clamp(
    3.0,
    10.0,
    6.5 + 1.028524561 * Z_balanced
  )
```

Display a match rating to one decimal:

```text
ratingDisplay = round(ratingExact, 1)
```

Do not store only the rounded value. Persist `ratingExact` and derive display formatting in the API/UI.

This yields a Gaussian-like rating distribution centered on 6.5 and makes perfect 10s genuinely exceptional.

---

# 12. Minimum minutes

Follow the published SofaScore behavior:

```text
minutesPlayed < 10 -> NR (not rated)
minutesPlayed >= 10 -> calculate/persist a rating
```

This is a fixed rating-system rule, not configuration.

The 10-minute threshold uses the rating-only on-pitch seconds counter from §17 (measured against the match clock), not `LiveMatchState.playerMinutes` (the persisted copy of the engine's `eng.playerMinutes` map, which AI substitution logic reads via `minOnPitchMinutes`).

A sub-10-minute appearance:

- remains in match/player history;
- can still contain goals, assists, cards, etc.;
- shows `NR` in the performance UI;
- is excluded from rating averages;
- is excluded from positional calibration.

---

# 13. Action categories

For auditability and future UI explanation, store contribution totals in five SofaScore-like categories, but **do not weight the categories**.

Every contribution still enters `C_i` directly.

Map the current engine's intent-action families as follows:

### Shooting
- `SHOT` steps (including penalties, which resolve as a pinned `SHOT` from a `PENALTY` restart). Map the counterfactual expected value and variance from the shot-resolution probability expression, using the captured geometry and the shooter's and goalkeeper's contributions.

### Passing
- `PASS`, `CROSS`, and `CLEARANCE` steps that resolve through the outcome expression, plus set-piece deliveries when the possession start pins one of those actions.

### Dribbling / Progression
- `CARRY` and `DRIBBLE` steps that resolve through the outcome expression.

### Defending
- the defending-side contributions of `TURNOVER`, `FOUL`, `CONTINUE`, and `RETAINED_RESTART` outcomes whose probabilities consumed defending players' usable-Z terms, plus defensive resistance consumed by shot resolution (pressure, block). If a defending player's contribution cannot be attributed to a specific defender (no consumed usable-Z term), leave it at zero rather than inventing one.

### Goalkeeping
- the goalkeeper's `zGk` contribution to every shot resolution (saves, goals conceded), plus any goal-kick possession-start involvement if it is expressed through the probability model.

For a shot that involves shooter, goalkeeper, and possibly blocker, different participants may receive contributions in different categories from the same real event, but each contribution must be limited to the usable-Z terms the shot-resolution expression actually consumed for that participant.

The five category sums are explanatory only. There is no formula such as "Shooting 30%, Passing 20%".

---

# 14. Cards, fouls, assists, goals, and other headline events

Do not add arbitrary headline-event bonuses.

### Goal
Its value emerges from the shot's probability and the resulting `U=+1`.

### Assist
The assist remains a displayed stat, but there is no fixed assist bonus. The chance-creating pass already receives the threat increase it produced.

### Big chance missed
No special label is required. Missing a high-value shot is automatically more negative.

### Penalty save
No special bonus is required. Preventing a high-probability goal is automatically strongly positive.

### Fouls
A foul is valued according to the possession/restart state it creates, evaluated from the outcome utility of the resolved foul state.

### Red card
A red card is not modeled as a distinct action in the current engine; `resolveCards` only decides yellow/red after the foul outcome and does not change subsequent team strengths. Therefore there is no separate post-dismissal state to value. The foul's outcome utility already captures the conceded restart; do not add a synthetic card penalty. If a future engine models dismissal as a probability change, re-open this clause.

### Yellow card
Do not invent a fixed yellow-card penalty. Any football cost already created by the foul/restart is counted. A yellow only adds extra rating cost if the match simulator itself makes the yellow card change subsequent match probabilities.

### Own goal
The current engine has no own-goal probability path; all goals are scored by the shooting side and the `OWN_GOAL` event code in constants.ts is never emitted by `matchSim.ts`. Until such a path exists, no own-goal term is needed. If an own-goal event family is added later, use terminal utility `-1` from the responsible player's team perspective and route it through the same counterfactual evaluation.

This keeps the rating tightly coupled to actual match consequences rather than a designer-maintained points table.

---

# 15. Do not use these inputs directly

The rating formula must never add or subtract points directly for:

- OVR;
- natural position;
- player value;
- salary;
- contract length;
- age;
- hidden growth budget;
- hidden decline budget;
- hidden peak age;
- club rating/Elo;
- division budget;
- whether the manager is Pro;
- whether the club won the match;
- clean sheet as a standalone bonus;
- Man of the Match status.

Some of these may already affect the simulator and therefore indirectly affect what happens on the pitch. That is sufficient.

---

# 16. Data persistence

Create a durable save-scoped match-rating table rather than storing the grade only inside a transient live-match object.

The repository's persistence is fully normalized and save-scoped: every world entity lives in its own table with a composite `@@id([saveId, ...])`, relations to `Save`, and a full sync (delete + insert) inside the save lock (`persistWorld`). `LiveMatch` is the documented exception: transient runtime state kept as JSON because it is never queried relationally. A new rating table must follow the normalized save-scoped convention, not the `LiveMatch` JSON exception.

Recommended Prisma model, following the existing `Match`/`MatchStat`/`MatchEvent` shape:

```prisma
model PlayerMatchRating {
  id                Int      @id @default(autoincrement())
  saveId            Int
  save              Save     @relation(fields: [saveId], references: [id], onDelete: Cascade)
  matchId           Int
  playerId          Int
  clubId            Int
  seasonId          Int

  tier              Int
  primaryRole       String
  minutesPlayed     Int

  rawImpact         Float
  rawVariance       Float
  rawZ              Float
  balancedZ         Float
  ratingExact       Float?

  shootingImpact    Float
  passingImpact     Float
  dribblingImpact   Float
  defendingImpact   Float
  goalkeepingImpact Float

  ratingModelVersion Int
  createdAt         DateTime @default(now())

  @@unique([saveId, matchId, playerId])
  @@index([saveId, playerId, createdAt])
  @@index([saveId, playerId, seasonId])
  @@index([saveId, seasonId, primaryRole, ratingModelVersion])
}
```

`ratingExact` is nullable because a player who appeared for fewer than 10 minutes is persisted as an appearance but receives `NR`.

Use the project's actual `tacPos`-derived role strings for `primaryRole`; do not create a duplicate role taxonomy.

Persist the `clubId`, `seasonId`, and `tier` as match-time facts so transfers do not rewrite history.

The ratings are part of the domain `World` state: a `playerMatchRatings` mirror on `World` (loaded by `rebuildWorld`) is written by `persistWorld` in the same transaction as the finalized match. Rating keys must not consume `World.nextId`; use the same delete-and-reinsert sync pattern as the other world rows so retries are idempotent. A calibration snapshot (season-frozen role distributions) is a small additional save-scoped table with the same conventions, refreshed at season start by `seasonRolloverService`.

---

# 17. Match-engine integration

Create a pure analytics module, conceptually:

```text
backend/src/game/player-rating.ts
```

It must not mutate match state and must not consume RNG.

Responsibilities:

1. build same-role median benchmarks from the world's active senior population at match start;
2. read the existing EPV/state-value table;
3. observe every rating-relevant decision at the pure probability-expression boundary (after §6.3), with its captured context, the resolved outcome, and the next-state/terminal classification;
4. calculate each causally involved player's `c` and `v`;
5. aggregate category contributions;
6. track on-pitch seconds in each deployed role (a rating-only seconds counter, separate from the engine's per-player minutes map `eng.playerMinutes`/`LiveMatchState.playerMinutes` — AI substitution logic reads `eng.playerMinutes` via `minOnPitchMinutes`, and `st.playerMinutes` is the persisted copy, so adding a new analytics field to `LiveMatchState` must never alter that map or the AI substitution path);
7. finalize `rawZ`;
8. apply the season-frozen position calibration;
9. convert to `ratingExact`;
10. return deterministic persistence records.

Hook it into the same action-resolution points that already produce match statistics/events, calling the pure expressions with the actual values and with substituted benchmarks.

The accumulated per-match analytics for a live match live in a compact, optional `LiveMatchState` field (e.g. per-player `{secondsPerRole, rawImpact, rawVariance, categoryImpacts, modelVersion}`). It is rebuilt and persisted with the live state (`persistLiveMatchState`) so streamed ticks and server reloads do not lose the accumulation, and it is never read by gameplay logic. At full time the same transaction that finalizes the match copies the accumulator into the save-scoped `PlayerMatchRating` rows via `persistWorld`.

The rating accumulator is strictly write-only for gameplay. In particular it must not be modeled on, or merged into, the existing `playerRecentLoad`/`playerMatchLoad`/`playerPreMatchLoad` maps: `applyMatchToPlayers` (backend/src/game/match.ts) reads `st.playerMatchLoad` at full time and writes it into each player's `recentLoad`, so those fields are gameplay-relevant and persist across the match boundary. Adding rating fields to them would change post-match player recovery/load and therefore future match probabilities. A dedicated `ratingAccum` field is the only safe home.

Do not infer ratings later from the human-readable event feed. The event feed intentionally omits/condenses some actions and is presentation data, not the authoritative simulation stream.

Do not store the full action trace in `LiveMatchState` or extend `lastBallAction` with analytics fields.

---

# 18. Finalization and retry safety

Ratings are written only when the competitive match is finalized.

The write must be part of the same retry-safe finalization boundary used for the rest of match statistics. In the live path this is `advanceLiveMatches` → `finalizeLiveMatch` → `buildMatchFromState`/`applyMatchToPlayers` → `persistWorld` (under `withGlobalLock` with `Save.revision` optimistic concurrency). In the instant-simulation path (`simulateMatch` for competitive fixtures, practice excluded) the same `persistWorld` transaction writes the rating rows from the in-memory accumulator.

Because of:

```prisma
@@unique([saveId, matchId, playerId])
```

a retry must upsert the identical deterministic record rather than create duplicates; the `persistWorld` delete-and-reinsert sync already guarantees this.

Practice matches do not persist ratings.

If an admin force-finishes a real competitive match, ratings are generated normally from the resolved match.

---

# 19. Historical/backfill rule

This rollout ships after a world reset. No pre-rollout match contains rating data, so there is nothing to backfill.

Do not fabricate ratings for old matches from box-score data, and do not replay old simulations through the rating module: the live engine does not persist an authoritative per-action probability trace, so a deterministic replay cannot be reconstructed. Existing pre-rollout matches simply remain unrated.

The UI begins the graph at the first rating-capable match after the rollout and shows `—` for earlier periods.

---

# 20. Last 10 Games summary

"Last 10 Games" means the player's ten most recent **competitive appearances**, ordered chronologically in the chart.

An appearance under 10 minutes remains in the ten-game sequence but displays:

```text
NR
```

and has no plotted grade point.

Above the chart show:

```text
Average rating: X.XX
Rated appearances: N
```

The average excludes `NR`.

Each point/row should expose on hover/tap:

- season;
- opponent;
- home/away;
- result;
- minutes played;
- rating;
- goals;
- assists;
- cards.

Do not include practice matches.

---

# 21. Last 10 Seasons summary

Show the current season plus the previous nine world seasons as a fixed chronological window.

For each season:

```text
seasonRating =
  arithmetic mean of ratingExact
  across that player's rated competitive appearances in the season
```

Display to two decimals.

If the player had no rated appearance in that season, show `—`.

The tooltip for a season point shows:

- season;
- average rating;
- rated appearances;
- total appearances;
- minutes;
- goals;
- assists.

Do not hide seasons merely because the player had no rating; the point of this tab is long-term career chronology.

---

# 22. Player popout UI

Add a compact **Performance** section to the existing player popout.

Structure:

```text
Performance
[ Last 10 games ] [ Last 10 seasons ]

Average 7.24

        line chart
```

For the compact popout:

- line chart only;
- one-decimal match labels;
- two-decimal average;
- no large stat table;
- tap/hover provides detail.

Reuse one shared frontend component with the Squad-page implementation rather than creating two independent chart implementations.

---

# 23. Squad page UI

In the player detail area where Career and Customization already exist, add:

```text
Performance
```

as another tab.

The full Performance tab contains:

1. `Last 10 games | Last 10 seasons` toggle;
2. larger rating chart;
3. average rating;
4. the matching rows beneath the chart;
5. optional five-category contribution breakdown for the selected match, using the already persisted category impacts.

The five-category breakdown is explanatory only and must never imply category weights.

---

# 24. Pro visibility rules

Create one server-side authorization rule for player performance:

```text
canViewPlayerPerformance(viewer, player)
```

Return `true` when any of these is true:

1. viewer is admin;
2. viewer has Pro;
3. viewer manages the player's owning club;
4. viewer currently has the player on loan;
5. viewer is the owning manager of a player currently loaned out;
6. player is currently unowned/free-agent.

Return `false` for a player currently owned by another human or AI club when the viewer is non-Pro.

This matches the requested rule: another team's performance information is a Pro scouting benefit.

The check must be enforced in the backend/API.

A non-Pro client must not receive:

- match grades;
- averages;
- raw rating fields;
- category impacts;
- rating history.

Do not merely hide them with CSS.

In the UI, a non-Pro viewing another club's player should see a compact locked Performance section/tab with a Pro indicator, not fake/blurred numbers.

---

# 25. API

Expose one player-performance endpoint alongside the existing player-history route patterns (e.g. under `backend/src/routes/proFeatures.ts`), for example:

```text
GET /api/players/:playerId/performance
```

After authorization via `canViewPlayerPerformance`, return both windows in one request because each is small:

```json
{
  "last10Games": [...],
  "last10Seasons": [...],
  "currentAverage": 7.24
}
```

The API should return display-ready historical facts but never return:

- `rawImpact`;
- `rawVariance`;
- `rawZ`;
- `balancedZ`;
- benchmark values;
- positional calibration distributions.

Those are internal analytics/debug fields.

Admin diagnostics may expose them through a separate admin-only endpoint if needed.

---

# 26. Automatic position-balance diagnostics

Because role fairness is a hard invariant, add an admin/test diagnostic rather than a tuning panel.

For each role and rating-model version report:

- count;
- mean rating;
- median rating;
- standard deviation;
- 10th percentile;
- 25th percentile;
- 75th percentile;
- 90th percentile.

Also compute pairwise two-sample Kolmogorov-Smirnov statistics on `balancedZ`.

This is diagnostic only.

Do not provide controls to "fix" a role by changing its multiplier. If a persistent difference appears, it means the rating instrumentation/model has a bug or a new event family is not being benchmarked correctly.

---

# 27. Required tests

## Determinism
- same match seed and state -> identical ratings;
- retry finalization -> no duplicate/change;
- rating calculation consumes zero RNG.

## No simulation feedback
- enabling/disabling rating persistence in a test build cannot change score, events, fatigue, injuries, cards, substitutions, or RNG sequence;
- the observer/refactor changes no engine rule: same seed and state produce byte-for-byte identical scores, events, stats, fatigue, cards, and RNG state with and without the rating module.

## No match-engine recalibration
- the rating feature consumes data from the match engine; it must never change engine rules, config, probability formulas, action order, timing draws, fatigue/cards/substitution logic, or the RNG stream;
- no `MATCH_SIMULATOR_CONFIG`, `game.config.jsonc`, or `MP_CONFIG` values may be touched by this feature;
- the pure-function refactor must be verified to be a behavior-preserving extraction (identical outputs on the existing test corpus, e.g. `matchSimulator.test.ts` / `matchTimeline.test.ts`), not a rewrite that alters calibration;
- the new `LiveMatchState` accumulator and the pure helpers must be absent from every engine decision path so a build without the rating feature is indistinguishable from today's engine.

## Position fairness
Simulate a large deterministic set of matches and confirm no role is structurally shifted upward/downward after balancing.

Specifically verify that the deployed-role distributions of `balancedZ` (at the fine `tacPosRole` level and at the coarse calibration grouping) are centered on the same standard-normal scale.

## Football sanity
- difficult goal > easy goal, all else equal;
- high-probability miss is more negative than low-probability miss;
- difficult save > routine save;
- progressive dangerous pass > safe sideways pass;
- successful dangerous defensive action > routine defensive action;
- dangerous turnover < harmless turnover;
- penalty save strongly positive.

Own-goal and red-card sanity cases are deferred until the engine models those families; the current engine has no own-goal probability path and no post-dismissal state.

## Pure probability observer
- identical inputs to the extracted pure functions produce identical probabilities (no RNG);
- substituting a same-role benchmark changes only the rated player's usable-Z term inside the weighted-mean aggregate (and the direct `zFinishing`/`zGk` terms for shots);
- an action whose weight vector does not consume a player yields zero contribution for that player;
- presentation-only sub-decisions (lane, shot-location jitter, carrier/fouler picks) never produce rating contributions.

## Minutes
- 9:59 played -> NR;
- 10:00 played -> rated;
- NR performances excluded from averages/calibration;
- rating seconds come from the rating-only counter, never from `LiveMatchState.playerMinutes` (the persisted engine minutes map read by AI substitution).

## Role switching
- action benchmarks use role at action time;
- primary role uses greatest seconds;
- tie uses earlier role.

## Live-state persistence
- streamed ticks and reloads preserve the accumulated per-match analytics in `LiveMatchState` without duplication;
- live accumulators are never read by gameplay logic;
- final ratings are written exactly once by the same `persistWorld` transaction that finalizes the match.

## Visibility
- own club, non-Pro -> allowed;
- other club, non-Pro -> denied;
- other club, Pro -> allowed;
- admin -> allowed;
- active loanee -> borrower and owner allowed;
- free agent -> allowed;
- API does not leak hidden raw rating internals.

## History
- last 10 games means appearances, not club fixtures;
- sub-10-minute appearance occupies a slot but displays NR;
- practice games excluded;
- 10-season window retains empty seasons as `—`;
- transfers do not rewrite historical club/opponent/season facts.

---

# 28. Rollout order

1. Add save-scoped rating and calibration persistence schema/migration.
2. Extract the engine's probability expressions into pure evaluation functions (no RNG, no mutation).
3. Implement same-role benchmark construction.
4. Implement the read-only rating observer at the action-resolution boundary.
5. Implement event contribution accumulation and the rating-only role-seconds counter.
6. Implement raw standardization and season-frozen positional Gaussianization.
7. Implement 3.0–10.0 conversion.
8. Hook the observer and accumulator into competitive match simulation (live and instant; practice excluded).
9. Persist ratings transactionally at match finalization via `persistWorld`; wire `persistLiveMatchState` and `rebuildWorld`.
10. Add player-performance authorization (`canViewPlayerPerformance`).
11. Add the player-performance API.
12. Build the shared Performance chart component.
13. Add the compact player-popout section.
14. Add the full Squad-page Performance tab.
15. Add automated fairness/determinism/observer/security tests.
16. Add admin-only distribution diagnostics.
17. Reset the world; no legacy backfill (no authoritative action trace exists pre-rollout).

---

# 29. Why this model fits Footmania

This approach is preferable to a traditional weighted-stat rating because Footmania already owns the complete probabilistic match engine.

The game therefore does not need to guess that:

- one goal is worth six tackles;
- a save is worth 0.15;
- a CB deserves a clean-sheet bonus;
- a striker deserves a shooting multiplier.

The engine's own probability expressions already know how dangerous the situation was and how likely each outcome was. The rating reads those same expressions as a pure observer and asks one consistent question:

> **How much better or worse was the player's realized contribution than a typical player in the same role would have been expected to produce in the exact same situations?**

That makes the grade contextual, deterministic, position-balanced, hard to game, and almost entirely self-calibrating — with zero new gameplay tunables.
