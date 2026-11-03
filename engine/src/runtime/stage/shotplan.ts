import { Ray, Vector3, type Mesh, type Object3D } from "three";
import type { V3 } from "./camera.js";

/** Г8: the shot plan executor (`shotplan/plan.json`, same meaning as Sonnet's hand-made story.js).
 *  Pure parts (format, time, ease, shake, which plan is active, the camera point of a plan, the cut)
 *  live here; stage/index.ts feeds it the clock and the beats and puts the camera. */

export type Ease = "lin" | "io" | "in" | "out";
export type ShotLook = V3 | { actor: string; bone: "head" | "hips"; o: V3 };
export interface ShotPoint {
  pos: V3;
  look: ShotLook;
  fov?: number;
}
/** a moment of the plan: seconds from the first update, `prev`, `B<i>[e][±s]`, `END[±s]` */
export type ShotTime =
  | { k: "num"; x: number }
  | { k: "prev" }
  | { k: "beat"; i: number; end: boolean; off: number }
  | { k: "end"; off: number };
export interface Shot {
  name: string;
  at: ShotTime;
  to: ShotTime;
  from: ShotPoint;
  end: ShotPoint | null;
  cut: boolean;
  shake: number;
  ease: Ease;
}
export interface Shotplan {
  version: number;
  scene: string;
  world?: string;
  notes?: string;
  shots: Shot[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isV3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every(isNum);

export function parseShotTime(v: unknown): ShotTime | null {
  if (isNum(v)) return { k: "num", x: v };
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "prev") return { k: "prev" };
  let m = /^B(\d+)(e?)(?:([+-])(\d+(?:\.\d+)?))?$/.exec(s);
  if (m) return { k: "beat", i: Number(m[1]), end: m[2] === "e", off: m[3] ? (m[3] === "-" ? -1 : 1) * Number(m[4]) : 0 };
  m = /^END(?:([+-])(\d+(?:\.\d+)?))?$/.exec(s);
  if (m) return { k: "end", off: m[1] ? (m[1] === "-" ? -1 : 1) * Number(m[2]) : 0 };
  return null;
}

function parseLook(v: unknown): ShotLook | null {
  if (isV3(v)) return v;
  if (v && typeof v === "object") {
    const o = v as { actor?: unknown; bone?: unknown; o?: unknown };
    if (typeof o.actor === "string" && (o.bone === "head" || o.bone === "hips"))
      return { actor: o.actor, bone: o.bone, o: isV3(o.o) ? o.o : [0, 0, 0] };
  }
  return null;
}

function parsePoint(v: unknown): ShotPoint | null {
  if (!v || typeof v !== "object") return null;
  const p = v as { pos?: unknown; look?: unknown; fov?: unknown };
  const look = parseLook(p.look);
  if (!isV3(p.pos) || !look) return null;
  return { pos: p.pos, look, ...(isNum(p.fov) ? { fov: p.fov } : {}) };
}

/** both ends on one base (two numbers, the same beat start/end, END) -> to <= at is known before playing */
function staticallyEmpty(a: ShotTime, b: ShotTime): boolean {
  if (a.k === "num" && b.k === "num") return b.x <= a.x;
  if (a.k === "end" && b.k === "end") return b.off <= a.off;
  if (a.k === "beat" && b.k === "beat" && a.i === b.i && a.end === b.end) return b.off <= a.off;
  return false;
}

/** plan.json -> Shotplan; a broken shot is dropped with a warning, a broken plan -> null */
export function parseShotplan(j: unknown, warn: string[]): Shotplan | null {
  if (!j || typeof j !== "object" || !Array.isArray((j as any).shots)) {
    warn.push("shotplan: no shots[] -> director");
    return null;
  }
  const raw = j as { version?: unknown; scene?: unknown; world?: unknown; notes?: unknown; shots: unknown[] };
  const shots: Shot[] = [];
  raw.shots.forEach((s, k) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : `shot ${k}`;
    const at = parseShotTime(o.at);
    const to = parseShotTime(o.to);
    const from = parsePoint(o.from);
    const end = o.end === undefined || o.end === null ? null : parsePoint(o.end);
    if (!at || !to || !from || (o.end !== undefined && o.end !== null && !end)) {
      warn.push(`shotplan: shot "${name}" is malformed -> skipped`);
      return;
    }
    const ease: Ease = o.ease === "lin" || o.ease === "in" || o.ease === "out" || o.ease === "io" ? o.ease : "io";
    if (o.ease !== undefined && o.ease !== ease) warn.push(`shotplan: shot "${name}" ease "${String(o.ease)}" -> io`);
    shots.push({ name, at, to, from, end, cut: o.cut === true, shake: isNum(o.shake) ? Math.max(0, o.shake) : 0, ease });
  });
  return {
    version: isNum(raw.version) ? raw.version : 1,
    scene: typeof raw.scene === "string" ? raw.scene : "",
    ...(typeof raw.world === "string" ? { world: raw.world } : {}),
    ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
    shots,
  };
}

