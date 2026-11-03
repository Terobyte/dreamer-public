import type { NavRamp } from "../../nav/floor.js";
import { findStageRoute, type StageLevel } from "./path.js";
import { releaseClaim, resolveTouch, yawTo, type Claims, type Place, type V2 } from "./places.js";

export interface TouchActor {
  pos(): V2;
  /** feet height right now: tells the level the actor really stands on */
  y(): number;
  /** `seat` = the place's `top` when `act` is "sit" (L154: the pelvis lands on it) */
  go(path: V2[], yaw: number, act: "idle" | "sit", ys?: number[], seat?: number): void;
}

export interface ToucherCtx {
  places: Place[];
  claims: Claims;
  levels: StageLevel[];
  ramps: NavRamp[];
  /** nav.json `doors`: cell indices are local to the door's layer */
  doors: Record<string, { level?: string; cells: number[] }>;
  doorOpen(id: string): boolean;
  actor(who: string): TouchActor | undefined;
  /** collects pose-fallback warnings (Stage.warnings) */
  warnings?: string[];
}

export type TouchResult = "walk" | "skip" | "unreachable" | "queued" | "no_actor";

const EPS_Y = 1e-3;

/**
 * The stage's `touch`: book the place, route there over the nav levels and walk.
 * - the start level is the one the actor stands on now (by feet height), never the
 *   level of its last goal; on a ramp (no level) the touch waits for `tick` (F30);
 * - doors and obstacles count only on their own level (F25/F32);
 * - a missed route drops the booking it made (F6), a walk frees the places the actor leaves (F33).
 */
export function createToucher(c: ToucherCtx) {
  const pending = new Map<string, { name: string; pose?: string; finishYaw?: number | "along" }>();
  const levelOf = (who: string): string | null => {
    const a = c.actor(who);
    if (!a) return null;
    const l = c.levels.find((q) => Math.abs(q.y - a.y()) < EPS_Y);
    return l ? String((l.layer as { level?: unknown }).level ?? "") : null;
  };

  const touch = (who: string, name: string, pose?: string, finishYaw?: number | "along"): TouchResult => {
    const a = c.actor(who);
    if (!a) {
      console.warn(`stage: touch by "${who}", who is not in the cast`);
      return "no_actor";
    }
    const from = levelOf(who);
    if (from === null) {
      pending.set(who, { name, pose, finishYaw });
      return "queued";
    }
    pending.delete(who);
    const before = new Set(Object.keys(c.claims));
    const r = resolveTouch({ places: c.places, claims: c.claims, actor: { who, at: a.pos() }, name, clips: [], pose, warnings: c.warnings });
    if ("skip" in r) return "skip";
    const to = r.place.level ?? from;
    const openCells: Record<string, number[]> = {};
    for (const [id, d] of Object.entries(c.doors)) {
      if (!c.doorOpen(id)) continue;
      const lvl = d.level ?? from;
      (openCells[lvl] ??= []).push(...d.cells);
    }
    const route = findStageRoute(c.levels, c.ramps, a.pos(), from, r.approach ?? r.target, to, {
      obstacles: c.places.map((p) => ({ level: p.level, rect: p.obstacle })),
      openCells,
    });
    if (!route) {
      // unreachable: stay, never walk through a wall or a shut door, and drop the booking (F6)
      releaseClaim(c.claims, before);
      return "unreachable";
    }
    for (const k of Object.keys(c.claims)) if (c.claims[k] === who && k !== (r.claim ?? r.place.name)) delete c.claims[k];
    // a bed edge is off the nav: the route ends on the floor beside it, one more step onto the seat
    if (r.approach) {
      route.path.push(r.target);
      if (route.ys && route.ys.length) route.ys.push(route.ys[route.ys.length - 1]!);
    }
    // "along": face the way the last leg of the route points (a goto with no look target)
    const along = (): number => {
      const n = route.path.length;
      return n >= 2 ? yawTo(route.path[n - 2]!, route.path[n - 1]!) : r.yaw;
    };
    // B53: a place without a yaw ends facing along the walk (or as the actor stands), never NaN
    const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    // "along" is for a place with no facing of its own: one with a thing to face (its look, its yaw) ends facing
    // it (Squidward, Nov 3: SpongeBob at the easel faced the wall the last step pointed to, not the picture)
    const asked = r.keepYaw ? r.yaw : finishYaw === "along" ? (finite(r.yaw) ? r.yaw : along()) : finishYaw;
    const fallback = finite(r.yaw) ? r.yaw : route.path.length >= 2 ? along() : a.yaw();
    const fin = finite(asked) ? asked : finite(fallback) ? fallback : a.yaw();
    a.go(route.path, fin, r.act, route.ys, r.act === "sit" ? r.place.top : undefined);
    return "walk";
  };

  /** replays touches that waited for the actor to step off a ramp */
  const tick = (): TouchResult[] => {
    const out: TouchResult[] = [];
    for (const [who, q] of [...pending]) if (levelOf(who) !== null) out.push(touch(who, q.name, q.pose, q.finishYaw));
    return out;
  };

  /** drop a touch that waits on a ramp: a newer order for the actor replaces it (B66) */
  const cancel = (who: string): void => void pending.delete(who);

  /** the step in through a door: a route from the door to the farthest point along `yaw` (at most `max` m, 0.1 m
   *  steps down to 0.2 m) whose cell one can walk on; null = not even 0.2 m in. Squidward, Nov 3: the fixed 1 m
   *  step landed inside the table's block of the nav, and from there no route led anywhere. */
  const stepIn = (doorAt: V2, yaw: number, level: string | null, max = 1.0): V2[] | null => {
    const lvl = level ?? String((c.levels[0]?.layer as { level?: unknown } | undefined)?.level ?? "");
    const openCells: Record<string, number[]> = {};
    for (const [id, d] of Object.entries(c.doors)) if (c.doorOpen(id)) (openCells[d.level ?? lvl] ??= []).push(...d.cells);
    const obstacles = c.places.map((p) => ({ level: p.level, rect: p.obstacle }));
    const r = (yaw * Math.PI) / 180;
    for (let d = max; d >= 0.2 - 1e-9; d -= 0.1) {
      const to: V2 = [doorAt[0] + Math.sin(r) * d, doorAt[1] + Math.cos(r) * d];
      const route = findStageRoute(c.levels, c.ramps, doorAt, lvl, to, lvl, { obstacles, openCells });
      if (route) return [...route.path, to];  // the route ends on the goal cell's centre; the point is in that cell
    }
    return null;
  };

  return { touch, tick, levelOf, cancel, stepIn };
}
