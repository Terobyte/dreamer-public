import { insideInset, legalCameraPoint, roomRect, type CameraLaw, type CameraSide, type V3 } from "./camera.js";
import type { DActor, DRoom } from "./director.js";
import type { V2 } from "./places.js";
import type { Ease, ShotLook, ShotPoint } from "./shotplan.js";

/** К1 (camera moves): atoms of camera movement turned into legal `from`/`end` points from measured facts (head, face yaw, walls,
 *  180° side). Spark never writes coordinates: it names an atom (`MOVES`), a scheme (`SCHEMES`) or a record (`RECORDS`);
 *  this module is the one place that turns a name into points. Legality of a point is `camera.ts` (`insideInset`,
 *  `legalCameraPoint`); the 180° side is the caller's `ctx.side`. All randomness would go through `ctx.rng` (none is needed here). */

export type Side = CameraSide;
export interface Box {
  min: V3;
  max: V3;
}
export type MoveSubject = { actor: string } | { pair: [string, string] } | { room: true };
export interface Ctx {
  actors: DActor[];
  room: DRoom;
  fov: number;
  aspect: number;
  durationS: number;
  rng: () => number;
  side?: Side;
  prev?: ShotPoint;
  obstacles?: Box[];
  clear?: (cam: V3, look: V3) => boolean;
  /** the speaker of the beat (decides the `ots` / `two` target) */
  speaker?: string;
  /** straight walk of the beat per actor: where it ends (stage.json `goto`); `route` has the segments if not straight */
  walk?: Record<string, { to: V2; route?: V2[]; blocked?: boolean }>;
}
export interface Resolved {
  from: ShotPoint;
  end: ShotPoint | null;
  ease: Ease;
  shake: number;
  warnings: string[];
}

/** numbers of an atom: d metres from the aim, az degrees from the base direction, h metres (above the head, or above the floor if `abs`), f degrees of fov added to ctx.fov */
export interface Spec {
  d: [number, number];
  az: [number, number];
  h: [number, number];
  f: [number, number];
  abs?: boolean;
  shake: number;
  ease: Ease;
  /** pan / tilt: degrees the look turns from `from` to `end`, camera stands */
  pan?: number;
  tilt?: number;
  dolly?: boolean;
  walk?: "side" | "behind" | "lead";
  ots?: boolean;
  two?: boolean;
  /** wide / master: the whole room is the aim */
  room?: boolean;
}
export interface MoveDef {
  id: string;
  family: string;
  aliases: string[];
  defaults: Spec;
  moving: boolean;
  faceMove: boolean;
  /** one-line meaning for the Spark prompt */
  meaning: string;
  /** the static stand-in (`pickMove` under a no-motion style) */
  staticOf?: string;
}

const S = (d: [number, number], az: [number, number], h: [number, number], f: [number, number], shake: number, ease: Ease, x: Partial<Spec> = {}): Spec => ({ d, az, h, f, shake, ease, ...x });
const def = (id: string, family: string, aliases: string[], meaning: string, defaults: Spec, moving: boolean, faceMove = false, staticOf?: string): [string, MoveDef] => [id, { id, family, aliases, defaults, moving, faceMove, meaning, staticOf }];

