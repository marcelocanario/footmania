import { describe, expect, it } from "vitest";
import { aiBestXI, chooseAiTactics } from "../src/game/club";

import { generatePlayer } from "../src/game/player";
import { createRng, type RngState } from "../src/game/rng";
import type { Club, Player, Position, SkillSet } from "../src/game/types";

let clubIdCounter = 700;
function makeClub(isHuman = false): Club {
  return {
    id: clubIdCounter++,
    name: "Test",
    shortName: "TST",
    ownerUserId: isHuman ? 1 : null,
    competitionState: "ACTIVE",
    lastMeaningfulActivityAt: null,
    abandonmentEligibleAt: null,
    liveMatchAt: null,
    country: "BRA",
    highestDivision: 1,
    cash: 10000000,
    stadiumName: "St",
    primaryColor: "#000",
    secondaryColor: "#fff",
    coachName: "Coach",
    tactics: { formation: 4, style: 0, pressing: 0, direction: 0 },
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    isHuman,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
}

const POSITIONS: Position[] = ["GK", "GK", "GK", "LB", "LB", "LB", "RB", "RB", "CB", "CB", "CB", "CB", "DM", "DM", "DM", "AM", "AM", "AM", "ST", "ST", "ST"];

function makeSquad(rng: RngState, club: Club, count: number): Player[] {
  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    players.push(generatePlayer(rng, club, { id: i + 1, position: POSITIONS[i % POSITIONS.length] }));
  }
  return players;
}

/** A player with explicit skills (all other attributes left at generation defaults). */
function skilled(club: Club, id: number, position: Position, skills: Partial<SkillSet>, overrides: Partial<Player> = {}): Player {
  const p = generatePlayer(createRng(id * 131 + 7), club, { id, position });
  return Object.assign(p, { skills: { ...p.skills, ...skills }, ...overrides });
}

