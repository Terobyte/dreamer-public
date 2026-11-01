import { NodeIO } from "@gltf-transform/core";
import { simplify, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { glbTriangles } from "./tris.js";

const TRIES = 8;

/**
 * Cuts a GLB down to at most `tris` triangles (quadric simplification: UV
 * seams and materials stay). The cache keeps the full mesh; this runs at
 * build time, so one mesh can be cut differently per scene. A GLB already
 * under the limit comes back as the very same buffer.
 */
export async function cutGlb(buf: Buffer, tris: number): Promise<Buffer> {
  const from = glbTriangles(buf);
  if (from <= tris) return buf;
  await MeshoptSimplifier.ready;
  const io = new NodeIO();
  const target = Math.floor(tris * 0.9);
  let ratio = target / from;
  let got = from;
  for (let i = 0; i < TRIES; i++) {
    const doc = await io.readBinary(new Uint8Array(buf));
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: Math.max(0, Math.min(1, ratio)), error: 1 }));
    const out = Buffer.from(await io.writeBinary(doc));
    got = glbTriangles(out);
    if (got === 0) throw new Error(`CUT_EMPTY: ${from} -> 0 triangles (limit ${tris})`);
    if (got <= tris) return out;
    // the simplifier stopped short: aim again from what it reached
    ratio = ratio * (target / got) * 0.8;
  }
  throw new Error(`CUT_OVER: ${from} -> ${got} triangles, limit ${tris}`);
}
