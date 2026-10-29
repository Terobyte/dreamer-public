import type { Ctx } from "../ctx.js";
import type { V2 } from "../geom/vec.js";
import type { AssetFiles, GlbSizes, Mesh } from "./geometry.js";
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
export function propMeshes(ctx: Ctx, assetFiles: AssetFiles = {}, glbSizes: GlbSizes = {}): Mesh[] {
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
    const asset = String(raws[g.src]?.asset);
    const mesh = boxMesh(p.id, "prop", asset, g.room, from, to, w, p.y[0], p.y[1]);
    // An asset the cache could not provide leaves the box alone: the prop
    // stays an OBB placeholder and `build.json` says so (missing asset).
    const file = assetFiles[asset];
    if (file !== undefined) {
      mesh.glb = file;
      // the normalized GLB sits centred on its footprint with its bottom on
      // y = 0, so the page only needs the box's centre, its floor and the
      // depth axis the passport already fixed
      mesh.glbPos = [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, p.y[0], (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4];
      mesh.glbYaw = Math.atan2(to[0] - from[0], to[1] - from[1]);
      // uniform scale off the prop's height alone: `h` is the dimension the
      // author is held to, and fitting the widest axis instead would shrink
      // a prop whose generated model happens to have a broad base
      const size = glbSizes[asset];
      if (size !== undefined && size.h > 0) mesh.scale = (p.y[1] - p.y[0]) / size.h;
    }
    out.push(mesh);
  }
  return out;
}
