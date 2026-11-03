import { createLife } from "./life.js";
import { AnimationClip, AnimationMixer, LoopOnce, LoopRepeat, PropertyBinding, Quaternion, Vector3, type AnimationAction, type KeyframeTrack, type Object3D } from "three";

export interface Animator {
  play(name: string, o?: { once?: boolean }): void;
  /** advance; `talking` adds head nods to the life layer */
  update(dt: number, o?: { talking?: boolean; look?: [number, number, number] }): void;
  /** back to the idle pose (crossfade) */
  idle(): void;
  current(): string;
  /** the body has a life layer (a rig with a head or chest) */
  alive(): boolean;
  has(name: string): boolean;
  /** inspection helpers (tests, debugging) */
  weight(name: string): number;
  time(name: string): number;
  duration(name: string): number;
  trackNames(name: string): string[];
  /** registered tracks (inspection: interpolation checks) */
  tracks(name: string): KeyframeTrack[];
  /** the clip the body rests in between clips */
  idleName?(): string;
  /** rest in another clip from now on (looped); unknown name -> false, nothing changes */
  setIdle?(name: string): boolean;
}

/** the idle after once-clip `clip`: a lying idle under a clip that ends sitting (facts `end_lying` false) turns
 *  into a sitting one (idleForPose "sit"); null = keep (k24_true: wake_up sat up, the idle laid her back down) */
export function idleAfterClip(clip: string, cur: string, clips: string[], facts: Record<string, { lying?: boolean; end_lying?: boolean }> | null): string | null {
  if (!facts || facts[cur]?.lying !== true || facts[clip]?.end_lying !== false) return null;
  return idleForPose("sit", cur, clips, facts);
}

/** The idle a staged pose needs, or null = keep the current one. Only a lying idle against a non-lying pose (or the
 *  reverse) changes: a standing idle on a sit is the procedural seated legs' job (Mama on the bed edge).
 *  k18_true 50–58 s: Mirai staged to sit fell back to sleep_curled after wake_up and spoke lying down. */
export function idleForPose(pose: string | undefined, cur: string, clips: string[], facts: Record<string, { lying?: boolean } | undefined> | null): string | null {
  if (!pose || !facts) return null;
  const lying = (c: string): boolean => facts[c]?.lying === true;
  if (pose === "lie") return lying(cur) ? null : clips.find((c) => lying(c) && /sleep|lie|rest/i.test(c)) ?? clips.find(lying) ?? null;
  if (!lying(cur)) return null;
  const want = pose === "sit" ? ["sit_idle", "stand_idle"] : ["stand_idle", "idle"];
  return want.find((c) => clips.includes(c)) ?? clips.find((c) => facts[c]?.lying === false && /idle/i.test(c)) ?? null;
}

const TPOSE_DEG = 30;
const ARM = /upperarm_(l|r)/i;
const ROOT = /pelvis|root|hips/i;

