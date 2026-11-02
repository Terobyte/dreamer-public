import { describe, expect, it } from "vitest";
import { parseShotplan, shotFrame } from "../../src/runtime/stage/shotplan.js";

const point = (fov?: number) => ({ pos: [0, 1, 2], look: [0, 1, 0], ...(fov === undefined ? {} : { fov }) });

describe("B65: an end FOV applies when the start FOV is omitted", () => {
  it("uses the requested end FOV; an explicit starting FOV is the passing control", () => {
    const makeFrame = (fromFov?: number) => {
      const warnings: string[] = [];
      const plan = parseShotplan({ shots: [{ name: "zoom", at: 0, to: 2, from: point(fromFov), end: point(30), ease: "lin" }] }, warnings)!;
      expect(warnings).toEqual([]);
      const active = { shot: plan.shots[0]!, index: 0, at: 10, to: null };
      return shotFrame(active, 12, () => null).fov;
    };

    expect(makeFrame(60)).toBe(30);
    expect(makeFrame()).toBe(30);
  });
});
