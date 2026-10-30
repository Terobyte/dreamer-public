import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeGlb, readGlb, writeGlb } from "../src/assets/glb.js";
import { fakeGlb } from "../src/assets/providers/fake.js";
import { cachePaths } from "../src/assets/cache.js";
import { sceneAssets } from "../src/assets/run.js";
import { placeAssets } from "../src/build/materials.js";
import { runCheck } from "../src/check.js";

type Mat4 = number[];

const ID: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major multiply, independent of the one under test. */
function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

function apply(m: Mat4, p: [number, number, number]): [number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function local(node: Record<string, unknown>): Mat4 {
  if (Array.isArray(node.matrix)) return node.matrix as Mat4;
  const t = (node.translation as number[] | undefined) ?? [0, 0, 0];
  const q = (node.rotation as number[] | undefined) ?? [0, 0, 0, 1];
  const s = (node.scale as number[] | undefined) ?? [1, 1, 1];
  const [x, y, z, w] = q;
  const r = [
    1 - 2 * (y * y + z * z),
    2 * (x * y + w * z),
    2 * (x * z - w * y),
    2 * (x * y - w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z + w * x),
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
  ];
  return [
    r[0] * s[0],
    r[1] * s[0],
    r[2] * s[0],
    0,
    r[3] * s[1],
    r[4] * s[1],
    r[5] * s[1],
    0,
    r[6] * s[2],
    r[7] * s[2],
    r[8] * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

/** Every POSITION vertex of the default scene, in world space. */
function worldPoints(buf: Buffer): [number, number, number][] {
  const { json, bin } = readGlb(buf);
  const j = json as unknown as Record<string, any>;
  const out: [number, number, number][] = [];
  const walk = (index: number, parent: Mat4): void => {
    const node = j.nodes[index] as Record<string, unknown>;
    const world = mul(parent, local(node));
    if (typeof node.mesh === "number") {
      for (const prim of j.meshes[node.mesh].primitives) {
        const acc = j.accessors[prim.attributes.POSITION];
        const view = j.bufferViews[acc.bufferView];
        const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        for (let i = 0; i < acc.count; i++) {
          const o = base + i * 12;
          out.push(apply(world, [bin!.readFloatLE(o), bin!.readFloatLE(o + 4), bin!.readFloatLE(o + 8)]));
        }
      }
    }
    for (const child of (node.children as number[] | undefined) ?? []) walk(child, world);
  };
  for (const root of j.scenes[j.scene ?? 0].nodes as number[]) walk(root, ID);
  return out;
}

function bbox(buf: Buffer): { min: [number, number, number]; max: [number, number, number] } {
  const pts = worldPoints(buf);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p[a]);
      max[a] = Math.max(max[a], p[a]);
    }
  }
  return { min, max };
}

/** The fake triangle re-parented under one node with the given TRS. */
function underNode(trs: Record<string, unknown>): Buffer {
  const { json, bin } = readGlb(fakeGlb());
  const j = json as unknown as Record<string, any>;
  const roots = j.scenes[0].nodes as number[];
  j.nodes.push({ ...trs, children: roots });
  j.scenes[0].nodes = [j.nodes.length - 1];
  return writeGlb(json, bin);
}

describe("glb container", () => {
  it("test_glb_roundtrip", () => {
    const src = fakeGlb();
    const { json, bin } = readGlb(src);
    const again = readGlb(writeGlb(json, bin));
    expect(again.json).toEqual(json);
    expect(again.bin).toEqual(bin);
  });
});