export const MOVES: Record<string, MoveDef> = Object.fromEntries([
  def("wide", "size", ["общий"], "the whole scene from a distance", S([4.5, 4.5], [0, 0], [0.3, 0.3], [0, 0], 0, "io", { room: true }), false),
  def("medium", "size", ["средний"], "waist-up on the subject", S([2.4, 2.4], [0, 0], [0.1, 0.1], [0, 0], 0, "io"), false),
  def("medium_wide", "size", ["средне-общий"], "knees-up on the subject, wider than medium", S([3.2, 3.2], [0, 0], [0.1, 0.1], [0, 0], 0, "io"), false),
  def("close", "size", ["крупный"], "face fills the frame", S([1.2, 1.2], [0, 0], [0, 0], [0, 0], 0, "io"), false, true),
  def("medium_close", "size", ["средне-крупный"], "shoulders-up on the subject", S([1.6, 1.6], [0, 0], [0, 0], [0, 0], 0, "io"), false, true),
  def("master", "size", ["мастер-план"], "the whole room from high and far", S([7, 7], [0, 0], [1.2, 1.2], [8, 8], 0, "io", { room: true }), false),
  def("detail", "size", ["деталь"], "very tight on the head", S([0.8, 0.8], [0, 0], [-0.1, -0.1], [-8, -8], 0, "io"), false),
  def("push_in", "move", ["наезд"], "slow move toward the subject", S([2.2, 1.6], [0, 0], [0.1, 0], [0, -4], 0.003, "io"), true, true, "close"),
  def("pull_out", "move", ["отъезд"], "move away from the subject", S([1.6, 2.4], [0, 0], [0, 0.1], [0, 3], 0.003, "io"), true, false, "wide"),
  def("slow_push", "move", ["медленный наезд"], "very slow push on the face at the moment of emotion", S([1.9, 1.4], [0, 0], [0, 0], [0, -3], 0.001, "lin"), true, true, "close"),
  def("truck", "move", ["проезд вбок"], "camera slides sideways", S([2.6, 2.6], [-18, 18], [0.1, 0.1], [0, 0], 0.002, "io"), true, false, "medium"),
  def("arc", "move", ["дуга"], "camera circles the subject", S([2.4, 2.4], [0, 30], [0.1, 0.1], [0, 0], 0.002, "io"), true, false, "medium"),
  def("pedestal_up", "move", ["подъём"], "camera rises", S([2.4, 2.4], [0, 0], [-0.2, 0.5], [0, 0], 0.002, "io"), true, false, "medium"),
  def("pedestal_down", "move", ["опускание"], "camera lowers", S([2.4, 2.4], [0, 0], [0.5, -0.2], [0, 0], 0.002, "io"), true, false, "medium"),
  def("crane_up", "move", ["кран вверх"], "rise and pull back (scene end)", S([2.8, 4.2], [0, 0], [0.2, 1], [0, 0], 0.001, "io"), true, false, "wide"),
  def("crane_down", "move", ["кран вниз"], "descend and move in (scene start)", S([4.2, 2.8], [0, 0], [1, 0.2], [0, 0], 0.001, "io"), true, false, "medium"),
  def("follow_side", "move", ["сопровождение рядом"], "camera walks beside a walking actor", S([2, 2], [90, 90], [0.1, 0.1], [0, 0], 0.003, "lin", { walk: "side" }), true, false, "medium"),
  def("follow_behind", "move", ["сопровождение сзади"], "camera follows a walking actor from behind", S([2.2, 2.2], [180, 180], [0.2, 0.2], [0, 0], 0.003, "lin", { walk: "behind" }), true, false, "medium"),
  def("lead", "move", ["ведение"], "camera backs away in front of a walking actor", S([2.2, 2.2], [0, 0], [0.1, 0.1], [0, 0], 0.003, "lin", { walk: "lead" }), true, false, "medium"),
  def("drift", "move", ["дрейф"], "tiny living drift", S([2.4, 2.5], [0, 4], [0.1, 0.1], [0, 0], 0.002, "io"), true, false, "medium"),
  def("handheld", "move", ["ручная камера"], "hand-held wobble", S([2.2, 2.1], [0, 3], [0.1, 0.1], [0, 0], 0.006, "io"), true, false, "medium"),
  def("steadicam", "move", ["стедикам"], "smooth gliding move", S([2.4, 2], [0, -5], [0.1, 0.1], [0, 0], 0.001, "io"), true, false, "medium"),
  def("zoom_in", "lens", ["наезд зумом"], "lens narrows, camera stands", S([2.4, 2.4], [0, 0], [0.1, 0.1], [0, -8], 0.002, "io"), true, false, "close"),
  def("zoom_out", "lens", ["отъезд зумом"], "lens widens, camera stands", S([2.4, 2.4], [0, 0], [0.1, 0.1], [0, 8], 0.002, "io"), true, false, "wide"),
  def("dolly_zoom", "lens", ["dolly zoom"], "Vertigo: camera moves away, lens narrows, subject keeps its size", S([2, 3.4], [0, 0], [0.1, 0.1], [0, 0], 0, "lin", { dolly: true }), true, false, "medium"),
  def("pan_to", "turn", ["панорама"], "camera stands and turns", S([2.6, 2.6], [0, 0], [0.1, 0.1], [0, 0], 0.002, "io", { pan: 7 }), true, false, "medium"),
  def("tilt_up", "turn", ["вертикальная панорама"], "camera stands and tilts up", S([2.6, 2.6], [0, 0], [0, 0], [0, 0], 0.002, "io", { tilt: 7 }), true, false, "medium"),
  def("whip_pan", "turn", ["быстрая панорама"], "fast pan as a cut", S([2.6, 2.6], [0, 0], [0.1, 0.1], [0, 0], 0, "in", { pan: 9 }), true, false, "medium"),
  def("eye_level", "angle", ["на уровне глаз"], "camera at the subject's eye height, still", S([2.4, 2.4], [0, 0], [0, 0], [0, 0], 0, "io"), false),
  def("low", "angle", ["низкий"], "camera below the eyes, looks up", S([2.2, 2.2], [0, 0], [-0.6, -0.6], [0, 0], 0, "io"), false),
  def("high", "angle", ["высокий"], "camera above, looks down", S([2.2, 2.2], [0, 0], [0.9, 0.9], [0, 0], 0, "io"), false),
  def("child_eye", "angle", ["глазами ребёнка"], "camera at a child's eye height", S([2.2, 2.2], [0, 0], [0.8, 0.8], [0, 0], 0, "io", { abs: true }), false),
  def("tatami", "angle", ["татами"], "Ozu: very low and still", S([2.4, 2.4], [0, 0], [0.7, 0.7], [0, 0], 0, "io", { abs: true }), false),
  def("top_down", "angle", ["вид сверху"], "almost straight down", S([0.6, 0.6], [0, 0], [3, 3], [0, 0], 0, "io"), false),
  def("profile", "angle", ["профиль"], "camera at the side of the face", S([2.4, 2.4], [90, 90], [0.1, 0.1], [0, 0], 0, "io"), false),
  def("three_quarter", "angle", ["три четверти"], "camera at 40° from the face line", S([2.4, 2.4], [40, 40], [0.1, 0.1], [0, 0], 0, "io"), false),
  def("frontal", "angle", ["лобовой"], "straight in front of the face (Anderson)", S([2.4, 2.4], [0, 0], [0.1, 0.1], [0, 0], 0, "io"), false),
  def("ots", "pair", ["через плечо"], "over the shoulder of one of the pair", S([0.8, 0.8], [14, 14], [0.1, 0.1], [0, 0], 0, "io", { ots: true }), false, true),
  def("two", "pair", ["двойной"], "both actors in one frame", S([1.8, 1.8], [0, 0], [0.2, 0.2], [0, 0], 0, "io", { two: true }), false),
  def("close_reaction", "pair", ["реакция"], "close on the listener", S([1.2, 1.2], [0, 0], [0, 0], [0, 0], 0, "io"), false, true),
]);
/** records: named, not executed (a static point and `MOVE_RECORD_ONLY`) */
export const RECORDS: Record<string, { id: string; meaning: string }> = {
  dutch: { id: "dutch", meaning: "tilted horizon (needs roll)" },
  rack_focus: { id: "rack_focus", meaning: "focus pull (needs depth of field)" },
  insert: { id: "insert", meaning: "detail of an object (needs an object)" },
  pov: { id: "pov", meaning: "view from the actor's head (needs the inside view)" },
  cross_cut: { id: "cross_cut", meaning: "cut between two places (needs two rooms)" },
};
export const SCHEMES: Record<string, { id: string; meaning: string }> = {
  over_the_shoulder: { id: "over_the_shoulder", meaning: "shoulder to shoulder, one ots per speaker" },
  reaction_cut: { id: "reaction_cut", meaning: "close on the listener" },
  establishing: { id: "establishing", meaning: "master shot at the start of a scene" },
  oner: { id: "oner", meaning: "one chain of moves without a cut" },
  rhythm_cut: { id: "rhythm_cut", meaning: "shorter plans on emotion" },
  return_wide: { id: "return_wide", meaning: "back to a wide at the end of a line" },
  open_from_light: { id: "open_from_light", meaning: "open on the light, then on the hero" },
  final_pull_out: { id: "final_pull_out", meaning: "last plan of the scene pulls out" },
};

