import { describe, expect, it } from "vitest";
import { generateWorld, createHumanClub } from "../src/game/worldgen";
import { initSeason, createFillerAI } from "../src/game/multiplayer";
import { createLiveMatchState } from "../src/game/match";
import { createRng } from "../src/game/rng";
import { liveStateView } from "../src/services/liveView";
import {
  clubKitsSchema,
  deserializeClubKits,
  deriveAiKits,
  deriveFallbackKits,
  kitDesignSchema,
  parseClubKits,
  resolveClubKits,
  serializeClubKits,
  type ClubKits,
} from "../src/game/kits";

const validKit = {
  primary: "#d40000",
  secondary: "#ffffff",
  accent: "#111111",
  numberColor: "#ffffff",
  pattern: "stripes",
};

describe("kit design validation", () => {
  it("accepts a valid three-kit set", () => {
    const kits: ClubKits = { home: validKit, away: validKit, gk: validKit };
    expect(clubKitsSchema.safeParse(kits).success).toBe(true);
  });

  it("rejects malformed hex colors", () => {
    expect(kitDesignSchema.safeParse({ ...validKit, primary: "red" }).success).toBe(false);
    expect(kitDesignSchema.safeParse({ ...validKit, primary: "#d4000" }).success).toBe(false);
    expect(kitDesignSchema.safeParse({ ...validKit, accent: "#d40000ff" }).success).toBe(false);
  });

  it("rejects unknown patterns", () => {
    expect(kitDesignSchema.safeParse({ ...validKit, pattern: "polka-dots" }).success).toBe(false);
  });

  it("does not persist squad numbers (preview-only concern)", () => {
    // A payload carrying a number must fail validation so numbers can never
    // leak into stored designs; the renderer owns preview numbers instead.
    expect(kitDesignSchema.safeParse({ ...validKit, number: 9 }).success).toBe(false);
  });
});

describe("AI kit derivation", () => {
  it("is deterministic per club id", () => {
    for (const id of [1, 7, 42, 999]) {
      expect(deriveAiKits(id)).toEqual(deriveAiKits(id));
    }
  });

  it("varies across clubs", () => {
    const sets = new Set(
      Array.from({ length: 40 }, (_, i) => JSON.stringify(deriveAiKits(i + 1))),
    );
    // With two palette draws plus a coin flip, collisions across 40 clubs are
    // vanishingly unlikely but not impossible; assert strong variety only.
    expect(sets.size).toBeGreaterThan(30);
  });

  it("assigns light and dark shells to home and away exactly once", () => {
    const lumaOf = (hex: string) => {
      const b = hex.replace("#", "");
      return Math.round(0.2126 * parseInt(b.slice(0, 2), 16) + 0.7152 * parseInt(b.slice(2, 4), 16) + 0.0722 * parseInt(b.slice(4, 6), 16));
    };
    for (let id = 1; id <= 60; id++) {
      const kits = deriveAiKits(id);
      const lh = lumaOf(kits.home.primary);
      const la = lumaOf(kits.away.primary);
      // One side must be meaningfully lighter than the other.
      expect(Math.abs(lh - la)).toBeGreaterThan(20);
    }
  });

  it("gives the goalkeeper a shell distinct from outfield kits", () => {
    for (let id = 1; id <= 40; id++) {
      const kits = deriveAiKits(id);
      expect(kits.gk.primary.toLowerCase()).not.toBe(kits.home.primary.toLowerCase());
      expect(kits.gk.primary.toLowerCase()).not.toBe(kits.away.primary.toLowerCase());
      expect(kitDesignSchema.safeParse(kits.gk).success).toBe(true);
    }
  });

  it("is stored on filler AI clubs with the identity columns mirroring the home shell", () => {
    const world = generateWorld(4242);
    initSeason(world, { year: 2026, month: 1 }, 1);
    createFillerAI(world, 1, 1);
    const fillers = world.clubs.filter((c) => !c.isHuman);
    expect(fillers.length).toBeGreaterThan(0);
    for (const filler of fillers) {
      expect(filler.kits).toEqual(deriveAiKits(filler.id));
      expect(filler.primaryColor).toBe(filler.kits!.home.primary);
      expect(filler.secondaryColor).toBe(filler.kits!.home.secondary);
    }
  });
});

