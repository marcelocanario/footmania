import { createRng } from "./src/game/rng";
import { generatePlayer } from "./src/game/player";
import type { Club, Position } from "./src/game/types";
import { simulateMatch, createLiveMatchState, tickLiveMatch, buildMatchFromState } from "./src/game/match";

let clubIdCounter = 1;
function makeClub(overall: number, overrides: Partial<Club> = {}): Club {
  return {
    id: clubIdCounter++,
    name: "Test",
    shortName: "TST",
    ownerUserId: null,
    timezone: null,
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
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
    ...overrides,
  };
}
function makeSquad(rng: any, club: Club, count: number, offset = 0) {
  const players = [];
  const balanced: Position[] = [
    0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2,
    3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4,
  ];
  for (let i = 0; i < count; i++) {
    const p = generatePlayer(rng, club, { id: offset + i + 1, position: balanced[i % balanced.length] });
    players.push(p);
  }
  return players;
}
// Simulate prior tests that created 6 clubs
for (let i=0;i<6;i++) makeClub(75);
console.log("counter after 6 dummies", clubIdCounter);
const rng1 = createRng(99);
const rng2 = createRng(99);
const home = makeClub(75);
const away = makeClub(75);
console.log("home id", home.id, "away id", away.id);
const players1 = [...makeSquad(rng1, home, 30), ...makeSquad(rng1, away, 30, 30)];
const players2 = [...makeSquad(rng2, home, 30), ...makeSquad(rng2, away, 30, 30)];
const instant = simulateMatch(rng1, home, away, players1, { competitionId: 1, fixtureId: 1 });
const st = createLiveMatchState(rng2, home, away, players2, { matchId: 1, competitionId: 1, fixtureId: 1 });
let guard=0;
while (!st.ended && guard++ < 500) {
  tickLiveMatch(rng2, home, away, players2, st, 1, { ignoreHalfTime: true });
  if (guard % 20 === 0) console.log(`guard ${guard} clock ${st.matchClockSeconds} period ${st.period} first ${st.firstHalfAddedMinutes} second ${st.secondHalfAddedMinutes} ended ${st.ended} events ${st.events.length}`);
}
console.log("stream final", st.events.length, st.matchClockSeconds, st.firstHalfAddedMinutes, st.secondHalfAddedMinutes, st.ended, st.events.map(e=>`${e.minute}${(e as any).addedTime?`+${(e as any).addedTime}`:''}:${e.type}`));
console.log("instant", instant.match.events.length, instant.match.events.map(e=>`${e.minute}${(e as any).addedTime?`+${(e as any).addedTime}`:''}:${e.type}`));
console.log("equal?", st.events.length===instant.match.events.length);
