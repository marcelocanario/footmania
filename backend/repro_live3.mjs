import { PrismaClient } from '@prisma/client';
const p=new PrismaClient();
const sRow=await p.liveMatch.findFirst({where:{matchId:389,saveId:3}});
const s=JSON.parse(sRow.stateJson);
const playersAll=await p.player.findMany({where:{clubId:347}});
console.log('All Canario players:');
for(const pl of playersAll.sort((a,b)=>a.id-b.id)){
  console.log(`${pl.id} ${pl.name} tacPos${pl.tacPos} pos${pl.position} starter${pl.starter} overall${pl.overall} inj${pl.injuryDays} susp${pl.suspendedGames} energy${Math.round(pl.energy)}`);
}
console.log('homeOn tacPos', s.homeOn.map(id=>{const pl=playersAll.find(x=>x.id===id); return `${id}:${pl?.tacPos}`}).join(', '));
console.log('homeTactics', s.homeTactics);
console.log('awayTactics', s.awayTactics);
await p.$disconnect();
