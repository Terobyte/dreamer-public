/**
 * XR spike (2026-11-02): a world built by `engine/` inside an IWSDK World.
 *
 * Question it answers: can the engine's built world (geometry/nav/build json +
 * assets) live as content inside Meta's IWSDK host, with one three.js, the
 * player on the engine spawn and the engine nav keeping the player in bounds.
 *
 * meshOf/materialOf are copied from engine/src/runtime/main.ts (private there);
 * spec phase X1 extracts `buildWorld(scene)` so this copy goes away.
 */
import {
  BufferAttribute,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LocomotionEnvironment,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  RepeatWrapping,
  SRGBColorSpace,
  BufferGeometry,
  type Texture,
  type World,
  Vector3,
  createSystem,
  LocomotionSystem,
} from '@iwsdk/core';
import * as THREE_APP from 'three';
import { loadGlb, loadMaps, type MaterialDef } from '../../engine/src/runtime/assets.js';
import { addSceneLights } from '../../engine/src/build/lights.js';
import { EYE, makeWalker, type Walker } from '../../engine/src/runtime/walk.js';

function unbase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function materialOf(def: MaterialDef, map?: Texture): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: new Color(def.color || '#808080'),
    metalness: 0,
    roughness: 0.9,
    side: DoubleSide,
  });
  if (def.map && map) {
    map.colorSpace = SRGBColorSpace;
    m.map = map;
    m.color.set(0xffffff);
    if (def.transparent) m.transparent = true;
    if (def.repeat_m) {
      map.wrapS = map.wrapT = RepeatWrapping;
      map.repeat.set(1 / def.repeat_m, 1 / def.repeat_m);
    }
  } else if (def.transparent) {
    m.transparent = true;
  }
  return m;
}

function meshOf(src: any, material: MeshStandardMaterial): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(src.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(src.normals, 3));
  g.setAttribute('uv', new Float32BufferAttribute(src.uvs, 2));
  g.setIndex(new BufferAttribute(new Uint32Array(src.indices), 1));
  const mesh = new Mesh(g, material);
  mesh.userData.kind = src.kind;
  mesh.name = String(src.id);
  return mesh;
}

/** Report for the spike: what the page proved, read by the CLI via console. */
const report: Record<string, unknown> = {};
(window as any).__xrspike = report;

