import { Clipper, EndType, FillRule, JoinType } from "clipper2-ts";
import type { Path64 } from "clipper2-ts";
import type { Ctx } from "../ctx.js";
import type { Issue, NavJson, PropGeo, Stage } from "../types.js";
import type { V2 } from "../geom/vec.js";
import { obbCorners } from "../geom/obb.js";
import { beamPolys, closestOnEdge } from "../props/place.js";
import { cutPath } from "../openings/stage.js";
import { fixtureGeos, fixtureFootprint } from "../build/fixtures.js";
import type { OpeningGeo } from "../openings/resolve.js";
import { msg } from "../report/messages.js";
import { CAPSULE_H, CAPSULE_R, CELL, STEP_MAX, levelY, pointInPoly } from "./floor.js";

const STAGE: Stage = "nav";

interface RoomRec {
  id: string;
  level: string;
  height: number;
  outline: V2[];
  edges: Array<{ id: string; from: V2; to: V2; arc: any; len: number; normalIn: V2 }>;
}

function toPoly(path: Path64): V2[] {
  return path.map((p) => [p.x / 1000, p.y / 1000] as V2);
}

function toPath(poly: V2[]): Path64 {
  return poly.map(([x, z]) => ({ x: Math.round(x * 1000), y: Math.round(z * 1000) }));
}

/**
 * A capsule can walk through an opening only when the hole it leaves in the
 * wall reaches from the floor to head height; anything else (a window, a sill
 * step, a closed leaf) is wall again as far as navigation is concerned.
 */
function isWalkThrough(g: OpeningGeo): boolean {
  return g.leafOpen !== false && g.sill <= STEP_MAX && g.sill + g.height >= CAPSULE_H;
}

/** Horizontal crossings of a set of polygons with the line z = const. */
function crossings(polys: V2[][], z: number): Array<{ x: number; dir: number }> {
  const out: Array<{ x: number; dir: number }> = [];
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      if (a[1] > z === b[1] > z) continue;
      out.push({ x: a[0] + ((z - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), dir: b[1] > a[1] ? 1 : -1 });
    }
  }
  out.sort((p, q) => p.x - q.x);
  return out;
}

/** Inside intervals along the row z, by non-zero winding or even-odd parity. */
function rowSpans(polys: V2[][], z: number, nonZero: boolean): Array<[number, number]> {
  const cs = crossings(polys, z);
  const res: Array<[number, number]> = [];
  let w = 0;
  let start = 0;
  for (const c of cs) {
    const was = nonZero ? w !== 0 : w % 2 !== 0;
    w += nonZero ? c.dir : 1;
    const now = nonZero ? w !== 0 : w % 2 !== 0;
    if (!was && now) start = c.x;
    else if (was && !now) res.push([start, c.x]);
  }
  return res;
}

function inSpans(spans: Array<[number, number]>, x: number): boolean {
  for (const [a, b] of spans) {
    if (x < a) return false;
    if (x <= b) return true;
  }
  return false;
}

interface Obstacles {
  polys: V2[][];
  solidProps: PropGeo[];
  body: V2[][];
}

function obstaclesOf(ctx: Ctx, level: string, base: number): Obstacles {
  const rooms = ((ctx.rooms ?? []) as RoomRec[]).filter((r) => r.level === level);
  const rawById = new Map<string, any>((((ctx.scene as any).rooms ?? []) as any[]).map((r) => [String(r.id), r]));
  const openings = ((ctx.openings ?? []) as OpeningGeo[]).filter((g) => !g.error && g.intervalLevel === level);

  // walls for the capsule: the uncut body minus only the openings it can pass
  // (not windows, sill steps or closed leaves). Patching cut openings back with
  // their chord rectangle would add a false obstacle on arcs
  const plan = ctx.levels?.get(level) as any;
  let body: Path64[] = plan?.body ?? [];
  if (plan?.bodyFull) {
    const walk = new Set(openings.filter(isWalkThrough).map((g) => g.id));
    const cuts = ((plan.cuts ?? []) as Array<{ id: string; paths: Path64[] }>).filter((c) => walk.has(c.id));
    body = cuts.length === 0 ? plan.bodyFull : Clipper.difference(plan.bodyFull, cuts.flatMap((c) => c.paths), FillRule.NonZero);
  }

  const polys: V2[][] = body.map(toPoly);

  const solidProps: PropGeo[] = [];
  for (const g of (ctx.props ?? []) as PropGeo[]) {
    if (!g.solid) continue;
    const room = rooms.find((r) => r.id === g.room);
    if (!room) continue;
    // real vertical extent: it only blocks if it reaches into the capsule band
    if (g.y[1] <= base + STEP_MAX || g.y[0] >= base + CAPSULE_H) continue;
    solidProps.push(g);
    polys.push(asPositive(obbCorners(g.obb)));
  }

  // a fixture is solid for the capsule, exactly like a prop: it blocks only
  // when its body reaches into the capsule band
  for (const f of fixtureGeos(ctx)) {
    if (f.level !== level) continue;
    if (f.y[1] <= base + STEP_MAX || f.y[0] >= base + CAPSULE_H) continue;
    polys.push(asPositive(fixtureFootprint(f)));
  }

  for (const r of rooms) {
    for (const b of beamPolys(rawById.get(r.id))) {
      if (base + r.height - b.h >= base + CAPSULE_H) continue;
      polys.push(asPositive(b.poly));
    }
  }

  return { polys, solidProps, body: body.map(toPoly) };
}

