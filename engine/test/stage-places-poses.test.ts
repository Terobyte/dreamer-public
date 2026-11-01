import { describe, it, expect } from "vitest";
import { resolveTouch, SIDE_M, type Place } from "../src/runtime/stage/places.js";

const BED: Place = {
  name: "bed", id: "room_bed", kind: "sit", room: "room", level: "L0", at: [2, 2], yaw: 0, look: null, obstacle: null,
  poses: ["lie", "sit"], top: 0.6, slots: { lie: 1, sit: 2 },
};
const SINK: Place = {
  name: "sink", id: "room_sink", kind: "stand", room: "room", level: "L0", at: [5, 1], yaw: 0, look: [5, 0], obstacle: null,
  poses: ["stand_at"],
};
const DOOR: Place = {
  name: "room door", id: "door1", kind: "door", room: "room", level: "L0", at: [1, 0], yaw: 0, look: [1, 1], obstacle: null,
  poses: ["door"],
};
const go = (claims: Record<string, string>, who: string, name: string, pose: string, warnings: string[], places = [BED, SINK]): any =>
  resolveTouch({ places, claims, actor: { who, at: [0, 0] }, name, pose, warnings });

describe("stage places: poses", () => {
  it("second lie on the same bed: stand_at beside with a warning; sit on the same bed still works", () => {
    const claims = {}; const w: string[] = [];
    expect(go(claims, "Mirai", "bed", "lie", w).pose).toBe("lie");
    const sit = go(claims, "Mama", "bed", "sit", w);
    expect(sit.pose).toBe("sit");
    expect(sit.act).toBe("sit");
    expect(sit.target).toEqual(BED.at);
    const lie2 = go(claims, "Papa", "bed", "lie", w);
    expect(lie2.pose).toBe("stand_at");
    expect(Math.hypot(lie2.target[0] - 2, lie2.target[1] - 2)).toBeCloseTo(SIDE_M, 5);
    expect(w.some((x) => x.includes("Papa"))).toBe(true);
  });
  it("a pose the place does not have -> stand_at and a warning", () => {
    const w: string[] = [];
    const r = go({}, "Mirai", "sink", "lie", w);
    expect(r.pose).toBe("stand_at");
    expect(w).toHaveLength(1);
  });
  it("all slots of a pose taken, third asks -> stand_at, warning names the actor", () => {
    const claims = {}; const w: string[] = [];
    go(claims, "A", "bed", "sit", w);
    go(claims, "B", "bed", "sit", w);
    const r = go(claims, "C", "bed", "sit", w);
    expect(r.pose).toBe("stand_at");
    expect(w.some((x) => x.includes("C"))).toBe(true);
  });
  it("explicit stand_at has no limit: beside, no booking, no warning", () => {    const claims: Record<string, string> = {}; const w: string[] = [];
    const r1 = go(claims, "Mirai", "sink", "stand_at", w);
    expect(r1.pose).toBe("stand_at");
    expect(Math.hypot(r1.target[0] - 5, r1.target[1] - 1)).toBeCloseTo(SIDE_M, 5);
    const r2 = go(claims, "Mama", "sink", "stand_at", w);
    expect(r2.pose).toBe("stand_at");
    expect(claims).toEqual({});
    expect(w).toHaveLength(0);
  });
  it("door pose on a non-door place falls back to stand_at with a warning", () => {
    const w: string[] = [];
    const r: any = go({}, "Mirai", "bed", "door", w);
    expect(r.pose).toBe("stand_at");
    expect(w.some((x) => x.includes("Mirai"))).toBe(true);
  });
  it("door pose has no limit: beside, no booking, no warning", () => {
    const claims: Record<string, string> = {}; const w: string[] = [];
    const places = [DOOR];
    const r1: any = resolveTouch({ places, claims, actor: { who: "Mirai", at: [0, 0] }, name: "room door", pose: "door", warnings: w });
    expect(r1.pose).toBe("door");
    expect(Math.hypot(r1.target[0] - 1, r1.target[1] - 0)).toBeCloseTo(SIDE_M, 5);
    const r2: any = resolveTouch({ places, claims, actor: { who: "Mama", at: [0, 0] }, name: "room door", pose: "door", warnings: w });
    expect(r2.pose).toBe("door");
    expect(claims).toEqual({});
    expect(w).toHaveLength(0);
  });
});
