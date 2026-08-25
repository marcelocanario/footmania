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
   homegrown player on his retained academy-rate contract before a normal
   professional renewal creates a genuine keep-or-sell decision.

8. Academy intake must replace expected retirements plus real uncompensated
   non-retirement losses, including free agents deleted after their retention
   period. Youth dismissal must not create immediate or club-specific replacement
   entitlement, but it must not permanently drain the global population either.

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

### 3.5 Academy age, promotion, and contract boundaries are inconsistent

Academy contracts use one fixed configured duration even though recruits enter
at different ages. Promotion is treated as a new professional negotiation rather
than a status change on the player's existing contract, and there is no single
strict rule for voluntary promotion from age 18, automatic promotion at age 20,
and contract expiry at age 21.

### 3.6 Population intake assumes retirement is the only terminal sink

The automatic academy intake mean models the academy-to-retirement lifetime.
An unclaimed free agent is permanently deleted after the retention period, but
that additional sink is not included in future academy intake. Expected rather
than actual retirements also permits stochastic population drift, and deleting
youth permanently reduces the world even though the same club must not be able
to dismiss and immediately reroll a replacement.

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
- growth potential on a continuous 0-to-1 scale;
- growth speed on a continuous 0-to-1 scale;
- personal peak age;
- decline potential on a continuous 0-to-1 scale;
- decline speed on a continuous 0-to-1 scale.

All five profile attributes are hidden. Raw Z is independent from the profile
and sets the player's career quality level. `growthPotential` is the only
variable that controls total improvement magnitude; `growthSpeed` controls how
quickly and steeply that budget is realized before the peak. There is no second
potential ceiling, growth tier, or development-rate multiplier.

`declinePotential` controls total decline magnitude and `declineSpeed` controls
how quickly and steeply it is realized after the peak. `peakAge` is the exact
age at which the growth phase ends and decline begins. It is drawn as an integer
from a configurable truncated normal distribution with a central mean, standard
deviation, minimum, and maximum, producing most peaks near the center with
tails on both sides.

Growth/decline potential and speed use separate configurable piecewise-linear
probability densities over the continuous 0-to-1 interval. If short-period
volatility is retained, it must be zero-mean timing noise and may not change a
player's total growth or decline budget.

Generate `growthPotential`, `growthSpeed`, `peakAge`, `declinePotential`, and
`declineSpeed` for every player and persist them for every non-filler player.
Remove the old growth-tier,
development-rate, decline-start-age, and mutable-potential authorities rather
than retaining compatibility fields; the planned world reset removes migration
requirements.

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
  academyCurrentDivisionWeight * currentDivisionStrength
  + academyHighestEverDivisionWeight * highestEverDivisionStrength
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

The current-division and highest-ever-division weights are configurable and
normalized by the shared pedigree helper. Highest-ever division is an intended
permanent ratchet: once a club has reached D1, the historical component of its
academy pedigree permanently uses D1 strength.

### 5.4 Current OVR from career age

Before the personal peak, `growthSpeed` interpolates between configurable slow
and fast cumulative growth curves. Both curves start at zero at academy entry
reference age 16 and finish at one at `peakAge`, so speed changes timing and
steepness but never the full-activity growth magnitude. A player generated at
17-19 is reconstructed as having already followed the appropriate part of that
career curve; generation age does not restart his growth clock.

```text
careerGrowthBudget =
  maximumCareerGrowthOverall * growthPotential

entryTargetOVR = personalPeakTarget - careerGrowthBudget

growthProgress =
  normalizedAgeProgress(academyMinAge, age, peakAge)

cumulativeGrowthFraction = lerp(
  growthSlowCurve(growthProgress),
  growthFastCurve(growthProgress),
  growthSpeed
)

currentTargetOVRBeforeDecline =
  entryTargetOVR
  + careerGrowthBudget
    * cumulativeGrowthFraction
    * historicalGrowthActivityModifier
```

This formulation is intentional: lower historical activity reduces realized
growth instead of incorrectly moving a young player closer to his peak. Growth
not realized before the personal peak age is lost rather than banked for
later.

After the personal peak, `declineSpeed` interpolates between configurable slow
and fast cumulative decline curves:

```text
careerDeclineBudget =
  maximumCareerDeclineOverall * declinePotential

yearsSincePeak = max(0, age - peakAge)

cumulativeDeclineFraction = lerp(
  declineSlowCurve(yearsSincePeak),
  declineFastCurve(yearsSincePeak),
  declineSpeed
)

currentTargetOVRAfterDecline =
  realizedPreDeclineTargetOVR
  - careerDeclineBudget
    * cumulativeDeclineFraction
    * historicalDeclineActivityModifier
```

