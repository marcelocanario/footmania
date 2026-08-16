import type { Club, Player, World } from "../game/types";
import { createRng } from "../game/rng";
import { nextInt, pick, shuffle } from "../game/rng";
import { generatePlayer } from "../game/player";
import { tacticsForClub } from "../game/club";
import { createLeagueFixtures, emptyStandingsRow } from "../game/league";
import { createCup, scheduleCupRound } from "../game/cup";
import { createStateChampionship, createStateGroupFixtures } from "../game/stateChampionship";
import { STARTING_CASH } from "../game/constants";
import { generateName } from "../game/names";
import { generateFreeAgents } from "../game/transfers";

const CITIES_SP = [
  "São Paulo", "Santos", "Campinas", "Guarulhos", "São Bernardo", "Santo André", "Osasco",
  "Ribeirão Preto", "Sorocaba", "Mauá", "Jundiaí", "Piracicaba", "Bauru", "Carapicuíba",
  "Itaquaquecetuba", "Franca", "São Vicente", "Praia Grande", "Guarujá", "Limeira",
  "Taubaté", "Suzano", "Barueri", "Embu", "Sumaré", "Taboão", "Marília", "São Carlos",
  "Presidente Prudente", "Araraquara", "Americana", "Rio Claro", "Itu", "Mogi das Cruzes",
  "Indaiatuba", "Cotia", "Bragança Paulista", "Salto", "Atibaia", "Águas de Lindóia",
  "Hortolândia", "Santa Bárbara", "Sertãozinho", "Ourinhos", "Assis", "Itapetininga",
  "Botucatu", "Araçatuba", "Lorena", "Pindamonhangaba",
];

const CITIES_OTHER = [
  "Belo Horizonte", "Rio de Janeiro", "Porto Alegre", "Curitiba", "Salvador", "Fortaleza",
  "Recife", "Goiânia", "Manaus", "Belém", "Florianópolis", "Vitória", "João Pessoa",
  "Natal", "Campo Grande", "Cuiabá", "Maceió", "Aracaju", "Teresina", "São Luís",
  "São José dos Campos", "Blumenau", "Caxias do Sul", "Pelotas", "Londrina", "Maringá",
  "Uberlândia", "Juiz de Fora", "Ribeirão das Neves",
];

const CLUB_SUFFIXES = ["FC", "Athletic", "United", "Sport", "Club"];

const COLORS: [string, string][] = [
  ["#d40000", "#ffffff"], ["#003399", "#ffffff"], ["#008000", "#ffffff"], ["#ff6600", "#000000"],
  ["#660099", "#ffffff"], ["#000000", "#ffffff"], ["#0099cc", "#ffffff"], ["#cc9900", "#000000"],
  ["#006633", "#ffffff"], ["#990000", "#ffffff"], ["#333333", "#ffffff"], ["#663300", "#ffffff"],
];

const STATE_DISTRIBUTION = [
  "SP", "SP", "SP", "SP", "SP", "SP", "SP", "SP", "SP", "SP", "SP", "SP", "SP", "SP",
  "MG", "MG", "RJ", "RJ", "RS", "PR", "BA", "CE", "PE", "GO", "SC", "DF",
];

const DIVISION_1_REP = [3, 3, 4, 4, 5, 3, 3, 4, 4, 3, 3, 4, 3, 3, 3, 4, 3, 3, 2, 3];
const DIVISION_2_REP = [2, 2, 3, 3, 2, 2, 3, 2, 2, 2, 3, 2, 2, 2, 3, 2, 2, 2, 3, 2];

function makeClubName(rng: ReturnType<typeof createRng>, cities: string[], used: Set<string>): { name: string; short: string; city: string } {
  let city = pick(rng, cities);
  let attempts = 0;
  let name = "";
  do {
    city = pick(rng, cities);
    const suffix = pick(rng, CLUB_SUFFIXES);
    name = `${city} ${suffix}`;
    attempts++;
  } while (used.has(name) && attempts < 50);
  used.add(name);
  return { name, short: name, city };
}

