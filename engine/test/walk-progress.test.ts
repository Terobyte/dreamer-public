/** Squidward v37 149–152 s: follow_side on Squidward coming into the pineapple ran on the clock; he stopped at the
 *  table, the camera went on along its path and stood a metre off him, his dark body the frame. A walk move goes as
 *  far as the walker has gone along it, not as far as the clock says. */
import { describe, it, expect } from "vitest";
import { walkProgress } from "../src/runtime/stage/shotplan.js";

describe("walkProgress", () => {
  const p0: [number, number] = [0, 0];
  const delta: [number, number] = [3, 0]; // the camera path, the walker's planned path the same

  it("is the walked share of the path", () => {
    expect(walkProgress(p0, [1.5, 0.2], delta, 0)).toBeCloseTo(0.5, 6);
  });
  it("a walker who stopped short holds the camera where he is", () => {
    let u = 0;
    for (const x of [0.5, 1, 1.4, 1.4, 1.4]) u = walkProgress(p0, [x, 0], delta, u);
    expect(u).toBeCloseTo(1.4 / 3, 6);
  });
  it("never goes back, never past the end", () => {
    expect(walkProgress(p0, [0.5, 0], delta, 0.4)).toBeCloseTo(0.4, 6);
    expect(walkProgress(p0, [9, 0], delta, 0)).toBe(1);
    expect(walkProgress(p0, [-2, 0], delta, 0)).toBe(0);
  });
  it("a path of no length is done", () => {
    expect(walkProgress(p0, [1, 1], [0, 0], 0)).toBe(1);
  });
});