/**
 * obbCorners/beamPolys build a standalone solid quad, never a hole, but their
 * vertex order isn't guaranteed to match the wall body's outer-boundary
 * convention (Clipper2 emits holes as negatively-wound paths). Left
 * unnormalized, a quad wound opposite to an overlapping wall segment cancels
 * to winding 0 under the nonzero union below and wrongly erases that wall
 * (e.g. a beam running flush along the wall it should reinforce). `body`
 * itself is left untouched since its negative sub-paths are real holes.
 */
function asPositive(poly: V2[]): V2[] {
  return Clipper.isPositive(toPath(poly)) ? poly : [...poly].reverse();
}

function inflate(polys: V2[][]): V2[][] {
  if (polys.length === 0) return [];
  const united = Clipper.union(polys.map(toPath), [], FillRule.NonZero);
  if (united.length === 0) return [];
  const grown = Clipper.inflatePaths(united, Math.round(CAPSULE_R * 1000), JoinType.Round, EndType.Polygon, 2);
  return grown.map(toPoly);
}

function snapDown(v: number): number {
  return Math.floor(v / CELL + 1e-9) * CELL;
}

function snapUp(v: number): number {
  return Math.ceil(v / CELL - 1e-9) * CELL;
}

interface Layer {
  level: string;
  y: number;
  origin: [number, number];
  w: number;
  h: number;
  walk: Uint8Array;
  roomOf: Int16Array;
  rooms: RoomRec[];
}

function buildLayer(ctx: Ctx, level: string): Layer | null {
  const rooms = ((ctx.rooms ?? []) as RoomRec[]).filter((r) => r.level === level);
  if (rooms.length === 0) return null;
  const base = levelY(ctx, level);

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const r of rooms) {
    for (const [x, z] of r.outline) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const x0 = snapDown(minX - CELL);
  const z0 = snapDown(minZ - CELL);
  const w = Math.round((snapUp(maxX + CELL) - x0) / CELL);
  const h = Math.round((snapUp(maxZ + CELL) - z0) / CELL);

  const blocked = inflate(obstaclesOf(ctx, level, base).polys);
  const walk = new Uint8Array(w * h);
  const roomOf = new Int16Array(w * h).fill(-1);
  for (let j = 0; j < h; j++) {
    const z = z0 + (j + 0.5) * CELL;
    const bad = rowSpans(blocked, z, true);
    const roomSpans = rooms.map((r) => rowSpans([r.outline], z, false));
    for (let i = 0; i < w; i++) {
      const x = x0 + (i + 0.5) * CELL;
      let ri = -1;
      for (let k = 0; k < rooms.length; k++) {
        if (inSpans(roomSpans[k], x)) {
          ri = k;
          break;
        }
      }
      if (ri < 0) continue;
      roomOf[j * w + i] = ri;
      if (!inSpans(bad, x)) walk[j * w + i] = 1;
    }
  }
  return { level, y: base, origin: [x0, z0], w, h, walk, roomOf, rooms };
}

function packBits(layer: Layer): string {
  const bytes = Buffer.alloc(Math.ceil((layer.w * layer.h) / 8));
  for (let n = 0; n < layer.w * layer.h; n++) {
    if (layer.walk[n]) bytes[n >> 3] |= 1 << (n & 7);
  }
  return bytes.toString("base64");
}

function spawnLevel(ctx: Ctx): string {
  const spawnRoom = String((ctx.scene as any).spawn?.room ?? "");
  const rooms = (ctx.rooms ?? []) as RoomRec[];
  return rooms.find((r) => r.id === spawnRoom)?.level ?? rooms[0]?.level ?? "L0";
}

