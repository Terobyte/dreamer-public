import { INSET, insideInset, legalCameraPoint, roomRect, snapInside, type CameraSide, type CameraLaw, type V3 } from "./camera.js";
import type { V2 } from "./places.js";
import { ndcOf, resolveMove, type MoveSubject } from "./moves.js";
import { STYLES, pickMove, type Style } from "./styles.js";
import type { Ease, ShotLook } from "./shotplan.js";

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
  /** metres of route still ahead while walking; none = unknown (counts as a long walk) */
  walkLeft?: number;
  /** where the route ends (the runtime's real goal); none = guessed from yaw x walkLeft */
  walkTo?: V2;
  /** measured head point (world, smoothed): seated or lying, the head is not at height × 0.9 above `pos` */
  head?: V3;
  /** the face: between the head bone and the eye (a box figure's head bone sits mid-body); the sight probe and the
   *  frame's edge look at it (Squidward v20: SpongeBob's face behind a chair back, his head bone seen under the seat) */
  face?: V3;
  /** the eye (`Actor.eye()`, 0.92 of the height: the top of a box figure); the probe must see it as well as the face */
  eye?: V3;
  /** measured face yaw (head bone), same convention as yaw; none = the body yaw */
  faceYaw?: number;
  /** lying down: the face looks up, yaw is where the head points, so a face angle off yaw means nothing */
  lying?: boolean;
  offstage?: boolean;
}
/** a walk with less route than this left when it starts gets no `follow` cut (and its end no cut): a 1 s walk cut in
 *  and out gave 0.5–1.5 s shots (Koshakan bedroom, Nov 2) */
export const FOLLOW_MIN_M = 2.5;
export interface DEvent {
  kind: "line" | "narrator" | "walk" | "tick";
  speaker?: string;
  durationS?: number;
  shot?: string;
  /** narrator: the actor the text names (a close in a narration run frames them) */
  about?: string;
  dt: number;
  /** К2: beat index, room key and move tags (absent = behaviour by `shot` and `kind`) */
  beat?: number;
  room?: string;
  tags?: { first?: boolean; enter?: boolean; look?: boolean; last?: boolean };
  /** К3м: Spark's choice for this beat (moves.json): the director does not draw a move nor apply tags */
  forced?: { move: string; subject: MoveSubject };
  /** К3м: moves.json `hold` for this beat: a beat change does not cut the running plan */
  hold?: boolean;
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
  /** К2: the move of the plan (from `cam` to `end`); all optional so the legacy callers do not change */
  lookRef?: ShotLook;
  lookEndRef?: ShotLook;
  end?: V3;
  lookEnd?: V3;
  fov?: number;
  fovEnd?: number;
  ease?: Ease;
  shake?: number;
  move?: string;
  warnings?: string[];
  /** seconds the move lasts (event duration, or `style.asl[0]`) */
  moveDurationS?: number;
}

/** who the director frames: actors of the focus room and level; an actor off every level (lying on a bed, sitting on
 *  a table: feet above the floor) belongs to the room it is in (k14_true: Mirai on the bed was dropped from the
 *  director's crew, so Mama's line framed Mama alone) */
export function inScene(a: Pick<DActor, "room" | "level">, room: string | null, level: string | null): boolean {
  return a.room === room && (a.level === level || a.level === null || level === null);
}

const DEG = Math.PI / 180;
const OPEN_CEILING = 3.5;
const REACT_AT = 0.45;
const BACK_AT = 0.75;
const LONG_LINE = 7;
/** a wide whose worst pair face is under this many degrees off the camera is kept square to the side */
const WIDE_FACE_OK = 100;
/** off a spoken line: the camera stays within this many degrees of a standing subject's face */
const NARRATION_FACE_OK = 120;
/** a wide may swing within its 180° half-plane by up to this many degrees to see the faces */
const WIDE_SWING = 60;
/** the wide's camera height above the floor (metres) and its largest look down (degrees) */
const WIDE_EYE = 1.6;
const WIDE_TILT = 18;
/** a move must keep its subjects' heads inside this share of the frame (ndc), else the base frame stays */
const IN_FRAME = 0.9;

