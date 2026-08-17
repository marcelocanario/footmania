# Match Simulator Overhaul Plan — Revised Technical Specification

**Status:** Proposal only.
**Goal:** Replace the current match calculations with a live, reproducible, state-dependent football simulation in which player quality, positioning, fitness, tactics, substitutions, match state, and randomness continuously affect future events.

---

## 0. Simulation Architecture and Validation Harness

Build the simulation/testing infrastructure **before modifying match behaviour**.

The simulator must support:

```text
simulateMatch(seed, config)
simulateNMatches(teamA, teamB, count, config)
aggregateSimulationResults(results)
```

Every simulated match must persist:

```text
simulationSeed
engineVersion
balanceConfigVersion
```

This ensures historical matches remain reproducible even after balance constants change.

### 0.1 Required aggregate metrics

Track:

```text
Goals
xG
Shots
Shots on target
Possession
Home / Draw / Away %
Yellow cards
Red cards
Injuries
Penalties
Scoreline distribution
Comeback frequency
Red-card impact
Substitution impact
Tactical-change impact
Strength-gap win curves
Fatigue curves
Home-advantage curves
```

### 0.2 Core modelling rule

Each causal factor should enter the probability pipeline **once**.

For example:

```text
position fit
    ↓
effective player skill
    ↓
sector strength
    ↓
event probability
```

Do **not** subsequently add another generic `positionSignal`.

Likewise:

```text
energy → player readiness
morale → team force
pressing → possession/fatigue/cards/counter exposure
```

Each effect must have one clearly defined pathway.

---

# 1. Design Principles

The match is simulated live, minute by minute.

There must be:

* No hidden winner.
* No predetermined target score.
* No pre-generated list of future events.
* No result correction after the simulation.
* No random number reused to steer the whole match.

Every meaningful state change must affect subsequent probabilities.

Examples:

```text
Substitution
Tactical change
Goal
Red card
Injury
Fatigue
Formation change
Player reassignment
```

The simulation should behave as a **state-dependent event hazard model**.

At any moment:

```text
Current match state
    ↓
Player contributions
    ↓
Sector strengths
    ↓
Tactical interactions
    ↓
Live event hazards
    ↓
Random event draw
    ↓
Updated match state
```

---

# 2. Probability Architecture

Do not assign artificial percentage buckets such as:

```text
40% team
35% tactics
25% luck
```

because coefficient weights do not translate directly into outcome variance.

Instead separate the engine into:

```text
Deterministic football state
+
Match-level performance variance
+
Event-level randomness
```

### 2.1 Deterministic football state

Includes:

```text
Player ability
Position suitability
Energy
Formation
Morale/form
Tactical execution
Tactical matchup
Home advantage
Cards/injuries
Current score and time
```

### 2.2 Match-level performance variance

Each team receives a small seeded match-performance factor representing whether the team is having a particularly good or bad day.

Example:

```text
performanceVariance ~ Normal(0, 0.04)

matchPerformanceFactor =
    clamp(1 + performanceVariance, 0.90, 1.10)
```

Use the same factor throughout the match unless specific match events modify confidence.

This should create mild match-to-match variation without predetermining the result.

### 2.3 Event-level randomness

Every individual event receives its own seeded random draw.

Examples:

```text
Who wins possession?
Does possession become a shot?
Who receives the ball?
Does the shot score?
Does a foul occur?
Does an injury occur?
```

Football's low scoring already provides substantial natural variance. Therefore explicit random bonuses should remain small.

---

# 3. Position Suitability

## 3.1 Compatibility Matrix

Use the existing Elifoot-derived compatibility matrix as the initial tuning table.

| Natural \ Assigned |   GK |   LB |   CB |   RB |   SW |   LM |   CM |   RM |   LW |   RW |   ST |
| ------------------ | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GK                 | 1.00 |  .30 |  .35 |  .30 |  .30 |  .30 |  .30 |  .30 |  .27 |  .27 |  .27 |
| LB                 |  .30 | 1.00 |  .93 |  .90 |  .85 |  .64 |  .62 |  .51 |  .55 |  .49 |  .33 |
| CB                 |  .35 |  .93 | 1.00 |  .93 |  .85 |  .69 |  .68 |  .69 |  .36 |  .36 |  .26 |
| RB                 |  .30 |  .90 |  .93 | 1.00 |  .85 |  .51 |  .62 |  .64 |  .49 |  .55 |  .33 |
| SW                 |  .32 |  .81 |  .84 |  .84 | 1.00 |  .68 |  .74 |  .72 |  .32 |  .32 |  .32 |
| LM                 |  .27 |  .65 |  .66 |  .65 |  .82 | 1.00 |  .94 |  .87 |  .74 |  .61 |  .48 |
| CM                 |  .27 |  .56 |  .62 |  .56 |  .84 |  .94 | 1.00 |  .94 |  .68 |  .68 |  .61 |
| RM                 |  .27 |  .65 |  .66 |  .65 |  .82 |  .87 |  .74 | 1.00 |  .61 |  .74 |  .48 |
| LW                 |  .17 |  .32 |  .33 |  .16 |  .33 |  .74 |  .72 |  .71 | 1.00 |  .87 |  .84 |
| RW                 |  .17 |  .26 |  .33 |  .26 |  .33 |  .71 |  .72 |  .74 |  .87 | 1.00 |  .74 |
| ST                 |  .17 |  .26 |  .33 |  .32 |  .33 |  .59 |  .69 |  .59 |  .84 |  .84 | 1.00 |

