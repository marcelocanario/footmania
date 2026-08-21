import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/rng";
import { generatePlayer } from "../src/game/player";
import { dismissYouthPlayer, promoteYouthPlayer, promotedYouthSalary, processSeasonEndContracts, processSeasonalAcademyIntake, commitSeasonRollover } from "../src/game/season";
import { calculateBaseSalary } from "../src/game/economy";
import { makeClub, makeWorld } from "./helpers";

describe("youth academy", () => {
  it("promotes manually and pays 80% of the fair senior salary", () => {
    const club = makeClub();
    const rng = createRng(7);
    const youth = generatePlayer(rng, club, { isYouth: true, id: 1 });
    youth.age = 20;
    const world = makeWorld([club], [youth]);
    const fair = calculateBaseSalary(youth.overall, youth.age);

    expect(promoteYouthPlayer(world, youth).ok).toBe(true);
    expect(youth.isYouth).toBe(false);
    expect(youth.salary).toBe(promotedYouthSalary(youth));
    expect(youth.salary).toBe(Math.max(500, Math.round(fair * 0.8)));
    expect(world.news.at(-1)?.kind).toBe("academy");
  });

  it("ages youth every season and automatically promotes them at 21", () => {
    const club = makeClub();
    const youth = generatePlayer(createRng(9), club, { isYouth: true, id: 1 });
    youth.age = 20;
    const world = makeWorld([club], [youth]);

    processSeasonEndContracts(world.rng, world);
  processSeasonalAcademyIntake(world.rng, world);
  commitSeasonRollover(world);

    expect(youth.age).toBe(21);
    expect(youth.isYouth).toBe(false);
    expect(world.news.some((n) => n.text.includes("automatically promoted"))).toBe(true);
    expect(world.news.some((n) => n.kind === "academy")).toBe(true);
  });

  it("can release a youth player from the academy", () => {
    const club = makeClub();
    const youth = generatePlayer(createRng(11), club, { isYouth: true, id: 1 });
    const world = makeWorld([club], [youth]);

    expect(dismissYouthPlayer(world, youth).ok).toBe(true);
    expect(world.players).toHaveLength(0);
    expect(world.news.at(-1)?.text).toContain("released from the youth academy");
  });
});
