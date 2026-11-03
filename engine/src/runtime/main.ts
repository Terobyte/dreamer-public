import { Color, Mesh, MeshStandardMaterial, Scene, Vector3, WebGLRenderer } from "three";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { lookDir, pickCamera } from "./cams.js";
import { controls } from "./walk.js";
import { pivotOffset, touchTarget, type Door } from "./doors.js";
import { connectSim, createBridge, simPost, type StageHandlers } from "./bridge.js";
import { startStage, type Stage } from "./stage/index.js";
import { TONE, buildWorld } from "./world.js";

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

  const setup = pickCamera(geo, params, window.innerWidth / Math.max(window.innerHeight, 1));
  const world = await buildWorld({ geo, nav, built }, { base: "", hide: setup.hide });
  const { walker, doors, objects, layers: all } = world;
  // highlights roll off instead of clipping; a world can opt out with style.tone = "none"
  if (world.style.tone) {
    (renderer as any).toneMapping = TONE;
    (renderer as any).toneMappingExposure = world.style.exposure;
  }
  if (world.shadows) renderer.shadowMap.enabled = true;
  const scene = new Scene();
  scene.background = world.background ?? new Color(world.style.exterior);
  scene.add(world.root);
  const meshTotal = (geo.meshes as any[]).length;

  const camera = setup.camera;
  const keys = controls(renderer.domElement, Number(geo.spawn.yaw ?? 0));

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
  // `?stage=` turns the page into a stage: the cast plays, the camera is directed, the player does not walk
  const stageHandlers: StageHandlers = {};
  const bridge = createBridge(
    { door: (id) => doors.get(id) ?? null },
    {
      post: sim ? simPost(sim) : () => undefined,
      warn: (m) => console.warn(`bridge: ${m}`),
    },
    stageHandlers,
  );
  const stageUrl = params.get("stage");
  let stage: Stage | null = null;
  if (stageUrl) {
    stage = await startStage({
      scene,
      camera: setup.camera as any,
      stageUrl,
      sim,
      film: params.get("film") === "1",
      geo,
      nav,
      layers: all,
      doorOpen: (id) => doors.get(id)?.state() === "open",
    });
    Object.assign(stageHandlers, stage.handlers);
    // place the directed camera before the first render: the first frame is already inside the room (F36)
    stage.update(0, performance.now() / 1000);
  }
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
  const walking = setup.mode === "walk" && !stage;
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

  // host hooks (temporary, Koshakan crutch until the engine plays clips itself): per-frame callbacks
  const frameHooks: ((dt: number, now: number) => void)[] = [];
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
    stage?.update(dt, now / 1000);
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
    for (const h of frameHooks) { try { h(Math.min(real, 0.1), now); } catch (e) { console.warn("onFrame hook", e); } }
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
    stage: stage ? stage.api : null,
    /** host access to the live three.js objects (same three instance as the engine) */
    three: { THREE, scene, camera, renderer, loadGltf: (url: string) => new GLTFLoader().loadAsync(url) },
    onFrame: (cb: (dt: number, now: number) => void): void => { frameHooks.push(cb); },
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
  (window as any).__ready = true;
  requestAnimationFrame(frame);
}

void start();
