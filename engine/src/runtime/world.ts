import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  RepeatWrapping,
  SRGBColorSpace,
  type Object3D,
  type Texture,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { addSceneLights } from "../build/lights.js";
import { loadGlb, loadMaps, type GlbSrc, type MaterialDef } from "./assets.js";
import { makeDoor, setCells, type Door, type DoorDef } from "./doors.js";
import { addOutdoor } from "./outdoor.js";
import { scatterObjects, toSources, type ScatterSource } from "./scatter.js";
import { markNoblock } from "./stage/sight.js";
import { EYE, makeWalker, type Walker } from "./walk.js";

/** Highlights roll off instead of clipping (Koshakan's cream walls read as white blotches without it). */
export const TONE = NeutralToneMapping;
export const EXPOSURE = 0.9;
/** Mesh kinds that form the room shell: what a host's locomotor may collide with. */
export const SHELL_KINDS: ReadonlySet<string> = new Set(["floor", "wall", "cap"]);

export interface WorldLoaders {
  /** real pixels of every material that has a cached map */
  maps: (materials: Record<string, MaterialDef>) => Promise<Map<string, Texture>>;
  /** a mesh's GLB, fitted to its placeholder box */
  glb: (src: GlbSrc, box: { min: any; max: any }) => Promise<Group>;
  /** a whole GLTF scene (scatter walks its meshes and bakes their matrices) */
  scatter: (url: string) => Promise<Object3D>;
}

export interface BuildWorldOpts {
  /** prefix for relative `map`, `glb` and outdoor files */
  base: string;
  /** mesh kinds the caller does not want to see (camera modes) */
  hide?: Set<string>;
  loaders?: Partial<WorldLoaders>;
  /** L45: a GLB that fails and stays a box; the page collects these for the film (default console.warn) */
  warn?: (m: string) => void;
}

export interface WorldLayer {
  layer: any;
  bits: Uint8Array;
}

export interface EngineWorld {
  /** meshes, GLBs, lights, outdoor, scatter: no renderer, no camera, no DOM */
  root: Group;
  walker: Walker;
  doors: Map<string, Door>;
  /** by `geo.meshes[].id`; a swapped GLB replaces its placeholder here */
  objects: Map<string, Object3D>;
  spawn: { x: number; floorY: number; z: number; yawDeg: number };
  /** floor / wall / cap meshes: the part a host's locomotor gets */
  shell: Object3D[];
  geo: any;
  nav: any;
  layers: WorldLayer[];
  built: any;
  /** the host applies these: `scene.background`, `renderer.toneMapping` */
  style: { ambient: number; exterior: string; tone: boolean; exposure: number };
  background: Color | null;
  /** the sun casts shadows: the host turns `renderer.shadowMap` on */
  shadows: boolean;
  /** every GLB swap (meshes and scatter assets); a failure leaves the placeholder */
  loads: { ok: number; total: number; failed: number };
}

/** base64 → bytes without `Buffer`: the nav bitmap is read in the page. */
function unbase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `base` + a relative url; absolute urls (scheme, `/`, data, blob) pass through. */
export function withBase(base: string, url: string): string {
  if (!base || /^([a-z][a-z0-9+.-]*:|\/)/i.test(url)) return url;
  const clean = url.replace(/^\.\//, "");
  const sep = base.endsWith("/") ? "" : "/";
  return base + sep + clean;
}

/** Placeholder decal: flat colour with the asset id written on it (needs a DOM; null without one). */
function labelTexture(id: string, color: string): CanvasTexture | null {
  if (typeof document === "undefined") return null;
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

export function materialOf(id: string, def: MaterialDef, loadedMap?: Texture): MeshStandardMaterial {
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
    if (def.transparent) {
      m.transparent = true;
      // cut-outs (trees, signs on white) are mostly 0/1 alpha: test it so crossed planes sort cleanly
      m.alphaTest = 0.35;
    }
    if (def.repeat_m) {
      loadedMap.wrapS = loadedMap.wrapT = RepeatWrapping;
      // UVs are in metres, so a texture that should tile every `repeat_m`
      // metres needs its repeat set to the reciprocal
      loadedMap.repeat.set(1 / def.repeat_m, 1 / def.repeat_m);
    }
  } else if (def.transparent) {
    m.transparent = true;
    const label = labelTexture(id, def.color || "#808080");
    if (label) {
      m.color.set(0xffffff); // avoid double-tinting: the map already carries def.color
      m.map = label;
    }
  } else if (def.repeat_m) {
    // no cached tile texture yet: still a coloured placeholder
    m.userData.repeat_m = def.repeat_m;
  }
  return m;
}

export function meshOf(src: any, material: MeshStandardMaterial): Mesh {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(src.positions, 3));
  g.setAttribute("normal", new Float32BufferAttribute(src.normals, 3));
  g.setAttribute("uv", new Float32BufferAttribute(src.uvs, 2));
  g.setIndex(new BufferAttribute(new Uint32Array(src.indices), 1));
  const mesh = new Mesh(g, material);
  mesh.userData.kind = src.kind;
  mesh.name = String(src.id);
  return mesh;
}

