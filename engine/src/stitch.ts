/**
 * One world out of places built apart: a book's rooms as the story reaches them, the sim's rooms told from memory,
 * a street and the houses on it. `stitchScenes` lays the parts side by side along x with STITCH_GAP between them
 * (no overlap, and no point light of one reaches the next), renames the ids of a later part that collide with an
 * earlier one (every ref inside that part follows), and links door pairs: `{from: "a:front", to: "b:street"}` sets
 * both `to` fields (stage `Place.to`: who walks out through one comes in by the other).
 *
 * A part with an `outdoor` (sky dome and ground disc, drawn around the origin) stays at the origin; the others are laid
 * past it. The spawn is the first part's. Pure: asset caches and relative ref images are the caller's (bin `stitch`).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const STITCH_GAP = 30;

export interface StitchPart { name: string; scene: any }
export interface StitchLink { from: string; to: string }
export interface StitchIds { rooms: Record<string, string>; doors: Record<string, string>; props: Record<string, string> }

type V2 = [number, number];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** x/z extent of a part: its rooms (shape or circle), free walls and portals */
function extent(s: any): { minX: number; maxX: number } | null {
  const xs: number[] = [];
  for (const r of s.rooms ?? []) {
    for (const v of r.shape ?? []) xs.push(Number(v[0]));
    if (r.circle) xs.push(r.circle.c[0] - r.circle.r, r.circle.c[0] + r.circle.r);
  }
  for (const w of s.walls ?? []) xs.push(w.from[0], w.to[0]);
  for (const p of s.portals ?? []) xs.push(p.at[0]);
  return xs.length ? { minX: Math.min(...xs), maxX: Math.max(...xs) } : null;
}

/** every coordinate of a part moved by dx along x (decals and props `on` a wall edge follow the wall) */
function shift(s: any, dx: number): void {
  if (!dx) return;
  const p2 = (p: any): void => { if (Array.isArray(p) && typeof p[0] === "number") p[0] += dx; };
  for (const r of s.rooms ?? []) {
    for (const v of r.shape ?? []) p2(v);
    if (r.circle) p2(r.circle.c);
    for (const b of r.beams ?? []) (p2(b.from), p2(b.to));
  }
  for (const w of s.walls ?? []) (p2(w.from), p2(w.to));
  for (const f of s.fixtures ?? []) (p2(f.from), p2(f.to));
  for (const o of s.openings ?? []) p2(o.at);
  for (const st of s.stairs ?? []) p2(st.from?.at);
  for (const p of s.props ?? []) (p2(p.at), Array.isArray(p.face) && p2(p.face));
  for (const d of s.decals ?? []) p2(d.at);
  for (const l of s.lights ?? []) p2(l.pos);
  for (const c of s.cameras ?? []) (p2(c.pos), p2(c.look));
  for (const r of s.routes ?? []) for (const q of r.path ?? []) if (q && typeof q === "object") p2(q.at);
  for (const p of s.portals ?? []) p2(p.at);
  for (const sc of s.scatter ?? []) {
    if (Array.isArray(sc.area)) (sc.area[0] += dx, sc.area[2] += dx);
    for (const a of sc.avoid ?? []) p2(a);
  }
  if (s.spawn) p2(s.spawn.at);
}

