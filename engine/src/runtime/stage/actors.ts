import { AnimationClip, Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3, type Object3D } from "three";
import { bindHeadToHead } from "./headbind.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadGlb } from "../assets.js";
import { createAnimator, type Animator } from "./anim.js";
import type { V2 } from "./places.js";
import { legHeights, sitDrop, sitLegs } from "./pose.js";

export const WALK_SPEED = 1.4;
/** the animator crossfade (`createAnimator` default fade): the contact_y shift follows it */
const CLIP_FADE = 0.15;

/** head/chest nodes for the procedural nod (Н17 F8): the head node, then one
 *  upper node (neck/chest); [] when the body has no named bones (a box). */
export function findNodBones(root: Object3D): Object3D[] {
  const byName = new Map<string, Object3D>();
  root.traverse((o) => {
    const n = o.name.toLowerCase();
    if (n && !byName.has(n)) byName.set(n, o);
  });
  const head = byName.get("head");
  const upper = ["neck", "neck1", "neck_01", "chest", "upperchest", "upper_chest", "spine2"]
    .map((n) => byName.get(n)).find(Boolean);
  return [head, upper].filter((b): b is Object3D => !!b && b !== root);
}

const NOD_X = new Vector3(1, 0, 0);
/** bounded nod on the head/chest local nodes (never the group, never out of
 *  range: |amp| ≤ 0.07). Returns undo (call it before the next mixer update).
 *  No named bones (a box) -> a no-op: the caller rocks the group instead. */
export function applyNod(root: Object3D, amp: number): () => void {
  const bones = findNodBones(root);
  if (!bones.length) return () => undefined;
  const a = Math.max(-0.07, Math.min(0.07, amp));
  const saved = bones.map((b) => b.quaternion.clone());
  bones.forEach((b, k) => {
    b.quaternion.multiply(new Quaternion().setFromAxisAngle(NOD_X, k === 0 ? a : a * 0.5));
  });
  return () => {
    bones.forEach((b, k) => b.quaternion.copy(saved[k]!));
  };
}

export interface Actor {
  who: string;
  group: Group;
  pos(): V2;
  yaw(): number;
  /** height of the feet right now (climbs along the walk when `go` gets a `yEnd`) */
  y(): number;
  act(): "idle" | "sit";
  /** how far the feet go down while seated now (L154 `sitDrop`: standing hip height − seat height) */
  drop(): number;
  /** walk the waypoints, then turn to `yaw` and take `act`. `ys` = feet height at each waypoint (the height
   * changes only along a segment whose ends differ, i.e. a ramp, F24); a single number = height of the last one.
   * `seat` = seat height above the feet level for `act` "sit" (the place's `top`); none = the rig's shin.
   * A turn in place of a seated actor (`go([], yaw, "sit")`) keeps its seat. */
  go(path: V2[], yaw: number, act: "idle" | "sit", ys?: number | number[], seat?: number): void;
  teleport(at: V2, newYaw: number, newAct?: "idle" | "sit", newY?: number, seat?: number): void;
  /** still walking or turning */
  moving(): boolean;
  /** metres of route still ahead (0 when standing or only turning) */
  walkLeft(): number;
  /** collision capsule radius (Н9, `capsuleRadius`) */
  radius(): number;
  /** put the actor on a point (collision push, Н9): no walking, the walk goes on from there */
  shove(x: number, z: number): void;
  speak(seconds: number): void;
  speaking(): boolean;
  /** world point of the eyes (the gaze target other actors look at) */
  eye(): [number, number, number];
  /** where the head looks (a world point), null = nowhere in particular */
  look(p: [number, number, number] | null): void;
  /** play a clip by name (no animator or no such clip -> stays in idle) */
  play(clip: string, o?: { once?: boolean }): void;
  /** bounded procedural nod (1.5 s): head/chest bones on a rig, the group on a box; never moves a bone out of range */
  gesture(): void;
  update(dt: number, now: number): void;
}

/** collision capsule radius (Н9): half the wider bbox side, 0.12..0.3 m. The cap: a rig at rest is often a
 *  T-pose, its arm span would keep two actors 1.7 m apart */
export function capsuleRadius(body: Object3D): number {
  const fit = new Box3().setFromObject(body);
  return Math.min(0.3, Math.max(0.12, 0.5 * Math.max(fit.max.x - fit.min.x, fit.max.z - fit.min.z)));
}

