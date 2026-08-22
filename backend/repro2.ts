import { createRng } from "./src/game/rng";
import { generatePlayer } from "./src/game/player";
import type { Club, Player, Position } from "./src/game/types";
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
  const players: Player[] = [];
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

const rng1 = createRng(99);
const rng2 = createRng(99);
const home = makeClub(75);
const away = makeClub(75);
const players1 = [...makeSquad(rng1, home, 30), ...makeSquad(rng1, away, 30, 30)];
const players2 = [...makeSquad(rng2, home, 30), ...makeSquad(rng2, away, 30, 30)];

console.log("players1 rng state after squad", rng1.state);
console.log("players2 rng state after squad", rng2.state);
console.log("rngs equal?", rng1.state===rng2.state && rng1.seed===rng2.seed);

const instant = simulateMatch(rng1, home, away, players1, { competitionId: 1, fixtureId: 1 });
console.log("instant events", instant.match.events.length);
console.log(instant.match.events.map(e=>`${e.minute}${(e as any).addedTime?`+${(e as any).addedTime}`:''}:${e.type} h${e.half}`).join(", "));
console.log("instant scores", instant.match.homeScore, instant.match.awayScore, "rng state", rng1.state);
console.log("instant firstHalfAdded", (instant.match as any).firstHalfAddedMinutes, "second", (instant.match as any).secondHalfAddedMinutes);

const st = createLiveMatchState(rng2, home, away, players2, { matchId: 1, competitionId: 1, fixtureId: 1 });
console.log("st after create coin toss", st.coinTossWinner, st.events[0], "rng2 state", rng2.state);
let guard=0;
while (!st.ended && guard++ < 500) {
  const res = tickLiveMatch(rng2, home, away, players2, st, 1, { ignoreHalfTime: true });
  //if (guard<5) console.log(`tick ${guard} clock ${st.matchClockSeconds} period ${st.period} added1 ${st.firstHalfAddedMinutes} added2 ${st.secondHalfAddedMinutes} events ${st.events.length}`);
}
const match = buildMatchFromState(st, home, away, players2);
console.log("stream events", match.events.length);
console.log(match.events.map(e=>`${e.minute}${(e as any).addedTime?`+${(e as any).addedTime}`:''}:${e.type} h${e.half}`).join(", "));
console.log("stream scores", match.homeScore, match.awayScore);
console.log("stream firstHalfAdded", st.firstHalfAddedMinutes, "second", st.secondHalfAddedMinutes);
console.log("equal?", instant.match.homeScore===match.homeScore && instant.match.awayScore===match.awayScore && instant.match.events.length===match.events.length);
if (instant.match.events.length !== match.events.length) {
  const instSet = new Set(instant.match.events.map(e=>`${e.minute}${(e as any).addedTime?`+${(e as any).addedTime}`:''}:${e.type}:${e.clubId}:${e.playerId}`));
  const streamSet = new Set(match.events.map(e=>`${e.minute}${(e as any).addedTime?`+${(e as any).addedTime}`:''}:${e.type}:${e.clubId}:${e.playerId}`));
  console.log("instant only", [...instSet].filter(x=>!streamSet.has(x)));
  console.log("stream only", [...streamSet].filter(x=>!instSet.has(x)));
}
