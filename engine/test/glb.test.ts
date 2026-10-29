import { describe, expect, it } from "vitest";
import { normalizeGlb, readGlb, writeGlb } from "../src/assets/glb.js";
import { fakeGlb } from "../src/assets/providers/fake.js";

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
