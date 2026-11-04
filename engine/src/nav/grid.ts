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
import { CAPSULE_H, CAPSULE_R, CELL, STEP_MAX, levelY, pointInPoly, rampExit } from "./floor.js";
import type { NavRamp } from "./floor.js";
import { placeStairs, type StairGeo } from "../stairs/place.js";
import { RAIL_BAR } from "../build/stairs.js";

const EPS = 1e-6;

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

/**
 * `scene` follows each leaf's `open`; `open` / `closed` force every door that
 * has a leaf, which is how the runtime masks are made.
 */
type DoorMode = "scene" | "open" | "closed";

/** Ids of the doors the page can move: a door opening with a `leaf`. */
function leafDoorIds(ctx: Ctx): Set<string> {
  const out = new Set<string>();
  for (const o of ((ctx.scene as any).openings ?? []) as any[]) {
    if (o?.kind === "door" && o.leaf) out.add(String(o.id));
  }
  return out;
}

function passes(g: OpeningGeo, mode: DoorMode, leafed: Set<string>): boolean {
  if (mode === "scene" || !leafed.has(g.id)) return isWalkThrough(g);
  return mode === "open" && g.sill <= STEP_MAX && g.sill + g.height >= CAPSULE_H;
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

/** A laid-out flight with the two levels it joins and its nav strip. */
interface StairNav {
  geo: StairGeo;
  ramp: NavRamp;
  fromLevel: string;
  toLevel: string;
}

/** A rectangle in flight-axis coordinates: `s0`..`s1` along, `t0`..`t1` across. */
function axisQuad(geo: StairGeo, s0: number, s1: number, t0: number, t1: number): V2[] {
  const px: V2 = [-geo.dir[1], geo.dir[0]];
  const at = (s: number, t: number): V2 => [
    geo.from[0] + geo.dir[0] * s + px[0] * t,
    geo.from[1] + geo.dir[1] * s + px[1] * t,
  ];
  return [at(s0, t1), at(s1, t1), at(s1, t0), at(s0, t0)];
}

/** Flight-axis parameter of a plan point. */
function axisS(geo: StairGeo, p: V2): number {
  return (p[0] - geo.from[0]) * geo.dir[0] + (p[1] - geo.from[1]) * geo.dir[1];
}

/**
 * Every flight that was laid out, with the levels it joins. A flight whose
 * ends sit on one level links nothing: `stairsStage` already reports that.
 */
export function stairNavs(ctx: Ctx): StairNav[] {
  const raw: any[] = ((ctx.scene as any).stairs ?? []) as any[];
  const rooms = (ctx.rooms ?? []) as RoomRec[];
  const levelOf = (id: string): string => rooms.find((r) => r.id === id)?.level ?? "";
  const out: StairNav[] = [];
  for (const geo of placeStairs(ctx)) {
    if (geo.bad !== null) continue;
    const src = raw[geo.i] ?? {};
    const fromLevel = levelOf(String(src?.from?.room));
    const toLevel = levelOf(String(src?.to?.room));
    if (!fromLevel || !toLevel || fromLevel === toLevel) continue;
    out.push({
      geo,
      fromLevel,
      toLevel,
      ramp: {
        stair: geo.id,
        y0: geo.y0,
        y1: geo.y0 + geo.dy,
        axis: { from: geo.from, dir: Number(src?.from?.dir ?? 0), len: geo.len },
        poly: axisQuad(geo, 0, geo.len, -geo.width / 2, geo.width / 2),
      },
    });
  }
  return out;
}

/** How close to a flight's foot the flood has to get to take it (spec "Навигация"). */
const LINK_R = 0.3;

interface Obstacles {
  polys: V2[][];
  /**
   * Obstacles whose inflated shape has to be cut back to `keep`. A flight's
   * treads and rails are solid, but the capsule radius must not spill behind
   * the foot: the round end cap of the offset would wall off the only
   * approach to the stairs. The entry edge is left uneroded, exactly as the
   * exit edge of the cut above is (spec "Навигация").
   */
  clipped: Array<{ polys: V2[][]; keep: V2[] }>;
  solidProps: PropGeo[];
  body: V2[][];
}

function obstaclesOf(ctx: Ctx, level: string, base: number, mode: DoorMode = "scene"): Obstacles {
  const rooms = ((ctx.rooms ?? []) as RoomRec[]).filter((r) => r.level === level);
  const rawById = new Map<string, any>((((ctx.scene as any).rooms ?? []) as any[]).map((r) => [String(r.id), r]));
  const openings = ((ctx.openings ?? []) as OpeningGeo[]).filter((g) => !g.error && g.intervalLevel === level);

  // walls for the capsule: the uncut body minus only the openings it can pass
  // (not windows, sill steps or closed leaves). Patching cut openings back with
  // their chord rectangle would add a false obstacle on arcs
  const plan = ctx.levels?.get(level) as any;
  let body: Path64[] = plan?.body ?? [];
  if (plan?.bodyFull) {
    const leafed = leafDoorIds(ctx);
    const walk = new Set(openings.filter((g) => passes(g, mode, leafed)).map((g) => g.id));
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

  // A flight is solid in the level it rises from from the first tread the
  // capsule cannot step onto (top above `step_max`); the one below it is a
  // step, not a wall. Rails along the sides are solid over the whole run --
  // and where there is no rail there is a wall that close instead.
  const clipped: Array<{ polys: V2[][]; keep: V2[] }> = [];
  for (const sn of stairNavs(ctx)) {
    const g = sn.geo;
    const hw = g.width / 2;
    if (sn.fromLevel === level) {
      const flight: V2[][] = [];
      const k = Math.max(1, Math.ceil((STEP_MAX + EPS) / g.rise));
      const s0 = Math.min(g.len, (k - 1) * g.going);
      if (s0 < g.len - EPS) flight.push(asPositive(axisQuad(g, s0, g.len, -hw, hw)));
      if (hw > RAIL_BAR + EPS) {
        flight.push(asPositive(axisQuad(g, 0, g.len, hw - RAIL_BAR, hw)));
        flight.push(asPositive(axisQuad(g, 0, g.len, -hw, -hw + RAIL_BAR)));
      }
      const far = g.len + hw + CAPSULE_R + 1;
      if (flight.length > 0) {
        clipped.push({ polys: flight, keep: asPositive(axisQuad(g, 0, far, -far, far)) });
      }
    }
    // the hole the flight cut in the slab above is not floor on that level.
    // Its exit edge is left uneroded: the capsule has to be able to stand on
    // the top tread, which is flush with that edge (spec "Навигация")
    if (sn.toLevel === level && g.cut) {
      const ss = g.cut.map((p) => axisS(g, p));
      const a = Math.min(...ss);
      const b = Math.max(...ss) - CAPSULE_R;
      if (b > a + EPS) polys.push(asPositive(axisQuad(g, a, b, -hw, hw)));
    }
  }

  return { polys, clipped, solidProps, body: body.map(toPoly) };
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

function inflatePaths(polys: V2[][]): Path64[] {
  if (polys.length === 0) return [];
  const united = Clipper.union(polys.map(toPath), [], FillRule.NonZero);
  if (united.length === 0) return [];
  return Clipper.inflatePaths(united, Math.round(CAPSULE_R * 1000), JoinType.Round, EndType.Polygon, 2);
}

/**
 * The region the capsule centre may not enter: every obstacle grown by the
 * capsule radius, with each clipped group cut back to its own `keep` window.
 */
function blockedRegion(obs: Obstacles): V2[][] {
  let out = inflatePaths(obs.polys);
  for (const c of obs.clipped) {
    const grown = Clipper.intersect(inflatePaths(c.polys), [toPath(c.keep)], FillRule.NonZero);
    if (grown.length > 0) out = Clipper.union(out, grown, FillRule.NonZero);
  }
  return out.map(toPoly);
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

function buildLayer(ctx: Ctx, level: string, mode: DoorMode = "scene"): Layer | null {
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

  const blocked = blockedRegion(obstaclesOf(ctx, level, base, mode));
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

/**
 * One layer per level that has rooms, by ascending `y` with the spawn level
 * first: the page spawns in `layers[0]`, and so does every one-level scene.
 */
function buildLayers(ctx: Ctx): Layer[] {
  const rooms = (ctx.rooms ?? []) as RoomRec[];
  const levels = [...new Set(rooms.map((r) => r.level))];
  levels.sort((a, b) => levelY(ctx, a) - levelY(ctx, b));
  const spawn = spawnLevel(ctx);
  // a stable sort keeps the rest ascending
  levels.sort((a, b) => (a === spawn ? -1 : b === spawn ? 1 : 0));
  return levels.map((l) => buildLayer(ctx, l)).filter((l): l is Layer => l !== null);
}

/**
 * Per level with a door the page can move: the whole layer with every such
 * door open and with every one closed, and for each door the cells that differ
 * (a cell goes to the nearest door), so the page flips one door's cells in the
 * bitmap without a rebuild.
 */
function doorMasks(ctx: Ctx, layers: Layer[]): {
  masks: Map<string, { open: string; closed: string }>;
  doors: Record<string, { level: string; cells: number[] }>;
} {
  const leafed = leafDoorIds(ctx);
  const masks = new Map<string, { open: string; closed: string }>();
  const doors: Record<string, { level: string; cells: number[] }> = {};
  for (const layer of layers) {
    const mine = ((ctx.openings ?? []) as OpeningGeo[]).filter(
      (g) => !g.error && g.intervalLevel === layer.level && leafed.has(g.id),
    );
    if (mine.length === 0) continue;
    const open = buildLayer(ctx, layer.level, "open");
    const closed = buildLayer(ctx, layer.level, "closed");
    if (!open || !closed) continue;
    masks.set(layer.level, { open: packBits(open), closed: packBits(closed) });
    for (const g of mine) doors[g.id] = { level: layer.level, cells: [] };
    for (let n = 0; n < open.w * open.h; n++) {
      if (!open.walk[n] || closed.walk[n]) continue;
      const x = open.origin[0] + ((n % open.w) + 0.5) * CELL;
      const z = open.origin[1] + (Math.floor(n / open.w) + 0.5) * CELL;
      let best = mine[0];
      let bd = Infinity;
      for (const g of mine) {
        const d = Math.hypot(g.center[0] - x, g.center[1] - z);
        if (d < bd) {
          bd = d;
          best = g;
        }
      }
      doors[best.id].cells.push(n);
    }
  }
  return { masks, doors };
}

export function buildNav(ctx: Ctx): NavJson {
  const navs = stairNavs(ctx);
  const layers = buildLayers(ctx);
  const dm = doorMasks(ctx, layers);
  return {
    cell: CELL,
    capsule: { r: CAPSULE_R, h: CAPSULE_H, step_max: STEP_MAX },
    layers: layers.map((layer) => {
      const bits = packBits(layer);
      return {
        level: layer.level,
        y: layer.y,
        origin: [layer.origin[0], layer.origin[1]],
        w: layer.w,
        h: layer.h,
        bits,
        masks: dm.masks.get(layer.level) ?? { open: bits, closed: bits },
      };
    }),
    doors: dm.doors,
    ramps: navs.map((n) => n.ramp),
    links: navs.map((n) => ({ from: n.fromLevel, to: n.toLevel, via: n.geo.id })),
  };
}

/**
 * The cell the flood continues from on the level a flight climbs to: the top
 * tread's exit, or the first cell past it that is walkable.
 */
function seedCell(L: Layer, sn: StairNav): number | null {
  const steps = Math.ceil((CAPSULE_R + CELL) / CELL);
  for (let k = 0; k <= steps; k++) {
    const x = sn.geo.exit[0] + sn.geo.dir[0] * k * CELL;
    const z = sn.geo.exit[1] + sn.geo.dir[1] * k * CELL;
    const i = Math.floor((x - L.origin[0]) / CELL + 1e-9);
    const j = Math.floor((z - L.origin[1]) / CELL + 1e-9);
    if (i < 0 || j < 0 || i >= L.w || j >= L.h) continue;
    const n = j * L.w + i;
    if (L.walk[n] === 1) return n;
  }
  return null;
}

/**
 * The cell the flood continues from on the level a flight descends to: the
 * foot of the flight, or the first cell past it (away from the ramp) that is
 * walkable. A flight is walked in both directions (spec "Навигация").
 */
function footSeedCell(L: Layer, sn: StairNav): number | null {
  const steps = Math.ceil((CAPSULE_R + CELL) / CELL);
  for (let k = 0; k <= steps; k++) {
    const x = sn.ramp.axis.from[0] - sn.geo.dir[0] * k * CELL;
    const z = sn.ramp.axis.from[1] - sn.geo.dir[1] * k * CELL;
    const i = Math.floor((x - L.origin[0]) / CELL + 1e-9);
    const j = Math.floor((z - L.origin[1]) / CELL + 1e-9);
    if (i < 0 || j < 0 || i >= L.w || j >= L.h) continue;
    const n = j * L.w + i;
    if (L.walk[n] === 1) return n;
  }
  return null;
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

/** Like `isWalkable`, on the layer with every movable door `open` or `closed`. */
export function isWalkableMask(nav: NavJson, x: number, z: number, mask: "open" | "closed", level = "L0"): boolean {
  const layer = (nav.layers as any[]).find((l) => l.level === level);
  if (!layer) return false;
  const i = Math.floor((x - layer.origin[0]) / CELL + 1e-9);
  const j = Math.floor((z - layer.origin[1]) / CELL + 1e-9);
  if (i < 0 || j < 0 || i >= layer.w || j >= layer.h) return false;
  const n = j * layer.w + i;
  const bytes = Buffer.from(layer.masks[mask] as string, "base64");
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
  const layers = buildLayers(ctx);
  const nav = buildNav(ctx);
  ctx.nav = nav;
  const layer = layers.find((l) => l.level === level);
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

  // 4-connected flood from the spawn cell, crossing to another level by any
  // flight whose foot it reaches: a loft is not cut off, it is upstairs
  const navs = stairNavs(ctx);
  const seen = layers.map((l) => new Uint8Array(l.w * l.h));
  const reached = new Set<string>();
  const li0 = layers.indexOf(layer);
  const start = j * layer.w + i;
  seen[li0][start] = 1;
  const queue: Array<[number, number]> = [[li0, start]];
  const visit = (lj: number, m: number): void => {
    if (seen[lj][m] || layers[lj].walk[m] !== 1) return;
    seen[lj][m] = 1;
    queue.push([lj, m]);
  };
  for (let qi = 0; qi < queue.length; qi++) {
    const [li, n] = queue[qi];
    const L = layers[li];
    reached.add(`${L.level}/${L.roomOf[n]}`);
    const ci = n % L.w;
    const cj = (n - ci) / L.w;
    const step = (ni: number, nj: number): void => {
      if (ni < 0 || nj < 0 || ni >= L.w || nj >= L.h) return;
      visit(li, nj * L.w + ni);
    };
    step(ci + 1, cj);
    step(ci - 1, cj);
    step(ci, cj + 1);
    step(ci, cj - 1);
    const cx = L.origin[0] + (ci + 0.5) * CELL;
    const cz = L.origin[1] + (cj + 0.5) * CELL;
    for (const sn of navs) {
      if (sn.fromLevel === L.level && Math.hypot(cx - sn.ramp.axis.from[0], cz - sn.ramp.axis.from[1]) <= LINK_R) {
        const lj = layers.findIndex((x) => x.level === sn.toLevel);
        const seed = lj < 0 ? null : seedCell(layers[lj], sn);
        if (seed !== null) visit(lj, seed);
      }
      const exit = rampExit(sn.ramp);
      if (sn.toLevel === L.level && Math.hypot(cx - exit[0], cz - exit[1]) <= LINK_R) {
        const li2 = layers.findIndex((x) => x.level === sn.fromLevel);
        const seed = li2 < 0 ? null : footSeedCell(layers[li2], sn);
        if (seed !== null) visit(li2, seed);
      }
    }
  }

  const rawRooms: any[] = (ctx.scene as any).rooms ?? [];
  // a building seen only from outside (roof or facade, no opening of its own) is scenery: nobody walks in (as ROOM_UNREACHABLE)
  const opened = new Set<string>();
  for (const g of (ctx.openings ?? []) as OpeningGeo[]) if (!g.error) for (const sd of g.interval?.sides ?? []) opened.add(String(sd.room));
  const shell = (id: string): boolean => {
    const raw = rawRooms.find((x: any) => String(x?.id) === id);
    return !!raw && raw.open !== true && (!!raw.roof || typeof raw.facade === "string") && !opened.has(id);
  };
  for (const L of layers) {
    L.rooms.forEach((r, k) => {
      if (reached.has(`${L.level}/${k}`) || shell(r.id)) return;
      const idx = rawRooms.findIndex((x: any) => String(x?.id) === r.id);
      const path = `/rooms/${idx < 0 ? 0 : idx}`;
      issues.push({
        code: "NAV_ROOM_CUT",
        stage: STAGE,
        path,
        msg: msg("NAV_ROOM_CUT", { room: r.id, path, r: String(CAPSULE_R) }),
      });
    });
  }
  return issues;
}
