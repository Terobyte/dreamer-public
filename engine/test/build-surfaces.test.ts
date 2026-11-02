import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { readGlb, sceneTriangles, writeGlb } from "../src/assets/glb.js";
import { groupHeights, surfacesOf, worldSurfaces, type Surface } from "../src/build/surfaces.js";
import { demoFlat } from "./helpers/scene.js";
import { runCheck } from "../src/check.js";
import { sceneAssets } from "../src/assets/run.js";
import { fakeGlb, fakePng } from "../src/assets/providers/fake.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
const io = new NodeIO();

interface RawOpts {
  pos: number[];
  idx?: number[];
  idxType?: 5121 | 5123 | 5125;
  stride?: number;
  offset?: number;
  accOffset?: number;
  mode?: number;
  sparse?: boolean;
  matrix?: number[];
  bufferIndex?: number;
}

/** a GLB written by hand, so every accessor field the reader supports can be set */
function rawGlb(o: RawOpts): Buffer {
  const n = o.pos.length / 3;
  const stride = o.stride ?? 12;
  const viewOff = o.offset ?? 0;
  const accOff = o.accOffset ?? 0;
  const posLen = accOff + n * stride;
  const parts: Buffer[] = [Buffer.alloc(viewOff + posLen)];
  const bin0 = parts[0];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) bin0.writeFloatLE(o.pos[i * 3 + k], viewOff + accOff + i * stride + k * 4);
  }
  const json: any = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: o.matrix ? [{ children: [1], matrix: o.matrix }, { mesh: 0 }] : [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, byteOffset: accOff || undefined, componentType: 5126, count: n, type: "VEC3" }],
    bufferViews: [{ buffer: o.bufferIndex ?? 0, byteOffset: viewOff, byteLength: posLen, byteStride: o.stride }],
  };
  // placeAssets measures the model from accessor min/max
  const mm = (k: number): number[] => o.pos.filter((_, i) => i % 3 === k);
  json.accessors[0].min = [0, 1, 2].map((k) => Math.min(...mm(k)));
  json.accessors[0].max = [0, 1, 2].map((k) => Math.max(...mm(k)));
  if (o.sparse) json.accessors[0].sparse = { count: 1 };
  if (o.mode !== undefined) json.meshes[0].primitives[0].mode = o.mode;
  if (o.idx) {
    const type = o.idxType ?? 5125;
    const size = type === 5121 ? 1 : type === 5123 ? 2 : 4;
    const have = bin0.length;
    const at = Math.ceil(have / 4) * 4;
    parts.push(Buffer.alloc(at - have));
    const ib = Buffer.alloc(o.idx.length * size);
    o.idx.forEach((v, i) => (size === 1 ? ib.writeUInt8(v, i) : size === 2 ? ib.writeUInt16LE(v, i * 2) : ib.writeUInt32LE(v, i * 4)));
    parts.push(ib);
    json.accessors.push({ bufferView: 1, componentType: type, count: o.idx.length, type: "SCALAR" });
    json.bufferViews.push({ buffer: o.bufferIndex ?? 0, byteOffset: at, byteLength: ib.length });
    json.meshes[0].primitives[0].indices = 1;
  }
  const bin = Buffer.concat(parts);
  json.buffers = [{ byteLength: bin.length }];
  return writeGlb(json, bin);
}

type Q = [number, number, number, number, number]; // x0 z0 x1 z1 y

/** flat up-facing quads (counter-clockwise seen from above) */
function quads(list: Q[]): { pos: number[]; idx: number[] } {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const [x0, z0, x1, z1, y] of list) {
    const b = pos.length / 3;
    pos.push(x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return { pos, idx };
}

async function makeDocGlb(opts: {
  pos: number[];
  idx?: number[];
  matrix?: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
}): Promise<Buffer> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType("VEC3").setArray(new Float32Array(opts.pos)).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute("POSITION", position);
  if (opts.idx) {
    prim.setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(opts.idx)).setBuffer(buffer));
  }
  const mesh = doc.createMesh().addPrimitive(prim);
  const node = doc.createNode().setMesh(mesh);
  let root = node;
  if (opts.matrix) {
    root = doc.createNode().addChild(node).setMatrix(opts.matrix);
  }
  doc.createScene().addChild(root);
  const u8 = await io.writeBinary(doc);
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

const glbDocOf = async (list: Q[]): Promise<Buffer> => makeDocGlb(quads(list));