const toDeg = (a: Quaternion, b: Quaternion): number => (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;

/** first time where both upper arms are >= 30 degrees off their bind pose; null = never / no arm tracks.
 *  Scans the interpolated motion (not just key times): sparse keys 0°->90° cut at ~1/3 of the span. */
function calibrationEnd(tracks: KeyframeTrack[], bind: Record<string, Quaternion>): number | null {
  const side: Record<string, KeyframeTrack> = {};
  for (const t of tracks) {
    const p = PropertyBinding.parseTrackName(t.name);
    const m = ARM.exec(p.nodeName ?? "");
    if (m && p.propertyName === "quaternion") side[m[1].toLowerCase()] = t;
  }
  if (!side.l || !side.r || !bind.l || !bind.r) return null;
  const itp = { l: side.l.createInterpolant(), r: side.r.createInterpolant() };
  const q = new Quaternion();
  const devAt = (t: number): [number, number] => {
    const dev = (s: "l" | "r"): number => toDeg(q.fromArray(Array.from(itp[s].evaluate(t)) as number[]), bind[s]);
    return [dev("l"), dev("r")];
  };
  const tMin = Math.min(side.l.times[0], side.r.times[0]);
  const tMax = Math.max(side.l.times[side.l.times.length - 1], side.r.times[side.r.times.length - 1]);
  if (!(tMax > tMin)) {
    const [dl, dr] = devAt(tMin);
    return dl >= TPOSE_DEG && dr >= TPOSE_DEG ? tMin : null;
  }
  // coarse scan at ~5 ms, then bisect to the boundary
  const N = Math.min(10000, Math.max(200, Math.ceil((tMax - tMin) / 0.005)));
  let lo = tMin;
  let hi: number | null = null;
  for (let i = 0; i <= N; i++) {
    const t = tMin + ((tMax - tMin) * i) / N;
    const [dl, dr] = devAt(t);
    if (dl >= TPOSE_DEG && dr >= TPOSE_DEG) {
      hi = t;
      break;
    }
    lo = t;
  }
  if (hi === null) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (hi - lo < 1e-6) break;
    const [dl, dr] = devAt(mid);
    if (dl >= TPOSE_DEG && dr >= TPOSE_DEG) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** rebuild a track with new times/values, keeping its interpolation and custom interpolant factory (STEP, GLTF CUBICSPLINE).
 *  A custom factory (getInterpolation() === undefined) is copied over directly: setInterpolation(undefined)
 *  only prints a false "unsupported interpolation" warning. */
function cloneTrack(track: KeyframeTrack, times: ArrayLike<number>, values: ArrayLike<number>): KeyframeTrack {
  const nt = new (track.constructor as any)(track.name, Array.from(times as any), Array.from(values as any));
  const interp = track.getInterpolation();
  if (interp !== undefined) {
    try {
      nt.setInterpolation(interp);
    } catch { /* keep the default */ }
  }
  if (Object.prototype.hasOwnProperty.call(track, "createInterpolant")) (nt as any).createInterpolant = (track as any).createInterpolant;
  return nt;
}

const isCubic = (track: KeyframeTrack): boolean =>
  (track as any).createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline === true;

function cutHead(track: KeyframeTrack, t0: number): KeyframeTrack {
  if (t0 <= 0) return track;
  const vs = track.getValueSize();
  const itp = track.createInterpolant();
  const head = Array.from(itp.evaluate(t0) as ArrayLike<number>);
  // CUBICSPLINE: one key is [inTangent, vertex, outTangent]; the head key keeps the sampled
  // vertex with the sampled derivative on both sides, so the remaining curve keeps its shape
  // (zeroed tangents would flatten the first span, including the root Y jump/fall).
  // The inTangent of a first key is never read; setting it too keeps the layout clean.
  let values: number[];
  if (isCubic(track) && head.length === vs / 3) {
    const tMin = track.times[0], tMax = track.times[track.times.length - 1];
    const span = Math.max(tMax - tMin, 1e-6);
    const e = Math.min(1e-4, span * 1e-4);
    const lo = Math.max(tMin, t0 - e), hi = Math.min(tMax, t0 + e);
    const a = Array.from(itp.evaluate(lo) as ArrayLike<number>);
    const b = Array.from(itp.evaluate(hi) as ArrayLike<number>);
    const dt = hi - lo || 1;
    const deriv = b.map((x, i) => (x - (a[i] as number)) / dt);
    values = [...deriv, ...head, ...deriv];
  } else {
    values = head;
  }
  const times = [0];
  for (let i = 0; i < track.times.length; i++) {
    if (track.times[i] > t0 + 1e-9) {
      times.push(track.times[i] - t0);
      for (let k = 0; k < vs; k++) values.push(track.values[i * vs + k]);
    }
  }
  return cloneTrack(track, times, values);
}

const REST_STEP = 1 / 15;
const UPRIGHT = 0.9;  // pelvis at least this share of its bind height = standing, not lying or crouched

/** The standing frame (clip, time) where both upper arms hang lowest in world space; null when the body has
 *  no upperarm->child pair to measure. Sampled on a throwaway mixer; the bind state is restored after. */
function restPose(root: Object3D, reg: Map<string, AnimationClip>): { name: string; t: number } | null {
  const arms: Array<[Object3D, Object3D]> = [];
  root.traverse((o) => {
    if (ARM.test(o.name) && o.children[0]) arms.push([o, o.children[0]]);
  });
  if (arms.length < 2 || !reg.size) return null;
  let pelvis: Object3D | null = null;
  root.traverse((o) => {
    if (!pelvis && ROOT.test(o.name)) pelvis = o;
  });
  const saved: Array<[Object3D, Quaternion, Vector3, Vector3]> = [];
  root.traverse((o) => saved.push([o, o.quaternion.clone(), o.position.clone(), o.scale.clone()]));
  const a = new Vector3(), b = new Vector3();
  const pelvisY = (): number => (pelvis as Object3D | null)?.getWorldPosition(a).y ?? 0;
  root.updateMatrixWorld(true);
  const bindY = pelvisY();
  const mixer = new AnimationMixer(root);
  let best: { name: string; t: number; score: number } | null = null;
  for (const [name, clip] of reg) {
    const act = mixer.clipAction(clip);
    act.play();
    for (let t = 0; t <= clip.duration + 1e-9; t += REST_STEP) {
      act.time = t;
      mixer.update(0);
      root.updateMatrixWorld(true);
      if (bindY > 1e-6 && pelvisY() < UPRIGHT * bindY) continue;
      let score = Infinity;
      for (const [ua, child] of arms) {
        ua.getWorldPosition(a);
        child.getWorldPosition(b);
        const len = a.distanceTo(b);
        score = Math.min(score, len > 1e-9 ? (a.y - b.y) / len : -1);  // sin of the drop below horizontal
      }
      if (!best || score > best.score + 1e-6) best = { name, t, score };
    }
    act.stop();
  }
  mixer.uncacheRoot(root);
  for (const [o, q, p, s] of saved) {
    o.quaternion.copy(q);
    o.position.copy(p);
    o.scale.copy(s);
  }
  root.updateMatrixWorld(true);
  return best && best.score > 0 ? { name: best.name, t: best.t } : null;
}

/** The clip as the runtime plays it on `root`: tracks with no bone in the body dropped, the calibration
 *  head cut (`calibrationEnd`/`cutHead`), the root X/Z frozen (walks in place). No track for the body ->
 *  a clip with no tracks. Shared by `createAnimator` and `clipFacts` (Г4), so facts match what plays. */
export function prepareClip(src: AnimationClip, root: Object3D, name: string = src.name): AnimationClip {
  // B70: the bind pose is the arm's rotation the first time any clip is prepared on it, kept on the bone.
  // The animator poses idle right after preparing its clips; a later prepareClip (clipFacts on the same
  // body) must still compare the calibration T-pose against the bind pose, not against idle's lowered arms.
  const bind: Record<string, Quaternion> = {};
  root.traverse((o) => {
    const m = ARM.exec(o.name);
    if (!m) return;
    // an array, not a Quaternion: Object3D.clone copies userData through JSON
    const ud = o.userData as { bindQuat?: number[] };
    if (!Array.isArray(ud.bindQuat) || ud.bindQuat.length !== 4) ud.bindQuat = o.quaternion.toArray() as number[];
    bind[m[1].toLowerCase()] = new Quaternion().fromArray(ud.bindQuat);
  });
  const known = src.tracks.filter((t) => {
    const n = PropertyBinding.parseTrackName(t.name).nodeName;
    return !!n && !!root.getObjectByName(n);
  });
  if (known.length < src.tracks.length && known.length) console.warn(`anim: clip "${name}" dropped ${src.tracks.length - known.length} track(s) with no bone in the body`);
  if (!known.length) return new AnimationClip(name, 0, []);
  let tracks = known;
  const t0 = calibrationEnd(known, bind);
  if (t0 === null) console.warn(`anim: clip "${name}" has no upperarm pair to detect the calibration head, not cut`);
  else tracks = known.map((t) => cutHead(t, t0));
  tracks = tracks.map((t) => {
    const p = PropertyBinding.parseTrackName(t.name);
    if (p.propertyName !== "position") return t;
    const cubic = isCubic(t);
    if (!cubic && t.getValueSize() !== 3) return t;
    if (cubic && t.getValueSize() / 3 !== 3) return t;
    const node = root.getObjectByName(p.nodeName)!;
    const isRoot = ROOT.test(p.nodeName) || ((node as any).isBone && !(node.parent as any)?.isBone);
    if (!isRoot) return t;
    const v = Array.from(t.values);
    if (isCubic(t)) {
      // CUBICSPLINE root: freeze vertex X/Z to the first vertex, zero tangent X/Z (Y kept)
      const vs = t.getValueSize(), st = vs / 3;
      const fx = v[st], fz = v[st + 2];
      for (let k = 0; k < v.length / vs; k++) {
        const base = k * vs;
        for (let j = 0; j < st; j++) {
          if (j % 3 === 1) continue;
          v[base + j] = 0;
          v[base + st + j] = j % 3 === 0 ? fx : fz;
          v[base + 2 * st + j] = 0;
        }
      }
    } else {
      for (let i = 0; i < v.length; i += 3) {
        v[i] = v[0];
        v[i + 2] = v[2];
      }
    }
    return cloneTrack(t, Array.from(t.times), v);
  });
  return new AnimationClip(name, -1, tracks);
}

/** One AnimationMixer per character: clips retargeted by bone name, calibration head cut, root walks in place, crossfades. */
export function createAnimator(root: Object3D, clips: Record<string, AnimationClip>, opts: { idle?: string; fade?: number; seed?: string; life?: boolean } = {}): Animator {
  const fade = opts.fade ?? 0.15;
  const mixer = new AnimationMixer(root);
  // prepareClip reads the arms' bind pose: every clip is prepared here, before the first update
  const reg = new Map<string, AnimationClip>();
  for (const [name, src] of Object.entries(clips)) {
    const clip = prepareClip(src, root, name);
    if (!clip.tracks.length) {
      console.warn(`anim: clip "${name}" has no track for this body, not registered`);
      continue;
    }
    reg.set(name, clip);
  }

  const actions = new Map<string, AnimationAction>();
  const actionOf = (name: string): AnimationAction => {
    let a = actions.get(name);
    if (!a) actions.set(name, (a = mixer.clipAction(reg.get(name)!)));
    return a;
  };

  // idle: "clip" loops, "clip@sec" holds the pose
  const spec = (opts.idle ?? "").split("@");
  let idleName = spec[0];
  let hold: number | null = spec[1] !== undefined && Number.isFinite(Number(spec[1])) ? Number(spec[1]) : null;
  if (!reg.has(idleName)) {
    idleName = [...reg.keys()][0] ?? "";
    if (opts.idle !== undefined && idleName) console.warn(`anim: idle "${opts.idle}" not found, holding frame 0 of "${idleName}"`);
    hold = 0;
  }
  if (!opts.idle && idleName) {
    // no idle: rest on the standing frame with both arms hanging lowest. Frame 0 of a clip is the
    // calibration edge (arms just 30° off T), which reads as a stiff T on screen (Koshakan, Nov 1).
    const rest = restPose(root, reg);
    if (rest) [idleName, hold] = [rest.name, rest.t];
    else hold = 0;
  }

  const life = opts.life === false ? null : createLife(root, opts.seed);
  const warned = new Set<string>();
  let state: "idle" | "clip" = "idle";
  let cur: AnimationAction | null = null;
  let curName = idleName;
  let onceActive = false;

  const activate = (name: string, o: { once?: boolean; hold?: number | null }): AnimationAction => {
    const a = actionOf(name);
    a.reset();
    a.setEffectiveWeight(1);
    if (o.hold != null) {
      a.setLoop(LoopRepeat, Infinity);
      a.clampWhenFinished = false;
      a.time = o.hold;
      a.setEffectiveTimeScale(0);
    } else if (o.once) {
      a.setLoop(LoopOnce, 1);
      a.clampWhenFinished = true;
      a.setEffectiveTimeScale(1);
    } else {
      a.setLoop(LoopRepeat, Infinity);
      a.clampWhenFinished = false;
      a.setEffectiveTimeScale(1);
    }
    a.play();
    return a;
  };
  const switchTo = (name: string, o: { once?: boolean; hold?: number | null }): void => {
    const prev = cur;
    const next = activate(name, o);
    if (prev && prev !== next && fade > 0) prev.crossFadeTo(next, fade, false);
    else if (prev && prev !== next) prev.stop();
    cur = next;
    curName = name;
    onceActive = !!o.once;
  };
  const goIdle = (): void => {
    state = "idle";
    if (idleName) switchTo(idleName, { hold });
  };

  mixer.addEventListener("finished", (e: any) => {
    if (e.action === cur && onceActive && state === "clip") goIdle();
  });
  if (idleName) {
    cur = activate(idleName, { hold });
    mixer.update(0);
  }

  return {
    play(name, o = {}) {
      if (!reg.has(name)) {
        if (!warned.has(name)) {
          warned.add(name);
          console.warn(`anim: no clip "${name}", staying in idle`);
        }
        if (state !== "idle") goIdle();
        return;
      }
      if (state === "clip" && curName === name) return;
      // already looping this clip as idle: restarting would visibly jump
      if (state === "idle" && name === idleName && hold == null && !o.once) return;
      state = "clip";
      switchTo(name, { once: o.once });
    },
    idle() {
      if (state !== "idle") goIdle();
    },
    update(dt, o = {}) {
      life?.before();
      mixer.update(dt);
      // full life in idle; a clip keeps a little breath under it
      life?.after(dt, { weight: state === "idle" ? 1 : 0.3, talking: !!o.talking, look: o.look });
    },
    current: () => (state === "idle" ? idleName : curName),
    idleName: () => idleName,
    setIdle(name) {
      if (!reg.has(name)) return false;
      if (name === idleName && hold == null) return true;
      idleName = name;
      hold = null;
      if (state === "idle") goIdle();
      return true;
    },
    alive: () => !!life,
    has: (n) => reg.has(n),
    weight: (n) => actions.get(n)?.getEffectiveWeight() ?? 0,
    time: (n) => actions.get(n)?.time ?? 0,
    duration: (n) => reg.get(n)?.duration ?? 0,
    trackNames: (n) => (reg.get(n)?.tracks ?? []).map((t) => t.name),
    tracks: (n) => [...(reg.get(n)?.tracks ?? [])],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// text -> clip

export interface CastClips {
  clips?: Record<string, unknown>;
  /** clip -> words */
  verbs?: Record<string, string[]>;
  /** the name in the book's language ("Мирай" for Mirai): narration names the actor by it */
  aliases?: string[];
}
/** alias (lower case) -> cast name, from every `cast[name].aliases` */
export function aliasesOf(cast: Record<string, CastClips>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, c] of Object.entries(cast)) for (const a of c.aliases ?? []) if (typeof a === "string" && a.trim()) out[a.trim().toLowerCase()] = name;
  return out;
}
export type ClipPick = { who: string; clip: string };

const DEFAULT_VERBS: Record<string, string[]> = {
  wake: ["wake", "woke", "waking"],
  hug: ["hug", "hugged", "held", "hold"],
  flick: ["flick", "flicked", "splash", "drip"],
  stroke: ["stroke", "stroked", "pat", "patted"],
  leap: ["leap", "jump", "jumped", "ran", "run"],
  fall: ["fall", "fell", "whoops", "tumble"],
  sit: ["sat", "sit", "climbed"],
  walk: ["walk", "walked"],
};
const invert = (m: Record<string, string[]>): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [clip, words] of Object.entries(m)) for (const w of words ?? []) out.set(String(w).toLowerCase(), clip);
  return out;
};
const DEFAULT_MAP = invert(DEFAULT_VERBS);
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD = "[\\p{L}\\p{N}_]";
const hasClip = (c: CastClips | undefined, clip: string): boolean => !!c && Object.prototype.hasOwnProperty.call(c.clips ?? {}, clip);

