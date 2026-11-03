// Г4: facts of a clip measured on the body that plays it — where the skin touches (contact_y), where the
// face looks in the actor's axes (face_dir / face_yaw), head height over the skin (head_y), lying or not.
// clipFacts never loads anything: the CLI (`dreamer clipfacts <cast dir>` -> writeClipfacts) and the tests
// hand it a body already prepared by prepareActorBody, the same code createActor uses.
import { AnimationMixer, Box3, Quaternion, Vector3, type AnimationClip, type Object3D, type SkinnedMesh } from "three";
import { createAnimator, prepareClip } from "./anim.js";
import { headPose } from "./critic.js";

export type V3 = [number, number, number];
export interface ClipFacts {
  /** where the skin rests (supportY) relative to the actor root (m): the holder shifts by -contact_y */
  contact_y: number;
  /** unit gaze in the actor's axes (+Z = actor forward) */
  face_dir: V3;
  /** atan2(x, z) of face_dir in degrees 0..360 (0 = actor forward, 90 = +X); null when |face_dir.y| > 0.8 */
  face_yaw: number | null;
  /** head bone height over the lowest skin point (m) */
  head_y: number;
  /** head_y < 0.5 x height */
  lying: boolean;
  /** contact_y at k/16 of the clip, k = 0..15: a clip that changes pose (wake_up sits up, lies back) rests on the
   *  support all along, not on its mean (k22_true: the lying part floated 17 cm over the bed) */
  contact_curve?: number[];
  /** where the seat rests: the support of the skin under the pelvis, relative to the root (m). A chair sit's
   *  contact is the feet; in a bed the seat sits on the blanket (k23_true: sit_idle's seat 14 cm over the bed) */
  seat_y?: number;
  /** the pose of the clip's last frame (head over the support < 0.5 x height): the idle after a once-clip goes on
   *  from it (k24_true: wake_up ended sitting, the lying idle dropped Mirai back on the bed) */
  end_lying?: boolean;
}

const MAX_POINTS = 2000;
const UP = new Vector3(0, 1, 0);

/** World points of the skin: SkinnedMesh vertices after skinning, at most 2000 (every k-th vertex, k fixed
 *  by the vertex count, so it is the same for every frame of a body). Call after root.updateMatrixWorld. */
export function skinPoints(root: Object3D): V3[] {
  const meshes: SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as any).isSkinnedMesh) meshes.push(o as SkinnedMesh);
  });
  const total = meshes.reduce((n, m) => n + (m.geometry.attributes.position?.count ?? 0), 0);
  const k = Math.max(1, Math.ceil(total / MAX_POINTS));
  const out: V3[] = [];
  const v = new Vector3();
  let g = 0;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++, g++) {
      if (g % k) continue;
      v.fromBufferAttribute(pos, i);
      m.applyBoneTransform(i, v);
      v.applyMatrix4(m.matrixWorld);
      out.push([v.x, v.y, v.z]);
    }
  }
  return out;
}

/** Minimum world y of the skin (skinPoints); a body with no skinned mesh -> its bounding box bottom (0 if empty). */
export function lowestSkinY(root: Object3D): number {
  const pts = skinPoints(root);
  if (pts.length) return pts.reduce((m, p) => Math.min(m, p[1]), Infinity);
  const b = new Box3().setFromObject(root);
  return b.isEmpty() ? 0 : b.min.y;
}

/** a support band holds at least this share of the skin points: a foot sole or a lying side does, an ear tip does not */
const SUPPORT_SHARE = 0.015;
const SUPPORT_BAND_M = 0.02;

/** World y the body rests on: the lowest y whose 2 cm band above holds >= 1.5% of the skin points. The bare
 *  minimum is the tip of whatever dangles lowest (Koshakan: a lamb's ear hung under the sleeping body, 7 cm of air). */
export function supportY(root: Object3D): number {
  const ys = skinPoints(root).map((p) => p[1]);
  return ys.length ? bandLow(ys) : lowestSkinY(root);
}

/** the lowest y whose SUPPORT_BAND_M band holds SUPPORT_SHARE of `ys` */
function bandLow(all: number[]): number {
  const ys = [...all].sort((a, b) => a - b);
  const need = Math.max(1, Math.ceil(ys.length * SUPPORT_SHARE));
  let j = 0;
  for (let i = 0; i < ys.length; i++) {
    if (j < i) j = i;
    while (j < ys.length && ys[j]! <= ys[i]! + SUPPORT_BAND_M) j++;
    if (j - i >= need) return ys[i]!;
  }
  return ys[0]!;
}