/** ease of the share u in [0, 1]: lin u, io 3u² − 2u³, in u², out 1 − (1 − u)²; unknown -> io */
export function easeOf(name: string | undefined): (u: number) => number {
  if (name === "lin") return (u) => u;
  if (name === "in") return (u) => u * u;
  if (name === "out") return (u) => 1 - (1 - u) * (1 - u);
  return (u) => 3 * u * u - 2 * u * u * u;
}

/** handheld shake, metres: a · [sin(2π·1.3τ), 0.5·sin(2π·1.7τ + 1), sin(2π·1.1τ + 2)], τ = seconds into the plan */
export function shakeOf(a: number, tau: number): V3 {
  return [
    a * Math.sin(2 * Math.PI * 1.3 * tau),
    a * 0.5 * Math.sin(2 * Math.PI * 1.7 * tau + 1),
    a * Math.sin(2 * Math.PI * 1.1 * tau + 2),
  ];
}

export interface ActiveShot {
  shot: Shot;
  index: number;
  at: number;
  /** null: the end is not known yet (the camera stands in `end`) */
  to: number | null;
}

/** The plan's clock: `tick(now)` every frame (the first one is t0), `beat(i, now, dur)` when a beat event
 *  comes (the first one per index counts), `end(now)` on book_end / the book's scene transition. */
export function createShotClock(plan: Shotplan, warn: string[]) {
  let t0: number | null = null;
  const beatAt = new Map<number, number>();
  const beatDur = new Map<number, number | undefined>();
  let endAt: number | null = null;
  const skipped = new Set<number>();
  plan.shots.forEach((s, k) => {
    if (staticallyEmpty(s.at, s.to)) {
      skipped.add(k);
      warn.push(`shotplan: shot "${s.name}" ends before it starts (to <= at) -> skipped`);
    }
  });

  const beatEnd = (i: number): number | null => {
    const a = beatAt.get(i);
    if (a === undefined) return null;
    const d = beatDur.get(i);
    if (d !== undefined) return a + d;
    return beatAt.get(i + 1) ?? endAt;
  };
  const timeOf = (t: ShotTime, k: number): number | null => {
    if (t.k === "num") return t0 === null ? null : t0 + t.x;
    if (t.k === "prev") {
      let j = k - 1;
      while (j >= 0 && skipped.has(j)) j--; // the last shot that can play, not a skipped one
      return j < 0 ? t0 : timeOf(plan.shots[j].to, j);
    }
    if (t.k === "end") return endAt === null ? null : endAt + t.off;
    const b = t.end ? beatEnd(t.i) : (beatAt.get(t.i) ?? null);
    return b === null ? null : b + t.off;
  };

  return {
    tick(now: number): void {
      if (t0 === null) t0 = now;
    },
    beat(i: number, now: number, dur?: number): void {
      if (beatAt.has(i)) return;
      beatAt.set(i, now);
      beatDur.set(i, dur !== undefined && Number.isFinite(dur) ? dur : undefined);
    },
    end(now: number): void {
      if (endAt === null) endAt = now;
    },
    /** the latest started plan (equal starts: the last in the list); null once it is over or before any */
    active(now: number): ActiveShot | null {
      let best: ActiveShot | null = null;
      plan.shots.forEach((shot, k) => {
        if (skipped.has(k)) return;
        const at = timeOf(shot.at, k);
        if (at === null || at > now) return;
        const to = timeOf(shot.to, k);
        if (to !== null && to <= at) {
          skipped.add(k);
          warn.push(`shotplan: shot "${shot.name}" ends before it starts (to <= at) -> skipped`);
          return;
        }
        if (to !== null && now >= to) return;
        if (!best || at >= best.at) best = { shot, index: k, at, to };
      });
      return best as ActiveShot | null;
    },
  };
}
export type ShotClock = ReturnType<typeof createShotClock>;

