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
  const scene: any = ctx.scene;
  const raws = (scene.decals ?? []) as any[];
  const out: Mesh[] = [];
  for (const d of (ctx.passport.decals ?? []) as PassDecal[]) {
    const raw = raws[d.i];
    if (!raw) continue;
    const n: V3 = [d.normal[0], 0, d.normal[1]];
    // the in-plan perpendicular of a unit normal is already unit length
    const u: V3 = [-d.normal[1], 0, d.normal[0]];
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
