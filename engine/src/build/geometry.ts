import { scatterEntries, type ScatterEntry } from "./scatter.js";
import type { Ctx } from "../ctx.js";
import type { V2 } from "../geom/vec.js";
import { EPS } from "../geom/vec.js";
import { FREE, freeWalls, resolveGlassIds } from "../plan/merge.js";
import { overlapArea } from "../plan/rooms.js";
import type { FreeWall, Interval, LevelPlan } from "../plan/merge.js";
import type { OpeningGeo } from "../openings/resolve.js";
import { grayOf } from "./color.js";
import { horizontalFace } from "./floors.js";
import { boxMesh } from "./beams.js";
import { EXTERIOR, intervalMeshes } from "./walls.js";
import type { WallRoom } from "./walls.js";
import { meshBBox } from "./mesh.js";
import { propMeshes } from "./props.js";
import { decalMeshes } from "./decals.js";
import { sunOf, type SunLight } from "./lights.js";
import { doorMeshes } from "./doors.js";
import { fixtureMeshes } from "./fixtures.js";
import { stairMeshes } from "./stairs.js";
import { extrudeFace, footprintsOverlap } from "./slab.js";
import { roofMeshes } from "./roof.js";
import type { StairGeo } from "../stairs/place.js";

export { meshBBox };

export interface Mesh {
  id: string;
  kind:
    | "floor"
    | "ceiling"
    | "roof"
    | "wall"
    | "band"
    | "reveal"
    | "beam"
    | "fixture"
    | "prop"
    | "decal"
    | "leaf"
    | "backdrop"
    | "cap"
    | "step"
    | "rail"
    | "slab";
  material: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  room?: string;
  side?: string;
  glb?: string;
  glbPos?: [number, number, number];
  glbYaw?: number;
  scale?: number;
  /** vertical scale of a flat prop when it differs from `scale` (see props.ts) */
  scaleY?: number;
}

export interface MaterialDef {
  color: string;
  map?: string;
  repeat_m?: number;
  transparent?: boolean;
}

export type Light =
  | { kind: "point"; pos: [number, number, number]; color: string; power: number }
  | { kind: "hemi"; pos?: [number, number, number]; color: string; power: number }
  | SunLight;

export interface Camera {
  id: string;
  /** `null` once `build` has looked for the ref file and not found it. */
  ref?: string | null;
  pos: [number, number, number];
  look?: [number, number, number];
  fov: number;
}

export interface Geometry {
  version: 0;
  meshes: Mesh[];
  floors: { room: string; level: string; y: number; outline: V2[] }[];
  materials: Record<string, MaterialDef>;
  lights: Light[];
  cameras: Camera[];
  spawn: { at: V2; y: number; yaw: number };
  style: { ambient: number; exterior: string };
  /** sky dome + fading ground disc, only for a scene with `outdoor` (В2) */
  outdoor?: Outdoor;
  /** `scatter` sets, one InstancedMesh per entry (spec "scatter") */
  scatter?: ScatterEntry[];
  scatterWarnings?: string[];
}

export interface Outdoor {
  sky: {
    asset: string;
    /** `dist/assets` file of the panorama, null when it is a placeholder */
    file: string | null;
    /** dome radius, always past the ground's edge */
    radius: number;
    /** vertical gradient stand-in for `--assets none`: zenith → horizon */
    fallback: { top: string; bottom: string };
  };
  ground: { material: string; radius: number; fade: number; y: number };
}

/** The ground sits this far under the yards' floors so the two never z-fight. */
const GROUND_DROP = 0.01;

function mixHex(a: string, b: string, t: number): string {
  const p = (h: string): number[] => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h);
    const v = m ? parseInt(m[1], 16) : 0x808080;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const [x, y] = [p(a), p(b)];
  return `#${x.map((c, i) => Math.round(c * (1 - t) + y[i] * t).toString(16).padStart(2, "0")).join("")}`;
}