## 3.2 Effective player skill

```text
fit(p,r) =
    positionCompatibility[naturalPosition(p)][r]

positionAdjustedSkill =
    gameSkill(p) * fit(p,r)
```

Fatigue is then applied separately:

```text
readiness(p) =
    1 - 0.28 * (max(0, 75 - energy(p)) / 75)^1.35

effectiveSkill(p,r) =
    positionAdjustedSkill * readiness(p)
```

Properties:

```text
energy >= 75 → readiness = 1.00
energy = 0   → readiness = 0.72
```

Do not add separate `positionSignal` or `readinessSignal` later.

Their effects are already contained within `effectiveSkill`.

---

# 4. Sector Model

Use:

```text
GK
DEFENCE
MIDFIELD
ATTACK
```

## 4.1 Base sector value

```text
sectorBase(s) =
    sum(effectiveSkill(p, assignedRole(p)))
```

## 4.2 Sector cohesion

Multiple misplaced players should produce a small additional organisational penalty.

```text
misplacement =
    weightedMean(1 - fit(p, assignedRole(p)))

sectorCohesion =
    1 - 0.12 * misplacement
```

Range:

```text
0.88 ≤ sectorCohesion ≤ 1.00
```

Then:

```text
sectorValue =
    sectorBase * sectorCohesion
```

Do not later add another generic position penalty.

---

# 5. Attack and Defence Forces

Use the initial asymmetric sector weights:

```text
defenceForce =
    3.0*GK
    + 0.9*DEF
    + 0.4*MID
    + 0.1*ATT

attackForce =
    0.0*GK
    + 0.1*DEF
    + 0.6*MID
    + 0.9*ATT
```

Midfield control remains independently available:

```text
midfieldForce = MID
```

These values should be externally configurable.

Example:

```ts
MATCH_BALANCE = {
    defenceWeights: {
        gk: 3.0,
        defence: 0.9,
        midfield: 0.4,
        attack: 0.1
    },
    attackWeights: {
        gk: 0,
        defence: 0.1,
        midfield: 0.6,
        attack: 0.9
    }
}
```

Do not hard-code balancing constants throughout the engine.

---

# 6. Energy, Stamina, Age, and Rest

## 6.1 Stamina capacity

Initially derive stamina from existing physical attributes.

```text
physicalSkill =
    mean(speed, strength/physical)

agePenalty =
    1.8 * max(0, age - 27)

physicalBonus =
    0.25 * (physicalSkill - 50)

staminaCapacity =
    clamp(
        100 - agePenalty + physicalBonus,
        45,
        100
    )
```

Age should primarily affect:

```text
fatigue
recovery
availability
```

rather than directly reducing technical skill.

---

## 6.2 Rest quality

```text
restQuality =
    clamp(
        100
        - 1.10 * minutesPlayedLast24h
        - 0.35 * minutesPlayedLast72h
        + 15 * daysSinceLastMatch,
        0,
        100
    )
```

Do not add an additional generic "rest penalty".

Rest should influence the match through player energy.

---

## 6.3 Daily recovery

```text
dailyRecovery =
    clamp(
        4
        + 0.04 * staminaCapacity
        + 0.02 * restQuality,
        4,
        10
    )

energyNextDay =
    min(100, energy + dailyRecovery)
```

---

# 7. In-Match Fatigue

Replace the current coarse fatigue interval with minute-level updates.

```text
roleLoad = {
    GK:  0.20,
    DEF: 0.75,
    MID: 1.00,
    ATT: 0.90
}
```

```text
pressLoad =
    1 + 0.22 * pressing/100

styleLoad = {
    cautious:  0.92,
    balanced:  1.00,
    attacking: 1.10
}

ageLoad =
    1 + 0.006 * max(0, age - 27)
```

Then:

