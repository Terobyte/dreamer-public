/**
 * Sitting on a bed is sitting on its edge beside the sleeper, and a sleeper lies in the bed, not on the
 * blanket (Koshakan bedroom, Nov 2): Mama "sat" at `place.at`, outside the footboard, 1.4 m from Mirai, and
 * Mirai lay on top of the blanket like a toy on a made bed.
 */
import { describe, it, expect } from "vitest";
import { BED_EDGE_IN_M, BED_TUCK_M, bedSitSpot, resolveTouch, startSpot, type Place, type V2 } from "../src/runtime/stage/places.js";
import { createToucher } from "../src/runtime/stage/touch.js";
import { CELL } from "../src/nav/floor.js";

// the Koshakan bedroom bed as places.json has it: head at +Z, foot spot outside the footboard
const BED: Place = {
  name: "bed", id: "bed", kind: "sit", room: "bedroom", level: "L0", at: [-1.26, 1.22], yaw: 180, look: null,
  size: { w: 1.1, d: 2.05, h: 0.95 }, obstacle: [-1.8, 1.475, -0.7, 3.525], poses: ["lie", "sit"], top: 0.571,
  lie: { at: [-1.2079, 2.6334], yaw: 180, head: [-1.25, 3.525] }, slots: { lie: 1, sit: 2 },
};
const dist = (a: V2, b: V2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dirOf = (yaw: number): V2 => [Math.sin((yaw * Math.PI) / 180), Math.cos((yaw * Math.PI) / 180)];
const sit = (claims: Record<string, string>, who: string, at: V2, places = [BED]): any =>
  resolveTouch({ places, claims, actor: { who, at }, name: "bed", pose: "sit", warnings: [] });

describe("sitting on a bed: on the long edge beside the sleeper", () => {
  it("Mama's sit is on the bed's edge next to Mirai's spot, not outside the footboard", () => {
    const r = sit({}, "Mama", [-2.68, 2.65]);
    expect(r.act).toBe("sit");
    const [x, z] = r.target as V2;
    // on the bed, BED_EDGE_IN_M in from the long edge on the actor's side (left, x = -1.8)
    expect(x).toBeCloseTo(-1.8 + BED_EDGE_IN_M, 5);
    expect(z).toBeGreaterThan(1.475);
    expect(z).toBeLessThan(BED.lie!.at[1]);
    expect(dist(r.target, BED.lie!.at)).toBeLessThan(0.8);
  });

  it("she sits facing out of the bed, turned toward its head, and keeps that yaw whatever she looks at", () => {
    const r = sit({}, "Mama", [-2.68, 2.65]);
    const [fx, fz] = dirOf(r.yaw);
    expect(fx).toBeLessThan(0); // out of the left edge: the legs hang off the bed
    expect(fz).toBeGreaterThan(0); // turned toward the head (+Z), where the sleeper's face is
    expect(r.keepYaw).toBe(true);
  });

  it("the side nearer to the actor first; the second sitter gets the other side", () => {
    const claims = {};
    const a = sit(claims, "Mama", [0.5, 2.5]);
    expect(a.target[0]).toBeCloseTo(-0.7 - BED_EDGE_IN_M, 5);
    const b = sit(claims, "Papa", [0.5, 2.5]);
    expect(b.target[0]).toBeCloseTo(-1.8 + BED_EDGE_IN_M, 5);
  });

  it("a side whose floor is taken by another piece of furniture is not offered first", () => {
    const shelf: Place = { name: "shelf", id: "shelf", kind: "stand", room: "bedroom", level: "L0", at: [-2.4, 2.4], yaw: 90, look: null,
      obstacle: [-2.3, 1.6, -1.85, 2.8] };
    const r = sit({}, "Mama", [-2.68, 2.65], [BED, shelf]);
    expect(r.target[0]).toBeCloseTo(-0.7 - BED_EDGE_IN_M, 5);
  });

  it("a bed with no lie spot or no size keeps the old place spot", () => {
    const flat: Place = { ...BED, lie: undefined };
    expect(bedSitSpot(flat, [0, 0], [flat], 0)).toBeNull();
    expect(sit({}, "Mama", [0, 0], [flat]).target).toEqual(BED.at);
  });

  it("start with pose sit on a bed seats her on the same edge spot as a walk does", () => {
    const s = startSpot(BED, "sit", [-2.68, 2.65], [BED]);
    const w = sit({}, "Mama", [-2.68, 2.65]);
    expect(s.at).toEqual(w.target);
    expect(s.yaw).toBeCloseTo(w.yaw, 5);
    expect(s.y).toBe(0);
  });
});

describe("lying in a bed: under the blanket line", () => {
  it("lie sinks BED_TUCK_M below the top", () => {
    expect(BED_TUCK_M).toBeGreaterThan(0);
    expect(startSpot(BED, "lie").y).toBeCloseTo(0.571 - BED_TUCK_M, 5);
  });
});

describe("toucher: a bed sit ignores the look yaw", () => {
  it("goto bed sit look Mirai ends with the edge yaw, not the yaw from the foot spot to Mirai", () => {
    // the floor under the bed is not walkable: she walks to the edge over the floor, the last step sits her on it
    const N = Math.ceil(4 / CELL);
    const navLayer = { level: "L0", y: 0, origin: [-4, 0], w: N, h: N };
    const bits = new Uint8Array(Math.ceil((N * N) / 8)).fill(255);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = -4 + (i + 0.5) * CELL, z = (j + 0.5) * CELL;
      if (x >= -1.8 && x <= -0.7 && z >= 1.475 && z <= 3.525) bits[(j * N + i) >> 3]! &= ~(1 << ((j * N + i) & 7));
    }
    let got: { path: V2[]; yaw: number; act: string; ys?: number[] } | null = null;
    const actor = { pos: (): V2 => [-2.68, 2.65], y: () => 0, yaw: () => 0,
      go: (path: V2[], yaw: number, act: "idle" | "sit", ys?: number[]) => void (got = { path, yaw, act, ys }) };
    const t = createToucher({
      places: [BED], claims: {}, levels: [{ layer: navLayer as any, bits, y: 0 }], ramps: [], doors: {}, doorOpen: () => false,
      actor: () => actor,
    });
    const r = sit({}, "Mama", [-2.68, 2.65]);
    expect(t.touch("Mama", "bed", "sit", 0)).toBe("walk");
    expect(got!.act).toBe("sit");
    expect(got!.yaw).toBeCloseTo(r.yaw, 5);
    const last = got!.path[got!.path.length - 1]!;
    expect(last[0]).toBeCloseTo(r.target[0], 5);
    expect(last[1]).toBeCloseTo(r.target[1], 5);
    const before = got!.path[got!.path.length - 2]!;
    expect(before[0]).toBeLessThan(-1.8); // the step before is on the floor beside the bed
    if (got!.ys) expect(got!.ys.length).toBe(got!.path.length);
  });
});
