import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { Document, NodeIO, getBounds } from "@gltf-transform/core";
import { cutGlb } from "../src/assets/cut.js";
import { glbTriangles } from "../src/assets/tris.js";
import { demoFlat } from "./helpers/scene.js";
import { runCheck } from "../src/check.js";
import { sceneAssets } from "../src/assets/run.js";
import { fakeGlb, fakePng } from "../src/assets/providers/fake.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));

function png(): Uint8Array {
  const p = new PNG({ width: 4, height: 4 });
  p.data.fill(200);
  return new Uint8Array(PNG.sync.write(p));
}

/** A UV sphere (or a box-ish plate when `plate`) with a textured material. */
async function makeGlb(opts: { seg: number; rows?: number; plate?: boolean; texture?: boolean }): Promise<Buffer> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const n = opts.seg;
  const m = opts.rows ?? n;
  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= n; j++) {
      const u = j / n;
      const v = i / m;
      if (opts.plate) {
        // a thin slab 1 x 0.02 x 1: top grid, the bottom is the same grid lowered
        pos.push(u - 0.5, 0.01, v - 0.5);
      } else {
        const th = u * Math.PI * 2;
        const ph = v * Math.PI;
        pos.push(Math.cos(th) * Math.sin(ph), Math.cos(ph), Math.sin(th) * Math.sin(ph));
      }
      uv.push(u, v);
    }
  }
  const row = n + 1;
  const quads = (base: number, flip: boolean) => {
    for (let i = 0; i < m; i++)
      for (let j = 0; j < n; j++) {
        const a = base + i * row + j, b = a + 1, c = a + row, d = c + 1;
        if (flip) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
  };
  quads(0, false);
  if (opts.plate) {
    const base = pos.length / 3;
    for (let k = 0; k < base; k++) {
      pos.push(pos[k * 3], -0.01, pos[k * 3 + 2]);
      uv.push(uv[k * 2], uv[k * 2 + 1]);
    }
    quads(base, true);
  }
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(pos)).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(uv)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(idx)).setBuffer(buffer));
  const mat = doc.createMaterial("blue").setBaseColorFactor([0.1, 0.2, 0.9, 1]);
  if (opts.texture !== false) {
    mat.setBaseColorTexture(doc.createTexture("skin").setImage(png()).setMimeType("image/png"));
  }
  prim.setMaterial(mat);
  const mesh = doc.createMesh("m").addPrimitive(prim);
  const node = doc.createNode("n").setMesh(mesh);
  doc.createScene("s").addChild(node);
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

async function read(buf: Buffer) {
  return new NodeIO().readBinary(new Uint8Array(buf));
}

function bboxSize(doc: Document): number[] {
  const b = getBounds(doc.getRoot().listScenes()[0]);
  return [0, 1, 2].map((k) => b.max[k] - b.min[k]);
}

describe("cutGlb", () => {
  it("cuts a 20k sphere to 1000, keeps bbox and material", async () => {
    const src = await makeGlb({ seg: 101 });
    expect(glbTriangles(src)).toBeGreaterThanOrEqual(20000);
    const out = await cutGlb(src, 1000);
    const n = glbTriangles(out);
    expect(n).toBeLessThanOrEqual(1000);
    expect(n).toBeGreaterThanOrEqual(300);
    const a = bboxSize(await read(src));
    const b = bboxSize(await read(out));
    for (let k = 0; k < 3; k++) expect(Math.abs(b[k] - a[k]) / a[k]).toBeLessThanOrEqual(0.05);
    const mats = (await read(out)).getRoot().listMaterials();
    expect(mats.map((m) => m.getName())).toEqual(["blue"]);
    mats[0].getBaseColorFactor().forEach((x, k) => expect(x).toBeCloseTo([0.1, 0.2, 0.9, 1][k], 5));
  }, 60000);

  it("returns the same bytes when already under the limit", async () => {
    const src = await makeGlb({ seg: 10 });
    expect(glbTriangles(src)).toBeLessThanOrEqual(1000);
    const out = await cutGlb(src, 1000);
    expect(out.equals(src)).toBe(true);
  });

  it("is deterministic", async () => {
    const src = await makeGlb({ seg: 60 });
    const a = await cutGlb(src, 1000);
    const b = await cutGlb(src, 1000);
    expect(a.equals(b)).toBe(true);
  }, 60000);

  it("keeps a flat plate 1 x 0.02 x 1", async () => {
    const src = await makeGlb({ seg: 60, plate: true });
    expect(glbTriangles(src)).toBeGreaterThan(1000);
    const out = await cutGlb(src, 1000);
    const n = glbTriangles(out);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(1000);
    const b = bboxSize(await read(out));
    expect(b[0]).toBeGreaterThan(0.95);
    expect(b[2]).toBeGreaterThan(0.95);
  }, 60000);

  it("fails on an impossible cut", async () => {
    const src = await makeGlb({ seg: 30 });
    await expect(cutGlb(src, 0)).rejects.toThrow(/CUT_EMPTY|CUT_OVER/);
  }, 60000);

  it("keeps the texture image, UVs and the material's link to it", async () => {
    const src = await makeGlb({ seg: 80 });
    const out = await cutGlb(src, 1000);
    const srcDoc = await read(src);
    const doc = await read(out);
    const img = srcDoc.getRoot().listTextures()[0].getImage()!;
    const tex = doc.getRoot().listTextures();
    expect(tex.length).toBe(1);
    expect(Buffer.from(tex[0].getImage()!).equals(Buffer.from(img))).toBe(true);
    const srcUv = Array.from(
      srcDoc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())[0].getAttribute("TEXCOORD_0")!.getArray()!,
    );
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    const srcU = spread(srcUv.filter((_, i) => i % 2 === 0));
    const srcV = spread(srcUv.filter((_, i) => i % 2 === 1));
    const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
    for (const p of prims) {
      const uvAcc = p.getAttribute("TEXCOORD_0");
      expect(uvAcc).not.toBe(null);
      const posAcc = p.getAttribute("POSITION")!;
      expect(uvAcc!.getCount()).toBe(posAcc.getCount());
      const uv = Array.from(uvAcc!.getArray()!);
      expect(uv.length).toBeGreaterThan(0);
      for (const x of uv) expect(Number.isFinite(x)).toBe(true);
      const us = uv.filter((_, i) => i % 2 === 0);
      const vs = uv.filter((_, i) => i % 2 === 1);
      // each coordinate keeps its own spread: one collapsed axis must not hide behind the other
      expect(spread(us)).toBeGreaterThan(0.5);
      expect(spread(vs)).toBeGreaterThan(0.5);
      expect(spread(us)).toBeCloseTo(srcU, 1);
      expect(spread(vs)).toBeCloseTo(srcV, 1);
      expect(p.getMaterial()?.getBaseColorTexture()).toBe(tex[0]);
    }
  }, 60000);
});

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** a single floor prop sized 0.4 m (small: 1000-triangle limit) */
function oneVaseScene(dir: string): string {
  const s: any = demoFlat();
  s.props = (s.props as any[]).filter((p) => p.id === "vase");
  const vase = s.props.find((p: any) => p.id === "vase");
  vase.size = { w: 0.25, d: 0.25, h: 0.4 };
  vase.mount = "floor";
  vase.at = [0, 0];
  const path = join(dir, "one.scene.json");
  writeFileSync(path, JSON.stringify(s));
  return path;
}

