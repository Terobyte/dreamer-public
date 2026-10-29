/**
 * GLB 2.0 container and the normalization every SAM3D mesh goes through before
 * it reaches the page: front to +Z, bottom on y = 0, footprint centred, and no
 * metal. The vertex buffer is never rewritten — the whole transform rides on a
 * single new root node, so the cached GLB and the scene's `size` stay apart.
 */

const MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export interface GltfMaterial {
  pbrMetallicRoughness?: { metallicFactor?: number; [k: string]: unknown };
  [k: string]: unknown;
}

export interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  [k: string]: unknown;
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  material?: number;
  [k: string]: unknown;
}

export interface GltfAccessor {
  min?: number[];
  max?: number[];
  [k: string]: unknown;
}

export interface GltfJson {
  scene?: number;
  scenes?: { nodes: number[]; [k: string]: unknown }[];
  nodes?: GltfNode[];
  meshes?: { primitives: GltfPrimitive[]; [k: string]: unknown }[];
  accessors?: GltfAccessor[];
  materials?: GltfMaterial[];
  [k: string]: unknown;
}

/** Column-major 4x4, same layout glTF uses for `node.matrix`. */
type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

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

function apply(m: Mat4, p: readonly number[]): [number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** `node.matrix` if present, else T·R·S from the separate fields. */
function nodeMatrix(node: GltfNode): Mat4 {
  if (node.matrix !== undefined) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx,
    2 * (qx * qy + qw * qz) * sx,
    2 * (qx * qz - qw * qy) * sx,
    0,
    2 * (qx * qy - qw * qz) * sy,
    (1 - 2 * (qx * qx + qz * qz)) * sy,
    2 * (qy * qz + qw * qx) * sy,
    0,
    2 * (qx * qz + qw * qy) * sz,
    2 * (qy * qz - qw * qx) * sz,
    (1 - 2 * (qx * qx + qy * qy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function yRotation(deg: number): Mat4 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function corners(min: readonly number[], max: readonly number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) out.push([x, y, z]);
    }
  }
  return out;
}

interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

function emptyBox(): Box {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function grow(box: Box, p: readonly number[]): void {
  for (let a = 0; a < 3; a++) {
    box.min[a] = Math.min(box.min[a], p[a]);
    box.max[a] = Math.max(box.max[a], p[a]);
  }
}

/** Reads the GLB container: the JSON chunk and the BIN chunk, if any. */
export function readGlb(buf: Buffer): { json: GltfJson; bin: Buffer | null } {
  if (buf.length < 12 || buf.readUInt32LE(0) !== MAGIC) throw new Error("glb: not a GLB file");
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new Error(`glb: unsupported version ${version}`);
  const declaredLength = buf.readUInt32LE(8);
  if (declaredLength !== buf.length) {
    throw new Error(`glb: header declares length ${declaredLength}, buffer is ${buf.length}`);
  }

  let json: GltfJson | null = null;
  let bin: Buffer | null = null;
  let at = 12;
  while (at + 8 <= buf.length) {
    const length = buf.readUInt32LE(at);
    const type = buf.readUInt32LE(at + 4);
    const start = at + 8;
    const end = start + length;
    if (end > buf.length) throw new Error("glb: chunk runs past end of file");
    if (type === CHUNK_JSON && json === null) json = JSON.parse(buf.subarray(start, end).toString("utf-8")) as GltfJson;
    else if (type === CHUNK_BIN && bin === null) bin = Buffer.from(buf.subarray(start, end));
    at = end;
  }
  if (json === null) throw new Error("glb: no JSON chunk");
  return { json, bin };
}

function pad(buf: Buffer, byte: number): Buffer {
  const extra = (4 - (buf.length % 4)) % 4;
  return extra === 0 ? buf : Buffer.concat([buf, Buffer.alloc(extra, byte)]);
}

function chunk(data: Buffer, type: number): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(data.length, 0);
  head.writeUInt32LE(type, 4);
  return Buffer.concat([head, data]);
}

/** Writes the GLB container back out. JSON pads with spaces, BIN with zeros. */
export function writeGlb(json: GltfJson, bin: Buffer | null): Buffer {
  const jsonChunk = chunk(pad(Buffer.from(JSON.stringify(json), "utf-8"), 0x20), CHUNK_JSON);
  const binChunk = bin === null ? Buffer.alloc(0) : chunk(pad(bin, 0), CHUNK_BIN);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + jsonChunk.length + binChunk.length, 8);
  return Buffer.concat([header, jsonChunk, binChunk]);
}

/**
 * Bounding box of the default scene, from accessor min/max, under `prefix`
 * applied on top of each node's world matrix. Each primitive's 8 corners are
 * transformed and grown into the box individually — never merge first and
 * rotate the merged box, since that overstates the bound once meshes sit at
 * different world positions.
 */
function sceneBbox(json: GltfJson, roots: number[], prefix: Mat4 = IDENTITY): Box {
  const nodes = json.nodes ?? [];
  const box = emptyBox();
  const walk = (index: number, parent: Mat4): void => {
    const node = nodes[index];
    if (node === undefined) return;
    const world = mul(parent, nodeMatrix(node));
    if (typeof node.mesh === "number") {
      for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
        const acc = json.accessors?.[prim.attributes.POSITION];
        if (acc?.min === undefined || acc.max === undefined) continue;
        for (const corner of corners(acc.min, acc.max)) grow(box, apply(world, corner));
      }
    }
    for (const child of node.children ?? []) walk(child, world);
  };
  for (const root of roots) walk(root, prefix);
  return box;
}

/** glTF's default material is metal, which comes out black — kill it. */
function deMetal(json: GltfJson): void {
  const materials = (json.materials ??= []);
  for (const mat of materials) {
    const pbr = (mat.pbrMetallicRoughness ??= {});
    pbr.metallicFactor = 0;
  }
  let fallback = -1;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      if (typeof prim.material === "number") continue;
      if (fallback < 0) {
        materials.push({ pbrMetallicRoughness: { metallicFactor: 0 } });
        fallback = materials.length - 1;
      }
      prim.material = fallback;
    }
  }
}

/**
 * Turns the asset's front (which points at `frontDeg` by the angle table)
 * towards +Z, drops its bottom onto y = 0 and centres its footprint on the
 * origin. `size` is the bound after that rotation, before the page's scale.
 */
export function normalizeGlb(
  buf: Buffer,
  frontDeg: number,
): { glb: Buffer; size: { w: number; d: number; h: number } } {
  const { json, bin } = readGlb(buf);
  const sceneIndex = json.scene ?? 0;
  const scene = json.scenes?.[sceneIndex];
  if (scene === undefined) throw new Error("glb: no default scene");
  const nodes = (json.nodes ??= []);

  const rot = yRotation(-frontDeg);
  const after = sceneBbox(json, scene.nodes, rot);
  if (!Number.isFinite(after.min[0])) throw new Error("glb: scene has no positions");

  const size = {
    w: after.max[0] - after.min[0],
    d: after.max[2] - after.min[2],
    h: after.max[1] - after.min[1],
  };
  const shift: Mat4 = [
    ...IDENTITY.slice(0, 12),
    -(after.min[0] + after.max[0]) / 2,
    -after.min[1],
    -(after.min[2] + after.max[2]) / 2,
    1,
  ];

  nodes.push({ children: [...scene.nodes], matrix: mul(shift, rot) });
  scene.nodes = [nodes.length - 1];
  deMetal(json);

  return { glb: writeGlb(json, bin), size };
}
