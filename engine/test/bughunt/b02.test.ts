import { describe, it, expect } from "vitest";
import { createToucher } from "../../src/runtime/stage/touch.js";
import { CELL, type NavLayer } from "../../src/nav/floor.js";
import type { StageLevel } from "../../src/runtime/stage/path.js";
import type { Place, V2 } from "../../src/runtime/stage/places.js";

const c = (i: number): number => (i + 0.5) * CELL;
function level(name: string, y: number, w: number, h: number): StageLevel {
  const bits = new Uint8Array(Math.ceil((w * h) / 8)).fill(0xff);
  return { layer: { level: name, y, origin: [0, 0], w, h } as unknown as NavLayer, bits, y };
}

describe("B02: a touch queued on a ramp keeps pose and finishYaw", () => {
  it("tick replays the queued touch with pose=sit and finishYaw=90", () => {
    const places: Place[] = [
      { name: "chair", id: "c", kind: "stand", room: "r", level: "L0", at: [c(10), c(10)], yaw: 0, look: null, obstacle: null, poses: ["sit"] },
    ];
    let y = 1.5; // between L0 (0) and L1 (3): on a ramp, no level
    const calls: Array<{ yaw: number; act: string }> = [];
    let p: V2 = [c(2), c(2)];
    const actor = {
      pos: (): V2 => p,
      y: () => y,
      go: (path: V2[], yaw: number, act: string) => {
        calls.push({ yaw, act });
        p = path[path.length - 1]!;
      },
    };
    const t = createToucher({
      places,
      claims: {},
      levels: [level("L0", 0, 20, 20), level("L1", 3, 20, 20)],
      ramps: [],
      doors: {},
      doorOpen: () => false,
      actor: (w) => (w === "Mama" ? (actor as any) : undefined),
    });
    expect(t.touch("Mama", "chair", "sit", 90)).toBe("queued");
    y = 0;
    expect(t.tick()).toEqual(["walk"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ yaw: 90, act: "sit" });
  });
});
