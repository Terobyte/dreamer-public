import type { Ctx } from "../ctx.js";
import type { V2 } from "../geom/vec.js";
import type { Mesh } from "./geometry.js";
import { boxMesh } from "./beams.js";

interface PassProp {
  id: string;
  obb: V2[];
  y: [number, number];
}

/**
 * One placeholder box per placed prop (and per `around` copy). Every number
 * comes from the passport: the build layer never re-runs placement, so a
 * drift between `check` and `build` surfaces as geometry, not as two
 * placement algorithms quietly disagreeing.
 */
export function propMeshes(ctx: Ctx): Mesh[] {
  const scene: any = ctx.scene;
  const raws = (scene.props ?? []) as any[];
  const geo = new Map<string, { room: string; src: number }>();
  for (const p of ctx.props ?? []) geo.set(p.id, { room: p.room, src: p.src });

  const out: Mesh[] = [];
  for (const p of (ctx.passport.props ?? []) as PassProp[]) {
    const g = geo.get(p.id);
    if (!g) continue;
    const c = p.obb;
    if (c.length !== 4) continue;
    // the box is the OBB extruded in y: run it along the local depth axis,
    // from the midpoint of one width edge to the midpoint of the opposite one
    const from: V2 = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
    const to: V2 = [(c[3][0] + c[2][0]) / 2, (c[3][1] + c[2][1]) / 2];
    const w = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]);
    out.push(boxMesh(p.id, "prop", String(raws[g.src]?.asset), g.room, from, to, w, p.y[0], p.y[1]));
  }
  return out;
}
