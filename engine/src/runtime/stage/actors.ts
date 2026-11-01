import { AnimationClip, Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadGlb } from "../assets.js";
import { createAnimator, type Animator } from "./anim.js";
import type { V2 } from "./places.js";

export const SIT_DROP = 0.45;
export const WALK_SPEED = 1.4;

export interface Actor {
  who: string;
  group: Group;
  pos(): V2;
  yaw(): number;
  /** height of the feet right now (climbs along the walk when `go` gets a `yEnd`) */
  y(): number;
  act(): "idle" | "sit";
  /** walk the waypoints, then turn to `yaw` and take `act`. `ys` = feet height at each waypoint (the height
   * changes only along a segment whose ends differ, i.e. a ramp, F24); a single number = height of the last one */
  go(path: V2[], yaw: number, act: "idle" | "sit", ys?: number | number[]): void;
  /** still walking or turning */
  moving(): boolean;
  speak(seconds: number): void;
  speaking(): boolean;
  /** play a clip by name (no animator or no such clip -> stays in idle) */
  play(clip: string, o?: { once?: boolean }): void;
  update(dt: number, now: number): void;
}

/** clip name -> animations[0] of its GLB; a clip that does not load is skipped with a warning */
async function loadClips(who: string, urls: Record<string, string>): Promise<Record<string, AnimationClip>> {
  const loader = new GLTFLoader();
  const out: Record<string, AnimationClip> = {};
  await Promise.all(
    Object.entries(urls).map(async ([name, url]) => {
      try {
        const g = await loader.loadAsync(url);
        const clip = g.animations.find((a) => a.name === name) ?? g.animations[0];
        if (!clip) throw new Error("no animation in the file");
        out[name] = clip;
      } catch (e) {
        console.warn(`stage: actor "${who}" clip "${name}" failed (${String(e)}), skipped`);
      }
    }),
  );
  return out;
}

/** Cast member `who` from a GLB, scaled to `height_m`; a plain box stands in if the GLB does not load. */
export async function createActor(who: string, glbUrl: string, heightM: number, at: V2, y: number, yaw = 0, clipUrls: Record<string, string> = {}, idle?: string): Promise<Actor> {
  const group = new Group();
  group.name = `actor:${who}`;
  let body: Group;
  let animator: Animator | null = null;
  try {
    const [b, clips] = await Promise.all([
      loadGlb({ glb: glbUrl } as any, { min: new Vector3(-0.3, 0, -0.3), max: new Vector3(0.3, heightM, 0.3) }),
      loadClips(who, clipUrls),
    ]);
    body = b;
    if (Object.keys(clips).length) animator = createAnimator(body, clips, { idle });
  } catch (e) {
    console.warn(`stage: actor "${who}" GLB failed (${String(e)}), using a box`);
    body = new Group();
    const m = new Mesh(new BoxGeometry(0.5, heightM, 0.3), new MeshStandardMaterial({ color: 0x8888ff }));
    m.position.y = heightM / 2;
    body.add(m);
  }
  // loadGlb fits a box; the contract is the height: rescale about the feet to exactly height_m, feet on y = 0, centred
  const bb = new Box3().setFromObject(body);
  const h = bb.max.y - bb.min.y;
  const holder = new Group();
  holder.add(body);
  if (h > 0) holder.scale.setScalar(heightM / h);
  const feet = new Box3().setFromObject(holder);
  const c = feet.getCenter(new Vector3());
  body.position.x -= c.x / holder.scale.x;
  body.position.z -= c.z / holder.scale.z;
  body.position.y -= feet.min.y / holder.scale.y;
  group.add(holder);

  let x = at[0];
  let z = at[1];
  let cur = yaw;
  let act: "idle" | "sit" = "idle";
  let path: V2[] = [];
  let finish: { yaw: number; act: "idle" | "sit" } | null = null;
  let heights: number[] = [];
  let segFrom: V2 = [x, z];
  let segY = y;
  let talkUntil = 0;
  let clock = 0;
  let wasMoving = false;
  const wrap = (a: number): number => ((a % 360) + 540) % 360 - 180;

  const apply = (now: number, moving: boolean): void => {
    const bob = moving ? Math.abs(Math.sin(now * 9)) * 0.04 : 0;
    const sway = moving ? Math.sin(now * 9) * 0.05 : 0;
    const talking = now < talkUntil;
    group.position.set(x, y + bob - (act === "sit" && !moving ? SIT_DROP : 0), z);
    group.rotation.set(talking ? 0.04 + Math.sin(now * 6) * 0.05 : 0, (cur * Math.PI) / 180, sway);
  };
  apply(0, false);

  return {
    who,
    group,
    pos: () => [x, z],
    yaw: () => ((cur % 360) + 360) % 360,
    y: () => y,
    act: () => act,
    go(p: V2[], fy: number, fa: "idle" | "sit", ys?: number | number[]) {
      path = [...p];
      finish = { yaw: fy, act: fa };
      heights = Array.isArray(ys) ? [...ys] : path.map((_, k) => (k === path.length - 1 && ys !== undefined ? ys : y));
      segFrom = [x, z];
      segY = y;
      if (fa === "idle" || path.length) act = "idle";
    },
    moving: () => path.length > 0 || finish !== null,
    play(clip, o) {
      animator?.play(clip, o);
    },
    speak(seconds) {
      talkUntil = clock + seconds;
    },
    speaking: () => clock < talkUntil,
    update(dt, now) {
      clock = now;
      let moving = false;
      let budget = WALK_SPEED * dt;
      while (path.length && budget > 0) {
        const [tx, tz] = path[0];
        const d = Math.hypot(tx - x, tz - z);
        if (d < 1e-6) {
          y = heights[0] ?? y;
          path.shift();
          heights.shift();
          segFrom = [x, z];
          segY = y;
          continue;
        }
        const face = (Math.atan2(tx - x, tz - z) * 180) / Math.PI;
        cur += Math.max(-360 * dt * 2, Math.min(360 * dt * 2, wrap(face - cur)));
        const s = Math.min(d, budget);
        x += ((tx - x) / d) * s;
        z += ((tz - z) / d) * s;
        budget -= s;
        moving = true;
        const ty = heights[0] ?? y;
        const len = Math.hypot(tx - segFrom[0], tz - segFrom[1]);
        const left = Math.hypot(tx - x, tz - z);
        y = s >= d || len < 1e-9 ? ty : segY + (ty - segY) * (1 - left / len);
        if (s >= d) {
          x = tx;
          z = tz;
          path.shift();
          heights.shift();
          segFrom = [x, z];
          segY = y;
        }
      }
      if (!path.length && finish) {
        const dy = wrap(finish.yaw - cur);
        cur += Math.max(-360 * dt, Math.min(360 * dt, dy));
        if (Math.abs(dy) < 1) {
          cur = finish.yaw;
          act = finish.act;
          finish = null;
        }
      }
      apply(now, moving);
      if (animator) {
        const m = path.length > 0 || finish !== null;
        if (m && !wasMoving) (animator.has("walk") ? animator.play("walk") : animator.idle());
        else if (!m && wasMoving) animator.idle();
        wasMoving = m;
        animator.update(dt);
      }
    },
  };
}
