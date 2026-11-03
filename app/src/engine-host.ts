/**
 * IWSDK host for an engine-built world (spec X2). `buildWorld` (engine/) makes the plain three.js
 * subtree; this file only puts it into the IWSDK World: one entity for `root`, the shell for the
 * locomotor, the player on the engine spawn, and the engine nav as the last word on where to stand.
 * It does not import `three` itself (app/AGENTS.md): classes come from `@iwsdk/core`.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LocomotionEnvironment,
  LocomotionSystem,
  Mesh,
  MeshBasicMaterial,
  Pressed,
  RayInteractable,
  Vector3,
  createSystem,
  type World,
} from '@iwsdk/core';
import { TONE, buildWorld } from '../../engine/src/runtime/world.js';
import { navBit } from '../../engine/src/nav/floor.js';
import { buildFence } from '../../engine/src/nav/fence.js';
import { type Door } from '../../engine/src/runtime/doors.js';
import { connectSim, createBridge, simPost } from '../../engine/src/runtime/bridge.js';

/** IWSDK capsule radius (F11); the engine nav is already eroded by its own 0.25 m */
const FENCE_INSET_M = 0.5;

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
  /** how many times the host placed the player (spawn only; the fence needs no push-back) */
  setPlayerCalls: number;
  /** X3 acceptance: each door's width, nav cells at the doorway, and whether IWSDK's 1.0 m / 2.0 m capsule passes */
  passages: Array<{ id: string; width: number; height: number; cells: number; xrOk: boolean }>;
  /** frames where the player moved against the previous frame's direction along Z (push-back / jitter) */
  reversals: number;
  /** X4: ids of every `door_touch` the host raised (a press edge on a leaf), in order */
  doorEvents: string[];
  doorIds: string[];
  /** open / close a door as the sim would (`EngineWorld.doors`); the leaf then turns in the door system */
  openDoor: (id: string) => void;
  closeDoor: (id: string) => void;
  /** check helpers: put the player `dist` m before the closed leaf facing it; metres to the leaf; metres past the door line */
  stageAtDoor: (id: string, dist: number, open: boolean) => void;
  distToDoor: (id: string) => number;
  signedPastDoor: (id: string) => number;
  /** add `Pressed` to the leaf for `ms` (what a held ray trigger does) */
  pressDoor: (id: string, ms: number) => Promise<void>;
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
  setPlayerCalls: 0,
  passages: [],
  reversals: 0,
  doorEvents: [],
  doorIds: [],
  openDoor: () => undefined,
  closeDoor: () => undefined,
  stageAtDoor: () => undefined,
  distToDoor: () => NaN,
  signedPastDoor: () => NaN,
  pressDoor: async () => undefined,
  ready: false,
  error: '',
};

/** The sim to talk to: ?sim= → localStorage (F9: the managed browser drops the URL). */
export function pickSim(): string | null {
  const fromEnv = (import.meta.env as Record<string, string | undefined>).VITE_DREAMER_SIM;
  return new URLSearchParams(location.search).get('sim') || localStorage.getItem('dreamer.sim') || fromEnv || null;
}

/**
 * X4 doors. Each leaf is a ray-interactable kinematic locomotor body; a press edge raises `door_touch` and
 * tells the sim (`bridge.touch`), which decides: the door never moves itself. The loop runs in a system with
 * priority < LocomotionSystem's -5, so the collision body is already turned when the player moves.
 * Not done: poke (finger touch) outside the ray volume, parked as debt.
 */
