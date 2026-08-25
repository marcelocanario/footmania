# Player Generation, Development, Careers, Contracts, and Population Rebalance

## 1. Status and scope

This plan replaces the current independent-age player generation model with a
career-shaped model and recalibrates Division 1 around an 80 OVR automatic
starting XI, normally ranging from about 73 to 87 OVR.

The world will be reset when this work lands. There is no generation or
development version field and no compatibility branch for existing players.
The new formulas become authoritative for every generated player.

This plan covers:

- division-scaled senior and academy player generation;
- skill-based development and decline;
- manager-driven movement of good players up the division pyramid;
- academy and professional contract lifecycles;
- retirement and non-retirement population replacement;
- economy and calibration changes required by the higher D1 quality target.

This plan does not make filler AI persistent. Filler AI remains ephemeral,
does not use the market, and is excluded from persistent population accounting.

## 2. Product goals

1. A newly generated D1 automatic XI should average about 80 OVR, with its
   weakest starter around 73 and strongest starter around 87.

2. Every lower division should use the same distributions and career curve at
   a lower quality anchor. Adjacent divisions should overlap enough for an
   exceptional lower-division player to be useful higher in the pyramid.

3. Young players should normally begin below first-team quality. Rare elite
   prospects must still exist.

4. Initial senior players should look as if they have already followed the
   normal development curve. Young seniors are still developing, prime-age
   players are generally strongest, and veterans reflect decline.

5. Overall must always be derived from the seven persisted skills. Generation
   and development may target an OVR-equivalent amount, but neither may add to
   or subtract from `player.overall` independently.

6. Player movement remains manager-driven. The game must not label a player as
   belonging to a particular division, recommend a mandatory division, refuse
   a contract because of division, or automatically list a human club's player.
   Managers evaluate visible skills, OVR, age, price, wage, and contract terms.

7. Lower-division clubs should have a natural opportunity to use an excellent
   homegrown player before market value and professional wages create a genuine
   keep-or-sell decision.

8. Academy intake must replace expected retirements plus real uncompensated
   non-retirement losses, including free agents deleted after their retention
   period. Youth dismissal must not create replacement entitlement.

## 3. Current problems

### 3.1 Senior quality ignores age

The current senior target is:

```text
divisionMean + playerQualitySpreadOverall * Z
```

Age is drawn independently afterward. An 18-year-old and a 28-year-old have
the same expected OVR, so an initial squad does not resemble players who have
already lived through the development system.

### 3.2 Academy pedigree is mostly immediate ability

Youth generation subtracts expected growth only to age 21, then adds a large
academy pedigree boost directly to current OVR. A strong academy can therefore
produce several teenagers who are already first-team stars.

### 3.3 Development units are inconsistent

Generation treats the configured seasonal growth curve as OVR movement. Live
development distributes the same number as raw skill points. Because skill
weights differ by position, the resulting OVR movement is smaller and differs
materially between positions.

### 3.4 Professional contracts can remain anchored to stale wages

Renewal demand is currently based on persisted salary plus a raise. A player
who improves substantially can therefore remain far below the professional
salary implied by his current OVR.

### 3.5 Academy contracts and age 21 are not one strict boundary

Academy contracts use one fixed configured duration even though recruits enter
at different ages. Youth cannot renew through the professional contract route,
and an unpromoted youth can reach contract expiry without a clean professional
free-agent transition.

### 3.6 Population intake assumes retirement is the only terminal sink

The automatic academy intake mean models the academy-to-retirement lifetime.
An unclaimed free agent is permanently deleted after the retention period, but
that additional sink is not included in future academy intake.

## 4. Division quality model

Keep the existing division-strength curve:

```text
bottomDivisionMean = topDivisionMeanOverall - divisionOverallSpan

divisionMean(D) =
  bottomDivisionMean
  + divisionOverallSpan * divisionStrength(D)
```

`topDivisionMeanOverall` remains the mean of the complete generated D1 senior
population, not the mean of the selected XI. Best-XI selection raises the
automatic lineup above the full-squad population mean.

Initial calibration candidate:

```jsonc
"playerGeneration": {
  "topDivisionMeanOverall": 75,
  "playerQualitySpreadOverall": 5,
  "academyQualitySpreadOverall": 6,
  "divisionOverallSpan": 18,
  "seniorPeakOverallOffset": 4,
  "academyPedigreeOverallBoost": 18
}
```