/** World y the seat rests on: supportY of the skin within 0.1 x height (horizontally) of the pelvis bone and
 *  below it; null without a pelvis/hips bone or skin there */
export function seatY(root: Object3D, heightM: number): number | null {
  let pelvis: Object3D | null = null;
  root.traverse((o) => {
    if (!pelvis && (o as any).isBone && /pelvis|hips?$/i.test(o.name)) pelvis = o;
  });
  if (!pelvis) return null;
  const p = (pelvis as Object3D).getWorldPosition(new Vector3());
  const r = 0.1 * heightM;
  const ys = skinPoints(root).filter((q) => q[1] < p.y && Math.hypot(q[0] - p.x, q[2] - p.z) <= r).map((q) => q[1]);
  return ys.length ? bandLow(ys) : null;
}

const yawOf = (o: Object3D): number => {
  const f = new Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new Quaternion()));
  return Math.atan2(f.x, f.z);
};

const CURVE_N = 16;

/** contact_y at `t01` (0..1 of the clip) from a contact curve, linear; a finished clip (t01 >= 1, clamped by
 *  three) holds the last sample; null = no curve */
export function contactAt(curve: number[] | undefined, t01: number): number | null {
  if (!curve?.length) return null;
  const n = curve.length;
  const x = Math.max(0, Math.min(n - 1, t01 * n));
  const i = Math.floor(x);
  const j = Math.min(n - 1, i + 1);
  return curve[i]! + (curve[j]! - curve[i]!) * (x - i);
}

/** Facts of `clip` on `root` (the holder of a prepared body), sampled at 0, 1/4, 1/2, 3/4 of the prepared
 *  clip (prepareClip, as the runtime plays it). Null when the body has no head/neck bone (headPose). */
