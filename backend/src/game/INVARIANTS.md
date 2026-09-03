# Multiplayer Core Design Invariants

These invariants are the non-negotiable rules of the multiplayer league engine
(plan `plans/1. multiplayer.md` §92). Any refactor or new feature must preserve them.

1. **Every active division always contains exactly 8 competition slots.**
   Divisions are completed with filler AI up to 8 when created and after human
   placement.

2. **A season is globally synchronized.** All divisions share one calendar
   month / `MpSeason`; standings and fixtures are season-scoped.

3. **Every club plays at most one division per season.** `MpClubSeason` is keyed
   by `(clubId, seasonId)` and `MpMembership` by `(divisionId, clubId)`.

4. **AI filler can never be promoted.** Promotion ranking operates on human
   clubs only (`isHumanClub`); AI never consumes a promotion slot.

5. **Human density takes priority over preferred-time clustering.** Divisions
   are filled to 8 humans before opening another, then boundary-swapped by
   preferred-match-time window overlap (plan `plans/9.`; formerly timezone
   clustering — the server no longer stores a timezone).

6. **Empty divisions do not persist unnecessarily.** Divisions are created only
   when humans require them and are deleted/rebuilt at rollover.

7. **Division group membership is disposable between seasons.** Only the tier is
   persistent; `.1/.2/...` group membership is re-derived by clustering.

8. **Tier is the meaningful competitive level.** Promotion/relegation assigns a
   target tier; regrouping happens within each tier.

9. **No new human enters the current season after the configured join lock.**
   `completedRounds >= joinLockRound` (or `joinState === "LOCKED"`) routes new
   clubs to `PROVISIONAL`.

10. **Post-lock clubs remain playable through provisional preparation.**
    Squads, tactics, buying players, free agents and non-persistent practice
    matches all stay enabled while provisional. Outbound markets (transfer
    auctions and loan listings) additionally require the new-club sell lock
    (invariant 22).

11. **A provisional club receives its upcoming season's budget only once.**
    `MpAllocation` enforces a unique `(clubId, seasonId, type)`.

12. **Provisional players age and naturally develop/decay.** Aging and the
    natural development ticker continue; only match participation is frozen.

13. **Provisional contracts do not elapse.** Contract consumption happens only
    for ACTIVE clubs.

14. **Provisional salaries are not charged.** Payroll settles only for ACTIVE
    clubs.

15. **Practice matches cannot farm persistent progression.** They simulate on
    copies with a cloned RNG and apply no player mutations, stats, injuries or
    disciplinary effects.

16. **Abandoned clubs are never removed mid-season.** Inactivity only flags a
    club; removal to DORMANT happens at season rollover.

17. **A DORMANT club is frozen whole.** Its players do not age, develop,
    decline, retire or reach contract expiry; contracts, wages, payroll, cash
    and budgets do not move; it receives no academy intake, no automatic
    promotion and no replacement generation; and no offline catch-up is applied
    when it returns. Any listing, unresolved bid, reservation or loan boundary
    involving it is settled or closed BEFORE the frozen snapshot becomes
    authoritative, so no deadline can later fire against a stopped clock.
    Reactivation restores exactly that state.

18. **Returning abandoned clubs re-enter at the lowest available competitive
    level.** They do not reclaim their historical tier.

19. **Completed fixture results are immutable.** Finished matches are never
    rewritten; historical standings are snapshotted at rollover
    (`world.seasonHistory`) with the club name at archive time.

20. **Scheduled multiplayer operations must be idempotent and recoverable after
    downtime.** Rollover is committed as one atomic world transition (with a
    diagnostic phase marker); auctions use absolute `startsAt`/`endsAt`
    timestamps; worker steps re-run safely; global writes use optimistic
    concurrency on `Save.revision`.

21. **A destroyed filler AI's market state is fully reconciled before its squad
    is deleted.** Its own bids/reservations/evaluations are voided (a club that
    disappears can never win), and each of its active transfer listings is
    force-settled to the leading surviving bidder at the proxy clearing price,
    or cancelled when it has no bids. No listing, bid, reservation or evaluation
    may reference a deleted club or player (`retireFillerClub` /
    `removeFillerClubs`).

22. **New human clubs cannot move players OUT until they have played.** A
    human-owned club may buy players and release players immediately, but may
    not list players for transfer auction or loan until it has played
    `MP_CONFIG.newClubSellLockMatches` of its OWN league fixtures — counted
    from played fixtures involving the club, never from inherited standings
    rows (a mid-season joiner inherits the replaced AI's record but none of
    its played matches). Filler AI is exempt.

