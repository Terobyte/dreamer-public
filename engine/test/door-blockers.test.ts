import { describe, it, expect } from "vitest";
import { runCheck } from "../src/check.js";
import { doorMeshes } from "../src/build/doors.js";
import { makeDoor, touchTarget, type DoorDef } from "../src/runtime/doors.js";
import { demoFlat } from "./helpers/scene.js";

const DEF: DoorDef = {
  id: "front",
  rooms: ["living", "yard"],
  hinge_at: [0.45, 4],
  swing: "living",
  width: 0.9,
  height: 2.1,
  open: false,
  closed_end: [-0.45, 4],
  open_end: [0.45, 3.1],
};

describe("blockers F12/F13", () => {
  it("F12 leaf decal UVs stay in 0..1 on both wide sides", () => {
    const ctx = runCheck(demoFlat()).ctx as any;
    const leaf = doorMeshes(ctx).find((m: any) => m.id === "front:leaf")!;
    expect(leaf).toBeDefined();
    const vs = leaf.uvs.filter((_: number, i: number) => i % 2 === 1);
    expect(Math.max(...vs)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.min(...vs)).toBeGreaterThanOrEqual(0 - 1e-9);
  });

  it("F13 touch misses when the gaze passes above the leaf", () => {
    const d = makeDoor(DEF);
    expect(touchTarget([d], [0, 3], 0)).toBe("front");
    expect(touchTarget([d], [0, 3], 0, 60)).toBe(null);
  });
});
