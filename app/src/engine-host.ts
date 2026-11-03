/**
 * IWSDK host for an engine-built world (spec X2). `buildWorld` (engine/) makes the plain three.js
 * subtree; this file only puts it into the IWSDK World: one entity for `root`, the shell for the
 * locomotor, the player on the engine spawn, and the engine nav as the last word on where to stand.
 * It does not import `three` itself (app/AGENTS.md): classes come from `@iwsdk/core`.
 */
import {
  Color,
  Group,
  LocomotionEnvironment,
  LocomotionSystem,
  Mesh,
  Vector3,
  createSystem,
  type World,
} from '@iwsdk/core';
import { TONE, buildWorld } from '../../engine/src/runtime/world.js';
import { navBit } from '../../engine/src/nav/floor.js';

export interface DreamerXrReport {
  oneThree: boolean;
  meshes: number;
  glb: { ok: number; total: number; failed: number };
  shell: number;
  /** [x, floorY, z, yawDeg] in metres and degrees */
  spawn: number[];
  /** [x, y, z] in metres */
  player: number[];
  offNav: number;
  ready: boolean;
  error: string;
}

/** Created before any loading so a failure has somewhere to go. */
const report: DreamerXrReport = {
  oneThree: false,
  meshes: 0,
  glb: { ok: 0, total: 0, failed: 0 },
  shell: 0,
  spawn: [],
  player: [],
  offNav: 0,
  ready: false,
  error: '',
};

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

export async function hostEngineWorld(world: World, base: string): Promise<void> {
  (window as unknown as { __dreamerXr: DreamerXrReport }).__dreamerXr = report;
  report.ready = false;
  report.error = '';
  try {
    await host(world, base);
  } catch (e) {
    report.error = String(e instanceof Error ? e.message : e) || 'unknown error';
    report.ready = false;
    console.error('dreamer xr:', report.error);
  }
}

