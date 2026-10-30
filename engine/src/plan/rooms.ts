import type { V2 } from "../geom/vec.js";
import { EPS } from "../geom/vec.js";
import { arcFromBulge, discretizeArc, azToPoint } from "../geom/arc.js";
import { signedArea, segInt } from "../geom/poly.js";
import { Clipper, ClipType, FillRule } from "clipper2-ts";
import type { Issue } from "../types.js";
import { msg } from "../report/messages.js";

export interface AuthorEdge {
  id: string;
  room: string;
  i: number;
  from: V2;
  to: V2;
  arc: { c: V2; r: number; sweep?: number } | null;
  len: number;
  normalIn: V2;
}

export interface RoomGeo {
  id: string;
  level: string;
  height: number;
  edges: AuthorEdge[];
  outline: V2[];
  closed: boolean;
}

type RawVert = [number, number] | [number, number, { bulge?: number }];

function vertPos(v: RawVert): V2 {
  return [v[0], v[1]];
}

function clean(v: V2): V2 {
  return [Math.abs(v[0]) < EPS ? 0 : v[0], Math.abs(v[1]) < EPS ? 0 : v[1]];
}

function vertBulge(v: RawVert): number {
  if (v.length === 3 && v[2] && typeof v[2] === "object") {
    const b = (v[2] as { bulge?: unknown }).bulge;
    return typeof b === "number" ? b : 0;
  }
  return 0;
}

