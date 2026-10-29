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

/**
 * A flat quad of exactly 4 vertices: `center`, spanning ±`halfW` along `u`
 * and ±`halfH` along +Y, facing `n`. UVs run 0..1 over the whole quad, since
 * a decal or a backdrop carries one image stretched across its face.
 */
export function planeMesh(
  m: Omit<Mesh, "positions" | "normals" | "uvs" | "indices">,
  center: V3,
  n: V3,
  u: V3,
  halfW: number,
  halfH: number,
): Mesh {
  const at = (sw: number, sh: number): V3 => [
    center[0] + u[0] * sw * halfW,
    center[1] + sh * halfH,
    center[2] + u[2] * sw * halfW,
  ];
  const p: V3[] = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const uv: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  for (let i = 0; i < 4; i++) {
    positions.push(p[i][0], p[i][1], p[i][2]);
    normals.push(n[0], n[1], n[2]);
    uvs.push(uv[i][0], uv[i][1]);
  }
  // wind the pair of triangles to face `n`
  const a: V3 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const b: V3 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const cr: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const facing = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] > 0;
  const indices = facing ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  return { ...m, positions, normals, uvs, indices };
}
