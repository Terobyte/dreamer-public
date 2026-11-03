import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  HemisphereLight,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  Object3D,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";

/** `geometry.json` → `outdoor` (see `Outdoor` in build/geometry.ts). */
export interface OutdoorDef {
  sky: { asset: string; file: string | null; radius: number; fallback: { top: string; bottom: string } };
  ground: { material: string; radius: number; fade: number; y: number };
}

/** Rings of the ground disc: enough that the fade reads as a smooth ramp. */
const RINGS = 48;
const SEGMENTS = 96;

/** Vertical zenith → horizon → ground gradient for `--assets none`. */
function gradientSky(top: string, bottom: string): Texture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, top);
  grad.addColorStop(0.5, bottom);
  grad.addColorStop(1, bottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Mean colour of rows [y0, y1) (fractions of the height) of a texture's image. */
function meanColor(tex: Texture, y0: number, y1: number): Color {
  const img: any = (tex as any).image;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 32;
  const g = c.getContext("2d")!;
  g.drawImage(img, 0, 0, 64, 32);
  const r0 = Math.floor(32 * y0);
  const r1 = Math.max(r0 + 1, Math.floor(32 * y1));
  const d = g.getImageData(0, r0, 64, r1 - r0).data;
  let r = 0;
  let gg = 0;
  let b = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    gg += d[i + 1];
    b += d[i + 2];
  }
  return new Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, SRGBColorSpace);
}

/**
 * A flat disc whose UVs are world metres (so the ground tile repeats like any
 * floor) and whose vertex alpha runs 1 → 0 over the outer `fade` metres, so
 * the ground dissolves into the sky instead of ending in a horizon wall.
 */
function groundDisc(def: OutdoorDef["ground"]): BufferGeometry {
  const pos: number[] = [0, def.y, 0];
  const uv: number[] = [0, 0];
  const col: number[] = [1, 1, 1, 1];
  const inner = Math.max(0, def.radius - def.fade);
  // ring radii: one at the start of the fade, the rest spread across it
  const radii: number[] = [];
  if (inner > 0) radii.push(inner);
  for (let k = 1; k <= RINGS; k++) radii.push(inner + ((def.radius - inner) * k) / RINGS);
  for (const r of radii) {
    const a = def.fade > 0 ? Math.min(1, Math.max(0, (def.radius - r) / def.fade)) : 1;
    for (let s = 0; s < SEGMENTS; s++) {
      const t = (2 * Math.PI * s) / SEGMENTS;
      const x = r * Math.cos(t);
      const z = r * Math.sin(t);
      pos.push(x, def.y, z);
      uv.push(x, -z);
      col.push(1, 1, 1, a);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < SEGMENTS; s++) idx.push(0, 1 + ((s + 1) % SEGMENTS), 1 + s);
  for (let k = 0; k + 1 < radii.length; k++) {
    const a0 = 1 + k * SEGMENTS;
    const b0 = a0 + SEGMENTS;
    for (let s = 0; s < SEGMENTS; s++) {
      const s1 = (s + 1) % SEGMENTS;
      idx.push(a0 + s, a0 + s1, b0 + s1, a0 + s, b0 + s1, b0 + s);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(new Array((pos.length / 3) * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new Float32BufferAttribute(col, 4));
  g.setIndex(new BufferAttribute(new Uint32Array(idx), 1));
  return g;
}

/**
 * The street (В2): sky dome, ground disc, sun + hemi, returned as objects for
 * the caller's root. The dome is unlit and fog-free; `background` (the host sets
 * `scene.background`) takes the mean colour of the panorama's lower
 * band so nothing under the horizon shows black. Hemi colours come from the
 * upper/lower halves of the panorama (or of the gradient stand-in).
 */
/** the dome's panorama: wraps across the u = 0/1 seam and samples no mip (Koshakan meadow, Nov 3: the mip picked at
 *  the seam's UV jump drew a black 4 px line from the zenith to the horizon) */
export function skyTexture(t: Texture): Texture {
  t.wrapS = RepeatWrapping;
  t.generateMipmaps = false;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

export async function addOutdoor(
  def: OutdoorDef,
  groundMaterial: MeshStandardMaterial,
): Promise<{ objects: Object3D[]; background: Color }> {
  const objects: Object3D[] = [];
  let sky: Texture;
  let fromFile = false;
  if (def.sky.file) {
    try {
      sky = await new TextureLoader().loadAsync(def.sky.file);
      sky.colorSpace = SRGBColorSpace;
      fromFile = true;
    } catch {
      sky = gradientSky(def.sky.fallback.top, def.sky.fallback.bottom);
    }
  } else {
    sky = gradientSky(def.sky.fallback.top, def.sky.fallback.bottom);
  }
  const top = fromFile ? meanColor(sky, 0, 0.5) : new Color(def.sky.fallback.top);
  const low = fromFile ? meanColor(sky, 0.5, 0.6) : new Color(def.sky.fallback.bottom);
  const below = fromFile ? meanColor(sky, 0.5, 1) : groundMaterial.color.clone();

  const dome = new Mesh(
    new SphereGeometry(def.sky.radius, 64, 32),
    new MeshBasicMaterial({ map: skyTexture(sky), side: BackSide, fog: false, depthWrite: false }),
  );
  dome.name = "outdoor:sky";
  dome.renderOrder = -1;
  objects.push(dome);

  const mat = groundMaterial.clone();
  mat.vertexColors = true;
  mat.transparent = true;
  mat.depthWrite = false;
  if (mat.map) {
    mat.map = mat.map.clone();
    mat.map.wrapS = mat.map.wrapT = RepeatWrapping;
  }
  const ground = new Mesh(groundDisc(def.ground), mat);
  ground.name = "outdoor:ground";
  objects.push(ground);

  const sun = new DirectionalLight(0xfff4e0, 1.6);
  sun.position.set(60, 120, 40);
  objects.push(sun, new HemisphereLight(top, below, 0.8));
  return { objects, background: low };
}
