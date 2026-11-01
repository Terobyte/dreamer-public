import { clampCamera, INSET, insideInset, roomRect, snapInside, type V3 } from "./camera.js";
import type { V2 } from "./places.js";

/** Pure camera director (A3a): which plan, and when. Where exactly the camera stands is kept simple here (A3b refines it). */
export const BANK = ["ots", "close", "two", "wide", "orbit", "dolly", "low", "follow"] as const;
export type Plan = (typeof BANK)[number];

export interface DActor {
  name: string;
  pos: V2;
  yaw: number;
  height: number;
  level: string | null;
  room: string | null;
  walking: boolean;
}
export interface DEvent {
  kind: "line" | "narrator" | "walk" | "tick";
  speaker?: string;
  durationS?: number;
  shot?: string;
  /** narrator: the actor the text names (a close in a narration run frames them) */
  about?: string;
  dt: number;
}
export interface DRoom {
  outline: V2[];
  ceiling: number;
  open: boolean;
  /** height of the floor the room stands on (default 0) */
  floorY?: number;
}
export interface DirectorInput {
  event: DEvent;
  actors: DActor[];
  room: DRoom;
  rng?: () => number;
  /** vertical FOV in degrees and aspect of the real camera (default 50, 16:9) */
  fov?: number;
  aspect?: number;
  /** true when nothing stands between the camera and the look point (the runtime raycasts the world).
   *  Without it the director is pure and blind to furniture (Koshakan: a close behind the bed's footboard). */
  clear?: (cam: V3, look: V3) => boolean;
}
export interface DirectorOut {
  plan: string;
  cam: V3;
  look: V3;
  /** increments on every cut (new line, walk change, reaction); index.ts jumps when it changes */
  cut: number;
}

const DEG = Math.PI / 180;
const OPEN_CEILING = 3.5;
const REACT_AT = 0.45;
const BACK_AT = 0.75;
const LONG_LINE = 7;

const dist = (a: V2, b: V2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const norm = (v: V2, fallback: V2 = [0, 1]): V2 => {
  const l = Math.hypot(v[0], v[1]);
  return l < 1e-9 ? fallback : [v[0] / l, v[1] / l];
};
const faceOf = (yaw: number): V2 => [Math.sin(yaw * DEG), Math.cos(yaw * DEG)];
const rotate = (v: V2, deg: number): V2 => [v[0] * Math.cos(deg * DEG) - v[1] * Math.sin(deg * DEG), v[0] * Math.sin(deg * DEG) + v[1] * Math.cos(deg * DEG)];
const angleBetween = (a: V2, b: V2): number => Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) / DEG;
const signedAngle = (a: V2, b: V2): number => Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) / DEG;
const byName = (a: DActor, b: DActor): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Start yaw (degrees, 0..360) for every actor: facing the nearest other one; a lone actor faces the first camera. */
export function initialYaws(positions: V2[], firstCamera: V3): number[] {
  const yawTo = (from: V2, to: V2): number => {
    const d = (Math.atan2(to[0] - from[0], to[1] - from[1]) / DEG) % 360;
    return d < 0 ? d + 360 : d;
  };
  if (positions.length === 1) return [yawTo(positions[0], [firstCamera[0], firstCamera[2]])];
  return positions.map((p, i) => {
    let best = -1;
    let bd = Infinity;
    positions.forEach((q, j) => {
      const d = j === i ? Infinity : dist(p, q);
      if (d < bd) {
        bd = d;
        best = j;
      }
    });
    return best < 0 ? 0 : yawTo(p, positions[best]);
  });
}

/** One smoothing step from `prev` toward `target` (k in 0..1); the blend is kept inside the room outline with the
 * 0.3 m inset (F5: in an L room the straight path between two inside frames can cross the notch or hug an edge). */
export function smoothCam(prev: V3, target: V3, k: number, outline: V2[]): V3 {
  const p: V3 = [prev[0] + (target[0] - prev[0]) * k, prev[1] + (target[1] - prev[1]) * k, prev[2] + (target[2] - prev[2]) * k];
  if (outline.length < 3 || insideInset(outline, [p[0], p[2]])) return p;
  const r = roomRect(outline);
  const s = snapInside(outline, [p[0], p[2]], r);
  if (insideInset(outline, s)) return [s[0], p[1], s[1]];
  if (insideInset(outline, [target[0], target[2]])) return [target[0], p[1], target[2]];
  if (insideInset(outline, [prev[0], prev[2]])) return [prev[0], p[1], prev[2]];
  return p;
}