The decline activity modifier is smaller for historically active players, so
activity reduces rather than increases their realized decline. All slow and
fast curves must be monotonic cumulative curves with a zero starting point and
a defined terminal value of one. For any point before or after the peak, the
fast curve may not be behind the slow curve. Interpolation is shared by
generation and live development.

Skills are generated toward that target. The persisted overall is always
recomputed with `overallFromSkills(position, skills)`.

The live development system uses these same budgets and curves. It does not
store or grow a second OVR potential ceiling. Persisted progress bookkeeping
may record how much of each budget has already been consumed, but it may not
create another capacity or speed authority alongside the four 0-to-1 profile
values and `peakAge`.

Illustrative D1 academy distribution under the candidate calibration:

| Age | Mean OVR | Approximate P90 | Approximate P99 |
| --- | ---: | ---: | ---: |
| 16 | 60 | 69 | 76 |
| 17 | 63 | 71 | 78 |
| 18 | 65 | 73 | 80 |
| 19 | 68 | 76 | 83 |

Academy generation is restricted to ages 16 through 19 inclusive. Players may
remain in the academy through age 19 and are automatically promoted when they
turn 20; no intake path generates an age-20 youth player.

### 5.5 Initial senior ages

Replace `TN(24, 4, 18, 38)` with a standing-career survivorship distribution
that reflects every permanent player drain in the live world.

The distribution is calculated per position:

```text
weight(age) = probability of remaining in the active population through that age
```

The survival model includes retirement and terminal deletion after contract
expiry/free-agent retention. Contract expiry itself is not a drain while the
player remains in the free-agent pool, and signing or transfer is only a change
of ownership. A club becoming dormant is also not a player drain: the club and
its frozen players leave the active-population boundary together.

Goalkeepers naturally receive the existing three-year retirement grace. The
same authoritative survival model must be reused by initial senior age
generation, academy intake planning, long-running calibration, and admin
analytics. Probabilities that depend on manager behavior must be calibrated
from full-world simulation rather than guessed from retirement alone.

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
3. If a skill is at its hard bound, redistribute that skill's blocked raw
   progress across the other eligible skills in proportion to their current
   training weights.
4. Stop only when the complete OVR-equivalent budget has been allocated or no
   eligible skill remains.
5. Respect the player's remaining career growth or decline budget.
6. Recompute OVR from the resulting skills.

The normalization does not set OVR directly. It only determines how much raw
skill progress is needed for comparable expected OVR movement across positions.
Redistribution is necessary because otherwise, for example, a focus that sends
70 percent of growth to a skill already at 100 would realize only the remaining
30 percent, while another focus would realize the full budget. Hitting the
player's total remaining career growth budget is different: progress stops
there and is not redistributed, because no growth capacity remains.

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
   new contract is negotiated. A promoted academy player keeps his existing
   academy-rate salary only until that contract is renewed or expires. A club
   renewal can never reduce the player's current salary, while a later free-
   agent negotiation is a new market contract and may be lower.

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
- number of future complete seasons;
- remaining current-season fraction.

The professional market baseline is:

```text
professionalBaseSalary = calculateBaseSalary(currentOVR, currentAge)
```

Contract duration must use one unambiguous horizon:

```text
totalContractSeasonEquivalents =
  currentSeasonFraction + futureCompleteSeasons
```

The current implementation's selected `requestedSeasons` means future complete
seasons in addition to the remaining current season. It must not be passed a
total contract length as if the two meanings were interchangeable. The shared
salary function levelizes the compounded annual demand over the exact horizon.

For a club renewal, the baseline can never be below the current contractual
salary:

```text
renewalBaseline = max(currentSalary, professionalBaseSalary)
```

For a transfer, free-agent signing, or generated professional first contract,
the baseline is `professionalBaseSalary`; an expired high salary does not follow
the player into free agency. A player may therefore reject a club renewal at a
higher demand and later request less as a free agent.

The annual demand rate contains a minimum, a visible-skill component, and a
young-player component:

```text
annualDemandRate = clamp(
  renewalMinRaise
  + renewalSkillComponent(currentOVR)
  + renewalYouthPremiumWeight * renewalYouthPremiumAgeCurve(currentAge),
  renewalMinRaise,
  renewalMaxRaise
)
```

The youth curve is based only on visible age, peaks for young developing
players, and fades toward zero through the mid-20s. It must never use hidden
growth potential. This makes a long early renewal more expensive without
eliminating the intended advantage of promoting and using a young player.

The minimum, skill weight, youth-premium weight, age curve, exponent, and cap
remain centralized config tunables. They must be calibrated against projected
OVR-driven salary growth rather than fixing every player to one 10 percent
rate.

This authority is reused for:

- renewal of a promoted player's retained academy-origin contract;
- ordinary professional renewal;
- the winning contract attached to a transfer bid;
- a free-agent signing;
- generated senior first contracts.

