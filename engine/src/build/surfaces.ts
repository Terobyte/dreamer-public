import { readGlb, sceneTriangles, type V3 } from "../assets/glb.js";

/** A horizontal, upward-facing area of a model: a mattress, a shelf board, a table top. */
export interface Surface {
  y: number;
  /** `[x0, z0, x1, z1]`, the box around the cells */
  rect: [number, number, number, number];
  area: number;
  /** nothing sits over it within half a metre (a lower shelf under a board is closed) */
  open: boolean;
  /** corner of the model's grid, model system */
  origin: [number, number];
  /** `[i, j]` of every cell of the area, ascending i then j */
  cells: [number, number][];
}

export interface WorldSurface extends Surface {
  /** the rotated rectangle's corners */
  poly: [number, number][];
}

export interface SurfaceMesh {
  scale?: number;
  scaleY?: number;
  glbYaw?: number;
  glbPos?: [number, number, number];
}

const CELL = 0.05;
const MAX_CELLS = 400;
const MIN_AREA = 0.02;
const UP = 0.85;
const GROUP = 0.01;
const LINK = 0.03;
const CLOSE_GAP = 0.5;
const EPS = 1e-9;

/** Heights of one cell cut into layers: a height joins the group while it is under the group's minimum + 1 cm. */
export function groupHeights(heights: number[]): number[] {
  const sorted = [...heights].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const h of sorted) {
    const g = groups[groups.length - 1];
    if (g !== undefined && h < g[0] + GROUP) g.push(h);
    else groups.push([h]);
  }
  return groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Surfaces of a normalized model, found by looking at it from above on a 5 cm grid. */
export function surfacesOf(glb: Buffer): Surface[] {
  const { json, bin } = readGlb(glb);
  const tris = [...sceneTriangles(json, bin)];
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const t of tris) {
    for (const v of t) {
      minX = Math.min(minX, v[0]);
      maxX = Math.max(maxX, v[0]);
      minZ = Math.min(minZ, v[2]);
      maxZ = Math.max(maxZ, v[2]);
    }
  }
  if (tris.length === 0) return [];
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL - 1e-9));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL - 1e-9));
  if (nx > MAX_CELLS || nz > MAX_CELLS) return [];

  const heights = new Map<number, number[]>();
  for (const [a, b, c] of tris) {
    const u = sub(b, a);
    const v = sub(c, a);
    const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len === 0 || n[1] / len < UP) continue;
    const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (det === 0) continue;
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - minX) / CELL) - 1);
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0], c[0]) - minX) / CELL) + 1);
    const j0 = Math.max(0, Math.floor((Math.min(a[2], b[2], c[2]) - minZ) / CELL) - 1);
    const j1 = Math.min(nz - 1, Math.ceil((Math.max(a[2], b[2], c[2]) - minZ) / CELL) + 1);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const px = minX + (i + 0.5) * CELL;
        const pz = minZ + (j + 0.5) * CELL;
        const l1 = ((b[2] - c[2]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[2])) / det;
        const l2 = ((c[2] - a[2]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[2])) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -EPS || l2 < -EPS || l3 < -EPS) continue;
        const key = i * nz + j;
        const list = heights.get(key);
        const y = l1 * a[1] + l2 * b[1] + l3 * c[1];
        if (list === undefined) heights.set(key, [y]);
        else list.push(y);
      }
    }
  }

  // nodes: one per (cell, layer); union neighbours whose layers are within 3 cm
  const layers = new Map<number, number[]>();
  for (const [key, hs] of heights) layers.set(key, groupHeights(hs));
  const nodeId = new Map<string, number>();
  const info: { key: number; y: number }[] = [];
  for (const [key, ys] of layers) {
    ys.forEach((y, k) => {
      nodeId.set(`${key}:${k}`, info.length);
      info.push({ key, y });
    });
  }
  const parent = info.map((_, k) => k);
  const find = (k: number): number => {
    while (parent[k] !== k) k = parent[k] = parent[parent[k]];
    return k;
  };
  for (const [key, ys] of layers) {
    const i = Math.floor(key / nz);
    const j = key % nz;
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      if (i + di >= nx || j + dj >= nz) continue;
      const other = layers.get((i + di) * nz + j + dj);
      if (other === undefined) continue;
      ys.forEach((y, k) =>
        other.forEach((y2, k2) => {
          if (Math.abs(y - y2) <= LINK + 1e-9) parent[find(nodeId.get(`${key}:${k}`)!)] = find(nodeId.get(`${(i + di) * nz + j + dj}:${k2}`)!);
        }),
      );
    }
  }
  const comps = new Map<number, { key: number; y: number }[]>();
  info.forEach((n, k) => {
    const r = find(k);
    const list = comps.get(r);
    if (list === undefined) comps.set(r, [n]);
    else list.push(n);
  });

  const found: Surface[] = [];
  for (const members of comps.values()) {
    const cellKeys = [...new Set(members.map((m) => m.key))].sort((a, b) => a - b);
    if (cellKeys.length * CELL * CELL < MIN_AREA - 1e-12) continue;
    const ys = members.map((m) => m.y).sort((a, b) => a - b);
    const mid = ys.length >> 1;
    const y = ys.length % 2 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2;
    const cells = cellKeys.map((k): [number, number] => [Math.floor(k / nz), k % nz]);
    const is = cells.map((c) => c[0]);
    const js = cells.map((c) => c[1]);
    found.push({
      y,
      rect: [minX + Math.min(...is) * CELL, minZ + Math.min(...js) * CELL, minX + (Math.max(...is) + 1) * CELL, minZ + (Math.max(...js) + 1) * CELL],
      area: cells.length * CELL * CELL,
      open: true,
      origin: [minX, minZ],
      cells,
    });
  }
  found.sort((a, b) => a.y - b.y || a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1]);
  const sets = found.map((s) => new Set(s.cells.map((c) => c[0] * nz + c[1])));
  found.forEach((s) => {
    for (let m = 0; m < found.length; m++) {
      const gap = found[m].y - s.y;
      if (gap <= 0 || gap > CLOSE_GAP) continue;
      const covered = s.cells.filter((c) => sets[m].has(c[0] * nz + c[1])).length;
      if (covered * 2 >= s.cells.length) {
        s.open = false;
        break;
      }
    }
  });
  return found;
}

/** Surfaces of the model moved into the scene by the mesh's scale, yaw and position. */
export function worldSurfaces(local: Surface[], mesh: SurfaceMesh): WorldSurface[] {
  const s = mesh.scale ?? 1;
  const sy = mesh.scaleY ?? s;
  const yaw = mesh.glbYaw ?? 0;
  const [px, py, pz] = mesh.glbPos ?? [0, 0, 0];
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const place = (x: number, z: number): [number, number] => {
    const sx = x * s;
    const sz = z * s;
    return [sx * c + sz * sn + px, -sx * sn + sz * c + pz];
  };
  return local.map((f) => {
    const [x0, z0, x1, z1] = f.rect;
    const poly = [place(x0, z0), place(x1, z0), place(x1, z1), place(x0, z1)];
    const xs = poly.map((p) => p[0]);
    const zs = poly.map((p) => p[1]);
    return {
      y: f.y * sy + py,
      rect: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)],
      area: f.area * s * s,
      open: f.open,
      origin: f.origin,
      cells: f.cells,
      poly,
    };
  });
}
