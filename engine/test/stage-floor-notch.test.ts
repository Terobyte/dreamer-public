import { describe, it, expect } from "vitest";
import { floorAt, type FloorRef } from "../src/runtime/stage/places.js";

describe("floorAt by outline", () => {
  const L: FloorRef = { room: "L", level: "L0", outline: [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]] };
  const notch: FloorRef = { room: "notch", level: "L0", outline: [[2, 2], [6, 2], [6, 6], [2, 6]] };

  it("a point in the notch picks the notch room, not the L-room whose bbox covers it", () => {
    expect(floorAt([L, notch], [5, 5], "L0")?.room).toBe("notch");
    expect(floorAt([L, notch], [5, 5])?.room).toBe("notch");
  });

  it("a point in the L-room still picks the L-room", () => {
    expect(floorAt([L, notch], [1, 5], "L0")?.room).toBe("L");
    expect(floorAt([L, notch], [5, 1])?.room).toBe("L");
  });

  it("a point on the outer wall line falls back to the bbox", () => {
    expect(floorAt([L], [0, 3])?.room).toBe("L");
  });
});
