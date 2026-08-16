import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  Club,
  Competition,
  GroupStandings,
  LiveMatchState,
  Match,
  MatchStats,
  Player,
  StandingsRow,
  World,
} from "../game/types";
import { generateWorld } from "../game/worldgen";
import { createRng } from "../game/rng";

type Tx = Prisma.TransactionClient;

const TABLE_NAMES = [
  "matchEvent",
  "matchStat",
  "match",
  "standingsRow",
  "fixture",
  "competition",
  "player",
  "club",
  "newsItem",
  "ledgerEntry",
  "auctionBid",
  "auction",
  "trophy",
  "loan",
  "managerHistory",
  "seasonAward",
  "careerRecord",
  "clubTicketPrices",
  "stadiumUpgrade",
  "tvDeal",
  "liveMatch",
] as const;

function jsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Normalize a save written by the old single-column worldJson format. */
export function deserializeWorld(json: string): World {
  const world = JSON.parse(json) as World;
  world.seed ??= 0;
  world.year ??= 1;
  world.dayIndex ??= 0;
  world.dayOfWeek ??= ((world.dayIndex % 7) + 7) % 7;
  world.nextId ??= 1;
  world.clubs ??= [];
  world.players ??= [];
  world.competitions ??= [];
  world.fixtures ??= [];
  world.matches ??= [];
  world.news ??= [];
  world.auctions ??= [];
  world.loans ??= [];
  world.seasonAwards ??= [];
  world.records ??= [];
  world.managerHistory ??= [];
  world.ticketPrices ??= {};
  world.stadiumUpgrades ??= [];
  world.tvDeals ??= [];
  world.humanClubId ??= null;
  world.seasonSummary ??= null;
  world.contractWarnings ??= [];
  world.liveMatch ??= null;
  world.rng ??= createRng(world.seed);

  for (const club of world.clubs) {
    club.ledger ??= { income: [], expense: [] };
    club.trophies ??= {};
  }
  for (const player of world.players) {
    const legacy = player as Player & { suspended?: boolean };
    player.skillAcc ??= [0, 0, 0, 0, 0, 0, 0];
    player.suspendedGames ??= legacy.suspended ? 1 : 0;
    player.morale ??= 50;
    player.loanId ??= null;
  }
  for (const match of world.matches) {
    match.events ??= [];
    match.minuteEvents ??= [];
    match.stats.tackles ??= [0, 0];
    match.stats.wrongPasses ??= [0, 0];
    match.extraTime ??= false;
  }
  if (world.liveMatch) {
    world.liveMatch.compKind ??= "league";
    world.liveMatch.year ??= world.year;
    world.liveMatch.subbedIn ??= [[], []];
    world.liveMatch.possessionCounts ??= [0, 0];
    world.liveMatch.playerYellows ??= {};
    world.liveMatch.subSlots ??= { gn: [[-1, -1, -1], [-1, -1, -1]], gm: [[-1, -1, -1, -1], [-1, -1, -1, -1]] };
    world.liveMatch.suspensionClears ??= [];
    world.liveMatch.stats.tackles ??= [0, 0];
    world.liveMatch.stats.wrongPasses ??= [0, 0];
  }
  return world;
}

export async function createSaveRecord(
  prisma: PrismaClient,
  userId: number,
  name: string,
  seed?: number
): Promise<{ id: number; clubOptions: { id: number; name: string; shortName: string; primaryColor: string; secondaryColor: string; reputation: number; level: number; division: number }[] }> {
  const world = generateWorld(seed ?? Math.floor(Math.random() * 0x7fffffff));
  const save = await prisma.save.create({
    data: {
      userId,
      name,
      year: world.year,
      dayIndex: world.dayIndex,
      humanClubId: world.humanClubId,
      seed: world.seed,
      rngState: BigInt(world.rng.state),
    },
  });
  await persistWorld(prisma, save.id, userId, world);
  const options = world.clubs
    .filter((c) => c.division === 1)
    .map((c) => ({
      id: c.id,
      name: c.name,
      shortName: c.shortName,
      primaryColor: c.primaryColor,
      secondaryColor: c.secondaryColor,
      reputation: c.reputation,
      level: c.level,
      division: c.division,
    }));
  return { id: save.id, clubOptions: options };
}