export function pickClip(text: string, who: string | null, cast: Record<string, CastClips>, aliases: Record<string, string> = {}): ClipPick | null {
  const keys = new Map<string, string>();
  for (const [a, n] of Object.entries(aliases)) if (n in cast) keys.set(a.toLowerCase(), n);
  for (const n of Object.keys(cast)) keys.set(n.toLowerCase(), n);  // the name beats an alias
  const subjects: Array<{ start: number; end: number; name: string }> = [];
  for (const [k, name] of keys) {
    if (!k) continue;
    const re = new RegExp(`(?<!${WORD})${escRe(k)}(?!${WORD})`, "giu");
    for (const m of text.matchAll(re)) subjects.push({ start: m.index!, end: m.index! + m[0].length, name });
  }
  const seps = [...text.matchAll(/[.!?;\n]/gu)].map((m) => m.index!);
  const maps = new Map<string, Map<string, string>>();
  const mapOf = (n: string): Map<string, string> => {
    let m = maps.get(n);
    if (!m) {
      m = new Map(DEFAULT_MAP);
      for (const [w, c] of invert(cast[n]?.verbs ?? {})) m.set(w, c);
      maps.set(n, m);
    }
    return m;
  };
  for (const tok of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const at = tok.index!;
    const word = tok[0].toLowerCase();
    const lastSep = Math.max(-1, ...seps.filter((s) => s < at));
    let subj: string | null = null;
    let bestEnd = -1;
    for (const s of subjects) if (s.end <= at && s.start > lastSep && s.end > bestEnd) ((bestEnd = s.end), (subj = s.name));
    if (!subj && who !== null && who in cast) subj = who;
    if (!subj) continue;
    const clip = mapOf(subj).get(word);
    if (clip && hasClip(cast[subj], clip)) return { who: subj, clip };
  }
  return null;
}