function outdoorOf(scene: any, assetFiles: AssetFiles, levelY: Map<string, number>): Outdoor | undefined {
  const od = scene.outdoor;
  if (!od || typeof od !== "object") return undefined;
  const radius = Number(od.ground?.radius ?? 100);
  // the ground lies under the lowest yard floor (or level 0 when there is none)
  const yardYs = ((scene.rooms ?? []) as any[])
    .filter((r) => r?.open === true)
    .map((r) => levelY.get(String(r.level)) ?? 0);
  const floorY = yardYs.length > 0 ? Math.min(...yardYs) : 0;
  const exterior = String(scene.style?.exterior ?? "#808080");
  return {
    sky: {
      asset: String(od.sky),
      file: assetFiles[String(od.sky)] ?? null,
      radius: radius * 1.5,
      fallback: { top: exterior, bottom: mixHex(exterior, "#ffffff", 0.5) },
    },
    ground: { material: String(od.ground?.material), radius, fade: Number(od.ground?.fade ?? 0), y: floorY - GROUND_DROP },
  };
}

/** Asset ids that `--assets cache`/`live` resolved, each pointing at its `dist/assets/<id>.*` file. */
export type AssetFiles = Record<string, string>;

/** Each object asset's own bound after normalization, keyed by asset id. */
export type GlbSizes = Record<string, { w: number; d: number; h: number }>;

/** Scene materials, `$exterior`, the asset placeholders and glass variants of
 *  free walls, keyed by mesh material id. */
export function materialTable(
  scene: any,
  assetFiles: AssetFiles = {},
  free: FreeWall[] = [],
  glassIds: Map<number, string> = new Map(),
): Record<string, MaterialDef> {
  // a plain object trips on an id literally named "__proto__" (it would set
  // the prototype instead of an own property, F21); Object.create(null)
  // has no such accessor in its chain
  const out: Record<string, MaterialDef> = Object.create(null) as Record<string, MaterialDef>;
  for (const [id, m] of Object.entries((scene.materials ?? {}) as Record<string, any>)) {
    if (id === EXTERIOR) throw new Error(`material id "${EXTERIOR}" is reserved`);
    if (typeof m?.tile === "string") {
      out[id] = { color: grayOf(id), repeat_m: m.repeat_m ?? 1.0, ...(assetFiles[m.tile] ? { map: assetFiles[m.tile] } : {}) };
    } else out[id] = { color: String(m?.color) };
  }
  for (const [id, a] of Object.entries((scene.assets ?? {}) as Record<string, any>)) {
    if (id === EXTERIOR) throw new Error(`asset id "${EXTERIOR}" is reserved`);
    if (Object.prototype.hasOwnProperty.call(out, id)) {
      throw new Error(`material and asset share the id "${id}"`);
    }
    if (a?.kind === "tile") continue;
    out[id] =
      a?.kind === "decal"
        ? { color: grayOf(id), transparent: true, ...(assetFiles[id] ? { map: assetFiles[id] } : {}) }
        : { color: grayOf(id) };
  }
  out[EXTERIOR] = { color: String(scene.style?.exterior ?? "#808080") };
  for (const w of free) {
    const id = glassIds.get(w.i);
    if (!id) continue;
    const base = out[w.material] ?? { color: grayOf(w.material) };
    out[id] = { ...base, transparent: true };
  }
  return out;
}