export async function loadWorld(prisma: PrismaClient, saveId: number, userId: number): Promise<{ save: { id: number; name: string }; world: World } | null> {
  const save = await prisma.save.findFirst({ where: { id: saveId, userId } });
  if (!save) return null;
  const world = await rebuildWorld(prisma, save);
  // Old saves have no normalized rows yet. Keep them playable and let the
  // next write migrate them through persistWorld.
  const legacyWorldJson = (save as typeof save & { worldJson?: string | null }).worldJson;
  if (world.clubs.length === 0 && legacyWorldJson) {
    return { save: { id: save.id, name: save.name }, world: deserializeWorld(legacyWorldJson) };
  }
  return { save: { id: save.id, name: save.name }, world };
}

export async function persistWorld(
  prisma: PrismaClient,
  saveId: number,
  userId: number,
  world: World
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.save.updateMany({
      where: { id: saveId, userId },
      data: {
        year: world.year,
        dayIndex: world.dayIndex,
        humanClubId: world.humanClubId,
        seed: world.seed,
        rngState: BigInt(world.rng.state),
        seasonSummaryJson: world.seasonSummary ? JSON.stringify(world.seasonSummary) : null,
        pendingEventsJson: world.pendingDayEvents ? JSON.stringify(world.pendingDayEvents) : null,
        pendingMatchIdsJson: world.pendingDayMatchIds ? JSON.stringify(world.pendingDayMatchIds) : null,
      },
    });
    for (const t of TABLE_NAMES) {
      await (tx as unknown as Record<string, { deleteMany: (args: { where: { saveId: number } }) => Promise<unknown> }>)[t].deleteMany({ where: { saveId } });
    }
    if (world.clubs.length > 0) {
      await tx.club.createMany({ data: world.clubs.map((c) => clubRow(c, saveId)) });
    }
    if (world.players.length > 0) {
      await tx.player.createMany({ data: world.players.map((p) => playerRow(p, saveId)) });
    }
    if (world.loans.length > 0) {
      await tx.loan.createMany({ data: world.loans.map((l) => ({ id: l.id, saveId, playerId: l.playerId, fromClubId: l.fromClubId, toClubId: l.toClubId, startDay: l.startDay, endDay: l.endDay, recalled: l.recalled })) });
    }
    if (world.competitions.length > 0) {
      await tx.competition.createMany({ data: world.competitions.map((c) => competitionRow(c, saveId)) });
      const rows: { saveId: number; competitionId: number; clubId: number; played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number; points: number; groupName: string | null }[] = [];
      for (const comp of world.competitions) {
        for (const row of Object.values(comp.standings)) {
          rows.push({ saveId, competitionId: comp.id, clubId: row.clubId, played: row.played, wins: row.wins, draws: row.draws, losses: row.losses, goalsFor: row.goalsFor, goalsAgainst: row.goalsAgainst, points: row.points, groupName: null });
        }
        for (const g of comp.groupStandings) {
          for (const row of Object.values(g.rows)) {
            rows.push({ saveId, competitionId: comp.id, clubId: row.clubId, played: row.played, wins: row.wins, draws: row.draws, losses: row.losses, goalsFor: row.goalsFor, goalsAgainst: row.goalsAgainst, points: row.points, groupName: g.groupName });
          }
        }
      }
      await tx.standingsRow.createMany({ data: rows });
    }
    if (world.fixtures.length > 0) {
      await tx.fixture.createMany({ data: world.fixtures.map((f) => ({ id: f.id, saveId, competitionId: f.competitionId, round: f.round, homeClubId: f.homeClubId, awayClubId: f.awayClubId, dayIndex: f.dayIndex, played: f.played, leg: f.leg ?? null, tie: f.tie ?? null })) });
    }
    if (world.matches.length > 0) {
      await tx.match.createMany({ data: world.matches.map((m) => ({ id: m.id, saveId, fixtureId: m.fixtureId, competitionId: m.competitionId, homeClubId: m.homeClubId, awayClubId: m.awayClubId, homeScore: m.homeScore, awayScore: m.awayScore, penaltyWinnerId: m.penaltyWinnerId, penaltyScoreJson: m.penaltyScore ? JSON.stringify(m.penaltyScore) : null, attendance: m.attendance, gateRevenue: m.gateRevenue, extraTime: m.extraTime ?? false })) });
      await tx.matchStat.createMany({ data: world.matches.map((m) => statRow(m, saveId)) });
      const evRows: { saveId: number; matchId: number; minute: number; half: number; type: number; subtype: number; clubId: number; playerId: number | null; player2Id: number | null; goalType: number; ordinal: number }[] = [];
      for (const m of world.matches) {
        m.events.forEach((e, i) => {
          evRows.push({ saveId, matchId: m.id, minute: e.minute, half: e.half, type: e.type, subtype: e.subtype, clubId: e.clubId, playerId: e.playerId, player2Id: e.player2Id, goalType: e.goalType, ordinal: i });
        });
      }
      if (evRows.length > 0) await tx.matchEvent.createMany({ data: evRows });
    }
    if (world.news.length > 0) {
      await tx.newsItem.createMany({ data: world.news.map((n) => ({ saveId, dayIndex: n.dayIndex, text: n.text, kind: n.kind, clubId: n.clubId ?? null })) });
    }
    const ledgerRows: { saveId: number; clubId: number; direction: string; code: number; amount: number; day: number; label: string }[] = [];
    for (const club of world.clubs) {
      for (const e of club.ledger.income) ledgerRows.push({ saveId, clubId: club.id, direction: "income", code: e.code, amount: e.amount, day: e.day, label: e.label });
      for (const e of club.ledger.expense) ledgerRows.push({ saveId, clubId: club.id, direction: "expense", code: e.code, amount: e.amount, day: e.day, label: e.label });
    }
    if (ledgerRows.length > 0) await tx.ledgerEntry.createMany({ data: ledgerRows });
    if (world.auctions.length > 0) {
      await tx.auction.createMany({ data: world.auctions.map((a) => ({ id: a.id, saveId, playerId: a.playerId, minBid: a.minBid, deadlineDay: a.deadlineDay, sellerClubId: a.sellerClubId })) });
      const bidRows: { saveId: number; auctionId: number; clubId: number; amount: number }[] = [];
      for (const a of world.auctions) {
        for (const b of a.bids) bidRows.push({ saveId, auctionId: a.id, clubId: b.clubId, amount: b.amount });
      }
      if (bidRows.length > 0) await tx.auctionBid.createMany({ data: bidRows });
    }
    const trophyRows: { saveId: number; clubId: number; competitionName: string; count: number }[] = [];
    for (const club of world.clubs) {
      for (const [name, count] of Object.entries(club.trophies)) {
        trophyRows.push({ saveId, clubId: club.id, competitionName: name, count });
      }
    }
    if (trophyRows.length > 0) await tx.trophy.createMany({ data: trophyRows });
    if (world.managerHistory.length > 0) {
      await tx.managerHistory.createMany({ data: world.managerHistory.map((m) => ({ saveId, clubId: m.clubId, name: m.name, appointedDay: m.appointedDay, departedDay: m.departedDay, gamesInCharge: m.gamesInCharge, reason: m.reason })) });
    }
    if (world.seasonAwards.length > 0) {
      await tx.seasonAward.createMany({ data: world.seasonAwards.map((a) => ({ saveId, season: a.season, category: a.category, competitionId: a.competitionId, playerId: a.playerId, clubId: a.clubId, playerNameSnapshot: a.playerNameSnapshot, detail: a.detail })) });
    }
    if (world.records.length > 0) {
      await tx.careerRecord.createMany({ data: world.records.map((r) => ({ saveId, category: r.category, value: r.value, holderName: r.holderName })) });
    }
    if (Object.keys(world.ticketPrices).length > 0) {
      await tx.clubTicketPrices.createMany({ data: Object.entries(world.ticketPrices).map(([clubId, p]) => ({ saveId, clubId: Number(clubId), sector0: p[0], sector1: p[1], sector2: p[2], sector3: p[3] })) });
    }
    if (world.stadiumUpgrades.length > 0) {
      await tx.stadiumUpgrade.createMany({ data: world.stadiumUpgrades.map((u) => ({ saveId, clubId: u.clubId, startedDay: u.startedDay, completesDay: u.completesDay, newCapacity: u.newCapacity, cost: u.cost, completed: u.completed })) });
    }
    if (world.tvDeals.length > 0) {
      await tx.tvDeal.createMany({ data: world.tvDeals.map((d) => ({ saveId, clubId: d.clubId, season: d.season, baseAmount: d.baseAmount, positionBonus: d.positionBonus })) });
    }
    if (world.liveMatch) {
      await tx.liveMatch.create({ data: { saveId, stateJson: JSON.stringify(world.liveMatch) } });
    }
  });
}

