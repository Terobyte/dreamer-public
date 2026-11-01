import type { GlbSizes, AssetFiles } from "./geometry.js";

/** copies keep at least this far from each other and from every `avoid` point (m) */
export const SCATTER_STEP = 0.8;
/** a copy's height is drawn from this range (m) */
const H_RANGE: [number, number] = [0.3, 0.6];

export interface ScatterRaw {
  assets: string[];
  count: number;
  area: [number, number, number, number];
  seed: number;
  avoid?: [number, number][];
}

export interface ScatterPoint {
  asset: string;
  x: number;
  z: number;
  yaw: number;
  h: number;
}

/** One asset of one `scatter`: the page draws it as a single InstancedMesh. */
export interface ScatterEntry {
  i: number;
  asset: string;
  glb: string | null;
  count: number;
  /** per copy: `[x, y, z, yaw, scale]`, the GLB is normalized (bottom at y = 0) */
  transforms: number[][];
}

/** mulberry32: the only source of "random" here, so one seed gives one layout */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed-shuffled 0.8 lattice first, then dart throwing, then a grid sweep for
 * what random tries missed, then an analytic pass for holes smaller than the
 * grid step. The lattice goes first so greedy darts cannot block lattice
 * slots (a 3x3 m area always fits the 4x4 x 0.8 m grid). Zero copies when
 * `avoid` alone covers the whole area is `SCATTER_EMPTY`; fewer than `count`
 * (or zero because earlier sets took the room) is a `SCATTER_FEWER` warning.
 */