describe("normalizeGlb", () => {
  it("test_normalize_bottom_centre", () => {
    const before = bbox(fakeGlb());
    expect(before.min).toEqual([1, 2, -0.5]);

    const { glb, size } = normalizeGlb(fakeGlb(), 0);
    expect(size.w).toBeCloseTo(2, 6);
    expect(size.d).toBeCloseTo(1, 6);
    expect(size.h).toBeCloseTo(2, 6);

    const after = bbox(glb);
    expect(after.min[0]).toBeCloseTo(-1, 6);
    expect(after.max[0]).toBeCloseTo(1, 6);
    expect(after.min[1]).toBeCloseTo(0, 6);
    expect(after.max[1]).toBeCloseTo(2, 6);
    expect(after.min[2]).toBeCloseTo(-0.5, 6);
    expect(after.max[2]).toBeCloseTo(0.5, 6);

    const { json } = readGlb(glb);
    for (const mat of json.materials ?? []) expect(mat.pbrMetallicRoughness?.metallicFactor).toBe(0);
  });

  it("test_normalize_front", () => {
    const { glb, size } = normalizeGlb(fakeGlb(), 90);
    expect(size.w).toBeCloseTo(1, 6);
    expect(size.d).toBeCloseTo(2, 6);
    expect(size.h).toBeCloseTo(2, 6);

    // The source vertex with the biggest x is index 1 of the fake triangle.
    const pts = worldPoints(glb);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i][2] > pts[best][2]) best = i;
    expect(best).toBe(1);
  });

  it("test_normalize_default_material", () => {
    const { json, bin } = readGlb(fakeGlb());
    const j = json as unknown as Record<string, any>;
    j.materials = [{}];
    j.meshes[0].primitives.push({ attributes: { POSITION: 0 } });
    delete j.meshes[0].primitives[0].material;

    const { glb } = normalizeGlb(writeGlb(json, bin), 0);
    const out = readGlb(glb).json as unknown as Record<string, any>;
    for (const mat of out.materials) expect(mat.pbrMetallicRoughness.metallicFactor).toBe(0);
    for (const mesh of out.meshes) {
      for (const prim of mesh.primitives) expect(typeof prim.material).toBe("number");
    }
  });

  it("test_bbox_node_trs", () => {
    const src = underNode({ translation: [5, 0, 0], rotation: [0.7071068, 0, 0, 0.7071068] });
    const before = bbox(src);
    expect(before.min[0]).toBeCloseTo(6, 6);
    expect(before.max[0]).toBeCloseTo(8, 6);
    expect(before.min[1]).toBeCloseTo(-0.5, 6);
    expect(before.max[1]).toBeCloseTo(0.5, 6);
    expect(before.min[2]).toBeCloseTo(2, 6);
    expect(before.max[2]).toBeCloseTo(4, 6);

    const { glb, size } = normalizeGlb(src, 0);
    expect(size.w).toBeCloseTo(2, 6);
    expect(size.d).toBeCloseTo(2, 6);
    expect(size.h).toBeCloseTo(1, 6);

    const after = bbox(glb);
    expect(after.min[0]).toBeCloseTo(-1, 6);
    expect(after.max[0]).toBeCloseTo(1, 6);
    expect(after.min[1]).toBeCloseTo(0, 6);
    expect(after.max[1]).toBeCloseTo(1, 6);
    expect(after.min[2]).toBeCloseTo(-1, 6);
    expect(after.max[2]).toBeCloseTo(1, 6);
  });

  it("test_normalize_multi_mesh_rotates_each_point", () => {
    // Three single-point meshes at (1,0,0), (0,0,1), (0,0,0): rotating the
    // merged AABB corners (old bug) overstates depth to sqrt(2); rotating
    // each point before merging gives the true bound of 1/sqrt(2).
    const points: [number, number, number][] = [
      [1, 0, 0],
      [0, 0, 1],
      [0, 0, 0],
    ];
    const vertexFloats = points.flatMap((p) => [...p, ...p, ...p]);
    const bin = Buffer.from(new Float32Array(vertexFloats).buffer);
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1, 2] }],
      nodes: points.map((_, i) => ({ mesh: i })),
      meshes: points.map((_, i) => ({ primitives: [{ attributes: { POSITION: i } }] })),
      accessors: points.map((p, i) => ({
        bufferView: i,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: p,
        max: p,
      })),
      bufferViews: points.map((_, i) => ({ buffer: 0, byteOffset: i * 36, byteLength: 36 })),
      buffers: [{ byteLength: 108 }],
    };

    const { size } = normalizeGlb(writeGlb(json, bin), 45);
    expect(size.w).toBeCloseTo(Math.SQRT2, 6);
    expect(size.d).toBeCloseTo(1 / Math.SQRT2, 6);
    expect(size.h).toBeCloseTo(0, 6);
  });
});