23. **One senior-roster cap governs every VOLUNTARY acquisition path.**
    `SENIOR_SQUAD_LIMIT` bounds voluntary youth promotions, transfer-auction
    bids and wins, free-agent bids and signings, and loan claims alike.
    Loaned-in players occupy squad slots and count; loaned-out players do not.
    Bid-time checks fail early; settlement re-checks fail closed (terminal: the
    listing is cancelled, the player stays with the seller).

    Mandatory age promotion is the single exception: it may push a club ABOVE
    the cap rather than releasing, listing, replacing or overwriting anyone.
    While a club is over the cap, every voluntary acquisition AND every senior
    renewal is blocked; selling, loaning out and releasing stay available so the
    overflow is always resolvable.

24. **Loans cost a lender-chosen fee within a configured band.** The listing
    owner picks a claim fee between `MARKET_CONFIG.loans.feeMinValueRatio` and
    `feeMaxValueRatio` of the player's value, snapshotted in absolute currency
    at listing time. The borrower pays the lender at claim time from actual
    unreserved cash (§9 immediate-cash rule); a club may hold at most
    `maxLoanedInPerClub` borrowed players.

    A loan listing may never outlive the contract behind it. Both the loan
    period AND the listing's own public exposure window must finish inside the
    player's remaining contract, and a player in his final contractual season
    may not be listed (for loan or for sale) once the season has passed the
    join threshold — at that point he is on course to leave as a free agent,
    and he cannot be renewed while listed.

25. **Live matches advance only on the server clock.** Clients may request an
    elapsed-time catch-up but can never accelerate, pause for advantage, or
    force-finish a match; the worker's real-time pacing is authoritative.

26. **No hidden quality flags are exposed.** Birth-quality Z and the five
    career-profile attributes are server-private development inputs. They are
    never surfaced through any API view, and nothing derived from them (a star
    rating, a potential figure, a growth tier) is stored on the player or shown
    to a manager. There is exactly ONE growth capacity authority — the career
    growth budget — and one decline authority; no second ceiling, growth tier or
    development-rate multiplier may exist alongside them. Initial-roster pairing
    may correlate existing peak-quality tickets with existing career-stage
    bundles (it creates no new hidden rating, growth authority, or ceiling), and
    every player's assigned raw Z stays a server-private input like any other.

27. **Financial interventions pay the auction floor, never full value.**
    System liquidation credits the distressed club at the minimum acceptable
    opening price so deliberate insolvency cannot be farmed as a full-value
    liquidity pump.

28. **AI clubs are ephemeral single-season fillers.** Each AI team is generated
    for exactly one season: a fixed `SENIOR_SQUAD_LIMIT` senior roster, no
    academy, and zero finances (cash never changes; payroll, budgets,
    interventions and contract cycles skip them). They never sell, buy, loan,
    borrow or dismiss players. A human taking their slot or the season ending
    destroys them forever (`retireFillerClub` / `removeFillerClubs`), and every
    surviving filler is replaced by a fresh team when the next season's
    divisions are built (`ensureDivisionFull`).

29. **An extinct bottom-edge tier vanishes instead of receiving relegations.**
    A tier whose divisions contain no active human clubs at rollover (every
    human abandonment-flagged or DORMANT) is removed from the movement
    calculation: the tier above becomes the bottom tier and its bottom-2 are
    not relegated. The vanished tier is not rebuilt next season. A humanless
    tier ABOVE the deepest populated tier is not extinct: it still receives
    relegations from above and promotions from below and repopulates that way.
    The same rule is projected live into `relegationStatus` during the season.

30. **Overall is always derived from the seven persisted skills.** Generation
    and development may target an OVR-equivalent amount, but no code path may
    add to or subtract from `player.overall` independently of the skills. Every
    mutation recomputes it with `overallFromSkills(position, skills)`. Initial
    senior cohort conditioning may bound the target and adjust the effective
    personal peak, but the persisted OVR still comes only from generated skills;
    the player's persisted consumed career budgets must match that same peak.