describe("fallback and resolution", () => {
  it("derives a lighter away kit when the identity shell is dark", () => {
    const kits = deriveFallbackKits("#101010", "#eeeeee");
    const lumaOf = (hex: string) => getL(hex);
    expect(lumaOf(kits.away.primary)).toBeGreaterThan(lumaOf(kits.home.primary));
  });

  it("derives a darker away kit when the identity shell is light", () => {
    const kits = deriveFallbackKits("#eeeeee", "#101010");
    expect(getL(kits.away.primary)).toBeLessThan(getL(kits.home.primary));
  });

  it("prefers stored designs over the derived fallback", () => {
    const stored: ClubKits = { home: validKit, away: validKit, gk: validKit };
    const resolved = resolveClubKits({ kits: stored, primaryColor: "#000000", secondaryColor: "#ffffff" });
    expect(resolved).toBe(stored);
  });

  it("falls back to derived designs when kits are unset", () => {
    const resolved = resolveClubKits({ kits: null, primaryColor: "#123456", secondaryColor: "#ffffff" });
    expect(resolved.home.primary).toBe("#123456");
    expect(resolved.home.secondary).toBe("#ffffff");
  });
});

describe("kit persistence round-trip", () => {
  it("serializes and deserializes without loss", () => {
    const kits: ClubKits = {
      home: validKit,
      away: { ...validKit, pattern: "hoops" },
      gk: { ...validKit, pattern: "solid", primary: "#00ff00" },
    };
    const json = serializeClubKits(kits);
    expect(json).not.toBeNull();
    expect(deserializeClubKits(json)).toEqual(kits);
  });

  it("handles null and corrupt data safely", () => {
    expect(deserializeClubKits(null)).toBeNull();
    expect(deserializeClubKits("not json")).toBeNull();
    expect(deserializeClubKits(JSON.stringify({ home: { bad: true } }))).toBeNull();
    expect(parseClubKits(undefined)).toBeNull();
  });
});

describe("human club creation with kits", () => {
  it("stores explicit designs and mirrors the home shell into the identity columns", () => {
    const world = generateWorld(12345);
    const kits: ClubKits = {
      home: { ...validKit, primary: "#112233", secondary: "#ffffff" },
      away: { ...validKit, pattern: "solid" },
      gk: { ...validKit, pattern: "hoops" },
    };
    const club = createHumanClub(world, {
      userId: 1,
      clubName: "Test United",
      country: "BRA",
      timezone: null,
      kits,
      stadiumName: "Test Stadium",
      preferredHours: null,
    });
    expect(club.kits).toEqual(kits);
    expect(club.primaryColor).toBe("#112233");
    expect(club.secondaryColor).toBe("#ffffff");
  });

  it("keeps legacy color-only creation working", () => {
    const world = generateWorld(999);
    const club = createHumanClub(world, {
      userId: 2,
      clubName: "Old FC",
      country: "GER",
      timezone: null,
      primaryColor: "#aa0000",
      secondaryColor: "#ffffff",
      stadiumName: "Old Ground",
      preferredHours: null,
    });
    expect(club.kits).toBeNull();
    expect(club.primaryColor).toBe("#aa0000");
  });
});

describe("match-day kit usage (live view)", () => {
  it("sends home design for home, away design for away, and each side's GK design", () => {
    const world = generateWorld(2026);
    const storedKits: ClubKits = {
      home: { ...validKit, primary: "#112233", secondary: "#ffffff" },
      away: { ...validKit, pattern: "solid", primary: "#445566", secondary: "#ffffff" },
      gk: { ...validKit, pattern: "hoops", primary: "#ff8800", secondary: "#111111" },
    };
    const home = createHumanClub(world, { userId: 11, clubName: "Stored FC", country: "BRA", timezone: null, kits: storedKits, preferredHours: null });
    const away = createHumanClub(world, { userId: 12, clubName: "Derived FC", country: "BRA", timezone: null, preferredHours: null });
    const st = createLiveMatchState(createRng(7), home, away, world.players, { matchId: 1, fixtureId: 1, competitionId: 1 });

    const view = liveStateView(world, st);
    expect(view.homeKit).toEqual(storedKits.home);
    expect(view.homeGkKit).toEqual(storedKits.gk);
    // The away side wears its own away design, never the home design.
    const derivedAway = resolveClubKits(away).away;
    expect(view.awayKit).toEqual(derivedAway);
    expect(view.awayKit.primary).not.toBe(view.homeKit.primary);
    expect(view.awayGkKit).toEqual(resolveClubKits(away).gk);
  });
});

function getL(hex: string): number {
  const b = hex.replace(/^#/, "").padEnd(6, "0").slice(0, 6);
  return Math.round(0.2126 * parseInt(b.slice(0, 2), 16) + 0.7152 * parseInt(b.slice(2, 4), 16) + 0.0722 * parseInt(b.slice(4, 6), 16));
}