export function scatterPoints(raw: ScatterRaw, label = "scatter", extra: [number, number][] = []): { points: ScatterPoint[]; warnings: string[] } {
  const [x0, z0, x1, z1] = raw.area;
  const minx = Math.min(x0, x1), maxx = Math.max(x0, x1), minz = Math.min(z0, z1), maxz = Math.max(z0, z1);
  const rng = rngOf(raw.seed);
  const avoid = raw.avoid ?? [];
  const placed: [number, number][] = [];
  const clearOf = (x: number, z: number, set: [number, number][]): boolean =>
    set.every((p) => Math.hypot(x - p[0], z - p[1]) >= SCATTER_STEP);
  // `extra` holds copies placed by earlier `scatter` sets: one layout per set
  // would otherwise stack identical centres on top of each other (F9)
  const free = (x: number, z: number): boolean =>
    clearOf(x, z, avoid) && clearOf(x, z, extra) && clearOf(x, z, placed);
  // 0.8-lattice (both edges sampled, F12): shuffled with the seeded rng, so
  // one seed gives one layout and different seeds give different subsets
  const xs0: number[] = [];
  for (let x = minx; x <= maxx - 1e-9; x += SCATTER_STEP) xs0.push(x);
  if (xs0.length === 0 || xs0[xs0.length - 1] < maxx - 1e-9) xs0.push(maxx);
  const zs0: number[] = [];
  for (let z = minz; z <= maxz - 1e-9; z += SCATTER_STEP) zs0.push(z);
  if (zs0.length === 0 || zs0[zs0.length - 1] < maxz - 1e-9) zs0.push(maxz);
  const lattice: [number, number][] = [];
  for (const x of xs0) for (const z of zs0) lattice.push([x, z]);
  for (let k = lattice.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [lattice[k], lattice[j]] = [lattice[j], lattice[k]];
  }
  for (const [x, z] of lattice) {
    if (placed.length >= raw.count) break;
    if (free(x, z)) placed.push([x, z]);
  }
  for (let n = 0; n < raw.count * 40 && placed.length < raw.count; n++) {
    const x = minx + rng() * (maxx - minx);
    const z = minz + rng() * (maxz - minz);
    if (free(x, z)) placed.push([x, z]);
  }
  if (placed.length < raw.count) {
    // fixed 0.1 steps from min miss the far edge (a 0.01-wide area gets a
    // single row): sample both edges so a sliver near maxx/maxz is found
    const xs: number[] = [];
    for (let x = minx; x < maxx; x += 0.1) xs.push(x);
    xs.push(maxx);
    const zs: number[] = [];
    for (let z = minz; z < maxz; z += 0.1) zs.push(z);
    zs.push(maxz);
    for (const x of xs) {
      if (placed.length >= raw.count) break;
      for (const z of zs) {
        if (placed.length >= raw.count) break;
        if (free(x, z)) placed.push([x, z]);
      }
    }
  }
  if (placed.length < raw.count) {
    // Ascent pass for holes smaller than the grid step (a free disc no dart
    // throw or 0.1 grid ever lands in, F3/F8): the clearance maximum sits
    // strictly inside the hole, not on any avoid-circle crossing, so walk
    // uphill from deterministic starts instead of testing crossings. Only a
    // pass that finds nothing throws SCATTER_EMPTY.
    const R = SCATTER_STEP;
    const starts: [number, number][] = [[(minx + maxx) / 2, (minz + maxz) / 2]];
    for (const v of avoid) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        starts.push([v[0] + R * Math.cos(a), v[1] + R * Math.sin(a)]);
      }
      starts.push(
        [minx, Math.min(maxz, Math.max(minz, v[1]))],
        [maxx, Math.min(maxz, Math.max(minz, v[1]))],
        [Math.min(maxx, Math.max(minx, v[0])), minz],
        [Math.min(maxx, Math.max(minx, v[0])), maxz],
      );
      for (const bx of [minx, maxx]) {
        const t = R * R - (bx - v[0]) * (bx - v[0]);
        if (t >= 0) {
          const s = Math.sqrt(t);
          starts.push([bx, v[1] + s], [bx, v[1] - s]);
        }
      }
      for (const bz of [minz, maxz]) {
        const t = R * R - (bz - v[1]) * (bz - v[1]);
        if (t >= 0) {
          const s = Math.sqrt(t);
          starts.push([v[0] + s, bz], [v[0] - s, bz]);
        }
      }
    }
    for (let i = 0; i < avoid.length; i++) {
      for (let j = i + 1; j < avoid.length; j++) {
        const dx = avoid[j][0] - avoid[i][0];
        const dz = avoid[j][1] - avoid[i][1];
        const d = Math.hypot(dx, dz);
        if (d > 2 * R || d < 1e-12) continue;
        const mx = (avoid[i][0] + avoid[j][0]) / 2;
        const mz = (avoid[i][1] + avoid[j][1]) / 2;
        const h = Math.sqrt(Math.max(0, R * R - (d / 2) * (d / 2)));
        starts.push([mx + (-dz / d) * h, mz + (dx / d) * h], [mx - (-dz / d) * h, mz - (dx / d) * h]);
      }
    }
    const clampX = (x: number): number => Math.min(maxx, Math.max(minx, x));
    const clampZ = (z: number): number => Math.min(maxz, Math.max(minz, z));
    const clearance = (x: number, z: number): number => {
      let c = Infinity;
      for (const set of [avoid, extra, placed]) {
        for (const p of set) {
          const d = Math.hypot(x - p[0], z - p[1]);
          if (d < c) c = d;
        }
      }
      return c;
    };
    const span = Math.max(maxx - minx, maxz - minz);
    const climb = (sx: number, sz: number): [number, number] | null => {
      let x = clampX(sx), z = clampZ(sz);
      let c = clearance(x, z);
      let step = (span > 0 ? span : 1) / 2;
      for (let iter = 0; iter < 120 && step > 1e-12; iter++) {
        let bx = x, bz = z, bc = c;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const nx = clampX(x + step * Math.cos(a));
          const nz = clampZ(z + step * Math.sin(a));
          const nc = clearance(nx, nz);
          if (nc > bc) {
            bx = nx;
            bz = nz;
            bc = nc;
          }
        }
        if (bc > c) {
          x = bx;
          z = bz;
          c = bc;
          if (c >= SCATTER_STEP) return [x, z];
        } else {
          step /= 2;
        }
      }
      return c >= SCATTER_STEP ? [x, z] : null;
    };
    for (const [sx, sz] of starts) {
      if (placed.length >= raw.count) break;
      const hit = climb(sx, sz);
      if (hit !== null && free(hit[0], hit[1])) placed.push(hit);
    }
  }
  // `extra` (copies of earlier sets) never means SCATTER_EMPTY: only `avoid`
  // covering the whole area throws, otherwise zero placed is SCATTER_FEWER
  if (placed.length === 0) {
    const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
    const probe: [number, number][] = [
      ...lattice,
      [cx, cz],
      [minx, cz],
      [maxx, cz],
      [cx, minz],
      [cx, maxz],
    ];
    if (!probe.some(([x, z]) => clearOf(x, z, avoid)))
      throw new Error(`SCATTER_EMPTY ${label}: every point of the area is within ${SCATTER_STEP} m of an avoid point`);
  }
  const warnings: string[] = [];
  if (placed.length < raw.count) warnings.push(`SCATTER_FEWER ${label}: ${placed.length} of ${raw.count} copies fit with a ${SCATTER_STEP} m step`);
  const points = placed.map(([x, z]) => ({
    asset: raw.assets[Math.floor(rng() * raw.assets.length)],
    x,
    z,
    yaw: rng() * Math.PI * 2,
    h: H_RANGE[0] + rng() * (H_RANGE[1] - H_RANGE[0]),
  }));
  return { points, warnings };
}

/** All `scatter` sets merged per asset: one entry (one transform set, one InstancedMesh) per asset. */
export function scatterEntries(scene: any, files: AssetFiles = {}, sizes: GlbSizes = {}): { entries: ScatterEntry[]; warnings: string[] } {
  const by = new Map<string, { i: number; glb: string | null; transforms: number[][] }>();
  const warnings: string[] = [];
  const taken: [number, number][] = [];
  ((scene?.scatter ?? []) as ScatterRaw[]).forEach((raw, i) => {
    const r = scatterPoints(raw, `scatter[${i}]`, taken);
    warnings.push(...r.warnings);
    for (const p of r.points) taken.push([p.x, p.z]);
    for (const p of r.points) {
      const gh = sizes[p.asset]?.h;
      const scale = gh !== undefined && gh > 0 ? p.h / gh : p.h;
      let e = by.get(p.asset);
      if (!e) {
        e = { i, glb: files[p.asset] ?? null, transforms: [] };
        by.set(p.asset, e);
      }
      e.transforms.push([p.x, 0, p.z, p.yaw, scale]);
    }
  });
  return { entries: [...by].map(([asset, e]) => ({ i: e.i, asset, glb: e.glb, count: e.transforms.length, transforms: e.transforms })), warnings };
}