export function buildNav(ctx: Ctx): NavJson {
  const layer = buildLayer(ctx, spawnLevel(ctx));
  return {
    cell: CELL,
    capsule: { r: CAPSULE_R, h: CAPSULE_H, step_max: STEP_MAX },
    layers: layer
      ? [
          {
            level: layer.level,
            y: layer.y,
            origin: [layer.origin[0], layer.origin[1]],
            w: layer.w,
            h: layer.h,
            bits: packBits(layer),
          },
        ]
      : [],
    ramps: [],
    links: [],
  };
}

export function isWalkable(nav: NavJson, x: number, z: number, level = "L0"): boolean {
  const layer = (nav.layers as any[]).find((l) => l.level === level);
  if (!layer) return false;
  const i = Math.floor((x - layer.origin[0]) / CELL + 1e-9);
  const j = Math.floor((z - layer.origin[1]) / CELL + 1e-9);
  if (i < 0 || j < 0 || i >= layer.w || j >= layer.h) return false;
  const n = j * layer.w + i;
  const bytes = Buffer.from(layer.bits as string, "base64");
  return ((bytes[n >> 3] >> (n & 7)) & 1) === 1;
}

/** Distance from p to the nearest edge of a simple polygon (0 if p is inside). */
function distToPoly(p: V2, poly: V2[]): number {
  if (pointInPoly(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
    t = Math.min(1, Math.max(0, t));
    const q: V2 = [a[0] + dx * t, a[1] + dz * t];
    best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  return best;
}

/** What the spawn cell sits in, for the NAV_SPAWN_BLOCKED message. */
function blocker(ctx: Ctx, layer: Layer, p: V2, base: number): string {
  const obs = obstaclesOf(ctx, layer.level, base);
  const prop = obs.solidProps.find((g) => distToPoly(p, obbCorners(g.obb)) <= CAPSULE_R + 1e-9);
  if (prop) return prop.id;
  const room = layer.rooms.find((r) => pointInPoly(p, r.outline));
  if (!room) return "вне комнат";
  let bestId = `${room.id}#0`;
  let bestD = Infinity;
  for (const e of room.edges) {
    const { d } = closestOnEdge(p, e as never);
    if (d < bestD) {
      bestD = d;
      bestId = e.id;
    }
  }
  return `стене ${bestId}`;
}

export function navStage(ctx: Ctx): Issue[] {
  const issues: Issue[] = [];
  const level = spawnLevel(ctx);
  const layer = buildLayer(ctx, level);
  const nav = buildNav(ctx);
  ctx.nav = nav;
  if (!layer) return issues;

  const spawn = (ctx.scene as any).spawn;
  const at = spawn?.at;
  if (!Array.isArray(at) || at.length < 2) return issues;
  const i = Math.floor((at[0] - layer.origin[0]) / CELL + 1e-9);
  const j = Math.floor((at[1] - layer.origin[1]) / CELL + 1e-9);
  const inGrid = i >= 0 && j >= 0 && i < layer.w && j < layer.h;
  if (!inGrid || layer.walk[j * layer.w + i] !== 1) {
    const center: V2 = [layer.origin[0] + (i + 0.5) * CELL, layer.origin[1] + (j + 0.5) * CELL];
    const what = inGrid ? blocker(ctx, layer, center, layer.y) : "вне комнат";
    issues.push({
      code: "NAV_SPAWN_BLOCKED",
      stage: STAGE,
      path: "/spawn/at",
      msg: msg("NAV_SPAWN_BLOCKED", { what }),
    });
    return issues;
  }

  // 4-connected flood from the spawn cell
  const seen = new Uint8Array(layer.w * layer.h);
  const reached = new Set<number>();
  const start = j * layer.w + i;
  seen[start] = 1;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi];
    reached.add(layer.roomOf[n]);
    const ci = n % layer.w;
    const cj = (n - ci) / layer.w;
    const step = (ni: number, nj: number): void => {
      if (ni < 0 || nj < 0 || ni >= layer.w || nj >= layer.h) return;
      const m = nj * layer.w + ni;
      if (seen[m] || layer.walk[m] !== 1) return;
      seen[m] = 1;
      queue.push(m);
    };
    step(ci + 1, cj);
    step(ci - 1, cj);
    step(ci, cj + 1);
    step(ci, cj - 1);
  }

  const rawRooms: any[] = (ctx.scene as any).rooms ?? [];
  layer.rooms.forEach((r, k) => {
    if (reached.has(k)) return;
    const idx = rawRooms.findIndex((x: any) => String(x?.id) === r.id);
    const path = `/rooms/${idx < 0 ? 0 : idx}`;
    issues.push({
      code: "NAV_ROOM_CUT",
      stage: STAGE,
      path,
      msg: msg("NAV_ROOM_CUT", { room: r.id, path, r: String(CAPSULE_R) }),
    });
  });
  return issues;
}