describe("readGlb length check", () => {
  it("test_rejects_wrong_declared_length", () => {
    const buf = Buffer.from(fakeGlb());
    buf.writeUInt32LE(12, 8);
    expect(() => readGlb(buf)).toThrow();
  });
});

describe("foliage alpha", () => {
  // Tripo bakes leaves into an opaque JPEG with no alpha channel; a material
  // left at the default OPAQUE draws the leaf shards as black flakes.
  it("test_oak_leaf_material_is_cut_out", () => {
    const oak = readFileSync(new URL("./fixtures/oak_tripo.glb", import.meta.url));
    // the oak's material is named `tripo_material_<uuid>`: nothing in the
    // file says "leaf", so the asset itself is declared foliage
    const { json } = readGlb(normalizeGlb(oak, 0, { foliage: true }).glb);
    expect(json.materials?.length).toBeGreaterThan(0); // every() is void on []
    const modes = (json.materials ?? []).map((m) => m.alphaMode);
    expect(modes.every((m) => m === "MASK" || m === "BLEND")).toBe(true);
  });

  it("test_flat_untextured_material_stays_opaque", () => {
    const { json } = readGlb(normalizeGlb(Buffer.from(fakeGlb()), 0).glb);
    for (const m of json.materials ?? []) expect(m.alphaMode ?? "OPAQUE").toBe("OPAQUE");
  });

  it("test_single_sided_jpeg_stays_opaque", () => {
    // Regression: an ordinary single-sided JPEG-textured prop must not be
    // rewritten to MASK — only double-sided foliage is.
    const tri = new Float32Array([1, 2, -0.5, 3, 2, 0.5, 2, 4, 0]);
    const triBytes = Buffer.from(tri.buffer);
    const jpegStub = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const bin = Buffer.concat([triBytes, jpegStub]);
    const gltf = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { metallicFactor: 1, baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ mimeType: "image/jpeg", bufferView: 1 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [1, 2, -0.5],
          max: [3, 4, 0.5],
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: triBytes.length },
        { buffer: 0, byteOffset: triBytes.length, byteLength: jpegStub.length },
      ],
      buffers: [{ byteLength: bin.length }],
    };
    const { json } = readGlb(normalizeGlb(writeGlb(gltf, bin), 0).glb);
    expect(json.materials?.[0]?.alphaMode ?? "OPAQUE").toBe("OPAQUE");
  });

  it("test_tripo_named_ordinary_prop_stays_opaque", () => {
    // F10: a provider name alone must not mark foliage. An ordinary Tripo
    // prop named `tripo_material_1234` with a double-sided stub JPEG stays
    // OPAQUE — only the oak fixture's real cutout texture goes to MASK.
    const tri = new Float32Array([1, 2, -0.5, 3, 2, 0.5, 2, 4, 0]);
    const triBytes = Buffer.from(tri.buffer);
    const jpegStub = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const bin = Buffer.concat([triBytes, jpegStub]);
    const gltf = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          name: "tripo_material_1234",
          doubleSided: true,
          pbrMetallicRoughness: { metallicFactor: 1, baseColorTexture: { index: 0 } },
        },
      ],
      textures: [{ source: 0 }],
      images: [{ mimeType: "image/jpeg", bufferView: 1 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [1, 2, -0.5],
          max: [3, 4, 0.5],
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: triBytes.length },
        { buffer: 0, byteOffset: triBytes.length, byteLength: jpegStub.length },
      ],
      buffers: [{ byteLength: bin.length }],
    };
    const { json } = readGlb(normalizeGlb(writeGlb(gltf, bin), 0).glb);
    expect(json.materials?.[0]?.alphaMode ?? "OPAQUE").toBe("OPAQUE");
  });

  it("test_tripo_named_real_jpeg_without_uvs_stays_opaque", () => {
    // F13: a provider name plus real decodable JPEG bytes is still not proof
    // of foliage. An ordinary Tripo prop whose geometry has no TEXCOORD_0
    // cannot sample a cutout texture, so it stays OPAQUE; only UV-mapped
    // shards (the oak fixture) go to MASK.
    const oakBuf = readFileSync(new URL("./fixtures/oak_tripo.glb", import.meta.url));
    const oak = readGlb(oakBuf);
    const oakViews = (oak.json.bufferViews ?? []) as { byteOffset?: number; byteLength?: number }[];
    const oakImages = (oak.json.images ?? []) as { bufferView?: unknown }[];
    const oakBv = oakViews[oakImages[0]?.bufferView as number] as {
      byteOffset?: number;
      byteLength?: number;
    };
    const off = oakBv.byteOffset ?? 0;
    const jpeg = Buffer.from((oak.bin as Buffer).subarray(off, off + (oakBv.byteLength as number)));
    expect(jpeg[0]).toBe(0xff); // really the oak's decodable JPEG, not a stub
    expect(jpeg[1]).toBe(0xd8);
    const tri = new Float32Array([1, 2, -0.5, 3, 2, 0.5, 2, 4, 0]);
    const triBytes = Buffer.from(tri.buffer);
    const bin = Buffer.concat([triBytes, jpeg]);
    const gltf = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          name: "tripo_material_1234",
          doubleSided: true,
          pbrMetallicRoughness: { metallicFactor: 1, baseColorTexture: { index: 0 } },
        },
      ],
      textures: [{ source: 0 }],
      images: [{ mimeType: "image/jpeg", bufferView: 1 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [1, 2, -0.5],
          max: [3, 4, 0.5],
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: triBytes.length },
        { buffer: 0, byteOffset: triBytes.length, byteLength: jpeg.length },
      ],
      buffers: [{ byteLength: bin.length }],
    };
    const { json } = readGlb(normalizeGlb(writeGlb(gltf, bin), 0).glb);
    expect(json.materials?.[0]?.alphaMode ?? "OPAQUE").toBe("OPAQUE");
  });

  it("test_double_sided_jpeg_stays_opaque", () => {
    // Regression: an ordinary double-sided JPEG-textured prop is not
    // foliage — only Tripo-baked / foliage-named materials go to MASK, so
    // its dark texels must stay opaque.
    const tri = new Float32Array([1, 2, -0.5, 3, 2, 0.5, 2, 4, 0]);
    const triBytes = Buffer.from(tri.buffer);
    const jpegStub = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const bin = Buffer.concat([triBytes, jpegStub]);
    const gltf = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          name: "dark_wood_panel",
          doubleSided: true,
          pbrMetallicRoughness: { metallicFactor: 1, baseColorTexture: { index: 0 } },
        },
      ],
      textures: [{ source: 0 }],
      images: [{ mimeType: "image/jpeg", bufferView: 1 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [1, 2, -0.5],
          max: [3, 4, 0.5],
        },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: triBytes.length },
        { buffer: 0, byteOffset: triBytes.length, byteLength: jpegStub.length },
      ],
      buffers: [{ byteLength: bin.length }],
    };
    const { json } = readGlb(normalizeGlb(writeGlb(gltf, bin), 0).glb);
    expect(json.materials?.[0]?.alphaMode ?? "OPAQUE").toBe("OPAQUE");
  });

  // The oak's real decodable JPEG on a UV-mapped double-sided triangle.
  const uvProp = (name: string) => {
    const oak = readGlb(readFileSync(new URL("./fixtures/oak_tripo.glb", import.meta.url)));
    const bv = (oak.json.bufferViews as { byteOffset?: number; byteLength: number }[])[
      (oak.json.images as { bufferView: number }[])[0].bufferView
    ];
    const jpeg = (oak.bin as Buffer).subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const p = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const u = Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer);
    const bin = Buffer.concat([p, u, jpeg]);
    return writeGlb(
      {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
        materials: [{ name, doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        textures: [{ source: 0 }],
        images: [{ mimeType: "image/jpeg", bufferView: 2 }],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
          { bufferView: 1, componentType: 5126, count: 3, type: "VEC2", min: [0, 0], max: [1, 1] },
        ],
        bufferViews: [
          { buffer: 0, byteLength: p.length },
          { buffer: 0, byteOffset: p.length, byteLength: u.length },
          { buffer: 0, byteOffset: p.length + u.length, byteLength: jpeg.length },
        ],
        buffers: [{ byteLength: bin.length }],
      },
      bin,
    );
  };

  it("test_uv_mapped_tripo_prop_with_real_jpeg_stays_opaque", () => {
    // F15: provider name + real JPEG + UVs is still an ordinary prop; only
    // an explicit foliage marker (asset flag or foliage material name) cuts.
    const { json } = readGlb(normalizeGlb(uvProp("tripo_material_1234"), 0).glb);
    expect(json.materials?.[0]?.alphaMode ?? "OPAQUE").toBe("OPAQUE");
    expect(json.materials?.[0]?.extras).toBeUndefined();
  });

  it("test_leaf_named_material_is_cut_out", () => {
    const { json } = readGlb(normalizeGlb(uvProp("oak_leaves"), 0).glb);
    expect(json.materials?.[0]?.alphaMode).toBe("MASK");
  });

  it("test_explicit_opaque_foliage_is_cut_out", () => {
    // F17: an explicit OPAQUE is the default spelled out, not a choice to keep
    const { json, bin } = readGlb(readFileSync(new URL("./fixtures/oak_tripo.glb", import.meta.url)));
    (json.materials as { alphaMode?: string }[])[0].alphaMode = "OPAQUE";
    const out = readGlb(normalizeGlb(writeGlb(json, bin), 0, { foliage: true }).glb).json;
    expect(out.materials?.[0]?.alphaMode).toBe("MASK");
  });
});

