import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const clubs = await p.club.findMany({ where: { id: { in: [347, 219] } }, select: { id: true, name: true, tacticsFormation: true, tacticsStyle: true, tacticsPressing: true, tacticsDirection: true } });
console.log(clubs);
const live = await p.liveMatch.findFirst({ where: { matchId: 389, saveId: 3 } });
const s = JSON.parse(live.stateJson);
console.log('state homeTactics formation', s.homeTactics.formation, 'away', s.awayTactics.formation);
console.log('homeOn', s.homeOn);
console.log('awayOn', s.awayOn);
const playersAll = await p.player.findMany({ where: { clubId: { in: [347,219] } } });
const onPlayers = playersAll.filter(pl=> s.homeOn.includes(pl.id) || s.awayOn.includes(pl.id));
for(const pl of onPlayers){
  console.log(`${pl.id} ${pl.name} club${pl.clubId} tacPos${pl.tacPos} pos${pl.position} starter${pl.starter} overall${pl.overall}`);
}
await p.$disconnect();
