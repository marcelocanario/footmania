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

5. **Human density takes priority over timezone clustering.** Divisions are
   filled to 8 humans before opening another, then boundary-swapped by timezone.

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

17. **Abandoned clubs retain their underlying club, squad, finances and
    progression.** DORMANT preserves everything; the club can return.

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

23. **One senior-roster cap governs every acquisition path.**
    `SENIOR_SQUAD_LIMIT` bounds youth promotions, transfer-auction wins,
    free-agent signings and loan claims alike. Loaned-in players occupy squad
    slots and count; loaned-out players do not. Bid-time checks fail early;
    settlement re-checks fail closed (terminal: the listing is cancelled, the
    player stays with the seller).

24. **Loans cost a lender-chosen fee within a configured band.** The listing
    owner picks a claim fee between `MARKET_CONFIG.loans.feeMinValueRatio` and
    `feeMaxValueRatio` of the player's value, snapshotted in absolute currency
    at listing time. The borrower pays the lender at claim time from actual
    unreserved cash (§9 immediate-cash rule); a club may hold at most
    `maxLoanedInPerClub` borrowed players.

25. **Live matches advance only on the server clock.** Clients may request an
    elapsed-time catch-up but can never accelerate, pause for advantage, or
    force-finish a match; the worker's real-time pacing is authoritative.

26. **No hidden quality flags on players.** Birth-quality/potential indicators
    are server-private development inputs derived from persisted generation
    data (`rawZ`); they are never stored as a player field nor exposed through
    any API view.

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
