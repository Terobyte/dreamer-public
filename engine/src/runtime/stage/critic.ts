import { PerspectiveCamera, Quaternion, Vector3, type Object3D } from "three";
import type { V2, V3 } from "./camera.js";

/** The film critic's eyes (runtime half): every 0.5 s one fact per frame goes to window.__critic; make/critic.py judges them. */
export interface CriticActorIn {
  who: string;
  pos: V2;
  y: number;
  /** degrees; the face looks along (sin yaw, cos yaw) on the floor plane, like Actor.yaw() */
  yaw: number;
  /** head-turned direction in the same convention; when set, face_deg uses it instead of yaw */
  faceYaw?: number;
  /** head pitch in degrees (up positive), measured from the head bone; with faceYaw builds the full 3D face forward */
  facePitch?: number;
  /** rendered head height (eye level); when set, head_ndc uses it instead of y + 0.93 * height */
  headY?: number;
  /** measured head-bone world position (headPose); when set, head_ndc uses it instead of headY / the artificial point */
  headPos?: V3;
  height: number;
  clear: boolean;
  boneSig: number;
}
export interface CriticIn {
  t: number;
  plan: string;
  cam: V3;
  look: V3;
  speaker: string | null;
  fov: number;
  aspect: number;
  actors: CriticActorIn[];
  /** Г8: name of the active shot plan, null outside plans */
  shot?: string | null;
  /** Г8: the plan's point was moved more than 0.3 m by the camera law */
  shot_clamped?: boolean;
  /** К2: name of the move of the director's plan (or the Г8 `shot`) */
  move?: string | null;
  /** К2: the director's cut counter */
  dcut?: number;
  /** debug: what the director saw on its last step */
  dir_saw?: unknown;
  bed_saw?: unknown;
}
export interface CriticActor {
  who: string;
  head_ndc: [number, number];
  height_frac: number;
  face_deg: number;
  clear: boolean;
  bone_sig: number;
  /** floor position and body yaw, and the measured face yaw when known: the trace replays a frame in a director test */
  pos?: V2;
  yaw?: number;
  face_yaw?: number;
}
export interface CriticFact {
  t: number;
  plan: string;
  cam: V3;
  look: V3;
  speaker: string | null;
  actors: CriticActor[];
  /** bodies intersect in 3D (horizontal gap < 0.6 m with overlapping y .. y + height capsules) */
  overlap: boolean;
  /** Г8: name of the active shot plan, null outside plans (absent when the caller does not track plans) */
  shot?: string | null;
  /** Г8: the plan's point was moved more than 0.3 m by the camera law */
  shot_clamped?: boolean;
  /** К2: name of the move of the director's plan (or the Г8 `shot`) */
  move?: string | null;
  /** К2: the director's cut counter */
  dcut?: number;
  /** debug: what the director saw on its last step */
  dir_saw?: unknown;
  bed_saw?: unknown;
}

const round = (v: number, k: number): number => Math.round(v * k) / k;

/** Measured head pose from the rig: the head bone's world position and the world aim of its
 *  forward (+z) as yaw (0..360, like Actor.yaw()) and pitch (up positive). Null for a box stand-in (no bones).
 *  face_deg and head_ndc use this when the caller passes it, so a head turned by a clip or the life
 *  layer counts as seen even when the body faces away (F10), and sit/head motion moves the point (F11). */
export function headPose(root: Object3D): { pos: V3; faceYaw: number; facePitch: number } | null {
  const bones: Object3D[] = [];
  root.traverse((o) => {
    if ((o as any).isBone) bones.push(o);
  });
  // the neck comes before the head in traversal order: prefer the head itself (F14), so a head
  // turned by a clip describes the visible face even when the neck aims away
  const lower = (o: Object3D): string => o.name.toLowerCase();
  const head = bones.find((o) => lower(o) === "head")
    ?? bones.find((o) => ["neck", "neck1", "neck_01"].includes(lower(o)));
  if (!head) return null;
  const p = new Vector3();
  head.getWorldPosition(p);
  const q = new Quaternion();
  head.getWorldQuaternion(q);
  const f = new Vector3(0, 0, 1).applyQuaternion(q);
  const yaw = ((Math.atan2(f.x, f.z) * 180) / Math.PI + 360) % 360;
  const pitch = (Math.asin(Math.max(-1, Math.min(1, f.y))) * 180) / Math.PI;
  return { pos: [p.x, p.y, p.z], faceYaw: round(yaw, 10), facePitch: round(pitch, 10) };
}

/** Sum of the bones' local rotation angles in radians, rounded to 0.01: a frozen pose repeats the number. */
export function boneSig(root: Object3D): number {
  let s = 0;
  root.traverse((o) => {
    if ((o as any).isBone) s += Math.abs(o.rotation.x) + Math.abs(o.rotation.y) + Math.abs(o.rotation.z);
  });
  return round(s, 100);
}