31. **One professional-salary authority.** Every newly negotiated professional
    contract — ordinary renewal, renewal of a promoted academy player's retained
    deal, the contract attached to a winning transfer bid, a free-agent signing,
    and a generated first contract — resolves through
    `calculateProfessionalContractSalary`. Contract length always means complete
    seasons IN ADDITION TO the remainder of the current season; a total length
    may never be passed in its place. Club renewals and transfers apply the
    no-pay-cut floor (the greater of the current salary and the current-OVR
    market salary); free-agent signings and generated contracts do not, so an
    expired salary never follows a player into free agency.

32. **Academy terms and wages are derived, and promotion renegotiates nothing.**
    An academy contract always ends at `academyContractEndAge`, so its length is
    `academyContractEndAge - currentAge`; it can never be renewed or extended
    while the player is in the academy. Academy salary is exactly
    `academySalaryMultiplier` of the full professional calculation for the same
    player, with no professional floor reapplied — and therefore also produces a
    deliberately low release clause. Promotion (voluntary from
    `academyVoluntaryPromotionAge`, mandatory at `academyAutomaticPromotionAge`)
    preserves salary, contract start, contract end and remaining duration
    exactly, accepts no contract term and performs no salary calculation. No
    player remains `isYouth` at or beyond the automatic promotion age. Only the
    brand-new club's initial academy may condition personal peaks into a
    division-relative cohort band. Seasonal academy intake must continue through
    the independent pedigree generator and retain its intended outliers.

33. **Player movement is manager-driven only.** The game exposes no division-fit
    field, no division recommendation, no automatic listing of a human club's
    player, no forced sale, and no division-based contract refusal. Upward
    careers emerge from overlapping division distributions, uncapped
    development, value and salary tracking current OVR, larger higher-tier
    budgets, and the existing cross-division bid cap.

34. **Population events increment durable counters; only the seasonal intake
    creates players.** Every terminal or structural population event increments
    its pending counter exactly once, in the same transaction that performs the
    change. Deleting or signing a player, or activating a club, never generates
    a player immediately. The single seasonal academy intake snapshots and
    consumes the counters, generates the players, updates the signed carry and
    the seeded allocation record, and marks its idempotency key in one atomic
    locked commit — so a retry observes either all of those effects or none, and
    can never convert the same deletion into intake twice.

35. **The active-population boundary excludes filler, provisional and dormant
    stock.** Population control counts only players owned by active persistent
    clubs plus professional free agents inside their retention period. A dormant
    transition removes a club's target contribution and its frozen stock
    together and therefore adds no correction; provisional and filler creation
    and destruction are always zero. Academy promotion reclassifies an existing
    active player and is never a population flow, and transfers, signings and
    loans change ownership rather than population.

36. **Intake is an exact global total, then an allocation.** The signed
    correction may be negative, but generated intake never is: a configurable
    positive minimum per active club is always honoured and any unserved balance
    is carried forward. The resolved integer total is split as an equal
    whole-number share plus a seeded-random remainder of at most one extra
    player per club, reproducible from the world seed, season and intake key,
    and independent of club processing order. Slots blocked by a full academy
    carry into the correction rather than rerolling or disappearing.

37. **A youth dismissal is compensated globally, never locally.** It creates no
    credit for the dismissing club and no targeted replacement. The loss becomes
    one extra player in the GLOBAL correction at the first seasonal intake of
    the following season — the intake that accounts for the completed season's
    drain — and is shared out through the seeded allocation like every other
    recruit, so a club can never dismiss and reroll for itself. Between the
    dismissal and that intake, reconciliation treats the pending count as
    deliberately unavailable stock rather than unexplained drift.

38. **Admin account deletion never breaks immutable history.** An ACTIVE club
    whose owner's account is deleted is replaced IN PLACE by a freshly generated
    AI team: the club keeps its id so completed fixtures, results and standings
    stay untouched (invariant 19); identity, squad, finances, ledger, trophies,
    lineups, automation, Elo and market involvement are all reset to fresh
    filler semantics (deterministic identity seeded from the club id, a new
    static squad, zero cash, current tier kept as the highest-division marker).
    If the club is in a live match at deletion time, the match is force-finished
    through the authoritative resolve-now path BEFORE the squad is destroyed, so
    no LiveMatchState can survive referencing deleted player ids. From then on
    the club is a normal ephemeral AI club and is removed at the next rollover
    (invariant 28). A NEW/PROVISIONAL/DORMANT club is removed entirely with its
    queue, allocations and memberships. The world mutation persists before the
    account rows are deleted, so a crash leaves a retry-safe state.

