import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runCheck } from "../src/check.js";
import { buildGeometry } from "../src/build/geometry.js";
import { buildNav } from "../src/nav/grid.js";
import { findRoute } from "../src/routes/astar.js";
import { sceneAssets } from "../src/assets/run.js";
import { promptFor } from "../src/assets/templates.js";
import { inpaintSky, seamSky, SEAM_PROMPT } from "../src/assets/sky.js";
import { fakePng, fakeGlb, FakeImageProvider } from "../src/assets/providers/fake.js";
import { budgetIssues } from "../src/budget.js";
import { runAssets } from "../src/assets/run.js";
import { writeDist } from "../src/build/write.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

const dir = new URL("../../specs/examples/", import.meta.url);
const load = (f: string): any => JSON.parse(readFileSync(new URL(f, dir), "utf-8"));
const hashes = JSON.parse(readFileSync(new URL("./golden/geometry-hashes.json", import.meta.url), "utf-8"));

describe("В1 yard: open rooms + outdoor", () => {
  it("yard-house checks green", () => {
    const { report } = runCheck(load("yard-house.scene.json"));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("open yard does not bound camera/prop height (F1)", () => {
    const s = load("yard-house.scene.json");
    s.cameras = [{ id: "yard_cam", pos: [0, 1.6, -6], look: [0, 1.6, 0] }];
    s.props = [{ id: "tree", cat: "tree", room: "yard", at: [-6, -12], size: { w: 2, d: 2, h: 9 } }];
    const { report } = runCheck(s);
    expect(report.errors.filter((e) => e.code === "CAMERA_OUTSIDE")).toEqual([]);
    expect(report.errors.filter((e) => e.code === "PROP_ABOVE_CEILING")).toEqual([]);
  });

  it("sky asset requires aspect 2:1 (F2)", () => {
    const s = load("yard-house.scene.json");
    s.assets.s_sky.aspect = "1:1";
    const bad = runCheck(s);
    expect(bad.report.errors.some((e) => e.path.includes("/assets/s_sky/aspect"))).toBe(true);
    const missing = load("yard-house.scene.json");
    delete missing.assets.s_sky.aspect;
    const bad2 = runCheck(missing);
    expect(bad2.report.errors.some((e) => e.path.includes("/assets/s_sky/aspect"))).toBe(true);
  });

  it("yard has no wall/ceiling meshes, the house wall facing it has a door cut", () => {
    const { ctx } = runCheck(load("yard-house.scene.json"));
    const g = buildGeometry(ctx);
    const yard = g.meshes.filter((m) => m.room === "yard");
    expect(yard.some((m) => m.kind === "floor")).toBe(true);
    expect(yard.some((m) => m.kind === "wall" || m.kind === "ceiling")).toBe(false);
    // the front wall z=0: the door opening (0, 1.0 m) is not covered by any
    // wall triangle, while solid wall points beside it are (F3)
    const wallsOnZ0 = g.meshes.filter(
      (m) => m.kind === "wall" && m.positions.every((_, i) => i % 3 !== 2 || Math.abs(m.positions[i]) < 0.2),
    );
    expect(wallsOnZ0.length).toBeGreaterThan(0);
    const covered = (x: number, y: number): boolean => {
      for (const m of wallsOnZ0) {
        const { positions: p, indices: idx } = m;
        for (let t = 0; t < idx.length; t += 3) {
          const ax = p[idx[t] * 3];
          const ay = p[idx[t] * 3 + 1];
          const bx = p[idx[t + 1] * 3];
          const by = p[idx[t + 1] * 3 + 1];
          const cx = p[idx[t + 2] * 3];
          const cy = p[idx[t + 2] * 3 + 1];
          const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
          if (Math.abs(d) < 1e-12) continue;
          const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
          const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
          const l3 = 1 - l1 - l2;
          if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return true;
        }
      }
      return false;
    };
    expect(covered(0, 1.0)).toBe(false);
    expect(covered(2.5, 1.0)).toBe(true);
    const reveals = g.meshes.filter((m) => m.kind === "reveal" && m.id.includes("front"));
    expect(reveals.length).toBeGreaterThan(0);
  });

  // the golden hashes were re-taken after block Г (live door leaves, handle);
  // the outdoor blocks must not move them
  it("old examples keep the same geometry.json hash", () => {
    for (const [f, h] of Object.entries(hashes)) {
      const { ctx } = runCheck(load(f));
      const got = createHash("sha256").update(JSON.stringify(buildGeometry(ctx))).digest("hex");
      expect(got, f).toBe(h);
    }
  });

  it("schema rejects ground.fade > radius", () => {
    const s = load("yard-house.scene.json");
    s.outdoor.ground.fade = 500;
    const { report } = runCheck(s);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.path.startsWith("/outdoor"))).toBe(true);
  });

  it("schema rejects a sky that points to a non-sky asset", () => {
    const s = load("yard-house.scene.json");
    s.assets.s_sky.kind = "decal";
    s.assets.s_sky.aspect = "2:1";
    const { report } = runCheck(s);
    expect(report.errors.some((e) => e.code === "REF_KIND" && e.path === "/outdoor/sky")).toBe(true);
  });

  it("facade default: outer face without facade carries walls material (F11)", () => {
    const s = load("yard-house.scene.json");
    expect(s.rooms[1].facade).toBeUndefined();
    const { report, ctx } = runCheck(s);
    expect(report.errors).toEqual([]);
    const g = buildGeometry(ctx);
    const outerOnZ0 = g.meshes.filter(
      (m) => m.kind === "wall" && m.side === "$exterior" && m.positions.every((_, i) => i % 3 !== 2 || Math.abs(m.positions[i]) < 0.2),
    );
    expect(outerOnZ0.length).toBeGreaterThan(0);
    expect(outerOnZ0.every((m) => m.material === "plaster")).toBe(true);
  });

  it("facade: outer face of the house-yard wall carries facade, UV 0..height (F6)", () => {
    const s = load("yard-house.scene.json");
    s.rooms[1].facade = "white";
    const { report, ctx } = runCheck(s);
    expect(report.errors).toEqual([]);
    const g = buildGeometry(ctx);
    const onZ0 = g.meshes.filter(
      (m) => m.kind === "wall" && m.positions.every((_, i) => i % 3 !== 2 || Math.abs(m.positions[i]) < 0.2),
    );
    const outer = onZ0.filter((m) => m.side === "$exterior");
    const inner = onZ0.filter((m) => m.side === "hall");
    expect(outer.length).toBeGreaterThan(0);
    expect(inner.length).toBeGreaterThan(0);
    expect(outer.every((m) => m.material === "white")).toBe(true);
    expect(inner.every((m) => m.material === "plaster")).toBe(true);
    // the outer face lies on the yard side (z < 0)
    expect(outer.every((m) => m.positions.every((v, i) => i % 3 !== 2 || v < 0))).toBe(true);
    const vs = outer.flatMap((m) => m.uvs.filter((_, i) => i % 2 === 1));
    expect(Math.min(...vs)).toBeCloseTo(0, 6);
    expect(Math.max(...vs)).toBeCloseTo(3.0, 6);
  });

  it("window to yard shows decal on both faces (F12)", () => {
    const s = load("yard-house.scene.json");
    s.assets.d_win = { kind: "decal", prompt: "a window with white frame", aspect: "1:1" };
    s.openings.push({
      id: "win1",
      kind: "window",
      at: [2.5, 0],
      width: 1.2,
      height: 1.2,
      sill: 1.0,
      leaf: { decal: "d_win" },
    });
    const { report, ctx } = runCheck(s);
    expect(report.errors).toEqual([]);
    const g = buildGeometry(ctx);
    const leaves = g.meshes.filter((m) => m.id.startsWith("win1:") && (m as any).kind === "leaf");
    expect(leaves.length).toBe(2);
    const zs = leaves.map((m) => m.positions.filter((_, i) => i % 3 === 2));
    // one leaf on the yard face (z < 0), one on the hall face (z > 0)
    expect(zs.filter((z) => z.every((v) => v < 0)).length).toBe(1);
    expect(zs.filter((z) => z.every((v) => v > 0)).length).toBe(1);
  });

  it("tall room with horizon tile hints open:true (ROOM_LOOKS_OUTDOOR)", () => {
    const s = load("yard-house.scene.json");
    delete s.outdoor;
    const y = s.rooms[0];
    delete y.open;
    y.height = 30;
    y.ceiling = "white";
    y.walls = { material: "horizon" };
    s.materials.horizon = { tile: "a_horizon" };
    s.assets.a_horizon = { kind: "tile", prompt: "horizon countryside landscape" };
    const { report } = runCheck(s);
    expect(report.warnings.some((w) => w.code === "ROOM_LOOKS_OUTDOOR")).toBe(true);
  });

  it("shared wall with height diff warns meters of bare wall (WALL_HEIGHT_MISMATCH)", () => {
    const s = load("yard-house.scene.json");
    s.rooms[1].height = 3;
    s.rooms[2].height = 8;
    const { report } = runCheck(s);
    const w = report.warnings.find((x) => x.code === "WALL_HEIGHT_MISMATCH");
    expect(w).toBeTruthy();
    expect(w!.msg).toMatch(/(^|[^0-9.])5 м/);
  });

  it("ROOM_LOOKS_OUTDOOR sees a horizon tile on an edge override (F28)", () => {
    const s = load("yard-house.scene.json");
    s.materials.far = { tile: "a_far" };
    s.assets.a_far = { kind: "tile", prompt: "rolling countryside panorama" };
    s.rooms[1].edges = { "0": { material: "far" } };
    const { report } = runCheck(s);
    expect(report.warnings.some((w) => w.code === "ROOM_LOOKS_OUTDOOR" && w.path === "/rooms/1")).toBe(true);
  });

  it("ROOM_LOOKS_OUTDOOR ignores the material id, only the asset id/prompt (F28)", () => {
    const s = load("yard-house.scene.json");
    s.materials.sky_blue = { tile: "t_paint" };
    s.assets.t_paint = { kind: "tile", prompt: "matte painted plaster" };
    s.rooms[1].walls = { material: "sky_blue" };
    const { report } = runCheck(s);
    expect(report.warnings.filter((w) => w.code === "ROOM_LOOKS_OUTDOOR")).toEqual([]);
  });

  it("a yard prop against the facade does not hit the house wall (F29)", () => {
    const s = load("yard-house.scene.json");
    s.props = [{ id: "post", cat: "column", room: "yard", at: [2.5, -0.15], size: { w: 0.3, d: 0.3, h: 2 } }];
    const { report } = runCheck(s);
    expect(report.errors.filter((e) => e.code === "PROP_HITS_WALL")).toEqual([]);
  });

  it("old examples raise no street warnings (F35)", () => {
    for (const f of Object.keys(hashes)) {
      const { report } = runCheck(load(f));
      const codes = report.warnings.map((w) => w.code);
      expect(codes, f).not.toContain("ROOM_LOOKS_OUTDOOR");
      expect(codes, f).not.toContain("WALL_HEIGHT_MISMATCH");
    }
  });
});