Prototype results for this candidate over 500 generated D1 clubs:

| D1 automatic XI metric | Prototype result |
| --- | ---: |
| Average OVR | 80.3 |
| Average weakest starter | 73.6 |
| Average strongest starter | 86.8 |
| Academy starters per XI | 0.3 |

Illustrative five-division projection:

| Division | Senior population mean | Approximate XI average | Approximate XI range |
| --- | ---: | ---: | ---: |
| D1 | 75.0 | 80 | 73-87 |
| D2 | 68.4 | 74 | 67-80 |
| D3 | 63.6 | 69 | 62-75 |
| D4 | 60.0 | 65 | 59-72 |
| D5 | 57.0 | 62 | 56-69 |

These values are acceptance-test starting points. Final tunables must come from
the production generator and full calibration suite, not from comments or one
fixed seed.

## 5. Career-shaped generation

### 5.1 Personal profile first

Generation draws these before calculating current quality:

- age;
- raw birth-quality Z;
- personal decline start age;
- development rate;
- development volatility.

Raw Z remains independent from the development profile. A lucky birth-quality
draw creates a high-quality career anchor; development rate and decline age
control the shape and duration of the career.

### 5.2 Senior peak anchor

For a senior generated in division D:

```text
seniorPeakMean(D) = divisionMean(D) + seniorPeakOverallOffset

personalPeakTarget =
  seniorPeakMean(D)
  + playerQualitySpreadOverall * Z
```

### 5.3 Academy peak anchor

Academy pedigree continues to use current and historical division strength:

```text
pedigree =
  0.65 * currentDivisionStrength
  + 0.35 * highestEverDivisionStrength
```

The pedigree bonus applies to the career anchor, not directly as an immediate
current-OVR gift:

```text
academyPeakMean =
  bottomDivisionMean
  + seniorPeakOverallOffset
  + academyPedigreeOverallBoost * pedigree

personalPeakTarget =
  academyPeakMean
  + academyQualitySpreadOverall * Z
```

Setting the maximum pedigree boost equal to the division span means a stable
D1 academy has the same normal peak anchor as D1 seniors. The wider academy
spread preserves rare wonderkids without widening every senior squad.

### 5.4 Current OVR from career age

Before the personal decline age:

```text
careerAgeOffset =
  -remainingNaturalGrowth(age, declineStartAge)
  * developmentRate
  * historicalGrowthActivityModifier
```

After decline begins:

```text
careerAgeOffset =
  -accumulatedNaturalDecline(declineStartAge, age)
  * developmentRate
  * historicalDeclineActivityModifier
```

The generated target is:

```text
currentTargetOVR = personalPeakTarget + careerAgeOffset
```

Skills are generated toward that target. The persisted overall is always
recomputed with `overallFromSkills(position, skills)`.

Illustrative D1 academy distribution under the candidate calibration:

| Age | Mean OVR | Approximate P90 | Approximate P99 |
| --- | ---: | ---: | ---: |
| 16 | 60 | 69 | 76 |
| 17 | 63 | 71 | 78 |
| 18 | 65 | 73 | 80 |
| 19 | 68 | 76 | 83 |

### 5.5 Initial senior ages

Replace `TN(24, 4, 18, 38)` with the standing-career survivorship distribution
already implied by academy promotion and retirement probabilities.

The distribution is calculated per position:

```text
weight(age) = probability of remaining active through that age
```

Goalkeepers naturally receive the existing three-year retirement grace. The
same authoritative survivorship helper must be reused by initial senior age
generation, academy intake planning, and admin analytics.

## 6. Skill-based development

The age curve grants an OVR-equivalent development budget. That budget must be
translated into raw skill progress before any mutation.

For the player's position and current training focus:

```text
ovrSensitivity =
  overallScale(position)
  * sum(overallWeight(skill) * trainingWeight(skill))

rawSkillBudget = ovrEquivalentBudget / ovrSensitivity

skillProgress(skill) = rawSkillBudget * trainingWeight(skill)
```

Development then follows the existing accumulator model:

1. Add fractional progress to each skill accumulator.
2. Apply an integer skill point only when its accumulator crosses 1 or -1.
3. Respect skill bounds and the player's potential ceiling.
4. Recompute OVR from the resulting skills.