function makeClub(
  rng: ReturnType<typeof createRng>,
  id: number,
  division: number,
  reputation: number,
  city: string,
  stateCode: string,
  name: string,
  shortName: string
): Club {
  const level = Math.max(1, Math.min(25, reputation * 4 + nextInt(rng, 7) - (division - 1) * 2));
  const capacity = Math.max(10000, Math.min(60000, reputation * 11000 + nextInt(rng, 15000)));
  const [primary, secondary] = pick(rng, COLORS);
  return {
    id,
    name,
    shortName,
    stateCode,
    division,
    reputation,
    level,
    cash: STARTING_CASH[Math.min(4, division)][0],
    loanBalance: 0,
    stadiumName: `${city} Stadium`,
    stadiumCapacity: capacity,
    primaryColor: primary,
    secondaryColor: secondary,
    coachName: generateName(rng, "BRA"),
    boardConfidence: 50,
    fanConfidence: 50,
    tactics: tacticsForClub(rng),
    captainId: null,
    penaltyTakerId: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
}

export function buildSeasonStructure(world: World) {
  const rng = world.rng;
  world.competitions = [];
  world.fixtures = [];
  world.matches = [];
  world.auctions = [];

  const d1 = world.clubs.filter((c) => c.division === 1).map((c) => c.id);
  const d2 = world.clubs.filter((c) => c.division === 2).map((c) => c.id);

  const league1 = {
    id: world.nextId++,
    kind: "league" as const,
    division: 1,
    stateCode: "",
    name: "National League Division 1",
    round: 0,
    stage: "group" as const,
    config: {
      clubs: d1,
      turns: 2,
      groups: [],
      bracket: [],
      promoted: 4,
      relegated: 4,
      groupQualifiers: 0,
    },
    standings: Object.fromEntries(d1.map((c) => [c, emptyStandingsRow(c)])),
    groupStandings: [],
    winners: [],
    knockouts: [],
  };
  const league2 = {
    id: world.nextId++,
    kind: "league" as const,
    division: 2,
    stateCode: "",
    name: "National League Division 2",
    round: 0,
    stage: "group" as const,
    config: {
      clubs: d2,
      turns: 2,
      groups: [],
      bracket: [],
      promoted: 4,
      relegated: 0,
      groupQualifiers: 0,
    },
    standings: Object.fromEntries(d2.map((c) => [c, emptyStandingsRow(c)])),
    groupStandings: [],
    winners: [],
    knockouts: [],
  };
  world.competitions.push(league1, league2);

  const spClubs = world.clubs.filter((c) => c.stateCode === "SP");
  const stateTeams = shuffle(rng, spClubs)
    .slice(0, 16)
    .map((c) => c.id);
  const stateComp = createStateChampionship(rng, world.nextId++, "São Paulo State Championship", "SP", stateTeams);
  stateComp.config.knockoutDays = [28, 31, 42, 45, 56, 59];
  world.competitions.push(stateComp);

  const cupTeams = [...shuffle(rng, d1).slice(0, 12), ...shuffle(rng, d2).slice(0, 4)];
  const cup = createCup(rng, world.nextId++, "National Cup", cupTeams);
  cup.config.knockoutDays = [108, 111, 124, 127, 140, 143, 156, 159];
  world.competitions.push(cup);

  const stateGroupFixtures = createStateGroupFixtures(rng, stateComp, 7, 7);
  for (const f of stateGroupFixtures) f.id = world.nextId++;
  world.fixtures.push(...stateGroupFixtures);

  const league1Fixtures = createLeagueFixtures(rng, league1.id, d1, 105, 5);
  for (const f of league1Fixtures) f.id = world.nextId++;
  world.fixtures.push(...league1Fixtures);

  const league2Fixtures = createLeagueFixtures(rng, league2.id, d2, 105, 5);
  for (const f of league2Fixtures) f.id = world.nextId++;
  world.fixtures.push(...league2Fixtures);

  const cupRound0 = scheduleCupRound(rng, cup, 0, cup.config.knockoutDays[0], 3);
  for (const f of cupRound0) f.id = world.nextId++;
  world.fixtures.push(...cupRound0);
}

export function generateWorld(seed: number): World {
  const rng = createRng(seed);
  const world: World = {
    seed,
    year: 1,
    dayIndex: 0,
    dayOfWeek: 0,
    nextId: 1,
    clubs: [],
    players: [],
    competitions: [],
    fixtures: [],
    matches: [],
    news: [{ dayIndex: 0, text: "Welcome to Footmania! A new season is about to begin.", kind: "season" }],
    auctions: [],
    humanClubId: null,
    seasonSummary: null,
    rng,
    contractWarnings: [],
  };

  const usedNames = new Set<string>();
  const clubs: Club[] = [];
  for (let i = 0; i < 20; i++) {
    const state = STATE_DISTRIBUTION[i % STATE_DISTRIBUTION.length];
    const cities = state === "SP" ? CITIES_SP : CITIES_OTHER;
    const { name, short, city } = makeClubName(rng, cities, usedNames);
    const club = makeClub(rng, world.nextId++, 1, DIVISION_1_REP[i], city, state, name, short);
    clubs.push(club);
  }
  for (let i = 0; i < 20; i++) {
    const state = STATE_DISTRIBUTION[(i + 8) % STATE_DISTRIBUTION.length];
    const cities = state === "SP" ? CITIES_SP : CITIES_OTHER;
    const { name, short, city } = makeClubName(rng, cities, usedNames);
    const club = makeClub(rng, world.nextId++, 2, DIVISION_2_REP[i], city, state, name, short);
    clubs.push(club);
  }
  const spClubs = clubs.filter((c) => c.stateCode === "SP");
  const stateClubs = spClubs.slice(0, 12);
  const extraClubs: Club[] = [];
  for (let i = 0; i < 12; i++) {
    const { name, short, city } = makeClubName(rng, CITIES_SP, usedNames);
    const club = makeClub(rng, world.nextId++, 3, 1 + nextInt(rng, 3), city, "SP", name, short);
    extraClubs.push(club);
    clubs.push(club);
  }
  world.clubs = clubs;

  const statePool = [...stateClubs, ...extraClubs];
  for (const club of clubs) {
    const isStateOnly = club.division >= 3;
    const seniorCount = isStateOnly ? 18 + nextInt(rng, 4) : 25 + nextInt(rng, 6);
    const juniorCount = isStateOnly ? 6 + nextInt(rng, 3) : 8 + nextInt(rng, 5);
    for (let i = 0; i < seniorCount; i++) {
      const p = generatePlayer(rng, club, { id: world.nextId++ });
      world.players.push(p);
    }
    for (let i = 0; i < juniorCount; i++) {
      const p = generatePlayer(rng, club, { isYouth: true, id: world.nextId++ });
      world.players.push(p);
    }
    const gkCount = world.players.filter((p) => p.clubId === club.id && p.position === 0).length;
    if (gkCount === 0) {
      const p = generatePlayer(rng, club, { position: 0, id: world.nextId++ });
      world.players.push(p);
    }
    const cbs = world.players.filter((p) => p.clubId === club.id && p.position === 2).length;
    if (cbs === 0) {
      const p = generatePlayer(rng, club, { position: 2, id: world.nextId++ });
      world.players.push(p);
    }
    const fbs = world.players.filter((p) => p.clubId === club.id && p.position === 1).length;
    if (fbs === 0) {
      const p = generatePlayer(rng, club, { position: 1, id: world.nextId++ });
      world.players.push(p);
    }
    const gk = world.players.find((p) => p.clubId === club.id && p.position === 0 && p.overall >= 60);
    if (gk) club.penaltyTakerId = gk.id;
    const gks = world.players.filter((p) => p.clubId === club.id && p.position === 0).sort((a, b) => b.overall - a.overall);
    if (gks.length > 0) club.captainId = gks[0].id;
    club.penaltyTakerId = world.players
      .filter((p) => p.clubId === club.id && p.position === 4)
      .sort((a, b) => b.overall - a.overall)[0]?.id ?? gks[0]?.id ?? null;
  }

  buildSeasonStructure(world);
  generateFreeAgents(rng, world, 15);
  return world;
}