/** Ordered queue for line/narrator events (F5): two handlers before one update must both reach the director. */
export function createPendingQueue() {
  const q: DEvent[] = [];
  return {
    push(ev: DEvent): void {
      q.push(ev);
    },
    takeAll(): DEvent[] {
      const all = [...q];
      q.length = 0;
      return all;
    },
  };
}

/** Fallback frame when no snapped point is inside: from the pair midpoint toward the room center in 0.25 m steps (up to 40),
 * the first point inside the outline with `inset`; none (room narrower than 2*inset) -> the room center. Never throws. */
export function fallbackFrame(mid: V2, center: V2, outline: V2[], inset: number, eye: number): V3 {
  const dx = center[0] - mid[0];
  const dz = center[1] - mid[1];
  const L = Math.hypot(dx, dz);
  const ux = L < 1e-9 ? 0 : dx / L;
  const uz = L < 1e-9 ? 0 : dz / L;
  let plain: V2 | null = insideInset(outline, mid, 0) ? mid : null;
  for (let i = 0; i <= 40; i++) {
    const pt: V2 = [mid[0] + ux * 0.25 * i, mid[1] + uz * 0.25 * i];
    if (insideInset(outline, pt, inset)) return [pt[0], eye, pt[1]];
    if (!plain && insideInset(outline, pt, 0)) plain = pt;
  }
  // no point with the inset: the room center; a concave room whose center is outside takes the nearest inside point
  const fb = insideInset(outline, center, 0) ? center : (plain ?? snapInside(outline, mid, roomRect(outline, 0), 0));
  return [fb[0], eye, fb[1]];
}

export type SnapFn = (outline: V2[], p: V2, r: ReturnType<typeof roomRect>, inset?: number) => V2;

