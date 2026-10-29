import type { Ctx } from "../ctx.js";
import type { V2 } from "../geom/vec.js";
import type { OBB } from "../geom/obb.js";
import { pointInPoly } from "../nav/floor.js";
import type { Mesh } from "./geometry.js";
import { MeshBuilder } from "./mesh.js";
import type { V3 } from "./mesh.js";

/** spec "Формат SCENE.json", table `fixtures[].depth`, `h` */
export const FIXTURE_KINDS: Record<string, { depth: number; h: number; sill: number }> = {
  counter: { depth: 0.6, h: 0.9, sill: 0 },
  shelf: { depth: 0.3, h: 1.8, sill: 0 },
  "cabinet-wall": { depth: 0.35, h: 0.7, sill: 1.45 },
};

export interface FixtureGeo {
  /** index in `scene.fixtures`; the address in messages is `fixture.<i>` */
  i: number;
  id: string;
  room: string;
  level: string;
  /** back edge, as authored */
  from: V2;
  to: V2;
  /** unit normal of the back edge pointing into `room` */
  inward: V2;
  depth: number;
  /** absolute y span (level floor included) */
  y: [number, number];
  material: string;
  top: string;
  obb: OBB;
}

function norm2(v: V2): V2 {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/** Signed-area winding of a room outline: +1 counter-clockwise, -1 clockwise. */
function winding(poly: V2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a >= 0 ? 1 : -1;
}

/** Unit interior normal of the outline edge nearest to `p`. The room's own
 *  centroid is no guide in a concave room: it can sit on the far side of the
 *  local boundary (an L-shaped room and a fixture on its inner leg), while the
 *  edge the fixture backs onto points into the room right where it stands. */
function localInward(p: V2, outline: V2[]): V2 {
  const w = winding(outline);
  let best = Infinity;
  let out: V2 = [0, 0];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    if (l2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
    const q: V2 = [a[0] + dx * t, a[1] + dz * t];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < best) {
      best = d;
      const l = Math.sqrt(l2);
      out = [(-dz / l) * w, (dx / l) * w];
    }
  }
  return out;
}

/** Of the two perpendiculars of `from → to`, the one leading into the room.
 *  The back edge of a fixture normally lies on the inner face of a wall, which
 *  is half a thickness inside the room outline (that runs along the wall axis),
 *  so a probe a millimetre away lands inside the room on both sides. The whole
 *  depth is probed first; a tie (both probes land inside, which a shallow
 *  depth makes likely) is broken by the interior normal of the nearest outline
 *  edge, which is the wall the fixture backs onto. Only the sign is taken from
 *  it, so the result stays exactly perpendicular to the authored back edge. */
function inwardNormal(from: V2, to: V2, outline: V2[], depth: number): V2 {
  const d = norm2([to[0] - from[0], to[1] - from[1]]);
  const n: V2 = [-d[1], d[0]];
  const mid: V2 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const at = (s: number): V2 => [mid[0] + n[0] * s, mid[1] + n[1] * s];
  const pos = pointInPoly(at(depth), outline);
  const neg = pointInPoly(at(-depth), outline);
  if (pos !== neg) return pos ? n : [-n[0], -n[1]];
  const inward = localInward(mid, outline);
  const toward = n[0] * inward[0] + n[1] * inward[1];
  return toward >= 0 ? n : [-n[0], -n[1]];
}

/** Fixture bodies of the whole scene, in `scene.fixtures` order. */
export function fixtureGeos(ctx: Ctx): FixtureGeo[] {
  const scene = ctx.scene as Record<string, any>;
  const rooms = (ctx.rooms ?? []) as any[];
  const levels = (scene.levels ?? []) as any[];
  const out: FixtureGeo[] = [];
  ((scene.fixtures ?? []) as any[]).forEach((f, i) => {
    const room = rooms.find((r) => r.id === String(f?.room));
    if (!room) return;
    const kind = FIXTURE_KINDS[String(f.kind)];
    if (!kind) return;
    const from = [Number(f.from[0]), Number(f.from[1])] as V2;
    const to = [Number(f.to[0]), Number(f.to[1])] as V2;
    const depth = typeof f.depth === "number" ? f.depth : kind.depth;
    const h = typeof f.h === "number" ? f.h : kind.h;
    const base = Number(levels.find((l) => String(l?.id) === room.level)?.y ?? 0);
    const inward = inwardNormal(from, to, room.outline as V2[], depth);
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    // yaw of the box: its local +Z follows the back edge (spec "Соглашения":
    // yaw 0 = +Z, growing toward +X)
    const d = norm2([to[0] - from[0], to[1] - from[1]]);
    const yaw = (Math.atan2(d[0], d[1]) * 180) / Math.PI;
    out.push({
      i,
      id: `fixture.${i}`,
      room: room.id,
      level: String(room.level),
      from,
      to,
      inward,
      depth,
      y: [base + kind.sill, base + kind.sill + h],
      material: String(f.material),
      top: String(f.top ?? f.material),
      obb: {
        c: [
          (from[0] + to[0]) / 2 + inward[0] * (depth / 2),
          (from[1] + to[1]) / 2 + inward[1] * (depth / 2),
        ],
        half: [depth / 2, len / 2],
        yaw,
      },
    });
  });
  return out;
}

/** The four corners of the footprint: back edge first, then the front one. */
export function fixtureFootprint(g: FixtureGeo): V2[] {
  const off = (p: V2): V2 => [p[0] + g.inward[0] * g.depth, p[1] + g.inward[1] * g.depth];
  return [g.from, g.to, off(g.to), off(g.from)];
}

/** Body (`fixture.<i>`, no top face) plus the top plane (`fixture.<i>:top`). */
export function fixtureMeshes(ctx: Ctx): Mesh[] {
  const out: Mesh[] = [];
  for (const g of fixtureGeos(ctx)) {
    const q = fixtureFootprint(g);
    const [y0, y1] = g.y;
    const at = (k: number, y: number): V3 => [q[k][0], y, q[k][1]];
    const mb = new MeshBuilder();
    // sides, in footprint order; the normal of each is its outward perpendicular
    for (let k = 0; k < 4; k++) {
      const a = q[k];
      const b = q[(k + 1) % 4];
      const d = norm2([b[0] - a[0], b[1] - a[1]]);
      const n: V3 = [d[1], 0, -d[0]];
      const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
      mb.quad(at(k, y0), at((k + 1) % 4, y0), at((k + 1) % 4, y1), at(k, y1), n, [0, 0], [w, 0], [w, y1 - y0], [0, y1 - y0]);
    }
    // bottom: a wall cabinet hangs, so its underside is visible too
    mb.quad(at(0, y0), at(1, y0), at(2, y0), at(3, y0), [0, -1, 0], [q[0][0], q[0][1]], [q[1][0], q[1][1]], [q[2][0], q[2][1]], [q[3][0], q[3][1]]);
    out.push(mb.finish({ id: g.id, kind: "fixture", material: g.material, room: g.room }));
    // the top carries its own material, so it is one flat quad of 4 vertices
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    for (const p of q) {
      positions.push(p[0], y1, p[1]);
      normals.push(0, 1, 0);
      uvs.push(p[0], p[1]);
    }
    const cross =
      (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]);
    // wind the pair of triangles to face +Y
    const indices = cross < 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    out.push({ id: `${g.id}:top`, kind: "fixture", material: g.top, room: g.room, positions, normals, uvs, indices });
  }
  return out;
}