Persisted professional salary remains fixed for the signed contract. Daily
development does not silently recalculate wages. Current OVR is consulted again
only when the next professional contract is negotiated.

### 8.2 Academy salary

Academy salary is a configurable fraction of the salary the same player would
receive from the complete professional-contract formula for the same current
OVR, age, term, and current-season fraction:

```text
academyContractSeasons = 21 - currentAge

academyCurrentSeasonFraction = 1
academyFutureCompleteSeasons = academyContractSeasons - 1

professionalEquivalentSalary =
  calculateProfessionalContractSalary(
    calculateBaseSalary(currentOVR, currentAge),
    currentOVR,
    currentAge,
    academyFutureCompleteSeasons,
    academyCurrentSeasonFraction
  )

academySalary =
  professionalEquivalentSalary * academySalaryMultiplier
```

Academy intake occurs at the season boundary, so the current-season fraction is
one. A 16-year-old's five-season contract therefore contains the current season
plus four future complete seasons. Passing five as the number of future seasons
would incorrectly price six seasons of service.

`academySalaryMultiplier` must be configurable and strictly greater than zero
and less than one. Normal currency rounding applies after multiplication; a
professional salary floor must not be reapplied afterward in a way that breaks
the configured fraction.

The academy salary is fixed when the player is generated. Development does not
silently change it. Promotion also does not recalculate it: the same salary and
contract end date remain in force in the senior squad until the player signs a
normal professional renewal or the retained contract expires.

The low salary also intentionally produces a low release clause under the
existing release-clause formula. This is a deliberate mobility mechanism for
promoted players that their producing club does not value enough to retain; it
must not be silently replaced with a professional-equivalent clause.

### 8.3 Academy age, term, and promotion lifecycle

Academy players are generated only from ages 16 through 19 inclusive. At
generation, the contract duration is the number of complete seasons remaining
until age 21:

```text
academyContractSeasons = 21 - currentAge
```

A 16-year-old therefore receives a five-season contract, a 17-year-old a
four-season contract, an 18-year-old three seasons, and a 19-year-old two
seasons. The resulting contract end is the age-21
rollover boundary and may never be extended while the player remains in the
academy. Academy players cannot renew or replace their academy contract.

Voluntary promotion is allowed only from age 18. It requires an available
senior roster slot, but it does not request a contract duration and does not
negotiate salary. Promotion changes the player's academy/senior status while
preserving exactly:

- current salary;
- contract start and end boundaries;
- remaining contract duration;
- all other contract terms.

At the age-20 rollover boundary, every remaining academy player is
automatically promoted. This transition is mandatory and atomic: it is not a
manager decision and cannot be blocked by the normal senior-slot precondition.
If the senior squad is already full, mandatory promotion creates a temporary
roster overflow; it must never release, list, replace, or overwrite a player.
Until the senior roster is back at or below the configured limit, the club may
not submit or settle transfer bids, sign or bid for free agents, take a player
on loan, voluntarily promote another youth player, or renew any senior
contract. Selling, loaning out, or releasing players remains available so the
manager can resolve the overflow. Settlement must recheck the limit and fail
closed if a bid was submitted before the overflow arose.

Once promoted, the player is an ordinary senior-squad player for renewal and
expiry behavior. A renewal may be offered only after promotion and uses the
same current-OVR professional salary formula, term choices, validation, and
acceptance flow as every other senior renewal. Promotion itself is not a
renewal and never invokes that formula.

At the age-21 contract-expiry boundary, any unrenewed retained contract follows
the ordinary senior contract-expiry and free-agent path. There is no separate
academy expiry conversion and no age-21 youth state, because every player was
already promoted no later than age 20.

The lifecycle invariants are therefore:

- no academy player is younger than 16 or older than 19 in persisted state;
- no academy player can be voluntarily promoted before age 18;
- no academy contract can be renewed;
- no player remains `isYouth = true` on or after the age-20 promotion boundary;
- promotion preserves salary and contract expiry exactly;
- every post-promotion renewal uses the standard professional renewal authority;
- mandatory promotion may exceed the senior cap, but every acquisition and
  renewal path remains blocked until the overflow is resolved.

### 8.4 API and UI implications

The academy promotion mutation must not accept `contractSeasons` or a salary
offer. Before confirmation, the UI displays the retained salary and remaining
contract duration and makes clear that neither changes on promotion. The server
remains authoritative and verifies age eligibility, roster eligibility for
voluntary promotion, and exact contract preservation inside the locked
mutation.

The existing professional renewal endpoint becomes available after promotion
and uses the same options and shared salary authority as for any other senior,
provided the club is not above the senior cap. Transfer and free-agent bid
previews also use that authority with immutable listing snapshots where
required for retry-safe settlement.

