import { describe, it, expect } from "vitest";
import { separate } from "../src/runtime/stage/separate.js";

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
let seed = 12345;
const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function worstGap(pos: Array<[number, number]>, r: number[], touch: Array<[number, number]> = []): number {
  const t = new Set(touch.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`));
  let worst = Infinity;
  for (let i = 0; i < pos.length; i++)
    for (let j = i + 1; j < pos.length; j++) {
      const min = r[i] + r[j] - (t.has(`${i}:${j}`) ? 0.15 : 0);
      worst = Math.min(worst, dist(pos[i], pos[j]) - min);
    }
  return worst;
}

describe("separate: convergence armor (Н9 review)", () => {
  it("random overlapping clusters of 3..6 with mixed radii all end separated", () => {
    for (let trial = 0; trial < 200; trial++) {
      const n = 3 + (trial % 4);
      const pos: Array<[number, number]> = Array.from({ length: n }, () => [rnd() * 0.5, rnd() * 0.5]);
      const r = Array.from({ length: n }, () => 0.2 + rnd() * 0.3);
      const out = separate(pos, r);
      expect(out.iterations).toBeLessThanOrEqual(50);
      expect(worstGap(out.pos, r)).toBeGreaterThanOrEqual(-1e-6);
    }
  });
  it("a line of 4 actors squeezed on a chain resolves", () => {
    const pos: Array<[number, number]> = [[0, 0], [0.1, 0], [0.2, 0], [0.3, 0]];
    const r = [0.4, 0.4, 0.4, 0.4];
    expect(worstGap(separate(pos, r).pos, r)).toBeGreaterThanOrEqual(-1e-6);
  });
  it("touch pairs may stay closer by 0.15 but no closer; others fully apart", () => {
    const pos: Array<[number, number]> = [[0, 0], [0.05, 0], [0, 0.05]];
    const r = [0.3, 0.3, 0.3];
    const touch: Array<[number, number]> = [[0, 1]];
    const out = separate(pos, r, { touch });
    expect(worstGap(out.pos, r, touch)).toBeGreaterThanOrEqual(-1e-6);
  });
  it("already separated actors are not moved", () => {
    const pos: Array<[number, number]> = [[0, 0], [3, 0], [0, 3]];
    const out = separate(pos, 0.3);
    expect(out.pos).toEqual(pos);
    expect(out.iterations).toBe(1);
  });
  it("does not mutate the input", () => {
    const pos: Array<[number, number]> = [[0, 0], [0.01, 0]];
    separate(pos, 0.3);
    expect(pos).toEqual([[0, 0], [0.01, 0]]);
  });
});
