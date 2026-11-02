import { Box3, Ray, Raycaster, Vector3, type Object3D } from "three";
import type { V3 } from "./camera.js";

const PLANT_WORDS = new Set(["grass", "tuft", "flower", "dandelion", "clover", "bush", "weed", "fern"]);
/** A prop id is vegetation when its last word is a plant word (`grass_tuft`, `meadow-fern`). */
export function isPlantId(id: string): boolean {
  const last = id.split(/[^A-Za-z0-9]+/).filter(Boolean).pop();
  return last !== undefined && PLANT_WORDS.has(last.toLowerCase());
}
/** Flag every mesh under `root` as see-through for the sight probe when `id` is vegetation. */
export function markNoblock(root: Object3D, id: string): void {
  if (!isPlantId(id)) return;
  root.traverse((o) => { o.userData.noblock = true; });
}

/** The director's eyes: is anything of the world between the camera and what it looks at? Actors never block
 *  (the subject is the target; the listener in front is a fine foreground). Koshakan, Nov 1: the pure director
 *  put the close behind the bed's footboard. Meshes are collected once (the world is static), each with its
 *  world box, and a ray only tests the triangles of a mesh whose box it crosses: the meadow's grass and the
 *  ground under a 1 m sightline never cost a triangle test. Answers are cached on a 10 cm grid. */
export function createSight(world: Object3D, skip: () => Object3D[]): (cam: V3, look: V3) => boolean {
  let items: Array<{ o: Object3D; box: Box3 }> | null = null;
  const collect = (): Array<{ o: Object3D; box: Box3 }> => {
    const out: Array<{ o: Object3D; box: Box3 }> = [];
    const banned = new Set(skip());
    world.updateMatrixWorld(true);
    const walk = (o: Object3D): void => {
      if (banned.has(o) || !o.visible || o.userData.noblock === true) return;
      if ((o as any).isMesh && !(o as any).isSkinnedMesh) {
        const box = new Box3().setFromObject(o);
        if (!box.isEmpty()) out.push({ o, box });
      }
      for (const ch of o.children) walk(ch);
    };
    walk(world);
    return out;
  };
  const cache = new Map<string, boolean>();
  const rc = new Raycaster();
  const ray = new Ray();
  const from = new Vector3(), to = new Vector3(), dir = new Vector3(), hit = new Vector3();
  const key = (p: V3): string => p.map((v) => Math.round(v * 10)).join(",");

  const blocked = (a: V3, b: V3): boolean => {
    from.set(a[0], a[1], a[2]);
    to.set(b[0], b[1], b[2]);
    dir.subVectors(to, from);
    const len = dir.length();
    if (len < 0.3) return false;
    dir.divideScalar(len);
    const far = len - 0.25;  // the target's own surroundings (a pillow under a head) do not block
    ray.set(from, dir);
    rc.set(from, dir);
    rc.near = 0.05;
    rc.far = far;
    for (const it of items!) {
      if (!ray.intersectBox(it.box, hit) || hit.distanceTo(from) > far) continue;
      if (rc.intersectObject(it.o, false).length) return true;
    }
    return false;
  };

  return (cam, look) => {
    items ??= collect();
    const k = `${key(cam)}|${key(look)}`;
    const c = cache.get(k);
    if (c !== undefined) return c;
    // the head and the chest: one of them hidden is a bad frame
    const ok = !blocked(cam, look) && !blocked(cam, [look[0], look[1] - 0.35, look[2]]);
    if (cache.size > 4000) cache.clear();
    cache.set(k, ok);
    return ok;
  };
}