// ---- math ----
const DEG = Math.PI / 180;
/** the frame check's edge (okAt: |ndc| <= 0.85): a walk shot sizes its distance so the tallest walker fits inside it */
const WALK_FRAME_NDC = 0.85;
/** a walk shot's camera stands at least this far off every walker's path (director PATH_CLEAR_M) */
const WALK_PATH_CLEAR_M = 1.2;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const lerp3 = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Where a world point lands in a view: x, y in [-1, 1] across the frame (vertical fov `fovV` degrees), `depth` along the view; visible if depth >= 0.1 */
export function ndcOf(p: V3, cam: V3, look: V3, fovV: number, aspect: number): { x: number; y: number; depth: number } {
  const f = norm(sub(look, cam));
  const r: V3 = Math.abs(f[1]) > 0.999 ? [1, 0, 0] : norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const d = sub(p, cam);
  const depth = dot(d, f);
  const t = Math.tan((fovV * DEG) / 2);
  return { x: dot(d, r) / depth / (t * aspect), y: dot(d, u) / depth / t, depth };
}

const headOf = (a: DActor, floorY = 0): V3 => a.head ?? [a.pos[0], floorY + a.height * 0.9, a.pos[1]];
/** `DActor.hips` is a K2 extension (director.ts); until it lands, read it structurally so K1 keeps director.ts untouched */
const hipsOf = (a: DActor, floorY = 0): V3 => (a as unknown as { hips?: V3 }).hips ?? [a.pos[0], floorY + 0.25, a.pos[1]];
const topOf = (r: DRoom): number => (r.open ? (r.floorY ?? 0) + 3.5 : r.ceiling);
const sideOf = (s: CameraSide, x: number, z: number): number => ((x - s.origin[0]) * s.normal[0] + (z - s.origin[1]) * s.normal[1]) * s.sign;

function segDist2(a: V2, b: V2, c: V2, d: V2): number {
  const ccw = (p: V2, q: V2, r: V2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (ccw(a, c, d) * ccw(b, c, d) < 0 && ccw(c, a, b) * ccw(d, a, b) < 0) return 0;
  const pt = (p: V2, s: V2, e: V2): number => {
    const ex = e[0] - s[0];
    const ez = e[1] - s[1];
    const L = ex * ex + ez * ez;
    const t = L > 0 ? clampN(((p[0] - s[0]) * ex + (p[1] - s[1]) * ez) / L, 0, 1) : 0;
    return Math.hypot(p[0] - (s[0] + t * ex), p[1] - (s[1] + t * ez));
  };
  return Math.min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b));
}
function segBox(a: V3, b: V3, bx: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const dd = b[i] - a[i];
    if (Math.abs(dd) < 1e-12) {
      if (a[i] < bx.min[i] || a[i] > bx.max[i]) return false;
    } else {
      let u0 = (bx.min[i] - a[i]) / dd;
      let u1 = (bx.max[i] - a[i]) / dd;
      if (u0 > u1) [u0, u1] = [u1, u0];
      t0 = Math.max(t0, u0);
      t1 = Math.min(t1, u1);
      if (t0 > t1) return false;
    }
  }
  return true;
}

// ---- subject geometry ----
interface Pt {
  pos: V3;
  fov: number;
  o: V3;
  lookW: V3;
  /** look as a bone reference (pan / tilt between actors keep refs, not world vectors) */
  ref?: ShotLook;
}
interface Geo {
  kind: "actor" | "pair" | "room";
  /** the aim at path share w (0 = from, 1 = end) */
  aim: (w: number) => V3;
  base: number;
  hBase: number;
  dAdd: number;
  /** points that must be framed at path share u */
  frame: (u: number) => V3[];
  /** angle limit from the face to the camera, per actor name (60 for the framed face of a faceMove atom, else 100) */
  limit: (name: string) => number;
  lying: DActor[];
  /** actor whose head bone the look follows (ShotLook {actor, bone}) */
  lookActor: string | null;
  /** world point the camera looks at, if not `aim` (pair: midpoint of the heads) */
  lookAt?: (w: number) => V3;
  /** offset of the look from the lookActor's head (a walk group: aimed at the group's middle height, still riding the bone) */
  lookO?: V3;
  /** walk shots: the walkers' paths (floor segments) the camera keeps WALK_PATH_CLEAR_M off at every sample */
  keepOff?: [V2, V2][];
  noFace: boolean;
  /** pan / tilt: look goes from p0 (ref r0) to p1 (ref r1), the camera stands */
  turn?: { p0: V3; p1: V3; r0: ShotLook; r1: ShotLook };
}
const bearing = (x: number, z: number): number => Math.atan2(x, z) / DEG;