```text
fatiguePerMinute(p) =
    0.32
    * roleLoad(p)
    * pressLoad
    * styleLoad
    * ageLoad
    * (100 / staminaCapacity(p))
    * (1 + 0.35 * (1 - energy(p)/100))
```

```text
energy(p,t+1) =
    max(0, energy(p,t) - fatiguePerMinute(p))
```

### Calibration target

A normal starter should lose approximately:

```text
25–35 energy / 90 minutes
```

High pressing, poor stamina, age, and demanding positions should increase this.

---

# 8. Sector Stamina

Collective fatigue may produce a **small organisational effect**, but individual fatigue is already represented through readiness.

```text
sectorEnergy =
    weightedMean(
        energy(p),
        contributionWeight(p)
    )
```

```text
sectorStamina =
    0.94 + 0.06 * sectorEnergy/100
```

Then:

```text
sectorValueFinal =
    sectorValue * sectorStamina
```

Maximum additional sector-level fatigue penalty:

```text
6%
```

This is deliberately smaller than the previous 10% to reduce double-counting.

---

# 9. Morale and Recent Form

## 9.1 Squad morale

```text
squadMorale =
    0.75 * mean(starterMorale)
    + 0.25 * mean(availableSquadMorale)
```

## 9.2 Form

Use performance relative to expectation rather than raw wins.

```text
expectedPointsLast5 =
    sum(expectedPoints)

actualPointsLast5 =
    sum(actualPoints)

formScore =
    clamp(
        50 + 3.33 *
        (actualPointsLast5 - expectedPointsLast5),
        0,
        100
    )
```

## 9.3 Combined factor

```text
moraleForm =
    0.80 * squadMorale
    + 0.20 * formScore
```

```text
moraleFactor =
    0.90 + 0.20 * moraleForm/100
```

Apply once:

```text
attackForce  *= moraleFactor
defenceForce *= moraleFactor
midfieldForce *= moraleFactor
```

Do **not** subsequently add `moraleSignal` to event calculations.

---

# 10. Reputation

Reputation should not function as hidden player strength.

Use reputation for:

```text
Attendance
Revenue
Transfers
AI behaviour
Media pressure
Match commentary
Opponent respect
```

Optional high-pressure effects:

```text
Cup final
Major rivalry
Extremely hostile away environment
```

may use reputation/context, but event impact must remain:

```text
≤ ±2%
```

and should be visible/explainable.

---

# 11. Home Advantage

Implement home advantage at the **chance-generation level**, not as player strength.

Neutral venue:

```text
homeAdvantage = 0
```

Normal home match calibration target:

```text
approximately +0.25 xG / match
```

However, do not literally add:

```text
+0.175 to shotLambda
+0.075 to xGPerShot
```

because those variables use different units.

Instead define configurable multipliers:

```text
homeCreationMultiplier
homeShotQualityMultiplier
```

Calibrate them through simulation until equal teams produce approximately:

```text
neutral:
home xG ≈ away xG

normal venue:
home xG - away xG ≈ +0.20 to +0.35
```

Initial target:

```text
+0.25 xG
```

Suggested distribution:

```text
70% from extra chance creation
30% from shot quality
```

The calibration harness should determine the exact multipliers.

---

# 12. Formation Shape

Formation should define **where a team's strength exists**, not grant arbitrary bonuses.

Calculate properties such as:

```text
attackingWidth
defensiveWidth

centralAttackDensity
centralDefenceDensity

playersCommittedForward
defensiveDepth
midfieldDensity
```

Do not compare:

```text
myWidth vs opponentWidth
```

directly.

Instead compare attack against opposition defence.

Example:

```text
wideExposure =
    relative(
        myAttackingWidth,
        opponentDefensiveWidth
    )

centralExposure =
    relative(
        myCentralAttackDensity,
        opponentCentralDefenceDensity
    )
```

Counterattack space:

```text
counterSpace =
    opponentPlayersCommittedForward
    * myCounterCapability
```

Formation effects should therefore emerge from actual matchup geometry.

---

# 13. Relative Comparison Function

For comparable positive values:

```text
relative(a,b) =
    200*a/(a+b+0.0001) - 100
```

Properties:

```text
a = b → 0

a >> b → approaches +100

a << b → approaches -100
```

Use this function where relative strength matters.

---

# 14. Tactical Familiarity

Track familiarity separately for:

```text
Formation
Style
Pressing
Direction
```

## 14.1 Growth

Let:

```text
G = scheduled season games
```

After using the component:

```text
growthRate =
    1 - exp(-3/G)

newFamiliarity =
    currentFamiliarity
    + (100-currentFamiliarity) * growthRate
```

A full season using the same setup should approach approximately:

```text
95 familiarity
```

---

## 14.2 Decay

```text
newFamiliarity =
    familiarity * exp(-0.005 * daysWithoutUse)
```

