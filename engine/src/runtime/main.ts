import {
  AmbientLight,
  Box3,
  BufferAttribute,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  RepeatWrapping,
  Scene,
  BufferGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from "three";
import { loadGlb, loadMaps } from "./assets.js";
import { addOutdoor } from "./outdoor.js";
import { lookDir, pickCamera } from "./cams.js";
import { EYE, controls, makeWalker, type Walker } from "./walk.js";
import { makeDoor, pivotOffset, setCells, touchTarget, type Door, type DoorDef } from "./doors.js";
import { connectSim, createBridge, simPost } from "./bridge.js";

import type { MaterialDef } from "./assets.js";

/** base64 → bytes without `Buffer`: the nav bitmap is read in the page. */
function unbase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Placeholder decal: flat colour with the asset id written on it. */
function labelTexture(id: string, color: string): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = "#000000";
  g.font = "28px sans-serif";
  g.textAlign = "center";
  g.fillText(id, 128, 136);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function materialOf(id: string, def: MaterialDef, loadedMap?: Texture): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: new Color(def.color || "#808080"),
    metalness: 0,
    roughness: 0.9,
    side: DoubleSide,
  });
  if (def.map && loadedMap) {
    loadedMap.colorSpace = SRGBColorSpace;
    m.map = loadedMap;
    m.color.set(0xffffff); // avoid double-tinting: the map already carries the real pixels
    if (def.transparent) m.transparent = true;
    if (def.repeat_m) {
      loadedMap.wrapS = loadedMap.wrapT = RepeatWrapping;
      // UVs are in metres, so a texture that should tile every `repeat_m`
      // metres needs its repeat set to the reciprocal
      loadedMap.repeat.set(1 / def.repeat_m, 1 / def.repeat_m);
    }
  } else if (def.transparent) {
    m.transparent = true;
    m.color.set(0xffffff); // avoid double-tinting: the map already carries def.color
    m.map = labelTexture(id, def.color || "#808080");
  } else if (def.repeat_m) {
    // no cached tile texture yet: still a coloured placeholder
    m.userData.repeat_m = def.repeat_m;
  }
  return m;
}

function meshOf(src: any, material: MeshStandardMaterial): Mesh {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(src.positions, 3));
  g.setAttribute("normal", new Float32BufferAttribute(src.normals, 3));
  g.setAttribute("uv", new Float32BufferAttribute(src.uvs, 2));
  g.setIndex(new BufferAttribute(new Uint32Array(src.indices), 1));
  const mesh = new Mesh(g, material);
  mesh.name = String(src.id);
  return mesh;
}

