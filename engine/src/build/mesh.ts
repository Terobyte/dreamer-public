import type { Mesh } from "./geometry.js";

export type V3 = [number, number, number];

/** Accumulates triangles of one mesh; winding always follows the given normal. */
export class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  private push(p: V3, n: V3, uv: [number, number]): number {
    const i = this.positions.length / 3;
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs.push(uv[0], uv[1]);
    return i;
  }

  /** one triangle; vertex order is flipped when it would face away from `n` */
  tri(a: V3, b: V3, c: V3, n: V3, uva: [number, number], uvb: [number, number], uvc: [number, number]): void {
    const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const dot = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2];
    const ia = this.push(a, n, uva);
    const ib = this.push(b, n, uvb);
    const ic = this.push(c, n, uvc);
    if (dot > 0) this.indices.push(ia, ib, ic);
    else this.indices.push(ia, ic, ib);
  }

  /** a planar quad a→b→c→d */
  quad(a: V3, b: V3, c: V3, d: V3, n: V3, uva: [number, number], uvb: [number, number], uvc: [number, number], uvd: [number, number]): void {
    this.tri(a, b, c, n, uva, uvb, uvc);
    this.tri(a, c, d, n, uva, uvc, uvd);
  }

  get empty(): boolean {
    return this.indices.length === 0;
  }

  finish(m: Omit<Mesh, "positions" | "normals" | "uvs" | "indices">): Mesh {
    return { ...m, positions: this.positions, normals: this.normals, uvs: this.uvs, indices: this.indices };
  }
}

export function meshBBox(m: Mesh): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], m.positions[i + k]);
      max[k] = Math.max(max[k], m.positions[i + k]);
    }
  }
  return { min, max };
}