/** the animation of a clip GLB for clip key `name`: the one named `name`, else the first (null = none) */
export function pickAnimation(animations: AnimationClip[], name: string): AnimationClip | null {
  return animations.find((a) => a.name === name) ?? animations[0] ?? null;
}

/** Fit an already loaded body to `heightM`: `holder` is scaled to the height, the body centred on XZ
 *  with its feet on y = 0. Shared by `createActor` and the `clipfacts` CLI (Г4). */
export function prepareActorBody<T extends Object3D>(body: T, heightM: number): { holder: Group; body: T } {
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
  holder.updateMatrixWorld(true);
  return { holder, body };
}

/** clip name -> its animation (`pickAnimation`); a clip that does not load is skipped with a warning */
async function loadClips(who: string, urls: Record<string, string>): Promise<Record<string, AnimationClip>> {
  const loader = new GLTFLoader();
  const out: Record<string, AnimationClip> = {};
  await Promise.all(
    Object.entries(urls).map(async ([name, url]) => {
      try {
        const g = await loader.loadAsync(url);
        const clip = pickAnimation(g.animations, name);
        if (!clip) throw new Error("no animation in the file");
        out[name] = clip;
      } catch (e) {
        console.warn(`stage: actor "${who}" clip "${name}" failed (${String(e)}), skipped`);
      }
    }),
  );
  return out;
}

/** Cast member `who` from a GLB, scaled to `height_m`; a plain box stands in if the GLB does not load.
 *  `facts` = clipfacts.json of this actor (Г4): its `contact_y` per clip lowers/raises the holder so the skin lies on the support. */