describe("surfacesOf", () => {
  it("test_bed: mattress is one surface, posts are not", async () => {
    const post = (x: number, z: number): Q => [x, z, x + 0.05, z + 0.05, 0.75];
    const s = surfacesOf(
      await glbDocOf([[0, 0, 1, 2, 0.3], [0.05, 0.05, 0.95, 1.95, 0.45], post(0, 0), post(0.95, 0), post(0, 1.95), post(0.95, 1.95)]),
    );
    const mat = s.filter((x) => Math.abs(x.y - 0.45) < 0.01);
    expect(mat).toHaveLength(1);
    expect(mat[0].area).toBeGreaterThanOrEqual(1.5);
    expect(s.some((x) => Math.abs(x.y - 0.75) < 0.01)).toBe(false);
    expect(mat[0].origin).toEqual([0, 0]);
    expect(mat[0].open).toBe(true);
  });

  it("test_waves: +-1.5 cm mattress is one surface", async () => {
    const pos: number[] = [];
    const idx: number[] = [];
    const nx = 4, nz = 8, h = 0.2;
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) pos.push(i * h, 0.45 + ((i + j) % 2 ? 0.015 : -0.015), j * h);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, d = a + 1, b = a + nx + 1, c = b + 1;
        idx.push(a, b, c, a, c, d);
      }
    }
    expect(surfacesOf(await makeDocGlb({ pos, idx }))).toHaveLength(1);
  });

  const tri = (x: number): number[] => [x, 0.5, 0, x, 0.5, 0.05, x + 0.025, 0.5, 0.025];
  const patchDoc = async (x: number): Promise<Buffer> => {
    const q = quads([[0, 0, 0.35, 0.05, 0.5]]);
    return makeDocGlb({ pos: [...q.pos, ...tri(x)], idx: [...q.idx, 4, 5, 6] });
  };

  it("test_edge_through_center: edge exactly through the cell center counts", async () => {
    const s = surfacesOf(await patchDoc(0.375));
    expect(s).toHaveLength(1);
    expect(s[0].area).toBeCloseTo(0.02, 9);
  });

  it("test_edge_short_by_1mm: no surface", async () => {
    expect(surfacesOf(await patchDoc(0.376))).toEqual([]);
  });

  it("test_height_groups: 0, 0.009, 0.018 are two layers", () => {
    expect(groupHeights([0.018, 0, 0.009])).toEqual([0.0045, 0.018]);
  });

  it("test_shelf: 4 boards, only the top one is open", async () => {
    const s = surfacesOf(await glbDocOf([0.05, 0.4, 0.75, 1.1].map((y): Q => [0, 0, 0.8, 0.3, y])));
    expect(s.map((x) => x.open)).toEqual([false, false, false, true]);
    expect(s.map((x) => x.y)).toEqual([0.05, 0.4, 0.75, 1.1].map((y) => expect.closeTo(y, 5)));
  });

  it("test_partial_cover: upper board over < half leaves the lower one open", async () => {
    const s = surfacesOf(await glbDocOf([[0, 0, 1, 0.3, 0.1], [0, 0, 0.4, 0.3, 0.4]]));
    expect(s).toHaveLength(2);
    expect(s[0].open).toBe(true);
  });

  it("test_node_matrix: normalizeGlb-style root matrix moves the surface", async () => {
    const q = quads([[2, 3, 3, 4, 0.5]]);
    const m: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number] = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      3, 2, 5, 1,
    ];
    const s = surfacesOf(await makeDocGlb({ ...q, matrix: m }));
    expect(s).toHaveLength(1);
    expect(s[0].y).toBeCloseTo(2.5, 5);
    expect(s[0].origin[0]).toBeCloseTo(5, 5);
    expect(s[0].origin[1]).toBeCloseTo(8, 5);
  });

  it("test_deterministic and test_no_up_faces", async () => {
    const g = await glbDocOf([[0, 0, 1, 1, 0.5]]);
    expect(surfacesOf(g)).toEqual(surfacesOf(g));
    // a wall: vertical triangles only
    expect(surfacesOf(await makeDocGlb({ pos: [0, 0, 0, 1, 0, 0, 1, 1, 0], idx: [0, 1, 2] }))).toEqual([]);
  });
});