Every acquisition and renewal route must call one shared senior-cap validator.
The validator permits mandatory age promotion and other unavoidable returns,
but blocks voluntary additions and renewals while the club is over capacity.

### 8.5 Inactive-club freeze

A club flagged as abandoned during a season remains fully active through the
end of that season. Only after the season finishes is it removed from its
division and group and marked dormant.

While dormant, the club and all of its players are frozen exactly as stored:

- players do not age, develop, decline, retire, or suffer contract expiry;
- contracts, wages, payroll, cash, budgets, and other spending do not move;
- no academy intake, automatic promotion, replacement generation, fixtures, or
  market activity occurs;
- no offline catch-up is applied later.

Any market listing, unresolved bid, or loan boundary involving the club must be
settled or closed as part of the transition before the frozen snapshot becomes
authoritative. When the owner returns, the same club, players, money, and
contracts are restored unchanged and the club is assigned to the lowest active
division like a new entrant. Its clocks resume only when it becomes active.

Provisional teams are temporary and population-neutral. They are created with
their temporary players, play their applicable season, and are destroyed rather
than entering the persistent-club lifecycle. Their creation and destruction,
players, finances, and flows are excluded from persistent population correction.

## 9. Persistent population replenishment

### 9.1 Active population boundary and target

Population control applies only to the active persistent world.

```text
activePopulation =
  players owned by active persistent clubs
  + professional free agents inside their retention period
```

Exclude filler AI, provisional teams and their temporary players, and dormant
clubs and their frozen players. When a club becomes dormant, the club and all of
its players leave the active boundary together; this is not destruction and
creates no correction. Reactivation returns that same stock to the boundary.

The global target contains both owned rosters and the normal free-agent pool:

```text
targetActivePopulation =
  targetOwnedPlayersPerActiveClub * activePersistentClubCount
  + targetFreeAgentPool(activePersistentClubCount, retentionRules)
```

`targetOwnedPlayersPerActiveClub` includes both senior and academy players.
The free-agent target is derived and calibrated from expected contract-expiry
flow, signing probability, and retention duration. It is not an untracked
surplus on top of a club-only target. Admin analytics compare the target with
the same active-population definition.

### 9.2 Baseline and retirement variance

Keep an expected retirement baseline for smooth intake planning:

```text
retirementBaselinePerClub =
  targetOwnedPlayersPerActiveClub
  / expectedActivePlayerLifetimeFromAcademyEntry
```

The lifetime model responds to academy entry ages, promotion and contract
boundaries, position mix, retirement, and terminal free-agent deletion.

Expected retirement alone is not sufficient. Each cycle also applies the
realized variance:

```text
retirementVarianceCorrection =
  actualEligibleRetirements - expectedEligibleRetirements
```

Therefore an unusually high-retirement season is fully replenished and an
unusually low-retirement season does not create permanent surplus. Dormant or
provisional players are outside both sides of this calculation.

### 9.3 Signed correction and minimum intake

Maintain a signed, durable correction ledger in multiplayer state:

```text
rawExpectedGlobalIntake =
  retirementBaselinePerClub * activePersistentClubCount
  + carriedCorrection
  + retirementVarianceCorrection
  + eligibleTerminalDeletions
  + maturedYouthDismissals
  - extraNonAcademyGeneration
  + activeClubPopulationGap
```

`eligibleTerminalDeletions` excludes retirements, because retirement variance
already accounts for that cause. Each structural cause enters the equation once.

`activeClubPopulationGap` covers a genuinely new or reactivated active club's
target contribution minus the eligible players that enter the active boundary
with it. A dormant transition itself is zero because both club target and frozen
stock leave together. Provisional creation and destruction are always zero.

Definitions:

| Flow | Correction effect |
| --- | ---: |
| Expected retirement | Included in baseline |
| Actual minus expected eligible retirement | Signed variance |
| Free agent deleted after retention | +1 |
| Youth dismissed | Delayed +1 to the global pool after one full intake cycle |
| Academy promotion, voluntary or automatic | 0 |
| Dormant freeze or reactivation with the same roster | Boundary change, not destruction |
| Provisional or filler creation/deletion | 0 |
| Senior floor or financial-intervention replacement | -1 |
| Other non-academy persistent generation | -1 |

A youth dismissal never changes the current cycle's total or creates a credit
for the dismissing club. It enters `maturedYouthDismissals` only after one full
intake cycle and is then distributed globally. Until maturity, population
reconciliation treats the pending dismissal as deliberately unavailable stock
so it is not mistaken for unexplained drift.

The correction may be negative, but generated intake never is. Preserve a
configurable minimum academy intake for every active club:

```text
minimumGlobalIntake =
  minimumAcademyIntakePerActiveClub * activePersistentClubCount

resolvedGlobalIntake =
  max(minimumGlobalIntake, deterministicRound(rawExpectedGlobalIntake))
```

