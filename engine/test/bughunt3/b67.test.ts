import { describe, expect, it } from "vitest";
import { createShotClock, parseShotplan } from "../../src/runtime/stage/shotplan.js";

function activeName(shots: unknown[], now: number): string | null {
  const warnings: string[] = [];
  const plan = parseShotplan({ shots }, warnings)!;
  const clock = createShotClock(plan, warnings);
  clock.tick(100);
  return clock.active(now)?.shot.name ?? null;
}

const from = { pos: [0, 1, 2], look: [0, 1, 0] };

describe('B67: "prev" is based on the last playable shot', () => {
  it("does not anchor to an invalid, skipped predecessor; an unskipped predecessor is the control", () => {
    const control = [
      { name: "first", at: 0, to: 2, from },
      { name: "next", at: "prev", to: 5, from },
    ];
    expect(activeName(control, 101.5)).toBe("first");
    expect(activeName(control, 102.5)).toBe("next");

    const withSkipped = [
      { name: "first", at: 0, to: 2, from },
      { name: "empty", at: 2, to: 1, from },
      { name: "next", at: "prev", to: 5, from },
    ];
    expect(activeName(withSkipped, 101.5)).toBe("first");
  });
});