Decay must be slower than growth.

---

## 14.3 Combined familiarity

```text
combinedFamiliarity =
    0.45 * formationFamiliarity
    + 0.25 * styleFamiliarity
    + 0.15 * pressingFamiliarity
    + 0.15 * directionFamiliarity
```

---

# 15. Switching Tactics

When switching tactics, retrieve the familiarity of the **target tactic**.

Do not derive the new familiarity only from the currently selected tactic.

```text
targetFamiliarity =
    stored familiarity for new tactic component
```

Knowledge may partially transfer between similar systems:

```text
transfer =
    max(
        0,
        oldFamiliarity - targetFamiliarity
    )
    * similarity
    * transferCoefficient
```

Then:

```text
effectiveFamiliarity =
    clamp(
        targetFamiliarity + transfer,
        0,
        100
    )
```

Suggested initial:

```text
transferCoefficient = 0.35
```

### Pressing familiarity

Because pressing is numeric, familiarity should not be stored independently for every integer.

Use:

```text
ranges
or
continuous interpolation
```

For example:

```text
0–25    low press
26–50   medium-low
51–75   medium-high
76–100  aggressive
```

or interpolate familiarity based on distance between pressing values.

---

# 16. Tactical Execution

Familiarity determines **how well the team executes its tactical instructions**.

```text
tacticalExecution =
    0.60
    + 0.40 * effectiveFamiliarity/100
```

Then tactical effects are scaled by execution:

```text
executedEffect =
    rawTacticalEffect * tacticalExecution
```

Do not add familiarity itself as an independent team-strength bonus.

---

# 17. Tactical Styles

Map tactical styles to behaviours:

```text
CONTROL
PRESS
COUNTER
```

Initial matchup matrix:

| Row vs Column | Control | Press | Counter |
| ------------- | ------: | ----: | ------: |
| Control       |       0 |    -6 |      +4 |
| Press         |      +6 |     0 |      -8 |
| Counter       |      -4 |    +8 |       0 |

These are **interaction values**, not direct strength bonuses.

They must be tuned through simulation.

---

# 18. Direction

Direction modifies where attacks are attempted.

Examples:

```text
MIDDLE
LEFT
RIGHT
WIDE
BALANCED
```

Direction should influence:

```text
which defensive sector is challenged
which players participate
shot creator selection
crossing probability
central penetration probability
```

Avoid generic bonuses such as:

```text
wide beats narrow = +3 team strength
```

Instead:

```text
chosenDirection
    ↓
select relevant attacking sector
    ↓
compare against relevant defensive sector
```

This naturally creates tactical advantages.

---

# 19. Pressing

Pressing must have clearly separated consequences.

## Positive

```text
More possession contests
More turnovers
More pressure on opponent passing
```

## Negative

```text
Greater fatigue
More fouls/cards
More space behind pressure
Greater counterattack exposure
```

### 19.1 Possession pressure

Use pressing directly inside relevant possession/turnover calculations.

Do not also add a generic `pressingSignal`.

### 19.2 Fatigue

Already represented through:

```text
pressLoad =
    1 + 0.22 * pressing/100
```

Do not apply a second pressing fatigue multiplier elsewhere.

### 19.3 Passing errors

```text
wrongPassMultiplier =
    1 + 0.20 * opponentPressing/100
```

Apply only to pass/turnover events.

### 19.4 Counter exposure

```text
counterExposure =
    1 + 0.20 * pressing/100
```

Apply only when the opposition creates a counterattack.

---

# 20. Tactical Matchup

Tactical matchup should consist only of **interaction effects not already represented elsewhere**.

Example:

```text
styleInteraction
formationExposure
directionExposure
counterExposure
```

Then:

```text
rawTacticalMatchup =
    0.40 * styleInteraction
    + 0.35 * formationExposure
    + 0.15 * directionExposure
    + 0.10 * situationalExposure
```

Clamp:

```text
[-12, +12]
```

Then apply familiarity:

```text
tacticalMatchup =
    rawTacticalMatchup * tacticalExecution
```

Do not separately add:

```text
styleSignal
pressingSignal
directionSignal
familiaritySignal
```

after these effects have already been calculated.

---

# 21. Live Match State

Maintain a live structure containing at minimum:

```ts
MatchState {
    minute
    score

    homePlayers
    awayPlayers

    homeEnergy
    awayEnergy

    homeFormation
    awayFormation

    homeTactics
    awayTactics

    homeSectorForces
    awaySectorForces

    cards
    injuries
    substitutions

    homeXG
    awayXG

    homeMatchPerformanceFactor
    awayMatchPerformanceFactor

    rngState
}
```

Recalculate affected derived values after every meaningful state change.

