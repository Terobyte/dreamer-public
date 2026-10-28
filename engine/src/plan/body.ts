import { Clipper, JoinType, EndType, FillRule } from "clipper2-ts";
import type { Path64 } from "clipper2-ts";
import type { Interval } from "./merge.js";

export type { Path64 };

type V2 = [number, number];

function key(p: V2): string {
  return `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
}

function toPath(pts: V2[]): Path64 {
  return pts.map(([x, z]) => ({ x: Math.round(x * 1000), y: Math.round(z * 1000) }));
}

// Discretize an arc interval into a polyline of segments no longer than 0.25 m,
// walking the shorter sweep from `from` to `to` around the center (full circle if from == to).
function discretizeArcInterval(iv: Interval): V2[] {
  const c = iv.arc!.c;
  const r = iv.arc!.r;
  const full = Math.hypot(iv.from[0] - iv.to[0], iv.from[1] - iv.to[1]) < 1e-6;
  const a0 = Math.atan2(iv.from[0] - c[0], iv.from[1] - c[1]);
  let sweep: number;
  // The authored sweep (carried from the bulge) is the only thing that says
  // which side a half-turn or major arc bows to; endpoints alone are ambiguous.
  if (typeof iv.arc!.sweep === "number") {
    sweep = iv.arc!.sweep;
  } else if (full) {
    sweep = 2 * Math.PI;
  } else {
    const a1 = Math.atan2(iv.to[0] - c[0], iv.to[1] - c[1]);
    sweep = a1 - a0;
    // Keep sweep in (-PI, PI]: a strict lower bound preserves the authored
    // rotation direction for an exact half-turn (sweep === -PI) instead of
    // flipping it to the opposite semicircle.
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
  }
  const total = Math.abs(r * sweep);
  const n = Math.max(1, Math.ceil(total / 0.25));
  const pts: V2[] = [];
  for (let k = 0; k <= n; k++) {
    const ang = a0 + (sweep * k) / n;
    pts.push([c[0] + r * Math.sin(ang), c[1] + r * Math.cos(ang)]);
  }
  pts[0] = [iv.from[0], iv.from[1]];
  if (!full) pts[pts.length - 1] = [iv.to[0], iv.to[1]];
  return pts;
}

interface Seg {
  from: V2;
  to: V2;
  thickness: number;
}

function buildSegs(intervals: Interval[]): Seg[] {
  const segs: Seg[] = [];
  for (const iv of intervals) {
    if (iv.arc) {
      const pts = discretizeArcInterval(iv);
      for (let k = 0; k + 1 < pts.length; k++) {
        segs.push({ from: pts[k], to: pts[k + 1], thickness: iv.thickness });
      }
    } else {
      segs.push({ from: [iv.from[0], iv.from[1]], to: [iv.to[0], iv.to[1]], thickness: iv.thickness });
    }
  }
  return segs;
}

export function wallBody(intervals: Interval[]): Path64[] {
  const segs = buildSegs(intervals);
  if (segs.length === 0) return [];

  const adj = new Map<string, number[]>();
  const ptOf = new Map<string, V2>();
  const addAdj = (p: V2, idx: number): void => {
    const k = key(p);
    if (!ptOf.has(k)) ptOf.set(k, p);
    const list = adj.get(k) ?? [];
    if (!list.includes(idx)) list.push(idx);
    adj.set(k, list);
  };
  segs.forEach((s, idx) => {
    addAdj(s.from, idx);
    addAdj(s.to, idx);
  });

  const otherEnd = (idx: number, atKey: string): V2 | null => {
    const s = segs[idx];
    if (key(s.from) === atKey) return s.to;
    if (key(s.to) === atKey) return s.from;
    return null;
  };

  const used = new Set<number>();
  const chains: V2[][] = [];
  const chainThickness: number[] = [];

  // Walk a chain of degree-2 vertices of equal thickness; it breaks at a
  // junction (degree != 2), a thickness change, or closes on itself.
  const walk = (startKey: string, startIdx: number): void => {
    const chain: V2[] = [ptOf.get(startKey)!];
    const th = segs[startIdx].thickness;
    let curKey = startKey;
    let curIdx = startIdx;
    for (;;) {
      used.add(curIdx);
      const nxt = otherEnd(curIdx, curKey);
      if (!nxt) break;
      curKey = key(nxt);
      chain.push(ptOf.get(curKey)!);
      if (chain.length > 2 && curKey === key(chain[0])) break;
      const list = adj.get(curKey) ?? [];
      if (list.length !== 2) break;
      const rem = list.filter((i) => i !== curIdx && !used.has(i));
      if (rem.length !== 1) break;
      // A thickness change is a wall-body break, same as a junction: offsetting
      // mixed thicknesses together would stretch thin walls to the thickest one.
      if (segs[rem[0]].thickness !== th) break;
      curIdx = rem[0];
    }
    chains.push(chain);
    chainThickness.push(th);
  };

  // open chains start at every break vertex (a junction, an end, a thickness
  // change), so no chain is cut at an ordinary corner and loses its miter;
  // what is left are closed loops, where any start gives the same ring
  for (const [k, list] of adj) {
    const brk = list.length !== 2 || segs[list[0]].thickness !== segs[list[1]].thickness;
    if (!brk) continue;
    for (const idx of list) if (!used.has(idx)) walk(k, idx);
  }
  for (let i = 0; i < segs.length; i++) {
    if (!used.has(i)) walk(key(segs[i].from), i);
  }

  const pieces: Path64[] = [];
  chains.forEach((chain, ci) => {
    if (chain.length < 2) return;
    const closed = chain.length > 2 && key(chain[chain.length - 1]) === key(chain[0]);
    const pts = closed ? chain.slice(0, -1) : chain;
    const th = chainThickness[ci];
    const delta = Math.round((th / 2) * 1000);
    const endType = closed ? EndType.Joined : EndType.Square;
    // the offset's winding follows the path direction: normalise each piece
    // first, or a negative piece cancels the ones under it in the union below
    pieces.push(...Clipper.union(Clipper.inflatePaths([toPath(pts)], delta, JoinType.Miter, endType, 2), FillRule.NonZero));
  });
  return pieces.length === 0 ? [] : Clipper.union(pieces, FillRule.NonZero);
}