const crosses = (path: [number, number][], z: number, xMin: number, xMax: number): boolean =>
  path.some((p, i) => i > 0 && (path[i - 1][1] - z) * (p[1] - z) <= 0 && p[0] >= xMin && p[0] <= xMax);

describe("В2 outdoor build", () => {
  it("nav: route from the yard to the far room goes through the front door (F13)", () => {
    const { ctx } = runCheck(load("yard-house.scene.json"));
    const nav = buildNav(ctx);
    const r = findRoute(nav, [0, -6], [0, 9], "L0");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(crosses(r.path as [number, number][], 0, -0.5, 0.5)).toBe(true);
    expect(crosses(r.path as [number, number][], 6, -0.45, 0.45)).toBe(true);
  });

  it("geometry carries sky dome + fading ground disc under the yards", () => {
    const { ctx } = runCheck(load("yard-house.scene.json"));
    const g: any = buildGeometry(ctx);
    expect(g.outdoor).toBeTruthy();
    expect(g.outdoor.sky.asset).toBe("s_sky");
    expect(g.outdoor.sky.radius).toBeGreaterThan(120);
    expect(g.outdoor.ground).toMatchObject({ material: "grass", radius: 120, fade: 30 });
    expect(g.outdoor.ground.y).toBeCloseTo(-0.01, 6);
    // the gradient stand-in for --assets none starts from style.exterior
    expect(g.outdoor.sky.fallback.top).toBe("#9ab8d8");
  });
});

