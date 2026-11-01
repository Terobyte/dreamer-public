import type { Path64 } from "clipper2-ts";
import type { Ctx } from "../ctx.js";
import type { Issue, PropGeo, Stage } from "../types.js";
import type { V2 } from "../geom/vec.js";
import { EPS } from "../geom/vec.js";
import { obbCorners } from "../geom/obb.js";
import { beamPolys } from "../props/place.js";
import { cutPath } from "../openings/stage.js";
import type { OpeningGeo } from "../openings/resolve.js";
import { msg } from "../report/messages.js";
import { round3 } from "../report/report.js";

/** even-odd point-in-polygon test against a clipper path in millimetres */
function pointInPathMM(p: V2, poly: Path64): boolean {
  const x = p[0] * 1000;
  const z = p[1] * 1000;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    if (a.y > z !== b.y > z) {
      const xi = a.x + ((z - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (x < xi) inside = !inside;
    }
  }
  return inside;
}

const STAGE: Stage = "cameras";

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

/** non-zero winding test against the wall body, whose paths are in mm */
function inBody(body: Path64[] | undefined, p: V2): boolean {
  if (!body) return false;
  const x = p[0] * 1000;
  const z = p[1] * 1000;
  let wind = 0;
  for (const path of body) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      const a = path[j];
      const b = path[i];
      if (a.y <= z) {
        if (b.y > z && (b.x - a.x) * (z - a.y) - (x - a.x) * (b.y - a.y) > 0) wind++;
      } else if (b.y <= z && (b.x - a.x) * (z - a.y) - (x - a.x) * (b.y - a.y) < 0) {
        wind--;
      }
    }
  }
  return wind !== 0;
}

export function checkCameras(ctx: Ctx): Issue[] {
  const scene = ctx.scene as any;
  const issues: Issue[] = [];
  const rooms = (ctx.rooms ?? []) as Array<{ id: string; level: string; height: number; outline: V2[] }>;
  const rawById = new Map<string, any>(((scene.rooms ?? []) as any[]).map((r) => [String(r.id), r]));
  const props = (ctx.props ?? []) as PropGeo[];
  const openings = (ctx.openings ?? []) as OpeningGeo[];
  const list: any[] = scene.cameras ?? [];

  const levelY = (level: string): number => {
    const l = (scene.levels ?? []).find((x: any) => String(x?.id) === level);
    return typeof l?.y === "number" ? l.y : 0;
  };
  // an open room (yard) has no ceiling: it never bounds the camera height
  const isOpen = (id: string): boolean => rawById.get(id)?.open === true;
  const topOf = (r: { id: string; level: string; height: number }): number =>
    isOpen(r.id) ? Infinity : levelY(r.level) + r.height;

  // the wall body is flat; a camera above every wall that touches it (a parapet,
  // a balustrade with an explicit lower `h`) is over the wall, not inside it.
  // room perimeter walls are full height: if one is still under the camera,
  // a nearby low free wall must not mask it.
  const nearOutline = (outline: V2[], p: V2, band: number): boolean => {
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
      const [ax, az] = outline[i];
      const [bx, bz] = outline[j];
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / len2));
      if (Math.hypot(p[0] - (ax + t * dx), p[1] - (az + t * dz)) <= band) return true;
    }
    return false;
  };
  const clearsLowWalls = (level: string, p: V2, y: number): boolean => {
    const near = ((scene.walls ?? []) as any[]).filter((w) => {
      if (String(w?.level) !== level || !Array.isArray(w.from) || !Array.isArray(w.to)) return false;
      const [ax, az] = w.from as V2;
      const [bx, bz] = w.to as V2;
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / len2));
      const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (az + t * dz));
      return d <= (typeof w.thickness === "number" ? w.thickness : 0.2) / 2 + 0.05;
    });
    const base = levelY(level);
    if (near.length === 0 || !near.every((w) => typeof w.h === "number" && y > base + w.h + EPS)) return false;
    // a room wall under the camera is full height: it still blocks
    const band = 0.2 / 2 + 0.05;
    for (const r of rooms) {
      if (r.level !== level || !r.outline || isOpen(r.id)) continue;
      if (y < levelY(r.level) + r.height - EPS && nearOutline(r.outline, p, band)) return false;
    }
    return true;
  };

  for (let i = 0; i < list.length; i++) {
    const cam = list[i];
    const pos = cam?.pos;
    if (!Array.isArray(pos) || pos.length < 3) continue;
    const id = String(cam?.id ?? i);
    const path = `/cameras/${i}/pos`;
    const p: V2 = [pos[0], pos[2]];
    const y = pos[1];
    const fail = (params: Record<string, string>): void => {
      issues.push({ code: "CAMERA_OUTSIDE", stage: STAGE, path, msg: msg("CAMERA_OUTSIDE", { id, ...params }) });
    };
    const xyz = {
      x: String(round3(pos[0])),
      y: String(round3(y)),
      z: String(round3(pos[2])),
    };

    const candidates = rooms.filter((r) => pointInPoly(p, r.outline));
    if (candidates.length === 0) {
      fail({ ...xyz, kind: "rooms" });
      continue;
    }
    const room =
      candidates.find((r) => {
        const b = levelY(r.level);
        return y >= b - EPS && y <= topOf(r) + EPS;
      }) ?? candidates[0];
    const base = levelY(room.level);
    if (y < base - EPS || y > topOf(room) + EPS) {
      fail({
        ...xyz,
        kind: "y",
        room: room.id,
        a: String(round3(base)),
        b: String(round3(base + room.height)),
      });
      continue;
    }
    if (inBody(ctx.levels?.get(room.level)?.body, p) && !clearsLowWalls(room.level, p, y)) {
      fail({ ...xyz, kind: "in", what: `теле стены ${room.id}` });
      continue;
    }
    // the flattened 2D plan has a hole cut for each opening, but the hole only
    // spans the opening's own sill..sill+height — above or below that, the
    // wall body still blocks even though inBody() misses it
    const inOpeningGap = openings.some((o) => {
      if (!o || o.error) return false;
      if (!o.rooms.includes(room.id)) return false;
      if (!pointInPathMM(p, cutPath(o))) return false;
      return y < base + o.sill - EPS || y > base + o.sill + o.height + EPS;
    });
    if (inOpeningGap) {
      fail({ ...xyz, kind: "in", what: `теле стены ${room.id}` });
      continue;
    }
    const beam = !isOpen(room.id)
      ? beamPolys(rawById.get(room.id)).find(
          (b) =>
            pointInPoly(p, b.poly) &&
            y > base + room.height - b.h - EPS &&
            y < base + room.height + EPS,
        )
      : undefined;
    if (beam) {
      fail({ ...xyz, kind: "in", what: `балке ${room.id}` });
      continue;
    }
    const prop = props.find(
      (g) => g.solid && pointInPoly(p, obbCorners(g.obb)) && y > g.y[0] - EPS && y < g.y[1] + EPS,
    );
    if (prop) {
      fail({ ...xyz, kind: "in", what: prop.id });
      continue;
    }
  }
  return issues;
}