Any unserved positive or negative balance remains in `carriedCorrection`.
The minimum guarantees that every season has new prospects even during a
population surplus; analytics must expose a negative balance that cannot yet be
worked off because of this floor.

### 9.4 Exact seeded-random global allocation

First resolve one exact global integer total. Then express the equal club share
as an average:

```text
averageIntakePerClub =
  resolvedGlobalIntake / eligibleActiveClubCount
```

For example, 21 players across 10 clubs is an average of 2.1. Every club gets
the integer base of two, and exactly one club gets the twenty-first player.
Because players are indivisible, the fractional 0.1 still requires an exact
assignment rule.

Allocation rules:

1. Give every eligible active club `floor(averageIntakePerClub)` players.
2. Sort eligible club IDs into a stable canonical order, then shuffle that list
   with an RNG derived from the world seed, intake season, and intake event key.
3. Give one additional player to the first `remainderSlots` clubs in the seeded
   shuffle. Because the remainder is smaller than the club count, no club gets
   more than one remainder player in the same cycle.
4. Generate each assigned player from the recipient club's current division
   and permanent highest-ever academy pedigree.
5. Respect the academy roster limit.
6. Do not redistribute a blocked club's slots during the same intake pass.
7. Carry ungenerated slots into the signed global correction, never as a
   dismiss-and-reroll entitlement for that club.

Academy promotion only reclassifies an existing active player and therefore
never changes the population ledger.

### 9.5 Atomic flow accounting

Every eligible population event only increments its durable pending counter.
Deleting or signing a player, activating a club, or otherwise changing stock
must never generate academy players immediately. The single seasonal academy
intake at the season end/start boundary is the only event that converts pending
population compensation into newgens.

Record durable pending counters and cumulative analytics by structural cause:

- expected and actual eligible retirees;
- free agents deleted after retention;
- youth dismissals pending delay and matured dismissals;
- academy players generated from baseline and correction;
- initial active-club players generated;
- senior floor and financial-intervention replacements;
- provisional, dormant, and filler boundary flows;
- target owned stock, target free-agent stock, and actual active stock;
- correction before allocation;
- raw, minimum, resolved, and actual global intake;
- correction carried forward;
- seeded remainder order and recipients.

Every terminal event increments its pending counter exactly once in the same
transaction that performs the deletion. The intake step must snapshot and
consume the pending counters, generate players, update the carried correction
and seeded allocation record, and mark the intake idempotency key in one atomic
locked commit. A retry therefore observes either none of those effects or all of them;
it cannot reuse a deletion counter that was already converted into intake.

Admin analytics must show both stock and flows. The observed target gap must
reconcile to the signed ledger plus deliberately delayed dismissals; any other
difference is an invariant failure rather than another intake bonus.

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
- salary and value analytics;
- academy-origin release-clause mobility;
- young-player renewal premiums and maximum-term demands;
- target and observed free-agent stock.

The existing budget helper that returns a fixed 72 OVR must be removed or made
derived from the canonical generation projection.

OVR calibration and economy calibration are separate gates. Restricting academy
generation back to ages 16-19 means the existing XI prototype remains a valid
starting point for quality, subject to the redesigned career profile. It does
not validate wages: applying term premiums to generated professional and
academy-equivalent contracts requires a fresh wage-bill, budget, release-clause,
and insolvency simulation even when the OVR distribution is unchanged.

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
| `academyCurrentDivisionWeight` | 0.65 | Current-division pedigree contribution |
| `academyHighestEverDivisionWeight` | 0.35 | Permanent highest-ever pedigree contribution |
| `academyMinAge` | 16 | Youngest generated academy player |
| `academyMaxAge` | 19 | Oldest generated academy player |
| `academyAutomaticPromotionAge` | 20 | Mandatory promotion boundary |
| `academyContractEndAge` | 21 | Derived academy-origin contract expiry age |
| `maximumCareerGrowthOverall` | calibration required | OVR-equivalent growth budget at potential 1 |
| `growthPotentialDistribution` | calibration required | Distribution of hidden 0-to-1 growth magnitude |
| `growthSpeedDistribution` | calibration required | Distribution of hidden 0-to-1 growth speed |
| `growthSlowCurve` | calibration required | Slow cumulative growth boundary before peak |
| `growthFastCurve` | calibration required | Fast cumulative growth boundary before peak |
| `peakAgeDistribution` | calibration required | Truncated-normal mean, standard deviation, minimum, and maximum |
| `maximumCareerDeclineOverall` | calibration required | OVR-equivalent decline budget at potential 1 |
| `declinePotentialDistribution` | calibration required | Distribution of hidden 0-to-1 decline magnitude |
| `declineSpeedDistribution` | calibration required | Distribution of hidden 0-to-1 decline speed |
| `declineSlowCurve` | calibration required | Slow cumulative decline boundary after peak |
| `declineFastCurve` | calibration required | Fast cumulative decline boundary after peak |
| `academySalaryMultiplier` | existing value, constrained to `0 < value < 1` | Youth fraction of the same full-term professional salary calculation |
| `renewalMinRaise` | calibration required | Minimum annual demand component |
| `renewalYouthPremiumWeight` | calibration required | Extra renewal eagerness for young players |
| `renewalYouthPremiumAgeCurve` | calibration required | Visible-age curve that fades through the mid-20s |
| `minimumAcademyIntakePerActiveClub` | calibration required, greater than zero | Guarantees new prospects during a population surplus |

