import type { Ctx } from "../ctx.js";
import type { Issue, PropGeo } from "../types.js";
import type { V2 } from "../geom/vec.js";
import { EPS } from "../geom/vec.js";
import type { OBB } from "../geom/obb.js";
import { obbCorners, obbIntersects, obbPolyIntersects, rotLocal } from "../geom/obb.js";
import { beamPolys, nearestEdge } from "./place.js";
import { CATS } from "./cats.js";
import { msg } from "../report/messages.js";
import { round3 } from "../report/report.js";

/** `mount: ceiling` props must leave a person's height underneath */
const CEILING_MIN = 2.0;
/** `mount: wall` needs an edge of its own room closer than this (to the axis) */
const WALL_SEARCH = 1.0;
/** `face: "room"` is meaningless further than this from the inner face */
const FACE_ROOM_MAX = 1.0;
const DEFAULT_THICKNESS = 0.12;
const SIZE_LO = 0.5;
const SIZE_HI = 1.6;

function pointInPoly(p: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > p[1] !== zj > p[1]) {
      const x = xi + ((p[1] - zi) / (zj - zi)) * (xj - xi);
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

/** SAT penetration depth; 0 when the boxes only touch or are apart */
function obbDepth(a: OBB, b: OBB): number {
  const pa = obbCorners(a);
  const pb = obbCorners(b);
  let best = Infinity;
  for (const ax of [rotLocal(1, 0, a.yaw), rotLocal(0, 1, a.yaw), rotLocal(1, 0, b.yaw), rotLocal(0, 1, b.yaw)]) {
    const proj = (pts: V2[]): [number, number] => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of pts) {
        const d = p[0] * ax[0] + p[1] * ax[1];
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      return [lo, hi];
    };
    const [a0, a1] = proj(pa);
    const [b0, b1] = proj(pb);
    const overlap = Math.min(a1, b1) - Math.max(a0, b0);
    if (overlap <= EPS) return 0;
    best = Math.min(best, overlap);
  }
  return best === Infinity ? 0 : best;
}

/** strict overlap of two vertical spans */
function yHits(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] - EPS && b[0] < a[1] - EPS;
}