/** rename ids in one part: `m.<ns>` old -> new, and every ref to them */
function rename(s: any, m: { room: Map<string, string>; level: Map<string, string>; mat: Map<string, string>; asset: Map<string, string>; door: Map<string, string>; prop: Map<string, string>; cam: Map<string, string>; route: Map<string, string> }): void {
  const f = (mp: Map<string, string>) => (x: any) => (typeof x === "string" && mp.has(x) ? mp.get(x)! : x);
  const R = f(m.room), L = f(m.level), M = f(m.mat), A = f(m.asset), D = f(m.door), P = f(m.prop);
  const on = (o: any): void => { if (o && typeof o === "object") o.room = R(o.room); };
  for (const r of s.rooms ?? []) {
    r.id = R(r.id); r.level = L(r.level);
    for (const k of ["floor", "ceiling", "facade"]) if (r[k] !== undefined) r[k] = M(r[k]);
    if (r.roof) r.roof.material = M(r.roof.material);
    if (r.walls) { r.walls.material = M(r.walls.material); for (const b of r.walls.bands ?? []) b.material = M(b.material); }
    for (const e of Object.values(r.edges ?? {}) as any[]) e.material = M(e.material);
    for (const b of r.beams ?? []) b.material = M(b.material);
  }
  for (const l of s.levels ?? []) l.id = L(l.id);
  for (const w of s.walls ?? []) (w.level = L(w.level), w.material = M(w.material));
  for (const fx of s.fixtures ?? []) { fx.room = R(fx.room); fx.material = M(fx.material); if (fx.top !== undefined) fx.top = M(fx.top); }
  for (const o of s.openings ?? []) {
    o.id = D(o.id); on(o.on); if (o.to !== undefined) o.to = D(o.to);
    if (o.leaf) { o.leaf.decal = A(o.leaf.decal); if (o.leaf.swing !== undefined) o.leaf.swing = R(o.leaf.swing); }
  }
  for (const st of s.stairs ?? []) { st.id = D(st.id); st.from.room = R(st.from.room); st.to.room = R(st.to.room); }
  for (const p of s.props ?? []) {
    p.id = P(p.id); p.asset = A(p.asset); if (p.room !== undefined) p.room = R(p.room); on(p.on);
    if (p.mount && typeof p.mount === "object") for (const k of ["top_of", "tier_of"]) if (p.mount[k] !== undefined) p.mount[k] = P(p.mount[k]);
    if (typeof p.face === "string" && p.face !== "room") p.face = P(p.face);
    if (p.around) p.around.center = P(p.around.center);
  }
  for (const d of s.decals ?? []) { d.asset = A(d.asset); if (d.room !== undefined) d.room = R(d.room); on(d.on); }
  for (const sc of s.scatter ?? []) sc.assets = sc.assets.map(A);
  for (const mt of Object.values(s.materials ?? {}) as any[]) if (mt.tile !== undefined) mt.tile = A(mt.tile);
  if (s.outdoor) { s.outdoor.sky = A(s.outdoor.sky); s.outdoor.ground.material = M(s.outdoor.ground.material); }
  for (const p of s.portals ?? []) { p.id = D(p.id); p.room = R(p.room); if (p.to !== undefined) p.to = D(p.to); }
  for (const c of s.cameras ?? []) c.id = f(m.cam)(c.id);
  for (const r of s.routes ?? []) {
    r.id = f(m.route)(r.id);
    r.path = r.path.map((q: any) => (typeof q === "string" ? D(q) : (q.room = R(q.room), q)));
  }
  if (s.spawn) s.spawn.room = R(s.spawn.room);
  for (const k of ["materials", "assets"] as const) {
    const mp = k === "materials" ? m.mat : m.asset;
    if (s[k]) s[k] = Object.fromEntries(Object.entries(s[k]).map(([id, v]) => [mp.get(id) ?? id, v]));
  }
}

