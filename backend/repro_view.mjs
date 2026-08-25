import { PrismaClient } from '@prisma/client';
import { liveStateView } from './src/services/liveView.ts';
import { loadGlobalWorld } from './src/services/saveService.ts';

const p = new PrismaClient();
const loaded = await loadGlobalWorld(p);
if(!loaded){ console.log('no world'); process.exit(0); }
console.log('loaded saveId', loaded.saveId);
const stRow = await p.liveMatch.findFirst({ where: { saveId: loaded.saveId }});
if(!stRow){ console.log('no live'); process.exit(0); }
const st = JSON.parse(stRow.stateJson);
console.log('st.homeTactics', st.homeTactics);
console.log('st.awayTactics', st.awayTactics);
const view = liveStateView(loaded.world, st, null);
console.log('view.homeFormation', view.homeFormation, 'id', view.homeFormationId);
console.log('view.awayFormation', view.awayFormation, 'id', view.awayFormationId);
console.log('view.homeOn sample', view.homeOn.slice(0,3).map(p=>`${p.name}:${p.tacPos}`));
await p.$disconnect();