function turnGeo(spec: Spec, a: DActor, other: DActor | undefined, ctx: Ctx): Geo {
  const floorY = ctx.room.floorY ?? 0;
  const hd = headOf(a, floorY);
  const ref = (n: string, bone: "head" | "hips"): ShotLook => ({ actor: n, bone, o: [0, 0, 0] });
  let p0 = hd;
  let p1 = hd;
  let r0 = ref(a.name, "head");
  let r1 = r0;
  if (spec.pan && other) {
    p1 = headOf(other, floorY);
    r1 = ref(other.name, "head");
  } else {
    p0 = hipsOf(a, floorY);
    r0 = ref(a.name, "hips");
  }
  const mid = lerp3(p0, p1, 0.5);
  return { kind: "actor", aim: (w) => (w ? p1 : p0), base: a.faceYaw ?? a.yaw, hBase: mid[1], dAdd: 0, frame: (u) => [lerp3(p0, p1, u)], limit: () => 100, lying: [], lookActor: a.name, noFace: false, turn: { p0, p1, r0, r1 } };
}
function geoOf(spec: Spec, faceMove: boolean, subject: MoveSubject, ctx: Ctx, walkOk: boolean): Geo | "NOWALK" {
  const floorY = ctx.room.floorY ?? 0;
  const find = (n: string): DActor | undefined => ctx.actors.find((a) => a.name === n);
  const roomGeo = (): Geo => {
    const xs = ctx.room.outline.map((p) => p[0]);
    const zs = ctx.room.outline.map((p) => p[1]);
    const c: V3 = [(Math.min(...xs) + Math.max(...xs)) / 2, floorY + 1.2, (Math.min(...zs) + Math.max(...zs)) / 2];
    const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    return { kind: "room", aim: () => c, base: 0, hBase: floorY + 1.2, dAdd: Math.max(0, ext * 0.45 - spec.d[0]) * 0 + (clampN(ext / 6, 0.6, 2.5) - 1) * spec.d[0], frame: () => [], limit: () => 100, lying: [], lookActor: null, noFace: false };
  };
  if ("room" in subject) return roomGeo();
  if ("actor" in subject) {
    const a = find(subject.actor);
    if (!a) return roomGeo();
    const h = headOf(a, floorY);
    const fd = a.faceYaw ?? a.yaw;
    if (spec.walk) {
      const w = ctx.walk?.[a.name];
      if (!walkOk || !w || w.blocked || (w.route && w.route.length > 1)) return "NOWALK";
      const dx = w.to[0] - a.pos[0];
      const dz = w.to[1] - a.pos[1];
      for (const bx of ctx.obstacles ?? []) {
        if (bx.max[1] < floorY || bx.min[1] > h[1]) continue;
        const y = clampN((bx.min[1] + bx.max[1]) / 2, floorY, h[1]);
        if (segBox([a.pos[0], y, a.pos[1]], [w.to[0], y, w.to[1]], bx)) return "NOWALK";
      }
      const aimAt = (u: number): V3 => [h[0] + dx * u, h[1], h[2] + dz * u];
      // every walker of the beat is framed whole, head to feet (v37/v38 street: the one beside the held walker stood
      // a metre off the lens, two frame heights tall); the camera stands back as far as the tallest body needs at
      // this fov, plus how far apart they walk
      // ...and one standing nearer the walker than the camera stands is in the shot anyway (v39 141 s: Squidward set
      // off a beat after the cut, not a walker yet, and walked in by the lens with his head cut off)
      const group = ctx.actors.filter((x) => !x.offstage && (x.name === a.name || ctx.walk?.[x.name] || Math.hypot(x.pos[0] - a.pos[0], x.pos[1] - a.pos[1]) < spec.d[0]));
      const along = (x: DActor, y: number, u: number): V3 => {
        const t = ctx.walk?.[x.name]?.to ?? x.pos;
        return [x.pos[0] + (t[0] - x.pos[0]) * u, y, x.pos[1] + (t[1] - x.pos[1]) * u];
      };
      // the top of each is his height, not his head bone (v42 151 s: Squidward's head bone is mid-body, 1.17 of 1.8 m;
      // framed by it, the shot held him from the knees to the chest)
      const topY = (x: DActor): number => Math.max(headOf(x, floorY)[1], floorY + x.height);
      const tall = Math.max(...group.map((x) => topY(x) - floorY));
      const spread = Math.max(0, ...group.map((x) => Math.hypot(x.pos[0] - a.pos[0], x.pos[1] - a.pos[1])));
      const need = tall / (2 * WALK_FRAME_NDC * Math.tan((ctx.fov * DEG) / 2)) + spread;
      const frame = (u: number): V3[] => group.flatMap((x) => [along(x, topY(x), u), along(x, floorY, u)]);
      return { kind: "actor", aim: aimAt, base: bearing(dx, dz), hBase: Math.max(h[1], floorY + tall / 2), dAdd: Math.max(0, need - spec.d[0]), frame, lookO: [0, floorY + tall / 2 - h[1], 0], keepOff: group.filter((x) => ctx.walk?.[x.name]).map((x) => [x.pos, ctx.walk![x.name]!.to] as [V2, V2]), limit: () => 100, lying: [], lookActor: a.name, noFace: spec.walk === "behind" || spec.walk === "lead" };
    }
    if (spec.pan || spec.tilt) return turnGeo(spec, a, ctx.actors.find((x) => x.name !== a.name && !x.offstage), ctx);
    const frame = a.lying ? [h, hipsOf(a, floorY)] : [h];
    return { kind: "actor", aim: () => h, base: fd, hBase: h[1], dAdd: 0, frame: () => frame, limit: (n) => (faceMove && n === a.name ? 60 : 100), lying: a.lying ? [a] : [], lookActor: a.name, noFace: false };
  }
  const [na, nb] = subject.pair;
  const a = find(na);
  const b = find(nb);
  if (!a || !b) return geoOf(spec, faceMove, { actor: a ? na : nb }, ctx, walkOk);
  const ha = headOf(a, floorY);
  const hb = headOf(b, floorY);
  const lying = [a, b].filter((x) => x.lying);
  if ((spec.pan || spec.tilt) && !a.walking && !b.walking) return turnGeo(spec, a, b, ctx);
  if (a.walking || b.walking) return geoOf(spec, faceMove, { actor: ctx.speaker === nb ? nb : na }, ctx, walkOk);
  if (spec.ots) {
    const sp = ctx.speaker;
    const target = sp === nb ? a : sp === na ? b : a;
    const other = target === a ? b : a;
    const ht = target === a ? ha : hb;
    const ho = target === a ? hb : ha;
    const d = Math.hypot(ho[0] - ht[0], ho[2] - ht[2]);
    return { kind: "pair", aim: () => ht, base: bearing(ho[0] - ht[0], ho[2] - ht[2]), hBase: ho[1], dAdd: d, frame: () => [ht, ho, ...[a, b].filter((x) => x.lying).map((x) => hipsOf(x, floorY))], limit: (n) => (n === target.name ? 60 : 100), lying: [a, b].filter((x) => x.lying), lookActor: null, lookAt: () => lerp3(ha, hb, 0.5), noFace: false };
  }
  const mid = lerp3(ha, hb, 0.5);
  const ax = hb[0] - ha[0];
  const az = hb[2] - ha[2];
  let nrm: V2 = [-az, ax];
  if (ctx.side) nrm = [ctx.side.normal[0] * ctx.side.sign, ctx.side.normal[1] * ctx.side.sign];
  else {
    const xs = ctx.room.outline.map((p) => p[0]);
    const zs = ctx.room.outline.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2 - mid[0];
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2 - mid[2];
    if (nrm[0] * cx + nrm[1] * cz < 0) nrm = [-nrm[0], -nrm[1]];
  }
  const sep = Math.hypot(ax, az);
  const tgt = ctx.speaker === nb ? b : a;
  return { kind: "pair", aim: () => mid, base: bearing(nrm[0], nrm[1]), hBase: mid[1], dAdd: sep * 0.9, frame: () => [ha, hb], limit: (n) => (n === tgt.name ? 60 : 100), lying, lookActor: null, noFace: false };
}