function buildScene(scene: string, cache: string): { build: any; status: number | null; stderr: string } {
  const out = join(mkdtempSync(join(tmpdir(), "dreamer-cut-")), "dist");
  const r = spawnSync(
    "node",
    ["--import", "tsx", "bin/dreamer.ts", "build", scene, "--out", out, "--assets", "cache", "--cache", cache],
    { cwd: ENGINE, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`build failed: ${r.stdout}${r.stderr}`);
  // check --built wants a shot per camera: fake them like camera-ref's built()
  const ids = (JSON.parse(readFileSync(join(out, "geometry.json"), "utf-8")).cameras as { id: string }[]).map(
    (c) => c.id,
  );
  mkdirSync(join(out, "shots"), { recursive: true });
  for (const id of ids) writeFileSync(join(out, "shots", `${id}.png`), fakePng(8, 8, [1, 2, 3]));
  const chk = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", "check", scene, "--built", out], {
    cwd: ENGINE,
    encoding: "utf-8",
  });
  return { build: JSON.parse(readFileSync(join(out, "build.json"), "utf-8")), status: chk.status, stderr: chk.stdout + chk.stderr };
}

describe("build cuts oversized meshes", () => {
  async function setup(vaseGlb: Buffer) {
    const dir = mkdtempSync(join(tmpdir(), "dreamer-cutscene-"));
    const scene = oneVaseScene(dir);
    const s = JSON.parse(readFileSync(scene, "utf-8"));
    let vasePath = "";
    for (const a of sceneAssets(runCheck(s).ctx.scene)) {
      const p = join(dir, `${a.key}.${a.kind === "object" ? "glb" : "png"}`);
      if (a.kind === "object") writeFileSync(p, a.id === "p_vase" ? vaseGlb : fakeGlb());
      else writeFileSync(p, fakePng(4, 4, [120, 90, 60], a.kind === "decal"));
      if (a.id === "p_vase") vasePath = p;
    }
    return { scene, cache: dir, vasePath };
  }

  it("cuts an 8000-triangle vase to its 1000 limit, cache untouched", async () => {
    // 80 x 50 quads, two triangles each: exactly 8000
    const glb = await makeGlb({ seg: 80, rows: 50 });
    expect(glbTriangles(glb)).toBe(8000);
    const { scene, cache, vasePath } = await setup(glb);
    const before = sha(vasePath);
    const from = glbTriangles(glb);
    const b = buildScene(scene, cache);
    expect(b.build.ok).toBe(true);
    expect(b.status, b.stderr).toBe(0);
    expect(b.build.assets.cut.p_vase.from).toBe(8000);
    expect(from).toBe(8000);
    expect(b.build.assets.cut.p_vase.to).toBeLessThanOrEqual(1000);
    expect(b.build.tris.by_prop.vase).toBeLessThanOrEqual(1000);
    expect(b.stderr).not.toMatch(/TRI_PROP_BUDGET/);
    expect(sha(vasePath)).toBe(before);
  }, 120000);

  it("leaves a mesh under the limit alone", async () => {
    const { scene, cache } = await setup(fakeGlb());
    const b = buildScene(scene, cache);
    expect(b.status, b.stderr).toBe(0);
    expect(b.build.assets.used).toContain("p_vase");
    expect(b.build.tris.by_prop.vase).toBeGreaterThan(0);
    expect(b.build.tris.by_prop.vase).toBeLessThanOrEqual(1000);
    expect(b.build.assets.cut?.p_vase).toBe(undefined);
  }, 120000);
});
