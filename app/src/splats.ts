import { createSystem, type World } from '@iwsdk/core';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { type Dissolvable, dissolveModifier } from './dissolve.js';

// Conch Street: SAM 3D Objects splats (h0/out/glb_sam3d, linked as public/splats).
// SAM3D normalizes each object into a unit box with Z up, so rotate to Y up and scale so the
// object's z span (from the .ply) becomes `height` metres. base is the object's lowest z in the
// unit box, so it stands on y = 0. yaw (deg) turns each front toward the street (+Z, the spawn);
// SAM3D fronts differ per object. Spawn is the origin looking down -Z; the street runs along X.
type Placement = { name: string; file: string; height: number; x: number; z: number; yaw: number };
const SHAPE: Record<string, { base: number; span: number }> = {
  squidward_house: { base: 0.492, span: 0.988 },
  pineapple_house: { base: 0.484, span: 0.962 },
  '09_squidward': { base: 0.491, span: 0.988 },
  '03_patrick_rock': { base: 0.347, span: 0.702 },
  '04_tube_coral': { base: 0.487, span: 0.984 },
};
const PLACEMENTS: Placement[] = [
  { name: 'squidward_house', file: 'squidward_house', height: 5, x: 0, z: -9, yaw: 0 },
  { name: 'pineapple_house', file: 'pineapple_house', height: 5.5, x: 8, z: -9, yaw: 150 },
  { name: 'patrick_rock', file: '03_patrick_rock', height: 3.5, x: -8, z: -9, yaw: 0 },
  { name: 'squidward', file: '09_squidward', height: 1.8, x: 0.3, z: -6.8, yaw: 0 },
  { name: 'coral_1', file: '04_tube_coral', height: 1.6, x: -4.2, z: -5.5, yaw: 20 },
  { name: 'coral_2', file: '04_tube_coral', height: 1.3, x: 4.3, z: -5.8, yaw: -70 },
  { name: 'coral_3', file: '04_tube_coral', height: 1.8, x: -12, z: -6.5, yaw: 140 },
  { name: 'coral_4', file: '04_tube_coral', height: 1.4, x: 12, z: -6, yaw: 230 },
];

// H7: 200K splats per frame holds 60 fps (vsync cap) on an M4 in the IWER stereo view;
// the 4 SAM3D objects are ~2M splats raw, 13 fps without LoD.
const DEFAULT_BUDGET = 200_000;

let lodBudget = '';
export const splatStats = { loaded: 0, fps: 0, p95ms: 0 };
const dissolvables: Dissolvable[] = [];

export function addSplats(world: World) {
  // test knobs: ?splats=squidward,04_tube_coral (names or files)  ?lod=0  ?budget=500000 (splats per frame)
  const q = new URLSearchParams(location.search);
  const only = q.get('splats')?.split(',');
  const lod = q.get('lod') !== '0';
  const budget = Number(q.get('budget')) || DEFAULT_BUDGET;
  lodBudget = lod ? String(budget) : 'off';
  world.scene.add(new SparkRenderer({ renderer: world.renderer, lodSplatCount: budget }));
  // repeated objects (the corals) share one decoded PackedSplats instead of loading it again
  const firstOfFile = new Map<string, SplatMesh>();
  for (const p of PLACEMENTS) {
    if (only && !only.includes(p.name) && !only.includes(p.file)) continue;
    const { t, modifier } = dissolveModifier();
    const source = firstOfFile.get(p.file);
    const mesh = new SplatMesh({
      ...(source ? { packedSplats: source.packedSplats } : { url: `./splats/${p.file}.ply` }),
      lod,
      objectModifier: modifier,
      onLoad: () => {
        splatStats.loaded++;
      },
    });
    if (!source) firstOfFile.set(p.file, mesh);
    const { base, span } = SHAPE[p.file];
    const scale = p.height / span;
    mesh.name = p.name;
    // YXZ: tip Z-up to Y-up first, then yaw about the world vertical
    mesh.rotation.set(-Math.PI / 2, (p.yaw * Math.PI) / 180, 0, 'YXZ');
    mesh.scale.setScalar(scale);
    mesh.position.set(p.x, base * scale, p.z);
    world.createTransformEntity(mesh);
    dissolvables.push({ mesh, t, target: 0 });
  }
  (window as any).__splats = splatStats;
  // D toggles dissolve on the desktop; the director will call this through a tool later
  const dissolve = (target: number) => dissolvables.forEach((d) => (d.target = target));
  (window as any).__dissolve = dissolve;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyD') dissolve(dissolvables[0]?.target ? 0 : 1);
  });
}

const DISSOLVE_SECONDS = 2.5;

export class DissolveSystem extends createSystem() {
  update(delta: number): void {
    for (const d of dissolvables) {
      const v = d.t.value;
      if (v === d.target) continue;
      const step = delta / DISSOLVE_SECONDS;
      d.t.value = v < d.target ? Math.min(d.target, v + step) : Math.max(d.target, v - step);
      d.mesh.updateVersion();
    }
  }
}

// Frame timing from the world loop itself, so it keeps counting inside an XR session
// (window.requestAnimationFrame stops there).
export class SplatStatsSystem extends createSystem() {
  private frames: number[] = [];
  private acc = 0;
  private hud!: HTMLDivElement;

  init(): void {
    this.hud = document.createElement('div');
    this.hud.style.cssText =
      'position:fixed;left:8px;top:8px;z-index:9999;font:12px monospace;color:#0f0;background:#000a;padding:4px 6px;pointer-events:none';
    document.body.appendChild(this.hud);
  }

  update(delta: number): void {
    this.frames.push(delta * 1000);
    this.acc += delta;
    if (this.acc < 1) return;
    const sorted = [...this.frames].sort((a, b) => a - b);
    splatStats.fps = Math.round(this.frames.length / this.acc);
    splatStats.p95ms = Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10;
    this.frames.length = 0;
    this.acc = 0;
    this.hud.textContent = `${splatStats.fps} fps  p95 ${splatStats.p95ms} ms  ${splatStats.loaded} obj  lod ${lodBudget}`;
  }
}