---

# 22. Possession

Possession should depend primarily on midfield control plus tactical pressure.

For example:

```text
possessionStrength =
    midfieldForce
    * matchPerformanceFactor
    * relevantTacticalModifiers
```

Compare:

```text
possessionSignal =
    relative(
        homePossessionStrength,
        awayPossessionStrength
    )
```

Then:

```text
p(homePossession) =
    logistic(
        1.10 * possessionSignal/100
    )
```

where:

```text
logistic(x) =
    1/(1+exp(-x))
```

Clamp:

```text
0.25 ≤ p(homePossession) ≤ 0.75
```

The clamp prevents extreme teams from effectively eliminating the opponent's possession entirely.

---

# 23. Chance Creation

When a team controls the current attacking sequence, determine its attacking strength against the relevant defensive strength.

Example:

```text
attackStrength =
    attackForce
    * matchPerformanceFactor
    * tacticalAttackModifier
    * homeCreationMultiplier
```

```text
defensiveStrength =
    opponentDefenceForce
    * opponentMatchPerformanceFactor
    * defensiveTacticalModifier
```

Then:

```text
attackSignal =
    relative(
        attackStrength,
        defensiveStrength
    )
```

Initial shot hazard:

```text
shotLambda =
    0.28 * exp(
        0.85 * attackSignal/100
    )
```

```text
pShot =
    1 - exp(-shotLambda)
```

This is a chance-occurrence hazard.

The constant must be calibrated against desired shot totals.

---

# 24. Shooter Selection

Do not select shooters uniformly.

```text
scorerWeight(p) =
    max(
        0.01,
        attackContribution(p)
        * finishingSkill(p)
        * positionShotWeight(p)
    )
```

Sample from the resulting weighted categorical distribution.

Position weights should make:

```text
ST > LW/RW > attacking midfield > defensive midfield > defenders
```

while still allowing occasional goals from all outfield positions.

---

# 25. Shot Quality and xG

Once a shot occurs, calculate its actual scoring probability.

```text
shooterVsGK =
    relative(
        shooterEffectiveSkill,
        goalkeeperEffectiveSkill
    )
```

Add situational components:

```text
shotSignal =
    0.55 * attackSituationSignal
    + 0.20 * shooterVsGK
    + 0.15 * tacticalShotQuality
    + 0.10 * staminaSituation
```

Then:

```text
xGPerShot =
    clamp(
        0.115
        * exp(1.10 * shotSignal/100),
        0.025,
        0.40
    )
```

### Critical rule

```text
p(goal | shot) = xGPerShot
```

Do **not** use:

```text
1 - exp(-xGPerShot)
```

because xG itself already represents the scoring probability of that shot.

Store:

```text
teamXG += xGPerShot
```

Then:

```text
goal =
    RNG() < xGPerShot
```

---

# 26. Goalkeeper Influence

Goalkeeper quality should primarily affect:

```text
shot conversion
```

rather than preventing most chances from existing.

A strong goalkeeper should reduce:

```text
p(goal | shot)
```

but should not automatically prevent the opponent from generating shots.

This preserves meaningful distinctions between:

```text
defensive quality
and
goalkeeping quality
```

---

# 27. Red Cards

Do **not** use:

```text
(playersOnPitch / 11)^2
```

after already removing the dismissed player's contribution.

Instead use two separate effects.

## 27.1 Direct effect

Remove the player from:

```text
sector contribution
formation shape
energy calculation
morale composition
role availability
```

## 27.2 Organisational effect

Apply a calibrated manpower/shape penalty.

Example state:

```text
manpowerDifference =
    ownPlayers - opponentPlayers
```

Initial configurable values might include:

```text
10v11:
attack organisation  -10% to -20%
defensive organisation -5% to -15%

9v11:
substantially larger penalties
```

Exact values must be determined by simulation.

The impact should depend on the dismissed role.

Examples:

```text
ST red:
larger attacking loss
smaller immediate defensive disruption

CB red:
large defensive disruption

CM red:
large midfield/possession disruption
```

If the manager reorganises the formation, recompute the shape and reduce the organisational penalty accordingly.

---

# 28. Score-State Behaviour

Current score should affect **behaviour**, not secretly modify finishing luck.

Examples:

Trailing team:

```text
may increase attacking commitment
may increase pressing
may commit more players forward
```

Leading team:

```text
may reduce risk
may defend deeper
may counterattack more
```

For AI teams, these changes should come through tactical decisions.

Do not implement:

```text
losing team gets hidden goal bonus
```

or:

```text
winning team gets hidden finishing penalty
```

---

# 29. Other Match Events

Use hazards for:

```text
Yellow cards
Red cards
Injuries
Penalties
```

