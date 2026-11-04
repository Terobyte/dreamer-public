/** Squidward v33 profile: 89% of the page's CPU in the round room was insideInset under snapInside/legalCameraPoint —
 *  a 5 cm grid over the whole room (25k points x 48 edges) for every candidate every frame. The page fell to 10 fps and
 *  the recording doubled frames: the camera looked jerky. The nearest legal point is searched outward from the point,
 *  same grid, same answer. */
import { describe, it, expect } from "vitest";
import { insideInset, legalCameraPoint, roomRect, snapInside, type CameraLaw, type Rect, type V3 } from "../src/runtime/stage/camera.js";
import type { V2 } from "../src/runtime/stage/places.js";

const round = (r: number, n = 48, cx = 0, cz = 0): V2[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cz + r * Math.sin((2 * Math.PI * i) / n)] as V2);

/** the old full grid, as reference */
function bruteNearest(r: Rect, c: V2, ok: (q: V2) => boolean): V2 | null {
  let best: V2 | null = null;
  let bd = Infinity;
  for (let x = r.minx; x <= r.maxx + 1e-9; x += 0.05)
    for (let z = r.minz; z <= r.maxz + 1e-9; z += 0.05) {
      const d = (x - c[0]) ** 2 + (z - c[1]) ** 2;
      if (d < bd && ok([x, z])) {
        bd = d;
        best = [x, z];
      }
    }
  return best;
}

let seed = 7;
const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);

describe("nearest legal camera point", () => {
  const L = round(4.2);
  const rect = roomRect(L);

  it("snapInside gives the same point as the full grid", () => {
    for (let k = 0; k < 60; k++) {
      const p: V2 = [(rnd() - 0.5) * 11, (rnd() - 0.5) * 11];
      const want = insideInset(L, p) ? p : (bruteNearest(rect, p, (q) => insideInset(L, q)) ?? p);
      const got = snapInside(L, p, rect);
      const dw = (want[0] - p[0]) ** 2 + (want[1] - p[1]) ** 2;
      const dg = (got[0] - p[0]) ** 2 + (got[1] - p[1]) ** 2;
      expect(insideInset(L, got)).toBe(true);
      expect(dg).toBeCloseTo(dw, 9);
    }
  });

  it("legalCameraPoint on the required side gives the same distance as the full grid", () => {
    for (let k = 0; k < 40; k++) {
      const p: V3 = [(rnd() - 0.5) * 11, 1.5, (rnd() - 0.5) * 11];
      const side = { origin: [0, 0] as V2, normal: [Math.cos(k), Math.sin(k)] as V2, sign: 1 as const };
      const law: CameraLaw = { outline: L, rect, height: 2.7, side };
      const got = legalCameraPoint(p, law);
      const ok = (q: V2): boolean => insideInset(L, q) && (q[0] * side.normal[0] + q[1] * side.normal[1]) > 1e-6;
      expect(ok([got[0], got[2]])).toBe(true);
      const want = bruteNearest(rect, [Math.max(rect.minx, Math.min(rect.maxx, p[0])), Math.max(rect.minz, Math.min(rect.maxz, p[2]))], ok)!;
      const c: V2 = [Math.max(rect.minx, Math.min(rect.maxx, p[0])), Math.max(rect.minz, Math.min(rect.maxz, p[2]))];
      const dw = (want[0] - c[0]) ** 2 + (want[1] - c[1]) ** 2;
      const dg = (got[0] - c[0]) ** 2 + (got[2] - c[1]) ** 2;
      expect(dg).toBeLessThanOrEqual(dw + 1e-9);
    }
  });

  // timed against the full grid on the same machine (an absolute budget failed under the whole suite's load)
  it("a point just past the wall is snapped in at a fraction of the full grid's time", () => {
    const pts: V3[] = Array.from({ length: 200 }, (_, i) => [4.1 * Math.cos(i), 1.5, 4.1 * Math.sin(i)]);
    const law: CameraLaw = { outline: L, rect, height: 2.7 };
    legalCameraPoint(pts[0], law);
    let t0 = performance.now();
    for (const p of pts) legalCameraPoint(p, law);
    const fast = performance.now() - t0;
    t0 = performance.now();
    for (const p of pts) bruteNearest(rect, [p[0], p[2]], (q) => insideInset(L, q));
    const brute = performance.now() - t0;
    expect(fast).toBeLessThan(brute / 4);
  });
});
