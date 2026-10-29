import {
  AmbientLight,
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
  Scene,
  BufferGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { pickCamera, yawDir } from "./cams.js";
import { EYE, controls, makeWalker, type Walker } from "./walk.js";

interface MaterialDef {
  color: string;
  map?: string;
  repeat_m?: number;
  transparent?: boolean;
}

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

function materialOf(id: string, def: MaterialDef): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: new Color(def.color || "#808080"),
    metalness: 0,
    roughness: 0.9,
    side: DoubleSide,
  });
  if (def.transparent) {
    m.transparent = true;
    m.color.set(0xffffff); // avoid double-tinting: the map already carries def.color
    m.map = labelTexture(id, def.color || "#808080");
  }
  if (def.repeat_m) {
    // the tile texture itself arrives with the assets phase
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

  const [geo, nav] = await Promise.all([
    fetch("geometry.json").then((r) => r.json()),
    fetch("nav.json").then((r) => r.json()),
  ]);

  const scene = new Scene();
  scene.background = new Color(geo.style?.exterior || "#808080");

  const mats = new Map<string, MeshStandardMaterial>();
  const material = (id: string): MeshStandardMaterial => {
    let m = mats.get(id);
    if (!m) {
      m = materialOf(id, (geo.materials ?? {})[id] ?? { color: "#808080" });
      mats.set(id, m);
    }
    return m;
  };

  const setup = pickCamera(geo, params, window.innerWidth / Math.max(window.innerHeight, 1));
  const objects = new Map<string, Mesh | Group>();
  const meshTotal = (geo.meshes as any[]).length;
  for (const src of geo.meshes as any[]) {
    const mesh = meshOf(src, material(String(src.material)));
    mesh.visible = !setup.hide.has(String(src.kind));
    objects.set(mesh.name, mesh);
    scene.add(mesh);
  }

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

  const layer = (nav.layers ?? [])[0];
  const bits = unbase64(String(layer?.bits ?? ""));
  const walker: Walker = makeWalker(layer, bits, geo.floors ?? [], geo.spawn.at);

  const camera = setup.camera;
  const keys = controls(renderer.domElement, Number(geo.spawn.yaw ?? 0));
  const walking = setup.mode === "walk";
  if (setup.error) {
    console.error(setup.error);
    say(setup.error);
  }
  const syncCamera = (): void => {
    const p = walker.pos();
    camera.position.set(p[0], p[1], p[2]);
    const d = yawDir(keys.yaw());
    camera.lookAt(p[0] + d.x, p[1] + d.y, p[2] + d.z);
    camera.updateMatrixWorld();
  };
  if (walking || setup.error) syncCamera();

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (walking) {
      const [dx, dz] = keys.dir(keys.yaw(), dt);
      if (dx !== 0 || dz !== 0) walker.tryMove(dx, dz);
      syncCamera();
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
    meshCount: (): number => meshTotal,
    inspect: (
      id: string,
    ): { type: "Mesh" | "Group"; hasMap: boolean; visible: boolean; mapColorSpace: string | null } | null => {
      const o = objects.get(id);
      if (!o) return null;
      const m = o instanceof Mesh ? (o.material as MeshStandardMaterial) : null;
      return {
        type: o instanceof Mesh ? "Mesh" : "Group",
        hasMap: !!m?.map,
        visible: o.visible,
        mapColorSpace: m?.map?.colorSpace ?? null,
      };
    },
  };
  (window as any).__dreamer = api;

  await api.ready;
  (window as any).__ready = true;
  requestAnimationFrame(frame);
}

void start();