const flagShadows = (o: Object3D): void =>
  o.traverse((x: any) => {
    if (x.isMesh) {
      x.castShadow = true;
      x.receiveShadow = true;
    }
  });

/**
 * The world of a built `dist` as a plain three.js subtree: geometry, GLBs, lights, street, scatter, nav and
 * doors. The renderer, camera, input and frame loop belong to the host (desktop `main.ts`, or IWSDK in `app/`).
 */
export async function buildWorld(
  data: { geo: any; nav: any; built?: any },
  opts: BuildWorldOpts,
): Promise<EngineWorld> {
  const { geo, nav } = data;
  const built = data.built ?? {};
  const base = opts.base;
  const hide = opts.hide ?? new Set<string>();
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const loaders: WorldLoaders = {
    maps: opts.loaders?.maps ?? loadMaps,
    glb: opts.loaders?.glb ?? loadGlb,
    scatter: opts.loaders?.scatter ?? (async (url) => (await new GLTFLoader().loadAsync(url)).scene),
  };

  const defs: Record<string, MaterialDef> = {};
  for (const [id, d] of Object.entries((geo.materials ?? {}) as Record<string, MaterialDef>)) {
    defs[id] = typeof d.map === "string" ? { ...d, map: withBase(base, d.map) } : d;
  }
  // every material whose cached asset made it into dist/assets gets its real pixels before any mesh using it
  // is built, so __ready never fires on a page still showing coloured placeholders
  const loadedMaps = await loaders.maps(defs);
  const mats = new Map<string, MeshStandardMaterial>();
  const material = (id: string): MeshStandardMaterial => {
    let m = mats.get(id);
    if (!m) {
      m = materialOf(id, defs[id] ?? { color: "#808080" }, loadedMaps.get(id));
      mats.set(id, m);
    }
    return m;
  };

  const root = new Group();
  const sunShadows = ((geo.lights ?? []) as any[]).some((l) => l.kind === "sun" && l.castShadow === true);
  const objects = new Map<string, Object3D>();
  const loads = { ok: 0, total: 0, failed: 0 };
  const swaps: Promise<void>[] = [];
  for (const src of geo.meshes as any[]) {
    const mesh = meshOf(src, material(String(src.material)));
    mesh.visible = !hide.has(String(src.kind));
    objects.set(mesh.name, mesh);
    markNoblock(mesh, mesh.name);
    root.add(mesh);
    // the box is the OBB placeholder; once its real GLB is loaded it swaps in for the box, same name and
    // visibility, so every other lookup by mesh name keeps working untouched
    if (typeof src.glb === "string") {
      loads.total++;
      mesh.geometry.computeBoundingBox();
      const box = { min: mesh.geometry.boundingBox!.min, max: mesh.geometry.boundingBox!.max };
      swaps.push(
        loaders
          .glb({ ...src, glb: withBase(base, src.glb) }, box)
          .then((glb) => {
            glb.name = mesh.name;
            glb.visible = mesh.visible;
            glb.userData.kind = mesh.userData.kind; // B73: the swapped model keeps the placeholder's kind
            if (sunShadows) flagShadows(glb);
            markNoblock(glb, mesh.name);
            root.remove(mesh);
            root.add(glb);
            objects.set(mesh.name, glb);
            loads.ok++;
          })
          .catch((e) => {
            // B36: a GLB that fails keeps its box, so __ready still fires
            loads.failed++;
            warn(`runtime: "${mesh.name}" GLB failed (${String(e)}), using a box`);
          }),
      );
    }
  }

  // a scene with a street gets its sky dome, ground disc and sun before the first frame
  let background: Color | null = null;
  if (geo.outdoor) {
    const def = geo.outdoor;
    const sky = def.sky?.file ? { ...def.sky, file: withBase(base, def.sky.file) } : def.sky;
    const out = await addOutdoor({ ...def, sky }, material(String(def.ground.material)));
    for (const o of out.objects) root.add(o);
    background = out.background;
  }
  addSceneLights(root, geo);

  // `scatter`: one InstancedMesh per asset (`geo.scatter`, fallback `built.scatter`)
  const scatterEntries = ((geo as any).scatter ?? (built as any).scatter ?? []) as any[];
  let scatterGroup: Group | null = null;
  if (scatterEntries.length > 0) {
    const scatterSources = new Map<string, ScatterSource[]>();
    const entries = scatterEntries.map((e) => (typeof e.glb === "string" && e.glb ? { ...e, glb: withBase(base, e.glb) } : e));
    await Promise.all(
      [...new Set(entries.map((e: any) => String(e.asset)))].map(async (asset) => {
        const glb = entries.find((e: any) => String(e.asset) === asset)?.glb;
        if (typeof glb !== "string" || !glb) return;
        loads.total++;
        try {
          const scene = await loaders.scatter(glb);
          scene.updateMatrixWorld(true);
          const found: any[] = [];
          scene.traverse((o: any) => {
            if (o.isMesh) found.push(o);
          });
          const parts: ScatterSource[] = toSources(found);
          if (parts.length > 0) scatterSources.set(asset, parts);
          loads.ok++;
        } catch (e) {
          loads.failed++;
          warn(`runtime: scatter "${asset}" GLB failed (${String(e)}), using a box`);
        }
      }),
    );
    scatterGroup = scatterObjects(entries, scatterSources);
    root.add(scatterGroup);
  }

  // a sun with `castShadow` needs the host's shadow map; the flags are ours
  if (sunShadows) flagShadows(root);

  // layers[0] is the spawn level; the rest are reachable by a flight, so the walker needs all of them
  const layers: WorldLayer[] = ((nav.layers ?? []) as any[]).map((l) => ({ layer: l, bits: unbase64(String(l?.bits ?? "")) }));
  // no layers (a scene without walkable rooms): an empty one at the spawn, so the walker stands still
  if (layers.length === 0) layers.push({ layer: { level: "", y: geo.spawn.y ?? 0, origin: [0, 0], w: 0, h: 0 }, bits: new Uint8Array(0) });
  const walker = makeWalker(layers[0].layer, layers[0].bits, geo.floors ?? [], geo.spawn.at, {
    layers: layers.slice(1),
    ramps: nav.ramps ?? [],
  });

  // doors: the leaf mesh turns about the hinge; the door's nav cells follow its state in the bitmap the walker reads
  const doors = new Map<string, Door>();
  const bitsOfLevel = (level: string): Uint8Array | undefined => layers.find((a) => a.layer.level === level)?.bits;
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

  await Promise.all(swaps);

  const shell = [...objects.values()].filter((o) => SHELL_KINDS.has(String(o.userData.kind)));
  const p = walker.pos();
  return {
    root,
    walker,
    doors,
    objects,
    spawn: { x: p[0], floorY: p[1] - EYE, z: p[2], yawDeg: Number(geo.spawn.yaw ?? 0) },
    shell,
    geo,
    nav,
    layers,
    built,
    style: {
      ambient: Number(geo.style?.ambient ?? 1),
      exterior: String(geo.style?.exterior || "#808080"),
      tone: geo.style?.tone !== "none",
      exposure: Number(geo.style?.exposure ?? EXPOSURE),
    },
    background,
    shadows: sunShadows,
    loads,
  };
}

/**
 * Sew a place into a world that is already running (the endless book, the sim's rooms picked from memory): `data` is
 * the place's built dist, laid where `dreamer stitch` put it, so nothing is shifted here. Its subtree joins
 * `world.root`, its meshes `objects`, its doors `doors`, and its nav the walker; the first place keeps working.
 * A door id the world already has throws: stitch renames what collides, so a clash means an unstitched part.
 */
export async function attachPlace(world: EngineWorld, data: { geo: any; nav: any; built?: any }, opts: BuildWorldOpts): Promise<EngineWorld> {
  const clash = ((data.built?.doors ?? []) as DoorDef[]).map((d) => d.id).filter((id) => world.doors.has(id));
  if (clash.length > 0) throw new Error(`attachPlace: door ids already in the world: ${clash.join(", ")}`);
  const part = await buildWorld(data, opts);
  world.root.add(part.root);
  for (const [k, o] of part.objects) world.objects.set(k, o);
  for (const [k, d] of part.doors) world.doors.set(k, d);
  world.walker.extend({ layers: part.layers, floors: data.geo.floors ?? [], ramps: data.nav.ramps ?? [] });
  world.layers.push(...part.layers);
  world.shell.push(...part.shell);
  return part;
}