Remove the fixed `academyContractSeasons` setting; the term is derived from
`academyContractEndAge - currentAge`. Validate that the academy age boundaries
are ordered, automatic promotion occurs after the maximum generated age, and
contract end occurs after automatic promotion. Pedigree weights must be
non-negative with a positive sum and are normalized by the shared helper.

Potential and speed probability densities must remain inside 0-1 and have
positive total mass. `peakAgeDistribution` must have positive deviation and
ordered integer bounds. Slow/fast cumulative curves must be monotonic, start at
zero, terminate at one, and maintain `fast >= slow` at every comparable point.

Do not hard-code these values in generation, contract, or market services.

Align all shipped config values, Zod defaults, fallback defaults, comments,
business rules, and calibration assertions.

## 12. Implementation sequence

1. Extract pure growth/decline curves and full active-career survival helpers so
   generation, live development, intake planning, and analytics share them.

2. Implement position-normalized skill development while preserving skill
   accumulators, training focus, blocked-skill redistribution, career budgets,
   and OVR derivation.

3. Replace growth tier, development rate, and mutable potential ceiling with
   hidden 0-to-1 growth potential and speed, truncated-normal peak age, hidden
   0-to-1 decline potential and speed, and the slow/fast boundary curves.

4. Implement profile-first, career-shaped senior and youth generation and
   position-specific active-career senior age generation.

5. Add the separate academy spread, peak-offset, pedigree-weight, career-curve,
   and potential-distribution config fields.

6. Restrict academy generation to ages 16-19, derive academy contract duration
   as `21 - currentAge`, and forbid academy renewals.

7. Implement voluntary promotion from age 18 and mandatory automatic promotion
   at age 20 while preserving salary and contract expiry exactly. Replace the
   absolute promotion cap with mandatory overflow plus shared over-cap blocks
   on acquisitions, voluntary promotions, and renewals.

8. Implement exact-horizon professional salary authority, no-pay-cut renewal
   baselines, and the visible-age youth renewal premium. Reuse it for promoted
   and ordinary renewals, transfers, free agents, generated professionals, and
   the professional-equivalent input to academy salary calculation.

9. Implement the complete dormant freeze and exclude dormant, provisional, and
   filler stock and flows from active population control.

10. Add the active-stock/free-agent target, retirement variance, delayed youth-
    dismissal correction, atomic flow consumption, signed carry, minimum intake,
    and exact seeded-random remainder allocation at seasonal intake.

11. Derive budget quality assumptions from generation projections and
    recalibrate the economy and young-player renewal curve.

12. Update APIs and frontend contract/promotion/overflow flows.

13. Add the deterministic, integration, and Monte Carlo calibration groups,
    then run the full calibration suite to select final generation, career,
    contract, economy, and population tolerances.

14. Align final configuration, `BUSINESS_RULES.md`, `INVARIANTS.md`, generation
    fixtures, analytics, and all affected tests with the accepted calibration.

## 13. Required tests and calibration

### 13.1 Generation

- D1 combined initial XI averages about 80 OVR.
- D1 average weakest starter is within the accepted 73 band.
- D1 average strongest starter is within the accepted 87 band.
- Every lower division follows the configured curve.
- Adjacent divisions overlap while preserving ordered means.
- Age buckets rise toward prime age and decline afterward.
- Rare elite teenagers exist without dominating academy cohorts.
- Academy generation produces ages 16-19 only.
- Growth/decline potential and speed remain within 0 and 1.
- Peak-age samples match the configured truncated-normal mean, spread, bounds,
  and both tails.
- Potential/speed probability densities and slow/fast cumulative curves reject
  malformed, negative, non-monotonic, incorrectly bounded, or crossed config.
- Initial senior age buckets match full active-career survival, including
  terminal free-agent deletion but excluding dormancy as a drain.
- Generation is deterministic for world, club, type, season, and slot.

### 13.2 Development

- OVR always equals `overallFromSkills(position, skills)`.
- No code path mutates OVR independently from skills.
- Equal OVR-equivalent budgets produce comparable expected OVR movement across
  all positions.