// ---- legality ----
interface Env {
  ctx: Ctx;
  spec: Spec;
  g: Geo;
  floorY: number;
  lo: number;
  hi: number;
  strictFace: boolean;
  noFace: boolean;
  useClear: boolean;
  /** wide / master: the two floor corners farthest from the camera must be ahead and across the frame (a camera inside the room can never see the corners behind it) */
  roomFrame?: boolean;
  /** extra vertical fov degrees, tried in steps for room shots */
  fovAdd?: number;
}
const shk = (e: Env): number => e.spec.shake;
function okPoint(e: Env, p: V3): boolean {
  const s = shk(e);
  if (p[1] < e.lo + 0.5 * s - 1e-9 || p[1] > Math.max(e.lo + 0.5 * s, e.hi - 0.5 * s) + 1e-9) return false;
  if (e.ctx.room.outline.length >= 3 && !insideInset(e.ctx.room.outline, [p[0], p[2]], 0.3 + 1.5 * s)) return false;
  if (e.ctx.side && sideOf(e.ctx.side, p[0], p[2]) <= 1e-6) return false;
  for (const bx of e.ctx.obstacles ?? []) if (p[0] >= bx.min[0] && p[0] <= bx.max[0] && p[1] >= bx.min[1] && p[1] <= bx.max[1] && p[2] >= bx.min[2] && p[2] <= bx.max[2]) return false;
  return true;
}
function faceAngle(a: DActor, head: V3, cam: V3): number {
  const yaw = (a.faceYaw ?? a.yaw) * DEG;
  const dx = cam[0] - head[0];
  const dz = cam[2] - head[2];
  const l = Math.hypot(dx, dz);
  if (l < 1e-9) return 0;
  return Math.acos(clampN((Math.sin(yaw) * dx + Math.cos(yaw) * dz) / l, -1, 1)) / DEG;
}
/** all per-sample rules: point legal, subject framed, faces seen from the front, lying actors not crowded, clear view */
function okAt(e: Env, pos: V3, lookW: V3, fov: number, u: number, checkClear: boolean): boolean {
  const { ctx } = e;
  if (!okPoint(e, pos)) return false;
  for (const [p0, p1] of e.g.keepOff ?? []) if (segDist2([pos[0], pos[2]], [pos[0], pos[2]], p0, p1) < WALK_PATH_CLEAR_M - 1e-9) return false;
  for (const p of e.g.frame(u)) {
    const n = ndcOf(p, pos, lookW, fov, ctx.aspect);
    if (n.depth < 0.1 || Math.abs(n.x) > 0.85 || Math.abs(n.y) > 0.85) return false;
  }
  if (e.roomFrame) {
    const far = ctx.room.outline.map((c) => ({ c, d: Math.hypot(c[0] - pos[0], c[1] - pos[2]) })).sort((a, b) => b.d - a.d).slice(0, 2);
    for (const { c } of far) {
      const n = ndcOf([c[0], e.floorY, c[1]], pos, lookW, fov, ctx.aspect);
      if (n.depth < 0.1 || Math.abs(n.x) > 1) return false;
    }
  }
  if (e.g.lying.length && !ctx.clear) return false;
  for (const a of e.g.lying) {
    if (len(sub(pos, headOf(a, e.floorY))) < 0.5 - 1e-9) return false;
    if (pos[1] > e.floorY + 1.6 + 1e-9) return false;
  }
  if (!e.noFace && !e.g.noFace) {
    for (const a of ctx.actors) {
      if (a.lying || a.offstage) continue;
      const h = headOf(a, e.floorY);
      const n = ndcOf(h, pos, lookW, fov, ctx.aspect);
      if (n.depth < 0.1 || Math.abs(n.x) > 1 || Math.abs(n.y) > 1) continue;
      const lim = e.strictFace ? e.g.limit(a.name) : 100;
      if (faceAngle(a, h, pos) > lim + 1e-9) return false;
    }
  }
  if (checkClear && e.useClear && ctx.clear && !ctx.clear(pos, lookW)) return false;
  return true;
}
const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({ pos: lerp3(a.pos, b.pos, t), fov: a.fov + (b.fov - a.fov) * t, o: lerp3(a.o, b.o, t), lookW: lerp3(a.lookW, b.lookW, t), ref: t >= 1 ? b.ref : t <= 0 ? a.ref : undefined });
export function isMoved(a: { pos: V3; fov: number; lookW: V3 }, b: { pos: V3; fov: number; lookW: V3 }): boolean {
  if (len(sub(b.pos, a.pos)) >= 0.1) return true;
  if (Math.abs(b.fov - a.fov) >= 2) return true;
  const da = norm(sub(a.lookW, a.pos));
  const db = norm(sub(b.lookW, b.pos));
  return Math.acos(clampN(dot(da, db), -1, 1)) / DEG >= 5;
}
function pathOk(e: Env, a: Pt, b: Pt): boolean {
  const L = len(sub(b.pos, a.pos));
  const N = Math.max(8, Math.ceil(L / 0.05));
  for (let k = 0; k <= N; k++) {
    const u = k / N;
    const p = lerpPt(a, b, u);
    if (!okAt(e, p.pos, p.lookW, p.fov, u, true)) return false;
  }
  const m = 0.3 + 1.5 * shk(e);
  const o = e.ctx.room.outline;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) if (segDist2([a.pos[0], a.pos[2]], [b.pos[0], b.pos[2]], o[j], o[i]) < m - 1e-9) return false;
  for (const bx of e.ctx.obstacles ?? []) if (segBox(a.pos, b.pos, bx)) return false;
  return true;
}

// ---- candidates ----
const SHIFTS = [0, ...Array.from({ length: 12 }, (_, i) => [(i + 1) * 15, -(i + 1) * 15]).flat()].filter((v, i, arr) => arr.indexOf(v) === i && Math.abs(v) <= 180);
const SCALES = [1, 0.85, 0.7, 0.55, 1.25, 1.5];

