import type { Ctx } from "../ctx.js";
import type { Mesh } from "./geometry.js";
import { planeMesh } from "./mesh.js";
import type { V3 } from "./mesh.js";

interface PassDecal {
  i: number;
  edge: string;
  center: [number, number, number];
  normal: [number, number];
}

/** A flat quad per decal, exactly at the passport centre (inner face + 0.02). */
export function decalMeshes(ctx: Ctx): Mesh[] {
  const out: Mesh[] = floorDecals(ctx).map(floorMesh);
  const scene: any = ctx.scene;
  const raws = (scene.decals ?? []) as any[];
  for (const d of (ctx.passport.decals ?? []) as PassDecal[]) {
    const raw = raws[d.i];
    if (!raw) continue;
    const n: V3 = [d.normal[0], 0, d.normal[1]];
    // the in-plan perpendicular of a unit normal is already unit length; it must point to the right of a
    // viewer facing the wall (looking along -n), or every picture with text on a wall reads mirrored
    const u: V3 = [d.normal[1], 0, -d.normal[0]];
    out.push(
      planeMesh(
        { id: `decal.${d.i}`, kind: "decal", material: String(raw.asset), room: String(raw.room) },
        d.center as V3,
        n,
        u,
        Number(raw.size.w) / 2,
        Number(raw.size.h) / 2,
      ),
    );
  }
  return out;
}

/** a decal lying on the floor sits this far above it, so the two never z-fight */
export const FLOOR_LIFT = 0.005;

/** a floor decal: `at` + `rotation` instead of `on` (a bare `at` still snaps to a wall) */
export function isFloorDecal(raw: any): boolean {
  return !!raw && Array.isArray(raw.at) && typeof raw.rotation === "number" && raw.on === undefined;
}

export interface FloorDecal {
  i: number;
  asset: string;
  room: string;
  center: V3;
  normal: V3;
  /** in-plan width axis, turned by `rotation` degrees about +Y */
  u: V3;
  size: { w: number; h: number };
  rotation: number;
}

/** Every floor decal of the scene, on its room's floor + FLOOR_LIFT. */
export function floorDecals(ctx: Ctx): FloorDecal[] {
  const scene: any = ctx.scene;
  const out: FloorDecal[] = [];
  ((scene.decals ?? []) as any[]).forEach((raw, i) => {
    if (!isFloorDecal(raw)) return;
    const room = String(raw.room ?? "");
    const rec = ((ctx.rooms ?? []) as any[]).find((r) => r.id === room);
    if (!rec) return;
    const lvl = ((scene.levels ?? []) as any[]).find((l) => String(l?.id) === String(rec.level));
    const y = (typeof lvl?.y === "number" ? lvl.y : 0) + FLOOR_LIFT;
    const a = (Number(raw.rotation) * Math.PI) / 180;
    out.push({
      i,
      asset: String(raw.asset),
      room,
      center: [Number(raw.at[0]), y, Number(raw.at[1])],
      normal: [0, 1, 0],
      u: [Math.cos(a), 0, -Math.sin(a)],
      size: { w: Number(raw.size.w), h: Number(raw.size.h) },
      rotation: Number(raw.rotation),
    });
  });
  return out;
}

/** a flat quad facing up: `w` along `u`, `h` along the in-plan perpendicular */
function floorMesh(d: FloorDecal): Mesh {
  const [ux, , uz] = d.u;
  const v: [number, number] = [-uz, ux];
  const hw = d.size.w / 2;
  const hh = d.size.h / 2;
  const c = d.center;
  const at = (sw: number, sh: number): V3 => [c[0] + ux * sw * hw + v[0] * sh * hh, c[1], c[2] + uz * sw * hw + v[1] * sh * hh];
  const p: V3[] = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
  const positions = p.flat();
  const normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  // wind the pair of triangles to face +Y
  const a = [p[1][0] - p[0][0], p[1][2] - p[0][2]];
  const b = [p[2][0] - p[0][0], p[2][2] - p[0][2]];
  const up = a[1] * b[0] - a[0] * b[1] > 0;
  const indices = up ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  return { id: `decal.${d.i}`, kind: "decal", material: d.asset, room: d.room, positions, normals, uvs, indices };
}