const dist = (a: V2, b: V2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const norm = (v: V2, fallback: V2 = [0, 1]): V2 => {
  const l = Math.hypot(v[0], v[1]);
  return l < 1e-9 ? fallback : [v[0] / l, v[1] / l];
};
const faceOf = (yaw: number): V2 => [Math.sin(yaw * DEG), Math.cos(yaw * DEG)];
/** К2: direction of the face (head bone when measured); lying actors look up, so they have no face direction. */
export function faceDir(a: DActor): V2 | null {
  if (a.lying) return null;
  return faceOf(a.faceYaw ?? a.yaw);
}
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

/** schemes the director runs as one atom for one beat */
const SCHEME_ATOM: Record<string, string> = { over_the_shoulder: "ots", reaction_cut: "close", establishing: "master", return_wide: "master", final_pull_out: "pull_out" };

export function createDirector(defaultRng: () => number, opts: { snap?: SnapFn; style?: string } = {}) {
  const snap: SnapFn = opts.snap ?? snapInside;
  // К2: the move layer is on when a style is named or an event carries tags; plain callers keep the legacy frames
  const styleKnown = opts.style !== undefined && Object.hasOwn(STYLES, opts.style);
  const style: Style = STYLES[styleKnown ? opts.style! : "storybook"];
  const styleWarn = opts.style !== undefined && !styleKnown ? [`STYLE_UNKNOWN ${opts.style}`] : [];
  let moveMode = opts.style !== undefined;
  let moveCut = -1;
  /** the cut number the runtime sees while a move is held, the clock and room when the move started */
  let heldCut = -1;
  /** a held still frame that has not seen a head it holds for this long (s) is cut again (hiddenFor, recuts) */
  let hiddenFor = 0;
  /** the frame last handed out, and how long a still one has left a standing head of its room off screen (Squidward
   *  v19 155–159 s: SpongeBob walked 2.7 m to the table, the two-shot cut before it held both heads off its edges) */
  let lastOut: DirectorOut | null = null;
  let lostFor = 0;
  let lostRecut = false;
  /** one such cut per beat: a room too small for both would cut every 0.75 s */
  let lostTried = false;
  /** a still fallback frame on a walking speaker turns its look after him (Squidward v21 153–157 s) */
  let trackName: string | null = null;
  let trackMove: object | null = null;
  let recuts = 0;
  let recut = false;
  let moveStart = 0;
  let moveRoom: string | null = null;
  /** accent styles: the last base frame on screen and when its cut began */
  let shown: { out: DirectorOut; at: number } | null = null;
  let shownRoom: string | null = null;
  let carryWarn: string[] = [];
  let curMove: Pick<DirectorOut, "cam" | "look" | "lookRef" | "lookEndRef" | "end" | "lookEnd" | "fov" | "fovEnd" | "ease" | "shake" | "move" | "warnings" | "moveDurationS"> | null = null;
  let lastBeat: number | undefined;
  let curPair = false;
  let pairNames: string[] = [];
  let lastSpeaker: string | undefined;
  let lastRoomEv: string | undefined;
  let faceBase: { name: string; dir: V2 } | null = null;
  let clock = 0;
  let count = 0;
  let plan: Plan | null = null;
  let lastPlan: Plan | null = null;
  let planStart = 0;
  let cutSeq = 0;
  let subjectIsListener = false;
  let walkSig = "";
  /** a walk that began too soon after a cut is cut for on the action, WALK_CUT_S after it, not asl.min (Squidward v22
   *  142–145 s: they got up 0.5 s into "Fine. One hour. Then I paint.", the walk's cut was swallowed for good and the
   *  line's close held them walking into the lens) */
  let walkCutOwed = false;
  const following = new Set<string>();
  let wideLock: { cut: number; cam: V3 } | null = null;
  // F1: the room the frame is built in; crossing into another room/level is a cut, never a smooth glide through the wall
  let roomKey: string | null = null;
  let focus: string | null = null;
  let closeLineAxis: V2 | null = null;
  let closeLineOrigin: V2 | null = null;
  let explicitPlan = false;
  let pending: Array<{ at: number; plan: Plan; listener: boolean }> = [];
  // persistent 180° side (F7): reselected only when the pair axis turns by more than 90°
  const st: { side: 1 | -1 | null; axis: V2 | null; origin?: V2; normal?: V2; wideCut?: number } = { side: null, axis: null };

  const step = (inp: DirectorInput): DirectorOut => {
    const rng = inp.rng ?? defaultRng;
    const ev = inp.event;
    const all = inp.actors.filter((a) => !a.offstage).sort(byName);
    if (!all.length) {
      const floorY = inp.room.floorY ?? 0;
      const height = inp.room.open ? floorY + OPEN_CEILING : inp.room.ceiling;
      const top = height - 0.3 - floorY;
      const eye = Math.min(floorY + Math.min(1.5, Math.max(0.05, top)), height);
      const lookY = Math.min(floorY + Math.min(1, Math.max(0.05, top)), height);
      const c = roomCenter(inp.room.outline);
      const legal = legalCameraPoint([c[0], eye, c[1]], { outline: inp.room.outline, rect: roomRect(inp.room.outline), height, floorY });
      return { plan: plan ?? "wide", cam: legal, look: [legal[0], lookY, legal[2]], cut: cutSeq, ...(styleWarn.length ? { warnings: styleWarn } : {}) };
    }
    const named = ev.kind === "line" || ev.kind === ("walk" as string) ? all.find((a) => a.name === ev.speaker) : undefined;
    // narrator always pivots on the first actor by name, never on the stored focus (F1)
    // a tick stays in the room the camera is in while someone is there (v31 152.5 s: in with SpongeBob, out to
    // Squidward on the street, in again with him half a second later)
    const keyOf = (a: DActor): string => `${a.level ?? ""}|${a.room ?? ""}`;
    const focused = all.find((a) => a.name === focus);
    const stay = !named && ev.kind !== "narrator" && roomKey !== null && (!focused || keyOf(focused) !== roomKey) ? all.find((a) => keyOf(a) === roomKey) : undefined;
    const pivot = ev.kind === "narrator" ? (all.find((a) => a.name === ev.about) ?? all[0]) : (named ?? stay ?? focused ?? all[0]);
    // the room of the speaker (narrator: of the first actor); other rooms/levels are not in the frame
    // a lying/seated actor off every level (feet above the floor) is still in the room (k17_dbg: Mirai on the bed)
    const crew = all.filter((a) => a.room === pivot.room && (a.level === pivot.level || a.level === null || pivot.level === null));
    const speaker = crew.find((a) => a.name === pivot.name) ?? crew[0];
    const listener = ev.kind === "narrator" ? undefined : nearestOther(crew, speaker);
    // F6: narrator has no reaction listener, but a `two` still frames the speaker pair
    const frameOther = listener ?? (ev.kind === "narrator" ? nearestOther(crew, speaker) : undefined);
    // only a long walk is a shot; once in, a walker stays in until it stops (its route running short is no cut)
    for (const a of crew) {
      if (!a.walking) following.delete(a.name);
      else if ((a.walkLeft ?? Infinity) >= FOLLOW_MIN_M) following.add(a.name);
    }
    const walkers = crew.filter((a) => a.walking && following.has(a.name));
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
      if (listener) pool = pool.filter((p) => p !== "follow");
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
    if (ev.tags || ev.forced) moveMode = true;
    const alternates = (who?: string): boolean => who !== undefined && who !== lastSpeaker && pairNames.includes(who);
    // К2: a new room is a cut with the room state dropped; a new beat cuts a plan
    let forceCut = false;
    let roomChanged = false;
    let holdBeat = false;
    const cutAtStart = cutSeq;
    if (ev.room !== undefined) {
      if (lastRoomEv !== undefined && ev.room !== lastRoomEv) {
        forceCut = true;
        roomChanged = true;
        st.side = null;
        st.axis = null;
        wideLock = null;
        curMove = null;
      }
      lastRoomEv = ev.room;
    }
    if (ev.beat !== undefined) {
      const changed = lastBeat !== undefined && ev.beat !== lastBeat;
      if (ev.hold && roomChanged) carryWarn.push(`HOLD_IGNORED B${ev.beat}`);
      else if (changed && ev.hold && plan !== null) holdBeat = true;
      if (changed && !holdBeat && !(style.cut === "long" && curPair && curMove?.move && ev.kind === "line" && alternates(ev.speaker))) forceCut = true;
      lastBeat = ev.beat;
    }
    // a face that turned more than 30° since the plan began (or past 90° to the camera) ends the plan
    if (moveMode && ev.kind === "tick" && curMove && faceBase) {
      const a = crew.find((x) => x.name === faceBase!.name);
      const fd = a ? faceDir(a) : null;
      if (a && fd) {
        const toCam: V2 = [curMove.cam[0] - a.pos[0], curMove.cam[2] - a.pos[1]];
        if (angleBetween(fd, faceBase.dir) > 30 || angleBetween(fd, toCam) > 90) forceCut = true;
      }
    }
    lostRecut = false;
    if (ev.kind !== "tick") lostTried = false;
    if (ev.kind === "tick" && !lostTried && lastOut && plan !== null) {
      const fy = inp.room.floorY ?? 0;
      // a frame of the room or the pair keeps everyone; any other keeps the one speaking (a reaction close leaves him out)
      const holdsAll = ["two", "wide", "orbit", "master"].includes(String(lastOut.plan));
      const lost = crew.some((a) => {
        if (a.offstage || a.walking) return false;
        if (!holdsAll && (a.name !== lastSpeaker || subjectIsListener || ev.kind !== "tick")) return false;
        // a move is judged at its end frame (where it settles); a look on an actor follows that actor
        const o = lastOut!;
        const cam = o.end ?? o.cam;
        const look = o.lookEnd ?? o.look;
        const p = ndcOf(a.head ?? ([a.pos[0], fy + a.height * 0.93, a.pos[1]] as V3), cam, look, o.fovEnd ?? o.fov ?? 50, inp.aspect ?? 16 / 9);
        return !(p.depth > 0.2 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05);
      });
      lostFor = lost ? lostFor + (ev.dt ?? 0) : 0;
      if (lostFor >= HIDDEN_RECUT_S && walkers.length === 0) {
        lostFor = 0;
        forceCut = true;
        lostRecut = true;
        lostTried = true;
      }
    } else lostFor = 0;

    // cut: "long" — alternating lines inside one running move do not cut it until asl.max has passed
    const holdPlan = holdBeat || moveMode && style.cut === "long" && !ev.forced && curMove !== null && ev.kind === "line" && curPair && alternates(ev.speaker) && !forceCut && !ev.tags?.first && !ev.tags?.look && clock - planStart < style.asl[1];
    if (holdPlan) {
      count++;
      focus = speaker.name;
    } else if (ev.kind === "line" || ev.kind === "narrator") {
      count++;
      pending = [];
      explicitPlan = Boolean(ev.shot && (BANK as readonly string[]).includes(ev.shot));
      const p = choose();
      lastPlan = p;
      cut(p);
      // a narration about an actor hands the ticks after it to that actor (v13 67.9 s: a tick re-cut to a close on
      // Squidward, the last speaker, while the narrator still read about SpongeBob)
      focus = ev.kind === "line" || (ev.kind === "narrator" && ev.about === speaker.name) ? speaker.name : focus;
      const otherActor = nearestOther(crew, speaker);
      const isClose = Boolean(ev.kind === "line" && otherActor && dist(speaker.pos, otherActor.pos) < 0.3);
      closeLineAxis = isClose ? faceOf(speaker.yaw) : null;
      closeLineOrigin = isClose ? [speaker.pos[0], speaker.pos[1]] : null;
      const dur = ev.durationS ?? 0;
      if (ev.kind === "line" && listener && dur > LONG_LINE && p !== "orbit" && p !== "dolly") {
        pending = [
          { at: clock + dur * REACT_AT, plan: "close", listener: true },
          { at: clock + dur * BACK_AT, plan: "ots", listener: false },
        ];
      }
    } else {
      if (plan === null) cut("wide");
      if (ev.tags?.last) {
        explicitPlan = false;
        lastPlan = "wide";
        cut("wide");
      } else if ((forceCut || ev.tags?.enter) && plan !== null && sig === walkSig) {
        explicitPlan = false;
        cut(lostRecut ? "wide" : plan);
      }
      if (sig !== walkSig) {
        explicitPlan = false;
        const p: Plan = walkers.length === 1 ? "follow" : "wide";
        lastPlan = p;
        cut(p);
      }
      while (pending.length && pending[0].at <= clock) {
        explicitPlan = false;
        const r = pending.shift()!;
        cut(r.plan, r.listener);
      }
    }
    const walkChanged = sig !== walkSig;
    walkSig = sig;
    if (ev.kind === "line") lastSpeaker = ev.speaker;
    const key = `${speaker.level ?? ""}|${speaker.room ?? ""}`;
    if (roomKey !== null && key !== roomKey && ev.kind !== "line" && ev.kind !== "narrator" && cutSeq === cutAtStart) cutSeq++;
    roomKey = key;

    const out0 = frame(plan ?? "wide", subjectIsListener && listener ? listener : speaker, subjectIsListener && listener ? speaker : frameOther, crew, walkers, inp, clock - planStart, clock, cutSeq, st, snap, speaker, closeLineAxis, explicitPlan, closeLineOrigin);
    const floorY = inp.room.floorY ?? 0;
    const height = inp.room.open ? floorY + OPEN_CEILING : inp.room.ceiling;
    const cameraLaw: CameraLaw = {
      outline: inp.room.outline,
      rect: roomRect(inp.room.outline),
      height,
      floorY,
      side: st.side && st.origin && st.normal ? { origin: st.origin, normal: st.normal, sign: st.side } : undefined,
      fallback: out0.cam,
    };
    let out = unblock(out0, inp, snap, cameraLaw);
    // a wide is locked off: the cut places it, then only the look pans after whoever moves (a wide re-framed every
    // tick slid 2.5 m across the Koshakan bedroom while Mama walked, Nov 2)
    if (out.plan === "wide" && wideLock && wideLock.cut === out.cut) out = { ...out, cam: wideLock.cam };
    wideLock = out.plan === "wide" ? { cut: out.cut, cam: out.cam } : null;
    // F12: a coerced plan (low -> close, ots -> close, two -> wide) is what the viewer saw: repeats compare to it
    if (ev.kind === "line" || ev.kind === "narrator") lastPlan = out.plan as Plan;
    if (!moveMode || explicitPlan) return styleWarn.length ? { ...out, warnings: styleWarn } : out;
    // a static plan past 2*asl.max drifts (0.1 m), except in styles without motion
    const driftNow = cutSeq === moveCut && curMove !== null && !curMove.end && style.move > 0 && clock - planStart > 2 * style.asl[1] && curMove.move !== "drift";
    // a base cut sooner than asl.min after the move began is swallowed (k12_storybook: every narrator sentence and
    // reaction cut re-picked a move, 3 cuts in 1.5 s); a scene start/end, an entrance and a new room still cut
    const t = ev.tags ?? {};
    /** a narration about an actor the running frame does not hold (Squidward v12 64–71 s: "SpongeBob waved his arms"
     *  3.7 s after Squidward's line, the close on Squidward kept, the wave off screen) */
    const subjectOut = (o: Pick<DirectorOut, "cam" | "look" | "fov"> | null | undefined): boolean => {
      if (!o || ev.kind !== "narrator" || !ev.about || speaker.name !== ev.about) return false;
      const p = ndcOf(speaker.head ?? ([speaker.pos[0], floorY + speaker.height * 0.93, speaker.pos[1]] as V3), o.cam, o.look, o.fov ?? 50, inp.aspect ?? 16 / 9);
      return !(p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1);
    };
    let walkCutDue = false;
    if (walkCutOwed && clock - moveStart >= WALK_CUT_S) {
      walkCutOwed = false;
      if (walkers.length > 0) {
        if (cutSeq === moveCut) cutSeq++;
        walkCutDue = true;
      }
    }
    const mustCut = curMove === null || !!(t.first || t.last || t.enter) || key !== moveRoom || ev.kind === "line" || subjectOut(curMove) || lostRecut || walkCutDue;
    if (cutSeq !== moveCut && !driftNow && !mustCut && clock - moveStart < style.asl[0]) {
      if (walkChanged && walkers.length > 0) walkCutOwed = true;
      moveCut = cutSeq;
    }
    // "shoot rarely, shoot true" (accent styles): a beat that is not a scene start/end, an entrance, a look or a
    // spoken line gets the base planner's frame, the readable legacy wide of restage12
    const mustCutBase = !!(t.first || t.last || t.enter) || key !== shownRoom || lostRecut;
    // the owed cut on a walk is the move picker's (a walking speaker is followed), not the base planner's still wide
    const accentBeat = !!(t.first || t.last || t.enter || t.look) || ev.kind === "line" || walkCutDue;
    /** a frame holding a head the probe does not see (v22 21–24.6 s: the base two-shot, unblock found no clear point,
     *  held SpongeBob behind the chair backs 3.5 s): the base planner's frame is not kept, the move picker frames it */
    const hidesHead = (o: DirectorOut): boolean => !!inp.clear && crew.some((a) => {
      if (a.offstage) return false;
      const h = a.head ?? ([a.pos[0], floorY + a.height * 0.93, a.pos[1]] as V3);
      const p = ndcOf(h, o.cam, o.look, o.fov ?? 50, inp.aspect ?? 16 / 9);
      return p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && !probePoints(a, h).every((q) => inp.clear!(o.cam, q));
    });
    /** a plan on a standing subject taken from behind her (Koshakan k2 27–29 s: the base two-shot over Mama's back
     *  while the narrator read about her); a wide and a walker are let be */
    const showsBack = (o: DirectorOut): boolean => {
      if (o.plan === "wide" || o.plan === "master" || speaker.walking || speaker.offstage) return false;
      const fd = faceDir(speaker);
      if (!fd) return false;
      const p = ndcOf(speaker.head ?? ([speaker.pos[0], floorY + speaker.height * 0.93, speaker.pos[1]] as V3), o.cam, o.look, o.fov ?? 50, inp.aspect ?? 16 / 9);
      return p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && angleBetween(fd, [o.cam[0] - speaker.pos[0], o.cam[2] - speaker.pos[1]]) > NARRATION_FACE_OK;
    };
    const baseHidden = !!style.accent && !accentBeat && (curMove === null || cutSeq !== moveCut) && (hidesHead(out) || showsBack(out));
    if (baseHidden) {
      moveCut = NaN;
      recut = true;  // its own cut id: the runtime cuts to the new frame, it does not glide out of the hidden one
    }
    if (style.accent && (curMove === null || cutSeq !== moveCut) && !accentBeat && !baseHidden) {
      moveCut = cutSeq;
      curMove = null;
      // the base cuts no sooner than asl.min either: a too-early cut keeps the frame on screen
      if (shown && out.cut !== shown.out.cut && !mustCutBase && clock - shown.at < style.asl[0] && !hidesHead(shown.out) && !showsBack(shown.out) && !subjectOut(shown.out)) return { ...out, cam: shown.out.cam, look: shown.out.look, plan: shown.out.plan, cut: shown.out.cut };
      if (!shown || out.cut !== shown.out.cut) {
        shown = { out, at: clock };
        shownRoom = key;
      }
      else shown.out = out;
      return styleWarn.length ? { ...out, warnings: styleWarn } : out;
    }
    // Squidward v19 20–24 s: the frame saw SpongeBob at the cut, then he turned and his head went behind a chair back;
    // the frame held him hidden four seconds. A held still frame that loses a head it holds is cut again.
    // A move is judged where its camera is by now (v21 19–24 s: a crane_down on SpongeBob coming in held him behind
    // the chair backs to its end): start to end over its duration, a look on an actor at that actor's head now.
    if (curMove && inp.clear && cutSeq === moveCut && !driftNow) {
      const mv = curMove;
      const u = mv.end ? Math.min(1, Math.max(0, (clock - moveStart) / Math.max(0.1, mv.moveDurationS ?? 1))) : 0;
      const mix = (a: V3, b: V3 | undefined): V3 => (b ? [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u] : a);
      const refHead = (r: ShotLook | undefined): V3 | null => {
        if (!r || Array.isArray(r)) return null;
        const a = crew.find((x) => x.name === (r as any).actor);
        if (!a?.head) return null;
        const o = ((r as any).o ?? [0, 0, 0]) as V3;
        return [a.head[0] + o[0], a.head[1] + o[1], a.head[2] + o[2]];
      };
      const cam = mix(mv.cam, mv.end);
      const look = refHead(u > 0.5 ? mv.lookEndRef ?? mv.lookRef : mv.lookRef) ?? mix(mv.look, mv.lookEnd);
      const f = (mv.fov ?? 50) + ((mv.fovEnd ?? mv.fov ?? 50) - (mv.fov ?? 50)) * u;
      const lost = crew.some((a) => {
        if (a.offstage) return false;
        const h = a.head ?? ([a.pos[0], floorY + a.height * 0.93, a.pos[1]] as V3);
        const p = ndcOf(h, cam, look, f, inp.aspect ?? 16 / 9);
        return p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && !probePoints(a, h).every((q) => inp.clear!(cam, q));
      });
      hiddenFor = lost ? hiddenFor + (ev.dt ?? 0) : 0;
      if (hiddenFor >= HIDDEN_RECUT_S) {
        hiddenFor = 0;
        recut = true;
        moveCut = NaN;
      }
    } else hiddenFor = 0;
    if (cutSeq !== moveCut || driftNow) {
      if (cutSeq !== moveCut) {
        shown = null;
        // a re-cut of the same beat gets its own cut id (the runtime cuts on a new id)
        heldCut = recut ? cutSeq + ++recuts / 1000 : cutSeq;
        recut = false;
        moveStart = clock;
        moveRoom = key;
      }
      moveCut = cutSeq;
      curMove = null;
      faceBase = null;
      const tags = ev.tags ?? {};
      const carried = carryWarn;
      carryWarn = [];
      // К3м2 r4/r6: each cut takes exactly one draw from the shared rng and runs on its own stream from it, so a
      // forced cut (no pickMove) moves the shared stream as much as the director's own pick and other beats keep their moves
      // the first value of the cut stream is the shared draw itself (a constant test rng still picks as in К2)
      const v0 = rng();
      let cs = Math.floor(v0 * 4294967296) >>> 0;
      let first = true;
      const cutRng = (): number => {
        if (first) {
          first = false;
          return v0;
        }
        return (cs = (Math.imul(cs, 1664525) + 1013904223) >>> 0) / 4294967296;
      };
      // a cut for a head the frame lost takes the room in (a random pick put the close back on the one left in view)
      const ownPick = (): { id: string; warnings: string[] } => driftNow ? { id: "drift", warnings: [] as string[] } : lostRecut ? { id: "wide", warnings: [] as string[] } : pickMove(style, tags, cutRng, { line: ev.kind === "line", noWalk: walkers.length === 0, walking: walkers.some((w) => w.name === speaker.name) });
      /** the move being tried (its id labels the frame) */
      let pk: { id: string; warnings: string[] } = { id: "", warnings: [] };
      let frontalRejected = false;
      // style wishes (height, fov); legalCameraPoint keeps the last word at runtime
      const hiY = Math.max(floorY + 0.3, height - 0.3);
      const lo = Math.min(floorY + style.height[0], hiY);
      const hi = Math.max(lo, Math.min(floorY + style.height[1], hiY));
      const cy = (v: V3): V3 => [v[0], Math.min(hi, Math.max(lo, v[1])), v[2]];
      const cf = (f: number): number => Math.min(style.fov[1], Math.max(style.fov[0], f));
      const headOf = (a: DActor): V3 => a.head ?? [a.pos[0], floorY + a.height * 0.93, a.pos[1]];
      /** shoot true: every subject's head inside the frame (k12_calm 6–16 s: the establishing master aimed at the
       *  room, Mirai lying under the frame; 30 s: a close over lying Mirai showed Mama alone, huge) */
      const inView = (who: DActor[], cam: V3, look: V3, fov: number): boolean => who.every((a) => {
        const p = ndcOf(headOf(a), cam, look, fov, inp.aspect ?? 16 / 9);
        return p.depth > 0.2 && Math.abs(p.x) <= IN_FRAME && Math.abs(p.y) <= IN_FRAME;
      });
      /** on a spoken line the camera stands in front of the speaker (k18_true 34–45 s: the two-shot sat behind Mama,
       *  her line was the back of her head) */
      const sf = ev.kind === "line" ? faceDir(speaker) : null;
      // off a line (narration, a walk, a recut) a standing subject is not shot from behind either, with a looser limit;
      // a walker may be followed (Koshakan k2 27–29 s: "Mama bent down..." over the back of her head)
      const nf = !sf && !speaker.walking && !speaker.offstage ? faceDir(speaker) : null;
      const faces = (cam: V3): boolean => {
        const to: V2 = [cam[0] - speaker.pos[0], cam[2] - speaker.pos[1]];
        if (sf) return angleBetween(sf, to) <= WIDE_FACE_OK;
        return !nf || angleBetween(nf, to) <= NARRATION_FACE_OK;
      };
      /** the probe sees every subject's head from `cam` (no probe: always) */
      const seesAll = (who: DActor[], cam: V3): boolean => !inp.clear || who.every((a) => probePoints(a, headOf(a)).every((q) => inp.clear!(cam, q)));
      const pt = (l: ShotLook): V3 => {
        if (Array.isArray(l)) return l as V3;
        const a = crew.find((x) => x.name === (l as any).actor);
        const h: V3 = a?.head ?? [a?.pos[0] ?? 0, (a?.height ?? 1.5) * 0.93, a?.pos[1] ?? 0];
        const o = (l as any).o as V3;
        return [h[0] + o[0], h[1] + o[1], h[2] + o[2]];
      };
      // pair atoms (ots/two/reaction) need the second actor; a "long" style keeps one pair plan across alternating lines
      const subjOf = (at: string, forced: MoveSubject | null = null): { subj: MoveSubject; usePair: boolean; who: DActor[]; whoName: string } => {
        const pairAtom = at === "ots" || at === "two" || at === "close_reaction";
        const roomAtom = at === "wide" || at === "master";
        if (forced) {
          // a forced pair atom on one actor takes the nearest other as the second (К3м2)
          let subj: MoveSubject = forced;
          let whoName = speaker.name;
          if (pairAtom && "actor" in forced) {
            const other = nearestOther(crew, crew.find((x) => x.name === forced.actor)!);
            if (other) {
              subj = { pair: [forced.actor, other.name] };
              whoName = other.name;
            }
          }
          const names = "pair" in subj ? subj.pair : "actor" in subj ? [subj.actor] : [];
          const who = "room" in subj ? crew.filter((a) => !a.offstage) : crew.filter((a) => names.includes(a.name));
          return { subj, usePair: "pair" in subj, who, whoName };
        }
        const usePair = Boolean(listener) && !roomAtom && at !== "close" && (pairAtom || style.cut === "long");
        const subj: MoveSubject = roomAtom ? { room: true } : usePair ? { pair: [speaker.name, listener!.name] } : { actor: (at === "close" && pk.id === "reaction_cut" && listener ? listener : speaker).name };
        const names = "pair" in subj ? subj.pair : "actor" in subj ? [subj.actor] : [];
        const who = roomAtom ? crew.filter((a) => !a.offstage) : crew.filter((a) => names.includes(a.name));
        return { subj, usePair, who, whoName: speaker.name };
      };
      const attempt = (at: string, forced: MoveSubject | null = null, extra: string[] = []): typeof curMove => {
        const { subj, usePair, who, whoName } = subjOf(at, forced);
        try {
          const r = resolveMove(at, subj, {
            actors: crew, room: inp.room, fov: (style.fov[0] + style.fov[1]) / 2, aspect: inp.aspect ?? 16 / 9,
            durationS: ev.durationS ?? style.asl[0], rng: cutRng, speaker: whoName, clear: inp.clear,
            // a walker's straight route: where it ends, from its heading and what is left of the walk
            walk: Object.fromEntries(crew.filter((a) => a.walking).map((a) => [a.name, { to: walkGoal(a) }])),
            side: st.side && st.origin && st.normal ? { origin: st.origin, normal: st.normal, sign: st.side } : undefined,
          });
          if (forced && r.warnings.includes("MOVE_NO_LEGAL_POINT")) return null;
          // К2 p.9: a plan labelled frontal must face the face (<= 10 deg), else it is not a frontal plan
          if (at === "frontal") {
            const fa = crew.find((x) => x.name === ("actor" in subj ? subj.actor : "pair" in subj ? subj.pair[0] : speaker.name));
            if (fa) {
              const d = Math.abs((((Math.atan2(r.from.pos[0] - fa.pos[0], r.from.pos[2] - fa.pos[1]) / DEG - (fa.faceYaw ?? fa.yaw)) % 360) + 540) % 360 - 180);
              if (d > 10 + 1e-6) {
                frontalRejected = true;
                return null;
              }
            }
          }
          const sh = Math.min(style.shake[1], Math.max(style.shake[0], r.shake));
          r.from.pos = cy(r.from.pos);
          // a move without its own fov takes the middle of the style's range (cf(undefined) was NaN)
          const fovMid = (style.fov[0] + style.fov[1]) / 2;
          r.from.fov = cf(r.from.fov ?? fovMid);
          if (r.end) {
            r.end.pos = cy(r.end.pos);
            r.end.fov = cf(r.end.fov ?? r.from.fov);
          }
          const mv = {
            cam: r.from.pos, look: pt(r.from.look), ...(Array.isArray(r.from.look) ? {} : { lookRef: r.from.look as ShotLook }),
            ...(r.end ? { end: r.end.pos, lookEnd: pt(r.end.look), ...(Array.isArray(r.end.look) ? {} : { lookEndRef: r.end.look as ShotLook }), fovEnd: r.end.fov } : {}),
            fov: r.from.fov, ease: r.ease, shake: style.move === 0 ? 0 : sh, move: forced ? at : pk.id,
            warnings: [...styleWarn, ...carried, ...extra, ...pk.warnings, ...r.warnings], moveDurationS: ev.durationS ?? style.asl[0],
          };
          if (!inView(who, mv.cam, mv.look, mv.fov) || (mv.end && mv.lookEnd && !inView(who, mv.end, mv.lookEnd, mv.fovEnd ?? mv.fov))) return null;
          if (!faces(mv.cam) || (mv.end && !faces(mv.end))) return null;
          // an occluded move (moves.ts found no clear one) or a start the probe rejects is not kept: the next try or
          // the base frame takes over (Squidward, Nov 3: the close stood in the easel's canvas)
          if (r.warnings.includes("MOVE_OCCLUDED") || !seesAll(who, mv.cam)) return null;
          curPair = usePair;
          pairNames = usePair ? [speaker.name, listener!.name] : [];
          return mv;
        } catch {
          return null;
        }
      };
      /** a still two-shot from the speaker's front: a ring of points round the pair, inside the room, both heads in
       *  frame, nothing in the way; the one most square to her face (k18_true: in the 3.6 m bedroom the base two and
       *  the wide both stood behind Mama, the free corner was across the bed) */
      const faceTwo = (): DirectorOut | null => {
        if (!sf || !listener) return null;
        const pair = [speaker, listener];
        const hs = pair.map(headOf);
        const look: V3 = [(hs[0][0] + hs[1][0]) / 2, (hs[0][1] + hs[1][1]) / 2, (hs[0][2] + hs[1][2]) / 2];
        const fov = (style.fov[0] + style.fov[1]) / 2;
        const outline = inp.room.outline;
        const rect = roomRect(outline);
        let best: { o: DirectorOut; score: number } | null = null;
        for (const d of [2.6, 2.2, 1.8, 1.4])
          for (let k = 0; k < 24; k++) {
            const r = k * 15 * DEG;
            const p = snap(outline, [look[0] + Math.sin(r) * d, look[2] + Math.cos(r) * d], rect, 0.25);
            const cam = cy([p[0], look[1] + 0.35, p[1]]);
            if (Math.hypot(cam[0] - look[0], cam[2] - look[2]) < 1.2) continue;
            if (!inView(pair, cam, look, fov) || !faces(cam)) continue;
            if (inp.clear && !pair.every((a, i) => probePoints(a, hs[i]!).every((q) => inp.clear!(cam, q)))) continue;
            const score = angleBetween(sf, [cam[0] - speaker.pos[0], cam[2] - speaker.pos[1]]) + Math.abs(d - 2.2) * 10;
            if (!best || score < best.score) best = { o: { ...out, plan: "two", cam, look, fov }, score };
          }
        return best?.o ?? null;
      };
      // the picked move; a pair that it loses gets a two-shot; then the base frame if it sees the subjects, else the
      // base wide; both still, at the style's height (ozu stays low)
      curPair = false;
      pairNames = [];
      // Spark's move for the beat (К3м2): pickMove is not called and tags are not applied; a move it cannot place
      // falls back to the director's own pick with FORCED_FALLBACK
      const f = driftNow ? undefined : ev.forced;
      const fw: string[] = [];
      if (f) {
        const names = "actor" in f.subject ? [f.subject.actor] : "pair" in f.subject ? f.subject.pair : [];
        if (names.every((n) => crew.some((x) => x.name === n))) {
          pk = { id: f.move, warnings: [] };
          curMove = attempt(SCHEME_ATOM[f.move] ?? f.move, f.subject);
        }
        if (!curMove) fw.push(`FORCED_FALLBACK B${ev.beat} ${f.move}`);
      }
      let atom = "";
      if (!curMove) {
        pk = ownPick();
        atom = SCHEME_ATOM[pk.id] ?? pk.id;
        // a lying listener has no shoulder: over it the ots framed Mama alone, huge (k12_calm 32–40 s) -> a two-shot
        if (atom === "ots" && listener && (listener.lying || speaker.lying)) atom = "two";
        curMove = attempt(atom, null, fw) ?? (listener && atom !== "two" && atom !== "close" && !subjOf(atom).subj.hasOwnProperty("room") ? attempt("two", null, fw) : null);
        if (!curMove && frontalRejected) {
          pk = { id: "medium", warnings: [] };
          curMove = attempt("medium", null, [...fw, "FRONTAL_REJECTED"]);
        }
      }
      if (curMove) {
        const a = crew.find((x) => x.name === speaker.name);
        const fd = a ? faceDir(a) : null;
        if (a && fd) faceBase = { name: a.name, dir: fd };
      } else {
        const who = subjOf(atom).who;
        // judged as it will be shot: at the style's height and fov (k18 0.9: a low base saw both at 0.35 m, lost Mirai at 1.1 m)
        const fit = (o: DirectorOut): DirectorOut => ({ ...o, cam: cy(o.cam), fov: cf(o.fov ?? (style.fov[0] + style.fov[1]) / 2) });
        const [b0, wide] = [out, frame("wide", speaker, frameOther, crew, walkers, inp, 0, clock, cutSeq, st, snap, speaker)].map(fit);
        const sees = (o: DirectorOut): boolean => inView(who, o.cam, o.look, o.fov ?? 50);
        // every candidate asks the probe; none clear -> the wide turned off the furniture (unblock)
        const ok = (o: DirectorOut): boolean => sees(o) && seesAll(who, o.cam);
        const good = [b0, wide].find((o) => ok(o) && faces(o.cam)) ?? faceTwo();
        // a pair no clear frame holds (Squidward 25 s: SpongeBob at the door 4.4 m off, chairs between): the speaker's
        // close, before a base frame that shows the chairs
        const close = !good && ev.kind === "line" && atom !== "close" ? attempt("close", null, fw) : null;
        if (close) curMove = { ...close, warnings: [...(close.warnings ?? []), `MOVE_OUT_OF_FRAME ${pk.id}`] };
        else {
          const base = good ?? [b0, wide].find(ok) ?? unblock(wide, inp, snap, cameraLaw);
          curMove = { cam: base.cam, look: base.look, fov: base.fov, shake: 0, warnings: [...styleWarn, ...carried, ...fw, `MOVE_OUT_OF_FRAME ${pk.id}`] };
          trackName = walkers.some((w) => w.name === speaker.name) ? speaker.name : null;
          trackMove = curMove;
        }
      }
    }
    // a still camera on the path of a walking speaker is put off it (Squidward v24 134–136 s: follow_side came out
    // still, 0.4 m off their way to the door; they walked through the lens): the camera moves aside, 1.2 m off the
    // line he walks, at its cut only
    // (v35 141.9–144 s: and off the path of everyone else walking, Squidward trudging after SpongeBob past the lens)
    if (curMove && !curMove.end && moveStart === clock && walkers.length) {
      const q = offWalkPaths([curMove.cam[0], curMove.cam[2]], walkers, snap, inp.room.outline, speaker.name);
      if (q[0] !== curMove.cam[0] || q[1] !== curMove.cam[2]) curMove = { ...curMove, cam: [q[0], curMove.cam[1], q[1]] };
    }
    if (!curMove) return out;
    // a still frame turns after a walking speaker, the director's fallback's or a move that came out still (v24 141–145 s)
    // once on him the frame stays on him to its end (he stops where it turned to, not where it was cut)
    if (!curMove.end && trackMove !== curMove && walkers.some((a) => a.name === speaker.name)) {
      trackName = speaker.name;
      trackMove = curMove;
    }
    const tracked = !curMove.end && trackName && trackMove === curMove ? crew.find((a) => a.name === trackName) : undefined;
    if (tracked) return { ...out, ...curMove, look: tracked.head ?? [tracked.pos[0], (inp.room.floorY ?? 0) + tracked.height * 0.93, tracked.pos[1]], cut: heldCut };
    return { ...out, ...curMove, cut: heldCut };
  };

  // the last word on every frame: no steep look down (capTilt), nobody in the room cut by its edge (cleanEdges)
  const tilt = steadyTilt();
  return {
    step: (inp: DirectorInput): DirectorOut =>
      (lastOut = cleanEdges(tilt(step(inp), inp.room.floorY ?? 0, inp.clear, inp.actors, inp.room.outline), inp.actors, inp.aspect ?? 16 / 9, { clear: inp.clear })),
  };
}

/** what the probe must see of an actor: the face and the eye (`DActor.eye`, where the film critic asks) both; without
 *  them the head point stands in (Squidward v7 21–25 s: the face point past a chair's scroll, the top of the box behind it) */
function probePoints(a: DActor, head: V3): V3[] {
  return [a.face ?? head, ...(a.eye ? [a.eye] : [])];
}

const MAX_TILT_DEG = 30, MIN_CAM_Y = 1.0;
const HIDDEN_RECUT_S = 0.75;
/** how far over the shoulder the near head keeps off the line to the subject's head, m */
const OTS_CLEAR_M = 0.45;
/** how fast the base orbit's camera drifts along its circle, m/s */
const ORBIT_DRIFT_MS = 0.4;
/** a cut on a walk's start comes this long after the last cut at the soonest (a cut on the action, not asl.min) */
const WALK_CUT_S = 1.5;
/** a still camera stands at least this far off the line a walking speaker walks */
const PATH_CLEAR_M = 1.2;
/** ... and this far off the line anyone else walks: a 1.8 m walker passing it whole in a 50° frame from 1.1 m up */
const OTHER_PATH_CLEAR_M = 2.0;
/** A held frame looks down at most 30° (Squidward, Nov 3, 16–21 s: the wide for SpongeBob entering stood 2.6 m high,
 *  2.3 m off his 0.57 m head — 41° down, the top of his head and the floor). The camera comes straight down (never under
 *  1 m over the floor), else backs off along the look line inside the room, else takes the lowest height over its spot
 *  that `clear` sees from. A move (`end`) and a frame on someone lying
 *  (a look from above at a bed is meant) keep theirs. */
export function capTilt<T extends DirectorOut>(out: T, floorY: number, clear?: (cam: V3, look: V3) => boolean, crew: DActor[] = [], outline: V2[] = []): T {
  if (out.end) return out;
  const [cx, cy, cz] = out.cam;
  const L = out.look;
  const tan = Math.tan((MAX_TILT_DEG * Math.PI) / 180);
  const flat = Math.hypot(L[0] - cx, L[2] - cz);
  if (Math.atan2(cy - L[1], flat) <= (MAX_TILT_DEG * Math.PI) / 180 + 1e-9) return out;
  if (crew.some((a) => a.lying && Math.hypot(a.pos[0] - L[0], a.pos[1] - L[2]) < 1.2)) return out;
  // what the frame must see is the heads in it, not its look point (a two-shot looks between them: v17, the line to
  // the middle went through the canvas and every lower camera was "blocked")
  const fov = out.fov ?? 50;
  const heads = crew
    .filter((a) => !a.offstage)
    .filter((a) => { const p = ndcOf(a.head ?? ([a.pos[0], (a.height ?? 1.7) * 0.93, a.pos[1]] as V3), out.cam, L, fov, 16 / 9); return p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1; })
    .flatMap((a) => probePoints(a, a.head ?? ([a.pos[0], (a.height ?? 1.7) * 0.93, a.pos[1]] as V3)));
  const sees = (c: V3): boolean => !clear || (heads.length ? heads.every((h) => clear(c, h)) : clear(c, L));
  const y0 = Math.max(floorY + MIN_CAM_Y, L[1] + flat * tan);
  if (y0 >= cy) return out;
  // 1) straight down
  if (sees([cx, y0, cz])) return { ...out, cam: [cx, y0, cz] };
  // 2) back along the flat look line, each height from the low point up, as far as 30° needs (inside the room)
  const u: V2 = flat > 1e-6 ? [(cx - L[0]) / flat, (cz - L[2]) / flat] : [1, 0];
  for (let y = y0; y < cy - 1e-9; y += 0.15) {
    const d = (y - L[1]) / tan;
    if (d <= flat) continue;
    const c: V3 = [L[0] + u[0] * d, y, L[2] + u[1] * d];
    if (outline.length >= 3 && !insideInset(outline, [c[0], c[2]])) continue;
    if (sees(c)) return { ...out, cam: c };
  }
  // 2b) round the look point at 30°, nearest side first, the same flat reach (v14 66–85 s: the easel and a chair back
  // stood on the frame's own line, the two-shot stayed 45° over the heads for 19 s)
  const reachD = Math.max(flat, (y0 - L[1]) / tan);
  const yR = L[1] + reachD * tan;
  if (yR >= floorY + MIN_CAM_Y - 1e-9) {
    const a0 = Math.atan2(u[1], u[0]);
    for (let k = 1; k <= 6; k++) {  // up to 90°: the far half would cross the line between them
      for (const sgn of [1, -1]) {
        const a = a0 + sgn * k * (Math.PI / 12);
        const c: V3 = [L[0] + Math.cos(a) * reachD, yR, L[2] + Math.sin(a) * reachD];
        if (outline.length >= 3 && !insideInset(outline, [c[0], c[2]])) continue;
        if (sees(c)) return { ...out, cam: c };
      }
    }
  }
  // 3) the lowest clear height over the same spot: less steep, if not 30°
  for (let y = y0 + 0.15; y < cy - 1e-9; y += 0.15) if (sees([cx, y, cz])) return { ...out, cam: [cx, y, cz] };
  return out;
}

/** A still camera point put off the line every walker has left to walk (straight ahead, `walkLeft`): PATH_CLEAR_M off
 *  the one the frame holds (`held`), OTHER_PATH_CLEAR_M off anyone else (v36 141–143.5 s: Squidward trudging 1.2 m past
 *  a 1.1 m high camera was a body filling the frame). Pushed out from the nearest point of a path it stands on, a few
 *  passes for paths that cross. */
/** where a walker's route ends: the runtime's goal, else guessed from where it faces (Squidward v39 149.6 s: he came
 *  into the pineapple facing south, his route went south-east; a follow beside the guess stood on his real path) */
export function walkGoal(a: DActor): V2 {
  if (a.walkTo) return a.walkTo;
  const L = a.walkLeft ?? 2;
  return [a.pos[0] + Math.sin(a.yaw * DEG) * L, a.pos[1] + Math.cos(a.yaw * DEG) * L];
}
export function offWalkPaths(c0: V2, walkers: DActor[], snap: SnapFn, outline: V2[], held?: string): V2 {
  let c = c0;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const w of walkers) {
      const g = walkGoal(w);
      const gl = Math.hypot(g[0] - w.pos[0], g[1] - w.pos[1]);
      const f: V2 = gl > 1e-6 ? [(g[0] - w.pos[0]) / gl, (g[1] - w.pos[1]) / gl] : faceOf(w.yaw);
      const L = Math.max(0.5, gl);
      const along = Math.max(0, Math.min(L, (c[0] - w.pos[0]) * f[0] + (c[1] - w.pos[1]) * f[1]));
      const near: V2 = [w.pos[0] + f[0] * along, w.pos[1] + f[1] * along];
      const off = Math.hypot(c[0] - near[0], c[1] - near[1]);
      const need = w.name === held ? PATH_CLEAR_M : OTHER_PATH_CLEAR_M;
      if (off >= need - 1e-9) continue;
      const n: V2 = off > 1e-3 ? [(c[0] - near[0]) / off, (c[1] - near[1]) / off] : [f[1], -f[0]];
      const p: V2 = [near[0] + n[0] * need * 1.001, near[1] + n[1] * need * 1.001];
      c = outline.length >= 3 ? snap(outline, p, roomRect(outline), 0.25) : p;
      moved = true;
    }
    if (!moved) break;
  }
  return c;
}