export function lintProps(ctx: Ctx): Issue[] {
  const scene = ctx.scene as Record<string, any>;
  const issues: Issue[] = [];
  const rooms = (ctx.rooms ?? []) as any[];
  const roomById = new Map<string, any>(rooms.map((r) => [r.id, r]));
  const rawById = new Map<string, any>(((scene.rooms ?? []) as any[]).map((r) => [String(r.id), r]));
  const list: any[] = scene.props ?? [];
  const geos = [...((ctx.props ?? []) as PropGeo[])].sort(
    (a, b) => a.src - b.src || (a.copy ?? 0) - (b.copy ?? 0),
  );
  const placed = new Set(geos.map((g) => g.src));

  const thicknessOf = (roomId: string): number => {
    const t = rawById.get(roomId)?.walls?.thickness;
    return typeof t === "number" ? t : DEFAULT_THICKNESS;
  };
  const levelYOf = (room: any): number => {
    const lvl = (scene.levels ?? []).find((l: any) => String(l?.id) === room.level);
    return typeof lvl?.y === "number" ? lvl.y : 0;
  };
  const wallPolysOf = (room: any): V2[][] =>
    (ctx.levels?.get(room.level)?.body ?? []).map((path: any) =>
      (path as Array<{ x: number; y: number }>).map((pt) => [pt.x / 1000, pt.y / 1000] as V2),
    );
  const beamsOf = (room: any): Array<{ poly: V2[]; h: number }> => beamPolys(rawById.get(room.id));

  const at = (raw: any): V2 | null => (Array.isArray(raw.at) ? [raw.at[0], raw.at[1]] : null);

  // --- props that never got placed: one defect, one record, no further checks
  list.forEach((raw, i) => {
    if (placed.has(i)) return;
    const room = roomById.get(String(raw.room));
    if (!room) return; // reported by the schema stage as REF_UNKNOWN
    const p = at(raw);
    if (raw.mount === "wall" && !raw.on && p) {
      const near = nearestEdge(p, room, thicknessOf(room.id), false);
      if (!near || near.d >= WALL_SEARCH - EPS) {
        issues.push({
          code: "PROP_WALL_NOT_FOUND",
          stage: "props",
          path: `/props/${i}/at`,
          msg: msg("PROP_WALL_NOT_FOUND", {
            id: String(raw.id),
            edge: near ? near.e.id : "?",
            d: String(round3(near ? near.d : 0)),
            need: String(WALL_SEARCH),
          }),
        });
        return;
      }
    }
    if (raw.around) return;
    if (typeof raw.yaw !== "number" && raw.face === undefined && raw.mount !== "ceiling") {
      issues.push({
        code: "PROP_NO_FACING",
        stage: "props",
        path: `/props/${i}`,
        msg: msg("PROP_NO_FACING", { id: String(raw.id) }),
        fix: { face: "room" },
      });
    }
  });

  // --- placed props
  for (let gi = 0; gi < geos.length; gi++) {
    const g = geos[gi];
    const raw = list[g.src];
    const room = roomById.get(g.room);
    if (!raw || !room) continue;
    // `fix` is applied to the nearest node owning its keys, so errors that carry
    // one point at the field; copies of `around` get no `fix` and no `at`
    const path = g.copy === undefined ? `/props/${g.src}/at` : `/props/${g.src}`;
    const copy = g.copy === undefined ? {} : { copy: g.copy };
    const add = (code: Issue["code"], params: Record<string, string>, fix?: Record<string, unknown>): void => {
      issues.push({
        code,
        stage: "props",
        path,
        msg: msg(code, { id: g.id, ...params }),
        ...copy,
        ...(fix && g.copy === undefined ? { fix } : {}),
      });
    };

    const c: V2 = [g.obb.c[0], g.obb.c[1]];
    const thickness = thicknessOf(room.id);
    const levelY = levelYOf(room);
    const ceilY = levelY + room.height;

    // 1. outside its own room
    if (!pointInPoly(c, room.outline as V2[])) {
      const other = rooms.find((r) => r.id !== room.id && r.level === room.level && pointInPoly(c, r.outline));
      add(
        "PROP_OUTSIDE_ROOM",
        { x: String(round3(c[0])), z: String(round3(c[1])), room: room.id, other: other ? other.id : "" },
        other ? { room: other.id } : undefined,
      );
      continue;
    }

    // 2. top above the ceiling, or above the bottom of a beam over the footprint
    let top = ceilY;
    let topWhat = room.height;
    for (const b of beamsOf(room)) {
      if (obbPolyIntersects(g.obb, [b.poly]) && ceilY - b.h < top) {
        top = ceilY - b.h;
        topWhat = room.height - b.h;
      }
    }
    if (g.y[1] > top + EPS) {
      add("PROP_ABOVE_CEILING", {
        y1: String(round3(g.y[1])),
        room: room.id,
        h: String(round3(topWhat)),
        d: String(round3(g.y[1] - top)),
      });
      continue;
    }

    // 3. hanging too low (clearance measured from the room's own floor, not y = 0)
    const clearance = g.y[0] - levelY;
    if (raw.mount === "ceiling" && clearance < CEILING_MIN - EPS) {
      add("PROP_CEILING_LOW", { y0: String(round3(clearance)), min: "2.0" });
      continue;
    }

    // 4. standing on a support smaller than its own footprint
    const topOf = raw.mount && typeof raw.mount === "object" ? raw.mount.top_of : undefined;
    if (topOf) {
      const support = geos.find((s) => s.id === String(topOf));
      if (support) {
        const inside = obbCorners(g.obb).every((p) => {
          const d = [p[0] - support.obb.c[0], p[1] - support.obb.c[1]];
          const ax = rotLocal(1, 0, support.obb.yaw);
          const az = rotLocal(0, 1, support.obb.yaw);
          const u = Math.abs(d[0] * ax[0] + d[1] * ax[1]);
          const v = Math.abs(d[0] * az[0] + d[1] * az[1]);
          return u <= support.obb.half[0] + EPS && v <= support.obb.half[1] + EPS;
        });
        if (!inside) {
          add("PROP_ON_TOO_SMALL", {
            other: support.id,
            w: String(round3(g.size.w)),
            d: String(round3(g.size.d)),
            sw: String(round3(support.size.w)),
            sd: String(round3(support.size.d)),
          });
          continue;
        }
      }
    }

    if (g.solid) {
      // 5. inside the wall body or a beam footprint
      const near = nearestEdge(c, room, thickness, true);
      const hitWall = obbPolyIntersects(g.obb, wallPolysOf(room));
      const hitBeam = beamsOf(room).find(
        (b) => obbPolyIntersects(g.obb, [b.poly]) && yHits(g.y, [ceilY - b.h, ceilY]),
      );
      if (hitWall || hitBeam) {
        // depth past the inner face along its normal; a beam is reported at the
        // same address, measured by how far the prop reaches into it
        let depth = 0;
        if (near) {
          const face: V2 = [near.q[0] + near.n[0] * (thickness / 2), near.q[1] + near.n[1] * (thickness / 2)];
          for (const p of obbCorners(g.obb)) {
            depth = Math.max(depth, -((p[0] - face[0]) * near.n[0] + (p[1] - face[1]) * near.n[1]));
          }
        }
        if (depth <= EPS && hitBeam) depth = Math.min(g.y[1], ceilY) - (ceilY - hitBeam.h);
        const p0 = at(raw);
        const fix =
          near && p0
            ? { at: [round3(p0[0] + near.n[0] * (depth + 0.01)), round3(p0[1] + near.n[1] * (depth + 0.01))] }
            : undefined;
        add(
          "PROP_HITS_WALL",
          { edge: near ? near.e.id : room.id, d: String(round3(depth)) },
          fix,
        );
        continue;
      }

      // 6. into another solid prop (the record goes to the later one)
      let bump: { other: PropGeo; d: number } | null = null;
      for (let j = 0; j < gi; j++) {
        const o = geos[j];
        if (!o.solid) continue;
        const oRaw = list[o.src];
        const oTopOf = oRaw?.mount && typeof oRaw.mount === "object" ? oRaw.mount.top_of : undefined;
        if (String(topOf ?? "") === o.id || String(oTopOf ?? "") === g.id) continue;
        if (!yHits(g.y, o.y)) continue;
        if (!obbIntersects(g.obb, o.obb)) continue;
        bump = { other: o, d: obbDepth(g.obb, o.obb) };
        break;
      }
      if (bump) {
        add("PROP_HITS_PROP", { other: bump.other.id, d: String(round3(bump.d)) });
        continue;
      }

      // 7. in a doorway corridor or a leaf sector (only openings on this room's level)
      const openings = ((ctx.openings ?? []) as any[]).filter(
        (o) => o && !o.error && Array.isArray(o.rooms) && o.rooms.includes(room.id),
      );
      const inDoor = openings.find(
        (o) =>
          o.corridor &&
          obbPolyIntersects(g.obb, [o.corridor]) &&
          yHits(g.y, [levelY + o.sill, levelY + o.sill + o.height]),
      );
      if (inDoor) {
        add("PROP_IN_DOORWAY", { opening: String(inDoor.id) });
        continue;
      }
      const inSwing = openings.find((o) => o && !o.error && o.sector && obbPolyIntersects(g.obb, [o.sector]));
      if (inSwing) {
        add("PROP_IN_SWING", { opening: String(inSwing.id) });
        continue;
      }
    }

    // warnings: `face: "room"` taken from too far away
    if (g.copy === undefined && raw.face === "room") {
      const p0 = at(raw);
      const near = p0 ? nearestEdge(p0, room, thickness, true) : null;
      if (near && near.d > FACE_ROOM_MAX + EPS) {
        issues.push({
          code: "FACE_ROOM_FAR",
          stage: "props",
          path: `/props/${g.src}/at`,
          msg: msg("FACE_ROOM_FAR", {
            id: g.id,
            edge: near.e.id,
            d: String(round3(near.d)),
            max: String(FACE_ROOM_MAX),
          }),
        });
      }
    }
  }

  // warnings: implausible size for the declared `cat`, once per source prop
  list.forEach((raw, i) => {
    const cat = CATS[String(raw.cat)];
    if (!cat || !raw.size) return;
    const bad: string[] = [];
    const check = (k: "w" | "d" | "h", lo: number, hi: number): void => {
      const v = raw.size[k];
      if (typeof v !== "number") return;
      if (v < lo - EPS || v > hi + EPS) bad.push(`${k} ${round3(v)} вне ${round3(lo)}…${round3(hi)}`);
    };
    check("w", cat.w * SIZE_LO, cat.w * SIZE_HI);
    check("d", cat.d * SIZE_LO, cat.d * SIZE_HI);
    check("h", cat.h * SIZE_LO, cat.hMax ?? cat.h * SIZE_HI);
    if (bad.length === 0) return;
    issues.push({
      code: "PROP_SIZE_ODD",
      stage: "props",
      path: `/props/${i}/size`,
      msg: msg("PROP_SIZE_ODD", { id: String(raw.id), cat: String(raw.cat), bad: bad.join(", ") }),
    });
  });

  return issues;
}