The normalization does not set OVR directly. It only determines how much raw
skill progress is needed for comparable expected OVR movement across positions.

Playing time remains authoritative:

- regular starters grow faster;
- rotation players grow more slowly;
- inactive players grow least;
- active veterans decline more slowly than inactive veterans.

Training focus still changes which individual skills receive the progress.

## 7. Manager-driven career movement

There is no division-fit label, division recommendation, automatic listing,
forced sale, or division-based contract refusal.

Managers evaluate players from visible football and economic information:

- individual skills;
- OVR;
- age;
- energy and availability;
- current wage;
- requested wage and contract duration;
- transfer price and value;
- squad needs and tactics.

Upward careers emerge from these systems:

1. Division distributions overlap. An excellent D3 prospect can reach normal
   D2 quality and the lower end of D1 quality.

2. Development has no division ceiling. Playing in D3 does not stop a player
   from becoming substantially better than normal D3 quality.

3. Player value increases with visible OVR and age through the existing value
   authority.

4. Professional salary requests are recalculated from current OVR whenever a
   new contract is negotiated, so a rapidly improving player cannot remain on
   a stale low-skill salary forever.

5. Higher divisions retain larger seasonal budgets.

6. The existing transfer cap permits stronger-division buyers to bid a higher
   multiple when purchasing from a weaker division.

7. The producing manager decides whether the sporting value justifies the new
   salary or whether selling is the better use of the player's market value.

Transfer history and immutable generation origin metadata remain available for
future career-history presentation, but they do not classify player quality.

## 8. Contract authority

### 8.1 One professional salary calculation

Every newly negotiated professional contract must use one shared function.

Inputs:

- current OVR;
- current age;
- requested contract seasons;
- remaining current-season fraction when relevant.

The professional market baseline is:

```text
professionalBaseSalary = calculateBaseSalary(currentOVR, currentAge)
```

The selected duration then applies the existing compounded year-over-year
contract demand model:

```text
professionalContractSalary =
  calculateContractDemand(
    professionalBaseSalary,
    currentOVR,
    currentAge,
    requestedSeasons,
    currentSeasonFraction
  )
```

The annual raise floor used by that model must be calibrated to at least 10
percent per year, as required for longer deals to cost meaningfully more. The
raise floor, skill weight, age curve, exponent, and cap remain centralized
config tunables.

This authority is reused for:

- a youth player's first professional contract on promotion;
- ordinary professional renewal;
- the winning contract attached to a transfer bid;
- a free-agent signing;
- generated senior first contracts.

Persisted professional salary remains fixed for the signed contract. Daily
development does not silently recalculate wages. Current OVR is consulted again
only when the next professional contract is negotiated.

### 8.2 Academy salary

Academy salary uses the professional salary for the same current OVR and age:

```text
academySalary =
  max(salaryFloor, professionalBaseSalary * academySalaryMultiplier)
```

The academy multiplier remains configurable. Academy salary is contractual for
the youth term and is not a professional salary promise after promotion.

### 8.3 Academy term ends before age 21

At generation, academy contract duration is derived from the player's current
age and the configured academy deadline. It may never extend beyond the point
at which the player reaches age 21.

```text
academyContractDays = days until age 21
```

Youth contracts cannot be renewed as youth contracts.

At age 20, the club receives the normal contract-expiry warning. Before the
age-21 boundary, the manager may promote the player and select a professional
contract term.

Promotion requires:

- an available senior roster slot;
- a requested professional contract duration;
- salary calculated from the player's current OVR and age through the shared
  professional contract authority.

At the age-21 rollover boundary:

- a youth with a completed professional promotion remains with the club as a
  senior;
- an unsigned youth leaves the academy;
- the departing player is converted to a non-youth professional free agent;
- a normal free-agent listing is created using current OVR, age, and contract
  terms;
- no player remains `isYouth = true` at age 21 or later;
- no player retains academy salary after becoming professional.

There is no automatic retention or automatic professional contract. The club
must choose the contract term and accept its current-skill salary before the
deadline, or the player leaves.

### 8.4 API and UI implications

The academy promotion mutation must accept `contractSeasons`.

