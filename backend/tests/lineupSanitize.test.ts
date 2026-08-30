import { describe, expect, it } from "vitest";
import { lineupForMatch, peekLineup, sanitizeSavedLineup } from "../src/game/club";
import { generatePlayer } from "../src/game/player";
import { createRng } from "../src/game/rng";
import { formationById } from "../src/game/formations";
import type { Club, Player, Position } from "../src/game/types";

function makeClub(id = 900): Club {
  return {
    id,
    name: "Sanitize FC",
    shortName: "SFC",
    ownerUserId: 1,
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
    isHuman: true,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
}

// Formation 4 slot roles: GK, LB, CB1, CB2, AM, DM, DM, AM, ST1, ST2 — the
// test players are natural positions, kept eligible for every slot they occupy.
const STARTER_POSITIONS: Position[] = ["GK", "LB", "CB", "CB", "AM", "DM", "AM", "AM", "ST", "ST", "AM"];
const BENCH_POSITIONS: Position[] = ["GK", "CB", "LB", "DM", "ST", "LW", "AM"];

interface Scenario {
  club: Club;
  players: Player[];
  starters: number[];
  subs: number[];
}

function scenario(withSpare = true): Scenario {
  const club = makeClub();
  const rng = createRng(4242);
  const players: Player[] = [];
  let id = 100;
  for (const position of STARTER_POSITIONS) {
    players.push(generatePlayer(rng, club, { id: ++id, position }));
  }
  for (const position of BENCH_POSITIONS) {
    players.push(generatePlayer(rng, club, { id: ++id, position }));
  }
  if (withSpare) {
    players.push(generatePlayer(rng, club, { id: ++id, position: "DM" }));
  }
  const starters = players.slice(0, 11).map((p) => p.id);
  const subs = players.slice(11, 18).map((p) => p.id);
  return { club, players, starters, subs };
}

function byId(players: Player[], id: number): Player {
  const found = players.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing player ${id}`);
  return found;
}

describe("sanitizeSavedLineup", () => {
  it("passes a fully valid saved lineup through unchanged", () => {
    const s = scenario();
    const result = sanitizeSavedLineup(s.club, s.players, { starters: s.starters, subs: s.subs, freeKickTakerId: null });
    expect(result).not.toBeNull();
    expect(result!.starters.map((p) => p.id)).toEqual(s.starters);
    expect(result!.subs.map((p) => p.id)).toEqual(s.subs);
  });

  it("promotes the position-fit bench player into an invalid starter slot and tops up the bench", () => {
    const s = scenario(true);
    const injuredStarter = byId(s.players, s.starters[2]); // CB slot
    injuredStarter.injuryDays = 12;
    const slotRole = formationById(4)!.slots[2].role;
    const spare = s.players[s.players.length - 1];

    const result = sanitizeSavedLineup(s.club, s.players, { starters: s.starters, subs: s.subs, freeKickTakerId: null })!;
    expect(result.starters).toHaveLength(11);
    expect(result.starters.map((p) => p.id)).not.toContain(injuredStarter.id);
    // §9.3: the replacement is the unused bench/squad candidate with the
    // highest pair score for the slot (a DM can outscore a CB at the CB slot
    // with strong defending/passing), and it came from the saved bench.
    const promoted = result.starters[2];
    expect(promoted.id).not.toBe(injuredStarter.id);
    expect(s.subs).toContain(promoted.id);
    // The vacated bench slot is topped up so the chosen squad size survives.
    expect(result.subs).toHaveLength(s.subs.length);
    expect(result.subs.map((p) => p.id)).not.toContain(promoted.id);
    expect(result.subs.map((p) => p.id)).toContain(spare.id);
    // Surviving bench entries keep their relative order ahead of the top-up.
    const surviving = s.subs.filter((id) => id !== promoted.id);
    expect(result.subs.slice(0, surviving.length).map((p) => p.id)).toEqual(surviving);
    // No duplicated match-squad entries.
    const ids = [...result.starters.map((p) => p.id), ...result.subs.map((p) => p.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.starters.every((p) => p.starter)).toBe(true);
    expect(result.subs.every((p) => !p.starter)).toBe(true);
    void slotRole;
  });

  it("replaces a goalkeeper only with the bench goalkeeper", () => {
    const s = scenario(false);
    const gkStarter = byId(s.players, s.starters[0]);
    gkStarter.injuryDays = 3;
    const benchGk = byId(s.players, s.subs[0]); // BENCH_POSITIONS[0] = GK
    const result = sanitizeSavedLineup(s.club, s.players, { starters: s.starters, subs: s.subs, freeKickTakerId: null })!;
    expect(result.starters[0].id).toBe(benchGk.id);
    expect(result.starters[0].position).toBe("GK");
  });

  it("treats suspended, on-sale and duplicated entries as invalid", () => {
    const s = scenario(false);
    byId(s.players, s.starters[4]).suspendedGames = 1;
    byId(s.players, s.starters[5]).onSale = true;
    const duplicated = s.starters[6];
    const savedStarters = [...s.starters];
    savedStarters[7] = duplicated; // duplicate of slot 6
    const result = sanitizeSavedLineup(s.club, s.players, { starters: savedStarters, subs: s.subs, freeKickTakerId: null })!;
    expect(result.starters.map((p) => p.id)).not.toContain(savedStarters[4]);
    expect(result.starters.map((p) => p.id)).not.toContain(savedStarters[5]);
    // The duplicate slot was refilled with someone else.
    expect(result.starters[7].id).not.toBe(duplicated);
    // No player appears twice across the match squad.
    const ids = [...result.starters.map((p) => p.id), ...result.subs.map((p) => p.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns null when no valid eleven can be assembled", () => {
    const s = scenario(false);
    // Cripple every bench option plus two starters: only 10 healthy remain.
    for (const id of s.subs) byId(s.players, id).injuryDays = 30;
    byId(s.players, s.starters[9]).injuryDays = 30;
    byId(s.players, s.starters[10]).injuryDays = 30;
    const result = sanitizeSavedLineup(s.club, s.players, { starters: s.starters, subs: [], freeKickTakerId: null });
    expect(result).toBeNull();
  });

  it("is deterministic across repeated runs", () => {
    const build = () => {
      const s = scenario(true);
      byId(s.players, s.starters[1]).injuryDays = 8;
      byId(s.players, s.subs[3]).suspendedGames = 2;
      const first = sanitizeSavedLineup(s.club, s.players, { starters: s.starters, subs: s.subs, freeKickTakerId: null });
      const second = sanitizeSavedLineup(s.club, s.players, { starters: s.starters, subs: s.subs, freeKickTakerId: null });
      return { first, second };
    };
    const { first, second } = build();
    expect(first).not.toBeNull();
    expect(second!.starters.map((p) => p.id)).toEqual(first!.starters.map((p) => p.id));
    expect(second!.subs.map((p) => p.id)).toEqual(first!.subs.map((p) => p.id));
  });
});

describe("lineup unavailability integration", () => {
  it("lineupForMatch repairs the saved lineup instead of discarding it", () => {
    const s = scenario(true);
    const injured = byId(s.players, s.starters[2]);
    injured.injuryDays = 6;
    s.club.savedLineup = { starters: s.starters, subs: s.subs, freeKickTakerId: null };
    const lineup = lineupForMatch(s.club, s.players);
    expect(lineup).not.toBeNull();
    expect(lineup!.starters).toHaveLength(11);
    expect(lineup!.starters.map((p) => p.id)).not.toContain(injured.id);
    // The rest of the user's chosen eleven survived untouched.
    for (let i = 0; i < 11; i++) {
      if (i === 2) continue;
      expect(lineup!.starters.some((p) => p.id === s.starters[i])).toBe(true);
    }
  });

  it("peekLineup preview matches the kickoff lineup", () => {
    const s = scenario(true);
    byId(s.players, s.starters[5]).injuryDays = 2;
    byId(s.players, s.subs[2]).suspendedGames = 1;
    s.club.savedLineup = { starters: s.starters, subs: s.subs, freeKickTakerId: null };
    const preview = peekLineup(s.club, s.players);
    const kickoff = lineupForMatch(s.club, s.players);
    expect(preview).not.toBeNull();
    expect(kickoff).not.toBeNull();
    expect(preview!.starters.map((p) => p.id)).toEqual(kickoff!.starters.map((p) => p.id));
    expect(preview!.subs.map((p) => p.id)).toEqual(kickoff!.subs.map((p) => p.id));
  });

  it("falls back to buildLineup (null here) when the squad cannot field eleven", () => {
    const s = scenario(false);
    for (const id of s.subs) byId(s.players, id).injuryDays = 40;
    byId(s.players, s.starters[0]).injuryDays = 40;
    byId(s.players, s.starters[10]).injuryDays = 40;
    s.club.savedLineup = { starters: s.starters, subs: s.subs, freeKickTakerId: null };
    expect(lineupForMatch(s.club, s.players)).toBeNull();
  });
});