Baseline values must represent **average neutral conditions**, not minimum rates.

Initial targets:

| Event        | Approximate total/match |
| ------------ | ----------------------: |
| Yellow cards |                     4.5 |
| Red cards    |                    0.15 |
| Injuries     |                    0.35 |
| Penalties    |                    0.25 |

---

# 30. Centred Event Modifiers

Do not use:

```text
multiplier =
    1
    + positiveModifier
    + positiveModifier
    + positiveModifier
```

because average event frequency will always exceed the stated baseline.

Instead define reference conditions.

For yellow cards:

```text
cardMultiplier =
    exp(
        βPress * (pressing - referencePressing)
        + βFatigue * (fatigue - referenceFatigue)
        + βExposure * (exposure - referenceExposure)
        + βDiscipline * (disciplineRisk - referenceDiscipline)
    )
```

Then:

```text
lambdaPerMinute =
    baselineRate/90
    * cardMultiplier
```

```text
pEvent =
    1 - exp(-lambdaPerMinute)
```

The same pattern should be used for:

```text
injuries
penalties
red cards
```

---

# 31. Yellow Cards

Player selection should depend on actual involvement.

Example weight:

```text
yellowWeight(p) =
    duelInvolvement
    * defensiveExposure
    * disciplineRisk
    * fatigueRisk
```

A defender repeatedly stopping attacks should therefore be more likely to receive the card than an uninvolved player.

---

# 32. Red Cards

Red-card probability should depend on:

```text
Existing yellow card
Discipline
Pressing
Dangerous duel
Fatigue
Defensive emergency
Event randomness
```

Second-yellow and straight-red events should be modelled separately.

---

# 33. Injuries

Injury risk should depend on:

```text
Fatigue
Age
Recent workload
Match contact/load
Player durability, if available
Randomness
```

Do not use age as a direct match ability penalty.

Age should instead increase workload consequences.

---

# 34. Penalties

Penalty hazards should depend primarily on:

```text
Box entries
Attacking pressure
Defender exposure
Tackle behaviour
Player discipline
Random event draw
```

Penalty conversion is then a separate event:

```text
penaltyTakerSkill
vs
goalkeeperSkill
```

---

# 35. Goal Types and Assists

Goal types should be weighted from the actual attacking situation.

Possible categories:

```text
Central attack
Through ball
Counterattack
Cross/header
Long shot
Set piece
Penalty
Rebound
```

Weights should depend on:

```text
Formation
Direction
Style
Players involved
Opponent shape
Match state
```

Assist selection should likewise use weighted player involvement.

---

# 36. Substitutions

When a substitution occurs:

1. Remove outgoing player contribution.
2. Add incoming player's current energy.
3. Calculate incoming position fit.
4. Recalculate relevant sector.
5. Recalculate formation shape if necessary.
6. Recalculate morale composition.
7. Recalculate tactical execution if roles changed.
8. Apply all new probabilities starting with the next simulation step.

Nothing in the previous match state may predetermine subsequent events.

---

# 37. AI Substitutions

Use a rule-based score.

```text
substitutionNeed =
    0.45 * fatigueNeed
    + 0.25 * sectorDeficit
    + 0.15 * scoreUrgency
    + 0.15 * riskNeed
```

Normalize all components to:

```text
0–100
```

Replacement selection:

```text
replacementValue =
    0.65 * effectiveSkill
    + 0.25 * energy
    + 0.10 * (fit * 100)
```

All components are now comparable.

Add small seeded timing uncertainty so AI substitutions do not occur at identical minutes every match.

---

# 38. Tactical Changes During Matches

Human or AI tactical changes must affect the **next simulation step**.

Changing:

```text
Formation
Style
Pressing
Direction
Roles
```

must recalculate only the affected derived states.

Example:

```text
minute 60:
manager changes to high press

minute 61:
possession contest changes
fatigue load changes
card risk changes
counter exposure changes
```

No future event list exists that needs to be rewritten.

---

# 39. UI — Lineup

For every player display:

```text
Natural position: CM
Assigned position: ST
Position fit: 61%
Effective position penalty: -39%
Current energy: 83
Current readiness: 100%
```

Also expose sector impact where useful:

```text
Midfield cohesion: 94%
```

Use:

```text
Green
Yellow
Red
```

fit indicators.

Saved lineups must apply exactly the same penalties as manually assembled lineups.

---

# 40. UI — Tactics

Display:

```text
Formation familiarity
Style familiarity
Pressing familiarity
Direction familiarity
Combined familiarity
```

Also explain consequences.

Example:

```text
High Press

+ More pressure on possession
+ More turnovers

- Higher fatigue
- Higher foul/card risk
- More vulnerable to counterattacks
```

