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
}

export type Claims = Record<string, string>;

export interface Walk {
  place: Place;
  target: V2;
  yaw: number;
  act: "sit" | "idle";
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
}): Walk | Skip {
  const place = a.places.find((p) => norm(p.name) === norm(a.name));
  if (!place) {
    console.warn(`stage: touch "${a.name}" is not a place of this scene`);
    return { skip: "unknown" };
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
    return { place, target: place.at, yaw: faceYaw(place.at), act };
  }
  // taken by someone else: stand beside it, on the side nearer to the actor; the claim stays
  const r = (place.yaw * Math.PI) / 180;
  const px = Math.cos(r);
  const pz = -Math.sin(r);
  const side = (s: number): V2 => [place.at[0] + s * SIDE_M * px, place.at[1] + s * SIDE_M * pz];
  const d = (p: V2): number => Math.hypot(p[0] - a.actor.at[0], p[1] - a.actor.at[1]);
  const [l, rr] = [side(1), side(-1)];
  const target = d(l) <= d(rr) ? l : rr;
  return { place, target, yaw: place.kind === "sit" ? place.yaw : faceYaw(target), act: "idle" };
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
