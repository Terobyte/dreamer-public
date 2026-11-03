/** Place bank of a stage (`stage/places.json`) and the two pure rules that put actors on it. */
import { pointInPoly } from "../../nav/floor.js";
export type V2 = [number, number];

export interface Place {
  name: string;
  id: string;
  kind: string; // sit | stand | door
  room: string;
  level: string | null;
  at: V2;
  /** degrees, 0 = +Z, 90 = +X */
  yaw: number;
  look: V2 | null;
  /** [minx, minz, maxx, maxz] */
  obstacle: number[] | null;
  size?: { w: number; d: number; h: number };
  /** lie | sit | stand_on | stand_at | door */
  poses?: string[];
  top?: number;
  slots?: Record<string, number>;
  /** per-pose spot: lie = centre of the top, yaw along the long side, head point; stand_on = centre of the top */
  lie?: { at: V2; yaw: number; head: V2 };
  stand_on?: { at: V2 };
  /** the seat itself (make/stage.py): `at` is the nav cell one walks to, the last step lands on the seat — a chair
   *  in the table's block of the nav had its sit point 0.65 m off the seat (Squidward, Nov 3) */
  seat?: { at: V2 };
  /** a door that leads elsewhere: the place (a door or a spot) one comes out at, San Andreas style (stage exitBy) */
  to?: string;
}

/** a sleeper lies in the bed, not on the blanket: the body sinks this far below the top (Koshakan, Nov 2) */
export const BED_TUCK_M = 0.1;

/** how far a body tucked in a bed (BED_TUCK_M under the top) rises when its idle turns to a sitting clip: the
 *  tuck, less the seat's height over the clip's contact. A chair sit stands on its feet; in a bed it sits on its
 *  seat, legs under the blanket (k23_true 46 s: sit_idle's seat 14 cm over the bed) */
export function bedLift(facts: { contact_y?: number; seat_y?: number } | undefined): number {
  const over = facts?.seat_y === undefined ? 0 : Math.max(0, facts.seat_y - (facts.contact_y ?? 0));
  return BED_TUCK_M - over;
}
/** a bed sitter's pelvis is this far in from the long edge */
export const BED_EDGE_IN_M = 0.15;
/** ...and this far from the sleeper's spot toward the foot, so the two bodies do not overlap */
export const BED_SIT_FOOTWARD_M = 0.35;
/** the sitter faces out of the bed (legs hang off it) turned this far toward its head, where the sleeper's face is */
export const BED_SIT_TURN_DEG = 45;
/** the floor point beside the edge she walks to (the nav has no cells under a bed); also the side's "is it free" probe */
const BED_SIDE_FLOOR_M = 0.35;

/**
 * Sitting on a bed (a place with a `lie` spot and a size): on a long edge beside the sleeper, not at `place.at`
 * (that spot is outside the footboard). Sides are ordered free first, then nearer to `from`; `slot` picks one.
 */
export function bedSitSpot(place: Place, from: V2, places: Place[], slot: number): { at: V2; yaw: number; approach: V2 } | null {
  const lie = place.lie;
  if (!lie || !place.size) return null;
  // the long axis is the lie yaw (exact), turned to point at the head
  const r = (lie.yaw * Math.PI) / 180;
  let u: V2 = [Math.sin(r), Math.cos(r)];
  if ((lie.head[0] - lie.at[0]) * u[0] + (lie.head[1] - lie.at[1]) * u[1] < 0) u = [-u[0], -u[1]];
  const p: V2 = [u[1], -u[0]];
  const o = place.obstacle;
  const c: V2 = o && o.length === 4 ? [(o[0]! + o[2]!) / 2, (o[1]! + o[3]!) / 2] : lie.at;
  const halfW = Math.min(place.size.w, place.size.d) / 2;
  const along = (lie.at[0] - c[0]) * u[0] + (lie.at[1] - c[1]) * u[1] - BED_SIT_FOOTWARD_M;
  const pt = (side: number, off: number): V2 => [c[0] + u[0] * along + p[0] * side * off, c[1] + u[1] * along + p[1] * side * off];
  const blocked = (q: V2): boolean =>
    places.some((pl) => pl !== place && pl.obstacle && pl.obstacle.length === 4 &&
      q[0] >= pl.obstacle[0]! && q[0] <= pl.obstacle[2]! && q[1] >= pl.obstacle[1]! && q[1] <= pl.obstacle[3]!);
  const sides = [1, -1]
    .map((s) => ({ s, at: pt(s, halfW - BED_EDGE_IN_M), floor: pt(s, halfW + BED_SIDE_FLOOR_M) }))
    .map((q) => ({ ...q, blocked: blocked(q.floor) }))
    .sort((a, b) => Number(a.blocked) - Number(b.blocked) || Math.hypot(a.at[0] - from[0], a.at[1] - from[1]) - Math.hypot(b.at[0] - from[0], b.at[1] - from[1]));
  const pick = sides[Math.abs(slot) % 2]!;
  const t = (BED_SIT_TURN_DEG * Math.PI) / 180;
  const f: V2 = [p[0] * pick.s * Math.cos(t) + u[0] * Math.sin(t), p[1] * pick.s * Math.cos(t) + u[1] * Math.sin(t)];
  return { at: pick.at, yaw: yawTo([0, 0], f), approach: pick.floor };
}

