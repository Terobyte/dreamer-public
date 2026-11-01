import { PNG } from "pngjs";
import type { ImageSize } from "../templates.js";
import { MaskEmptyError, MaskMeshError, type ImageProvider, type ObjectProvider, type SceneMesh } from "./types.js";

/**
 * A tiny solid PNG. `whiteCorners` makes it usable as a decal: the alpha cut
 * floods from the corners, so it needs something white to start from.
 */
export function fakePng(width: number, height: number, rgb: [number, number, number], whiteCorners = false): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const corner = whiteCorners && (x === 0 || x === width - 1) && (y === 0 || y === height - 1);
      const c = corner ? ([255, 255, 255] as const) : rgb;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const TRIANGLE = [1, 2, -0.5, 3, 2, 0.5, 2, 4, 0];

function pad(buf: Buffer, byte: number): Buffer {
  const extra = (4 - (buf.length % 4)) % 4;
  return extra === 0 ? buf : Buffer.concat([buf, Buffer.alloc(extra, byte)]);
}

/**
 * One triangle, off-centre and off the floor, with the glTF default
 * `metallicFactor: 1` — exactly the shape of GLB SAM3D hands back, so the
 * normalizer has something real to recentre, drop and de-metal.
 */
export function fakeGlb(): Buffer {
  const bin = pad(Buffer.from(new Float32Array(TRIANGLE).buffer), 0);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { metallicFactor: 1 } }],
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

export class FakeImageProvider implements ImageProvider {
  readonly calls: { prompt: string; size: ImageSize }[] = [];

  constructor(private readonly rgb: [number, number, number] = [120, 90, 60]) {}

  async generate(prompt: string, size: ImageSize): Promise<Buffer> {
    this.calls.push({ prompt, size });
    return fakePng(4, 4, this.rgb, true);
  }

  readonly refCalls: { bytes: Buffer; what: string; prompt: string; size: ImageSize }[] = [];

  async fromRef(ref: { bytes: Buffer; what: string }, prompt: string, size: ImageSize): Promise<Buffer> {
    this.refCalls.push({ bytes: ref.bytes, what: ref.what, prompt, size });
    return fakePng(4, 4, this.rgb, true);
  }

  readonly edits: { prompt: string; width: number; height: number }[] = [];

  /** A stand-in painter: every gray (128) pixel becomes a row-wise blend of its nearest non-gray neighbours. */
  async edit(png: Buffer, prompt: string): Promise<Buffer> {
    const img = PNG.sync.read(png);
    const { width: w, height: h } = img;
    this.edits.push({ prompt, width: w, height: h });
    const gray = (i: number): boolean => img.data[i] === 128 && img.data[i + 1] === 128 && img.data[i + 2] === 128;
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!gray((y * w + x) * 4)) {
          x++;
          continue;
        }
        let e = x;
        while (e < w && gray((y * w + e) * 4)) e++;
        const a = Math.max(0, x - 1);
        const b = Math.min(w - 1, e);
        for (let k = x; k < e; k++) {
          const t = (k - a) / Math.max(1, b - a);
          for (let c = 0; c < 3; c++) {
            const va = img.data[(y * w + a) * 4 + c];
            const vb = img.data[(y * w + b) * 4 + c];
            img.data[(y * w + k) * 4 + c] = Math.round(va * (1 - t) + vb * t);
          }
        }
        x = e;
      }
    }
    return PNG.sync.write(img);
  }
}

export interface FakeObjectOpts {
  /** by `what`: `error` = segmentation throws, `empty` = MASK_EMPTY, `mesh` = SAM3D fails after the mask */
  fail?: Record<string, "error" | "empty" | "mesh">;
  /** the pose every `fromScene` mesh comes back with; none by default */
  pose?: object | null;
}

export class FakeObjectProvider implements ObjectProvider {
  readonly calls: { name: string }[] = [];
  readonly sceneCalls: { bytes: Buffer; what: string; size: ImageSize }[] = [];

  constructor(private readonly opts: FakeObjectOpts = {}) {}

  async fromScene(scene: { bytes: Buffer; what: string }, size: ImageSize): Promise<SceneMesh> {
    this.sceneCalls.push({ bytes: scene.bytes, what: scene.what, size });
    const fail = this.opts.fail?.[scene.what];
    if (fail === "error") throw new Error("fake segmentation app is down");
    if (fail === "empty") throw new MaskEmptyError();
    if (fail === "mesh") throw new MaskMeshError("fake SAM3D failed on the mask");
    return this.opts.pose === undefined ? { glb: fakeGlb() } : { glb: fakeGlb(), pose: this.opts.pose };
  }

  async mesh(_png: Buffer, name: string): Promise<Buffer> {
    this.calls.push({ name });
    return fakeGlb();
  }
}
