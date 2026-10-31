import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runCheck } from "../src/check.js";

const dir = new URL("../../specs/examples/", import.meta.url);
const load = (f: string): any => JSON.parse(readFileSync(new URL(f, dir), "utf-8"));

describe("P1 open rooms: height 0 must not read as a real ceiling", () => {
  it("B14 stair flight from an open room does not report STAIR_HEADROOM", () => {
    const raw = load("demo.scene.json");
    raw.rooms[1].open = true; // hall = stair.from.room
    const { report } = runCheck(raw);
    const e = report.errors.filter((i) => i.code === "STAIR_HEADROOM");
    expect(e).toEqual([]);
  });

  it("B15 decal on an open room's wall is not DECAL_OFF_WALL", () => {
    const raw = load("yard-house.scene.json");
    raw.assets.d_yard = { kind: "decal", prompt: "small framed picture" };
    raw.decals = [
      {
        asset: "d_yard",
        room: "yard",
        on: { room: "yard", edge: 2, t: 0.2 },
        y: 1.5,
        size: { w: 1, h: 1 },
      },
    ];
    const { report } = runCheck(raw);
    const e = report.errors.filter((i) => i.code === "DECAL_OFF_WALL");
    expect(e).toEqual([]);
  });
});
