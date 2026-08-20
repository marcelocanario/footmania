import { PrismaClient } from "@prisma/client";
import { ensureCurrentSeason } from "../src/services/mpService";

const prisma = new PrismaClient();

try {
  await ensureCurrentSeason(prisma);
} finally {
  await prisma.$disconnect();
}
