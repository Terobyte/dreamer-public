import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { runCheck } from "../src/check.js";
import { demoFlat } from "./helpers/scene.js";
import { sceneAssets, type AssetRef } from "../src/assets/run.js";
import { fakePng } from "../src/assets/providers/fake.js";
import type { Report } from "../src/types.js";
import { fakeShots } from "./fake-shots.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const DEMO = "../specs/examples/demo-flat.scene.json";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dreamer-"));
}

function pad(buf: Buffer, byte: number): Buffer {
  const extra = (4 - (buf.length % 4)) % 4;
  return extra === 0 ? buf : Buffer.concat([buf, Buffer.alloc(extra, byte)]);
}

/** A GLB whose only triangle spans exactly `w × h × d`, so the normalized
 *  bound is a known box instead of fakeGlb's fixed 2 × 2 × 1. */
function boxGlb(w: number, d: number, h: number): Buffer {
  const verts = [0, 0, 0, w, h, d, 0, h, 0];
  const bin = pad(Buffer.from(new Float32Array(verts).buffer), 0);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { metallicFactor: 1 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [w, h, d] },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  };
  const json = pad(Buffer.from(JSON.stringify(gltf), "utf-8"), 0x20);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (data: Buffer, type: number): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  return Buffer.concat([header, chunk(json, 0x4e4f534a), chunk(bin, 0x004e4942)]);
}

/** A two-colour checkerboard: nowhere near one flat colour. */
function checkerPng(n: number): Buffer {
  const png = new PNG({ width: n, height: n });
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const c = (x + y) % 2 === 0 ? 20 : 230;
      png.data[i] = c;
      png.data[i + 1] = c;
      png.data[i + 2] = c;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Same RGB everywhere, alpha split 50/50 — one colour by RGB alone, but
 *  not blank once alpha is part of the comparison. */
function alphaCheckerPng(n: number): Buffer {
  const png = new PNG({ width: n, height: n });
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      png.data[i] = 120;
      png.data[i + 1] = 90;
      png.data[i + 2] = 60;
      png.data[i + 3] = (x + y) % 2 === 0 ? 40 : 255;
    }
  }
  return PNG.sync.write(png);
}

const scene = runCheck(demoFlat()).ctx.scene as any;

function refs(): AssetRef[] {
  return sceneAssets(scene);
}

/** The author size of the prop each object asset belongs to. */
const sizeOfAsset = new Map<string, { w: number; d: number; h: number }>(
  ((scene.props ?? []) as any[]).map((p) => [String(p.asset), p.size]),
);

interface Fakes {
  glb?: Record<string, Buffer>;
  png?: Record<string, Buffer>;
}

/** Cache every referenced asset: objects as a box equal to the prop's own
 *  size unless `fakes` overrides them, images as a flat fake PNG. */
function fillCache(dir: string, fakes: Fakes = {}): string {
  for (const a of refs()) {
    if (a.kind === "object") {
      const own = sizeOfAsset.get(a.id);
      const buf = fakes.glb?.[a.id] ?? boxGlb(own?.w ?? 1, own?.d ?? 1, own?.h ?? 1);
      writeFileSync(join(dir, `${a.key}.glb`), buf);
    } else {
      const buf = fakes.png?.[a.id] ?? fakePng(4, 4, [120, 90, 60], a.kind === "decal");
      writeFileSync(join(dir, `${a.key}.png`), buf);
    }
  }
  return dir;
}

interface Built {
  dist: string;
  build: any;
}

function build(mode: "cache" | "none", fakes: Fakes = {}): Built {
  const out = join(tmp(), "dist");
  const args = ["--import", "tsx", "bin/dreamer.ts", "build", DEMO, "--out", out, "--assets", mode];
  if (mode === "cache") args.push("--cache", fillCache(tmp(), fakes));
  const r = spawnSync("node", args, { cwd: ENGINE, encoding: "utf-8" });
  expect(r.status).toBe(0);
  return { dist: out, build: JSON.parse(readFileSync(join(out, "build.json"), "utf-8")) };
}

function checkBuilt(dist: string): Report {
  fakeShots(dist);
  const report = join(tmp(), "r.json");
  const r = spawnSync(
    "node",
    ["--import", "tsx", "bin/dreamer.ts", "check", DEMO, "--report", report, "--built", dist],
    { cwd: ENGINE, encoding: "utf-8" },
  );
  expect(r.status).toBe(0);
  return JSON.parse(readFileSync(report, "utf-8")) as Report;
}