export interface ShotFrame {
  name: string;
  pos: V3;
  look: V3;
  fov: number | null;
  cut: boolean;
}

/** where the camera of an active plan is at `now`: eased from -> end, plus the shake; `bone` gives a bone's world point */
/** baseFov: the camera's fov before the plan took it -- where a zoom with no `from.fov` starts (B65) */
export function shotFrame(a: ActiveShot, now: number, bone: (actor: string, bone: "head" | "hips") => V3 | null, baseFov: number | null = null): ShotFrame {
  const s = a.shot;
  const u = a.to === null ? 1 : Math.max(0, Math.min(1, (now - a.at) / (a.to - a.at)));
  const e = s.end ? easeOf(s.ease)(u) : 0;
  const lookAt = (l: ShotLook): V3 => {
    if (Array.isArray(l)) return l;
    const p = bone(l.actor, l.bone) ?? [0, 1, 0];
    return [p[0] + l.o[0], p[1] + l.o[1], p[2] + l.o[2]];
  };
  const mix = (p: V3, q: V3): V3 => [p[0] + (q[0] - p[0]) * e, p[1] + (q[1] - p[1]) * e, p[2] + (q[2] - p[2]) * e];
  const end = s.end ?? s.from;
  const sh = shakeOf(s.shake, now - a.at);
  const p = mix(s.from.pos, end.pos);
  const f0 = s.from.fov ?? null;
  const f1 = end.fov ?? f0;
  return {
    name: s.name,
    pos: [p[0] + sh[0], p[1] + sh[1], p[2] + sh[2]],
    look: mix(lookAt(s.from.look), lookAt(end.look)),
    // B65: no start fov -> the zoom starts from the camera's own (baseFov); unknown -> the end fov once moving
    fov: f0 !== null ? f0 + ((f1 ?? f0) - f0) * e
      : f1 === null ? null
      : baseFov !== null ? baseFov + (f1 - baseFov) * e
      : e > 0 ? f1 : null,
    cut: s.cut,
  };
}

const CUT_KINDS = new Set(["wall", "band", "cap", "reveal"]);

/** the cut (`cut: true`): meshes of kind wall/band/cap/reveal the segment camera -> look crosses, and the
 *  ceiling when the camera is above its height − 0.05 (its lowest world vertex) */
export function cutMeshes(scene: Object3D, cam: V3, look: V3): Mesh[] {
  const out: Mesh[] = [];
  const o = new Vector3(...cam);
  const d = new Vector3(look[0] - cam[0], look[1] - cam[1], look[2] - cam[2]);
  const len = d.length();
  const ray = new Ray(o, len > 0 ? d.clone().divideScalar(len) : new Vector3(0, 0, 1));
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3();
  scene.traverse((obj) => {
    const m = obj as Mesh;
    if (!(m as any).isMesh) return;
    const kind = m.userData?.kind;
    if (kind !== "ceiling" && !CUT_KINDS.has(kind)) return;
    const pos = m.geometry?.getAttribute("position");
    if (!pos) return;
    m.updateWorldMatrix(true, false);
    const w = m.matrixWorld;
    if (kind === "ceiling") {
      let minY = Infinity;
      for (let i = 0; i < pos.count; i++) minY = Math.min(minY, a.fromBufferAttribute(pos, i).applyMatrix4(w).y);
      if (cam[1] > minY - 0.05) out.push(m);
      return;
    }
    if (len <= 0) return;
    const idx = m.geometry.getIndex();
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(w);
      b.fromBufferAttribute(pos, i1).applyMatrix4(w);
      c.fromBufferAttribute(pos, i2).applyMatrix4(w);
      if (ray.intersectTriangle(a, b, c, false, hit) && hit.distanceTo(o) <= len) {
        out.push(m);
        return;
      }
    }
  });
  return out;
}