function clubRow(c: Club, saveId: number) {
  return {
    id: c.id,
    saveId,
    name: c.name,
    shortName: c.shortName,
    stateCode: c.stateCode,
    division: c.division,
    reputation: c.reputation,
    level: c.level,
    cash: c.cash,
    loanBalance: c.loanBalance,
    stadiumName: c.stadiumName,
    stadiumCapacity: c.stadiumCapacity,
    primaryColor: c.primaryColor,
    secondaryColor: c.secondaryColor,
    coachName: c.coachName,
    boardConfidence: c.boardConfidence,
    fanConfidence: c.fanConfidence,
    isHuman: c.isHuman,
    captainId: c.captainId,
    penaltyTakerId: c.penaltyTakerId,
    tacticsFormation: c.tactics.formation,
    tacticsStyle: c.tactics.style,
    tacticsPressing: c.tactics.pressing,
    tacticsDirection: c.tactics.direction,
    savedLineupJson: c.savedLineup ? JSON.stringify(c.savedLineup) : null,
  };
}

function playerRow(p: Player, saveId: number) {
  return {
    id: p.id,
    saveId,
    clubId: p.clubId,
    name: p.name,
    country: p.country,
    age: p.age,
    position: p.position,
    side: p.side,
    overall: p.overall,
    potential: p.potential,
    tier: p.tier,
    characteristic1: p.characteristic1,
    characteristic2: p.characteristic2,
    energy: p.energy,
    salary: p.salary,
    value: p.value,
    releaseClause: p.releaseClause,
    injuryDays: p.injuryDays,
    contractDays: p.contractDays,
    isYouth: p.isYouth,
    isStar: p.isStar,
    worldClass: p.worldClass,
    starter: p.starter,
    growthAcc: p.growthAcc,
    potentialAcc: p.potentialAcc,
    careerGoals: p.careerGoals,
    careerAssists: p.careerAssists,
    seasonGoals: p.seasonGoals,
    seasonAssists: p.seasonAssists,
    yellows: p.yellows,
    reds: p.reds,
    tacPos: p.tacPos,
    onSale: p.onSale,
    salePrice: p.salePrice,
    suspendedGames: p.suspendedGames,
    morale: p.morale,
    loanId: p.loanId,
    skillGol: p.skills.gol,
    skillVel: p.skills.vel,
    skillTec: p.skills.tec,
    skillPas: p.skills.pas,
    skillDes: p.skills.des,
    skillArm: p.skills.arm,
    skillFin: p.skills.fin,
    skillAccJson: JSON.stringify(p.skillAcc),
  };
}

