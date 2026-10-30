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

  const levelY = new Map<string, number>();
  for (const l of (scene.levels ?? []) as any[]) levelY.set(String(l.id), Number(l.y ?? 0));

  const out: Mesh[] = [];
  for (const g of (ctx.openings ?? []) as OpeningGeo[]) {
    if (g.error) continue;
    const raw = raws.get(g.id);
    if (!raw) continue;
    // `sill` is measured from the level floor (as in the wall reveals);
    // add the level base or an L1 leaf hangs at y=0
    const base = levelY.get(String((g as any).intervalLevel)) ?? 0;
    const y0 = base + g.sill;
    const y1 = base + g.sill + g.height;

    const decal = raw.leaf?.decal;
    if (g.kind === "window" && typeof decal === "string") {
      // a window has no swing leaf: the decal hangs on both faces of the wall
      const nIn: V3 = [g.normalIn[0], 0, g.normalIn[1]];
      const u: V3 = [g.axis[0], 0, g.axis[1]];
      const cy = y0 + g.height / 2;
      const off = g.thickness / 2 + 0.005;
      const cIn: V3 = [g.center[0] + nIn[0] * off, cy, g.center[1] + nIn[2] * off];
      out.push(
        planeMesh(
          { id: `${g.id}:leaf:in`, kind: "leaf", material: decal, room: String(g.rooms[0]) },
          cIn,
          nIn,
          u,
          g.width / 2,
          g.height / 2,
        ),
      );
      const nOut: V3 = [-nIn[0], 0, -nIn[2]];
      const cOut: V3 = [g.center[0] - nIn[0] * off, cy, g.center[1] - nIn[2] * off];
      out.push(
        planeMesh(
          { id: `${g.id}:leaf:out`, kind: "leaf", material: decal, room: String(g.rooms[1] ?? g.rooms[0]) },
          cOut,
          nOut,
          u,
          g.width / 2,
          g.height / 2,
        ),
      );
    }
    if (g.kind === "door" && typeof decal === "string") {
      // open: perpendicular to the wall, from the hinge into the swing room, so
      // the leaf lands exactly on the end of the passport's swing sector.
      // closed: on the inner face, from the hinge to the far jamb — the same
      // plane and hinge the runtime turns the leaf about (`doorDefs` below),
      // so opening never jumps the leaf off its pivots
      const sector = g.sector;
      let from: V2;
      let to: V2;
      if (sector && g.hingeAt) {
        from = g.hingeAt;
        to = sector[sector.length - 1] as V2;
      } else if (g.hingeAt) {
        const k = g.swing === g.rooms[0] || g.swing === null ? 1 : -1;
        const n: V2 = [g.normalIn[0] * k, g.normalIn[1] * k];
        const h = g.hingeAt;
        const d = (e: V2): number => Math.hypot(e[0] - h[0], e[1] - h[1]);
        const far = d(g.ends[0]) >= d(g.ends[1]) ? g.ends[0] : g.ends[1];
        from = h;
        to = [far[0] + n[0] * (g.thickness / 2), far[1] + n[1] * (g.thickness / 2)];
      } else {
        from = g.ends[0];
        to = g.ends[1];
      }
      out.push(
        boxMesh(`${g.id}:leaf`, "leaf", decal, String(g.swing ?? g.rooms[0]), from, to, LEAF, y0, y1, "unit"),
      );
      // the handle rides the edge opposite the hinge, so it swings with the leaf
      const lx = to[0] - from[0];
      const lz = to[1] - from[1];
      const ll = Math.hypot(lx, lz) || 1;
      const ux = lx / ll;
      const uz = lz / ll;
      const h0: V2 = [to[0] - ux * 0.12, to[1] - uz * 0.12];
      const h1: V2 = [to[0] - ux * 0.03, to[1] - uz * 0.03];
      const hy0 = y0 + Math.min(0.95, (y1 - y0) * 0.45);
      out.push(
        boxMesh(`${g.id}:handle`, "leaf", decal, String(g.swing ?? g.rooms[0]), h0, h1, 0.06, hy0, Math.min(hy0 + 0.1, y1)),
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

/** What the page needs to swing a door: the passport's hinge and sector ends. */
export interface DoorJson {
  id: string;
  rooms: string[];
  hinge_at: V2;
  swing: string | null;
  width: number;
  height: number;
  open: boolean;
  closed_end: V2;
  open_end: V2;
  /** leaf vertical span in world Y (sill + level base): the touch ray clips here */
  y0: number;
  y1: number;
}

/** `build.json` `doors`: every door opening with a leaf. */
export function doorDefs(ctx: Ctx): DoorJson[] {
  const raws = new Map<string, any>();
  for (const o of ((ctx.scene as any).openings ?? []) as any[]) raws.set(String(o.id), o);
  const levelY = new Map<string, number>();
  for (const l of (((ctx.scene as any).levels ?? []) as any[])) levelY.set(String(l.id), Number(l.y ?? 0));
  const out: DoorJson[] = [];
  for (const g of (ctx.openings ?? []) as OpeningGeo[]) {
    const raw = raws.get(g.id);
    if (g.error || g.kind !== "door" || !raw?.leaf || !g.hingeAt) continue;
    // `normalIn` points into rooms[0]; the leaf swings into `swing`
    const k = g.swing === g.rooms[0] || g.swing === null ? 1 : -1;
    const n: V2 = [g.normalIn[0] * k, g.normalIn[1] * k];
    const h = g.hingeAt;
    const d = (e: V2): number => Math.hypot(e[0] - h[0], e[1] - h[1]);
    const far = d(g.ends[0]) >= d(g.ends[1]) ? g.ends[0] : g.ends[1];
    const y0 = (levelY.get(String((g as any).intervalLevel)) ?? 0) + g.sill;
    out.push({
      id: g.id,
      rooms: g.rooms,
      hinge_at: h,
      swing: g.swing,
      width: g.width,
      height: g.height,
      open: g.leafOpen !== false,
      closed_end: [far[0] + n[0] * (g.thickness / 2), far[1] + n[1] * (g.thickness / 2)],
      open_end: [h[0] + n[0] * g.width, h[1] + n[1] * g.width],
      y0,
      y1: y0 + g.height,
    });
  }
  return out;
}