Before confirmation, the UI displays the server-calculated professional salary
for every allowed term. The server remains authoritative and recalculates the
demand inside the locked mutation.

The existing professional contract endpoint uses the same options and shared
salary authority. Transfer and free-agent bid previews also use that authority
with immutable listing snapshots where required for retry-safe settlement.

## 9. Persistent population replenishment

### 9.1 Baseline retirement model

Keep the existing automatic academy intake mean as the expected replacement
rate for the configured academy-to-retirement lifecycle:

```text
retirementBaselinePerClub =
  targetPersistentPlayersPerClub
  / expectedPlayerLifetimeFromAcademyEntry
```

This remains the long-run retirement compensation and responds to academy entry
ages, the age-21 boundary, position mix, and live retirement probabilities.

### 9.2 Signed global correction

Maintain a signed, durable population correction in multiplayer state.

For each intake cycle:

```text
expectedGlobalIntake =
  retirementBaselinePerClub * persistentClubCount
  + carriedCorrection
  + eligibleNonRetirementDestructions
  - extraNonAcademyGeneration
  + newClubPopulationGap
```

Definitions:

| Flow | Correction effect |
| --- | ---: |
| Expected retirement | Already in baseline; no additional effect |
| Free agent deleted after retention | +1 |
| Youth dismissed by manager | 0 |
| Filler AI player deleted or generated | 0 |
| Senior floor replacement generated | -1 |
| Financial intervention replacement generated | -1 |
| New persistent club expected roster | Included in club-growth target |
| New persistent club actual generated roster | Subtracted from club-growth target |
| Human replacing filler | Filler flows 0; new human expected/actual gap normally 0 |

The correction is signed. Extra replacement generation can create a temporary
surplus that reduces future academy intake; later free-agent deletion can cancel
that surplus. This prevents double replacement.

Fractional expected intake and blocked academy capacity remain in
`carriedCorrection` rather than being discarded.

### 9.3 Fair global allocation

Resolve one global integer intake total, then allocate exact slots across all
persistent non-filler clubs.

Allocation rules:

1. Give every eligible club the same integer base share.
2. Assign remainder slots by a stable hash of world seed, season, and club ID.
3. Rotate remainder priority naturally because the season is part of the hash.
4. Generate each assigned player from the recipient club's own current division
   and academy pedigree.
5. Respect the academy roster limit.
6. Do not redistribute a blocked club's slots during the same intake pass.
7. Carry ungenerated slots into the next global correction.

Youth dismissal can create academy capacity, but it cannot increase the global
total or the dismissing club's predetermined share. This preserves the reroll
protection.

### 9.4 Population flow accounting

Record durable counters by structural cause:

- retirees;
- free agents deleted after retention;
- youth dismissed;
- academy players generated from baseline;
- academy players generated from correction;
- initial persistent-club players generated;
- senior floor replacements generated;
- financial intervention replacements generated;
- filler players created and destroyed;
- correction before allocation;
- expected global intake;
- actual global intake;
- correction carried forward.

`deleteUnclaimedFreeAgent()` increments the eligible sink exactly once. Its
existing terminal deletion and listing cleanup provide the idempotency boundary.

Admin population analytics must show both total stock and these flows so drift
can be diagnosed without changing gameplay formulas.

## 10. Economy recalibration

The higher D1 target changes salaries and values nonlinearly. Budget assumptions
must be derived from generation configuration rather than hard-coded OVR values.

Update:

- expected D1 full-squad OVR;
- expected D1 XI OVR;
- representative meaningful-signing percentile;
- representative elite-player percentile;
- D1 wage budget;
- tier budget curve;
- expected signings per season;
- financial intervention calibration;
- salary and value analytics.

The existing budget helper that returns a fixed 72 OVR must be removed or made
derived from the canonical generation projection.

## 11. Configuration changes

Add or retune these designer-facing settings in `game.config.jsonc` and its Zod
schema/defaults:

| Setting | Initial candidate | Purpose |
| --- | ---: | --- |
| `topDivisionMeanOverall` | 75 | Full D1 senior population mean |
| `playerQualitySpreadOverall` | 5 | Senior within-division spread |
| `academyQualitySpreadOverall` | 6 | Wider academy talent tail |
| `divisionOverallSpan` | 18 | D1-to-bottom population gap |
| `seniorPeakOverallOffset` | 4 | Peak anchor above all-age division mean |
| `academyPedigreeOverallBoost` | 18 | Maximum pedigree peak-anchor shift |
| `academySalaryMultiplier` | existing value | Youth fraction of professional base |
| `renewalMinRaise` | at least 0.10 | Minimum annual premium in a longer deal |

