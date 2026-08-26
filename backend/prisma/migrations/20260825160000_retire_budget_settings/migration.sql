-- Retire the persisted season-budget balance settings.
--
-- The Division 1 seasonal budget, the minimum tier ratio and the tier decay
-- rate are now owned exclusively by backend/config/game.config.jsonc, because
-- they anchor both seasonal allocations and every player market value. Keeping
-- a database copy meant a stale admin save could silently override a
-- configuration rollout and desynchronize prices from budgets.
--
-- Only these three keys are removed. The Setting table itself stays: the global
-- lock, scheduler bookkeeping, match timing, inactivity thresholds and the join
-- threshold still live there. Season allocations already issued to clubs are
-- stored on MpAllocation and are immutable; they are not touched here.
DELETE FROM "Setting"
WHERE "key" IN (
  'FIRST_DIVISION_SEASON_BUDGET',
  'MINIMUM_TIER_BUDGET_RATIO',
  'TIER_BUDGET_DECAY_RATE'
);