describe("В3 sky asset", () => {
  it("outdoor.sky is a referenced asset with the panorama template", () => {
    const refs = sceneAssets(load("yard-house.scene.json"));
    expect(refs.map((r) => r.id)).toEqual(["s_sky"]);
    expect(refs[0].kind).toBe("sky");
    expect(promptFor("sky", "x")).toBe(
      "equirectangular 360 panorama, 2:1, seamless left-right edge, horizon at the vertical middle, no people. x",
    );
  });

  it("a 2:1 picture comes out of the seam step with matching left/right edges", () => {
    // a horizontal ramp: left edge black, right edge white — the worst seam
    const w = 64;
    const h = 32;
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = Math.round((255 * x) / (w - 1));
        png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
        png.data[i + 3] = 255;
      }
    const r = seamSky(PNG.sync.write(png));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = PNG.sync.read(r.png);
    expect(out.width).toBe(w);
    expect(out.height).toBe(h);
    const col = (x: number): number => {
      let s = 0;
      for (let y = 0; y < h; y++) s += out.data[(y * w + x) * 4];
      return s / h;
    };
    expect(Math.abs(col(0) - col(w - 1))).toBeLessThanOrEqual(8);
  });

  it("a picture that is not 2:1 fails with ASSET_FAILED and a reason", () => {
    const r = seamSky(fakePng(32, 32, [100, 150, 200]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issue.code).toBe("ASSET_FAILED");
    expect(r.issue.msg).toMatch(/2:1/);
  });

  it("a live run whose sky comes back not 2:1 reports ASSET_FAILED and builds with the gradient", async () => {
    const s = load("yard-house.scene.json");
    const cacheDir = mkdtempSync(join(tmpdir(), "sky-"));
    const image = { generate: async (prompt: string) => (prompt.includes("equirectangular") ? fakePng(32, 32, [90, 140, 220]) : fakePng(64, 64, [120, 120, 120])) };
    const object = { mesh: async () => fakeGlb() };
    const rep = await runAssets(s, { mode: "live", cacheDir, image, object, maxDollars: 5 });
    expect((rep.failed ?? []).map((i) => i.code)).toEqual(["ASSET_FAILED"]);
    expect(rep.used).not.toContain("s_sky");
    expect(rep.missing).toContain("s_sky");
    const { ctx, report } = runCheck(s);
    const out = mkdtempSync(join(tmpdir(), "sky-dist-"));
    const b = await writeDist(ctx, report, out, { startedAt: Date.now(), assets: rep, cacheDir });
    expect(b.warnings.some((w) => w.startsWith("ASSET_FAILED"))).toBe(true);
    const g = JSON.parse(readFileSync(join(out, "geometry.json"), "utf-8"));
    expect(g.outdoor.sky.file).toBeNull();
  });

  const ramp = (w: number, h: number): Buffer => {
    // a horizontal ramp: left edge black, right edge white — the worst seam
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = Math.round((255 * x) / (w - 1));
        png.data[i + 3] = 255;
      }
    return PNG.sync.write(png);
  };

  it("the edit recipe: a gray band over the seam goes to the edit model and is pasted back feathered", async () => {
    const w = 512;
    const h = 256;
    const src = ramp(w, h);
    const painter = new FakeImageProvider();
    const sent: Buffer[] = [];
    const r = await inpaintSky(src, async (png, prompt) => {
      sent.push(png);
      return painter.edit(png, prompt);
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // one h×h crop with a gray band down its middle and the real picture beside it
    expect(painter.edits).toEqual([{ prompt: SEAM_PROMPT, width: h, height: h }]);
    const crop = PNG.sync.read(sent[0]);
    const at = (img: PNG, x: number, y: number): number => img.data[(y * img.width + x) * 4];
    expect(at(crop, h / 2, 10)).toBe(128);
    expect(at(crop, 0, 10)).not.toBe(128);
    const out = PNG.sync.read(r.png);
    const orig = PNG.sync.read(src);
    expect([out.width, out.height]).toEqual([w, h]);
    const col = (img: PNG, x: number): number => {
      let s = 0;
      for (let y = 0; y < h; y++) s += at(img, x, y);
      return s / h;
    };
    // the wrap is continuous, and far from the seam the picture is untouched
    expect(Math.abs(col(out, 0) - col(out, w - 1))).toBeLessThanOrEqual(8);
    for (const x of [w / 4, w / 2, (3 * w) / 4]) expect(col(out, x)).toBe(col(orig, x));
  });

  it("a live run with an edit-capable provider paints the seam and pays for the edit", async () => {
    const s = load("yard-house.scene.json");
    const cacheDir = mkdtempSync(join(tmpdir(), "sky-edit-"));
    const image = new FakeImageProvider();
    const gen = image.generate.bind(image);
    image.generate = async (prompt, size) => (prompt.includes("equirectangular") ? ramp(64, 32) : gen(prompt, size));
    const rep = await runAssets(s, { mode: "live", cacheDir, image, object: { mesh: async () => fakeGlb() }, maxDollars: 5 });
    expect(rep.failed ?? []).toEqual([]);
    expect(rep.used).toContain("s_sky");
    expect(image.edits).toHaveLength(1);
    const rows = readFileSync(join(cacheDir, "ledger.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.filter((r) => r.kind === "sky").reduce((a, r) => a + r.cents, 0)).toBe(2);
  });
});

describe("В4 roof", () => {
  const withRoof = (kind: "flat" | "gable"): any => {
    const s = load("yard-house.scene.json");
    s.rooms[1].roof = { material: "white", kind, overhang: 0.5 };
    return s;
  };
  for (const kind of ["flat", "gable"] as const) {
    it(`${kind} roof covers the footprint with the overhang`, () => {
      const { report, ctx } = runCheck(withRoof(kind));
      expect(report.errors).toEqual([]);
      const g = buildGeometry(ctx);
      const roof = g.meshes.filter((m) => m.kind === "roof" && m.room === "hall");
      expect(roof.length).toBeGreaterThan(0);
      const xs = roof.flatMap((m) => m.positions.filter((_, i) => i % 3 === 0));
      const ys = roof.flatMap((m) => m.positions.filter((_, i) => i % 3 === 1));
      const zs = roof.flatMap((m) => m.positions.filter((_, i) => i % 3 === 2));
      // hall is x∈[-4,4], z∈[0,6]
      expect(Math.abs(Math.min(...xs) - -4.5)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(Math.max(...xs) - 4.5)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(Math.min(...zs) - -0.5)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(Math.max(...zs) - 6.5)).toBeLessThanOrEqual(0.01);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(3.0 - 1e-6);
      if (kind === "gable") expect(Math.max(...ys)).toBeGreaterThan(3.5);
      else expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.5);
    });
  }

  // hall cut into an L: the quadrant x∈[-4,0], z∈[3,6] is not the room (the study door moves to x=2)
  const lRoof = (kind: "flat" | "gable"): any => {
    const s = withRoof(kind);
    s.rooms[1].shape = [[-4, 0], [4, 0], [4, 6], [0, 6], [0, 3], [-4, 3]];
    s.rooms[1].roof.overhang = 0;
    s.openings[1].at = [2, 6];
    return s;
  };
  const covers = (m: any, x: number, z: number): boolean => {
    const P = m.positions;
    const side = (ax: number, az: number, bx: number, bz: number): number => (bx - ax) * (z - az) - (bz - az) * (x - ax);
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]].map((i: number) => [P[3 * i], P[3 * i + 2]]);
      const d1 = side(a[0], a[1], b[0], b[1]);
      const d2 = side(b[0], b[1], c[0], c[1]);
      const d3 = side(c[0], c[1], a[0], a[1]);
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      if (area < 1e-9) continue;
      if ((d1 > 1e-9 && d2 > 1e-9 && d3 > 1e-9) || (d1 < -1e-9 && d2 < -1e-9 && d3 < -1e-9)) return true;
    }
    return false;
  };
  for (const kind of ["flat", "gable"] as const) {
    it(`${kind} roof follows an L footprint, not its bounding box`, () => {
      const { report, ctx } = runCheck(lRoof(kind));
      expect(report.errors).toEqual([]);
      const roof = buildGeometry(ctx).meshes.filter((m) => m.kind === "roof" && m.room === "hall");
      expect(roof.length).toBeGreaterThan(0);
      const hit = (x: number, z: number): boolean => roof.some((m) => covers(m, x, z));
      expect(hit(-2, 4)).toBe(false);
      expect(hit(2, 4)).toBe(true);
      expect(hit(2, 1)).toBe(true);
      expect(hit(-2, 1)).toBe(true);
    });
  }

  it("schema rejects an unknown roof kind", () => {
    const s = withRoof("flat");
    s.rooms[1].roof.kind = "dome";
    expect(runCheck(s).report.ok).toBe(false);
  });
});