export function createDirector(defaultRng: () => number, opts: { snap?: SnapFn } = {}) {
  const snap: SnapFn = opts.snap ?? snapInside;
  let clock = 0;
  let count = 0;
  let plan: Plan | null = null;
  let lastPlan: Plan | null = null;
  let planStart = 0;
  let cutSeq = 0;
  let subjectIsListener = false;
  let walkSig = "";
  // F1: the room the frame is built in; crossing into another room/level is a cut, never a smooth glide through the wall
  let roomKey: string | null = null;
  let focus: string | null = null;
  let pending: Array<{ at: number; plan: Plan; listener: boolean }> = [];
  // persistent 180° side (F7): reselected only when the pair axis turns by more than 90°
  const st: { side: 1 | -1 | null; axis: V2 | null } = { side: null, axis: null };

  const step = (inp: DirectorInput): DirectorOut => {
    const rng = inp.rng ?? defaultRng;
    const ev = inp.event;
    const all = [...inp.actors].sort(byName);
    if (!all.length) {
      const floorY = inp.room.floorY ?? 0;
      const height = inp.room.open ? floorY + OPEN_CEILING : inp.room.ceiling;
      // F11: never above the ceiling — a 0.4 m room gets a 0.1 m eye, not the 0.5 m floor
      const top = height - 0.3 - floorY;
      const eye = Math.min(floorY + Math.min(1.5, Math.max(0.05, top)), height);
      const lookY = Math.min(floorY + Math.min(1, Math.max(0.05, top)), height);
      const c = roomCenter(inp.room.outline);
      let xz: V2 = c;
      if (inp.room.outline.length >= 3) {
        const s = snap(inp.room.outline, c, roomRect(inp.room.outline));
        if (insideInset(inp.room.outline, s)) xz = s;
        else {
          // no inset point (room narrower than 0.6 m): any inside point, still within the ceiling (F6)
          const s0 = snap(inp.room.outline, c, roomRect(inp.room.outline, 0), 0);
          if (insideInset(inp.room.outline, s0, 0)) xz = s0;
          else {
            const fb = snapInside(inp.room.outline, c, roomRect(inp.room.outline, 0), 0);
            if (insideInset(inp.room.outline, fb, 0)) xz = fb;
          }
        }
      }
      return { plan: plan ?? "wide", cam: [xz[0], eye, xz[1]], look: [xz[0], lookY, xz[1]], cut: cutSeq };
    }
    const named = ev.kind === "line" ? all.find((a) => a.name === ev.speaker) : undefined;
    // narrator always pivots on the first actor by name, never on the stored focus (F1)
    const pivot = ev.kind === "narrator" ? (all.find((a) => a.name === ev.about) ?? all[0]) : (named ?? all.find((a) => a.name === focus) ?? all[0]);
    // the room of the speaker (narrator: of the first actor); other rooms/levels are not in the frame
    const crew = all.filter((a) => a.room === pivot.room && a.level === pivot.level);
    const speaker = crew.find((a) => a.name === pivot.name) ?? crew[0];
    const listener = ev.kind === "narrator" ? undefined : nearestOther(crew, speaker);
    // F6: narrator has no reaction listener, but a `two` still frames the speaker pair
    const frameOther = listener ?? (ev.kind === "narrator" ? nearestOther(crew, speaker) : undefined);
    const walkers = crew.filter((a) => a.walking);
    const sig = walkers.map((a) => a.name).join(",");
    clock += ev.dt;

    const choose = (): Plan => {
      if (ev.shot && (BANK as readonly string[]).includes(ev.shot)) return ev.shot as Plan;
      if (walkers.length === 1) return "follow";
      if (walkers.length > 1) return "wide";
      if (count === 1) return "wide";
      if (ev.kind === "narrator") {
        if (crew.length < 2 || maxSpan(crew) > 4) return "wide";
        // a picture book is mostly narration: two, then a close/dolly/orbit, then two again (Koshakan)
        if (lastPlan !== "two") return "two";
        const np: Plan[] = ["close", "dolly", "orbit"];
        return np[Math.floor(rng() * np.length) % np.length];
      }
      let pool: Plan[];
      // F15: rule 5 without a listener = its pool cut to the lone-actor plans (two/orbit/wide ∩ wide/close/follow)
      if (count % 5 === 0) pool = listener ? ["two", "orbit", "wide"] : ["wide"];
      else if (!listener) pool = ["wide", "close", "follow"];
      else pool = BANK.filter((p) => p !== "low" || speaker.height > listener.height);
      // nobody walks: "follow" would film the back of the speaker's head and the floor ahead (Koshakan)
      pool = pool.filter((p) => p !== "follow");
      let i = Math.floor(rng() * pool.length) % pool.length;
      if (pool[i] === lastPlan) i = (i + 1) % pool.length;
      return pool[i];
    };

    const cut = (p: Plan, asListener = false): void => {
      plan = p;
      planStart = clock;
      subjectIsListener = asListener;
      cutSeq++;
    };

    if (ev.kind === "line" || ev.kind === "narrator") {
      count++;
      pending = [];
      const p = choose();
      lastPlan = p;
      cut(p);
      focus = ev.kind === "line" ? speaker.name : focus;
      const dur = ev.durationS ?? 0;
      if (ev.kind === "line" && listener && dur > LONG_LINE && p !== "orbit" && p !== "dolly") {
        pending = [
          { at: clock + dur * REACT_AT, plan: "close", listener: true },
          { at: clock + dur * BACK_AT, plan: "ots", listener: false },
        ];
      }
    } else {
      if (plan === null) cut("wide");
      if (sig !== walkSig) {
        pending = [];
        const p: Plan = walkers.length === 1 ? "follow" : "wide";
        lastPlan = p;
        cut(p);
      }
      while (pending.length && pending[0].at <= clock) {
        const r = pending.shift()!;
        cut(r.plan, r.listener);
      }
    }
    walkSig = sig;
    const key = `${speaker.level ?? ""}|${speaker.room ?? ""}`;
    if (roomKey !== null && key !== roomKey && ev.kind !== "line" && ev.kind !== "narrator") cutSeq++;
    roomKey = key;

    const out0 = frame(plan ?? "wide", subjectIsListener && listener ? listener : speaker, subjectIsListener && listener ? speaker : frameOther, crew, walkers, inp, clock - planStart, clock, cutSeq, st, snap, speaker);
    const out = unblock(out0, inp, snap);
    // F12: a coerced plan (low -> close, ots -> close, two -> wide) is what the viewer saw: repeats compare to it
    if (ev.kind === "line" || ev.kind === "narrator") lastPlan = out.plan as Plan;
    return out;
  };

  return { step };
}