describe("sceneTriangles", () => {
  const collect = (g: Buffer): number[][][] => {
    const { json, bin } = readGlb(g);
    return [...sceneTriangles(json, bin as Buffer)].map((t) => t.map((v) => [...v]));
  };

  it("indexed triangles under a translation node are shifted", async () => {
    const q = quads([[0, 0, 1, 1, 0]]);
    const plain = collect(await makeDocGlb(q));
    const moved = collect(
      await makeDocGlb({ ...q, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1] }),
    );
    expect(plain).toHaveLength(2);
    expect(moved[0][0][0]).toBeCloseTo(plain[0][0][0] + 1, 6);
  });

  it("byteOffset and byteStride 16 give the same triangles; every index type works", () => {
    const q = quads([[0, 0, 1, 1, 0.2]]);
    const base = collect(rawGlb(q));
    expect(collect(rawGlb({ ...q, offset: 8, accOffset: 4, stride: 16 }))).toEqual(base);
    expect(collect(rawGlb({ ...q, idxType: 5121 }))).toEqual(base);
    expect(collect(rawGlb({ ...q, idxType: 5123 }))).toEqual(base);
  });

  it("no mode field means triangles; a non-triangle mode is skipped; no indices means consecutive", () => {
    expect(collect(rawGlb({ pos: [0, 0, 0, 0, 0, 1, 1, 0, 1] }))).toHaveLength(1);
    expect(collect(rawGlb({ pos: [0, 0, 0, 0, 0, 1, 1, 0, 1], mode: 1 }))).toHaveLength(0);
  });

  it("sparse accessors are an error", () => {
    const g = rawGlb({ pos: [0, 0, 0, 0, 0, 1, 1, 0, 1], sparse: true });
    expect(() => surfacesOf(g)).toThrow("glb: unsupported accessor");
  });

  it("non-BIN buffer in bufferView throws unsupported accessor", () => {
    const g = rawGlb({ pos: [0, 0, 0, 0, 0, 1, 1, 0, 1], bufferIndex: 1 });
    expect(() => surfacesOf(g)).toThrow("glb: unsupported accessor");
  });
});

describe("worldSurfaces", () => {
  const local: Surface = { y: 1, rect: [0, 0, 1, 0.5], area: 0.5, open: true, origin: [0, 0], cells: [[0, 0]] };

  it("rotates, scales and moves; area follows scale squared", () => {
    const w = worldSurfaces([local], { scale: 2, glbYaw: Math.PI / 2, glbPos: [10, 0, 20] })[0];
    expect(w.rect[0]).toBeCloseTo(10, 6);
    expect(w.rect[1]).toBeCloseTo(18, 6);
    expect(w.rect[2]).toBeCloseTo(11, 6);
    expect(w.rect[3]).toBeCloseTo(20, 6);
    expect(w.y).toBeCloseTo(2, 6);
    expect(w.area).toBeCloseTo(2, 6);
    expect(w.poly).toHaveLength(4);
    expect(w.cells).toEqual(local.cells);
    expect(w.origin).toEqual(local.origin);
  });

  it("scaleY only touches y", () => {
    const w = worldSurfaces([local], { scale: 2, scaleY: 0.5, glbYaw: 0, glbPos: [0, 0, 0] })[0];
    expect(w.y).toBeCloseTo(0.5, 6);
    expect(w.area).toBeCloseTo(2, 6);
    expect(w.rect[2]).toBeCloseTo(2, 6);
  });
});

function oneVaseScene(dir: string, assetId = "p_vase"): string {
  const s: any = demoFlat();
  s.props = (s.props as any[]).filter((p) => p.id === "vase");
  const vase = s.props[0];
  vase.asset = assetId;
  delete s.assets.p_vase;
  s.assets[assetId] = { kind: "object", prompt: "vase" };
  vase.size = { w: 0.25, d: 0.25, h: 0.4 };
  vase.mount = "floor";
  vase.at = [0, 0];
  const path = join(dir, "one.scene.json");
  writeFileSync(path, JSON.stringify(s));
  return path;
}

function buildWith(vaseGlb: Buffer, opts?: { assetId?: string }): { out: string; build: any; geo: any } {
  const assetId = opts?.assetId ?? "p_vase";
  const dir = mkdtempSync(join(tmpdir(), "dreamer-surf-"));
  const scene = oneVaseScene(dir, assetId);
  for (const a of sceneAssets(runCheck(JSON.parse(readFileSync(scene, "utf-8"))).ctx.scene)) {
    const p = join(dir, `${a.key}.${a.kind === "object" ? "glb" : "png"}`);
    if (a.kind === "object") writeFileSync(p, a.id === assetId ? vaseGlb : fakeGlb());
    else writeFileSync(p, fakePng(4, 4, [120, 90, 60], a.kind === "decal"));
  }
  const out = join(mkdtempSync(join(tmpdir(), "dreamer-surf-out-")), "dist");
  const r = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", "build", scene, "--out", out, "--assets", "cache", "--cache", dir], {
    cwd: ENGINE,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`build failed: ${r.stdout}${r.stderr}`);
  return {
    out,
    build: JSON.parse(readFileSync(join(out, "build.json"), "utf-8")),
    geo: JSON.parse(readFileSync(join(out, "geometry.json"), "utf-8")),
  };
}

