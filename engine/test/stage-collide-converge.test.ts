import { describe, it, expect } from "vitest";
import { separate } from "../src/runtime/stage/separate.js";

const dist = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe("separate converges (Н9)", () => {
  it("dense group of 5 in a tight point: no pair violates r1+r2", () => {
    const pos: Array<[number, number]> = [
      [0, 0],
      [0.01, 0],
      [0, 0.01],
      [0.01, 0.01],
      [0.005, 0.005],
    ];
    const r = [0.2, 0.2, 0.2, 0.2, 0.2];
    const out = separate(pos, r);
    for (let i = 0; i < out.pos.length; i++) {
      for (let j = i + 1; j < out.pos.length; j++) {
        expect(dist(out.pos[i], out.pos[j])).toBeGreaterThanOrEqual(r[i] + r[j] - 1e-9);
      }
    }
  });
  it("iterations are bounded and the result is deterministic", () => {
    const pos: Array<[number, number]> = [
      [1, 1],
      [1.02, 1],
      [1, 1.02],
    ];
    const r = [0.2, 0.2, 0.2];
    const a = separate(pos, r);
    const b = separate(pos, r);
    expect(a.iterations).toBeLessThanOrEqual(50);
    expect(a.pos).toEqual(b.pos);
    expect(a.iterations).toBe(b.iterations);
  });
  it("dense group of 5 with r=1: converges within 50 iterations (F5)", () => {
    const pos: Array<[number, number]> = Array.from({ length: 5 }, () => [0, 0]);
    const r = [1, 1, 1, 1, 1];
    const out = separate(pos, r);
    expect(out.iterations).toBeLessThanOrEqual(50);
    for (let i = 0; i < out.pos.length; i++) {
      for (let j = i + 1; j < out.pos.length; j++) {
        expect(dist(out.pos[i], out.pos[j])).toBeGreaterThanOrEqual(2 - 1e-9);
      }
    }
    // Н9: детерминирован и при большом радиусе
    expect(separate(pos, r).pos).toEqual(out.pos);
  });
  it("maxIters above the standard cap still returns at most 50 (F9)", () => {
    const pos: Array<[number, number]> = Array.from({ length: 5 }, () => [0, 0]);
    const out = separate(pos, [1, 1, 1, 1, 1], { maxIters: 100 });
    expect(out.iterations).toBeLessThanOrEqual(50);
    expect(out.pos).toHaveLength(5);
  });
  it("F1 edge: non-finite maxIters and unrepresentable corrections still return bounded", () => {
    const out = separate(
      [[1e20, 1e20], [1e20, 1e20]],
      [1, 1],
      { maxIters: Infinity },
    );
    expect(out.iterations).toBeLessThanOrEqual(50);
    expect(out.pos).toHaveLength(2);
  });
});
