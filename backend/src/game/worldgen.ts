import type { Club, Player, World } from "../game/types";
import { createRng } from "../game/rng";
import { nextInt, pick } from "../game/rng";
import { generatePlayer } from "../game/player";
import { tacticsForClub } from "../game/club";
import { createLeagueFixtures, emptyStandingsRow } from "../game/league";
import { STARTING_CASH, TICKET_PRICES } from "../game/constants";
import { generateName } from "../game/names";
import { COUNTRIES, COUNTRY_BY_CODE, FEATURED_COUNTRIES } from "../game/countries";
import { gameConfig } from "../config";

const CITIES = [
  "London", "Manchester", "Liverpool", "Madrid", "Barcelona", "Seville", "Milan", "Rome",
  "Turin", "Munich", "Hamburg", "Berlin", "Paris", "Lyon", "Marseille", "Lisbon",
  "Porto", "Amsterdam", "Rotterdam", "Brussels", "Antwerp", "Vienna", "Salzburg", "Zurich",
  "Geneva", "Stockholm", "Oslo", "Copenhagen", "Helsinki", "Dublin", "Warsaw", "Krakow",
  "Prague", "Budapest", "Bucharest", "Belgrade", "Zagreb", "Athens", "Istanbul", "Moscow",
  "Saint Petersburg", "Kyiv", "Buenos Aires", "Rosario", "Montevideo", "Santiago", "Lima",
  "Asuncion", "Bogota", "Medellin", "Quito", "Caracas", "La Paz", "Mexico City", "Guadalajara",
  "Monterrey", "New York", "Los Angeles", "Chicago", "Miami", "Toronto", "Vancouver",
  "Montreal", "Tokyo", "Osaka", "Kyoto", "Seoul", "Shanghai", "Beijing", "Guangzhou",
  "Hong Kong", "Bangkok", "Kuala Lumpur", "Jakarta", "Singapore", "Mumbai", "Delhi",
  "Dubai", "Riyadh", "Tel Aviv", "Cairo", "Casablanca", "Tunis", "Algiers", "Lagos",
  "Accra", "Nairobi", "Johannesburg", "Cape Town", "Durban",
];

const CLUB_SUFFIXES = ["FC", "Athletic", "United", "Sport", "Club"];

const COLORS: [string, string][] = [
  ["#d40000", "#ffffff"], ["#003399", "#ffffff"], ["#008000", "#ffffff"], ["#ff6600", "#000000"],
  ["#660099", "#ffffff"], ["#000000", "#ffffff"], ["#0099cc", "#ffffff"], ["#cc9900", "#000000"],
  ["#006633", "#ffffff"], ["#990000", "#ffffff"], ["#333333", "#ffffff"], ["#663300", "#ffffff"],
];

function makeClubName(rng: ReturnType<typeof createRng>, used: Set<string>): { name: string; short: string; city: string } {
  let city = pick(rng, CITIES);
  let attempts = 0;
  let name = "";
  do {
    city = pick(rng, CITIES);
    const suffix = pick(rng, CLUB_SUFFIXES);
    name = `${city} ${suffix}`;
    attempts++;
  } while (used.has(name) && attempts < 50);
  used.add(name);
  return { name, short: name, city };
}

function pickCountry(rng: ReturnType<typeof createRng>): string {
  const featured = nextInt(rng, 100) < 70;
  const pool = featured ? FEATURED_COUNTRIES : COUNTRIES;
  let total = 0;
  for (const c of pool) total += c.strength - 10;
  let roll = nextInt(rng, Math.max(1, total));
  for (const c of pool) {
    roll -= c.strength - 10;
    if (roll < 0) return c.code;
  }
  return pool[0].code;
}

const LEVEL_POOL = [5, 10, 10, 15, 15, 15, 15, 20, 20, 20, 25];

function makeClub(
  rng: ReturnType<typeof createRng>,
  id: number,
  country: string,
  level: number,
  city: string,
  name: string,
  shortName: string
): Club {
  const capacity = Math.max(10000, Math.min(60000, (level / 5) * 11000 + nextInt(rng, 15000)));
  const [primary, secondary] = pick(rng, COLORS);
  return {
    id,
    name,
    shortName,
    country,
    level,
    cash: STARTING_CASH[Math.max(0, Math.min(4, Math.round(level / 5) - 1))],
    stadiumName: `${city} Stadium`,
    stadiumCapacity: capacity,
    primaryColor: primary,
    secondaryColor: secondary,
    coachName: generateName(rng, country),
    boardConfidence: 50,
    fanConfidence: 50,
    tactics: tacticsForClub(rng),
    trainingFocus: "assistant",
    captainId: null,
    penaltyTakerId: null,
    isHuman: false,
    ledger: { income: [], expense: [] },
    trophies: {},
  };
}