function say(text: string): void {
  const d = document.createElement("div");
  d.id = "msg";
  d.style.cssText = "position:fixed;left:8px;top:8px;color:#fff;font:14px sans-serif;z-index:1";
  d.textContent = text;
  document.body.appendChild(d);
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: false });
    if (!renderer.getContext()) throw new Error("no context");
  } catch (e) {
    console.error(`no WebGL context: ${String(e)}`);
    say("no WebGL context");
    return;
  }
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const [geo, nav, built] = await Promise.all([
    fetch("geometry.json").then((r) => r.json()),
    fetch("nav.json").then((r) => r.json()),
    fetch("build.json")
      .then((r) => r.json())
      .catch(() => ({})),
  ]);

  const scene = new Scene();
  scene.background = new Color(geo.style?.exterior || "#808080");

  // every material whose cached asset made it into dist/assets gets its real
  // pixels loaded before any mesh using it is built, so __ready never fires
  // on a page still showing coloured placeholders
  const loadedMaps = await loadMaps((geo.materials ?? {}) as Record<string, MaterialDef>);

  const mats = new Map<string, MeshStandardMaterial>();
  const material = (id: string): MeshStandardMaterial => {
    let m = mats.get(id);
    if (!m) {
      m = materialOf(id, (geo.materials ?? {})[id] ?? { color: "#808080" }, loadedMaps.get(id));
      mats.set(id, m);
    }
    return m;
  };

  const setup = pickCamera(geo, params, window.innerWidth / Math.max(window.innerHeight, 1));
  const objects = new Map<string, Mesh | Group>();
  const meshTotal = (geo.meshes as any[]).length;
  const glbSwaps: Promise<void>[] = [];
  for (const src of geo.meshes as any[]) {
    const mesh = meshOf(src, material(String(src.material)));
    mesh.visible = !setup.hide.has(String(src.kind));
    objects.set(mesh.name, mesh);
    scene.add(mesh);
    // the box is the OBB placeholder; once its real GLB is loaded it swaps
    // in for the box, same name and visibility, so every other lookup by
    // mesh name keeps working untouched
    if (typeof src.glb === "string") {
      mesh.geometry.computeBoundingBox();
      glbSwaps.push(
        loadGlb(src, { min: mesh.geometry.boundingBox!.min, max: mesh.geometry.boundingBox!.max }).then((root) => {
          root.name = mesh.name;
          root.visible = mesh.visible;
          scene.remove(mesh);
          scene.add(root);
          objects.set(mesh.name, root);
        }),
      );
    }
  }

  // a scene with a street gets its sky dome, ground disc and sun before the
  // first frame, so __ready never fires on a bare `exterior` background
  if (geo.outdoor) await addOutdoor(scene, geo.outdoor, material(String(geo.outdoor.ground.material)));
  scene.add(new AmbientLight(0xffffff, 0.4 * Number(geo.style?.ambient ?? 1)));
  for (const l of (geo.lights ?? []) as any[]) {
    if (l.kind === "hemi") {
      const h = new HemisphereLight(new Color(l.color), new Color(0x404040), 1.0 * Number(l.power ?? 1));
      if (l.pos) h.position.set(l.pos[0], l.pos[1], l.pos[2]);
      scene.add(h);
    } else {
      const p = new PointLight(new Color(l.color), 15 * Number(l.power ?? 1));
      p.position.set(l.pos[0], l.pos[1], l.pos[2]);
      scene.add(p);
    }
  }

  // layers[0] is the spawn level (`buildLayers`); the rest are reachable by a
  // flight, so the walker needs all of them and the ramps that join them
  const all = (nav.layers ?? []).map((l: any) => ({ layer: l, bits: unbase64(String(l?.bits ?? "")) }));
  const walker: Walker = makeWalker(all[0].layer, all[0].bits, geo.floors ?? [], geo.spawn.at, {
    layers: all.slice(1),
    ramps: nav.ramps ?? [],
  });

  const camera = setup.camera;
  const keys = controls(renderer.domElement, Number(geo.spawn.yaw ?? 0));

  // doors: the leaf mesh turns about the hinge; the door's nav cells follow
  // its state in the same bitmap the walker reads
  const doors = new Map<string, Door>();
  const bitsOfLevel = (level: string): Uint8Array | undefined => all.find((a: any) => a.layer.level === level)?.bits;
  for (const def of (built.doors ?? []) as DoorDef[]) {
    const cells = (nav.doors ?? {})[def.id] as { level: string; cells: number[] } | undefined;
    doors.set(
      def.id,
      makeDoor(def, (blocked) => {
        const bits = cells ? bitsOfLevel(cells.level) : undefined;
        if (bits && cells) setCells(bits, cells.cells, !blocked);
      }),
    );
  }
  const turnLeaf = (door: Door): void => {
    const th = door.meshTurn();
    const [ox, oz] = pivotOffset(door.def.hinge_at, th);
    // the handle rides the leaf: same turn about the hinge, or it stays
    // behind in the doorway while the leaf swings away
    for (const name of [`${door.def.id}:leaf`, `${door.def.id}:handle`]) {
      const leaf = objects.get(name) as any;
      if (!leaf) continue;
      leaf.rotation.y = th;
      leaf.position.x = ox;
      leaf.position.z = oz;
    }
  };
  const sim = params.get("sim");
  const bridge = createBridge(
    { door: (id) => doors.get(id) ?? null },
    {
      post: sim ? simPost(sim) : () => undefined,
      warn: (m) => console.warn(`bridge: ${m}`),
    },
  );
  if (sim) connectSim(sim, bridge, (m) => console.warn(`bridge: ${m}`));
  let touching: string | null = null;
  addEventListener("keydown", (e) => {
    if (sim || e.code !== "KeyE") return;
    // debug without a sim: E flips the door in front of the player
    const p = walker.pos();
    const id = touchTarget([...doors.values()], [p[0], p[2]], keys.yaw(), keys.pitch(), p[1]);
    const d = id ? doors.get(id) : undefined;
    if (d) d.state() === "open" ? d.close() : d.open();
  });
  const walking = setup.mode === "walk";
  if (setup.error) {
    console.error(setup.error);
    say(setup.error);
  }
  const syncCamera = (): void => {
    const p = walker.pos();
    camera.position.set(p[0], p[1], p[2]);
    const d = lookDir(keys.yaw(), keys.pitch());
    camera.lookAt(p[0] + d.x, p[1] + d.y, p[2] + d.z);
    camera.updateMatrixWorld();
  };
  if (walking || setup.error) syncCamera();

  let last = performance.now();
  const frame = (now: number): void => {
    const real = Math.max(0, (now - last) / 1000);
    // the walk is clamped so a stalled frame cannot tunnel through a wall; a
    // door is pure kinematics and follows the wall clock (0.6 s is 0.6 s even
    // at 2 fps), so a slow page still lands it on its stop in time
    const dt = Math.min(real, 0.1);
    last = now;
    for (const d of doors.values()) {
      d.update(real);
      turnLeaf(d);
    }
    if (walking) {
      const [dx, dz] = keys.dir(keys.yaw(), dt);
      if (dx !== 0 || dz !== 0) walker.tryMove(dx, dz);
      syncCamera();
      // touch is an event for the sim to decide on; the door does not move itself
      const p = walker.pos();
      const hit = touchTarget([...doors.values()], [p[0], p[2]], keys.yaw(), keys.pitch(), p[1]);
      if (hit && hit !== touching) {
        window.dispatchEvent(new CustomEvent("door_touch", { detail: { id: hit } }));
        if (sim) bridge.touch(hit);
      }
      touching = hit;
    }
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  renderer.render(scene, camera);

  const api = {
    ready: new Promise<void>((ok) => requestAnimationFrame(() => ok())),
    pos: (): [number, number, number] =>
      walking || setup.error
        ? walker.pos()
        : [camera.position.x, camera.position.y, camera.position.z],
    tryMove: (dx: number, dz: number): [number, number, number] => {
      const p = walker.tryMove(dx, dz);
      if (walking || setup.error) syncCamera();
      return p;
    },
    teleport: (x: number, z: number): [number, number, number] => {
      const p = walker.teleport(x, z);
      if (walking || setup.error) syncCamera();
      return p;
    },
    camera: (): { pos: [number, number, number]; dir: [number, number, number]; fov: number } => {
      const d = new Vector3();
      camera.getWorldDirection(d);
      return {
        pos: [camera.position.x, camera.position.y, camera.position.z],
        dir: [d.x, d.y, d.z],
        fov: (camera as any).isPerspectiveCamera ? (camera as any).fov : 0,
      };
    },
    door: (id: string) => {
      const d = doors.get(id);
      if (!d) return null;
      return {
        open: () => d.open(),
        close: () => d.close(),
        lock: () => d.lock(),
        unlock: () => d.unlock(),
        state: () => d.state(),
        angle: () => d.angle(),
        sweepDeg: () => d.sweepDeg(),
      };
    },
    look: (yaw: number): void => keys.setYaw(yaw),
    meshCount: (): number => meshTotal,
    inspect: (
      id: string,
    ): {
      type: "Mesh" | "Group";
      hasMap: boolean;
      visible: boolean;
      mapColorSpace: string | null;
      mapWidth: number | null;
    } | null => {
      const o = objects.get(id);
      if (!o) return null;
      const m = o instanceof Mesh ? (o.material as MeshStandardMaterial) : null;
      return {
        type: o instanceof Mesh ? "Mesh" : "Group",
        hasMap: !!m?.map,
        visible: o.visible,
        mapColorSpace: m?.map?.colorSpace ?? null,
        mapWidth: m?.map?.image?.width ?? null,
      };
    },
  };
  (window as any).__dreamer = api;

  await api.ready;
  await Promise.all(glbSwaps);
  (window as any).__ready = true;
  requestAnimationFrame(frame);
}

void start();