export function computeFact(i: CriticIn): CriticFact {
  const cam = new PerspectiveCamera(i.fov, i.aspect, 0.05, 200);
  cam.position.set(i.cam[0], i.cam[1], i.cam[2]);
  cam.lookAt(i.look[0], i.look[1], i.look[2]);
  cam.updateMatrixWorld(true);
  const ndc = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z).project(cam);
  const actors = i.actors.map((a): CriticActor => {
    const hp = a.headPos ?? ([a.pos[0], a.headY ?? a.y + a.height * 0.93, a.pos[1]] as V3);
    const hx = hp[0], hy = hp[1], hz = hp[2];
    const head = ndc(hx, hy, hz);
    // project() mirrors points behind the camera into the frame; keep them out so _face_seen stays false
    const dx = i.look[0] - i.cam[0], dy = i.look[1] - i.cam[1], dz = i.look[2] - i.cam[2];
    const front = dx * (hx - i.cam[0]) + dy * (hy - i.cam[1]) + dz * (hz - i.cam[2]) > 0;
    const headNdc: [number, number] = front ? [round(head.x, 1000), round(head.y, 1000)] : [9, 9];
    const crown = ndc(a.pos[0], a.y + a.height, a.pos[1]);
    const feet = ndc(a.pos[0], a.y, a.pos[1]);
    const yaw = a.faceYaw ?? a.yaw;
    // full 3D angle between the face forward and the head->camera ray (F15): a camera high
    // behind reads ~97 (seen, not a back), not the yaw-only 180
    const pitch = (((a.facePitch ?? 0) * Math.PI) / 180);
    const fx = Math.sin((yaw * Math.PI) / 180) * Math.cos(pitch),
      fy = Math.sin(pitch),
      fz = Math.cos((yaw * Math.PI) / 180) * Math.cos(pitch);
    const tx = i.cam[0] - hx, ty = i.cam[1] - hy, tz = i.cam[2] - hz;
    const tl = Math.hypot(tx, ty, tz) || 1;
    const dot = Math.max(-1, Math.min(1, (fx * tx + fy * ty + fz * tz) / tl));
    return {
      who: a.who,
      head_ndc: headNdc,
      height_frac: round(Math.abs(crown.y - feet.y) / 2, 1000),
      face_deg: round((Math.acos(dot) * 180) / Math.PI, 10),
      clear: a.clear,
      bone_sig: a.boneSig,
      pos: [round(a.pos[0], 100), round(a.pos[1], 100)],
      yaw: round(a.yaw, 10),
      ...(a.faceYaw !== undefined ? { face_yaw: round(a.faceYaw, 10) } : {}),
    };
  });
  let overlap = false;
  for (let k = 0; k < i.actors.length && !overlap; k++)
    for (let j = k + 1; j < i.actors.length; j++) {
      const dx = i.actors[k].pos[0] - i.actors[j].pos[0], dz = i.actors[k].pos[1] - i.actors[j].pos[1];
      // bodies are vertical capsules (feet y .. y + height): roots a metre apart in height on
      // stairs still intersect, while bodies on far floors do not (F9)
      const top = Math.min(i.actors[k].y + i.actors[k].height, i.actors[j].y + i.actors[j].height);
      const bottom = Math.max(i.actors[k].y, i.actors[j].y);
      if (Math.hypot(dx, dz) < 0.6 && bottom < top) overlap = true;
    }
  return {
    t: round(i.t, 100), plan: i.plan, cam: i.cam, look: i.look, speaker: i.speaker, actors, overlap,
    ...(i.shot !== undefined ? { shot: i.shot } : {}),
    ...(i.shot_clamped !== undefined ? { shot_clamped: i.shot_clamped } : {}),
    ...(i.move !== undefined ? { move: i.move } : {}),
    ...(i.dcut !== undefined ? { dcut: i.dcut } : {}),
    ...(i.dir_saw !== undefined ? { dir_saw: i.dir_saw } : {}), ...(i.bed_saw !== undefined ? { bed_saw: i.bed_saw } : {}),
  };
}

/** Recorder: `tick(dt, now)` pushes one fact into `sink` each 0.5 s of stage time. */
export function createCritic(sink: CriticFact[], build: () => Omit<CriticIn, "t"> | CriticIn): { tick(dt: number, now: number): void } {
  let acc = 0;
  return {
    tick(dt, now) {
      acc += dt;
      if (acc < 0.5) return;
      acc = Math.min(acc - 0.5, 0.49);
      sink.push(computeFact({ ...build(), t: now }));
    },
  };
}