/**
 * where an actor starts on a place: `lie` = in the bed along the long side, BED_TUCK_M under the top;
 * `sit` on a bed = its edge beside the sleeper (bedSitSpot, `from` picks the side)
 */
export function startSpot(place: Place, pose?: string, from?: V2, places?: Place[]): { at: V2; yaw: number; y: number } {
  if (pose === "lie" && place.lie) return { at: place.lie.at, yaw: place.lie.yaw, y: Math.max(0, (place.top ?? 0) - BED_TUCK_M) };
  if (pose === "sit") {
    const s = bedSitSpot(place, from ?? place.at, places ?? [place], 0);
    if (s) return { at: s.at, yaw: s.yaw, y: 0 };
  }
  // a stand place faces its thing (`look`), as a walk there does (resolveTouch): Squidward started back to his easel
  return { at: place.at, yaw: place.kind !== "sit" && place.look ? yawTo(place.at, place.look) : place.yaw, y: 0 };
}

export type Claims = Record<string, string>;

export interface Walk {
  place: Place;
  target: V2;
  yaw: number;
  act: "sit" | "idle";
  /** pose actually granted (only when one was requested) */
  pose?: string;
  /** where else to stand when `target` has no route (stand_at: the far side, then the place's own spot) */
  alts?: V2[];
  /** claims key this walk booked, if any */
  claim?: string;
  /** the finish yaw is the spot's own (a bed edge): a look target turns the head, not the body */
  keepYaw?: boolean;
  /** walkable floor point the route ends on when `target` is off the nav (a bed edge); the last step goes to `target` */
  approach?: V2;
}
export type Skip = { skip: "unknown" | "already_there" };

export const SIDE_M = 0.8;
const SAME_SPOT_M = 0.05;

const norm = (s: string): string => s.trim().toLowerCase();