function build(e: Env, shift: number, scale: number, flip: 1 | -1): { from: Pt; full: Pt | null } {
  const { spec, g, ctx } = e;
  const mk = (w: 0 | 1): Pt => {
    const aim = g.turn ? lerp3(g.turn.p0, g.turn.p1, 0.5) : g.aim(w);
    const d = spec.d[w] * scale + g.dAdd;
    const a0 = spec.az[0];
    const az = (g.base + shift + (w === 0 ? a0 : a0 + (spec.az[1] - a0) * flip)) * DEG;
    const yRaw = (spec.abs ? e.floorY : g.hBase) + spec.h[w];
    const y = clampN(yRaw, e.lo + 0.5 * spec.shake, Math.max(e.lo + 0.5 * spec.shake, e.hi - 0.5 * spec.shake));
    const pos: V3 = [aim[0] + d * Math.sin(az), y, aim[2] + d * Math.cos(az)];
    let o: V3 = [0, 0, 0];
    if (!g.turn && w === 1 && (spec.pan || spec.tilt)) {
      const dd = len(sub(aim, pos));
      if (spec.pan) {
        const r = norm(cross(norm(sub(aim, pos)), [0, 1, 0]));
        const k = dd * Math.tan(spec.pan * DEG) * flip;
        o = [r[0] * k, 0, r[2] * k];
      } else o = [0, dd * Math.tan((spec.tilt ?? 0) * DEG), 0];
    }
    return { pos, fov: clampN(ctx.fov + spec.f[w] + (e.fovAdd ?? 0), 15, 90), o, lookW: g.turn ? (w ? g.turn.p1 : g.turn.p0) : ((l) => [l[0] + o[0], l[1] + o[1], l[2] + o[2]] as V3)(g.lookAt ? g.lookAt(w) : g.lookO ? [aim[0] + g.lookO[0], aim[1] + g.lookO[1], aim[2] + g.lookO[2]] : aim), ref: g.turn ? (w ? g.turn.r1 : g.turn.r0) : undefined };
  };
  const from = mk(0);
  return { from, full: e.spec.d[0] === e.spec.d[1] && spec.az[0] === spec.az[1] && spec.h[0] === spec.h[1] && spec.f[0] === spec.f[1] && !spec.pan && !spec.tilt && !spec.walk ? null : mk(1) };
}
function dollyFix(from: Pt, end: Pt): Pt {
  const d0 = len(sub(from.lookW, from.pos));
  const d1 = len(sub(end.lookW, end.pos)) || 1;
  const f = 2 * Math.atan((d0 * Math.tan((from.fov * DEG) / 2)) / d1) / DEG;
  return { ...end, fov: clampN(f, 5, 120) };
}

interface Found {
  from: Pt;
  end: Pt | null;
  shrunk: boolean;
  staticFallback: boolean;
}
function search(e: Env): Found | null {
  if (!e.roomFrame) return searchOnce(e);
  for (const add of [0, 10, 20, 30, 45]) {
    const r = searchOnce({ ...e, fovAdd: add });
    if (r) return r;
  }
  return null;
}
function searchOnce(e: Env): Found | null {
  let fb: Found | null = null;
  const moving = e.spec.d[0] !== e.spec.d[1] || e.spec.az[0] !== e.spec.az[1] || e.spec.h[0] !== e.spec.h[1] || e.spec.f[0] !== e.spec.f[1] || !!e.spec.pan || !!e.spec.tilt || !!e.spec.walk;
  const clearOnly = e.useClear && !!e.ctx.clear;
  for (const scale of SCALES) {
    // with `clear`: the first point legal without it is the anchor; only rotations up to 45° around it are tried
    let anchor: number | null = null;
    for (const shift of SHIFTS) {
      const c0 = build(e, shift, scale, 1);
      if (!okAt(e, c0.from.pos, c0.from.lookW, c0.from.fov, 0, false)) continue;
      if (anchor === null) anchor = shift;
      if (clearOnly && (Math.abs(shift - anchor) > 45 || !okAt(e, c0.from.pos, c0.from.lookW, c0.from.fov, 0, true))) continue;
      let base = c0;
      let won = shift;
      if (!fb) fb = { from: base.from, end: null, shrunk: false, staticFallback: moving };
      if (!moving) return fb;
      for (const flip of [1, -1] as const) {
        const c = flip === 1 ? base : build(e, won, scale, flip);
        if (!c.full) continue;
        for (let lvl = 0; lvl < 4; lvl++) {
          let end = lvl === 0 ? c.full : lerpPt(c.from, c.full, 0.5 ** lvl);
          if (e.spec.dolly) end = dollyFix(c.from, end);
          if (!isMoved(c.from, end)) break;
          if (e.g.turn && lvl > 0) break;
          if (pathOk(e, c.from, end)) return { from: c.from, end, shrunk: lvl > 0, staticFallback: false };
        }
      }
    }
    // same radius only: if this radius had a legal point but `clear` rejected the rotations or the path, it is occluded
    if (clearOnly && anchor !== null) return search({ ...e, useClear: false })?.end ? null : fb;
  }
  return fb;
}

const toPoint = (p: Pt, g: Geo, world: boolean): ShotPoint => ({
  pos: p.pos,
  look: p.ref ? p.ref : g.lookActor && !world ? { actor: g.lookActor, bone: "head", o: g.lookO ?? [0, 0, 0] } : (p.lookW as ShotLook),
  fov: p.fov,
});

/** outdoors there are no walls to show: the "room" of a wide is the actors on stage (Koshakan meadow, Nov 3: the wide
 *  of a 40 m field stood 11 m off and framed its centre, the pair 16 % of the frame) */
function openSubject(subject: MoveSubject, ctx: Ctx): MoveSubject {
  if (!("room" in subject) || !ctx.room.open) return subject;
  const on = ctx.actors.filter((a) => !a.offstage).map((a) => a.name);
  if (on.length >= 2) return { pair: [on[0]!, on[1]!] };
  return on.length === 1 ? { actor: on[0]! } : subject;
}

