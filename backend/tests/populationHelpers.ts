/**
 * Re-exports of the population-control surface used by tests. Keeping the
 * imports in one place means a rename in the engine surfaces as a single
 * compile error rather than a scatter of them across suites.
 */
export {
  activePersistentClubs,
  activePopulation,
  allocatedIntakeForClub,
  commitSeasonalIntake,
  emptyPopulationLedger,
  ensurePopulationLedger,
  expectedEligibleRetirements,
  isActivePersistentClub,
  pendingYouthDismissalCount,
  planSeasonalIntake,
  recordActiveClubBoundaryChange,
  recordExtraNonAcademyGeneration,
  recordRetirementOutcome,
  recordTerminalDeletion,
  recordYouthDismissal,
  retirementBaselinePerClub,
  targetActivePopulation,
  targetFreeAgentPool,
  type IntakePlan,
} from "../src/game/population";
export { expectedActivePlayerLifetimeFromAcademyEntry } from "../src/game/careerCurves";