function hostDoors(world: World, ew: Awaited<ReturnType<typeof buildWorld>>, rootEntity: any): void {
  const doors = ew.doors;
  const sim = pickSim();
  const bridge = createBridge(
    { door: (id) => doors.get(id) ?? null },
    { post: sim ? simPost(sim) : () => undefined, warn: (m) => console.warn(`bridge: ${m}`) },
  );
  if (sim) connectSim(sim, bridge, (m) => console.warn(`bridge: ${m}`));

  const idOf = new Map<unknown, string>();
  const entities = new Map<string, any>();
  const parts = new Map<string, any[]>();
  for (const [id, door] of doors) {
    const list: any[] = [];
    for (const name of [`${id}:leaf`, `${id}:handle`]) {
      const o = ew.objects.get(name);
      if (o) list.push(o);
    }
    parts.set(id, list);
    const leaf = ew.objects.get(`${id}:leaf`);
    if (!leaf) continue;
    const e = world.createTransformEntity(leaf, { parent: rootEntity });
    e.addComponent(RayInteractable);
    e.addComponent(LocomotionEnvironment, { type: 'kinematic' as any });
    idOf.set(leaf, id);
    entities.set(id, e);
    void door;
  }
  report.doorIds = [...doors.keys()];
  report.openDoor = (id) => doors.get(id)?.open();
  report.closeDoor = (id) => doors.get(id)?.close();

  const turned = new Map<string, number>();
  const turnLeaf = (door: Door): void => {
    const th = door.meshTurn();
    if (turned.get(door.def.id) === th) return;
    turned.set(door.def.id, th);
    // pivotOffset inlined: it returns a fresh tuple, and this runs in a system update (no allocation)
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const hinge = door.def.hinge_at;
    const hx = hinge[0];
    const hz = hinge[1];
    const ox = hx - (hx * c + hz * sn);
    const oz = hz - (-hx * sn + hz * c);
    // indexed loop: a for...of would allocate an array iterator every frame the leaf turns
    const list = parts.get(door.def.id);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      o.rotation.y = th;
      o.position.x = ox;
      o.position.z = oz;
      o.updateMatrixWorld(true);
    }
  };
  const doorList: Door[] = [...doors.values()];
  const DoorSystem = class extends createSystem({ pressed: { required: [RayInteractable, Pressed] } }) {
    init(): void {
      // the edge: `qualify` fires once when the tag appears, however long the trigger is held
      const off = this.queries.pressed.subscribe('qualify', (entity: any) => {
        const id = idOf.get(entity.object3D);
        if (!id) return;
        report.doorEvents.push(id);
        window.dispatchEvent(new CustomEvent('door_touch', { detail: { id } }));
        if (sim) bridge.touch(id);
      });
      this.cleanupFuncs.push(off);
    }
    update(dt: number): void {
      // indexed loop over an array built once: no MapIterator per frame
      for (let i = 0; i < doorList.length; i++) {
        doorList[i].update(dt);
        turnLeaf(doorList[i]);
      }
    }
  };
  world.registerSystem(DoorSystem, { priority: -10 });

  // check helpers (xr-check.mjs); not used by the app
  const through = new Map<string, [number, number, number, number]>(); // cx, cz, dx, dz of the walking direction
  report.stageAtDoor = (id, dist) => {
    const door = doors.get(id);
    if (!door) return;
    const [hx, hz] = door.def.hinge_at;
    const [ex, ez] = door.def.closed_end;
    const cx = (hx + ex) / 2;
    const cz = (hz + ez) / 2;
    const len = Math.hypot(ex - hx, ez - hz) || 1;
    let nx = -(ez - hz) / len;
    let nz = (ex - hx) / len;
    if ((ew.spawn.x - cx) * nx + (ew.spawn.z - cz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    // the player starts on the spawn side and walks through: direction is -n
    through.set(id, [cx, cz, -nx, -nz]);
    world.player.rotation.y = Math.atan2(nx, nz);
    world.getSystem(LocomotionSystem)?.setPlayerPosition(new Vector3(cx + nx * dist, ew.spawn.floorY, cz + nz * dist));
  };
  report.distToDoor = (id) => {
    const door = doors.get(id);
    if (!door) return NaN;
    const [[ax, az], [bx, bz]] = door.segment();
    const p = world.player.position;
    const ex = bx - ax;
    const ez = bz - az;
    const t = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.z - az) * ez) / (ex * ex + ez * ez || 1)));
    return Math.hypot(p.x - (ax + ex * t), p.z - (az + ez * t));
  };
  report.signedPastDoor = (id) => {
    const t = through.get(id);
    if (!t) return NaN;
    const p = world.player.position;
    return (p.x - t[0]) * t[2] + (p.z - t[1]) * t[3];
  };
  report.pressDoor = async (id, ms) => {
    const e = entities.get(id);
    if (!e) return;
    e.addComponent(Pressed);
    await new Promise((r) => setTimeout(r, ms));
    e.removeComponent(Pressed);
  };
}

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
  for (const d of (ew.built?.doors ?? []) as Array<{ id: string; width: number; height: number }>) {
    const cells = ((ew.nav?.doors ?? {})[d.id]?.cells ?? []).length;
    report.passages.push({ id: d.id, width: d.width, height: d.height, cells, xrOk: d.width >= 1.0 && d.height >= 2.0 && cells > 0 });
  }
  // the engine nav as geometry (X3): fence walls around everything the nav forbids, so the locomotor
  // stops the player itself and nothing has to push back per frame. Invisible, the locomotor ignores `visible` (F12).
  const fence = buildFence(ew.nav, FENCE_INSET_M);
  if (fence.length > 0) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(fence, 3));
    const fm = new Mesh(g, new MeshBasicMaterial());
    fm.visible = false;
    world.createTransformEntity(fm, { parent: rootEntity }).addComponent(LocomotionEnvironment);
  }

  hostDoors(world, ew, rootEntity);

  const { x, floorY, z, yawDeg } = ew.spawn;
  // engine yaw 0 faces +Z, a three Object3D faces -Z, hence + PI (F5)
  world.player.rotation.y = (yawDeg * Math.PI) / 180 + Math.PI;
  const loco = world.getSystem(LocomotionSystem);
  loco?.setPlayerPosition(new Vector3(x, floorY, z));
  report.setPlayerCalls++;
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
    private prevZ = NaN;
    private prevDz = 0;
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
      // every-frame jitter probe: the sign of the Z step flips against the last non-zero step
      if (this.prevZ === this.prevZ) {
        const dz = z - this.prevZ;
        if (dz !== 0) {
          if (this.prevDz * dz < 0) report.reversals++;
          this.prevDz = dz;
        }
      }
      this.prevZ = z;
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
