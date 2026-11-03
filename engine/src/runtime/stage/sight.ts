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

/** static meshes of the world with their world boxes (actors, hidden and see-through meshes left out) */
function worldMeshes(world: Object3D, skip: Object3D[]): Array<{ o: Object3D; box: Box3 }> {
  const out: Array<{ o: Object3D; box: Box3 }> = [];
  const banned = new Set(skip);
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
}

/** Top of the world under a floor point (metres), null = nothing there: one ray straight down through the meshes
 *  whose box covers the point. The bed's pillow is not a flat surface, so places.json never knows it (k19_true). */
export function createHeight(world: Object3D, skip: () => Object3D[]): (x: number, z: number) => number | null {
  let items: Array<{ o: Object3D; box: Box3 }> | null = null;
  const rc = new Raycaster();
  const from = new Vector3();
  const down = new Vector3(0, -1, 0);
  return (x, z) => {
    items ??= worldMeshes(world, skip());
    let top: number | null = null;
    for (const it of items) {
      const b = it.box;
      if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      if (top !== null && b.max.y <= top) continue;
      from.set(x, b.max.y + 0.01, z);
      rc.set(from, down);
      rc.near = 0;
      rc.far = b.max.y - b.min.y + 0.02;
      const h = rc.intersectObject(it.o, false)[0];
      if (h && (top === null || h.point.y > top)) top = h.point.y;
    }
    return top;
  };
}

/** The director's eyes: is anything of the world between the camera and what it looks at? Actors never block
 *  (the subject is the target; the listener in front is a fine foreground). Koshakan, Nov 1: the pure director
 *  put the close behind the bed's footboard. Meshes are collected once (the world is static), each with its
 *  world box, and a ray only tests the triangles of a mesh whose box it crosses: the meadow's grass and the
 *  ground under a 1 m sightline never cost a triangle test. Answers are cached on a 10 cm grid. */
export function createSight(world: Object3D, skip: () => Object3D[]): (cam: V3, look: V3) => boolean {
  let items: Array<{ o: Object3D; box: Box3 }> | null = null;
  const collect = (): Array<{ o: Object3D; box: Box3 }> => worldMeshes(world, skip());
  const cache = new Map<string, boolean>();
  const rc = new Raycaster();
  const ray = new Ray();
  const from = new Vector3(), to = new Vector3(), dir = new Vector3(), hit = new Vector3();
  const toward = (a: V3, b: V3, d: number): V3 => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
    return [a[0] + ((b[0] - a[0]) * d) / l, a[1] + ((b[1] - a[1]) * d) / l, a[2] + ((b[2] - a[2]) * d) / l];
  };
  const key = (p: V3): string => p.map((v) => Math.round(v * 10)).join(",");

  /** a mesh face between `a` and `b` (faces seen from `a`'s side only: three culls back faces); `trim` m before `b` do not count */
  const blocked = (a: V3, b: V3, trim = 0.25): boolean => {
    from.set(a[0], a[1], a[2]);
    to.set(b[0], b[1], b[2]);
    dir.subVectors(to, from);
    const len = dir.length();
    if (len < 0.3) return false;
    dir.divideScalar(len);
    const far = len - trim;  // the target's own surroundings (a pillow under a head) do not block
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
    // the head and the chest: one of them hidden is a bad frame. A camera inside a mesh (k12: inside the bed) sees
    // only back faces, which the forward ray skips: the reverse ray from 0.25 m off the target hits the outside face
    const ok = !blocked(cam, look) && !blocked(cam, [look[0], look[1] - 0.35, look[2]]) && !blocked(toward(look, cam, 0.25), cam, 0);
    if (cache.size > 4000) cache.clear();
    cache.set(k, ok);
    return ok;
  };
}