/** capTilt for a director that holds its frames: a still frame (the same cut, the camera where the director left it)
 *  is placed by capTilt once and stays there; a look that gets steeper later (a walker coming up under the camera) is
 *  lifted to 30°, the camera does not move (Squidward v34 141.5–144 s: re-placed every tick, a metre between ticks). */
export function steadyTilt(): typeof capTilt {
  let held: { cut: number; raw: V3; cam: V3 } | null = null;
  return (out, floorY, clear, crew = [], outline = []) => {
    if (out.end) {
      held = null;
      return out;
    }
    const same = held && held.cut === out.cut && Math.hypot(held.raw[0] - out.cam[0], held.raw[1] - out.cam[1], held.raw[2] - out.cam[2]) < 1e-6;
    if (!same) {
      const o = capTilt(out, floorY, clear, crew, outline);
      held = { cut: out.cut, raw: out.cam, cam: o.cam };
      return o;
    }
    const cam = held!.cam;
    const L = out.look;
    const flat = Math.hypot(L[0] - cam[0], L[2] - cam[2]);
    const lowest = cam[1] - flat * Math.tan((MAX_TILT_DEG * Math.PI) / 180);
    const look: V3 = L[1] < lowest ? [L[0], lowest, L[2]] : L;
    return { ...out, cam, look };
  };
}