- Training focus changes skill distribution without creating extra total growth.
- Progress blocked by a skill bound redistributes to eligible weighted skills;
  progress stops rather than redistributes when the career budget is exhausted.
- `growthPotential = 0` grants no career growth budget and
  `growthPotential = 1` grants the configured maximum budget.
- `growthSpeed = 0` follows the slow growth curve and `growthSpeed = 1` follows
  the fast curve; both reach the same full-activity total at peak age.
- `declinePotential = 0` grants no career decline budget and
  `declinePotential = 1` grants the configured maximum budget.
- `declineSpeed = 0` follows the slow decline curve and `declineSpeed = 1`
  follows the fast curve without changing total decline magnitude.
- There is no separate growth tier, development-rate capacity multiplier, or
  mutable OVR potential ceiling that can add growth a second time.
- Full starters outgrow rotation and inactive players.
- Active veterans decline more slowly than inactive veterans.
- D3 upper-tail players can develop into D2 and occasional D1-quality OVRs.

### 13.3 Contracts

- Academy generation never produces an age outside 16-19.
- Academy salary equals the configured fraction of the full professional
  calculation for the same current OVR, age, exact total horizon, and season
  fraction.
- A five-season academy contract at the season boundary is priced as the
  current season plus four future seasons, never six total seasons.
- The academy multiplier rejects values less than or equal to zero and greater
  than or equal to one.
- A 16-year-old receives five seasons, a 17-year-old four, an 18-year-old three,
  and a 19-year-old two, all ending at age 21.
- Youth cannot renew an academy contract.
- Voluntary promotion fails below age 18.
- Voluntary promotion succeeds at ages 18 and 19 when a senior slot is
  available.
- Every remaining academy player is automatically promoted at the age-20
  boundary, including when the normal senior squad is full.
- Mandatory promotion into a full senior squad creates a temporary overflow,
  releases no player, and blocks bids, signings, loans in, voluntary promotions,
  and renewals until resolved.
- Voluntary and automatic promotion preserve salary, contract start, contract
  end, and remaining duration exactly.
- Promotion accepts no contract term and performs no salary negotiation.
- A promoted player can use the ordinary senior renewal flow, whose salary uses
  the greater of current salary and current-OVR market salary as its baseline.
- A renewal can never reduce current salary, but the same player may later ask
  for less after becoming a free agent.
- The visible-age youth premium raises long-term renewal demand for young
  players without reading hidden growth potential.
- Longer professional terms apply the configured compounded annual premium.
- Renewal salary uses the greater of current contractual salary and current-OVR
  market salary as its baseline.
- The promoted player's low salary intentionally continues to produce the low
  release clause from the existing formula.
- An unrenewed promoted player's age-21 expiry follows the ordinary senior
  expiry path and creates exactly one free-agent listing where applicable.
- No player remains youth at age 20 or later.

### 13.4 Career movement and market

- No automatic listing or forced transfer is introduced.
- No division-fit field or recommendation is exposed.
- Higher-tier budgets and existing cross-division bid caps remain authoritative.
- Transfer and free-agent contracts use immutable visible listing inputs.
- A developing player's value and next professional salary rise with current
  OVR, creating a manager-driven keep-or-sell decision.

### 13.5 Inactive clubs

- A mid-season abandonment remains active through that season's end.
- Once dormant, the club has no division or group and its players, development,
  decline, age, contracts, payroll, finances, intake, promotion, and market
  activity remain byte-for-byte stable across later rollovers.
- Reactivation restores the same frozen state, assigns the lowest active
  division, and resumes clocks without offline catch-up.
- Dormant and provisional teams and their players are excluded from active
  population target, stock, and correction flows.

### 13.6 Population integrity

- Actual-minus-expected retirement variance corrects the expected baseline.
- Free-agent terminal deletion adds one correction exactly once.
- Free agents inside retention count in actual active population and the target
  includes a derived normal free-agent pool.
- Youth dismissal changes neither the current cycle nor the dismissing club's
  share, then matures into one globally distributed correction after a full
  intake cycle.
- Voluntary and automatic academy promotion add no correction.
- Dormant, provisional, and filler boundary flows add no correction.
- Senior floor and intervention replacements subtract from correction.
- A negative raw correction still generates the configured positive minimum
  intake and carries the remaining negative balance.
- Ten clubs receiving 21 players get two each plus one seeded-random remainder
  recipient drawn from the canonical eligible club list.
- A fixed world seed, season, and intake key reproduce the same recipients;
  different seasons are statistically unbiased across clubs without promising
  strict rotation.
- Eligible population events increment pending counters but never generate a
  player before the seasonal intake boundary.
- Global allocation is deterministic, seeded-random, retry-safe, and independent
  of club processing order.
