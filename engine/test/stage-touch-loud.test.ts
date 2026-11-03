/** Squidward v17 155 s: "SpongeBob goto living table" came to nothing and nobody said so (index.ts threw the touch's
 *  result away). A goto the actor cannot make is a stage warning the film writes out, naming who and where. */
import { describe, it, expect } from "vitest";
import { CELL, type NavLayer } from "../src/nav/floor.js";
import type { StageLevel } from "../src/runtime/stage/path.js";
import { createToucher } from "../src/runtime/stage/touch.js";
import type { Place, V2 } from "../src/runtime/stage/places.js";

const c = (i: number): number => (i + 0.5) * CELL;
const W = 20;
const bits = new Uint8Array(Math.ceil((W * W) / 8));
for (let n = 0; n < W * W; n++) if (n % W !== 10) bits[n >> 3] |= 1 << (n & 7); // column 10 is a wall
const L0: StageLevel = { layer: { level: "L0", y: 0, origin: [0, 0], w: W, h: W } as unknown as NavLayer, bits, y: 0 };
const PLACES: Place[] = [{ name: "window", id: "w", kind: "stand", room: "r", level: "L0", at: [c(14), c(4)], yaw: 0, look: null, obstacle: null }];

describe("a goto that cannot be made is said", () => {
  it("an unreachable place leaves a warning with the actor and the place", () => {
    const warnings: string[] = [];
    const A = { pos: (): V2 => [c(1), c(1)], y: () => 0, go: () => undefined, yaw: () => 0 };
    const t = createToucher({ places: PLACES, claims: {}, levels: [L0], ramps: [], doors: {}, doorOpen: () => false, actor: () => A, warnings });
    expect(t.touch("A", "window")).toBe("unreachable");
    expect(warnings.some((w) => w.includes("A") && w.includes("window"))).toBe(true);
  });

  it("stand_at whose near side is shut off goes to the far side (v17: the living table's near side was the armchair)", () => {
    const N = 60;
    const b2 = new Uint8Array(Math.ceil((N * N) / 8));
    for (let n = 0; n < N * N; n++) {
      const i = n % N, j = Math.floor(n / N);
      // a ring of wall round cell (10, 30): the near side's cell is floor, but nobody gets in
      const ring = i >= 6 && i <= 14 && j >= 26 && j <= 34 && (i === 6 || i === 14 || j === 26 || j === 34);
      if (!ring) b2[n >> 3] |= 1 << (n & 7);
    }
    const lv: StageLevel = { layer: { level: "L0", y: 0, origin: [0, 0], w: N, h: N } as unknown as NavLayer, bits: b2, y: 0 };
    // yaw 0: the sides are x ± SIDE_M (0.8 m = 20 cells): cells 10 (near the actor) and 50
    const table: Place = { name: "table", id: "t", kind: "stand", room: "r", level: "L0", at: [c(30), c(30)], yaw: 0, look: null, obstacle: null };
    const warnings: string[] = [];
    let went: V2 | null = null;
    const A = { pos: (): V2 => [c(2), c(30)], y: () => 0, go: (p: V2[]) => { went = p[p.length - 1]!; }, yaw: () => 0 };
    const t = createToucher({ places: [table], claims: {}, levels: [lv], ramps: [], doors: {}, doorOpen: () => false, actor: () => A, warnings });
    expect(t.touch("A", "table", "stand_at")).toBe("walk");
    expect(went![0]).toBeGreaterThan(c(30));
  });
});
