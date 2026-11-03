/** A place sewn into a running world (the endless book, the sim's rooms picked from memory): the world is up, a new
 *  place is built off to the side (`dreamer stitch` coordinates), and `attachPlace` adds it with no reload. Its meshes
 *  join the scene, its doors join the door map, and the walker can stand and walk on its floor; the first place
 *  keeps working. A door id the world already has is an error, not a silent overwrite. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Group, Texture } from "three";
import { attachPlace, buildWorld, type WorldLoaders } from "../src/runtime/world.js";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "../../h0/make/testdata/world_run/dist");
const read = (f: string): any => JSON.parse(readFileSync(join(DIST, f), "utf8"));
const data = (): { geo: any; nav: any; built: any } => ({ geo: read("geometry.json"), nav: read("nav.json"), built: read("build.json") });
const loaders: WorldLoaders = { maps: async () => new Map<string, Texture>(), glb: async () => new Group(), scatter: async () => new Group() };

const DX = 600;
/** the same dist as a second place laid DX metres off (as stitch lays it), its door renamed (as stitch renames it) */
const farPart = (): { geo: any; nav: any; built: any } => {
  const d = data();
  for (const f of d.geo.floors) f.outline = f.outline.map(([x, z]: [number, number]) => [x + DX, z]);
  for (const l of d.nav.layers) l.origin = [l.origin[0] + DX, l.origin[1]];
  for (const door of d.built.doors) door.id = `b_${door.id}`;
  d.nav.doors = Object.fromEntries(Object.entries(d.nav.doors).map(([k, v]) => [`b_${k}`, v]));
  return d;
};

describe("attachPlace", () => {
  it("the walker reaches the new place only after it is attached, and still walks the first one", async () => {
    const w = await buildWorld(data(), { base: "", loaders });
    expect(() => w.walker.teleport(DX + 1, 1)).toThrow();
    const part = await attachPlace(w, farPart(), { base: "", loaders });
    expect(w.root.children).toContain(part.root);
    const p = w.walker.teleport(DX + 1, 1);
    expect(p[0]).toBe(DX + 1);
    const q = w.walker.tryMove(0.3, 0);
    expect(q[0]).toBeCloseTo(DX + 1.3, 6);
    expect(w.walker.teleport(1, 1)[0]).toBe(1);
  });

  it("its doors join the world's door map", async () => {
    const w = await buildWorld(data(), { base: "", loaders });
    await attachPlace(w, farPart(), { base: "", loaders });
    expect(w.doors.has("door1")).toBe(true);
    expect(w.doors.has("b_door1")).toBe(true);
  });

  it("a door id the world already has is an error", async () => {
    const w = await buildWorld(data(), { base: "", loaders });
    await expect(attachPlace(w, data(), { base: "", loaders })).rejects.toThrow(/door1/);
  });
});
