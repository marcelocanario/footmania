import { PrismaClient } from '@prisma/client';
const p=new PrismaClient();
const rows=await p.liveMatch.findMany();
console.log('count', rows.length);
for(const r of rows){
  const s=JSON.parse(r.stateJson);
  console.log(`saveId ${r.saveId} matchId ${r.matchId} home ${r.homeClubId} away ${r.awayClubId} minute ${s.minute} homeFormation ${s.homeTactics?.formation} awayFormation ${s.awayTactics?.formation} scores ${s.scores}`);
}
await p.$disconnect();