39. **A reset with identity preservation archives only identity of ACTIVE and
    DORMANT clubs, and the claim is consume-once.** `keepIdentity` snapshots per
    owner of an ACTIVE or DORMANT club: name, short name, country, stadium
    name, coach name, kit designs, the two identity colors, the custom crest
    (data + variant), preferred match-time availability and friend-grouping
    consent — nothing game-progress related. PROVISIONAL clubs are not
    archived. Archive rows live outside the Save scope (they survive the wipe)
    and are deleted the moment the owner's next join successfully re-applies
    them. Friendships already live outside the Save scope and always survive a
    reset untouched.

40. **The world never plays an AI-only season.** After a reset, or after any
    rollover that ends with zero human clubs, the world enters
    waiting-for-first-human mode: no division, club or fixture exists, and the
    season clock is held via the same `pausedAt` gate as an admin pause
    (scheduler, day advancement, live matches and all timers frozen; manual
    admin resume refused). Only the first human join (or a dormant return)
    lifts the hold: it applies the resume shift so the season starts anchored
    to the join moment, clears the flag, and creates Division 1 lazily
    (`placeNewClub`), which the joining club plus seven fresh filler AI fill.
    A season that ends with zero humans re-enters the same waiting state.

41. **Paused joins place into the same division an unpaused join would.**
    Joining and dormant-returning stay allowed while `pausedAt` is set: the
    placement instant IS the frozen instant, and `applyResumeShift` re-anchors
    every real-time timer on resume. The `SIMULATING_HISTORY` skip in
    `firstReplaceableAIDivision` is relaxed while paused only — `completedRounds`
    cannot advance under the freeze, so the fixed `finalRound` of a backfilling
    division stays correct for every paused joiner, and a second joiner
    re-scheduling chunk 1 is an idempotency-keyed no-op. Market, contract and
    admin controls remain frozen.

42. **Natural position has exactly one authority.** `Player.position` (the nine
    natural positions) is the only persisted position identity. Broad group is
    always derived, never stored; a deployed role belongs only to a
    formation/live slot and is never persisted on the player. No `side` or
    `tacPos` field may be reintroduced, and no numeric position may appear in
    a public API.

43. **Out-of-position deployment is a single monotonic raw-skill penalty.**
    Playing a natural position in a deployed role applies the configured
    compatibility penalty exactly once: `effectiveRaw = clamp(raw - penalty, 1,
    100)` for every consumed skill; `usableZ = robustZ(effectiveRaw) * readiness`
    (no fit multiplier). The penalty never changes OVR, value, salary, or
    intrinsic development, and it can never improve a player.

44. **OVR is derived from persisted visible skills through the natural
    position's broad group.** OVR is never stored as an independent authority
    and never changes when a player's natural position migrates within its
    broad group. The position-model migration is atomic, retry-safe, refuses
    active live matches, and changes no numeric player/economic state.

45. **Passing and Playmaking have distinct causal pathways.** Passing is
    action-execution quality; Playmaking affects only forward destination
    quality in the match engine. Playmaking never enters athleticism, fatigue,
    recovery, injury, or lasting-setback calculations, and no AI config or
    profile field may treat it as physical.

46. **News history is render-immutable.** A persisted `NewsItem` is never
    rewritten once written: its `text`, `entriesJson` and `bodyJson` are the
    authoritative record, and the client renders whatever was stored. Localized
    news is emitted as a stable message key (`body`) at publish time; merging
    same-day same-subject items recomputes only the frame key and accumulates
    entries. Legacy rows (non-null `text`, null `bodyJson`) are never backfilled
    or migrated to keys — they keep rendering from `text` forever.

47. **Automation presets are club-scoped configuration, deliberately kept
    outside the World object and outside `Save.revision`'s transaction**
    (`services/automationPresetService.ts`; `Club.automationPresetsJson`).
    They are loaded on demand for only the clubs whose matches are actually
    being advanced, never held in memory for every club on every world load.
    Do not reintroduce an `automationPresets` field on the in-memory `Club`
    type or route its reads/writes through `persistWorld`/`loadGlobalWorld*` —
    that was the exact bug this invariant guards against: `clubRow` intentionally
    omits the column so an unrelated per-club UPDATE (or the no-previous-baseline
    upsert path in `persistWorld`) can never reset it to null. A concurrent
    preset edit and a concurrent world mutation are therefore never in
    contention with each other; at worst a rule edit lands a moment later than
    the request that made it.

