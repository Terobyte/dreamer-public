/** One world out of places built apart (a book's rooms, the sim's rooms from memory): `stitchScenes` lays the parts side
 *  by side with no overlap, renames what collides (refs follow), and links door pairs (`to` both ways). Squidward v10
 *  did it by hand (world_street/make_scene.ts: offsets 40 m and -40 m, ids prefixed, doors linked). */
import { describe, it, expect } from "vitest";
import { demoFlat } from "./helpers/scene.js";
import { stitchScenes, STITCH_GAP } from "../src/stitch.js";
import { CAMERA_FAR } from "../src/runtime/cams.js";
import { runCheck } from "../src/check.js";

const xs = (s: any, room: string): number[] => s.rooms.find((r: any) => r.id === room).shape.map((v: any) => v[0]);

describe("stitchScenes", () => {
  const a = demoFlat() as any, b = demoFlat() as any;
  const { scene: s, ids } = stitchScenes([{ name: "a", scene: a }, { name: "b", scene: b }], [{ from: "a:front", to: "b:front" }]);

  it("the first part stays where it was, the second lies past it with a gap, nothing overlaps", () => {
    expect(s.rooms.find((r: any) => r.id === "living").shape).toEqual(a.rooms.find((r: any) => r.id === "living").shape);
    const aMax = Math.max(...a.rooms.flatMap((r: any) => r.shape.map((v: any) => v[0])));
    const bMin = Math.min(...["living", "hall"].flatMap((r) => xs(s, ids.b!.rooms[r]!)));
    expect(bMin).toBeGreaterThanOrEqual(aMax + STITCH_GAP - 1e-9);
    expect(s.rooms).toHaveLength(4);
  });

  it("ids that collide are renamed in the later part, its refs follow; a level of the same height is shared", () => {
    const bl = ids.b!.rooms["living"]!;
    expect(bl).not.toBe("living");
    const bProps = s.props.slice(a.props.length);
    expect(bProps.every((p: any) => p.room !== "living" && p.room !== "hall")).toBe(true);
    for (const p of bProps) expect(s.assets[p.asset]).toBeDefined();
    const rb = s.rooms.find((r: any) => r.id === bl);
    expect(s.materials[rb.floor]).toBeDefined();
    expect(s.levels).toHaveLength(1);
    expect(s.spawn.room).toBe("hall");
    expect(s.cameras.map((c: any) => c.id)).toHaveLength(new Set(s.cameras.map((c: any) => c.id)).size);
  });

  it("a link makes the two doors lead to each other", () => {
    const fa = s.openings.find((o: any) => o.id === "front"), fb = s.openings.find((o: any) => o.id === ids.b!.doors["front"]);
    expect(fa.to).toBe(fb.id);
    expect(fb.to).toBe("front");
  });

  it("the stitched world passes the check, every room reachable", () => {
    const { report }: any = runCheck(s);
    const codes = (report.errors ?? []).map((i: any) => `${i.code} ${i.path}`);
    expect(codes).toEqual([]);
  });

  it("a part with an outdoor (a street) is the one at the origin: its ground disc is drawn there", () => {
    const street: any = demoFlat();
    street.outdoor = { sky: "t_wall", ground: { material: "parquet", radius: 60, fade: 20 } };
    const r = stitchScenes([{ name: "a", scene: demoFlat() }, { name: "st", scene: street }], []);
    expect(r.scene.outdoor).toBeDefined();
    const stLiving = r.scene.rooms.find((q: any) => q.id === r.ids.st!.rooms["living"]);
    expect(stLiving.shape).toEqual(street.rooms.find((q: any) => q.id === "living").shape);
    expect(r.scene.spawn.room).toBe("hall");  // the spawn is still the first part's
  });

  it("with a street, the other places lie past the camera's sight from it (Squidward v11: the pineapple's rooms, 30 m off, stood as a green box on the street's horizon)", () => {
    const street: any = demoFlat();
    street.outdoor = { sky: "t_wall", ground: { material: "parquet", radius: 60, fade: 20 } };
    const r = stitchScenes([{ name: "a", scene: demoFlat() }, { name: "st", scene: street }], []);
    const stMax = Math.max(...street.rooms.flatMap((q: any) => q.shape.map((v: any) => v[0])));
    const aMin = Math.min(...["living", "hall"].flatMap((q) => xs(r.scene, q)));
    expect(aMin - stMax).toBeGreaterThan(CAMERA_FAR);
  });

  it("an unknown door in a link is an error, not a silent no-op", () => {
    expect(() => stitchScenes([{ name: "a", scene: demoFlat() }, { name: "b", scene: demoFlat() }], [{ from: "a:nope", to: "b:front" }])).toThrow(/nope/);
  });
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stitchFiles } from "../src/stitch.js";

describe("stitchFiles (dreamer stitch)", () => {
  it("writes one scene.json and one cache from parts on disk; a relative ref image becomes absolute", () => {
    const root = mkdtempSync(join(tmpdir(), "stitch-"));
    const part = (name: string, extra: (s: any) => void) => {
      const d = join(root, name);
      mkdirSync(join(d, "cache"), { recursive: true });
      const s: any = demoFlat();
      extra(s);
      writeFileSync(join(d, "scene.json"), JSON.stringify(s));
      writeFileSync(join(d, "cache", `${name}.bin`), name);
      return join(d, "scene.json");
    };
    const a = part("a", () => {});
    const b = part("b", (s) => { s.assets.p_sofa.ref = { image: "refs/sofa.png", what: "the sofa" }; });
    const out = join(root, "out");
    stitchFiles([{ name: "a", path: a }, { name: "b", path: b }], [{ from: "a:front", to: "b:front" }], out);
    const s = JSON.parse(readFileSync(join(out, "scene.json"), "utf8"));
    expect(s.rooms).toHaveLength(4);
    expect(existsSync(join(out, "cache", "a.bin")) && existsSync(join(out, "cache", "b.bin"))).toBe(true);
    const sofa = Object.entries(s.assets).find(([k, v]: any) => k !== "p_sofa" && v.ref)![1] as any;
    expect(sofa.ref.image).toBe(join(root, "b", "refs/sofa.png"));
  });
});
