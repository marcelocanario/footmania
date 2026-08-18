# Multiplayer Core Design Invariants

These invariants are the non-negotiable rules of the multiplayer league engine
(plan `plans/multiplayer.md` §92). Any refactor or new feature must preserve them.

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
    Squads, tactics, transfers, auctions, free agents and non-persistent
    practice matches all stay enabled while provisional.

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