export function clipFacts(root: Object3D, clip: AnimationClip, heightM: number): ClipFacts | null {
  root.updateMatrixWorld(true);
  if (!headPose(root)) return null;
  const saved: Array<[Object3D, Vector3, Quaternion, Vector3]> = [];
  root.traverse((o) => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  const c = prepareClip(clip, root);
  const mixer = new AnimationMixer(root);
  const act = mixer.clipAction(c);
  act.play();
  const frames: Array<{ contact: number; dir: Vector3; head: number }> = [];
  const seats: number[] = [];
  let endHead = 0;
  const curve: number[] = [];
  try {
    const d = c.duration > 0 ? c.duration : 0;
    for (let k = 0; k < CURVE_N; k++) {
      const s = k / CURVE_N;
      mixer.setTime(d * s);
      root.updateMatrixWorld(true);
      const low = supportY(root);
      const rootY = root.getWorldPosition(new Vector3()).y;
      curve.push(low - rootY);
      if (k % (CURVE_N / 4) !== 0) continue;
      const hp = headPose(root)!;
      const yaw = (hp.faceYaw * Math.PI) / 180;
      const pitch = (hp.facePitch * Math.PI) / 180;
      const f = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      f.applyAxisAngle(UP, -yawOf(root));
      frames.push({ contact: low - rootY, dir: f, head: hp.pos[1] - low });
      const seat = seatY(root, heightM);
      if (seat !== null) seats.push(seat - rootY);
    }
    // the last frame (just short of the end: a looping action at its duration wraps to 0)
    mixer.setTime(d * 0.999);
    root.updateMatrixWorld(true);
    endHead = headPose(root)!.pos[1] - supportY(root);
  } finally {
    act.stop();
    mixer.uncacheRoot(root);
    for (const [o, p, q, sc] of saved) {
      o.position.copy(p);
      o.quaternion.copy(q);
      o.scale.copy(sc);
    }
    root.updateMatrixWorld(true);
  }
  const mean = (k: "contact" | "head"): number => frames.reduce((a, f) => a + f[k], 0) / frames.length;
  const sum = frames.reduce((a, f) => a.add(f.dir), new Vector3());
  const dir = sum.length() < 1e-6 ? frames[0]!.dir.clone().normalize() : sum.normalize();
  const faceYaw = Math.abs(dir.y) > 0.8 ? null : (((Math.atan2(dir.x, dir.z) * 180) / Math.PI) % 360 + 360) % 360;
  const headY = mean("head");
  return { contact_y: mean("contact"), face_dir: [dir.x, dir.y, dir.z], face_yaw: faceYaw, head_y: headY, lying: headY < 0.5 * heightM, contact_curve: curve,
    end_lying: endHead < 0.5 * heightM,
    ...(seats.length ? { seat_y: seats.reduce((a, b) => a + b, 0) / seats.length } : {}) };
}

const r3 = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

type Fs = typeof import("node:fs");
type Path = typeof import("node:path");

/** `dreamer clipfacts <cast dir>`: reads <cast dir>/cast.json (paths from the cast dir), loads each body and
 *  its clips from disk, fits the body as createActor does (idle frame, then prepareActorBody), writes <cast dir>/clipfacts.json = {actor: {clip: facts}} (numbers to 0.001).
 *  Returns the warnings (a clip or a body that fails is skipped, never thrown). Node only. */
export async function writeClipfacts(castDir: string): Promise<string[]> {
  // node builtins by a variable specifier: this module may be reached from the browser bundle (lowestSkinY)
  const fsName = "node:fs", pathName = "node:path";
  const fs: Fs = await import(fsName);
  const path: Path = await import(pathName);
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const { prepareActorBody, pickAnimation } = await import("./actors.js");
  const warnings: string[] = [];
  const cast = JSON.parse(fs.readFileSync(path.join(castDir, "cast.json"), "utf-8")) as Record<string, any>;
  const parse = async (rel: string): Promise<any> => {
    const file = path.resolve(castDir, rel);
    const b = fs.readFileSync(file);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    // facts need the skin, not its colours: textures are skipped (decoding one under node threw "self is not defined")
    return new GLTFLoader()
      .register(() => ({ name: "dreamer_no_textures", loadTexture: () => Promise.resolve(null) }) as any)
      .parseAsync(ab, path.dirname(file) + path.sep);
  };
  const out: Record<string, Record<string, unknown>> = {};
  for (const [who, c] of Object.entries(cast)) {
    if (!c || typeof c !== "object" || !c.glb || !c.clips || !Object.keys(c.clips).length) continue;
    const heightM = Number(c.height_m ?? 1.7);
    let gltf: any;
    try {
      gltf = await parse(String(c.glb));
    } catch (e) {
      warnings.push(`CLIPFACTS: actor "${who}" body ${c.glb} failed (${String(e)})`);
      continue;
    }
    const clips: Record<string, AnimationClip> = {};
    for (const [name, rel] of Object.entries(c.clips as Record<string, string>)) {
      try {
        const clip = pickAnimation((await parse(rel)).animations, name);
        if (!clip) throw new Error("no animation in the file");
        clips[name] = clip;
      } catch (e) {
        warnings.push(`CLIPFACTS: actor "${who}" clip "${name}" failed (${String(e)})`);
      }
    }
    // as createActor: the animator puts the idle frame on first, then the body is fitted (feet on y = 0)
    const body = gltf.scene as Object3D;
    createAnimator(body, clips, { idle: c.idle, seed: who, life: false });
    const { holder } = prepareActorBody(body, heightM);
    const facts: Record<string, unknown> = {};
    for (const [name, clip] of Object.entries(clips)) {
      const f = clipFacts(holder, clip, heightM);
      if (!f) {
        warnings.push(`CLIPFACTS: actor "${who}" has no head bone, no facts`);
        break;
      }
      facts[name] = {
        contact_y: r3(f.contact_y),
        face_dir: f.face_dir.map(r3),
        face_yaw: f.face_yaw === null ? null : r3(f.face_yaw) % 360,
        head_y: r3(f.head_y),
        ...(f.contact_curve ? { contact_curve: f.contact_curve.map(r3) } : {}),
        ...(f.seat_y !== undefined ? { seat_y: r3(f.seat_y) } : {}),
        ...(f.end_lying !== undefined ? { end_lying: f.end_lying } : {}),
        lying: f.lying,
      };
    }
    if (Object.keys(facts).length) out[who] = facts;
  }
  fs.writeFileSync(path.join(castDir, "clipfacts.json"), JSON.stringify(out, null, 1));
  return warnings;
}

/** L173: where the face looks in the world for an actor without a measured head bone: body yaw plus the
 *  clip's own `face_yaw` (0..360, actor axes). Undefined when the clip has no yaw (face up/down) or no facts. */
export function clipFaceYaw(bodyYaw: number, facts: { face_yaw?: number | null } | null | undefined): number | undefined {
  const fy = facts?.face_yaw;
  if (typeof fy !== "number" || !Number.isFinite(fy)) return undefined;
  return (((bodyYaw + fy) % 360) + 360) % 360;
}