const EDGE_IN = 0.9, EDGE_OUT = 1.3;
/** unblock's first pass keeps the camera this far (m, flat) from every actor */
const UNBLOCK_OFF_BODY = 1.2;
/** Nobody in the room is cut by the frame's edge (Squidward, Nov 3, v6 18–36 s: Squidward's head at ndc x 1.1–1.37,
 *  half a head at the side of SpongeBob's frame). A head between EDGE_IN and EDGE_OUT of the frame is cut: first the
 *  look re-aims at the middle of the heads in view and the fov widens (up to `maxFov`) until all are inside; else the
 *  look turns (up to 25°) until the cut one is out and the rest stay in; else the frame stays. A move (`end`)
 *  gets its end frame cleaned (look, fov). `clear` (the sight probe) must see every head the new frame keeps. */
export function cleanEdges<T extends DirectorOut>(out: T, crew: DActor[], aspect: number, o: { maxFov?: number; clear?: (cam: V3, look: V3) => boolean } = {}): T {
  // the head and the face of each (a box figure's face stands in at the edge while its head bone is past it)
  const heads = crew.filter((a) => !a.offstage).flatMap((a) => [a.head ?? ([a.pos[0], (a.height ?? 1.7) * 0.93, a.pos[1]] as V3), ...(a.face ? [a.face] : [])]);
  const reach = (cam: V3, look: V3, fov: number, h: V3): number => {
    const p = ndcOf(h, cam, look, fov, aspect);
    return p.depth <= 0.2 ? Infinity : Math.max(Math.abs(p.x), Math.abs(p.y));
  };
  const isCut = (cam: V3, look: V3, fov: number): boolean => heads.some((h) => { const r = reach(cam, look, fov, h); return r > EDGE_IN && r < EDGE_OUT; });
  // a move: its end frame (where it holds) gets the same word — its look and fov, never its path (Squidward v16 60–69 s:
  // a push_in ended with SpongeBob's head on the bottom edge and held it nine seconds)
  if (out.end) {
    const endFrame = { ...out, cam: out.end, look: out.lookEnd ?? out.look, fov: out.fovEnd ?? out.fov, end: undefined };
    const fixed = cleanEdges(endFrame, crew, aspect, o);
    const withEnd = fixed === endFrame ? out : { ...out, lookEnd: fixed.look, fovEnd: fixed.fov, lookEndRef: undefined };
    // and where it begins (Koshakan k2 29–31 s: a push_in began with lying Mirai's head on the bottom edge and slid
    // it out over two seconds; the end frame, where she was gone, passed)
    const startFrame = { ...withEnd, end: undefined };
    const s = cleanEdges(startFrame, crew, aspect, o);
    if (s === startFrame) return withEnd;
    // a look on an actor keeps following him, shifted as the fix turned it (a walker's follow stays on the walker)
    const ref = withEnd.lookRef as { actor?: string; o?: V3 } | undefined;
    if (ref && typeof ref === "object" && ref.actor) {
      const d: V3 = [s.look[0] - withEnd.look[0], s.look[1] - withEnd.look[1], s.look[2] - withEnd.look[2]];
      const o = ref.o ?? [0, 0, 0];
      return { ...withEnd, look: s.look, fov: s.fov, lookRef: { ...ref, o: [o[0] + d[0], o[1] + d[1], o[2] + d[2]] } as any };
    }
    return { ...withEnd, look: s.look, fov: s.fov, lookRef: undefined };
  }
  const fov0 = out.fov ?? 50;
  if (!isCut(out.cam, out.look, fov0)) return out;
  const held = out;
  const sees = (look: V3, keep: V3[]): boolean => !o.clear || keep.every((h) => o.clear!(out.cam, h));
  const cam = out.cam;
  // 1) all the heads near the frame in: aim at their middle, widen
  const near = heads.filter((h) => reach(cam, out.look, fov0, h) < EDGE_OUT);
  if (near.length) {
    const mid: V3 = [0, 1, 2].map((k) => near.reduce((s, h) => s + h[k], 0) / near.length) as V3;
    for (let fov = fov0; fov <= Math.max(fov0, o.maxFov ?? 70) + 1e-9; fov += 2) {
      if (near.every((h) => reach(cam, mid, fov, h) < EDGE_IN - 0.05) && !isCut(cam, mid, fov) && sees(mid, near))
        return { ...held, look: mid, fov, lookRef: undefined };
    }
  }
  // 2) the cut ones out: turn the look sideways about the camera
  const inside = heads.filter((h) => reach(cam, out.look, fov0, h) <= EDGE_IN);
  const f: V3 = [out.look[0] - cam[0], out.look[1] - cam[1], out.look[2] - cam[2]];
  for (const deg of [3, -3, 6, -6, 9, -9, 12, -12, 15, -15, 20, -20, 25, -25]) {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const look: V3 = [cam[0] + f[0] * c + f[2] * s, out.look[1], cam[2] - f[0] * s + f[2] * c];
    if (!isCut(cam, look, fov0) && inside.every((h) => reach(cam, look, fov0, h) <= EDGE_IN)) return { ...held, look, lookRef: undefined };
  }
  return held;
}