export async function createActor(who: string, glbUrl: string, heightM: number, at: V2, y: number, yaw = 0, clipUrls: Record<string, string> = {}, idle?: string,
  facts?: Record<string, { contact_y?: number } | undefined> | null): Promise<Actor> {
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
    // a face vertex the auto-rig left on the neck turns with the head (headbind.ts, Koshakan Mama's mouth)
    const moved = bindHeadToHead(body);
    if (moved) console.warn(`stage: actor "${who}": ${moved} face vertices were bound to the neck, now to the head`);
    // always: with no clip the animator still runs the life layer (breath, look, nods) on a rigged body
    animator = createAnimator(body, clips, { idle, seed: who });
  } catch (e) {
    console.warn(`stage: actor "${who}" GLB failed (${String(e)}), using a box`);
    body = new Group();
    const m = new Mesh(new BoxGeometry(0.5, heightM, 0.3), new MeshStandardMaterial({ color: 0x8888ff }));
    m.position.y = heightM / 2;
    body.add(m);
  }
  const { holder } = prepareActorBody(body, heightM);
  // L154: hip height and shin of the standing body, once (feet on 0 here, before the contact_y shift)
  const legs = legHeights(holder, 0);
  group.add(holder);
  const radius = capsuleRadius(holder);
  // Г4: the group stays on the support; the holder shifts by -contact_y of the current clip (metres, the
  // group is not scaled), linearly over the animator crossfade when the clip changes. No facts -> 0.
  const offOf = (clip: string): number => {
    const c = Number(facts?.[clip]?.contact_y);
    return Number.isFinite(c) && Math.abs(c) > 0.02 ? -c : 0;
  };
  let offClip = animator?.current() ?? "";
  let offFrom = offOf(offClip);
  let offTo = offFrom;
  let offT0 = 0;
  holder.position.y = offTo;
  const shift = (now: number): void => {
    if (!facts || !animator) return;
    const c = animator.current();
    if (c !== offClip) {
      offFrom = holder.position.y;
      offTo = offOf(c);
      offT0 = now;
      offClip = c;
    }
    const k = Math.max(0, Math.min(1, (now - offT0) / CLIP_FADE));
    holder.position.y = offFrom + (offTo - offFrom) * k;
  };

  let x = at[0];
  let z = at[1];
  let cur = yaw;
  let act: "idle" | "sit" = "idle";
  let path: V2[] = [];
  let finish: { yaw: number; act: "idle" | "sit"; seat?: number } | null = null;
  // seat height of the current sit (undefined = the shin) and the drop it gives
  let seat: number | undefined;
  let drop = sitDrop(legs, heightM);
  const sitOn = (s: number | undefined): void => {
    seat = s;
    drop = sitDrop(legs, heightM, s);
  };
  let heights: number[] = [];
  let segFrom: V2 = [x, z];
  let segY = y;
  let talkUntil = 0;
  let gestureUntil = -Infinity;
  let gaze: [number, number, number] | null = null;
  let clock = 0;
  let wasMoving = false;
  const wrap = (a: number): number => ((a % 360) + 540) % 360 - 180;

  // F8: a rigged body nods with its head/chest bones; a box (no named bones) rocks as a whole
  const nodBones = findNodBones(body);
  let nodUndo: (() => void) | null = null;
  // Н9: seated legs (thigh and knee 85 deg) laid after the mixer, undone at the next apply like the nod
  let legUndo: (() => void) | null = null;
  const nodAmp = (now: number): number => (now < gestureUntil ? Math.sin(now * 2 * Math.PI * 1.4) * 0.06 : 0);
  const apply = (now: number, moving: boolean): void => {
    nodUndo?.();
    nodUndo = null;
    legUndo?.();
    legUndo = null;
    const bob = moving ? Math.abs(Math.sin(now * 9)) * 0.04 : 0;
    const sway = moving ? Math.sin(now * 9) * 0.05 : 0;
    const talking = now < talkUntil;
    // Н17: procedural gesture — a bounded 1.5 s nod (never a bone out of range, F8)
    const nod = nodBones.length ? 0 : nodAmp(now);
    group.position.set(x, y + bob - (act === "sit" && !moving ? drop : 0), z);
    // a rigged body nods with its head (life layer); a box or an unrigged mesh rocks as a whole
    const rock = talking && !animator?.alive() ? 0.04 + Math.sin(now * 6) * 0.05 : 0;
    group.rotation.set(rock + nod, (cur * Math.PI) / 180, sway);
  };
  apply(0, false);

  return {
    who,
    group,
    pos: () => [x, z],
    yaw: () => ((cur % 360) + 360) % 360,
    y: () => y,
    act: () => act,
    drop: () => drop,
    go(p: V2[], fy: number, fa: "idle" | "sit", ys?: number | number[], st?: number) {
      path = [...p];
      // B53: a finish yaw that is not a number would turn the actor to NaN and never finish
      if (!Number.isFinite(fy)) fy = cur;
      // a turn in place keeps the seat it sits on
      finish = { yaw: fy, act: fa, seat: st ?? (fa === "sit" && !p.length && act === "sit" ? seat : undefined) };
      heights = Array.isArray(ys) ? [...ys] : path.map((_, k) => (k === path.length - 1 && ys !== undefined ? ys : y));
      segFrom = [x, z];
      segY = y;
      if (fa === "idle" || path.length) act = "idle";
    },
    teleport(at: V2, newYaw: number, newAct: "idle" | "sit" = "idle", newY?: number, st?: number) {
      x = at[0];
      z = at[1];
      cur = newYaw;
      act = newAct;
      sitOn(st);
      if (newY !== undefined) {
        y = newY;
        segY = newY;
      }
      path = [];
      finish = null;
      apply(clock, false);
    },
    moving: () => path.length > 0 || finish !== null,
    walkLeft: () => {
      let s = 0;
      let p: V2 = [x, z];
      for (const q of path) (s += Math.hypot(q[0] - p[0], q[1] - p[1])), (p = q);
      return s;
    },
    radius: () => radius,
    shove(nx, nz) {
      x = nx;
      z = nz;
      group.position.x = nx;
      group.position.z = nz;
      segFrom = [x, z];
    },
    play(clip, o) {
      animator?.play(clip, o);
    },
    speak(seconds) {
      talkUntil = clock + seconds;
    },
    gesture() {
      gestureUntil = clock + 1.5;
    },
    speaking: () => clock < talkUntil,
    eye: () => [x, y + heightM * 0.92 - (act === "sit" ? drop : 0), z],
    look(p) {
      gaze = p;
    },
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
          sitOn(finish.seat);
          finish = null;
        }
      }
      apply(now, moving);
      if (animator) {
        const m = path.length > 0 || finish !== null;
        if (m && !wasMoving) (animator.has("walk") ? animator.play("walk") : animator.idle());
        else if (!m && wasMoving) animator.idle();
        wasMoving = m;
        animator.update(dt, { talking: clock < talkUntil, look: gaze ?? undefined });
        shift(now);
      }
      // F8: lay the procedural nod on the head/chest bones after the mixer+life
      // (undone at the next apply, so it never accumulates and never leaves a range)
      if (act === "sit" && !moving && !finish) legUndo = sitLegs(body);
      const ga = nodAmp(now);
      if (ga && nodBones.length) nodUndo = applyNod(body, ga);
    },
  };
}
