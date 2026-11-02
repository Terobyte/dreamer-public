import type { NavRamp } from "../../nav/floor.js";
import { findStageRoute, type StageLevel } from "./path.js";
import { releaseClaim, resolveTouch, type Claims, type Place, type V2 } from "./places.js";

export interface TouchActor {
  pos(): V2;
  /** feet height right now: tells the level the actor really stands on */
  y(): number;
  go(path: V2[], yaw: number, act: "idle" | "sit", ys?: number[]): void;
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
  const pending = new Map<string, string>();
  const levelOf = (who: string): string | null => {
    const a = c.actor(who);
    if (!a) return null;
    const l = c.levels.find((q) => Math.abs(q.y - a.y()) < EPS_Y);
    return l ? String((l.layer as { level?: unknown }).level ?? "") : null;
  };

  const touch = (who: string, name: string, pose?: string, finishYaw?: number): TouchResult => {
    const a = c.actor(who);
    if (!a) {
      console.warn(`stage: touch by "${who}", who is not in the cast`);
      return "no_actor";
    }
    const from = levelOf(who);
    if (from === null) {
      pending.set(who, name);
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
    const route = findStageRoute(c.levels, c.ramps, a.pos(), from, r.target, to, {
      obstacles: c.places.map((p) => ({ level: p.level, rect: p.obstacle })),
      openCells,
    });
    if (!route) {
      // unreachable: stay, never walk through a wall or a shut door, and drop the booking (F6)
      releaseClaim(c.claims, before);
      return "unreachable";
    }
    for (const k of Object.keys(c.claims)) if (c.claims[k] === who && k !== (r.claim ?? r.place.name)) delete c.claims[k];
    a.go(route.path, finishYaw !== undefined ? finishYaw : r.yaw, r.act, route.ys);
    return "walk";
  };

  /** replays touches that waited for the actor to step off a ramp */
  const tick = (): TouchResult[] => {
    const out: TouchResult[] = [];
    for (const [who, name] of [...pending]) if (levelOf(who) !== null) out.push(touch(who, name));
    return out;
  };

  return { touch, tick, levelOf };
}
