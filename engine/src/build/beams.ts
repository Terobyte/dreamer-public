import type { V2 } from "../geom/vec.js";
import type { Mesh } from "./geometry.js";
import { MeshBuilder } from "./mesh.js";
import type { V3 } from "./mesh.js";

/** An axis-aligned-in-plan box from `from` to `to`, `w` wide, spanning y. */
export function boxMesh(
  id: string,
  kind: Mesh["kind"],
  material: string,
  room: string,
  from: V2,
  to: V2,
  w: number,
  y0: number,
  y1: number,
): Mesh {
  const d: V2 = [to[0] - from[0], to[1] - from[1]];
  const l = Math.hypot(d[0], d[1]) || 1;
  const ax: V2 = [d[0] / l, d[1] / l];
  const pr: V2 = [-ax[1], ax[0]];
  const h = w / 2;
  const corner = (s: number, side: number, y: number): V3 => [
    from[0] + ax[0] * (s * l) + pr[0] * side * h,
    y,
    from[1] + ax[1] * (s * l) + pr[1] * side * h,
  ];
  const mb = new MeshBuilder();
  // meter-scaled UVs local to each face: (u, v) spans the face's own physical
  // width/length and height, so vertical side faces keep their y extent in V
  // instead of collapsing it through a flattened [x, z] (F13)
  const face = (
    a: V3,
    b: V3,
    c: V3,
    e: V3,
    n: V3,
    uvs: [[number, number], [number, number], [number, number], [number, number]],
  ): void => mb.quad(a, b, c, e, n, uvs[0], uvs[1], uvs[2], uvs[3]);
  const yh = y1 - y0;
  // top, bottom: u along length, v across width
  face(corner(0, -1, y1), corner(1, -1, y1), corner(1, 1, y1), corner(0, 1, y1), [0, 1, 0], [
    [0, 0],
    [l, 0],
    [l, w],
    [0, w],
  ]);
  face(corner(0, -1, y0), corner(1, -1, y0), corner(1, 1, y0), corner(0, 1, y0), [0, -1, 0], [
    [0, 0],
    [l, 0],
    [l, w],
    [0, w],
  ]);
  // long sides: u along length, v along height
  face(corner(0, 1, y0), corner(1, 1, y0), corner(1, 1, y1), corner(0, 1, y1), [pr[0], 0, pr[1]], [
    [0, 0],
    [l, 0],
    [l, yh],
    [0, yh],
  ]);
  face(corner(0, -1, y0), corner(1, -1, y0), corner(1, -1, y1), corner(0, -1, y1), [-pr[0], 0, -pr[1]], [
    [0, 0],
    [l, 0],
    [l, yh],
    [0, yh],
  ]);
  // ends: u across width, v along height
  face(corner(1, -1, y0), corner(1, 1, y0), corner(1, 1, y1), corner(1, -1, y1), [ax[0], 0, ax[1]], [
    [0, 0],
    [w, 0],
    [w, yh],
    [0, yh],
  ]);
  face(corner(0, -1, y0), corner(0, 1, y0), corner(0, 1, y1), corner(0, -1, y1), [-ax[0], 0, -ax[1]], [
    [0, 0],
    [w, 0],
    [w, yh],
    [0, yh],
  ]);
  return mb.finish({ id, kind, material, room });
}