export function resolveMove(id: string, subject0: MoveSubject, ctx: Ctx): Resolved {
  const warnings: string[] = [];
  const subject = openSubject(subject0, ctx);
  let useId = id;
  const isRecord = Object.hasOwn(RECORDS, id);
  if (isRecord) useId = "medium";
  let md = Object.hasOwn(MOVES, useId) ? MOVES[useId] : undefined;
  if (!md) throw new Error(`MOVE_UNKNOWN ${id}`);
  if ("room" in subject && useId !== "wide" && useId !== "master") {
    warnings.push(`MOVE_ROOM_SUBJECT ${useId}`);
    useId = "wide";
    md = MOVES.wide;
  }
  const floorY = ctx.room.floorY ?? 0;
  const lo = floorY + 0.3;
  // legalCameraPoint clamps to height - CEIL_GAP (0.3) first (camera.ts:30), so that is the reachable top
  const hi = topOf(ctx.room) - 0.3;
  const finish = (r: Resolved): Resolved => {
    if (isRecord) r.warnings.push(`MOVE_RECORD_ONLY ${id}`);
    return r;
  };
  const run = (m: MoveDef, subj: MoveSubject, strictFace: boolean, noFace: boolean, useClear: boolean, walkOk = true): { f: Found; g: Geo; spec: Spec } | "NOWALK" | null => {
    const g = geoOf(m.defaults, m.faceMove, subj, ctx, walkOk);
    if (g === "NOWALK") return "NOWALK";
    const spec = m.defaults;
    const e: Env = { ctx, spec, g, floorY, lo, hi, strictFace, noFace, useClear };
    const f = (g.kind === "room" && search({ ...e, roomFrame: true })) || search(e);
    return f ? { f, g, spec } : null;
  };
  const out = (r: { f: Found; g: Geo; spec: Spec }, w: string[]): Resolved => ({
    from: toPoint(r.f.from, r.g, !!(r.spec.pan || r.spec.tilt)),
    end: r.f.end ? toPoint(r.f.end, r.g, !!(r.spec.pan || r.spec.tilt)) : null,
    ease: r.spec.ease,
    shake: r.spec.shake,
    warnings: [...warnings, ...w],
  });
  const note = (r: { f: Found }, m: MoveDef): string[] => (r.f.shrunk ? ["MOVE_SHRUNK"] : r.f.staticFallback && m.moving ? ["MOVE_STATIC"] : []);

  let first = run(md, subject, true, false, true);
  if (first === "NOWALK") {
    const alt = run(MOVES.medium, "room" in subject ? subject : "pair" in subject ? { actor: subject.pair[0] } : subject, true, false, true);
    if (alt && alt !== "NOWALK") return finish(out(alt, ["MOVE_STATIC"]));
    first = null;
  }
  if (first && first.f.staticFallback && md.moving && ctx.clear) {
    const free = run(md, subject, true, false, false);
    if (free && free !== "NOWALK" && free.f.end) first = null;
  }
  if (first) return finish(out(first, note(first, md)));
  if (ctx.clear) {
    const nc = run(md, subject, true, false, false);
    if (nc && nc !== "NOWALK") {
      nc.f.end = null;
      return finish(out(nc, ["MOVE_OCCLUDED"]));
    }
  }
  if (md.faceMove) {
    const rel = run(md, subject, false, false, true);
    if (rel && rel !== "NOWALK") {
      rel.f.end = null;
      return finish(out(rel, [md.moving ? "MOVE_STATIC" : "MOVE_FACE_FALLBACK"]));
    }
  }
  // the face cannot be kept: a wide on the room (face rule first, then without it)
  const roomish = openSubject({ room: true }, ctx);
  const wide = run(MOVES.wide, roomish, true, false, true) ?? run(MOVES.wide, roomish, false, true, true);
  if (wide && wide !== "NOWALK") {
    wide.f.end = null;
    // "wide": the frame is the room's, not the atom's; the director labels and judges it as a wide
    return finish(out(wide, ["MOVE_FACE_FALLBACK wide"]));
  }
  // nothing passes: clamp the wanted point, else the room centre
  const g = geoOf(md.defaults, md.faceMove, subject, ctx, false);
  const gg = g === "NOWALK" ? (geoOf(MOVES.wide.defaults, false, { room: true }, ctx, false) as Geo) : g;
  const spec = g === "NOWALK" ? MOVES.wide.defaults : md.defaults;
  const e: Env = { ctx, spec, g: gg, floorY, lo, hi, strictFace: false, noFace: true, useClear: false };
  const want = build(e, 0, 1, 1).from;
  const law: CameraLaw = { outline: ctx.room.outline, rect: roomRect(ctx.room.outline), height: topOf(ctx.room), floorY, side: ctx.side };
  const cl = legalCameraPoint(want.pos, law);
  const okc = (ctx.room.outline.length < 3 || insideInset(ctx.room.outline, [cl[0], cl[2]], 0.3 - 1e-6)) && (!ctx.side || sideOf(ctx.side, cl[0], cl[2]) > 1e-6);
  if (okc) return finish(out({ f: { from: { ...want, pos: cl }, end: null, shrunk: false, staticFallback: false }, g: gg, spec }, ["MOVE_CLAMPED"]));
  const xs = ctx.room.outline.map((p) => p[0]);
  const zs = ctx.room.outline.map((p) => p[1]);
  const centre: V3 = [(Math.min(...xs) + Math.max(...xs)) / 2, clampN(floorY + 1.2, lo, Math.max(lo, hi)), (Math.min(...zs) + Math.max(...zs)) / 2];
  const from: ShotPoint = ctx.prev ?? { pos: centre, look: gg.lookActor ? { actor: gg.lookActor, bone: "head", o: [0, 0, 0] } : gg.aim(0), fov: ctx.fov };
  warnings.push("MOVE_NO_LEGAL_POINT");
  return finish({ from, end: null, ease: spec.ease, shake: spec.shake, warnings });
}

// ---- schemes ----
export interface SchemeBeat {
  i: number;
  kind: "line" | "narrator" | "walk";
  speaker?: string;
  listener?: string;
  about?: string;
  actors: string[];
  durationS: number;
  tags: { first?: boolean; enter?: boolean; look?: boolean; last?: boolean };
}
export interface SchemePlan {
  beat: number;
  move: string;
  subject: MoveSubject;
  at: string;
  to: string;
  resolved: Resolved;
}