describe("Б1 budget in a yard", () => {
  it("three point lamps in an open yard break the per-room limit", () => {
    const s = load("yard-house.scene.json");
    const lamp = { kind: "point", pos: [0, 2.5, -10], color: "#ffd8b0", power: 1 };
    s.lights = [lamp, lamp, lamp];
    const { ctx } = runCheck(s);
    const issues = budgetIssues(ctx, { total: 10, by_prop: {} }).filter((i) => i.code === "POINT_LIGHT_BUDGET" && (i.data as any).room !== undefined);
    expect(issues.map((i) => (i.data as any).room)).toEqual(["yard"]);
  });
});

describe("В5 street example", () => {
  it("street-two-houses checks green and links house 1 to house 2 over the street", () => {
    const s = load("street-two-houses.scene.json");
    const { report, ctx } = runCheck(s);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    const ids = s.rooms.map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["street", "a_front", "a_back", "b_front", "b_back"]));
    const nav = buildNav(ctx);
    // a_back (z ∈ [-14,-10]) → b_back (z ∈ [10,14]), crossing the street z ∈ [-6,6]
    const r = findRoute(nav, [0, -12], [0, 12], "L0");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path.some((p) => Math.abs(p[1]) < 5)).toBe(true);
  });

  it("street.md exists for the author", () => {
    const md = readFileSync(new URL("../docs/street.md", import.meta.url), "utf-8");
    for (const w of ["open", "facade", "roof", "outdoor", "sky", "ground"]) expect(md).toContain(w);
  });
});