Do not expose arbitrary hidden numerical bonuses unless needed for debugging.

---

# 41. UI — Match

Display:

```text
Possession
Shots
Shots on target
xG
Team stamina
Sector stamina
Cards
Substitutions
```

After a substitution, optionally show:

```text
Midfield strength: +4.8%
Midfield stamina: +9.2%
Estimated possession change: +2.1 pp
```

These estimates should come from the actual engine calculation.

---

# 42. Event Explanation Payload

Major events should retain enough data for debugging and optional UI explanations.

Example:

```ts
{
    eventType: "GOAL",
    minute: 63,

    attackingSector: "ATTACK",
    defendingSector: "DEFENCE",

    attackerStrength: 71.2,
    defenderStrength: 66.1,

    tacticalModifier: 1.04,

    shooterSkill: 78,
    goalkeeperSkill: 74,

    shooterEnergy: 67,

    xG: 0.18,

    rngDraw: 0.12
}
```

This makes the simulator explainable and testable.

The user-facing UI does not necessarily need to expose raw RNG values.

---

# 43. Configuration Architecture

All balance constants should live in a centralized configuration.

Example:

```ts
MatchBalanceConfig {
    fatigue
    position
    morale
    homeAdvantage
    tacticalEffects
    shotGeneration
    shotQuality
    cards
    injuries
    penalties
    redCards
}
```

Support:

```text
balanceConfigVersion
```

This allows tuning without rewriting the engine.

---

# 44. Implementation Order

## Phase 0 — Measurement infrastructure

1. Create seeded simulation harness.
2. Create aggregate result reports.
3. Persist engine/balance versions.
4. Establish current-engine baseline statistics.

## Phase 1 — Player and sector fundamentals

5. Add position compatibility.
6. Add position warnings.
7. Refactor effective skill.
8. Create sector strength system.
9. Add sector cohesion.

## Phase 2 — Physical state

10. Implement stamina capacity.
11. Implement daily recovery.
12. Replace coarse energy drain with per-minute fatigue.
13. Add readiness.
14. Add small sector-stamina effect.

## Phase 3 — Team state

15. Add morale.
16. Add form.
17. Remove or cap direct reputation effects.
18. Implement calibrated home advantage.

## Phase 4 — Tactics

19. Add component familiarity storage.
20. Implement familiarity growth/decay.
21. Implement target-tactic familiarity switching.
22. Add tactical execution.
23. Implement style interactions.
24. Implement formation exposures.
25. Implement directional sector targeting.
26. Implement pressing trade-offs.

## Phase 5 — Live event model

27. Refactor possession calculation.
28. Implement chance-generation hazards.
29. Implement weighted shooter selection.
30. Implement true xG shot conversion.
31. Store cumulative live xG.

## Phase 6 — Match-state events

32. Implement role-sensitive red-card effects.
33. Implement centred yellow-card hazards.
34. Implement injury hazards.
35. Implement penalty hazards.
36. Implement goal types and assists.

## Phase 7 — Live management

37. Refactor human substitutions.
38. Add AI substitution scoring.
39. Ensure tactical changes affect next-step probabilities.
40. Implement AI score-state tactical responses.

## Phase 8 — Explainability and UI

41. Add event explanation payloads.
42. Add lineup fit indicators.
43. Add tactical familiarity UI.
44. Add sector stamina/strength indicators.
45. Add live xG and statistics.

## Phase 9 — Final tuning

46. Run large Monte Carlo batches.
47. Tune constants from distributions.
48. Run sensitivity analysis.
49. Lock balance configuration version.
50. Create regression thresholds.

---

# 45. Validation Targets

These are tuning targets, not hard-coded outcomes.

## 45.1 Equal neutral teams

Target approximately:

```text
Possession:        50 / 50
Team xG:           1.2–1.4
Total goals:       2.3–2.8
```

Neither team should possess systematic advantage.

---

## 45.2 Equal teams with home advantage

Target approximately:

```text
Home xG advantage:
+0.20 to +0.35

Home win:
42%–46%

Draw:
24%–28%

Away win:
28%–34%
```

---

# 46. Strength Curve Tests

Simulate teams with controlled strength differences.

Example:

```text
Equal strength
+5%
+10%
+20%
+30%
```

Check:

```text
win probability increases monotonically
```

but does not become deterministic too early.

A clearly stronger team must:

```text
win more
create more xG
concede less xG
```

while still occasionally drawing or losing.

---

# 47. Position Tests

Verify:

* Natural-position player outperforms the same player remotely out of position.
* Adjacent-role penalties are smaller than remote-role penalties.
* Saved and manually selected lineups behave identically.
* Multiple misplaced players create a small cohesion penalty.
* Position penalties are not applied multiple times.