/** Yaw (deg) that faces from `from` to `to`. */
export function yawTo(from: V2, to: V2): number {
  return (((Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI) % 360 + 360) % 360;
}

export function resolveTouch(a: {
  places: Place[];
  claims: Claims;
  actor: { who: string; at: V2 };
  name: string;
  clips?: string[];
  pose?: string;
  warnings?: string[];
}): Walk | Skip {
  const place = a.places.find((p) => norm(p.name) === norm(a.name));
  if (!place) {
    console.warn(`stage: touch "${a.name}" is not a place of this scene`);
    return { skip: "unknown" };
  }
  // an empty list is not "anything goes": it counts as ["stand_at"]
  const poses = place.poses && place.poses.length === 0 ? ["stand_at"] : place.poses;
  if (a.pose === "stand_at" || (a.pose === "door" && poses?.includes("door")))
    return { ...beside(place, a.actor.at), pose: a.pose };
  if (a.pose && poses?.includes(a.pose)) {
    const pose = a.pose;
    const n = place.slots?.[pose] ?? 1;
    const keys = Array.from({ length: n }, (_, i) => `${place.name}|${pose}|${i}`);
    if (keys.some((k) => a.claims[k] === a.actor.who)) return { skip: "already_there" };
    const free = keys.find((k) => a.claims[k] === undefined);
    if (free) {
      a.claims[free] = a.actor.who;
      const edge = pose === "sit" ? bedSitSpot(place, a.actor.at, a.places, keys.indexOf(free)) : null;
      if (edge) return { place, target: edge.at, yaw: edge.yaw, act: "sit", pose, claim: free, keepYaw: true, approach: edge.approach };
      const spot = pose === "lie" ? place.lie : pose === "stand_on" ? place.stand_on : undefined;
      const yaw = pose === "lie" && place.lie ? place.lie.yaw : place.yaw;
      if (pose === "sit" && place.seat) return { place, target: place.seat.at, yaw, act: "sit", pose, claim: free, approach: place.at };
      return { place, target: spot?.at ?? place.at, yaw, act: pose === "sit" ? "sit" : "idle", pose, claim: free };
    }
    const taken = `${a.actor.who}: pose "${pose}" of "${place.name}" is taken, stands beside it`;
    a.warnings?.push(taken);
    console.warn(`stage: ${taken}`);
    return { ...beside(place, a.actor.at), pose: "stand_at" };
  }
  if (a.pose && a.pose !== "stand_at") {
    const miss = `${a.actor.who}: "${place.name}" has no pose "${a.pose}", stands beside it`;
    a.warnings?.push(miss);
    console.warn(`stage: ${miss}`);
    return { ...beside(place, a.actor.at), pose: "stand_at" };
  }
  const holder = a.claims[place.name];
  if (holder === a.actor.who) return { skip: "already_there" };
  const act = place.kind === "sit" ? "sit" : "idle";
  const faceYaw = (at: V2): number =>
    place.kind === "sit" || !place.look ? place.yaw : yawTo(at, place.look);
  if (holder === undefined) {
    if (Math.hypot(a.actor.at[0] - place.at[0], a.actor.at[1] - place.at[1]) <= SAME_SPOT_M) {
      a.claims[place.name] = a.actor.who;
      return { skip: "already_there" };
    }
    a.claims[place.name] = a.actor.who;
    if (act === "sit" && place.seat) return { place, target: place.seat.at, yaw: faceYaw(place.at), act, approach: place.at };
    return { place, target: place.at, yaw: faceYaw(place.at), act };
  }
  return beside(place, a.actor.at);
}

/** stand beside the place, on the side nearer to the actor; the claim stays */
function beside(place: Place, from: V2): Walk {
  const faceYaw = (at: V2): number => (place.kind === "sit" || !place.look ? place.yaw : yawTo(at, place.look));
  const r = ((Number.isFinite(place.yaw) ? place.yaw : 0) * Math.PI) / 180;
  const px = Math.cos(r);
  const pz = -Math.sin(r);
  const side = (s: number): V2 => [place.at[0] + s * SIDE_M * px, place.at[1] + s * SIDE_M * pz];
  const d = (p: V2): number => Math.hypot(p[0] - from[0], p[1] - from[1]);
  const [l, rr] = [side(1), side(-1)];
  const [target, far] = d(l) <= d(rr) ? [l, rr] : [rr, l];
  return { place, target, yaw: place.kind === "sit" ? place.yaw : faceYaw(target), act: "idle", alts: [far, place.at] };
}

/**
 * F6: `resolveTouch` books the place before the route is known. When the
 * route misses, the caller drops that booking with the key set snapshotted
 * beforehand — otherwise the retry reports `already_there` and the place
 * keeps looking taken to everyone else. Only added keys are removed; a
 * booking that was already there is never touched.
 */
export function releaseClaim(claims: Claims, before: Set<string>): void {
  for (const k of Object.keys(claims)) if (!before.has(k)) delete claims[k];
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A remark of the narrator -> who goes where. Place names match longest first
 * ("library armchair" before "chair"); a cast member matches by full name or by
 * any name word of 3+ letters ("Mr. Rochester" -> "Edward Rochester").
 */
export function stageRegex(places: Place[], cast: string[] = []): (text: string) => { who: string; place: string } | null {
  const names = [...places].map((p) => p.name).sort((x, y) => y.length - x.length);
  // F22: \b is ASCII-only, so a name starting with É etc. never matches at its
  // own start. Unicode-aware boundaries instead (letters/numbers/underscore).
  const LB = "(?<![\\p{L}\\p{N}_])";
  const RB = "(?![\\p{L}\\p{N}_])";
  const placeRe = names.length ? new RegExp(`${LB}(${names.map(escape).join("|")})${RB}`, "iu") : null;
  const whoRes = cast.map((who) => {
    const words = who.split(/\s+/).filter((w) => w.length >= 3 && !/^(mr|mrs|miss)\.?$/i.test(w));
    return { who, re: new RegExp(`${LB}(${[who, ...words].map(escape).join("|")})${RB}`, "iu") };
  });
  return (text: string) => {
    if (!placeRe) return null;
    const pm = placeRe.exec(text);
    if (!pm) return null;
    const hit = whoRes.find((w) => w.re.test(text));
    if (!hit) return null;
    const place = places.find((p) => norm(p.name) === norm(pm[1]))!;
    return { who: hit.who, place: place.name };
  };
}

export interface FloorRef {
  room: string;
  level?: string | null;
  outline: V2[];
}

/**
 * The floor under `p`: the actor's own level first, then any. The outline itself
 * decides (an L-room's bbox covers the room in its notch); the bbox is only the
 * fallback for a point right on a wall line.
 */
export function floorAt(floors: FloorRef[], p: V2, level?: string | null): FloorRef | null {
  const inBox = (f: FloorRef): boolean => {
    const xs = f.outline.map((q) => q[0]);
    const zs = f.outline.map((q) => q[1]);
    return p[0] >= Math.min(...xs) && p[0] <= Math.max(...xs) && p[1] >= Math.min(...zs) && p[1] <= Math.max(...zs);
  };
  const inPoly = (f: FloorRef): boolean => pointInPoly(p, f.outline);
  const own = level !== undefined && level !== null ? floors.filter((f) => (f.level ?? null) === level) : [];
  return own.find(inPoly) ?? floors.find(inPoly) ?? own.find(inBox) ?? floors.find(inBox) ?? null;
}

/** How far a lying actor slides toward the foot of the bed so the pillow is under her head, not around it: the
 *  smallest shift (3 cm steps, at most `max`) where the furniture under the head bone rises no more than 3 cm over
 *  `base`, the top under her body (the mattress). 0 = the head is already clear. Measured against the mattress, not
 *  the head bone: a body tucked under the blanket has its head bone below the mattress top (k20_true slid the cap).
 *  k19_true: Mirai's head inside a 0.75 m pillow on a 0.57 m mattress. */
export function pillowShift(head: [number, number, number], foot: V2, heightAt: (x: number, z: number, below?: number) => number | null, base: number, r: number, max = 0.4): number {
  // the head centre and the back of the head (`r` toward the pillow; k21_dbg: the centre cleared, the back did not)
  const clear = (s: number): boolean => [s, s - r].every((d) => {
    const h = heightAt(head[0] + foot[0] * d, head[2] + foot[1] * d, base + 0.6);
    return h === null || h <= base + 0.03;
  });
  for (let s = 0; s < max; s += 0.03) if (clear(s)) return Math.round(s * 1000) / 1000;
  return max;
}

/** where a walker stops to reach another actor (a hug, a lap, sitting by her): `gap` short of the target, on the
 *  walker's side; the same spot -> a fixed side (+X). Koshakan meadow, Nov 3: "Mirai climbed into Mama's lap" */
export function nearActor(from: V2, target: V2, gap: number): V2 {
  const dx = from[0] - target[0];
  const dz = from[1] - target[1];
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return [target[0] + gap, target[1]];
  return [target[0] + (dx / d) * gap, target[1] + (dz / d) * gap];
}

/** a hug: where the mover stands so the two capsules touch, chest to chest; null when they already do not overlap
 *  (Koshakan meadow, Nov 3: Mirai hugged Mama from 0.12 m, the lap spot, her body inside Mama's knees) */
export function hugSpot(mover: V2, anchor: V2, rMover: number, rAnchor: number): V2 | null {
  const d = rMover + rAnchor;
  return Math.hypot(mover[0] - anchor[0], mover[1] - anchor[1]) < d - 1e-3 ? nearActor(mover, anchor, d) : null;
}

/** how far short of another actor a walker stops (nearActor's `gap`): into a lap close in (0.12 m), otherwise the two
 *  capsules touch plus 5 cm (bathroom, Nov 3: a fixed 0.5 m put Mama inside Mirai's capsule, 74 overlap frames) */
export function approachGap(clips: Array<string | undefined>, rWalker: number, rOther: number): number {
  return clips.some((c) => !!c && /lap/i.test(c)) ? 0.12 : rWalker + rOther + 0.05;
}