/** A blocked frame turns about its look point (smallest turn first, so the 180° side mostly holds), rises, and
 *  moves in or out, until the probe sees the subject; no clear spot in the room -> legal fallback. */
export function unblock(out: DirectorOut, inp: DirectorInput, snap: SnapFn, law: CameraLaw): DirectorOut {
  const probe = inp.clear;
  if (!probe) return out;
  // the probe is asked about the heads the frame holds, not its look point (Squidward v18 20–22 s: a two-shot looked
  // between the heads, SpongeBob's head stood behind a chair back and nobody asked about it)
  const fov = out.fov ?? 50;
  const heads = inp.actors
    .filter((a) => !a.offstage)
    .filter((a) => { const p = ndcOf(a.head ?? ([a.pos[0], (inp.room.floorY ?? 0) + a.height * 0.93, a.pos[1]] as V3), out.cam, out.look, fov, inp.aspect ?? 16 / 9); return p.depth > 0.2 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1; })
    .flatMap((a) => probePoints(a, a.head ?? ([a.pos[0], (inp.room.floorY ?? 0) + a.height * 0.93, a.pos[1]] as V3)));
  const clear = (c: V3, l: V3): boolean => (heads.length ? heads.every((h) => probe(c, h)) : probe(c, l));
  if (clear(out.cam, out.look)) return out;
  const room = inp.room;
  const L = out.look;
  const v: V2 = [out.cam[0] - L[0], out.cam[2] - L[2]];
  const r0 = Math.max(0.6, Math.hypot(v[0], v[1]));
  const d0 = norm(v);
  const side = law.side;
  // first a point 1.2 m from everybody, then anywhere: the 0.55 ring about a follow's look point (1 m ahead of the
  // walker) is 0.9 m behind him, over his head (Squidward, Nov 3: the frame was the top of Squidward's head)
  const offBodies = (c: V3): boolean => inp.actors.every((a) => a.offstage || Math.hypot(c[0] - a.pos[0], c[2] - a.pos[1]) >= UNBLOCK_OFF_BODY);
  for (const keepOff of [true, false])
  for (const a of [0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 120, -120])
    for (const dy of [0, 0.35, 0.7, 1.1])
      for (const k of [1, 0.75, 1.3, 0.55]) {
        const dir = rotate(d0, a);
        const p: V3 = [L[0] + dir[0] * r0 * k, out.cam[1] + dy, L[2] + dir[1] * r0 * k];
        if (side && ((p[0] - side.origin[0]) * side.normal[0] + (p[2] - side.origin[1]) * side.normal[1]) * side.sign <= 1e-6) {
          continue;
        }
        const c = legalCameraPoint(p, law);
        if (side && ((c[0] - side.origin[0]) * side.normal[0] + (c[2] - side.origin[1]) * side.normal[1]) * side.sign <= 1e-6) {
          continue;
        }
        if (room.outline.length >= 3 && !insideInset(room.outline, [c[0], c[2]])) {
          continue;
        }
        if (keepOff && !offBodies(c)) continue;
        if (clear(c, L)) return { ...out, cam: c };
      }
  return { ...out, cam: legalCameraPoint(out.cam, law) };
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

function frame(plan: Plan, subj: DActor, other: DActor | undefined, crew: DActor[], walkers: DActor[], inp: DirectorInput, t: number, clock: number, cut: number, st: { side: 1 | -1 | null; axis: V2 | null; origin?: V2; normal?: V2; wideCut?: number }, snap: SnapFn = snapInside, gaze: DActor = subj, closeAxis: V2 | null = null, explicitPlan = false, closeOrigin: V2 | null = null): DirectorOut {
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
  const axis: V2 = pair.length > 1 ? (closeAxis ?? (dist(pair[0].pos, pair[1].pos) < 0.3 ? (faceDir(gaze) ?? [0, 1]) : norm([pair[1].pos[0] - pair[0].pos[0], pair[1].pos[1] - pair[0].pos[1]]))) : (faceDir(subj) ?? [0, 1]);
  const origin: V2 = pair.length > 1 && closeOrigin ? closeOrigin : m;
  const n: V2 = [-axis[1], axis[0]];
  // persistent 180° side: reselected only when the axis turned by more than 90°
  let side: 1 | -1 = 1;
  if (pair.length > 1) {
    if (st.axis && st.side !== null && angleBetween(axis, st.axis) <= 90) side = st.side;
    else {
      const toCenter = (center[0] - origin[0]) * n[0] + (center[1] - origin[1]) * n[1];
      side = toCenter < 0 ? -1 : 1;
      st.side = side;
      st.axis = axis;
    }
    st.origin = origin;
    st.normal = n;
  } else {
    st.origin = undefined;
    st.normal = undefined;
  }
  const onSide = (pt: V2): boolean => ((pt[0] - origin[0]) * n[0] + (pt[1] - origin[1]) * n[1]) * side > 1e-6;
  let sideDir: V2 = pair.length > 1 ? [n[0] * side, n[1] * side] : norm([center[0] - origin[0], center[1] - origin[1]]);
  const span = pair.length > 1 ? dist(pair[0].pos, pair[1].pos) : 0;
  const meanH = pair.reduce((s, a) => s + a.height, 0) / pair.length;
  const head = (a: DActor, k = 0.9): V3 => a.head ?? at(a.pos, a.height * k);
  /** camera height above the floor a little under the eyes: the measured head when known */
  const eyeCam = (a: DActor): number => (a.head ? Math.max(0.5, a.head[1] - floorY - 0.1 * a.height) : a.height * 0.8);
  let cameraSide: CameraSide | undefined = pair.length > 1 ? { origin, normal: n, sign: side } : undefined;
  /** cross the line: only a fresh wide does it (it re-establishes the geography); every closure reads the new side */
  const setSide = (sg: 1 | -1): void => {
    side = sg;
    sideDir = [n[0] * sg, n[1] * sg];
    cameraSide = { origin, normal: n, sign: sg };
  };

  /** camera point (x, z, height above the floor) clamped into the room; fallback walks from the pair midpoint to the room center (F8) */
  const place = (x: number, z: number, y: number): V3 => {
    return legalCameraPoint([x, floorY + Math.min(y, top), z], {
      outline: room.outline,
      rect,
      height,
      floorY,
      side: cameraSide,
      fallback: fallbackFrame(origin, center, room.outline, INSET, floorY + Math.min(y, top)),
    });
  };

  /** Over the shoulder the near head sits to a side of the frame, not on the line to the subject (v30 video
   *  146–150 s: the back of Squidward's head 0.7 m from the lens filled the frame and hid SpongeBob). The camera steps
   *  sideways, the way that stays in the room and on the 180° side, until the near head is OTS_CLEAR_M off the line. */
  const shoulderAside = (cam: V3, subjHead: V3, nearHead: V3, y: number): V3 => {
    const ab: V2 = [subjHead[0] - cam[0], subjHead[2] - cam[2]];
    const L = Math.hypot(ab[0], ab[1]);
    if (L < 1e-6) return cam;
    const u: V2 = [ab[0] / L, ab[1] / L];
    const q: V2 = [nearHead[0] - cam[0], nearHead[2] - cam[2]];
    const t = (q[0] * u[0] + q[1] * u[1]) / L;
    if (t <= 0 || t >= 1) return cam;
    const lat = q[0] * -u[1] + q[1] * u[0];
    if (Math.abs(lat) >= OTS_CLEAR_M) return cam;
    for (const sgn of lat === 0 ? [1, -1] : [-Math.sign(lat), Math.sign(lat)]) {
      const need = sgn === -Math.sign(lat) || lat === 0 ? OTS_CLEAR_M - Math.abs(lat) : OTS_CLEAR_M + Math.abs(lat);
      const step = (need + 0.05) / (1 - t);
      const pt: V2 = [cam[0] - u[1] * step * sgn, cam[2] + u[0] * step * sgn];
      if (room.outline.length >= 3 && !insideInset(room.outline, pt)) continue;
      if (other && !onSide(pt)) continue;
      return place(pt[0], pt[1], y);
    }
    return cam;
  };

  /** Side wins over everything but orbit (F2): a non-orbit frame is never returned from the opposite side.
   * A point pushed across the axis by the room clamp is mirrored back; if that is still off-side, the side
   * direction from the pair midpoint is tried; the midpoint-to-center fallback is on-side by construction. */
  const toSide = (cam: V3, yAboveFloor: number, dFallback: number): V3 => {
    if (!other || onSide([cam[0], cam[2]])) return cam;
    const perp = (cam[0] - origin[0]) * n[0] + (cam[2] - origin[1]) * n[1];
    const mir = place(cam[0] - 2 * perp * n[0], cam[2] - 2 * perp * n[1], yAboveFloor);
    if (onSide([mir[0], mir[2]])) return mir;
    const along = place(origin[0] + sideDir[0] * dFallback, origin[1] + sideDir[1] * dFallback, yAboveFloor);
    if (onSide([along[0], along[2]])) return along;
    const rawFb = fallbackFrame(origin, center, room.outline, INSET, cam[1]);
    const fb = legalCameraPoint(rawFb, { outline: room.outline, rect, height, floorY, side: cameraSide });
    if (onSide([fb[0], fb[2]])) return fb;
    // the fallback landed on the axis (mid == room center): step strictly to the selected side (F7)
    const nudge = place(origin[0] + sideDir[0] * (dFallback + 0.4), origin[1] + sideDir[1] * (dFallback + 0.4), yAboveFloor);
    return onSide([nudge[0], nudge[2]]) ? nudge : (onSide([fb[0], fb[2]]) ? fb : place(center[0] + sideDir[0] * 0.4, center[1] + sideDir[1] * 0.4, yAboveFloor));
  };

  /** Rule 1: close/ots/low choose the point on the required side with the smallest angle to the face. */
  const bestFacePoint = (s: DActor, y: number, dists: number[], shoulderOffset = false): V3 => {
    // a lying actor has no face direction: the 180° side (or +z) stands in, never the body yaw
    const f: V2 = faceDir(s) ?? (other ? [n[0] * side, n[1] * side] : [0, 1]);
    const search = (withShoulder: boolean) => {
      // assigned inside `consider`: typed by a cast, or the checks below narrow it to `null` forever
      let bestUnder60 = null as { p: V3; ang: number } | null;
      let bestOver60: { p: V3; ang: number } | null = null;

      const consider = (pt: V2, ang: number) => {
        if (ang <= 60 + 1e-6) {
          if (!bestUnder60 || ang < bestUnder60.ang - 1e-6) {
            bestUnder60 = { p: place(pt[0], pt[1], y), ang };
          }
        } else {
          if (!bestOver60 || ang < bestOver60.ang - 1e-6) {
            bestOver60 = { p: place(pt[0], pt[1], y), ang };
          }
        }
      };

      const testPoint = (k: number, shIdx: number, d: number): { pt: V2; ang: number } | null => {
        const dv = rotate(f, k);
        const sh: V2 = shIdx === 0 ? [0, 0] : (shIdx === 1 ? [-dv[1] * 0.4, dv[0] * 0.4] : [dv[1] * 0.4, -dv[0] * 0.4]);
        const tx = s.pos[0] + dv[0] * d + sh[0];
        const tz = s.pos[1] + dv[1] * d + sh[1];
        if (other && !onSide([tx, tz])) return null;
        let pt: V2 = [tx, tz];
        if (room.outline.length >= 3 && !insideInset(room.outline, pt)) {
          pt = snap(room.outline, pt, rect);
          if (!insideInset(room.outline, pt)) return null;
          if (other && !onSide(pt)) return null;
        } else if (room.outline.length < 3) {
          if (pt[0] < rect.minx + INSET || pt[0] > rect.maxx - INSET || pt[1] < rect.minz + INSET || pt[1] > rect.maxz - INSET) return null;
        }
        const ang = angleBetween(f, [pt[0] - s.pos[0], pt[1] - s.pos[1]]);
        return { pt, ang };
      };

      const shIndices = withShoulder ? [0, 1, 2] : [0];

      // Analytical boundary checks for the 180° side
      if (other) {
        const n_side: V2 = [n[0] * side, n[1] * side];
        const s_dot = (s.pos[0] - origin[0]) * n[0] + (s.pos[1] - origin[1]) * n[1];
        const req = 1e-6 - s_dot * side;
        const ang_n = Math.atan2(n_side[1], n_side[0]);
        const ang_f = Math.atan2(f[1], f[0]);
        for (const shIdx of shIndices) {
          const sh_lat = shIdx === 0 ? 0 : (shIdx === 1 ? 0.4 : -0.4);
          for (const d of dists) {
            const R = Math.hypot(d, sh_lat);
            const ang_sh = Math.atan2(sh_lat, d);
            const cos_phi = (req + 1e-5) / R;
            if (Math.abs(cos_phi) <= 1) {
              const phi = Math.acos(cos_phi);
              for (const sgn of [1, -1]) {
                const dir_v = ang_n + sgn * phi;
                const dir_dv = dir_v - ang_sh;
                let k = (((dir_dv - ang_f) * 180) / Math.PI) % 360;
                if (k > 180) k -= 360;
                if (k < -180) k += 360;
                const res = testPoint(k, shIdx, d);
                if (res) consider(res.pt, res.ang);
              }
            }
          }
        }
      }

      // Check k = 0
      for (const shIdx of shIndices) {
        for (const d of dists) {
          const res = testPoint(0, shIdx, d);
          if (res) {
            consider(res.pt, res.ang);
            if (bestUnder60 && bestUnder60.ang <= 1e-3) return bestUnder60;
          }
        }
      }
      if (bestUnder60 && bestUnder60.ang <= 1e-3) return bestUnder60;

      // Sweep angles with bisection across boundaries
      for (let kAbs = 1; kAbs <= 180; kAbs++) {
        let ks: number[];
        if (other) {
          const a = rotate(f, kAbs);
          const b = rotate(f, -kAbs);
          const da = dist([s.pos[0] + a[0], s.pos[1] + a[1]], other.pos);
          const db = dist([s.pos[0] + b[0], s.pos[1] + b[1]], other.pos);
          ks = da >= db ? [kAbs, -kAbs] : [-kAbs, kAbs];
        } else {
          ks = [kAbs, -kAbs];
        }

        for (const k of ks) {
          const kPrev = k > 0 ? k - 1 : k + 1;
          for (const shIdx of shIndices) {
            for (const d of dists) {
              const res = testPoint(k, shIdx, d);
              const resPrev = testPoint(kPrev, shIdx, d);
              if (res) consider(res.pt, res.ang);
              if (!resPrev && res) {
                let lo = kPrev, hi = k;
                let cur = res;
                for (let step = 0; step < 12; step++) {
                  const mid = (lo + hi) / 2;
                  const mres = testPoint(mid, shIdx, d);
                  if (mres) {
                    hi = mid;
                    cur = mres;
                  } else {
                    lo = mid;
                  }
                }
                consider(cur.pt, cur.ang);
              } else if (resPrev && !res) {
                let lo = kPrev, hi = k;
                let cur = resPrev;
                for (let step = 0; step < 12; step++) {
                  const mid = (lo + hi) / 2;
                  const mres = testPoint(mid, shIdx, d);
                  if (mres) {
                    lo = mid;
                    cur = mres;
                  } else {
                    hi = mid;
                  }
                }
                consider(cur.pt, cur.ang);
              }
            }
          }
        }
        if (bestUnder60 && kAbs > bestUnder60.ang + (withShoulder ? 35 : 1e-3)) {
          return bestUnder60;
        }
      }
      return bestUnder60 ?? bestOver60;
    };

    const res = search(shoulderOffset);
    if (res) return res.p;

    return toSide(place(s.pos[0] + f[0] * dists[0], s.pos[1] + f[1] * dists[0], y), y, dists[0]);
  };

  let p: Plan = plan;
  // Н7б: explicit shot from bank is kept as is, including orbit and dolly for a single actor
  const isExplicit = explicitPlan;
  if (!isExplicit) {
    if (!other && (p === "ots" || p === "two")) p = p === "ots" ? "close" : "wide";
    if (!other && (p === "orbit" || p === "dolly")) p = p === "orbit" ? "wide" : "close";
    if (p === "low" && !other) p = "close";
  }
  if (p === "low" && other && subj.height <= other.height) p = "close";

  switch (p) {
    case "close": {
      return { plan: p, cut, cam: bestFacePoint(subj, eyeCam(subj), [1.6, 1.2, 0.9]), look: head(subj) };
    }
    case "ots": {
      const d0 = other ? dist(other.pos, subj.pos) + 1 : 2.5;
      const y = (other ?? subj).height * 0.9;
      const cam = bestFacePoint(subj, y, [d0, 2, 1.4, 1, 0.6], true);
      return { plan: p, cut, cam: other ? shoulderAside(cam, head(subj), head(other), y) : cam, look: head(subj) };
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
      const tanH = Math.tan(hfov / 2);
      const tanV = Math.tan(vfov / 2);
      const wy = ht * 1.15 + 0.3;
      const shoot = (du: V2): V3 => {
        const right: V2 = [-du[1], du[0]];
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
        const d = Math.max(dH, minDepth + ht * 1.4 / (2 * tanV), 2.5);
        return toSide(place(c[0] + du[0] * d, c[1] + du[1] * d, wy), wy, d);
      };
      // the worst face of the pair, measured where the walls really put the camera (Koshakan: Mama on the bed edge
      // faces Mirai along the axis; the square-on wide hit the wall and slid behind her, 130–150° off her face)
      const faces = pair.filter((a) => !a.lying);
      const worstFace = (cam: V3): number => Math.max(0, ...faces.map((a) => angleBetween(faceDir(a) ?? faceOf(a.yaw), [cam[0] - a.pos[0], cam[2] - a.pos[1]])));
      // 2 m, or less in a small room (a 3.6 m bedroom has no 2 m point in front of a seated Mama)
      const minWide = Math.min(2, 0.5 * Math.min(rect.maxx - rect.minx, rect.maxz - rect.minz));
      /** square to the side; when that misses the faces, swing inside the half-plane (never closer than 2 m) */
      const onThisSide = () => {
        const dir0 = norm(crew.length > 1 ? sideDir : [center[0] - c[0], center[1] - c[1]]);
        let best = { cam: shoot(dir0), face: 0, swing: 0 };
        best.face = worstFace(best.cam);
        if (best.face <= WIDE_FACE_OK) return best;
        // a lone subject has no 180° line: the wide may turn all the way round to the face
        const swing = pair.length > 1 ? WIDE_SWING : 180;
        for (let s = -swing; s <= swing; s += 15) {
          if (s === 0) continue;
          const r = s * DEG;
          const du: V2 = [dir0[0] * Math.cos(r) - dir0[1] * Math.sin(r), dir0[0] * Math.sin(r) + dir0[1] * Math.cos(r)];
          const cam = shoot(du);
          if (dist([cam[0], cam[2]], c) < minWide) continue; // a wide is a wide: no swing that lands at the actors' elbows
          const face = worstFace(cam);
          if (face < best.face - 1e-6 || (Math.abs(face - best.face) < 1e-6 && Math.abs(s) < Math.abs(best.swing))) best = { cam, face, swing: s };
        }
        return best;
      };
      let best = onThisSide();
      // the first frame of a wide cut may cross the line when no camera on this side sees the faces and the other
      // side does (Koshakan: the room-center side was wholly behind Mama's face); later shots keep the new side
      if (pair.length > 1 && best.face > WIDE_FACE_OK && st.wideCut !== cut) {
        const keep = side;
        setSide(side === 1 ? -1 : 1);
        const alt = onThisSide();
        if (alt.face <= WIDE_FACE_OK) {
          best = alt;
          st.side = side;
        } else setSide(keep);
      }
      st.wideCut = cut;
      // no steep look down: in a small room the 2.2 m wide looked 30–39° down and keystoned the walls (k12_calm,
      // Nov 3); the camera comes down to a grown-up's eye, then lower until the tilt is under WIDE_TILT
      const look = at(c, ht * 0.5);
      const flat = Math.hypot(best.cam[0] - look[0], best.cam[2] - look[2]);
      const y = Math.max(floorY + 0.9, Math.min(best.cam[1], floorY + WIDE_EYE, look[1] + flat * Math.tan(WIDE_TILT * DEG)));
      return { plan: p, cut, cam: [best.cam[0], y, best.cam[2]], look };
    }
    case "orbit": {
      // a drift, not a trip: 0.4 m/s along the circle whatever its radius (v28 video 100 s: 0.25 rad/s on 4.5 m
      // swung the camera 1 m in half a second and the next beat cut back near its start)
      const r = Math.max(3, span + 2.5);
      const a0 = Math.atan2(sideDir[1], sideDir[0]) + (ORBIT_DRIFT_MS / r) * t;
      return { plan: p, cut, cam: place(m[0] + Math.cos(a0) * r, m[1] + Math.sin(a0) * r, meanH * 0.8), look: at(m, meanH * 0.6) };
    }
    case "dolly": {
      const k = Math.min(1, t / 8);
      const d = 4.5 + (2.2 - 4.5) * k;
      const dir = other ? sideDir : (faceDir(subj) ?? faceOf(subj.yaw));
      const dy = eyeCam(subj);
      return { plan: p, cut, cam: toSide(place(subj.pos[0] + dir[0] * d, subj.pos[1] + dir[1] * d, dy), dy, d), look: head(subj) };
    }
    case "low": {
      return { plan: p, cut, cam: bestFacePoint(subj, 0.35, [1.8, 1.3, 1]), look: head(subj) };
    }
    default: {
      // follow: behind the walker, looking where it goes; mirrored across the pair axis when off the 180° side
      const w = walkers[0] ?? subj;
      const f = faceOf(w.yaw);
      let cam = place(w.pos[0] - f[0] * 2.5, w.pos[1] - f[1] * 2.5, w.height * 0.9);
      if (other) {
        const perp = (cam[0] - origin[0]) * n[0] + (cam[2] - origin[1]) * n[1];
        if (perp * side <= 1e-6) cam = place(cam[0] - 2 * perp * n[0], cam[2] - 2 * perp * n[1], cam[1] - floorY);
        // a camera right on the axis (or just across it) is pushed strictly to the 180° side
        const now = (cam[0] - origin[0]) * n[0] * side + (cam[2] - origin[1]) * n[1] * side;
        if (now <= 1e-6) cam = place(cam[0] + (0.4 - now) * n[0] * side, cam[2] + (0.4 - now) * n[1] * side, cam[1] - floorY);
        cam = toSide(cam, cam[1] - floorY, 2.5);
      }
      return { plan: p, cut, cam, look: at([w.pos[0] + f[0], w.pos[1] + f[1]], w.height * 0.8) };
    }
  }
}