/** Generates a club's senior + youth squads and position top-ups. */
function populateClubPlayers(rng: ReturnType<typeof createRng>, world: World, club: Club) {
  const seniorCount = 25 + nextInt(rng, 6);
  const juniorCount = 8 + nextInt(rng, 5);
  for (let i = 0; i < seniorCount; i++) {
    const p = generatePlayer(rng, club, { id: world.nextId++, seed: world.seed });
    world.players.push(p);
  }
  for (let i = 0; i < juniorCount; i++) {
    const p = generatePlayer(rng, club, { isYouth: true, id: world.nextId++, seed: world.seed });
    world.players.push(p);
  }
  const squad = () => world.players.filter((p) => p.clubId === club.id);
  const byPos = (pos: number) => squad().filter((p) => p.position === pos);
  if (byPos(0).length === 0) {
    const p = generatePlayer(rng, club, { position: 0, id: world.nextId++, seed: world.seed });
    world.players.push(p);
  }
  if (byPos(2).length === 0) {
    const p = generatePlayer(rng, club, { position: 2, id: world.nextId++, seed: world.seed });
    world.players.push(p);
  }
  if (byPos(1).length === 0) {
    const p = generatePlayer(rng, club, { position: 1, id: world.nextId++, seed: world.seed });
    world.players.push(p);
  }
  const gks = byPos(0).sort((a, b) => b.overall - a.overall);
  if (gks.length > 0) club.captainId = gks[0].id;
  club.penaltyTakerId =
    byPos(4).sort((a, b) => b.overall - a.overall)[0]?.id ?? gks[0]?.id ?? null;
}

export function buildSeasonStructure(world: World) {
  const rng = world.rng;
  world.competitions = [];
  world.fixtures = [];
  world.matches = [];
  world.auctions = [];

  const clubIds = world.clubs.map((c) => c.id);
  const league = {
    id: world.nextId++,
    kind: "league" as const,
    name: "National League",
    round: 0,
    stage: "group" as const,
    config: {
      clubs: clubIds,
      turns: gameConfig.league.turns,
      groups: [],
      bracket: [],
      promoted: 0,
      relegated: 0,
      groupQualifiers: 0,
    },
    standings: Object.fromEntries(clubIds.map((c) => [c, emptyStandingsRow(c)])),
    groupStandings: [],
    winners: [],
    knockouts: [],
  };
  world.competitions.push(league);

  const leagueFixtures = createLeagueFixtures(rng, league.id, clubIds, gameConfig.league.startDay, gameConfig.league.matchIntervalDays);
  for (const f of leagueFixtures) f.id = world.nextId++;
  world.fixtures.push(...leagueFixtures);
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
    loans: [],
    seasonAwards: [],
    records: [],
    managerHistory: [],
    ticketPrices: {},
    stadiumUpgrades: [],
    tvDeals: [],
    humanClubId: null,
    seasonSummary: null,
    rng,
    contractWarnings: [],
  };

  const usedNames = new Set<string>();
  const clubs: Club[] = [];
  for (let i = 0; i < gameConfig.league.teams; i++) {
    const country = pickCountry(rng);
    const level = LEVEL_POOL[nextInt(rng, LEVEL_POOL.length)];
    const { name, short, city } = makeClubName(rng, usedNames);
    const club = makeClub(rng, world.nextId++, country, level, city, name, short);
    clubs.push(club);
  }
  world.clubs = clubs;
  for (const club of clubs) {
    const base = TICKET_PRICES[Math.min(5, Math.round(club.level / 5))].map((x) => Math.max(1, Math.round(x / 200))) as [number, number, number, number];
    world.ticketPrices[club.id] = base;
  }
  for (const club of clubs) {
    populateClubPlayers(rng, world, club);
  }

  buildSeasonStructure(world);
  return world;
}

/**
 * Turns the first AI club into the human's club: applies the chosen country,
 * regenerates its squad (names follow the country's pools) and optionally
 * renames it. Invalid country codes fall back to the club's generated country.
 */
export function assignHumanClub(world: World, country: string, name?: string): { ok: boolean; clubId: number; error?: string } {
  const club = world.clubs[0];
  if (!club) return { ok: false, clubId: -1, error: "No clubs available" };
  if (world.humanClubId !== null) return { ok: false, clubId: club.id, error: "Save already started" };
  const finalCountry = COUNTRY_BY_CODE[country] ? country : club.country;
  club.country = finalCountry;
  club.isHuman = true;
  world.humanClubId = club.id;
  if (name && name.trim().length > 0) {
    club.name = name.trim();
    club.shortName = name.trim();
  }
  world.players = world.players.filter((p) => p.clubId !== club.id);
  club.coachName = generateName(world.rng, club.country);
  populateClubPlayers(world.rng, world, club);
  world.news.push({ dayIndex: world.dayIndex, text: `You took charge of ${club.name}`, kind: "season" });
  return { ok: true, clubId: club.id };
}
