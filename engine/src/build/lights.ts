import { AmbientLight, Color, DirectionalLight, HemisphereLight, PointLight, type Object3D } from "three";

/** `{kind: "sun"}` as `build` writes it: `dir` points from the world to the sun. */
export interface SunLight {
  kind: "sun";
  dir: [number, number, number];
  intensity: number;
  castShadow: boolean;
}

/** a scene `sun` reduced to the four fields the page needs (schema defaults dropped) */
export function sunOf(l: any): SunLight {
  return {
    kind: "sun",
    dir: [Number(l.dir[0]), Number(l.dir[1]), Number(l.dir[2])],
    intensity: Number(l.intensity ?? 1),
    castShadow: l.castShadow === true,
  };
}

/** the sun stands this far up its `dir` from the origin it shines at */
const SUN_DIST = 50;

/** A `DirectionalLight` shining along `-dir` onto the origin. */
export function sunLight(l: SunLight): DirectionalLight {
  const s = new DirectionalLight(0xffffff, Number(l.intensity));
  const n = Math.hypot(l.dir[0], l.dir[1], l.dir[2]) || 1;
  s.position.set((l.dir[0] / n) * SUN_DIST, (l.dir[1] / n) * SUN_DIST, (l.dir[2] / n) * SUN_DIST);
  s.target.position.set(0, 0, 0);
  s.castShadow = l.castShadow === true;
  if (s.castShadow) {
    // one orthographic box covering a house and its yard
    const cam = s.shadow.camera;
    cam.left = cam.bottom = -30;
    cam.right = cam.top = 30;
    cam.near = 1;
    cam.far = SUN_DIST * 2;
    s.shadow.mapSize.set(2048, 2048);
  }
  return s;
}

/**
 * Every light of a built `geometry.json` into `scene`: the flat ambient, then
 * hemi, point and sun lights. Kept out of `runtime/main.ts` so node can check
 * the scene graph without WebGL.
 */
export function addSceneLights(scene: Object3D, geo: { lights?: any[]; style?: { ambient?: number } }): void {
  scene.add(new AmbientLight(0xffffff, 0.4 * Number(geo.style?.ambient ?? 1)));
  for (const l of (geo.lights ?? []) as any[]) {
    if (l.kind === "hemi") {
      const h = new HemisphereLight(new Color(l.color), new Color(0x404040), 1.0 * Number(l.power ?? 1));
      if (l.pos) h.position.set(l.pos[0], l.pos[1], l.pos[2]);
      scene.add(h);
    } else if (l.kind === "sun") {
      const s = sunLight(l as SunLight);
      scene.add(s, s.target);
    } else {
      const p = new PointLight(new Color(l.color), 15 * Number(l.power ?? 1));
      p.position.set(l.pos[0], l.pos[1], l.pos[2]);
      scene.add(p);
    }
  }
}