export function stitchScenes(parts: StitchPart[], links: StitchLink[], o: { gap?: number } = {}): { scene: any; ids: Record<string, StitchIds> } {
  if (!parts.length) throw new Error("stitch: no parts");
  const gap = o.gap ?? STITCH_GAP;
  const outdoors = parts.filter((p) => p.scene.outdoor);
  if (outdoors.length > 1) throw new Error(`stitch: more than one part has an outdoor (${outdoors.map((p) => p.name).join(", ")})`);
  const anchor = outdoors[0] ?? parts[0]!;

  const taken = { room: new Set<string>(), mat: new Set<string>(), asset: new Set<string>(), door: new Set<string>(), prop: new Set<string>(), cam: new Set<string>(), route: new Set<string>() };
  const levelY = new Map<string, number>();
  const out: any = { ...clone(parts[0]!.scene) };
  for (const k of ["rooms", "levels", "walls", "fixtures", "openings", "stairs", "props", "decals", "lights", "cameras", "routes", "portals", "scatter"]) out[k] = [];
  out.materials = {}; out.assets = {};
  delete out.outdoor;
  const ids: Record<string, StitchIds> = {};
  const renamed: Array<{ part: StitchPart; s: any }> = [];

  // ids first, in the parts' order (the first part keeps its names, the spawn with them)
  for (const part of parts) {
    const s = clone(part.scene);
    const free = (set: Set<string>, id: string): string => {
      if (!set.has(id)) return id;
      let n = `${part.name}_${id}`;
      for (let k = 2; set.has(n); k++) n = `${part.name}_${id}_${k}`;
      return n;
    };
    const mapOf = (set: Set<string>, list: string[]) => new Map(list.map((id) => [id, free(set, id)] as [string, string]).filter(([a, b]) => a !== b));
    const doorIds = [...(s.openings ?? []), ...(s.stairs ?? []), ...(s.portals ?? [])].map((x: any) => String(x.id));
    const level = new Map<string, string>();
    for (const l of s.levels ?? []) {
      const y = levelY.get(l.id);
      if (y === undefined || y === l.y) continue;
      let n = `${part.name}_${l.id}`;
      for (let k = 2; levelY.has(n) && levelY.get(n) !== l.y; k++) n = `${part.name}_${l.id}_${k}`;
      level.set(l.id, n);
    }
    const m = {
      room: mapOf(taken.room, (s.rooms ?? []).map((r: any) => r.id)), level,
      mat: mapOf(taken.mat, Object.keys(s.materials ?? {})), asset: mapOf(taken.asset, Object.keys(s.assets ?? {})),
      door: mapOf(taken.door, doorIds), prop: mapOf(taken.prop, (s.props ?? []).map((p: any) => p.id).filter(Boolean)),
      cam: mapOf(taken.cam, (s.cameras ?? []).map((c: any) => c.id)), route: mapOf(taken.route, (s.routes ?? []).map((r: any) => r.id)),
    };
    rename(s, m);
    renamed.push({ part, s });

    const keep = (mp: Map<string, string>, list: string[]): Record<string, string> => Object.fromEntries(list.map((id) => [id, mp.get(id) ?? id]));
    ids[part.name] = { rooms: keep(m.room, (part.scene.rooms ?? []).map((r: any) => r.id)), doors: keep(m.door, doorIds), props: keep(m.prop, (part.scene.props ?? []).map((p: any) => p.id).filter(Boolean)) };

    for (const r of s.rooms ?? []) taken.room.add(r.id);
    for (const id of Object.keys(s.materials ?? {})) taken.mat.add(id);
    for (const id of Object.keys(s.assets ?? {})) taken.asset.add(id);
    for (const x of [...(s.openings ?? []), ...(s.stairs ?? []), ...(s.portals ?? [])]) taken.door.add(x.id);
    for (const p of s.props ?? []) if (p.id) taken.prop.add(p.id);
    for (const c of s.cameras ?? []) taken.cam.add(c.id);
    for (const r of s.routes ?? []) taken.route.add(r.id);
    for (const l of s.levels ?? []) if (!levelY.has(l.id)) (levelY.set(l.id, l.y), out.levels.push(l));
  }

  // then the places: the anchor (the outdoor part, else the first) where it was, the others past it in a row
  const first = renamed.find((r) => r.part === anchor)!;
  let cursor = (extent(first.s)?.maxX ?? 0) + gap;
  for (const { part, s } of renamed) {
    const e = extent(s);
    if (part !== anchor && e) {
      const dx = cursor - e.minX;
      shift(s, dx);
      cursor = e.maxX + dx + gap;
    }
    for (const k of ["rooms", "walls", "fixtures", "openings", "stairs", "props", "decals", "lights", "cameras", "routes", "portals", "scatter"]) out[k].push(...(s[k] ?? []));
    Object.assign(out.materials, s.materials ?? {});
    Object.assign(out.assets, s.assets ?? {});
    if (s.outdoor) out.outdoor = s.outdoor;
    if (part === parts[0]) out.spawn = s.spawn;
  }

  const door = (ref: string): any => {
    const i = ref.indexOf(":");
    const part = ref.slice(0, i), id = ref.slice(i + 1);
    const nid = ids[part]?.doors[id];
    const d = nid !== undefined ? [...out.openings, ...out.portals].find((x: any) => x.id === nid) : undefined;
    if (!d) throw new Error(`stitch: link names no door: ${ref}`);
    return d;
  };
  for (const l of links) {
    const a = door(l.from), b = door(l.to);
    a.to = b.id; b.to = a.id;
  }
  for (const k of ["walls", "fixtures", "stairs", "decals", "cameras", "routes", "portals", "scatter"]) if (!out[k].length && !(k in parts[0]!.scene)) delete out[k];
  return { scene: out, ids };
}

/**
 * `dreamer stitch`: parts on disk (`<dir>/scene.json`, its assets in `<dir>/cache`) into `<out>/scene.json` and one
 * `<out>/cache` (the cache is keyed by content, so the parts' caches merge). A relative ref image is resolved against
 * its part's folder, the stitched scene lives elsewhere. Returns the ids each part's things got.
 */
export function stitchFiles(parts: Array<{ name: string; path: string }>, links: StitchLink[], out: string): Record<string, StitchIds> {
  mkdirSync(join(out, "cache"), { recursive: true });
  const loaded = parts.map((p) => {
    const dir = dirname(resolve(p.path));
    const scene = JSON.parse(readFileSync(p.path, "utf8"));
    for (const a of Object.values(scene.assets ?? {}) as any[]) if (a.ref?.image && !isAbsolute(a.ref.image)) a.ref.image = join(dir, a.ref.image);
    if (existsSync(join(dir, "cache"))) cpSync(join(dir, "cache"), join(out, "cache"), { recursive: true });
    return { name: p.name, scene };
  });
  const { scene, ids } = stitchScenes(loaded, links);
  writeFileSync(join(out, "scene.json"), JSON.stringify(scene, null, 1));
  return ids;
}