- Blocked academy slots carry forward rather than reroll or disappear.
- Terminal deletion, counter consumption, generation, signed carry, seeded
  allocation recording, and idempotency marking cannot be partially committed
  or duplicated.
- Save/reload preserves pending and delayed correction, flow counters, and the
  seeded allocation record without duplication.
- Long-running population calibration remains stable as human club count grows.

### 13.7 Monte Carlo and long-running calibration

Probabilistic balance and long-horizon stability must be validated in dedicated
`calibrationDescribe` groups under `npm run test:calibration`. They must not run
inside the default `npm test` suite. Boundary rules, exact formulas,
idempotency, and individual lifecycle transitions remain ordinary deterministic
unit or integration tests.

All Monte Carlo groups use committed fixed seed sets. A repeated run against the
same code must produce identical samples and summary statistics. Assertions use
predeclared distribution, quantile, confidence-band, and drift tolerances rather
than one favorable seed. Failures print the seed set and relevant aggregate
metrics so regressions can be reproduced.

Initial minimum calibration coverage:

1. **Generation and division quality**
   - Generate at least 500 complete clubs per division for every representative
     pyramid size.
   - Measure full-squad and automatic-XI means, weakest/strongest starter
     distributions, within-division spread, adjacent-division overlap, position
     mix, academy age buckets, and elite-tail frequencies.
   - Assert ordered division means and the accepted D1 80/73/87 targets without
     requiring every individual club to match them.

2. **Hidden profile distributions**
   - Generate at least 50,000 player profiles across deterministic seeds.
   - Validate growth/decline potential and speed against their configured
     piecewise-linear densities and peak age against its truncated-normal mean,
     deviation, bounds, and tail frequencies.
   - Assert independence of raw birth-quality Z from the five hidden career
     profile attributes within the accepted correlation tolerance.

3. **Career trajectories and steady-state ages**
   - Simulate at least 20,000 complete careers across positions, activity
     archetypes, growth/decline potential bands, speed bands, and peak-age bands.
   - Verify that potential changes total magnitude, speed changes timing but not
     the full-activity total, growth stops at peak age, and decline begins from
     the realized peak.
   - Measure peak age, peak OVR, decline paths, retirement ages, terminal
     deletion ages, and the resulting standing active-player age distribution.
   - Assert that the simulated steady-state age distribution matches the
     distribution used for initial senior generation.

4. **Position-normalized development**
   - Sample at least 10,000 player-periods for every position and training-focus
     family, including skills near both hard bounds.
   - Compare requested and realized OVR-equivalent movement, capped-skill
     redistribution, accumulator rounding, activity effects, and exhausted
     career budgets.
   - Assert that position or focus does not create material extra total growth
     while still changing which skills improve.

5. **Contracts and economy**
   - Sample generated, renewed, transferred, and free-agent contracts across
     OVR, age, term, season fraction, and current-salary bands.
   - Validate exact contract horizons, academy fractions, no-pay-cut renewals,
     possible post-expiry pay reductions, young-player premiums, and the
     intended low academy-origin release clauses.
   - Simulate club wage bills and finances across divisions for multiple seasons
     and measure affordability, renewal rejection, transfers, interventions,
     and insolvency rates before accepting salary or budget calibration.

6. **Population stability**
   - Simulate at least 50 seeded worlds for at least 100 active seasons, including
     changing active-club counts, retirement variance, free-agent retention and
     deletion, delayed youth-dismissal compensation, senior replacements,
     blocked academies, dormant/reactivated clubs, and provisional teams.
   - Track owned stock, free-agent stock, total active stock, target stock,
     signed carry, minimum intake, and every structural flow.
   - Assert no statistically meaningful long-run population slope away from the
     target, no unexplained ledger difference, no immediate dismissal reroll,
     and no contribution from dormant, provisional, or filler boundaries.

7. **Seeded remainder allocation**
   - Run many club-count, remainder-size, and season-seed combinations.
   - Assert exact totals, canonical-order independence, same-seed replay, and
     approximately uniform recipient frequency within a predeclared binomial
     confidence band.
   - Do not assert strict rotation; repeated recipients across seasons are valid
     outcomes of the accepted seeded-random policy.

Sample sizes and statistical tolerances become pinned test inputs after the
first accepted calibration run. Later changes may not reduce sample sizes,
widen tolerances, or remove reported tail metrics merely to make a regression
pass; balance changes must update the documented target and supporting evidence.

### 13.8 Verification commands

```bash
cd backend && npm run build
cd backend && npm test
cd backend && npm run test:integration
cd backend && npm run test:calibration
cd frontend && npm run build
```

Integration coverage is required because free-agent deletion, rollover intake,
global allocation, save/reload, routes, and scheduler boundaries are affected.
Monte Carlo calibration is additionally required before accepting any change to
generation, career curves, salary/economy tuning, or population formulas.