function competitionRow(c: Competition, saveId: number) {
  return {
    id: c.id,
    saveId,
    kind: c.kind,
    division: c.division,
    stateCode: c.stateCode,
    name: c.name,
    round: c.round,
    stage: c.stage,
    configJson: JSON.stringify(c.config),
    winnersJson: JSON.stringify(c.winners),
    knockoutsJson: JSON.stringify(c.knockouts),
    groupStandingsJson: JSON.stringify(c.groupStandings),
  };
}

function statRow(m: Match, saveId: number) {
  const s: MatchStats = m.stats;
  return {
    saveId,
    matchId: m.id,
    homePossession: s.possession[0],
    awayPossession: s.possession[1],
    homeShots: s.shots[0],
    awayShots: s.shots[1],
    homeOnGoal: s.onGoal[0],
    awayOnGoal: s.onGoal[1],
    homeOffTarget: s.offTarget[0],
    awayOffTarget: s.offTarget[1],
    homeFouls: s.fouls[0],
    awayFouls: s.fouls[1],
    homeCorners: s.corners[0],
    awayCorners: s.corners[1],
    homeYellows: s.yellows[0],
    awayYellows: s.yellows[1],
    homeReds: s.reds[0],
    awayReds: s.reds[1],
    homeTackles: s.tackles[0],
    awayTackles: s.tackles[1],
    homeWrongPasses: s.wrongPasses[0],
    awayWrongPasses: s.wrongPasses[1],
  };
}

