import type { V2 } from "../geom/vec.js";
import { EPS } from "../geom/vec.js";
import type { OpeningGeo } from "./resolve.js";

export interface SwingInput {
  center: V2;
  axis: V2;
  normalRide: V2;
  width: number;
  thickness: number;
  rideRoom: string;
  swingRoom: string;
  swingEdgeFrom: V2;
  swingEdgeTo: V2;
}

export function jambsFor(center: V2, axis: V2, nSwing: V2, width: number): { left: V2; right: V2; L: V2 } {
  const f: V2 = [-nSwing[0], -nSwing[1]];
  const L: V2 = [f[1], -f[0]];
  const hw = width / 2;
  return { left: [center[0] + L[0] * hw, center[1] + L[1] * hw], right: [center[0] - L[0] * hw, center[1] - L[1] * hw], L };
}

export function sectorFor(hingeAt: V2, otherJamb: V2, nSwing: V2, width: number): V2[] {
  const a0 = Math.atan2(otherJamb[0] - hingeAt[0], otherJamb[1] - hingeAt[1]);
  const a1 = Math.atan2(nSwing[0], nSwing[1]);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const pts: V2[] = [[hingeAt[0], hingeAt[1]]];
  for (let k = 0; k <= 15; k++) {
    const a = a0 + (sweep * k) / 15;
    pts.push([hingeAt[0] + width * Math.sin(a), hingeAt[1] + width * Math.cos(a)]);
  }
  return pts;
}

export function applySwing(
  g: OpeningGeo,
  opts: { swingRoom: string; hinge?: "left" | "right" | null; nSwing: V2; swingFrom: V2; swingTo: V2; leafOpen: boolean; kind: string },
): void {
  g.swing = opts.swingRoom;
  // jambs are the chord ends. Spec: on an arc the jamb («откос») runs along the
  // chord, and the chord is exactly `width` long, so its ends are the spec's
  // "centre ± L·width/2" taken from the chord midpoint. From the axis point at
  // `m` instead, ± L·width/2 lands off the wall, outside the room on a circle.
  // On straight walls both readings coincide. Left/right by L = (f.z, -f.x), f = -n
  const { L } = jambsFor(g.center, g.axis, opts.nSwing, g.width);
  const side = (p: V2): number => (p[0] - g.center[0]) * L[0] + (p[1] - g.center[1]) * L[1];
  const [e0, e1] = g.ends;
  const left: V2 = side(e0) >= side(e1) ? e0 : e1;
  const right: V2 = left === e0 ? e1 : e0;
  let hinge = opts.hinge ?? null;
  if (!hinge) {
    const dL = Math.min(
      Math.hypot(left[0] - opts.swingFrom[0], left[1] - opts.swingFrom[1]),
      Math.hypot(left[0] - opts.swingTo[0], left[1] - opts.swingTo[1]),
    );
    const dR = Math.min(
      Math.hypot(right[0] - opts.swingFrom[0], right[1] - opts.swingFrom[1]),
      Math.hypot(right[0] - opts.swingTo[0], right[1] - opts.swingTo[1]),
    );
    hinge = Math.abs(dL - dR) < 1e-3 ? "left" : dL < dR ? "left" : "right";
  }
  g.hinge = hinge;
  const j = hinge === "left" ? left : right;
  const other = hinge === "left" ? right : left;
  void other;
  g.hingeAt = [j[0] + opts.nSwing[0] * (g.thickness / 2), j[1] + opts.nSwing[1] * (g.thickness / 2)];
  if (g.kind === "door" && opts.leafOpen) {
    // sector starts from the far jamb shifted to the same inner face as the hinge
    const otherInner: V2 = [other[0] + opts.nSwing[0] * (g.thickness / 2), other[1] + opts.nSwing[1] * (g.thickness / 2)];
    g.sector = sectorFor(g.hingeAt as V2, otherInner, opts.nSwing, g.width);
  } else {
    g.sector = null;
  }
  void EPS;
}