/** PROP_SIZE_ODD records the fact/size comparison raised for one prop. */
function factOdd(report: Report, id: string): any[] {
  return (report.warnings as any[]).filter(
    (w) => w.code === "PROP_SIZE_ODD" && String(w.msg).includes("факт") && String(w.msg).startsWith(`${id}:`),
  );
}

/** The placed OBB's own size, as `check --built` recorded it in the passport. */
function passportSize(report: Report, id: string): { w: number; d: number; h: number } {
  return (report.passport.props as any[]).find((p) => p.id === id).size;
}

/**
 * The OBB's own footprint and vertical span, read independently of the
 * `size` field: corner-to-corner distance (rotation-invariant) for w/d, and
 * the `y` interval height for h. This is what a walker actually collides
 * with and what the geometry builder actually draws — checking it directly
 * (not just the convenience `size` field next to it) catches a regression
 * where `size` gets updated to the fact but the OBB/vertical span used for
 * placement is left on the author's stale value.
 */
function passportObb(report: Report, id: string): { w: number; d: number; h: number } {
  const p = (report.passport.props as any[]).find((p) => p.id === id);
  const [c0, c1, c2] = p.obb as [number, number][];
  const dist = (a: [number, number], b: [number, number]): number =>
    Math.hypot(a[0] - b[0], a[1] - b[1]);
  return { w: dist(c0, c1), d: dist(c1, c2), h: p.y[1] - p.y[0] };
}

