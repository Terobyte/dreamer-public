import type { Ctx } from "../ctx.js";
import type { Issue } from "../types.js";
import type { RoomGeo } from "./rooms.js";
import { msg } from "../report/messages.js";
import { FREE } from "./merge.js";

const OUTDOOR_WORDS = ["horizon", "sky", "landscape", "countryside"];

function hayHasOutdoor(hay: string): boolean {
  const h = hay.toLowerCase();
  return OUTDOOR_WORDS.some((w) => h.includes(w));
}

/** B5: hints for an author describing a street as tall rooms. */
export function streetHints(ctx: Ctx, rooms: RoomGeo[], rawRooms: any[]): Issue[] {
  const out: Issue[] = [];
  const scene: any = ctx.scene;
  const assets: Record<string, any> = scene.assets ?? {};
  const materials: Record<string, any> = scene.materials ?? {};
  const rawById = new Map<string, any>();
  rawRooms.forEach((r: any) => {
    if (r && typeof r.id === "string") rawById.set(r.id, r);
  });

  // ROOM_LOOKS_OUTDOOR: a closed room taller than 12 m, or whose wall tile
  // looks like a horizon/landscape panorama.
  rawRooms.forEach((r: any, i: number) => {
    if (!r || typeof r !== "object") return;
    if (r.open === true) return;
    if (typeof r.height !== "number") return;
    const tall = r.height > 12;
    const matIds: string[] = [];
    if (typeof r.walls?.material === "string") matIds.push(r.walls.material);
    if (Array.isArray(r.walls?.bands)) {
      for (const b of r.walls.bands) {
        if (b && typeof b.material === "string") matIds.push(b.material);
      }
    }
    // a per-edge override is a wall material too
    for (const e of Object.values((r.edges ?? {}) as Record<string, any>)) {
      if (e && typeof e.material === "string") matIds.push(e.material);
    }
    let outdoorTile = false;
    for (const mid of matIds) {
      const m = materials[mid];
      const tileId = m?.tile;
      if (typeof tileId === "string") {
        const a = assets[tileId];
        // only the asset says what is painted: a material named `sky_blue` is a colour, not a sky
        if (hayHasOutdoor(`${tileId} ${a?.prompt ?? ""}`)) outdoorTile = true;
      }
    }
    if (tall || outdoorTile) {
      const path = `/rooms/${i}`;
      out.push({
        code: "ROOM_LOOKS_OUTDOOR",
        stage: "plan",
        path,
        msg: msg("ROOM_LOOKS_OUTDOOR", { path, room: String(r.id) }),
      });
    }
  });

  // WALL_HEIGHT_MISMATCH: a shared wall of two closed rooms whose heights
  // differ by more than 3 m — report the meters of bare wall above the low one.
  const levels = (ctx as any).levels as Map<string, { intervals: any[] }> | undefined;
  if (levels) {
    const seen = new Set<string>();
    for (const plan of levels.values()) {
      for (const iv of plan.intervals ?? []) {
        const sides = iv.sides ?? [];
        if (sides.length !== 2) continue;
        const [a, b] = sides;
        if (a.room === b.room || a.room === FREE || b.room === FREE) continue;
        const ra = rawById.get(a.room);
        const rb = rawById.get(b.room);
        if (!ra || !rb) continue;
        if (ra.open === true || rb.open === true) continue;
        if (typeof ra.height !== "number" || typeof rb.height !== "number") continue;
        const d = Math.abs(ra.height - rb.height);
        if (d <= 3 + 1e-9) continue;
        const key = [String(a.room), String(b.room)].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        const low = ra.height < rb.height ? ra : rb;
        const dd = String(Math.round(d * 1000) / 1000);
        const ri = rawRooms.indexOf(ra.height < rb.height ? rb : ra);
        const path = `/rooms/${ri < 0 ? 0 : ri}/height`;
        out.push({
          code: "WALL_HEIGHT_MISMATCH",
          stage: "plan",
          path,
          msg: msg("WALL_HEIGHT_MISMATCH", {
            path,
            a: String(a.room),
            b: String(b.room),
            low: String(low.id),
            d: dd,
          }),
        });
      }
    }
  }
  return out;
}