export function compileRooms(scene: any): { rooms: RoomGeo[]; issues: Issue[] } {
  const rooms: RoomGeo[] = [];
  const issues: Issue[] = [];
  const skipped = new Set<number>();

  const rawRooms: any[] = scene.rooms ?? [];
  const ownersByRoom = new Map<string, number[]>();
  rawRooms.forEach((r: any, ri: number) => {
    if (r.circle) {
      const c: V2 = [r.circle.c[0], r.circle.c[1]];
      const rad: number = r.circle.r;
      const from: V2 = [c[0], c[1] + rad];
      const outline: V2[] = [];
      const n = Math.max(8, Math.ceil((2 * Math.PI * rad) / 0.25));
      for (let k = 0; k < n; k++) outline.push(azToPoint(c, rad, (k * 360) / n));
      const edges: AuthorEdge[] = [
        {
          id: `${r.id}#0`,
          room: r.id,
          i: 0,
          from,
          to: [from[0], from[1]],
          arc: { c, r: rad, sweep: 2 * Math.PI },
          len: 2 * Math.PI * rad,
          normalIn: [0, 1],
        },
      ];
      rooms.push({ id: r.id, level: r.level, height: r.open === true ? 0 : r.height, edges, outline, closed: true });
      return;
    }
    const shape: RawVert[] = r.shape ?? [];
    // zero-length edges first
    let bad = -1;
    for (let i = 0; i < shape.length; i++) {
      const a = vertPos(shape[i]);
      const b = vertPos(shape[(i + 1) % shape.length]);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < EPS) {
        bad = i;
        break;
      }
    }
    if (bad >= 0) {
      skipped.add(ri);
      issues.push({
        code: "ROOM_SELF_INTERSECT",
        stage: "plan",
        path: `/rooms/${ri}/shape/${bad}`,
        msg: msg("ROOM_SELF_INTERSECT", {
          path: `/rooms/${ri}/shape/${bad}`,
          room: String(r.id),
          edges: String(bad),
        }),
      });
      return;
    }
    const chord: V2[] = shape.map(vertPos);
    const area = signedArea(chord);
    const ccw = area > 0;
    const edges: AuthorEdge[] = [];
    const outline: V2[] = [];
    const owners: number[] = [];
    for (let i = 0; i < shape.length; i++) {
      const p0 = vertPos(shape[i]);
      const p1 = vertPos(shape[(i + 1) % shape.length]);
      const b = vertBulge(shape[i]);
      const d: V2 = [p1[0] - p0[0], p1[1] - p0[1]];
      const l = Math.hypot(d[0], d[1]);
      const left: V2 = [-d[1] / l, d[0] / l];
      const nIn: V2 = ccw ? left : [-left[0], -left[1]];
      if (b === 0) {
        outline.push([p0[0], p0[1]]);
        owners.push(i);
        edges.push({ id: `${r.id}#${i}`, room: r.id, i, from: [p0[0], p0[1]], to: [p1[0], p1[1]], arc: null, len: l, normalIn: clean(nIn) });
      } else {
        const arc = arcFromBulge(p0, p1, b, nIn);
        const pts = discretizeArc(arc, p0, p1);
        for (let k = 0; k < pts.length - 1; k++) {
          outline.push(pts[k]);
          owners.push(i);
        }
        const midAng = Math.atan2(arc.apex[0] - arc.c[0], arc.apex[1] - arc.c[1]);
        const radial: V2 = b > 0
          ? [arc.c[0] - arc.apex[0], arc.c[1] - arc.apex[1]]
          : [arc.apex[0] - arc.c[0], arc.apex[1] - arc.c[1]];
        const rl = Math.hypot(radial[0], radial[1]);
        void midAng;
        edges.push({
          id: `${r.id}#${i}`,
          room: r.id,
          i,
          from: [p0[0], p0[1]],
          to: [p1[0], p1[1]],
          arc: { c: arc.c, r: arc.r, sweep: arc.sweep },
          len: arc.len,
          normalIn: clean([radial[0] / rl, radial[1] / rl]),
        });
      }
    }
    rooms.push({ id: r.id, level: r.level, height: r.open === true ? 0 : r.height, edges, outline, closed: true });
    ownersByRoom.set(String(r.id), owners);
  });

  // self-intersection on discretized outline
  rawRooms.forEach((r: any, ri: number) => {
    if (skipped.has(ri) || r.circle) return;
    const room = rooms.find((x) => x.id === r.id);
    if (!room) return;
    const hit = segmentsSelfIntersect(room.outline);
    if (hit) {
      skipped.add(ri);
      const owners = ownersByRoom.get(String(r.id)) ?? [];
      const ea = owners[hit[0] % Math.max(1, owners.length)] ?? hit[0];
      const eb = owners[hit[1] % Math.max(1, owners.length)] ?? hit[1];
      const path = `/rooms/${ri}/shape/${Math.min(ea, eb)}`;
      issues.push({
        code: "ROOM_SELF_INTERSECT",
        stage: "plan",
        path,
        msg: msg("ROOM_SELF_INTERSECT", {
          path,
          room: room.id,
          edges: `${room.id}#${ea} и ${room.id}#${eb}`,
        }),
      });
    }
  });

  // ROOMS_OVERLAP for same-level pairs
  const active = rooms.filter((rm) => {
    const idx = rawRooms.findIndex((r: any) => r.id === rm.id);
    return !skipped.has(idx);
  });
  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      if (active[a].level !== active[b].level) continue;
      const s = overlapArea(active[a].outline, active[b].outline);
      if (s > 0.01) {
        const ai = rawRooms.findIndex((r: any) => r.id === active[a].id);
        const bi = rawRooms.findIndex((r: any) => r.id === active[b].id);
        const path = `/rooms/${Math.min(ai, bi)}/shape`;
        issues.push({
          code: "ROOMS_OVERLAP",
          stage: "plan",
          path,
          msg: msg("ROOMS_OVERLAP", {
            path,
            a: active[a].id,
            b: active[b].id,
            S: String(Math.round(s * 1000) / 1000),
          }),
        });
      }
    }
  }

  return { rooms, issues };
}

function segmentsSelfIntersect(outline: V2[]): [number, number] | null {
  const n = outline.length;
  if (n < 4) return null;
  const closed = [...outline, outline[0]];
  const m = closed.length - 1;
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      if (Math.abs(i - j) <= 1) continue;
      if (i === 0 && j === m - 1) continue;
      if (segInt(closed[i], closed[i + 1], closed[j], closed[j + 1])) return [i, j];
    }
  }
  return null;
}

/** Area the two footprints share, in m² (0 when they only touch). */
export function overlapArea(a: V2[], b: V2[]): number {
  const pa = a.map((p) => ({ x: Math.round(p[0] * 1000), y: Math.round(p[1] * 1000) }));
  const pb = b.map((p) => ({ x: Math.round(p[0] * 1000), y: Math.round(p[1] * 1000) }));
  const inter = Clipper.intersect([pa], [pb], FillRule.NonZero);
  let s = 0;
  for (const path of inter) s += Math.abs(Clipper.area(path));
  return s / 1e6;
}