/** A scheme is a rule that picks an atom per beat; `planScheme` lays it over a list of beats. Alone-in-frame becomes `close`, nobody becomes `wide`. */
export function planScheme(id: string, beats: SchemeBeat[], ctx: Ctx): SchemePlan[] {
  if (!Object.hasOwn(SCHEMES, id)) throw new Error(`MOVE_UNKNOWN ${id}`);
  const plans: SchemePlan[] = [];
  const names = (b: SchemeBeat): string[] => b.actors.filter((n) => ctx.actors.some((a) => a.name === n));
  const pick = (b: SchemeBeat): MoveSubject | null => {
    const n = names(b);
    const sp = b.speaker && n.includes(b.speaker) ? b.speaker : (b.about && n.includes(b.about) ? b.about : n[0]);
    return sp ? { actor: sp } : null;
  };
  const push = (b: SchemeBeat, move: string, subject: MoveSubject, to: string, c: Ctx = ctx): SchemePlan => {
    const p: SchemePlan = { beat: b.i, move, subject, at: `B${b.i}`, to, resolved: resolveMove(move, subject, { ...c, speaker: b.speaker, durationS: b.durationS }) };
    plans.push(p);
    return p;
  };
  const e = (b: SchemeBeat): string => `B${b.i}e`;
  const pairOf = (b: SchemeBeat): [string, string] | null => {
    const n = names(b);
    return n.length >= 2 ? [n[0], n[1]] : null;
  };
  const single = (b: SchemeBeat, move: string): void => {
    const s = pick(b);
    if (!s) {
      push(b, "wide", { room: true }, e(b));
      return;
    }
    push(b, move === "ots" || move === "two" ? "close" : move, s, e(b));
  };
  if (id === "over_the_shoulder") {
    for (const b of beats) {
      const pr = pairOf(b);
      if (pr) push(b, "ots", { pair: pr }, e(b));
      else single(b, "close");
    }
  } else if (id === "reaction_cut") {
    for (const b of beats) {
      const n = names(b);
      const l = b.listener && n.includes(b.listener) ? b.listener : n.find((x) => x !== b.speaker);
      if (l) push(b, "close_reaction", { actor: l }, e(b));
      else single(b, "close");
    }
  } else if (id === "establishing") {
    if (beats[0]) push(beats[0], "master", { room: true }, e(beats[0]));
  } else if (id === "open_from_light") {
    const b0 = beats[0];
    if (b0) {
      push(b0, "master", { room: true }, e(b0));
      const hb = beats[1] ?? b0;
      const s = pick(hb);
      if (s) plans.push({ ...push(hb, "medium", s, e(hb)), at: hb === b0 ? e(b0) : `B${hb.i}` }), plans.splice(plans.length - 2, 1);
    }
  } else if (id === "return_wide") {
    const b = beats[beats.length - 1];
    if (b) push(b, "wide", { room: true }, e(b));
  } else if (id === "final_pull_out") {
    const b = beats[beats.length - 1];
    const s = b ? pick(b) : null;
    if (b) {
      if (s) push(b, "pull_out", s, e(b));
      else push(b, "wide", { room: true }, e(b));
    }
  } else if (id === "rhythm_cut") {
    for (const b of beats) single(b, b.durationS < 3 ? "close" : "medium");
  } else if (id === "oner") {
    const chain = ["push_in", "truck", "pull_out", "arc", "drift"];
    let prevShot: ShotPoint | null = null;
    let prevI = -2;
    let k = 0;
    const lookWOf = (s: ShotPoint): V3 => {
      const l = s.look as ShotLook;
      if (Array.isArray(l)) return [l[0], l[1], l[2]];
      const a = ctx.actors.find((x) => x.name === (l as { actor: string }).actor);
      const o = (l as { o: V3 }).o ?? [0, 0, 0];
      const h = a ? headOf(a, ctx.room.floorY ?? 0) : [0, 0, 0];
      return [h[0] + o[0], h[1] + o[1], h[2] + o[2]];
    };
    for (let n = 0; n < beats.length; n++) {
      const b = beats[n];
      const s = pick(b);
      if (!s) {
        push(b, "wide", { room: true }, e(b));
        k = 0;
        prevShot = null;
        prevI = b.i;
        continue;
      }
      const cont = prevShot !== null && b.i === prevI + 1;
      if (!cont) k = 0;
      const move = chain[k++ % chain.length];
      const nextB = beats[n + 1];
      const to = nextB && nextB.i === b.i + 1 && pick(nextB) ? `B${nextB.i}` : e(b);
      const p = push(b, move, s, to, { ...ctx, prev: cont ? plans[plans.length - 1]?.resolved.end ?? plans[plans.length - 1]?.resolved.from : undefined });
      if (cont && prevShot) {
        const r = p.resolved;
        const lk = prevShot.look as ShotLook;
        r.from = { pos: [...prevShot.pos] as V3, look: (Array.isArray(lk) ? [...lk] as unknown as ShotLook : { ...(lk as object) }) as ShotLook, fov: prevShot.fov };
        if (r.end) {
          const floorY = ctx.room.floorY ?? 0;
          const env: Env = { ctx, spec: MOVES[move].defaults, g: { kind: "room", aim: () => [0, 0, 0], base: 0, hBase: 0, dAdd: 0, frame: () => [], limit: () => 100, lying: [], lookActor: null, noFace: true }, floorY, lo: floorY + 0.3, hi: topOf(ctx.room) - 0.3, strictFace: false, noFace: true, useClear: false };
          const a: Pt = { pos: r.from.pos, fov: r.from.fov ?? ctx.fov, o: [0, 0, 0], lookW: lookWOf(r.from) };
          const b2: Pt = { pos: r.end.pos, fov: r.end.fov ?? ctx.fov, o: [0, 0, 0], lookW: lookWOf(r.end) };
          if (!pathOk(env, a, b2)) r.end = null;
        }
      }
      const r = p.resolved;
      const last = r.end ?? r.from;
      prevShot = { pos: [...last.pos] as V3, look: (Array.isArray(last.look) ? [...(last.look as unknown as V3)] as unknown as ShotLook : { ...((last.look as unknown) as object) }) as ShotLook, fov: last.fov };
      prevI = b.i;
    }
  }
  return plans;
}
