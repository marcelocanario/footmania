import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const rows = await p.liveMatch.findMany({ take: 2 });
console.log(JSON.stringify(rows, null, 2));
await p.$disconnect();
