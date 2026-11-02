import { describe, it, expect } from "vitest";
import { touchTarget, type Door } from "../../src/runtime/doors.js";

function stubDoor(): Door {
  const def: any = { id: "d1", hinge_at: [0, 2], closed_end: [1, 2], open_end: [0, 3], height: 2.2, y0: 0, y1: 2.2 };
  return {
    def,
    open: () => {},
    close: () => {},
    lock: () => {},
    unlock: () => {},
    update: () => {},
    state: () => "closed",
    angle: () => 0,
    sweepDeg: () => 90,
    meshTurn: () => 0,
    blocks: () => true,
    segment: (): [[number, number], [number, number]] => [def.hinge_at, def.closed_end],
  } as unknown as Door;
}

describe("B07 NaN ray must not hit door", () => {
  it("NaN origin returns null", () => {
    expect(touchTarget([stubDoor()], [NaN, NaN], 0)).toBeNull();
  });
  it("NaN yaw returns null", () => {
    expect(touchTarget([stubDoor()], [0, 0], NaN)).toBeNull();
  });
});