Do not hard-code these values in generation, contract, or market services.

Align all shipped config values, Zod defaults, fallback defaults, comments,
business rules, and calibration assertions.

## 12. Implementation sequence

1. Extract pure development-curve and retirement-survivorship helpers so
   generation, live development, intake planning, and analytics share them.

2. Implement position-normalized skill development while preserving skill
   accumulators, training focus, potential ceilings, and OVR derivation.

3. Implement profile-first, career-shaped senior and youth generation.

4. Implement position-specific standing-career senior age generation.

5. Add the separate academy spread and peak-offset config fields.

6. Rework academy contract duration to end at age 21 and remove automatic
   age-based retention.

7. Add contract-term selection to promotion and implement the shared
   current-OVR professional contract salary authority.

8. Reuse the same professional contract authority for renewals, transfers,
   free agents, and generated professionals.

9. Add signed population correction counters and fair global intake allocation.

10. Derive budget quality assumptions from generation projections and
    recalibrate the economy.

11. Update APIs and frontend contract/promotion flows.

12. Update `BUSINESS_RULES.md`, generation fixtures, analytics, and all affected
    tests only after final calibration values are accepted.

## 13. Required tests and calibration

### 13.1 Generation

- D1 combined initial XI averages about 80 OVR.
- D1 average weakest starter is within the accepted 73 band.
- D1 average strongest starter is within the accepted 87 band.
- Every lower division follows the configured curve.
- Adjacent divisions overlap while preserving ordered means.
- Age buckets rise toward prime age and decline afterward.
- Rare elite teenagers exist without dominating academy cohorts.
- Generation is deterministic for world, club, type, season, and slot.

### 13.2 Development

- OVR always equals `overallFromSkills(position, skills)`.
- No code path mutates OVR independently from skills.
- Equal OVR-equivalent budgets produce comparable expected OVR movement across
  all positions.
- Training focus changes skill distribution without creating extra total growth.
- Full starters outgrow rotation and inactive players.
- Active veterans decline more slowly than inactive veterans.
- D3 upper-tail players can develop into D2 and occasional D1-quality OVRs.

### 13.3 Contracts

- Academy salary equals the configured fraction of professional base salary for
  the same current OVR and age.
- Academy terms cannot extend beyond age 21.
- Youth cannot renew an academy contract.
- Promotion requires a selected professional term.
- Promotion salary uses current OVR, current age, and selected duration.
- Longer professional terms apply the configured compounded annual premium.
- Renewal salary uses current OVR rather than stale persisted salary as its
  market baseline.
- An unsigned age-21 player leaves and receives exactly one free-agent listing.
- No player remains youth or on academy pay at age 21 or later.

### 13.4 Career movement and market

- No automatic listing or forced transfer is introduced.
- No division-fit field or recommendation is exposed.
- Higher-tier budgets and existing cross-division bid caps remain authoritative.
- Transfer and free-agent contracts use immutable visible listing inputs.
- A developing player's value and next professional salary rise with current
  OVR, creating a manager-driven keep-or-sell decision.

### 13.5 Population integrity

- Retirement remains represented only by the baseline intake formula.
- Free-agent terminal deletion adds one correction exactly once.
- Youth dismissal adds no correction.
- Filler creation/deletion adds no correction.
- Senior floor and intervention replacements subtract from correction.
- New human club generation satisfies its expected population growth without
  counting destroyed filler players.
- Global allocation is deterministic, fair, retry-safe, and independent of
  club processing order.
- Blocked academy slots carry forward rather than reroll or disappear.
- Save/reload preserves pending correction and flow counters without duplication.
- Long-running population calibration remains stable as human club count grows.

### 13.6 Verification commands

```bash
cd backend && npm run build
cd backend && npm test
cd backend && npm run test:integration
cd backend && npm run test:calibration
cd frontend && npm run build
```

Integration coverage is required because free-agent deletion, rollover intake,
global allocation, save/reload, routes, and scheduler boundaries are affected.