async function rebuildWorld(
  prisma: PrismaClient,
  saveRow: { id: number; seed: number; year: number; dayIndex: number; humanClubId: number | null; rngState: bigint; worldJson?: string | null; seasonSummaryJson: string | null; pendingEventsJson: string | null; pendingMatchIdsJson: string | null }
): Promise<World> {
  const [
    clubRows,
    playerRows,
    loanRows,
    competitionRows,
    standingsRows,
    fixtureRows,
    matchRows,
    statRows,
    eventRows,
    newsRows,
    ledgerRows,
    auctionRows,
    bidRows,
    trophyRows,
    managerRows,
    awardRows,
    recordRows,
    ticketRows,
    upgradeRows,
    tvRows,
    liveRow,
  ] = await Promise.all([
    prisma.club.findMany({ where: { saveId: saveRow.id } }),
    prisma.player.findMany({ where: { saveId: saveRow.id } }),
    prisma.loan.findMany({ where: { saveId: saveRow.id } }),
    prisma.competition.findMany({ where: { saveId: saveRow.id } }),
    prisma.standingsRow.findMany({ where: { saveId: saveRow.id } }),
    prisma.fixture.findMany({ where: { saveId: saveRow.id } }),
    prisma.match.findMany({ where: { saveId: saveRow.id } }),
    prisma.matchStat.findMany({ where: { saveId: saveRow.id } }),
    prisma.matchEvent.findMany({ where: { saveId: saveRow.id }, orderBy: { ordinal: "asc" } }),
    prisma.newsItem.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
    prisma.ledgerEntry.findMany({ where: { saveId: saveRow.id } }),
    prisma.auction.findMany({ where: { saveId: saveRow.id } }),
    prisma.auctionBid.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
    prisma.trophy.findMany({ where: { saveId: saveRow.id } }),
    prisma.managerHistory.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
    prisma.seasonAward.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
    prisma.careerRecord.findMany({ where: { saveId: saveRow.id }, orderBy: { id: "asc" } }),
    prisma.clubTicketPrices.findMany({ where: { saveId: saveRow.id } }),
    prisma.stadiumUpgrade.findMany({ where: { saveId: saveRow.id } }),
    prisma.tvDeal.findMany({ where: { saveId: saveRow.id } }),
    prisma.liveMatch.findUnique({ where: { saveId: saveRow.id } }),
  ]);

  const clubs: Club[] = clubRows.map((r) => ({
    id: r.id,
    name: r.name,
    shortName: r.shortName,
    stateCode: r.stateCode,
    division: r.division,
    reputation: r.reputation,
    level: r.level,
    cash: r.cash,
    loanBalance: r.loanBalance,
    stadiumName: r.stadiumName,
    stadiumCapacity: r.stadiumCapacity,
    primaryColor: r.primaryColor,
    secondaryColor: r.secondaryColor,
    coachName: r.coachName,
    boardConfidence: r.boardConfidence,
    fanConfidence: r.fanConfidence,
    tactics: { formation: r.tacticsFormation, style: r.tacticsStyle, pressing: r.tacticsPressing, direction: r.tacticsDirection },
    captainId: r.captainId,
    penaltyTakerId: r.penaltyTakerId,
    savedLineup: jsonOr<Club["savedLineup"]>(r.savedLineupJson, null),
    isHuman: r.isHuman,
    ledger: { income: [], expense: [] },
    trophies: {},
  }));

  const players: Player[] = playerRows.map((r) => ({
    id: r.id,
    name: r.name,
    country: r.country,
    age: r.age,
    position: r.position as Player["position"],
    side: r.side,
    skills: { gol: r.skillGol, vel: r.skillVel, tec: r.skillTec, pas: r.skillPas, des: r.skillDes, arm: r.skillArm, fin: r.skillFin },
    overall: r.overall,
    potential: r.potential,
    tier: r.tier,
    characteristic1: r.characteristic1,
    characteristic2: r.characteristic2,
    energy: r.energy,
    salary: r.salary,
    value: r.value,
    releaseClause: r.releaseClause,
    injuryDays: r.injuryDays,
    contractDays: r.contractDays,
    isYouth: r.isYouth,
    isStar: r.isStar,
    worldClass: r.worldClass,
    starter: r.starter,
    growthAcc: r.growthAcc,
    potentialAcc: r.potentialAcc,
    skillAcc: jsonOr<number[]>(r.skillAccJson, [0, 0, 0, 0, 0, 0, 0]),
    careerGoals: r.careerGoals,
    careerAssists: r.careerAssists,
    seasonGoals: r.seasonGoals,
    seasonAssists: r.seasonAssists,
    yellows: r.yellows,
    reds: r.reds,
    clubId: r.clubId,
    tacPos: r.tacPos,
    onSale: r.onSale,
    salePrice: r.salePrice,
    suspendedGames: r.suspendedGames,
    morale: r.morale,
    loanId: r.loanId,
  }));

  const competitions: Competition[] = competitionRows.map((r) => ({
    id: r.id,
    kind: r.kind as Competition["kind"],
    division: r.division,
    stateCode: r.stateCode,
    name: r.name,
    round: r.round,
    stage: r.stage as Competition["stage"],
    config: jsonOr(r.configJson, { clubs: [], turns: 2, groups: [], bracket: [], promoted: 0, relegated: 0, groupQualifiers: 0 }),
    winners: jsonOr<number[]>(r.winnersJson, []),
    knockouts: jsonOr(r.knockoutsJson, []),
    groupStandings: jsonOr<GroupStandings[]>(r.groupStandingsJson, []),
    standings: {},
  }));

  for (const r of standingsRows) {
    const comp = competitions.find((c) => c.id === r.competitionId);
    if (!comp) continue;
    const row: StandingsRow = { clubId: r.clubId, played: r.played, wins: r.wins, draws: r.draws, losses: r.losses, goalsFor: r.goalsFor, goalsAgainst: r.goalsAgainst, points: r.points };
    if (r.groupName !== null && r.groupName !== undefined) {
      let g = comp.groupStandings.find((x) => x.groupName === r.groupName);
      if (!g) {
        g = { groupName: r.groupName, rows: {} };
        comp.groupStandings.push(g);
      }
      g.rows[r.clubId] = row;
    } else {
      comp.standings[r.clubId] = row;
    }
  }

  const fixtures = fixtureRows.map((f) => ({
    id: f.id,
    competitionId: f.competitionId,
    round: f.round,
    homeClubId: f.homeClubId,
    awayClubId: f.awayClubId,
    dayIndex: f.dayIndex,
    played: f.played,
    leg: f.leg ?? undefined,
    tie: f.tie ?? undefined,
  }));

  const statByMatch = new Map(statRows.map((s) => [s.matchId, s]));
  const eventsByMatch = new Map<number, Match["events"]>();
  for (const e of eventRows) {
    const list = eventsByMatch.get(e.matchId) ?? [];
    list.push({ minute: e.minute, half: e.half, type: e.type, subtype: e.subtype, clubId: e.clubId, playerId: e.playerId, player2Id: e.player2Id, goalType: e.goalType });
    eventsByMatch.set(e.matchId, list);
  }
  const matches: Match[] = matchRows.map((r) => {
    const s = statByMatch.get(r.id);
    return {
      id: r.id,
      fixtureId: r.fixtureId,
      competitionId: r.competitionId,
      homeClubId: r.homeClubId,
      awayClubId: r.awayClubId,
      homeScore: r.homeScore,
      awayScore: r.awayScore,
      penaltyWinnerId: r.penaltyWinnerId,
      penaltyScore: jsonOr<[number, number] | undefined>(r.penaltyScoreJson, undefined),
      attendance: r.attendance,
      gateRevenue: r.gateRevenue,
      events: eventsByMatch.get(r.id) ?? [],
      stats: s
        ? {
            possession: [s.homePossession, s.awayPossession],
            shots: [s.homeShots, s.awayShots],
            onGoal: [s.homeOnGoal, s.awayOnGoal],
            offTarget: [s.homeOffTarget, s.awayOffTarget],
            fouls: [s.homeFouls, s.awayFouls],
            corners: [s.homeCorners, s.awayCorners],
            yellows: [s.homeYellows, s.awayYellows],
            reds: [s.homeReds, s.awayReds],
            tackles: [s.homeTackles, s.awayTackles],
            wrongPasses: [s.homeWrongPasses, s.awayWrongPasses],
          }
        : { possession: [50, 50], shots: [0, 0], onGoal: [0, 0], offTarget: [0, 0], fouls: [0, 0], corners: [0, 0], yellows: [0, 0], reds: [0, 0], tackles: [0, 0], wrongPasses: [0, 0] },
      extraTime: r.extraTime,
      minuteEvents: [],
    };
  });

  for (const l of ledgerRows) {
    const club = clubs.find((c) => c.id === l.clubId);
    if (!club) continue;
    const entry = { code: l.code, amount: l.amount, day: l.day, label: l.label };
    if (l.direction === "income") club.ledger.income.push(entry);
    else club.ledger.expense.push(entry);
  }

  for (const t of trophyRows) {
    const club = clubs.find((c) => c.id === t.clubId);
    if (club) club.trophies[t.competitionName] = t.count;
  }

  const auctions = auctionRows.map((a) => ({
    id: a.id,
    playerId: a.playerId,
    minBid: a.minBid,
    deadlineDay: a.deadlineDay,
    sellerClubId: a.sellerClubId,
    bids: bidRows.filter((b) => b.auctionId === a.id).map((b) => ({ clubId: b.clubId, amount: b.amount })),
  }));

  const world: World = {
    seed: saveRow.seed,
    year: saveRow.year,
    dayIndex: saveRow.dayIndex,
    dayOfWeek: ((saveRow.dayIndex % 7) + 7) % 7,
    nextId: 1,
    clubs,
    players,
    competitions,
    fixtures,
    matches,
    news: newsRows.map((n) => ({ dayIndex: n.dayIndex, text: n.text, kind: n.kind, clubId: n.clubId ?? undefined })),
    auctions,
    loans: loanRows.map((l) => ({ id: l.id, playerId: l.playerId, fromClubId: l.fromClubId, toClubId: l.toClubId, startDay: l.startDay, endDay: l.endDay, recalled: l.recalled })),
    seasonAwards: awardRows.map((a) => ({ season: a.season, category: a.category, competitionId: a.competitionId, playerId: a.playerId, clubId: a.clubId, playerNameSnapshot: a.playerNameSnapshot, detail: a.detail })),
    records: recordRows.map((r) => ({ category: r.category, value: r.value, holderName: r.holderName })),
    managerHistory: managerRows.map((m) => ({ clubId: m.clubId, name: m.name, appointedDay: m.appointedDay, departedDay: m.departedDay, gamesInCharge: m.gamesInCharge, reason: m.reason })),
    ticketPrices: Object.fromEntries(ticketRows.map((t) => [t.clubId, [t.sector0, t.sector1, t.sector2, t.sector3]])),
    stadiumUpgrades: upgradeRows.map((u) => ({ clubId: u.clubId, startedDay: u.startedDay, completesDay: u.completesDay, newCapacity: u.newCapacity, cost: u.cost, completed: u.completed })),
    tvDeals: tvRows.map((d) => ({ clubId: d.clubId, season: d.season, baseAmount: d.baseAmount, positionBonus: d.positionBonus })),
    humanClubId: saveRow.humanClubId,
    seasonSummary: jsonOr(saveRow.seasonSummaryJson, null),
    rng: createRng(saveRow.seed),
    contractWarnings: [],
  };
  world.rng.state = Number(saveRow.rngState);
  world.nextId =
    Math.max(
      1,
      ...[...clubs.map((c) => c.id), ...players.map((p) => p.id), ...competitions.map((c) => c.id), ...fixtures.map((f) => f.id), ...matches.map((m) => m.id), ...auctions.map((a) => a.id), ...world.loans.map((l) => l.id)]
    ) + 1;
  world.liveMatch = liveRow ? jsonOr<LiveMatchState | null>(liveRow.stateJson, null) : null;
  world.pendingDayEvents = jsonOr<string[] | undefined>(saveRow.pendingEventsJson, undefined);
  world.pendingDayMatchIds = jsonOr<number[] | undefined>(saveRow.pendingMatchIdsJson, undefined);
  return world;
}
