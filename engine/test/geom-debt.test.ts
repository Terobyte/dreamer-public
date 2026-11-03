import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runCheck } from "../src/check.js";

// engine geometry debt (LESSONS L96–L110, specs/tero-engine-phase2-debt.md Д2–Д17)

const demoUrl = new URL("../../specs/examples/demo.scene.json", import.meta.url);

function demo(): any {
  return JSON.parse(readFileSync(demoUrl, "utf-8"));
}

describe("geometry debt", () => {
  // the demo flight runs from z 11.6 down to z 6 at x 0.95..1.85; the three
  // old lanes sat at x 0.951, 1.4 and 1.849

  it("L102 a slot in to.room between the lanes stops the cut", () => {
    const raw = demo();
    // loft has a 0.35 m slot (x 1.0..1.35) from its far wall down to z 8:
    // no lane crosses it, but there is no slab over that strip of the tread
    raw.rooms[2].shape = [
      [-2, 4],
      [2, 4],
      [2, 10.5],
      [1.35, 10.5],
      [1.35, 8],
      [1.0, 8],
      [1.0, 10.5],
      [-2, 10.5],
    ];
    const { report } = runCheck(raw);
    const up = (report.passport as any).stairs[0];
    const zs = (up.cut as number[][]).map((p) => p[1]);
    expect(Math.min(...zs)).toBeCloseTo(6, 3);
    expect(Math.max(...zs)).toBeCloseTo(8, 3);
    const e = report.errors.find((i) => i.code === "STAIR_HEADROOM");
    expect(e).toBeDefined();
  });

  it("L102 a beam between the lanes is seen", () => {
    const raw = demo();
    // x 1.025..1.275: over the tread, clear of all three lanes
    raw.rooms[1].beams = [{ from: [1.15, 10.7], to: [1.15, 11.1], material: "wood", w: 0.25, h: 0.5 }];
    const { report } = runCheck(raw);
    expect(report.errors.find((i) => i.code === "STAIR_HEADROOM")).toBeDefined();
  });
});
