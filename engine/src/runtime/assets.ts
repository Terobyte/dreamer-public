/**
 * Everything the page has to fetch before it can call itself ready: the tile
 * and decal textures, and the GLB each prop placeholder swaps for. Placement
 * is not computed here — `build` already baked `scale`, `glbPos` and `glbYaw`
 * into geometry.json; the page only applies them.
 */
import { Box3, CanvasTexture, Group, Material, Mesh, MeshStandardMaterial, Texture, TextureLoader, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export interface MaterialDef {
  color: string;
  map?: string;
  repeat_m?: number;
  transparent?: boolean;
}

export interface GlbSrc {
  glb: string;
  glbPos?: [number, number, number];
  glbYaw?: number;
  scale?: number;
  /** flat props scale Y on its own (see build/props.ts): the footprint scale must not stretch the height */
  scaleY?: number;
}

/** Runtime model scale: footprint `scale` on X/Z, `scaleY` on Y (falls back to `scale`). */
export function glbScale(src: GlbSrc): [number, number, number] {
  const s = Number(src.scale ?? 1);
  const sy = typeof src.scaleY === "number" ? Number(src.scaleY) : s;
  return [s, sy, s];
}

/**
 * Every material whose cached asset made it into `dist/assets`, with its real
 * pixels already in memory: the caller builds no mesh before this resolves,
 * so `__ready` never fires on a page still showing coloured placeholders.
 */
export async function loadMaps(materials: Record<string, MaterialDef>): Promise<Map<string, Texture>> {
  const loader = new TextureLoader();
  const pairs = await Promise.all(
    Object.entries(materials)
      .filter(([, def]) => typeof def.map === "string")
      .map(async ([id, def]) => [id, await loader.loadAsync(def.map!)] as [string, Texture]),
  );
  return new Map(pairs);
}

/**
 * Fits a loaded GLB into the OBB placeholder it replaces: uniform scale (so
 * the model keeps its own proportions) picked as the tightest fit on any
 * axis, centred in x/z and resting on the placeholder's floor in y. Only a
 * GLB that `build` could not measure (no normalized size) lands here.
 */
export function fitGlb(glbScene: Group, box: { min: Vector3; max: Vector3 }): void {
  const glbBox = new Box3().setFromObject(glbScene);
  const glbSize = glbBox.getSize(new Vector3());
  const boxSize = box.max.clone().sub(box.min);
  let scale = Infinity;
  for (const k of ["x", "y", "z"] as const) {
    if (glbSize[k] > 0) scale = Math.min(scale, boxSize[k] / glbSize[k]);
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  glbScene.scale.setScalar(scale);
  const glbCenter = glbBox.getCenter(new Vector3()).multiplyScalar(scale);
  const glbMinY = glbBox.isEmpty() ? 0 : glbBox.min.y * scale;
  const boxCenter = box.min.clone().add(box.max).multiplyScalar(0.5);
  glbScene.position.set(boxCenter.x - glbCenter.x, box.min.y - glbMinY, boxCenter.z - glbCenter.z);
}

/** A texel darker than this (mean of r, g, b) is a leaf shard, not bark. */
const LEAF_DARK = 60;

/**
 * The GLB's JPEG has no alpha channel, so MASK alone cuts nothing. Only a
 * foliage material (tagged `foliageCutout` by `maskFoliage` in assets/glb)
 * with a colour map gets its dark texels written into a copy of the map's
 * alpha; the material's `alphaTest` then discards them. Anything else —
 * including an unmarked double-sided MASK prop — is left alone so no holes
 * get punched in ordinary props.
 */
export function cutDarkTexels(root: Group): void {
  const done = new Map<Material, true>();
  root.traverse((obj) => {
    const mats = (obj as Mesh).material;
    for (const mat of Array.isArray(mats) ? mats : mats ? [mats] : []) {
      if (done.has(mat)) continue;
      done.set(mat, true);
      const std = mat as MeshStandardMaterial;
      if ((std.userData?.["foliageCutout"] as unknown) !== true) continue;
      const image = std.map?.image as CanvasImageSource & { width: number; height: number } | undefined;
      if (std.alphaTest <= 0 || !image) continue;
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < px.data.length; i += 4) {
        if (px.data[i] + px.data[i + 1] + px.data[i + 2] < LEAF_DARK * 3) px.data[i + 3] = 0;
      }
      ctx.putImageData(px, 0, 0);
      const cut = new CanvasTexture(canvas);
      cut.colorSpace = std.map!.colorSpace;
      cut.flipY = std.map!.flipY;
      cut.wrapS = std.map!.wrapS;
      cut.wrapT = std.map!.wrapT;
      std.map = cut;
      std.needsUpdate = true;
    }
  });
}

/**
 * The prop's model, placed. The normalized GLB stands on y = 0 with its
 * footprint centred and its front at +Z, so the whole placement is one
 * scale, one yaw about Y and one translation.
 */
export async function loadGlb(src: GlbSrc, box: { min: Vector3; max: Vector3 }): Promise<Group> {
  const gltf = await new GLTFLoader().loadAsync(src.glb);
  const root = gltf.scene;
  cutDarkTexels(root);
  if (typeof src.scale === "number" && src.glbPos) {
    root.scale.set(...glbScale(src));
    root.rotation.y = Number(src.glbYaw ?? 0);
    root.position.set(src.glbPos[0], src.glbPos[1], src.glbPos[2]);
  } else {
    fitGlb(root, box);
  }
  return root;
}
