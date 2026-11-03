import { describe, it, expect } from "vitest";
import { createBridge } from "../src/runtime/bridge.js";
import { placardPose, createPlacards } from "../src/runtime/placard.js";
import type { DoorDef } from "../src/runtime/doors.js";

const DOOR: DoorDef = {
  id: "door",
  rooms: ["bedroom", "bathroom"],
  hinge_at: [1, 2],
  swing: null,
  width: 0.8,
  height: 2.0,
  open: false,
  closed_end: [1.8, 2],
  open_end: [1, 2.8],
};

describe("D4 placard", () => {
  it("bridge routes placard to its handler and ignores a non-book transition quietly", () => {
    const got: unknown[] = [];
    const warns: string[] = [];
    const infos: string[] = [];
    const b = createBridge(
      { door: () => null },
      { post: () => undefined, warn: (m) => warns.push(m), info: (m) => infos.push(m) },
      { placard: (e) => got.push(e) },
    );
    b.handle({ type: "placard", door: "door", text: "загрузка", id: "s1" });
    b.handle({ type: "placard", clear: true, door: "door" });
    b.handle({ type: "transition", via: "npc_walk", destination: "bathroom" });
    expect(got.length).toBe(2);
    expect(warns).toEqual([]);
    expect(infos.length).toBe(1);
  });

  it("pose: centred in the doorway, at eye-ish height, facing across the door line", () => {
    const p = placardPose(DOOR);
    expect(p.pos[0]).toBeCloseTo(1.4);
    expect(p.pos[2]).toBeCloseTo(2);
    expect(p.pos[1]).toBeGreaterThan(1);
    expect(p.pos[1]).toBeLessThan(2);
    // the plaque lies in the door plane: its normal is perpendicular to hinge -> closed_end
    expect(Math.abs(Math.cos(p.yaw) * 0.8)).toBeLessThan(1e-9 + 0.8);
  });

  it("set / clear / unknown door", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const warns: string[] = [];
    const pl = createPlacards({
      door: (id) => (id === "door" ? DOOR : undefined),
      add: (text, pose) => {
        added.push(`${text}@${pose.pos[0].toFixed(1)}`);
        return { remove: () => removed.push(text) };
      },
      warn: (m) => warns.push(m),
    });
    pl.handle({ type: "placard", door: "door", text: "загрузка" });
    expect(added).toEqual(["загрузка@1.4"]);
    expect(pl.active()).toEqual(["door"]);
    pl.handle({ type: "placard", door: "door", clear: true });
    expect(removed).toEqual(["загрузка"]);
    expect(pl.active()).toEqual([]);
    pl.handle({ type: "placard", door: "nope", text: "x" });
    expect(warns.length).toBe(1);
    pl.handle({ type: "placard", door: "door", text: "a" });
    pl.handle({ type: "placard", clear: true });
    expect(pl.active()).toEqual([]);
  });
});
