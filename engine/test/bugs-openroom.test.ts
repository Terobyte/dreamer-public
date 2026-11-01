import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runCheck } from "../src/check.js";
import { buildGeometry } from "../src/build/geometry.js";

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

  it("B14 beam over the flight in an open from-room still reports STAIR_HEADROOM", () => {
    const raw = load("demo.scene.json");
    raw.rooms[1].open = true; // hall = stair.from.room
    raw.rooms[1].beams = [{ from: [1.4, 10.7], to: [1.4, 11.1], material: "wood", w: 0.25, h: 0.5 }];
    const { report } = runCheck(raw);
    const e = report.errors.filter((i) => i.code === "STAIR_HEADROOM");
    expect(e.length).toBeGreaterThan(0);
  });

  it("B14 beam in an open destination room still reports STAIR_HEADROOM", () => {
    const raw = load("demo.scene.json");
    raw.rooms[2].open = true; // loft = stair.to.room
    raw.rooms[2].beams = [{ from: [1.4, 10], to: [1.4, 10.2], material: "wood", w: 0.25, h: 3.5 }];
    const { report } = runCheck(raw);
    const e = report.errors.filter((i) => i.code === "STAIR_HEADROOM");
    expect(e.length).toBeGreaterThan(0);
  });

  it("B15 decal on the shared wall of an open room is not DECAL_OFF_WALL", () => {
    const raw = load("yard-house.scene.json");
    raw.assets.d_yard = { kind: "decal", prompt: "small framed picture" };
    // yard edge 2 runs (10,0)->(-10,0); hall shares x in [-4,4], i.e.
    // t in [0.3,0.7] — the old t=0.2 pointed at (6,0), where no wall is built
    raw.decals = [
      {
        asset: "d_yard",
        room: "yard",
        on: { room: "yard", edge: 2, t: 0.5 },
        y: 1.5,
        size: { w: 1, h: 1 },
      },
    ];
    const { report } = runCheck(raw);
    const e = report.errors.filter((i) => i.code === "DECAL_OFF_WALL");
    expect(e).toEqual([]);
  });

  it("B15 decal outside the shared wall of an open room is DECAL_OFF_WALL", () => {
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
    expect(e.length).toBeGreaterThan(0);
  });

  it("F5 decal on a free-wall stretch of an open room uses the free wall height", () => {
    const raw = load("yard-house.scene.json");
    raw.assets.d_yard = { kind: "decal", prompt: "small framed picture" };
    // free wall covers x in [4,8] of yard edge 2, so t=0.2 -> (6,0) stands on
    // a built wall of height 3, not on open ground
    raw.walls = [{ level: "L0", from: [4, 0], to: [8, 0], h: 3, material: "white" }];
    raw.decals = [
      {
        asset: "d_yard",
        room: "yard",
        on: { room: "yard", edge: 2, t: 0.2 },
        y: 1.5,
        size: { w: 1, h: 1 },
      },
    ];
    const { ctx, report } = runCheck(raw);
    const e = report.errors.filter((i) => i.code === "DECAL_OFF_WALL");
    expect(e).toEqual([]);
    // mechanism guard: the backing height is the free wall's h, not 0
    const geo = (ctx as any).decals?.[0];
    expect(geo?.height).toBe(3);
  });

  it("B15 decal above the neighbouring closed wall is DECAL_OFF_WALL", () => {
    const raw = load("yard-house.scene.json");
    raw.assets.d_yard = { kind: "decal", prompt: "small framed picture" };
    raw.decals = [
      {
        asset: "d_yard",
        room: "yard",
        on: { room: "yard", edge: 2, t: 0.5 },
        y: 3.5,
        size: { w: 1, h: 1 },
      },
    ];
    const { report } = runCheck(raw);
    const e = report.errors.filter((i) => i.code === "DECAL_OFF_WALL");
    expect(e.length).toBeGreaterThan(0);
  });

  it("F3 stair check uses the built beam height in an open from-room", () => {
    const raw = load("demo.scene.json");
    raw.rooms[1].open = true; // hall = stair.from.room
    raw.rooms[1].beams = [{ from: [1.4, 10.7], to: [1.4, 11.1], material: "wood", w: 0.25, h: 0.5 }];
    const { ctx } = runCheck(raw);
    const g = (ctx as any).stairs?.[0];
    expect(g?.headroom, "beam must bind headroom").toBeDefined();
    const m = buildGeometry(ctx).meshes.find((x) => x.id === "hall:beam:0");
    expect(m, "mesh hall:beam:0").toBeDefined();
    let top = -Infinity;
    for (let i = 1; i < m!.positions.length; i += 3) top = Math.max(top, m!.positions[i]);
    const nose = (s: number): number => g.rise + s * (g.rise / g.going);
    // L0 y = 0, so the built top is the check's roomCeil straight away
    expect(g.headroom.min).toBeCloseTo(top - 0.5 - nose(g.headroom.s1), 6);
  });

  it("F3 stair check uses the built beam height in an open destination room", () => {
    const raw = load("demo.scene.json");
    raw.rooms[2].open = true; // loft = stair.to.room
    raw.rooms[2].beams = [{ from: [1.4, 10], to: [1.4, 10.2], material: "wood", w: 0.25, h: 3.5 }];
    const { ctx } = runCheck(raw);
    const g = (ctx as any).stairs?.[0];
    expect(g?.headroom, "beam must bind headroom").toBeDefined();
    const m = buildGeometry(ctx).meshes.find((x) => x.id === "loft:beam:0");
    expect(m, "mesh loft:beam:0").toBeDefined();
    let top = -Infinity;
    for (let i = 1; i < m!.positions.length; i += 3) top = Math.max(top, m!.positions[i]);
    const nose = (s: number): number => g.rise + s * (g.rise / g.going);
    // L0 y = 0, so the built top is the check's roomCeil straight away
    expect(g.headroom.min).toBeCloseTo(top - 3.5 - nose(g.headroom.s1), 6);
  });
});