export async function hostEngineWorld(world: World, base: string): Promise<void> {
  (window as any).__xrworld = world;
  const url = (p: string) => (p.startsWith('http') || p.startsWith('/') ? p : base + p);
  const [geo, nav] = await Promise.all([
    fetch(url('geometry.json')).then((r) => r.json()),
    fetch(url('nav.json')).then((r) => r.json()),
  ]);

  // fact 1: one three. A Mesh class from the engine's import graph must be
  // the same class IWSDK renders with, or instanceof checks fail silently.
  const engineGroup = new Group();
  engineGroup.name = 'EngineWorld';
  report.oneThree = engineGroup instanceof THREE_APP.Group && (Group as unknown) === THREE_APP.Group;

  if (geo.style?.tone !== 'none') {
    world.renderer.toneMapping = NeutralToneMapping;
    world.renderer.toneMappingExposure = Number(geo.style?.exposure ?? 0.9);
  }
  world.scene.background = new Color(geo.style?.exterior || '#808080');

  const materials: Record<string, MaterialDef> = {};
  for (const [id, def] of Object.entries((geo.materials ?? {}) as Record<string, MaterialDef>)) {
    materials[id] = def.map ? { ...def, map: url(def.map) } : def;
  }
  const maps = await loadMaps(materials);
  const mats = new Map<string, MeshStandardMaterial>();
  const material = (id: string) => {
    let m = mats.get(id);
    if (!m) mats.set(id, (m = materialOf(materials[id] ?? { color: '#808080' }, maps.get(id))));
    return m;
  };

  const swaps: Promise<void>[] = [];
  let glbOk = 0;
  for (const src of geo.meshes as any[]) {
    const mesh = meshOf(src, material(String(src.material)));
    engineGroup.add(mesh);
    if (typeof src.glb === 'string') {
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox!;
      swaps.push(
        loadGlb({ ...src, glb: url(src.glb) }, { min: bb.min, max: bb.max })
          .then((root) => {
            root.name = mesh.name;
            engineGroup.remove(mesh);
            engineGroup.add(root);
            glbOk++;
          })
          .catch((e) => console.warn(`xrspike: GLB ${src.glb} failed: ${String(e)}`)),
      );
    }
  }
  await Promise.all(swaps);
  addSceneLights(engineGroup, geo);
  report.meshes = (geo.meshes as any[]).length;
  report.glb = `${glbOk}/${swaps.length}`;

  // hybrid: IWSDK's physics locomotor gets only the shell (floors stand the
  // player, walls stop it); furniture stays out of it, or the player steps up
  // onto the bed. Where you may stand among props is the engine nav's call.
  world.createTransformEntity(engineGroup);
  const shell = engineGroup.children.filter((o) => ['floor', 'wall', 'cap'].includes(o.userData.kind));
  for (const o of shell) world.createTransformEntity(o).addComponent(LocomotionEnvironment);
  report.shell = shell.length;

  // engine nav: the same walker the desktop page uses, here only as a judge
  const all = (nav.layers ?? []).map((l: any) => ({ layer: l, bits: unbase64(String(l?.bits ?? '')) }));
  const walker: Walker = makeWalker(all[0].layer, all[0].bits, geo.floors ?? [], geo.spawn.at, {
    layers: all.slice(1),
    ramps: nav.ramps ?? [],
  });
  const [sx, sy, sz] = walker.pos();
  const floorY = sy - EYE;
  // engine yaw: 0 faces +Z; a three Object3D faces -Z, hence + PI
  world.player.rotation.y = (Number(geo.spawn.yaw ?? 0) * Math.PI) / 180 + Math.PI;
  // the locomotor owns the player position (physics in a worker): a direct
  // player.position write is overwritten, placement goes through the system
  const loco = world.getSystem(LocomotionSystem);
  report.locomotor = !!loco;
  loco?.setPlayerPosition(new Vector3(sx, floorY, sz));
  report.spawn = [sx, floorY, sz, geo.spawn.yaw];

  // nav judge: never moves the player, counts frames where the player stands
  // on a cell the engine nav forbids (0 = IWSDK walls agree with engine nav)
  const probe = makeWalker(all[0].layer, all[0].bits, geo.floors ?? [], geo.spawn.at, {
    layers: all.slice(1),
    ramps: nav.ramps ?? [],
  });
  // nav guard: the locomotor moves the player, the engine nav has the last
  // word. A step onto a forbidden cell is undone to the last allowed spot.
  let offNav = 0;
  let pushedBack = 0;
  const good = new Vector3(sx, floorY, sz);
  const NavJudge = class extends createSystem({}) {
    update() {
      const p = world.player.position;
      try {
        probe.teleport(p.x, p.z);
        good.set(p.x, p.y, p.z);
      } catch {
        offNav++; // engine nav says this cell is not walkable
        if (!loco) return;
        // slide like the desktop walker: keep the axis that is still allowed
        let fixed = false;
        for (const [x, z] of [[p.x, good.z], [good.x, p.z]]) {
          try { probe.teleport(x, z); good.set(x, p.y, z); fixed = true; break; } catch { /* next axis */ }
        }
        void fixed;
        loco.setPlayerPosition(good);
        pushedBack++;
        report.pushedBack = pushedBack;
      }
      report.offNav = offNav;
      report.player = [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
    }
  };
  world.registerSystem(NavJudge);
  report.ready = true;
  console.log('xrspike ready', JSON.stringify(report));
}
