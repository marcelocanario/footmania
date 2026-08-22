import { createRng } from "./src/game/rng";
import { makeClub, makeSquad } from "./tests/helpers";
import { createLiveMatchState, tickLiveMatch, simulateMatch } from "./src/game/match";
import { buildMatchFromState } from "./src/game/match";

const rng1 = createRng(99);
const rng2 = createRng(99);
function mkClub(ov:number){ const c= makeClub(ov); return c; }
const home = makeClub(75);
const away = makeClub(75);
const players1 = [...makeSquad(rng1, home, 30), ...makeSquad(rng1, away, 30, 30)];
const players2 = [...makeSquad(rng2, home, 30), ...makeSquad(rng2, away, 30, 30)];
// Note makeSquad uses rng state, but we passed separate rngs that diverge after first squad generation? Actually we need to clone home/away objects after? Let's just use same pattern as test: makeClub not using rng, makeSquad uses rng.

const instant = simulateMatch(rng1, home, away, players1, { competitionId: 1, fixtureId: 1 });
console.log("instant events", instant.match.events.length, instant.match.events);
console.log("instant firstHalfAdded", (instant.match as any).firstHalfAddedMinutes, instant.match.events.filter(e=>e.minute<=45).length);
console.log("instant scores", instant.match.homeScore, instant.match.awayScore);

const st = createLiveMatchState(rng2, home, away, players2, { matchId: 1, competitionId: 1, fixtureId: 1 });
let guard=0;
while (!st.ended && guard++ < 500) {
  tickLiveMatch(rng2, home, away, players2, st, 1, { ignoreHalfTime: true });
}
const match = buildMatchFromState(st, home, away, players2);
console.log("stream events", match.events.length, match.events);
console.log("stream scores", match.homeScore, match.awayScore);
console.log("st firstHalfAdded", st.firstHalfAddedMinutes, "secondAdded", st.secondHalfAddedMinutes);
console.log("instant vs stream identical?", instant.match.homeScore===match.homeScore && instant.match.awayScore===match.awayScore && instant.match.events.length===match.events.length);
if (instant.match.events.length !== match.events.length) {
  console.log("diff instant", instant.match.events.map(e=>`${e.minute}${e.addedTime?`+${e.addedTime}`:''} ${e.type} h${e.half}`));
  console.log("diff stream", match.events.map(e=>`${e.minute}${e.addedTime?`+${e.addedTime}`:''} ${e.type} h${e.half}`));
}