/** A blocked frame turns about its look point (smallest turn first, so the 180° side mostly holds), rises, and
 *  moves in or out, until the probe sees the subject; no clear spot in the room -> the original frame. */
function unblock(out: DirectorOut, inp: DirectorInput, snap: SnapFn): DirectorOut {
  const clear = inp.clear;
  if (!clear || clear(out.cam, out.look)) return out;
  const room = inp.room;
  const floorY = room.floorY ?? 0;
  const height = room.open ? floorY + OPEN_CEILING : room.ceiling;
  const rect = roomRect(room.outline);
  const L = out.look;
  const v: V2 = [out.cam[0] - L[0], out.cam[2] - L[2]];
  const r0 = Math.max(0.6, Math.hypot(v[0], v[1]));
  const d0 = norm(v);
  for (const a of [0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 120, -120])
    for (const dy of [0, 0.35, 0.7, 1.1])
      for (const k of [1, 0.75, 1.3, 0.55]) {
        const dir = rotate(d0, a);
        const p = clampCamera([L[0] + dir[0] * r0 * k, out.cam[1] + dy, L[2] + dir[1] * r0 * k], rect, height, floorY);
        let c: V3 = p;
        if (room.outline.length >= 3) {
          const [sx, sz] = snap(room.outline, [p[0], p[2]], rect);
          if (!insideInset(room.outline, [sx, sz])) continue;
          c = [sx, p[1], sz];
        }
        if (clear(c, L)) return { ...out, cam: c };
      }
  return out;
}