export function buildGeometry(ctx: Ctx, assetFiles: AssetFiles = {}, glbSizes: GlbSizes = {}): Geometry {
  const scene: any = ctx.scene;
  const meshes: Mesh[] = [];
  const levelY = new Map<string, number>();
  for (const l of (scene.levels ?? []) as any[]) levelY.set(String(l.id), Number(l.y ?? 0));
  const sceneRoom = new Map<string, any>();
  for (const r of (scene.rooms ?? []) as any[]) sceneRoom.set(String(r.id), r);
  const geoRooms = (ctx.rooms ?? []) as any[];

  // a stairwell cut goes through the slab under `to.room`, that room's own
  // floor, and the ceiling of the room the flight runs in (spec "Лестницы")
  const floorCuts = new Map<string, V2[][]>();
  const ceilCuts = new Map<string, V2[][]>();
  const add = (m: Map<string, V2[][]>, room: string, cut: V2[]): void => {
    const list = m.get(room) ?? [];
    list.push(cut);
    m.set(room, list);
  };
  for (const g of ((ctx as any).stairs ?? []) as StairGeo[]) {
    if (g.bad || !g.cut) continue;
    const src = ((scene.stairs ?? []) as any[])[g.i] ?? {};
    add(floorCuts, String(src.to?.room), g.cut);
    add(ceilCuts, String(src.from?.room), g.cut);
  }

  const floors: Geometry["floors"] = [];
  for (const r of geoRooms) {
    const src = sceneRoom.get(r.id);
    const y = levelY.get(String(r.level)) ?? 0;
    floors.push({ room: r.id, level: r.level, y, outline: r.outline });
    meshes.push(horizontalFace(`${r.id}:floor`, "floor", String(src.floor), r.id, r.outline, y, floorCuts.get(r.id) ?? []));
    if (src.open === true) continue;
    meshes.push(
      horizontalFace(`${r.id}:ceiling`, "ceiling", String(src.ceiling), r.id, r.outline, y + Number(r.height), ceilCuts.get(r.id) ?? []),
    );
    if (src.roof && typeof src.roof === "object") meshes.push(...roofMeshes(r.id, src.roof, r.outline, y + Number(r.height)));
    // the slab a room on an upper level stands on, between it and the ceiling
    // of the room below: footprint × [y − slab, y] (spec "Уровни"), ends in
    // `exterior`
    const below = slabUnder(r, y, geoRooms, levelY);
    if (below !== null) {
      meshes.push(
        extrudeFace({ id: `${r.id}:slab`, kind: "slab", material: EXTERIOR, room: r.id }, r.outline, floorCuts.get(r.id) ?? [], below, y),
      );
    }
  }

  // walls, per level plan: one body per interval, one face per side
  const counters = new Map<string, number>();
  const next = (key: string): number => {
    const k = counters.get(key) ?? 0;
    counters.set(key, k + 1);
    return k;
  };
  const caps = { k: 0 };
  // kept apart too: a stair rail measures its clearance against these faces
  const wallMeshes = new Map<string, Mesh[]>();
  const openings = (ctx.openings ?? []) as OpeningGeo[];
  const free = freeWalls(scene, geoRooms);
  // materialTable also keys entries off scene.assets (F6): a glass variant
  // id must dodge those too, or it overwrites an asset's own map/color
  const glassIds = resolveGlassIds(free, [
    ...Object.keys(scene.materials ?? {}),
    ...Object.keys(scene.assets ?? {}),
  ]);
  for (const [levelId, plan] of (ctx.levels ?? new Map<string, LevelPlan>())) {
    const y = levelY.get(String(levelId)) ?? 0;
    (plan.intervals as Interval[]).forEach((iv, n) => {
      // a yard has no walls: an interval only yards border is not built
      if (iv.sides.every((s) => sceneRoom.get(s.room)?.open === true)) return;
      const own = openings.filter((o) => o.intervalLevel === levelId && o.intervalIndex === n && !o.error);
      const built = intervalMeshes(
        iv,
        { levelY: y, openings: own, caps, room: (s) => wallRoom(s, sceneRoom, geoRooms, free, glassIds) },
        next,
      );
      const list = wallMeshes.get(String(levelId)) ?? [];
      list.push(...built);
      wallMeshes.set(String(levelId), list);
      meshes.push(...built);
    });
  }

  // beams hang under their room's ceiling
  for (const r of geoRooms) {
    const src = sceneRoom.get(r.id);
    const y = levelY.get(String(r.level)) ?? 0;
    const top = y + Number(r.height);
    ((src.beams ?? []) as any[]).forEach((b, i) => {
      meshes.push(
        boxMesh(`${r.id}:beam:${i}`, "beam", String(b.material), r.id, b.from as V2, b.to as V2, Number(b.w), top - Number(b.h), top),
      );
    });
  }

  // things: props, decals, door leaves and backdrops
  meshes.push(...fixtureMeshes(ctx), ...propMeshes(ctx, assetFiles, glbSizes), ...decalMeshes(ctx), ...doorMeshes(ctx));
  meshes.push(
    ...stairMeshes(ctx, {
      sceneRoom,
      walls: (level) => wallMeshes.get(level) ?? [],
      levelY: (id) => levelY.get(String(geoRooms.find((r) => r.id === id)?.level)) ?? 0,
    }),
  );

  const spawnRoom = geoRooms.find((r) => r.id === String(scene.spawn?.room));
  const spawnY = levelY.get(String(spawnRoom?.level)) ?? 0;

  const sc = scatterEntries(scene, assetFiles, glbSizes);

  return {
    version: 0,
    meshes,
    floors,
    ...(sc.entries.length > 0 ? { scatter: sc.entries, scatterWarnings: sc.warnings } : {}),
    materials: materialTable(scene, assetFiles, free, glassIds),
    // a sun keeps only dir/intensity/castShadow: the schema's color/power defaults are not its fields
    lights: ((scene.lights ?? []) as any[]).map((l) => (l?.kind === "sun" ? sunOf(l) : l)) as Light[],
    cameras: ((scene.cameras ?? []) as Camera[]).map((c) => ({ ...c })),
    spawn: { at: scene.spawn.at as V2, y: spawnY, yaw: Number(scene.spawn.yaw ?? 0) },
    style: { ambient: Number(scene.style?.ambient ?? 1.0), exterior: String(scene.style?.exterior ?? "#808080") },
    ...(scene.outdoor ? { outdoor: outdoorOf(scene, assetFiles, levelY) } : {}),
  };
}

