import { PrismaClient } from '@prisma/client';
import { liveStateView } from './src/services/liveView.ts';
import { loadWorld } from './src/services/saveService.ts';

const p = new PrismaClient();
const save = await p.save.findFirst({ where: { id: 3 }});
console.log('save id', save.id);
const world = await loadWorld(p, 3);
console.log('world clubs', world.world.clubs.filter(c=>[347,219].includes(c.id)).map(c=>({id:c.id,name:c.name,formation:c.tactics.formation})));
const stRow = await p.liveMatch.findFirst({ where: { saveId: 3, matchId: 389 }});
const st = JSON.parse(stRow.stateJson);
console.log('st.homeTactics.formation', st.homeTactics.formation, 'st.awayTactics.formation', st.awayTactics.formation);
console.log('st.homeXI', st.homeXI);
console.log('st.homeOn', st.homeOn);
// need to call liveStateView - it needs World and LiveMatchState
import { PrismaClient as PC } from '@prisma/client';
const view = liveStateView(world.world, st, null);
console.log('view.homeFormation', view.homeFormation, 'homeFormationId', view.homeFormationId);
console.log('view.awayFormation', view.awayFormation, 'awayFormationId', view.awayFormationId);
console.log('view.homeOn tacPos', view.homeOn.map(pl=>`${pl.name}:${pl.tacPos}`).join(', '));
await p.$disconnect();