describe("props by fact", () => {
  it("test_fact_size_warns", () => {
    const b = build("cache", { glb: { p_sofa: boxGlb(1, 1, 1) } });
    expect(b.build.props.sofa.fact).toEqual({ w: 0.85, d: 0.85, h: 0.85 });
    const report = checkBuilt(b.dist);
    const odd = factOdd(report, "sofa");
    expect(odd.length).toBe(1);
    expect(odd[0].fix).toEqual({ size: { w: 0.85, d: 0.85, h: 0.85 } });
    // the OBB a walker bumps into must be the measured box, not the author's size
    expect(passportSize(report, "sofa")).toEqual({ w: 0.85, d: 0.85, h: 0.85 });
    const obb = passportObb(report, "sofa");
    expect(obb.w).toBeCloseTo(0.85, 6);
    expect(obb.d).toBeCloseTo(0.85, 6);
    expect(obb.h).toBeCloseTo(0.85, 6);
  }, 60000);

  it("test_fact_close_no_warning", () => {
    const b = build("cache", { glb: { p_sofa: boxGlb(2.0, 0.9, 0.85) } });
    expect(b.build.props.sofa.fact.w).toBeCloseTo(2.0, 6);
    expect(b.build.props.sofa.fact.d).toBeCloseTo(0.9, 6);
    const report = checkBuilt(b.dist);
    expect(factOdd(report, "sofa")).toEqual([]);
    const size = passportSize(report, "sofa");
    expect(size.w).toBeCloseTo(2.0, 6);
    expect(size.d).toBeCloseTo(0.9, 6);
    expect(size.h).toBeCloseTo(0.85, 6);
  }, 60000);

  it("test_fact_null_for_placeholder", () => {
    const b = build("none");
    for (const p of ["table", "chairs", "sofa", "vase", "lamp"]) {
      expect(b.build.props[p]).toEqual({ fact: null });
    }
    const report = checkBuilt(b.dist);
    expect((report.warnings as any[]).filter((w) => String(w.msg).includes("факт"))).toEqual([]);
    // without a fact the OBB must fall back to the author's own size
    const rawSofa = ((demoFlat() as any).props as any[]).find((p) => p.id === "sofa");
    expect(passportSize(report, "sofa")).toEqual(rawSofa.size);
    const obb = passportObb(report, "sofa");
    expect(obb.w).toBeCloseTo(rawSofa.size.w, 6);
    expect(obb.d).toBeCloseTo(rawSofa.size.d, 6);
    expect(obb.h).toBeCloseTo(rawSofa.size.h, 6);
  }, 60000);

  it("test_glb_broken_uses_author_size_for_obb", () => {
    // a broken GLB leaves `fact: null`, so the OBB must still be the
    // author's size, not left stuck on some stale or zeroed value
    const junk = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const b = build("cache", { glb: { p_sofa: junk } });
    const report = checkBuilt(b.dist);
    const rawSofa = ((demoFlat() as any).props as any[]).find((p) => p.id === "sofa");
    expect(passportSize(report, "sofa")).toEqual(rawSofa.size);
    const obb = passportObb(report, "sofa");
    expect(obb.w).toBeCloseTo(rawSofa.size.w, 6);
    expect(obb.d).toBeCloseTo(rawSofa.size.d, 6);
    expect(obb.h).toBeCloseTo(rawSofa.size.h, 6);
  }, 60000);

  it("test_blank_texture_warned", () => {
    const b = build("cache", { png: { t_floor: checkerPng(8) } });
    expect(b.build.warnings).toContain("ASSET_BLANK t_wall");
    expect(b.build.warnings).not.toContain("ASSET_BLANK t_floor");
  }, 60000);

  it("test_glb_broken_warned", () => {
    const junk = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const b = build("cache", { glb: { p_sofa: junk } });
    expect(b.build.warnings).toContain("ASSET_GLB_BROKEN p_sofa");
    expect(b.build.props.sofa.fact).toBe(null);
  }, 60000);

  it("test_blank_check_considers_alpha", () => {
    // same RGB everywhere, alpha varies: a naive RGB-only comparison would
    // wrongly call this blank
    const b = build("cache", { png: { t_wall: alphaCheckerPng(8) } });
    expect(b.build.warnings).not.toContain("ASSET_BLANK t_wall");
  }, 60000);

  it("test_fact_full_precision_not_rounded_away", () => {
    // sofa's authored size is {w:2, d:0.9, h:0.85}; a fact of w:2.4004 is
    // 20.02% over size.w — a warning is required — but round3(2.4004) is
    // 2.4, exactly 20% over, which would wrongly clear the threshold
    const report = runCheck(demoFlat(), { facts: { sofa: { w: 2.4004, d: 0.9, h: 0.85 } } }).report;
    const odd = factOdd(report, "sofa");
    expect(odd.length).toBe(1);
    expect(odd[0].fix).toEqual({ size: { w: 2.4, d: 0.9, h: 0.85 } });
  });

  it("test_built_props_use_fact_for_obb", () => {
    // end-to-end through the real CLI: `build` measures the fact, `check
    // --built` must place the OBB by it, not by the author's `size`.
    // Height matches sofa's authored size.h (0.85) so the fit scale is 1
    // and the fact equals this box exactly; w/d shrink so the smaller OBB
    // still clears the wall it sits against.
    const sofaFact = { w: 1, d: 0.7, h: 0.85 };
    const b = build("cache", { glb: { p_sofa: boxGlb(sofaFact.w, sofaFact.d, sofaFact.h) } });
    expect(b.build.props.sofa.fact).toEqual(sofaFact);
    const builtReport = checkBuilt(b.dist);
    expect(passportSize(builtReport, "sofa")).toEqual(sofaFact);
    const builtObb = passportObb(builtReport, "sofa");
    expect(builtObb.w).toBeCloseTo(sofaFact.w, 6);
    expect(builtObb.d).toBeCloseTo(sofaFact.d, 6);
    expect(builtObb.h).toBeCloseTo(sofaFact.h, 6);

    const noAssets = build("none");
    const rawSofa = ((demoFlat() as any).props as any[]).find((p) => p.id === "sofa");
    const noneReport = checkBuilt(noAssets.dist);
    expect(passportSize(noneReport, "sofa")).toEqual(rawSofa.size);
    const noneObb = passportObb(noneReport, "sofa");
    expect(noneObb.w).toBeCloseTo(rawSofa.size.w, 6);
    expect(noneObb.d).toBeCloseTo(rawSofa.size.d, 6);
    expect(noneObb.h).toBeCloseTo(rawSofa.size.h, 6);
  }, 60000);
  it("test_glb_zero_height_is_broken", () => {
    // a model with no height cannot be fitted to the prop's `h`, so it is
    // as unusable as one that would not parse: the prop must fall back to a
    // placeholder and say so, not keep a GLB whose fact is silently `null`
    const b = build("cache", { glb: { p_sofa: boxGlb(2, 0.9, 0) } });
    expect(b.build.warnings).toContain("ASSET_GLB_BROKEN p_sofa");
    expect(b.build.props.sofa.fact).toBe(null);
    const geometry = JSON.parse(readFileSync(join(b.dist, "geometry.json"), "utf-8"));
    const sofa = (geometry.meshes as any[]).find((m) => m.id === "sofa");
    expect(sofa.glb).toBe(undefined);
  }, 60000);
});