describe("chooseAiTactics", () => {
  it("is deterministic for identical squads", () => {
    const rng = createRng(11);
    const ai = makeClub(false);
    const base = makeSquad(rng, ai, 21);
    const clone = () => base.map((p) => ({ ...p, skills: { ...p.skills } }));

    chooseAiTactics(ai, clone());
    const first = { ...ai.tactics };
    ai.tactics = { formation: 4, style: 0, pressing: 0, direction: 0 };
    chooseAiTactics(ai, clone());
    expect(ai.tactics).toEqual(first);
  });

  it("never touches a human club's tactics", () => {
    const rng = createRng(21);
    const human = makeClub(true);
    const squad = makeSquad(rng, human, 21);
    const before = { ...human.tactics };
    chooseAiTactics(human, squad);
    expect(human.tactics).toEqual(before);
  });

  it("fields more of its elite defenders when the quality sits in the back line", () => {
    const defensive = makeClub(false);
    const attacking = makeClub(false);
    // Defensive club: elite FB/CB pool, mediocre everything else.
    const defSquad: Player[] = [skilled(defensive, 90, "GK", { gol: 70 })];
    for (let i = 0; i < 10; i++) {
      defSquad.push(skilled(defensive, i + 1, i % 2 === 0 ? "LB" : "CB", { des: 85, playmaking: 80, pas: 60, pace: 60, tec: 55, fin: 40 }));
    }
    for (let i = 10; i < 20; i++) {
      defSquad.push(skilled(defensive, i + 1, POSITIONS[i % POSITIONS.length], { des: 45, playmaking: 45, pas: 45, pace: 45, tec: 45, fin: 45 }));
    }
    // Attacking club: elite FW/AM pool with a thin, weak back line.
    const attSquad: Player[] = [skilled(attacking, 190, "GK", { gol: 70 })];
    for (let i = 0; i < 6; i++) {
      attSquad.push(skilled(attacking, 100 + i, "ST", { fin: 88, pace: 85, tec: 75, des: 40, playmaking: 45, pas: 60 }));
    }
    for (let i = 6; i < 12; i++) {
      attSquad.push(skilled(attacking, 100 + i, "AM", { pas: 82, tec: 82, playmaking: 70, des: 50, pace: 55, fin: 55 }));
    }
    for (let i = 12; i < 20; i++) {
      attSquad.push(skilled(attacking, 100 + i, i % 2 === 0 ? "LB" : "CB", { des: 48, playmaking: 48, pas: 48, pace: 48, tec: 48, fin: 48 }));
    }

    const defensiveAvailable = defSquad.filter((p) => p.clubId === defensive.id);
    const attackingAvailable = attSquad.filter((p) => p.clubId === attacking.id);
    const defXI = aiBestXI(defensiveAvailable, { pressing: 50, futureFixtures: true });
    const attXI = aiBestXI(attackingAvailable, { pressing: 50, futureFixtures: true });
    expect(defXI).not.toBeNull();
    expect(attXI).not.toBeNull();
    const defendersInXI = (xi: NonNullable<typeof defXI>) =>
      xi.slots.filter((slot) => slot.player.position === "LB" || slot.player.position === "RB" || slot.player.position === "CB").length;
    expect(defendersInXI(defXI!)).toBeGreaterThan(defendersInXI(attXI!));
    // The formation chosen by chooseAiTactics is exactly aiBestXI's argmax.
    chooseAiTactics(defensive, defSquad);
    expect(defensive.tactics.formation).toBe(defXI!.formation);
    expect(defXI!.slots.length).toBe(11);
  });

  it("maps the attribute profile onto style: pace/finishing counters, passing controls, defending presses", () => {
    const counter = makeClub(false);
    const control = makeClub(false);
    const press = makeClub(false);
    const fill = (club: Club, position: Position, skills: Partial<SkillSet>) => {
      const squad: Player[] = [skilled(club, 900 + club.id, "GK", { gol: 65 })];
      for (let i = 1; i < 17; i++) {
        squad.push(skilled(club, 900 + club.id * 100 + i, position, skills));
      }
      return squad;
    };
    const counterSquad = fill(counter, "ST", { pace: 90, fin: 88, tec: 45, pas: 42, des: 42, playmaking: 44 });
    const controlSquad = fill(control, "AM", { tec: 92, pas: 90, pace: 45, fin: 44, des: 46, playmaking: 46 });
    const pressSquad = fill(press, "CB", { des: 92, playmaking: 90, tec: 45, pas: 44, pace: 50, fin: 42 });
    chooseAiTactics(counter, counterSquad);
    chooseAiTactics(control, controlSquad);
    chooseAiTactics(press, pressSquad);
    expect(counter.tactics.style).toBe(2); // COUNTER
    expect(control.tactics.style).toBe(0); // CONTROL
    expect(press.tactics.style).toBe(1); // PRESS
  });

  it("scales pressing intensity with physical quality and energy reserve", () => {
    const heavy = makeClub(false);
    const light = makeClub(false);
    const build = (club: Club, des: number, playmaking: number) => {
      const squad: Player[] = [skilled(club, 800 + club.id, "GK", { gol: 65 })];
      for (let i = 1; i < 17; i++) {
        squad.push(skilled(club, 800 + club.id * 100 + i, "CB", { des, playmaking, pace: 60, tec: 60, pas: 60, fin: 50 }));
      }
      return squad;
    };
    const heavySquad = build(heavy, 90, 88);
    const lightSquad = build(light, 40, 38);
    chooseAiTactics(heavy, heavySquad);
    chooseAiTactics(light, lightSquad);
    expect(heavy.tactics.pressing).toBeGreaterThan(light.tactics.pressing);
    expect(heavy.tactics.pressing).toBe(2); // Heavy: physical + fresh
    expect(light.tactics.pressing).toBe(0); // Light
  });

  it("plays down the wings when the chosen XI is clearly stronger there", () => {
    const rng = createRng(61);
    const wide = makeClub(false);
    const squad: Player[] = [skilled(wide, 500, "GK", { gol: 65 })];
    // Elite wide-quality fullbacks/wingers, weak central players.
    for (let i = 1; i <= 6; i++) {
      squad.push(skilled(wide, 500 + i, "LB", { pace: 92, tec: 88, des: 78, pas: 78, playmaking: 60, fin: 60 }));
    }
    for (let i = 7; i <= 16; i++) {
      squad.push(skilled(wide, 500 + i, i % 2 === 0 ? "CB" : "AM", { pace: 40, tec: 42, des: 44, pas: 44, playmaking: 44, fin: 40 }));
    }
    chooseAiTactics(wide, squad);
    expect(wide.tactics.direction).toBe(1); // WIDE
  });

  it("only considers available players: injured/suspended contributors do not shape the profile", () => {
    const club = makeClub(false);
    const squad: Player[] = [skilled(club, 300, "GK", { gol: 65 })];
    // Ten elite defenders — but all of them suspended.
    for (let i = 1; i <= 10; i++) {
      squad.push(skilled(club, 300 + i, "CB", { des: 95, playmaking: 95, pas: 40, pace: 40, tec: 40, fin: 40 }, { suspendedGames: 1 }));
    }
    // Available squad is full of attackers.
    for (let i = 11; i <= 20; i++) {
      squad.push(skilled(club, 300 + i, "ST", { fin: 90, pace: 88, tec: 70, des: 35, playmaking: 40, pas: 45 }));
    }
    chooseAiTactics(club, squad);
    const xiWithoutDefenders = aiBestXI(
      squad.filter((p) => p.clubId === club.id && p.suspendedGames === 0),
      { pressing: 50, futureFixtures: true }
    );
    expect(xiWithoutDefenders).not.toBeNull();
    // No unavailable player can appear in the XI.
    for (const slot of xiWithoutDefenders!.slots) {
      expect(slot.player.suspendedGames).toBe(0);
    }
    // Re-run without suspensions: now the elite defenders shape the choice.
    for (const p of squad) p.suspendedGames = 0;
    chooseAiTactics(club, squad);
    const xiWithDefenders = aiBestXI(squad.filter((p) => p.clubId === club.id), { pressing: 50, futureFixtures: true });
    const cbCount = (xi: NonNullable<typeof xiWithDefenders>) => xi.slots.filter((slot) => slot.player.position === "CB" || slot.player.position === "LB" || slot.player.position === "RB").length;
    expect(xiWithDefenders).not.toBeNull();
    expect(cbCount(xiWithDefenders!)).toBeGreaterThan(cbCount(xiWithoutDefenders!));
  });

  it("leaves tactics untouched when no player can take the pitch", () => {
    const rng = createRng(81);
    const club = makeClub(false);
    const squad = makeSquad(rng, club, 5).map((p) => ({ ...p, injuryDays: 3 }));
    const before = { ...club.tactics };
    chooseAiTactics(club, squad);
    expect(club.tactics).toEqual(before);
  });
});