export type GesturePick = ClipPick & { procedural?: true };

/** voice remarks + line text -> verb; first row wins, shared by every character */
const GESTURE_TABLE: Array<[string, RegExp]> = [
  ["wave", /(?<![\p{L}])(hello|hullo|hi|hey|greetings|good (morning|day|evening)|привет|здравствуй)(?![\p{L}])/iu],
  ["shrug", /(?<![\p{L}])(sigh|tired|weary)/iu],
  ["jump", /(?<![\p{L}])(excited|giddy|cheer)/iu],
  ["droop", /(?<![\p{L}])(sad|hurt|quiet)/iu],
  ["armscross", /(?<![\p{L}])(stern|firm|offended)/iu],
  ["react", /(?<![\p{L}])(startled|gasp)/iu],
];
const strHash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export function clipForBeat(
  beat: { who?: string | null; text?: unknown; gesture?: unknown; remarks?: unknown; pose?: unknown; seed?: unknown },
  cast: Record<string, CastClips>,
  aliases: Record<string, string> = {},
  /** `poseOf`: the pose of the actor a pick lands on (a narration names its actor only in the text);
   *  `fits`: the clip was made for that pose (clipfacts `lying` for "lie"); none = no clip fits a non-standing pose */
  o: { poseOf?: (who: string) => string | undefined; fits?: (who: string, clip: string, pose: string) => boolean } = {},
): GesturePick | null {
  const who = typeof beat.who === "string" && beat.who in cast ? beat.who : null;
  const text = typeof beat.text === "string" ? beat.text : "";
  const standing = (pose: unknown): boolean => typeof pose !== "string" || pose === "" || pose === "stand" || pose === "stand_at";
  // a lying / seated actor never plays a standing clip: such a pick becomes a procedural gesture
  // (Koshakan, Nov 2: the narration "Mama bent down and whispered" hunched seated Mama with a standing clip)
  const lying = !standing(beat.pose);
  const done = (p: ClipPick): GesturePick => {
    const pose = beat.pose !== undefined ? beat.pose : o.poseOf?.(p.who);
    if (standing(pose)) return p;
    return o.fits?.(p.who, p.clip, pose as string) ? p : { ...p, procedural: true };
  };
  if (who && typeof beat.gesture === "string" && beat.gesture.trim()) {
    const g = beat.gesture.trim().toLowerCase();
    const key = Object.keys(cast[who].clips ?? {}).find((k) => k.toLowerCase() === g);
    if (key) return done({ who, clip: key });
    const hit = pickClip(beat.gesture, who, cast, aliases);
    if (hit) return done(hit);
  }
  const hit = pickClip(text, who, cast, aliases);
  if (hit) return done(hit);
  const rm = typeof beat.remarks === "string" ? beat.remarks : Array.isArray(beat.remarks) ? beat.remarks.filter((r) => typeof r === "string").join("\n") : "";
  const signal = `${rm}\n${text}`;
  const verb = GESTURE_TABLE.find(([, re]) => re.test(signal))?.[0];
  // Н17: no verb -> no gesture, the life nods stay; a matching verb with an
  // empty or verb-less bank is a bounded procedural gesture (F3)
  if (!who || !verb) return null;
  const variants = Object.keys(cast[who].clips ?? {}).filter((k) => k === verb || new RegExp(`^${verb}[_\\d]`).test(k)).sort();
  if (lying || !variants.length) return { who, clip: verb, procedural: true };
  const seed = typeof beat.seed === "string" ? beat.seed : "";
  return { who, clip: variants[strHash(`${seed}|${verb}|${text}`) % variants.length] };
}