/** a plate of `nx` x `nz` quads, top face up, assembled via @gltf-transform/core */
async function docPlate(nx: number, nz: number): Promise<Buffer> {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) pos.push(i / nx - 0.5, 0.5, j / nz - 0.5);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, d = a + 1, b = a + nx + 1, c = b + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  // a down-facing triangle at y = 0 gives the slab a height, else placeAssets calls it broken
  const base = pos.length / 3;
  pos.push(-0.5, 0, -0.5, 0.5, 0, -0.5, -0.5, 0, 0.5);
  idx.push(base, base + 1, base + 2);
  return makeDocGlb({ pos, idx });
}

/** handwritten plate for testing unsupported accessor fields/layouts */
function rawPlate(nx: number, nz: number, extra?: Partial<RawOpts>): Buffer {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) pos.push(i / nx - 0.5, 0.5, j / nz - 0.5);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, d = a + 1, b = a + nx + 1, c = b + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  const base = pos.length / 3;
  pos.push(-0.5, 0, -0.5, 0.5, 0, -0.5, -0.5, 0, 0.5);
  idx.push(base, base + 1, base + 2);
  return rawGlb({ pos, idx, ...extra });
}

describe("writeDist surfaces", () => {
  it("writes surfaces per mesh id", async () => {
    const b = buildWith(await docPlate(4, 4));
    expect(b.build.surfaces.vase.length).toBeGreaterThan(0);
    expect(b.build.surfaces.vase[0].poly).toHaveLength(4);
  }, 120000);

  it("a model with no up faces gets [] and SURFACES_EMPTY", async () => {
    const noUp = await makeDocGlb({
      pos: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
      idx: [0, 1, 2, 3, 4, 5],
    });
    const b = buildWith(noUp);
    expect(b.build.warnings).not.toContain("ASSET_GLB_BROKEN vase");
    expect(b.build.surfaces.vase).toEqual([]);
    expect(b.build.warnings.some((w: string) => w.startsWith("SURFACES_EMPTY vase"))).toBe(true);
  }, 120000);

  it("a broken GLB has no key in surfaces", () => {
    const b = buildWith(Buffer.from("not a glb at all"));
    expect(b.build.warnings.some((w: string) => w.startsWith("ASSET_GLB_BROKEN"))).toBe(true);
    expect(Object.keys(b.build.surfaces)).not.toContain("vase");
  }, 120000);

  it("surfaces come from the cut file in dist, not the cache", async () => {
    const b = buildWith(await docPlate(80, 50));
    expect(b.build.assets.cut.p_vase.to).toBeLessThanOrEqual(1000);
    const mesh = b.geo.meshes.find((m: any) => m.id === "vase");
    const file = readFileSync(join(b.out, "assets", "p_vase.glb"));
    const want = JSON.parse(JSON.stringify(worldSurfaces(surfacesOf(file), mesh)));
    expect(b.build.surfaces.vase).toEqual(want);
  }, 120000);

  it("non-BIN buffer in bufferView falls back to [] and SURFACES_EMPTY in writeDist", () => {
    const b = buildWith(rawPlate(2, 2, { bufferIndex: 1 }));
    expect(b.build.surfaces.vase).toEqual([]);
    expect(b.build.warnings).toContain("SURFACES_EMPTY vase");
    expect(b.build.warnings).not.toContain("ASSET_GLB_BROKEN vase");
  }, 120000);

  it("sparse accessor falls back to [] and SURFACES_EMPTY in writeDist", () => {
    const b = buildWith(rawPlate(2, 2, { sparse: true }));
    expect(b.build.surfaces.vase).toEqual([]);
    expect(b.build.warnings).toContain("SURFACES_EMPTY vase");
    expect(b.build.warnings).not.toContain("ASSET_GLB_BROKEN vase");
  }, 120000);

  it("F5: a placed GLB with a URL-special asset id produces its surfaces without SURFACES_EMPTY", async () => {
    const b = buildWith(await docPlate(4, 4), { assetId: "vase#custom" });
    expect(b.build.warnings).not.toContain("SURFACES_EMPTY vase");
    expect(b.build.surfaces.vase.length).toBeGreaterThan(0);
  }, 120000);

  it("contract: non-prop mesh is ignored by meshSurfaces", async () => {
    // contract check: only meshes with kind: 'prop' and glb string are in surfaces
    const b = buildWith(await docPlate(4, 4));
    expect(Object.keys(b.build.surfaces)).toEqual(["vase"]);
  }, 120000);
});