function wallRoom(
  side: { room: string; edge: number },
  sceneRoom: Map<string, any>,
  geoRooms: any[],
  free: FreeWall[],
  glassIds: Map<number, string>,
): WallRoom {
  if (side.room === FREE) {
    const w = free[side.edge];
    const dx = w.to[0] - w.from[0];
    const dz = w.to[1] - w.from[1];
    const l = Math.hypot(dx, dz) || 1;
    // a free wall has no inside: either perpendicular will do, the opposite
    // face is then drawn by the single-side branch of intervalMeshes
    return {
      id: w.id,
      height: w.top,
      normalIn: [-dz / l, dx / l],
      wallMaterial: w.glass ? glassIds.get(w.i) ?? w.material : w.material,
      bands: [],
    };
  }
  const src = sceneRoom.get(side.room);
  const geo = geoRooms.find((r) => r.id === side.room);
  if (src.open === true) {
    // a yard side of a shared wall: no height of its own, the wall takes the house room's
    return { id: String(src.id), height: 0, normalIn: geo.edges.find((e: any) => e.i === side.edge)?.normalIn ?? geo.edges[0].normalIn, wallMaterial: EXTERIOR, bands: [] };
  }
  const edge = geo.edges.find((e: any) => e.i === side.edge) ?? geo.edges[0];
  const override = (src.edges ?? {})[String(side.edge)];
  const bands = ((src.walls?.bands ?? []) as any[]).map((b) => ({ to: Number(b.to), material: String(b.material) }));
  // a closed full-circle room has a single edge whose `normalIn` is fixed by
  // convention to the outward radial at az=0 (rooms.ts), the opposite of the
  // inward convention every other edge uses (F2)
  const fullCircle = edge.arc != null && Math.abs(Math.abs(edge.arc.sweep ?? 0) - 2 * Math.PI) < 1e-6;
  const normalIn: V2 = fullCircle ? [-edge.normalIn[0], -edge.normalIn[1]] : (edge.normalIn as V2);
  return {
    id: String(src.id),
    height: Number(src.height),
    normalIn,
    wallMaterial: String(override?.material ?? src.walls?.material ?? EXTERIOR),
    bands,
    ...(typeof src.facade === "string" ? { facade: String(src.facade) } : {}),
  };
}

/**
 * Underside of the slab a room stands on: the top of the ceiling of the room
 * below it. "Below" is any room on the nearest lower level whose footprint
 * shares positive area with this one — a room may hang half off the one under
 * it, so touching corners or a contained centroid are neither necessary nor
 * sufficient. Whether the area is positive is decided exactly
 * (`footprintsOverlap`), not by the millimetre-rounded `overlapArea`, which
 * only ranks the candidates: where several qualify, the largest overlap wins,
 * the first in `rooms` on a tie.
 */
function slabUnder(r: any, y: number, geoRooms: any[], levelY: Map<string, number>): number | null {
  let bestY = -Infinity;
  for (const ly of levelY.values()) if (ly < y - EPS && ly > bestY) bestY = ly;
  if (!Number.isFinite(bestY)) return null;
  let top: number | null = null;
  let bestArea = 0;
  for (const other of geoRooms) {
    if ((levelY.get(String(other.level)) ?? 0) !== bestY) continue;
    if (!footprintsOverlap(r.outline as V2[], other.outline as V2[])) continue;
    const ceil = bestY + Number(other.height);
    if (ceil >= y - EPS) continue;
    const area = overlapArea(r.outline as V2[], other.outline as V2[]);
    if (top !== null && area <= bestArea) continue;
    bestArea = area;
    top = ceil;
  }
  return top;
}