---

# 48. Fatigue Tests

Verify:

* Equal players differ when one begins tired.
* Full-energy substitutions materially improve tired sectors.
* Midfielders generally lose more energy than goalkeepers.
* High pressing increases fatigue.
* Older players fatigue faster under identical workload.
* Older players recover more slowly.
* Fatigue does not completely erase player quality.

---

# 49. Tactical Tests

Verify independently:

```text
Style
Pressing
Formation
Direction
Familiarity
```

For each factor:

1. Hold every other variable constant.
2. Change only the factor under test.
3. Simulate thousands of matches.
4. Verify the intended outcome shifts.
5. Verify unrelated outcomes do not move excessively.

Example:

```text
increase pressing
```

should produce:

```text
↑ possession pressure
↑ fatigue
↑ cards
↑ counter vulnerability
```

but should not mysteriously increase finishing ability.

---

# 50. Familiarity Tests

Verify:

* Repeated use increases familiarity.
* Familiarity growth slows near 100.
* Unused systems decay slowly.
* Returning to a previously learned tactic restores stored knowledge.
* Switching to similar tactics transfers some execution ability.
* Switching to a completely unfamiliar tactic produces lower execution.
* Familiarity scales tactical execution rather than generic player strength.

---

# 51. Red-Card Tests

Compare:

```text
11v11
10v11 striker dismissed
10v11 midfielder dismissed
10v11 centre-back dismissed
9v11
```

Validate:

```text
xG
possession
shots
goals
win probability
```

The dismissed player's position must affect the type of disruption.

Reorganising the formation should partially compensate.

---

# 52. Randomness Tests

Run identical teams thousands of times.

Verify that:

```text
results vary naturally
```

Then disable match-level performance variance while retaining event draws.

Variance should fall slightly.

Then run deterministic event expectations without draws.

The stronger team ordering should remain intact.

This separates:

```text
underlying football strength
from
outcome variance
```

Do not attempt to prove "luck = 25%" from coefficient weights.

If a specific desired fraction of variance attributable to randomness is required, estimate it empirically from simulation.

---

# 53. Reproducibility Tests

Given:

```text
same teams
same tactics
same starting state
same simulation seed
same engine version
same balance version
same user decisions
```

the match must produce exactly the same result and event sequence.

Changing a decision should change subsequent RNG/state progression in a deterministic manner.

---

# 54. Regression Tests

Every balance or engine change should automatically test:

```text
Average goals
Average xG
Shot volume
Home advantage
Draw rate
Card rate
Penalty rate
Injury rate
Upset frequency
Red-card impact
Strength curve
```

Define acceptable bands rather than exact values.

Example:

```text
goalsPerMatch:
target = 2.55
acceptable = 2.30–2.80
```

A commit that moves major statistics outside their allowed range should fail simulation regression testing.

---

# 55. Final Engine Flow

The intended final simulation pipeline is:

```text
PLAYER DATA
    ↓
position fit
    ↓
energy/readiness
    ↓
effective player contribution
    ↓
sector aggregation
    ↓
sector cohesion
    ↓
small sector stamina effect
    ↓
morale/form
    ↓
live ATT/MID/DEF/GK forces
    ↓
formation geometry
    ↓
tactical interaction
    ↓
tactical execution/familiarity
    ↓
match-performance variance
    ↓
event-specific live strength
    ↓
state-dependent event hazard
    ↓
seeded random event draw
    ↓
new match state
    ↓
recalculate affected inputs
```

For shots:

```text
possession
    ↓
chance hazard
    ↓
shot
    ↓
weighted shooter selection
    ↓
shooter + situation + GK
    ↓
xG
    ↓
Bernoulli(xG)
    ↓
goal / no goal
```

---

# 56. Expected Result

The final simulator should produce matches where:

* Better teams win more frequently without deterministic outcomes.
* Player quality remains the main long-term driver.
* Out-of-position players create understandable penalties.
* Formation changes alter where advantages exist.
* Tactics change how strength is applied rather than giving arbitrary bonuses.
* Familiar tactics are executed better than unfamiliar ones.
* High pressing produces both advantages and costs.
* Fatigue creates meaningful late-match changes.
* Substitutions immediately matter.
* Red cards alter both manpower and structure.
* Home advantage shifts probabilities without forcing results.
* xG accurately represents scoring probability.
* Randomness creates football-like variation without steering the entire match.
* Every major match event can be traced back to actual engine inputs.
* Replaying the same state with the same seed remains deterministic.
* Balance constants can be tuned without redesigning the engine.

The central design rule is:

```text
One football cause → one defined engine effect.
```

That prevents hidden double-counting and makes the simulator substantially easier to balance, test, explain, and extend.
