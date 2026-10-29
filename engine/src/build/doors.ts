import type { Ctx } from "../ctx.js";
import type { V2 } from "../geom/vec.js";
import type { OpeningGeo } from "../openings/resolve.js";
import type { Mesh } from "./geometry.js";
import { boxMesh } from "./beams.js";
import { planeMesh } from "./mesh.js";
import type { V3 } from "./mesh.js";

/** Leaf thickness; the plan fixes it instead of the spec's "face + 0.02". */
const LEAF = 0.04;
/** How far behind the outer wall face an `outside` backdrop hangs. */
const BACKDROP_BACK = 1.0;
/** Margin the backdrop adds on each side so the opening never frames its edge. */
const BACKDROP_MARGIN = 0.2;

/** Door leaves and `outside` backdrops, one mesh each. */
export function doorMeshes(ctx: Ctx): Mesh[] {
  const scene: any = ctx.scene;
  const raws = new Map<string, any>();
  for (const o of (scene.openings ?? []) as any[]) raws.set(String(o.id), o);

  const out: Mesh[] = [];
  for (const g of (ctx.openings ?? []) as OpeningGeo[]) {
    if (g.error) continue;
    const raw = raws.get(g.id);
    if (!raw) continue;
    const y0 = g.sill;
    const y1 = g.sill + g.height;

    const decal = raw.leaf?.decal;
    if (g.kind === "door" && typeof decal === "string") {
      // open: perpendicular to the wall, from the hinge into the swing room, so
      // the leaf lands exactly on the end of the passport's swing sector.
      // closed: in the opening, along the wall axis
      const sector = g.sector;
      const from: V2 = sector && g.hingeAt ? g.hingeAt : g.ends[0];
      const to: V2 = sector && g.hingeAt ? (sector[sector.length - 1] as V2) : g.ends[1];
      out.push(
        boxMesh(`${g.id}:leaf`, "leaf", decal, String(g.swing ?? g.rooms[0]), from, to, LEAF, y0, y1),
      );
    }

    const backdrop = raw.outside?.backdrop;
    if (typeof backdrop === "string") {
      // `normalIn` points into rooms[0]; the backdrop sits that far out behind
      // the outer face and looks back in
      const n: V3 = [g.normalIn[0], 0, g.normalIn[1]];
      const d = g.thickness / 2 + BACKDROP_BACK;
      const center: V3 = [g.center[0] - n[0] * d, (y0 + y1) / 2, g.center[1] - n[2] * d];
      const u: V3 = [g.axis[0], 0, g.axis[1]];
      out.push(
        planeMesh(
          { id: `${g.id}:outside`, kind: "backdrop", material: backdrop, room: String(g.rooms[0]) },
          center,
          n,
          u,
          g.width / 2 + BACKDROP_MARGIN,
          g.height / 2 + BACKDROP_MARGIN,
        ),
      );
    }
  }
  return out;
}
