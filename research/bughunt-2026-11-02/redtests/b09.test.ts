import { describe, expect, it } from "vitest";
import { Group, Vector3 } from "three";
import { fitGlb } from "./assets";

describe("fitGlb empty group (B09)", () => {
  it("positions empty group with finite Y inside box", () => {
    const g = new Group();
    const box = { min: new Vector3(0, 0, 0), max: new Vector3(1, 1, 1) };
    fitGlb(g, box);
    expect(Number.isFinite(g.position.y)).toBe(true);
    expect(g.position.y).toBeGreaterThanOrEqual(box.min.y);
    expect(g.position.y).toBeLessThanOrEqual(box.max.y);
  });
});