function nearestOther(crew: DActor[], s: DActor): DActor | undefined {
  let best: DActor | undefined;
  let bd = Infinity;
  for (const a of crew) {
    if (a === s) continue;
    const d = dist(a.pos, s.pos);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}

function maxSpan(crew: DActor[]): number {
  let m = 0;
  for (const a of crew) for (const b of crew) m = Math.max(m, dist(a.pos, b.pos));
  return m;
}

function roomCenter(outline: V2[]): V2 {
  const xs = outline.map((p) => p[0]);
  const zs = outline.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
}

function frame(plan: Plan, subj: DActor, other: DActor | undefined, crew: DActor[], walkers: DActor[], inp: DirectorInput, t: number, clock: number, cut: number, st: { side: 1 | -1 | null; axis: V2 | null }, snap: SnapFn = snapInside, gaze: DActor = subj): DirectorOut {
  const room = inp.room;
  const floorY = room.floorY ?? 0;
  // open sky: the 3.5 m ceiling is above the floor, not an absolute world height (F3)
  const height = room.open ? floorY + OPEN_CEILING : room.ceiling;
  const top = Math.max(0.5, height - 0.3 - floorY);
  const rect = roomRect(room.outline);
  const center = roomCenter(room.outline);
  const vfov = (inp.fov ?? 50) * DEG;
  const aspect = inp.aspect ?? 16 / 9;

  const at = (p: V2, y: number): V3 => [p[0], floorY + y, p[1]];
  const mid = (list: DActor[]): V2 => [list.reduce((s, a) => s + a.pos[0], 0) / list.length, list.reduce((s, a) => s + a.pos[1], 0) / list.length];

  // the pair and its axis: from the smaller name to the larger (a speaker change does not flip it);
  // actors in one spot (< 0.3 m) take the original line speaker's gaze as the axis (F10: the listener
  // reaction reframes the same speaker, so deriving it from the reaction subject would flip the side)
  const pair = other ? [subj, other].sort(byName) : [subj];
  const m = mid(pair);
  const axis: V2 = pair.length > 1 ? (dist(pair[0].pos, pair[1].pos) < 0.3 ? faceOf(gaze.yaw) : norm([pair[1].pos[0] - pair[0].pos[0], pair[1].pos[1] - pair[0].pos[1]])) : faceOf(subj.yaw);
  const n: V2 = [-axis[1], axis[0]];
  // persistent 180° side: reselected only when the axis turned by more than 90°
  let side: 1 | -1 = 1;
  if (pair.length > 1) {
    if (st.axis && st.side !== null && angleBetween(axis, st.axis) <= 90) side = st.side;
    else {
      const toCenter = (center[0] - m[0]) * n[0] + (center[1] - m[1]) * n[1];
      side = toCenter < 0 ? -1 : 1;
      st.side = side;
      st.axis = axis;
    }
  }
  const onSide = (pt: V2): boolean => ((pt[0] - m[0]) * n[0] + (pt[1] - m[1]) * n[1]) * side > 1e-9;
  const sideDir: V2 = pair.length > 1 ? [n[0] * side, n[1] * side] : norm([center[0] - m[0], center[1] - m[1]]);
  const span = pair.length > 1 ? dist(pair[0].pos, pair[1].pos) : 0;
  const meanH = pair.reduce((s, a) => s + a.height, 0) / pair.length;
  const head = (a: DActor, k = 0.9): V3 => at(a.pos, a.height * k);

  /** camera point (x, z, height above the floor) clamped into the room; fallback walks from the pair midpoint to the room center (F8) */
  const place = (x: number, z: number, y: number): V3 => {
    const p = clampCamera([x, floorY + Math.min(y, top), z], rect, height, floorY);
    if (room.outline.length >= 3) {
      const [sx, sz] = snap(room.outline, [p[0], p[2]], rect);
      if (insideInset(room.outline, [sx, sz])) return [sx, p[1], sz];
      return fallbackFrame(m, center, room.outline, INSET, p[1]);
    }
    return p;
  };

  /** Side wins over everything but orbit (F2): a non-orbit frame is never returned from the opposite side.
   * A point pushed across the axis by the room clamp is mirrored back; if that is still off-side, the side
   * direction from the pair midpoint is tried; the midpoint-to-center fallback is on-side by construction. */
  const toSide = (cam: V3, yAboveFloor: number, dFallback: number): V3 => {
    if (!other || onSide([cam[0], cam[2]])) return cam;
    const perp = (cam[0] - m[0]) * n[0] + (cam[2] - m[1]) * n[1];
    const mir = place(cam[0] - 2 * perp * n[0], cam[2] - 2 * perp * n[1], yAboveFloor);
    if (onSide([mir[0], mir[2]])) return mir;
    const along = place(m[0] + sideDir[0] * dFallback, m[1] + sideDir[1] * dFallback, yAboveFloor);
    if (onSide([along[0], along[2]])) return along;
    const fb = fallbackFrame(m, center, room.outline, INSET, cam[1]);
    if (!other || onSide([fb[0], fb[2]])) return fb;
    // the fallback landed on the axis (mid == room center): step strictly to the selected side (F7)
    const nudge = place(m[0] + sideDir[0] * (dFallback + 0.4), m[1] + sideDir[1] * (dFallback + 0.4), yAboveFloor);
    return onSide([nudge[0], nudge[2]]) ? nudge : fb;
  };

  /** camera on the face side of `s`: tries the distances until the clamped point is within 60 degrees of the gaze */
  const faceCam = (s: DActor, dir: V2, dists: number[], y: number): V3 => {
    const f = faceOf(s.yaw);
    let faceOk: V3 | null = null;
    for (const d of dists) {
      const p = place(s.pos[0] + dir[0] * d, s.pos[1] + dir[1] * d, y);
      if (angleBetween(f, [p[0] - s.pos[0], p[2] - s.pos[1]]) > 60) continue;
      // after the room clamp the camera must still be on the 180° side (F7/F10)
      if (!other || onSide([p[0], p[2]])) return p;
      faceOk ??= p;
    }
    // F6: no preferred direction is on the 180° side — search the whole face cone (±60°) before giving up the side
    if (other) {
      const ks: number[] = [];
      for (let k = 0; k <= 60; k += 5) ks.push(k, -k);
      for (const d of [...dists, 2.2, 1.6, 1.2, 0.9, 0.6, 0.45])
        for (const k of ks) {
          const dv = rotate(f, k);
          const c = place(s.pos[0] + dv[0] * d, s.pos[1] + dv[1] * d, y);
          if (angleBetween(f, [c[0] - s.pos[0], c[2] - s.pos[1]]) > 60 + 1e-9) continue;
          if (onSide([c[0], c[2]])) return c;
        }
    }
    // F2: the face cone and the selected side do not intersect — the side wins, never the opposite side
    const fb = faceOk ?? place(s.pos[0] + dir[0] * dists[dists.length - 1], s.pos[1] + dir[1] * dists[dists.length - 1], y);
    return toSide(fb, y, dists[0]);
  };

  let p: Plan = plan;
  if (!other && (p === "ots" || p === "two")) p = p === "ots" ? "close" : "wide";
  // F13: one actor -> only wide/close/follow, explicit beat shots included (orbit -> wide, dolly -> close)
  if (!other && (p === "orbit" || p === "dolly")) p = p === "orbit" ? "wide" : "close";
  if (p === "low" && (!other || subj.height <= other.height)) p = "close";

  switch (p) {
    case "close": {
      const f = faceOf(subj.yaw);
      let dir = f;
      if (other) {
        const a = rotate(f, 30);
        const b = rotate(f, -30);
        const da = dist([subj.pos[0] + a[0], subj.pos[1] + a[1]], other.pos);
        const db = dist([subj.pos[0] + b[0], subj.pos[1] + b[1]], other.pos);
        const away = da >= db ? a : b;
        const near = da >= db ? b : a;
        // face side first, but the camera stays on the persistent 180° side
        dir = onSide([subj.pos[0] + away[0], subj.pos[1] + away[1]]) ? away : near;
      }
      return { plan: p, cut, cam: faceCam(subj, dir, [1.6, 1.2, 0.9], subj.height * 0.8), look: head(subj) };
    }
    case "ots": {
      const o = other!;
      const toO = norm([o.pos[0] - subj.pos[0], o.pos[1] - subj.pos[1]]);
      const f = faceOf(subj.yaw);
      const ang = Math.max(-40, Math.min(40, signedAngle(f, toO)));
      const dir = rotate(f, ang);
      const shoulder: V2 = [-dir[1] * 0.4, dir[0] * 0.4];
      const d0 = dist(o.pos, subj.pos) + 1;
      const y = o.height * 0.9;
      const sh: V2 = onSide([subj.pos[0] + dir[0] * d0 + shoulder[0], subj.pos[1] + dir[1] * d0 + shoulder[1]]) ? shoulder : [-shoulder[0], -shoulder[1]];
      const first = place(subj.pos[0] + dir[0] * d0 + sh[0], subj.pos[1] + dir[1] * d0 + sh[1], y);
      // the clamp can move the camera across the axis (F10): try angles nearest the listener first, both shoulders, all distances
      const angs = [0, 10, -10, 20, -20, 30, -30, 40, -40, 50, -50, 60, -60, 70, -70, 80, -80, 90, -90, 100, -100, 110, -110, 120, -120]
        .map((k) => ang + k)
        .filter((k) => Math.abs(k) <= 60);
      let faceOnly: V3 | null = null;
      for (const d of [d0, 2, 1.4, 1, 0.6])
        for (const k of angs)
          for (const sgn of [1, -1]) {
            const dv = rotate(f, k);
            const so: V2 = [-dv[1] * 0.4 * sgn, dv[0] * 0.4 * sgn];
            const c = place(subj.pos[0] + dv[0] * d + so[0], subj.pos[1] + dv[1] * d + so[1], y);
            if (angleBetween(f, [c[0] - subj.pos[0], c[2] - subj.pos[1]]) > 60) continue;
            if (onSide([c[0], c[2]])) return { plan: p, cut, cam: c, look: head(subj) };
            faceOnly ??= c;
          }
      // F6: no over-the-shoulder point on the 180° side — the plain face cone (no shoulder offset) before giving up the side
      const cone = faceCam(subj, f, [d0, 2, 1.4, 1, 0.6], y);
      if (onSide([cone[0], cone[2]]) && angleBetween(f, [cone[0] - subj.pos[0], cone[2] - subj.pos[1]]) <= 60 + 1e-9) return { plan: p, cut, cam: cone, look: head(subj) };
      // F2: face cone and side do not intersect — the side wins, never the opposite side
      return { plan: p, cut, cam: toSide(faceOnly ?? first, y, d0), look: head(subj) };
    }
    case "two": {
      const d = Math.max(3, span * 1.2 + 2.5);
      const y = meanH * 0.8;
      return { plan: p, cut, cam: toSide(place(m[0] + sideDir[0] * d, m[1] + sideDir[1] * d, y), y, d), look: at(m, meanH * 0.6) };
    }
    case "wide": {
      // framed by the actors (+ 1.75 m margin) in camera coordinates, not by world X/Z span (F2)
      const xs = crew.map((a) => a.pos[0]);
      const zs = crew.map((a) => a.pos[1]);
      const c: V2 = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...zs) + Math.min(...zs)) / 2];
      const ht = Math.max(...crew.map((a) => a.height));
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
      const dir0 = crew.length > 1 ? sideDir : norm([center[0] - c[0], center[1] - c[1]]);
      const du = norm(dir0);
      const right: V2 = [-du[1], du[0]];
      const tanH = Math.tan(hfov / 2);
      const tanV = Math.tan(vfov / 2);
      let dH = 2.5;
      let minDepth = 0;
      for (const a of crew) {
        const ox = a.pos[0] - c[0];
        const oz = a.pos[1] - c[1];
        const lat = ox * right[0] + oz * right[1];
        const dep = ox * du[0] + oz * du[1];
        if (dep < minDepth) minDepth = dep;
        dH = Math.max(dH, dep + (Math.abs(lat) + 1.75) / tanH);
      }
      const dV = minDepth + ht * 1.4 / (2 * tanV);
      const d = Math.max(dH, dV, 2.5);
      const wy = ht * 1.15 + 0.3;
      return { plan: p, cut, cam: toSide(place(c[0] + du[0] * d, c[1] + du[1] * d, wy), wy, d), look: at(c, ht * 0.5) };
    }
    case "orbit": {
      const a0 = Math.atan2(sideDir[1], sideDir[0]) + 0.25 * t;
      const r = Math.max(3, span + 2.5);
      return { plan: p, cut, cam: place(m[0] + Math.cos(a0) * r, m[1] + Math.sin(a0) * r, meanH * 0.8), look: at(m, meanH * 0.6) };
    }
    case "dolly": {
      const k = Math.min(1, t / 8);
      const d = 4.5 + (2.2 - 4.5) * k;
      const dir = other ? sideDir : faceOf(subj.yaw);
      const dy = subj.height * 0.8;
      return { plan: p, cut, cam: toSide(place(subj.pos[0] + dir[0] * d, subj.pos[1] + dir[1] * d, dy), dy, d), look: head(subj) };
    }
    case "low": {
      const lf = faceOf(subj.yaw);
      const opts = [lf, rotate(lf, 30), rotate(lf, -30)];
      const dir = other ? (opts.find((v) => onSide([subj.pos[0] + v[0], subj.pos[1] + v[1]])) ?? lf) : lf;
      return { plan: p, cut, cam: faceCam(subj, dir, [1.8, 1.3, 1], 0.35), look: head(subj) };
    }
    default: {
      // follow: behind the walker, looking where it goes; mirrored across the pair axis when off the 180° side
      const w = walkers[0] ?? subj;
      const f = faceOf(w.yaw);
      let cam = place(w.pos[0] - f[0] * 2.5, w.pos[1] - f[1] * 2.5, w.height * 0.9);
      if (other) {
        const perp = (cam[0] - m[0]) * n[0] + (cam[2] - m[1]) * n[1];
        if (perp * side < 0) cam = place(cam[0] - 2 * perp * n[0], cam[2] - 2 * perp * n[1], cam[1] - floorY);
        // a camera right on the axis (or just across it) is pushed strictly to the 180° side
        const now = (cam[0] - m[0]) * n[0] * side + (cam[2] - m[1]) * n[1] * side;
        if (now < 0.3) cam = place(cam[0] + (0.4 - now) * n[0] * side, cam[2] + (0.4 - now) * n[1] * side, cam[1] - floorY);
        cam = toSide(cam, cam[1] - floorY, 2.5);
      }
      return { plan: p, cut, cam, look: at([w.pos[0] + f[0], w.pos[1] + f[1]], w.height * 0.8) };
    }
  }
}