async function host(world: World, base: string): Promise<void> {
  const b = base.endsWith('/') ? base : base + '/';
  const [geo, nav, built] = await Promise.all([
    fetchJson(b + 'geometry.json'),
    fetchJson(b + 'nav.json'),
    fetchJson(b + 'build.json').catch(() => ({})), // as main.ts: no build.json is no doors
  ]);
  const ew = await buildWorld({ geo, nav, built }, { base: b });

  // one three: objects made inside buildWorld must be instances of IWSDK's classes
  let meshes = 0;
  let allMesh = true;
  ew.root.traverse((o) => {
    if ((o as Mesh).isMesh) {
      meshes++;
      if (!(o instanceof Mesh)) allMesh = false;
    }
  });
  report.oneThree = ew.root instanceof Group && allMesh && meshes > 0;
  report.meshes = (geo.meshes as unknown[]).length;
  report.glb = { ...ew.loads };

  if (ew.style.tone) {
    world.renderer.toneMapping = TONE;
    world.renderer.toneMappingExposure = ew.style.exposure;
  }
  if (ew.shadows) world.renderer.shadowMap.enabled = true;
  world.scene.background = ew.background ?? new Color(ew.style.exterior);

  // the locomotor gets only the shell; props are the engine nav's business. Children of rootEntity,
  // or IWSDK re-parents the mesh to the active level and root loses its shell.
  const rootEntity = world.createTransformEntity(ew.root);
  for (const o of ew.shell) world.createTransformEntity(o, { parent: rootEntity }).addComponent(LocomotionEnvironment);
  report.shell = ew.shell.length;

  const { x, floorY, z, yawDeg } = ew.spawn;
  // engine yaw 0 faces +Z, a three Object3D faces -Z, hence + PI (F5)
  world.player.rotation.y = (yawDeg * Math.PI) / 180 + Math.PI;
  const loco = world.getSystem(LocomotionSystem);
  loco?.setPlayerPosition(new Vector3(x, floorY, z));
  report.spawn = [x, floorY, z, yawDeg];
  // F16: player is the real player position, not a spawn copy
  report.player = [world.player.position.x, world.player.position.y, world.player.position.z];

  // nav guard: counts off-nav frames, does not allocate in update() and does not rollback (X3 без дрожания)
  const layers = ew.layers;
  const navRamps: any[] = ew.nav?.ramps ?? [];
  const STEP_MAX = 0.25;
  const CAPSULE_R = 0.25;
  const REPS = 1e-6;
  // precompute ramp geometry so update() does not allocate
  const rampInfos: Array<{ fromx: number; fromz: number; d0: number; d1: number; px0: number; px1: number; len: number; hw: number; y0: number; y1: number }> = [];
  for (const r of navRamps) {
    const deg = Number(r.axis?.dir ?? 0);
    const a = (deg * Math.PI) / 180;
    const s = Math.sin(a);
    const c = Math.cos(a);
    const d0 = Math.abs(s) < REPS ? 0 : s;
    const d1 = Math.abs(c) < REPS ? 0 : c;
    const px0 = -d1;
    const px1 = d0;
    let hw = 0;
    for (const p of r.poly as number[][]) {
      const q = Math.abs((p[0] - r.axis.from[0]) * px0 + (p[1] - r.axis.from[1]) * px1);
      if (q > hw) hw = q;
    }
    rampInfos.push({ fromx: r.axis.from[0], fromz: r.axis.from[1], d0, d1, px0, px1, len: r.axis.len, hw, y0: r.y0, y1: r.y1 });
  }
  const NavGuard = class extends createSystem({}) {
    private fy = floorY;
    update() {
      const p = world.player.position;
      const x = p.x;
      const z = p.z;
      let inside = false;
      let bestRamp: typeof rampInfos[0] | null = null;
      let bestRampY = 0;
      let bestRampT = 0;
      let bestRampHw = 0;
      let bestDist = Infinity;
      for (let i = 0; i < rampInfos.length; i++) {
        const ri = rampInfos[i];
        const ox = x - ri.fromx;
        const oz = z - ri.fromz;
        const s = ox * ri.d0 + oz * ri.d1;
        const t = ox * ri.px0 + oz * ri.px1;
        if (s < -REPS || s > ri.len + REPS || Math.abs(t) > ri.hw + REPS) continue;
        inside = true;
        const sc = s < 0 ? 0 : s > ri.len ? ri.len : s;
        const y = ri.len > 0 ? ri.y0 + ((ri.y1 - ri.y0) * sc) / ri.len : ri.y0;
        if (y < this.fy - 0.5 || y > this.fy + STEP_MAX) continue;
        const d = y > this.fy ? y - this.fy : this.fy - y;
        if (d < bestDist) {
          bestDist = d;
          bestRamp = ri;
          bestRampY = y;
          bestRampT = t;
          bestRampHw = ri.hw;
        }
      }
      let walkable: boolean;
      if (inside) {
        if (bestRamp !== null) walkable = Math.abs(bestRampT) <= bestRampHw - CAPSULE_R + REPS;
        else walkable = false;
        if (walkable) this.fy = bestRampY;
      } else {
        let best = layers[0];
        let bestD = best.layer.y > this.fy ? best.layer.y - this.fy : this.fy - best.layer.y;
        for (let i = 1; i < layers.length; i++) {
          const L = layers[i];
          const d = L.layer.y > this.fy ? L.layer.y - this.fy : this.fy - L.layer.y;
          if (d < bestD) {
            bestD = d;
            best = L;
          }
        }
        walkable = navBit(best.layer, best.bits, x, z);
        if (walkable) this.fy = best.layer.y;
      }
      if (!walkable) report.offNav++;
      report.player[0] = x;
      report.player[1] = p.y;
      report.player[2] = z;
    }
  };
  world.registerSystem(NavGuard);
  report.ready = true; // after buildWorld awaited every GLB swap, player already set
}

/** Which world to open: ?world= → localStorage → VITE_DREAMER_WORLD (F9: the managed browser drops the URL). */
export function pickWorld(): string | null {
  const fromUrl = new URLSearchParams(location.search).get('world');
  const fromStore = localStorage.getItem('dreamer.world');
  const fromEnv = (import.meta.env as Record<string, string | undefined>).VITE_DREAMER_WORLD;
  return fromUrl || fromStore || fromEnv || null;
}
