import { describe, expect, it } from "vitest";
import { applyMatchToPlayers, tribunalGamesForDraw, tribunalSuspension } from "../src/game/match";
import { leagueTurnKey } from "../src/services/seasonCalendar";
import { gameConfig } from "../src/config";
import { EVENT_CODES } from "../src/game/constants";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { playerView } from "../src/services/snapshot";
import type { Match } from "../src/game/types";
import { makeClub, makeWorld } from "./helpers";

const ROUNDS_PER_TURN = gameConfig.league.teams - 1;

function setupBookedPlayer() {
  const club = makeClub({ id: 1 });
  const player = generatePlayer(createRng(11), club, { id: 1 });
  const world = makeWorld([club], [player]);
  return { club, player, world };
}

/** Unplayed division fixture so applyTurnYellow can resolve the booking turn. */
function addFixture(world: ReturnType<typeof makeWorld>, id: number, round: number): void {
  world.fixtures.push({
    id,
    competitionId: world.competitions[0].id,
    round,
    homeClubId: 1,
    awayClubId: -1,
    dayIndex: round * 2,
    played: false,
  });
}

function yellowAt(club: ReturnType<typeof makeClub>, player: { id: number }, fixtureId: number | null, world: ReturnType<typeof makeWorld>): void {
  applyMatchToPlayers({
    ...(fixtureId !== null ? { fixtureId } : {}),
    events: [{ minute: 30, half: 1, type: EVENT_CODES.YELLOW, subtype: 0, clubId: club.id, playerId: player.id, player2Id: null, goalType: 0 }],
  } as unknown as Match, world);
}

describe("red-card tribunal log model", () => {
  it("maps draws through round(base + lnCoefficient * ln(X))", () => {
    expect(gameConfig.discipline.tribunalBase).toBeCloseTo(5.1748, 10);
    expect(gameConfig.discipline.tribunalLnCoefficient).toBeCloseTo(-0.9884, 10);
    // Bucket boundaries of the log model over X = 1..100.
    expect(tribunalGamesForDraw(1)).toBe(5);
    expect(tribunalGamesForDraw(2)).toBe(4);
    expect(tribunalGamesForDraw(5)).toBe(4);
    expect(tribunalGamesForDraw(6)).toBe(3);
    expect(tribunalGamesForDraw(14)).toBe(3);
    expect(tribunalGamesForDraw(15)).toBe(2);
    expect(tribunalGamesForDraw(41)).toBe(2);
    expect(tribunalGamesForDraw(42)).toBe(1);
    expect(tribunalGamesForDraw(100)).toBe(1);
  });

  it("yields the documented ban distribution", () => {
    const counts = new Map<number, number>();
    for (let x = 1; x <= 100; x++) {
      const g = tribunalGamesForDraw(x);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(counts.get(1)).toBe(59);
    expect(counts.get(2)).toBe(27);
    expect(counts.get(3)).toBe(9);
    expect(counts.get(4)).toBe(4);
    expect(counts.get(5)).toBe(1);
  });

  it("stays deterministic on the world RNG and consumes one draw per red", () => {
    const a = createRng(1234);
    const b = createRng(1234);
    for (let i = 0; i < 50; i++) expect(tribunalSuspension(a)).toBe(tribunalSuspension(b));
    for (let i = 0; i < 200; i++) {
      const g = tribunalSuspension(a);
      expect(g).toBeGreaterThanOrEqual(1);
      expect(g).toBeLessThanOrEqual(5);
    }
  });
});

describe("per-league-turn yellow accumulation", () => {
  it("bans after two bookings inside one turn and opens a fresh window", () => {
    const { club, player, world } = setupBookedPlayer();
    addFixture(world, 5001, 0);
    addFixture(world, 5002, 1);

    yellowAt(club, player, 5001, world);
    yellowAt(club, player, 5002, world);

    // Season total keeps counting across the ban (season history source).
    expect(player.yellows).toBe(2);
    expect(player.reds).toBe(0);
    expect(player.suspendedGames).toBe(gameConfig.discipline.turnYellowBanGames);
    expect(player.turnYellows ?? 0).toBe(0);
    expect(player.yellowsTurnKey ?? null).toBeNull();
  });

  it("never carries bookings across a league-turn boundary", () => {
    const { club, player, world } = setupBookedPlayer();
    addFixture(world, 5003, ROUNDS_PER_TURN - 1); // last round of turn 0
    addFixture(world, 5004, ROUNDS_PER_TURN); // first round of turn 1

    yellowAt(club, player, 5003, world);
    yellowAt(club, player, 5004, world);

    expect(player.yellows).toBe(2);
    expect(player.suspendedGames).toBe(0);
    expect(player.turnYellows ?? 0).toBe(1);
    expect(player.yellowsTurnKey ?? null).toBe(leagueTurnKey(0, ROUNDS_PER_TURN));
  });

  it("tracks a single booking within its turn without a ban", () => {
    const { club, player, world } = setupBookedPlayer();
    addFixture(world, 5005, 2);

    yellowAt(club, player, 5005, world);

    expect(player.yellows).toBe(1);
    expect(player.suspendedGames).toBe(0);
    expect(player.turnYellows ?? 0).toBe(1);
    expect(player.yellowsTurnKey ?? null).toBe(leagueTurnKey(0, 2));
  });

  it("ignores turn accounting for matches without a committed fixture", () => {
    const { club, player, world } = setupBookedPlayer();
    yellowAt(club, player, 987654, world);
    expect(player.yellows).toBe(1);
    expect(player.suspendedGames).toBe(0);
    expect(player.turnYellows ?? 0).toBe(0);
    expect(player.yellowsTurnKey ?? null).toBeNull();
  });
});

describe("per-turn yellow warning flag", () => {
  it("flags one-card-away players only when the next match shares the booking turn", () => {
    const { player, world } = setupBookedPlayer();
    addFixture(world, 5007, 0);
    const keyTurn0 = leagueTurnKey(0, 0);
    const keyTurn1 = leagueTurnKey(0, ROUNDS_PER_TURN);

    player.turnYellows = 1;
    player.yellowsTurnKey = keyTurn0;

    const warned = playerView(player, undefined, 0, null, keyTurn0);
    expect(warned.yellowWarning).toBe(true);
    expect(warned.turnYellows).toBe(1);

    // Next match belongs to the next turn: the limit resets, no warning.
    expect(playerView(player, undefined, 0, null, keyTurn1).yellowWarning).toBe(false);
    // No upcoming fixture: nothing to warn about.
    expect(playerView(player, undefined, 0, null, null).yellowWarning).toBe(false);
    // Caller without next-fixture context (loans, other-club views).
    expect(playerView(player, undefined, 0, null).yellowWarning).toBe(false);

    // Suspended players show the suspension instead of a pre-ban warning.
    player.suspendedGames = 1;
    expect(playerView(player, undefined, 0, null, keyTurn0).yellowWarning).toBe(false);
  });

  it("stays silent for players without bookings in the relevant turn", () => {
    const { player } = setupBookedPlayer();
    const key = leagueTurnKey(3, 5);
    player.turnYellows = 1;
    player.yellowsTurnKey = leagueTurnKey(0, 5);
    expect(playerView(player, undefined, 0, null, key).yellowWarning).toBe(false);

    player.yellowsTurnKey = key;
    player.turnYellows = 0;
    expect(playerView(player, undefined, 0, null, key).yellowWarning).toBe(false);
  });
});
