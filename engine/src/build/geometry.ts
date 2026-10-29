import type { Ctx } from "../ctx.js";
import type { V2 } from "../geom/vec.js";
import type { Interval, LevelPlan } from "../plan/merge.js";
import type { OpeningGeo } from "../openings/resolve.js";
import { grayOf } from "./color.js";
import { horizontalFace } from "./floors.js";
import { boxMesh } from "./beams.js";
import { EXTERIOR, intervalMeshes } from "./walls.js";
import type { WallRoom } from "./walls.js";
import { meshBBox } from "./mesh.js";

export { meshBBox };

export interface Mesh {
  id: string;
  kind: "floor" | "ceiling" | "wall" | "band" | "reveal" | "beam" | "prop" | "decal" | "leaf" | "backdrop" | "cap";
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
}

export interface MaterialDef {
  color: string;
  map?: string;
  repeat_m?: number;
  transparent?: boolean;
}

export type Light =
  | { kind: "point"; pos: [number, number, number]; color: string; power: number }
  | { kind: "hemi"; pos?: [number, number, number]; color: string; power: number };

export interface Camera {
  id: string;
  ref?: string;
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
}

/** Scene materials, `$exterior` and the asset placeholders, keyed by mesh material id. */
export function materialTable(scene: any): Record<string, MaterialDef> {
  // a plain object trips on an id literally named "__proto__" (it would set
  // the prototype instead of an own property, F21); Object.create(null)
  // has no such accessor in its chain
  const out: Record<string, MaterialDef> = Object.create(null) as Record<string, MaterialDef>;
  for (const [id, m] of Object.entries((scene.materials ?? {}) as Record<string, any>)) {
    if (id === EXTERIOR) throw new Error(`material id "${EXTERIOR}" is reserved`);
    if (typeof m?.tile === "string") out[id] = { color: grayOf(id), repeat_m: m.repeat_m ?? 1.0 };
    else out[id] = { color: String(m?.color) };
  }
  for (const [id, a] of Object.entries((scene.assets ?? {}) as Record<string, any>)) {
    if (id === EXTERIOR) throw new Error(`asset id "${EXTERIOR}" is reserved`);
    if (Object.prototype.hasOwnProperty.call(out, id)) {
      throw new Error(`material and asset share the id "${id}"`);
    }
    if (a?.kind === "tile") continue;
    out[id] = a?.kind === "decal" ? { color: grayOf(id), transparent: true } : { color: grayOf(id) };
  }
  out[EXTERIOR] = { color: String(scene.style?.exterior ?? "#808080") };
  return out;
}

export function buildGeometry(ctx: Ctx): Geometry {
  const scene: any = ctx.scene;
  const meshes: Mesh[] = [];
  const levelY = new Map<string, number>();
  for (const l of (scene.levels ?? []) as any[]) levelY.set(String(l.id), Number(l.y ?? 0));
  const sceneRoom = new Map<string, any>();
  for (const r of (scene.rooms ?? []) as any[]) sceneRoom.set(String(r.id), r);
  const geoRooms = (ctx.rooms ?? []) as any[];

  const floors: Geometry["floors"] = [];
  for (const r of geoRooms) {
    const src = sceneRoom.get(r.id);
    const y = levelY.get(String(r.level)) ?? 0;
    floors.push({ room: r.id, level: r.level, y, outline: r.outline });
    meshes.push(horizontalFace(`${r.id}:floor`, "floor", String(src.floor), r.id, r.outline, y));
    meshes.push(horizontalFace(`${r.id}:ceiling`, "ceiling", String(src.ceiling), r.id, r.outline, y + Number(r.height)));
  }

  // walls, per level plan: one body per interval, one face per side
  const counters = new Map<string, number>();
  const next = (key: string): number => {
    const k = counters.get(key) ?? 0;
    counters.set(key, k + 1);
    return k;
  };
  const caps = { k: 0 };
  const openings = (ctx.openings ?? []) as OpeningGeo[];
  for (const [levelId, plan] of (ctx.levels ?? new Map<string, LevelPlan>())) {
    const y = levelY.get(String(levelId)) ?? 0;
    (plan.intervals as Interval[]).forEach((iv, n) => {
      const own = openings.filter((o) => o.intervalLevel === levelId && o.intervalIndex === n && !o.error);
      meshes.push(
        ...intervalMeshes(iv, { levelY: y, openings: own, caps, room: (s) => wallRoom(s, sceneRoom, geoRooms) }, next),
      );
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

  const spawnRoom = geoRooms.find((r) => r.id === String(scene.spawn?.room));
  const spawnY = levelY.get(String(spawnRoom?.level)) ?? 0;

  return {
    version: 0,
    meshes,
    floors,
    materials: materialTable(scene),
    lights: (scene.lights ?? []) as Light[],
    cameras: (scene.cameras ?? []) as Camera[],
    spawn: { at: scene.spawn.at as V2, y: spawnY, yaw: Number(scene.spawn.yaw ?? 0) },
    style: { ambient: Number(scene.style?.ambient ?? 1.0), exterior: String(scene.style?.exterior ?? "#808080") },
  };
}

function wallRoom(side: { room: string; edge: number }, sceneRoom: Map<string, any>, geoRooms: any[]): WallRoom {
  const src = sceneRoom.get(side.room);
  const geo = geoRooms.find((r) => r.id === side.room);
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
  };
}