describe("foliage on the build path", () => {
  // the asset flag has to survive the schema and reach normalizeGlb through
  // placeAssets, or a real scene never gets the cutout the unit test proves
  const scene = (): any => {
    const s = JSON.parse(readFileSync(new URL("../../specs/examples/demo-flat.scene.json", import.meta.url), "utf-8"));
    s.assets.p_oak = { kind: "object", prompt: "a large oak tree", foliage: true };
    s.props[0].asset = "p_oak";
    return s;
  };

  it("the schema takes `foliage` on an asset and refuses a non-boolean", () => {
    expect(runCheck(scene()).report.errors).toEqual([]);
    const bad = scene();
    bad.assets.p_oak.foliage = "yes";
    expect(runCheck(bad).report.ok).toBe(false);
  });

  it("a scene asset declared foliage comes out of placeAssets with MASK leaves", () => {
    const s = scene();
    const { ctx, report } = runCheck(s);
    expect(report.ok).toBe(true);
    const ref = sceneAssets(ctx.scene).find((r) => r.id === "p_oak")!;
    const cacheDir = mkdtempSync(join(tmpdir(), "oak-cache-"));
    writeFileSync(cachePaths(cacheDir, ref.key).glb, readFileSync(new URL("./fixtures/oak_tripo.glb", import.meta.url)));
    const out = mkdtempSync(join(tmpdir(), "oak-dist-"));
    const placed = placeAssets(ctx.scene, cacheDir, ["p_oak"], out);
    expect(placed.files.p_oak).toBe("assets/p_oak.glb");
    const { json } = readGlb(readFileSync(join(out, "assets/p_oak.glb")));
    expect((json.materials ?? []).map((m) => m.alphaMode)).toEqual(["MASK"]);
    // the same asset without the flag stays opaque
    delete s.assets.p_oak.foliage;
    const plain = runCheck(s);
    const out2 = mkdtempSync(join(tmpdir(), "oak-dist-"));
    const ref2 = sceneAssets(plain.ctx.scene).find((r) => r.id === "p_oak")!;
    writeFileSync(cachePaths(cacheDir, ref2.key).glb, readFileSync(new URL("./fixtures/oak_tripo.glb", import.meta.url)));
    placeAssets(plain.ctx.scene, cacheDir, ["p_oak"], out2);
    const opaque = readGlb(readFileSync(join(out2, "assets/p_oak.glb"))).json;
    expect((opaque.materials ?? []).map((m) => m.alphaMode ?? "OPAQUE")).toEqual(["OPAQUE"]);
  });
});
