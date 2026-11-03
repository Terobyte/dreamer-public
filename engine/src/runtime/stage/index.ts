import { Vector3, type PerspectiveCamera, type Scene } from "three";
import type { StageEvent, StageHandlers } from "../bridge.js";
import { navBit, type NavRamp } from "../../nav/floor.js";
import type { HeldSpec } from "./held.js";
import { aliasesOf, clipForBeat, fitStaged, idleAfterClip, idleForPose, stagedClips, startStaged } from "./anim.js";
import { createActor, WALK_SPEED, type Actor } from "./actors.js";
import { createDirector, createPendingQueue, inScene, initialYaws, smoothCam, type DActor, type DEvent } from "./director.js";
import type { StageLevel } from "./path.js";
import { interRoomDoorStep } from "./path.js";
import { approachGap, BED_TUCK_M, bedLift, floorAt, hugSpot, nearActor, pillowShift, stageRegex, startSpot, yawTo, type Claims, type Place, type V2 } from "./places.js";
import { createToucher } from "./touch.js";
import { separate } from "./separate.js";
import { createSubs } from "./subs.js";
import { createHeight, createSight } from "./sight.js";
import { createCritic, boneSig, headPose, type CriticFact } from "./critic.js";
import { bodyInTheWay, clearOfBodies, legalCameraPoint, roomRect, type CamBody, type V3 } from "./camera.js";
import { createShotClock, cutMeshes, parseShotplan, shakeOf, shotFrame, type ActiveShot, type ShotClock } from "./shotplan.js";

export interface StageCtx {
  scene: Scene;
  camera: PerspectiveCamera;
  /** value of `?stage=` (url of stage.json, relative to the page) and of `?sim=` */
  stageUrl: string;
  sim: string | null;
  /** ?film=1: recording a film, no controls on screen (freestyle button, story ticker, G key) */
  film?: boolean;
  geo: any;
  layers: Array<{ layer: any; bits: Uint8Array }>;
  nav: any;
  /** is this door open right now? */
  doorOpen(id: string): boolean;
  /** swing a door of the page open or shut (main.ts: doors.ts `open`/`close`); an actor entering or exiting opens the
   *  door it passes, it shuts 2 s after the last one is through */
  door?(id: string, open: boolean): void;
  /** stage.json itself (tests; else fetched from stageUrl) */
  stage?: Record<string, unknown>;
  /** Г8: the shot plan, ready (tests; else `stage.shotplan` is fetched from the run folder) */
  plan?: unknown;
  /** К2: director style id (?camera_style=); absent = the legacy frames */
  cameraStyle?: string;
}

export interface Stage {
  handlers: StageHandlers;
  update(dt: number, now: number): void;
  warnings(): string[];
  api: {
    actors(): Array<{ who: string; pos: V2; yaw: number; act: string }>;
    camera(): { pos: [number, number, number]; room: string | null; height: number | null };
    subs(): string[];
    /** the world point `who` looks at right now, or null */
    gaze(who: string): [number, number, number] | null;
  };
}

const SPEAK_SECONDS = 3;
/** time constant of the head point the camera frames (DActor.head) */
const HEAD_SMOOTH_S = 1;
/** a door an actor passed shuts this long after the last one is through */
const DOOR_SHUT_S = 2;
/** actor capsule radius, m; exit walks this far (+ margin) past the door plane */
const CAPSULE_R = 0.3;
const EXIT_PAST_M = CAPSULE_R + 0.1;

/** a speech beat for gaze: who speaks, who/which place the speaker's `look` bit names, until when (4 s of silence after -> nobody looks at anything) */
export interface GazeBeat {
  speaker: string | null;
  at: string | null;
  place: Place | null;
  until: number;
}

export interface GazeActor {
  who: string;
  room: unknown;
  pos: V2;
  eye: [number, number, number];
}

/** who looks at whom (the pure decision behind the per-frame gaze): the speaker follows their `look` bit
 *  (a named actor, else a named place, else the nearest mate in the room); listeners look at the speaker;
 *  a narration turns the cast to each other, or to the place it is about; 4 s of silence after a beat -> null. */
export function resolveGaze(
  beat: GazeBeat | null,
  now: number,
  self: GazeActor,
  cast: GazeActor[],
  placePoint: (p: Place) => [number, number, number],
): [number, number, number] | null {
  if (!beat || now > beat.until) return null;
  const mates = cast.filter((o) => o.who !== self.who && o.room === self.room);
  const nearest = (): GazeActor | undefined =>
    mates.slice().sort((p, q) => Math.hypot(p.pos[0] - self.pos[0], p.pos[1] - self.pos[1]) - Math.hypot(q.pos[0] - self.pos[0], q.pos[1] - self.pos[1]))[0];
  const speaker = beat.speaker ? cast.find((o) => o.who === beat.speaker) : undefined;
  if (speaker && speaker.who !== self.who) return speaker.room === self.room ? speaker.eye : null;
  if (speaker) {
    const named = beat.at ? cast.find((o) => o.who === beat.at && o.who !== self.who) : undefined;
    if (named) return named.eye;
    if (beat.place) return placePoint(beat.place);
    return nearest()?.eye ?? null;
  }
  // narration: a place if the narration is about one, else the actors look at each other
  if (beat.place) return placePoint(beat.place);
  return nearest()?.eye ?? null;
}

/** a gaze target over a place: eye height (1.4 m) above the floor of the place's level (ground floor when unknown). */
export function placeGazePoint(p: Place, floorY = 0): [number, number, number] {
  return [p.at[0], floorY + 1.4, p.at[1]];
}

/** seed for one line's gesture variant: the scene seed with a stable line index
 *  (Н17 F7). No seed in the scene -> the bare index, as before. */
export function lineSeed(sceneSeed: unknown, lineIndex: number): string {
  const s = typeof sceneSeed === "string" ? sceneSeed : sceneSeed === null || sceneSeed === undefined ? "" : String(sceneSeed);
  return s ? `${s}|line-${lineIndex}` : `line-${lineIndex}`;
}

/** Reads stage.json + places + cast, puts the cast on its start places and returns the event handlers and the frame step. */
export async function startStage(c: StageCtx): Promise<Stage> {
  const locHref = typeof location !== "undefined" ? location.href : "http://localhost/";
  const stageAbs = new URL(c.stageUrl || "stage/stage.json", locHref);
  const stage: any = c.stage ?? (await fetch(stageAbs).then((r) => r.json()));
  // paths inside stage.json are relative to the run folder: the parent of stage/
  const runBase = new URL("../", stageAbs);
  let places: Place[];
  if ((c as any).places) {
    places = (c as any).places;
  } else {
    const placesJson = await fetch(new URL(stage.places, runBase)).then((r) => r.json());
    places = placesJson.places ?? placesJson;
  }
  const castUrl = stage.cast ? new URL(stage.cast, runBase) : new URL("cast/cast.json", locHref);
  const cast: Record<string, { glb?: string; height_m?: number; clips?: Record<string, string>; idle?: string; verbs?: Record<string, string[]>; aliases?: string[]; held?: Record<string, HeldSpec> }> =
    (c as any).cast ?? (await fetch(castUrl).then((r) => r.json()));
  const names = Object.keys(cast);
  // Г4: clip facts next to cast.json (contact_y per clip); an old run has none -> null, silently
  const clipfacts: Record<string, Record<string, { contact_y?: number; seat_y?: number; lying?: boolean; end_lying?: boolean }>> | null = await fetch(new URL("clipfacts.json", castUrl))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j && typeof j === "object" && !Array.isArray(j) ? j : null))
    .catch(() => null);

  // Г8: the shot plan (optional): given ready, or `stage.shotplan` (path from the run folder); none -> the director as before
  let planWarn: string | null = null;
  const planJson: unknown = c.plan !== undefined
    ? c.plan
    : typeof stage.shotplan === "string"
      ? await fetch(new URL(stage.shotplan, runBase))
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
          .then((j) => {
            if (j === null) planWarn = `stage: shotplan "${stage.shotplan}" not readable -> director`;
            return j;
          })
      : (planWarn = "stage: no shotplan -> director", null);

  const layerOf = (level: string | null) => c.layers.find((l) => l.layer.level === level) ?? c.layers[0];
  const roomAt = (p: V2, level?: string | null): any | null => floorAt(c.geo.floors ?? [], p, level);
  const ceilingOf = (room: string): number => {
    const m = (c.geo.meshes ?? []).find((q: any) => q.id === `${room}:ceiling`);
    if (!m) return 2.7;
    let top = 0;
    for (let i = 1; i < m.positions.length; i += 3) top = Math.max(top, m.positions[i]);
    return top || 2.7;
  };
  /** a room without a `:ceiling` mesh is open sky (a yard): the director gives it a taller camera ceiling */
  const isOpen = (room: string): boolean => !(c.geo.meshes ?? []).some((q: any) => q.id === `${room}:ceiling`);
  // deterministic "random" for the director (no Math.random in the runtime)
  let seed = 20261101;
  const rng = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const claims: Claims = {};
  const actors = new Map<string, Actor>();
  const fallback = places[0];
  for (const who of names) {
    const startName = stage.start?.[who];
    const sp = places.find((p) => p.name === startName) ?? fallback;
    const spot = sp && sp.name === startName ? startSpot(sp, stage.start_pose?.[who], sp.at, places) : null;
    const at: V2 = spot ? spot.at : sp ? sp.at : [c.geo.spawn.at[0], c.geo.spawn.at[1]];
    const url = new URL(cast[who].glb, castUrl).href;
    const clipUrls: Record<string, string> = {};
    for (const [k, v] of Object.entries(cast[who].clips ?? {})) clipUrls[k] = new URL(v, castUrl).href;
    const held: Record<string, HeldSpec> = {};
    for (const [k, h] of Object.entries(cast[who].held ?? {})) if (h && typeof h.glb === "string") held[k] = { ...h, glb: new URL(h.glb, castUrl).href };
    const a = await createActor(who, url, Number(cast[who].height_m ?? 1.7), at, layerOf(sp?.level ?? null).layer.y + (spot?.y ?? 0), spot?.yaw ?? sp?.yaw ?? 0, clipUrls, cast[who].idle, clipfacts?.[who] ?? null, held);
    if (sp && sp.name === startName) claims[sp.name] = who;
    // start_pose sit seats the actor at load, the same rule as a start event with pose sit (else it stands by the seat)
    if (spot && stage.start_pose?.[who] === "sit") a.teleport(at, a.yaw(), "sit", a.y(), sp.top);
    actors.set(who, a);
  }
  const director = createDirector(rng, { style: c.cameraStyle });
  let sceneFirst = true;
  /** К2: tags of the next queued line/narrator */
  const tagsOf = (look: boolean): DEvent["tags"] | undefined => {
    const t: NonNullable<DEvent["tags"]> = {};
    if (sceneFirst) t.first = true;
    if (look) t.look = true;
    sceneFirst = false;
    return Object.keys(t).length ? t : undefined;
  };
  // the director sees the furniture: a frame whose sightline the world blocks is moved (actors never block)
  const sight = createSight(c.scene, () => [...actors.values()].map((a) => a.group));
  /** the director's probe: nothing of the world and nobody else's body between the camera and the head it frames */
  // the bodies are taken once per director step (camBodies walks the bones; the probe runs hundreds of times a step)
  let stepBodies: CamBody[] = [];
  const seesPast = (cam: V3, look: V3): boolean => !bodyInTheWay(cam, look, stepBodies) && sight(cam, look);
  /** top of the furniture under a floor point (the pillow, which places.json does not know) */
  const heightAt = createHeight(c.scene, () => [...actors.values()].map((a) => a.group));
  const offstageActors = new Set<string>();
  /** actors walking to a door on `exit`: they become offstage only once they stop there */
  const exiting = new Set<string>();
  /** doors held open by who is passing them (door id -> actors), and when an unused one shuts */
  const doorUsers = new Map<string, Set<string>>();
  const exitDoor = new Map<string, string>();
  const doorShut = new Map<string, number>();
  const enteringBy = new Map<string, string>();
  const passStart = (id: string, who: string): void => {
    let u = doorUsers.get(id);
    if (!u) doorUsers.set(id, (u = new Set()));
    if (!u.size && !doorShut.has(id)) c.door?.(id, true);
    u.add(who);
    doorShut.delete(id);
  };
  const passEnd = (id: string, who: string): void => {
    const u = doorUsers.get(id);
    if (!u?.delete(who) || u.size) return;
    doorShut.set(id, nowT + DOOR_SHUT_S);
  };
  /** exit: door each actor still has to walk through before going offstage */
  const exitThrough = new Map<string, Place>();
  /** exit while the actor is on a ramp (`touch` -> queued): the door waits here until the actor steps off */
  const exitPending = new Map<string, { door: Place; noSide: boolean }>();
  /** exiting actors seen standing still once: they go offstage on the next update */
  const exitSettled = new Set<string>();
  /** B01: a new move or turn cancels an exit in progress (else the old door pulls the actor out);
   *  B66: and a touch still waiting for the actor to step off a ramp -- a newer order wins.
   *  Every new order for an actor goes through here: start, stage actions, line/touch/narrator moves. */
  const cancelExit = (who: string) => {
    exiting.delete(who);
    exitThrough.delete(who);
    exitPending.delete(who);
    exitSettled.delete(who);
    toucher.cancel(who);
  };
  const roomOfActor = (a: Actor, lvl: string | null): any | null => roomAt(a.pos(), lvl) ?? roomAt(a.pos()) ?? null;
  // measured head bone, low-passed (~1 s): the camera frames a seated / lying head, but does not bob with a nod
  const headSmooth = new Map<string, { p: V3; yaw: number; t: number }>();
  // own clock: dActors runs in the start-up probe, before `nowT` below exists
  let headT = 0;
  /** smoothed head point and face yaw (where the head looks, not the body: a seated Mama turns her head to Mirai) */
  const smoothHead = (a: Actor): { p: V3; yaw: number } | undefined => {
    const hp = headPose(a.group);
    if (!hp) return undefined;
    const prev = headSmooth.get(a.who);
    const k = prev ? 1 - Math.exp(-Math.max(0, headT - prev.t) / HEAD_SMOOTH_S) : 1;
    const p: V3 = prev ? [prev.p[0] + (hp.pos[0] - prev.p[0]) * k, prev.p[1] + (hp.pos[1] - prev.p[1]) * k, prev.p[2] + (hp.pos[2] - prev.p[2]) * k] : hp.pos;
    const dy = prev ? ((((hp.faceYaw - prev.yaw) % 360) + 540) % 360) - 180 : 0;
    const yaw = prev ? (((prev.yaw + dy * k) % 360) + 360) % 360 : hp.faceYaw;
    headSmooth.set(a.who, { p, yaw, t: headT });
    return { p, yaw };
  };
  /** last known pose per actor (start/stage carry it): the line event passes it to clipForBeat (Н17 F2) */
  const poseOf = new Map<string, string>();
  const dActors = (list: Actor[]): DActor[] =>
    list.map((a) => {
      const lvl = toucherLevel(a.who);
      const f = roomOfActor(a, lvl);
      const h = smoothHead(a);
      return {
        head: h?.p,
        faceYaw: h?.yaw,
        name: a.who,
        pos: a.pos(),
        yaw: a.yaw(),
        height: heightOf(a.who),
        level: lvl,
        room: f?.room ?? null,
        walking: a.moving(),
        walkLeft: a.walkLeft?.(),
        lying: poseOf.get(a.who) === "lie" && !a.moving(),
        offstage: offstageActors.has(a.who),
      };
    });
  const heightOf = (who: string): number => Number(cast[who].height_m ?? 1.7);
  let toucherLevel: (who: string) => string | null = () => null;
  // facing the viewer (F-live): two actors face each other, a lone one faces the first camera (`wide`)
  {
    const list = [...actors.values()].sort((x, y) => (x.who < y.who ? -1 : 1));
    if (list.length) {
      const f0 = roomOfActor(list[0], null) ?? (c.geo.floors ?? [])[0];
      let firstCam: [number, number, number] = [list[0].pos()[0], 1.5, list[0].pos()[1] + 4];
      if (f0) {
        const probe = createDirector(rng).step({
          event: { kind: "tick", dt: 0 },
          actors: dActors(list),
          room: { outline: f0.outline, ceiling: ceilingOf(f0.room), open: isOpen(f0.room) },
          fov: c.camera.fov,
          aspect: c.camera.aspect,
        });
        firstCam = probe.cam;
      }
      const yaws = initialYaws(list.map((a) => a.pos()), firstCam);
      list.forEach((a, i) => {
        a.go([], yaws[i], a.act());
        a.update(1, 0);
      });
    }
    for (const a of actors.values()) c.scene.add(a.group);
  }

  const subs = createSubs(c.sim);
  const remark = stageRegex(places, names);

  const warnings: string[] = [];
  if (planWarn) warnings.push(planWarn);
  const planParsed = planJson !== null && planJson !== undefined ? parseShotplan(planJson, warnings) : null;
  const shots: ShotClock | null = planParsed ? createShotClock(planParsed, warnings) : null;
  /** a beat event (`beat` = index in score.beats) reached a handler: its start is the last update's now */
  const beatIn = (e: StageEvent): void => {
    if (shots && typeof e.beat === "number" && Number.isInteger(e.beat)) {
      const d = Number(e.dur);
      shots.beat(e.beat, nowT, e.dur !== undefined && e.dur !== null && Number.isFinite(d) ? d : undefined);
    }
  };
  const toucher = createToucher({
    warnings,
    places,
    claims,
    levels: c.layers.map((l): StageLevel => ({ layer: l.layer, bits: l.bits, y: l.layer.y })),
    ramps: (c.nav.ramps ?? []) as NavRamp[],
    doors: c.nav.doors ?? {},
    doorOpen: c.doorOpen,
    actor: (w) => actors.get(w),
  });
  toucherLevel = (who) => toucher.levelOf(who);
  /** a move order: it replaces whatever the actor was doing, an exit included (B63: a narrator remark too) */
  const touch = (who: string, name: string, pose?: string, finishYaw?: number | "along"): void => {
    cancelExit(who);
    void toucher.touch(who, name, pose, finishYaw);
  };

  const whoOf = (e: StageEvent): string | null => {
    const w = e.who ?? e.actor ?? e.turn_owner;
    return typeof w === "string" && actors.has(w) ? w : null;
  };
  const touchName = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const m = /^\[\[TOUCH:(.+)\]\]$/.exec(v.trim());
    return (m ? m[1] : v).trim() || null;
  };

  // ---- freestyle button + story ticker (duo.html's, only here: no ?stage= -> none of this exists) ----
  let mode: string | null = null;
  const doc = typeof document !== "undefined" ? document : null;
  const btn = doc ? doc.createElement("button") : null;
  if (btn) {
    btn.id = "free";
    btn.hidden = true;
    btn.style.cssText = "position:fixed;top:8px;right:8px;z-index:3;font:14px system-ui,sans-serif;padding:6px 10px";
  }
  // only a book run has the button (F27): seed / free scenes never show it; freestyle is one-way
  const bookRun = stage.mode === "book";
  const setMode = (m: string): void => {
    if (c.film || !bookRun || m === mode || mode === "freestyle" || (m !== "book" && m !== "freestyle")) return;
    mode = m;
    if (btn) {
      btn.hidden = false;
      btn.classList.toggle("on", m === "freestyle");
      btn.textContent = m === "freestyle" ? "⚡ фристайл: импровизируют" : "⚡ Фристайл [G]";
    }
  };
  const goFree = (): void => {
    if (c.film || mode !== "book" || !c.sim || !btn) return;
    btn.textContent = "⚡ переключаю…";
    fetch(`${c.sim.replace(/\/$/, "")}/freestyle`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(
      () => (btn.textContent = "⚡ Фристайл [G] (движок не ответил)"),
    );
  };
  if (btn) {
    btn.onclick = goFree;
    doc?.body.appendChild(btn);
  }
  if (typeof addEventListener !== "undefined") {
    addEventListener("keydown", (e) => {
      if (e.code === "KeyG" && !e.repeat) goFree();
    });
  }
  const ticker = doc ? doc.createElement("div") : null;
  const tickerText = doc ? doc.createElement("span") : null;
  if (doc && ticker && tickerText) {
    ticker.id = "story";
    ticker.hidden = true;
    ticker.style.cssText = "position:fixed;top:52px;left:50%;transform:translateX(-50%);width:min(720px,90vw);color:#fff;font:14px system-ui,sans-serif;text-shadow:0 1px 3px #000;white-space:nowrap;overflow:hidden;z-index:2";
    // a running line (F28): the text enters on the right and leaves fully on the left, then again
    const css = doc.createElement("style");
    css.textContent = "@keyframes stage-ticker{from{transform:translateX(0)}to{transform:translateX(-100%)}}#story>span{display:inline-block;padding-left:100%;animation:stage-ticker linear infinite}";
    doc.head?.appendChild(css);
    ticker.appendChild(tickerText);
    doc.body?.appendChild(ticker);
  }
  // the run's own mode first: a book run shows the button before any event (F35)
  setMode(stage.freestyle ? "freestyle" : String(stage.mode ?? ""));
  let pieces = 0;
  let told = 0;

  const pendingQueue = createPendingQueue();
  /** the cast member a narration names first ("Down went Mirai" -> Mirai): the director's close goes to them */
  const aliases = aliasesOf(cast);
  const namedIn = (text: string): string | undefined => {
    let best: string | undefined;
    let at = Infinity;
    for (const n of [...names, ...Object.keys(aliases)]) {
      const m = new RegExp(`(?<![\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").exec(text);
      if (m && m.index < at) [best, at] = [aliases[n] ?? n, m.index];
    }
    return best;
  };
  let lastSpeaker: string | null = null;
  let lastBeatHadStage = false;
  // gaze: who looks at whom (life.ts turns the head); silence of 4 s after a beat -> nobody looks at anything
  const GAZE_SILENCE = 4;
  let nowT = 0;
  let gazeBeat: { speaker: string | null; at: string | null; place: Place | null; until: number } | null = null;
  /** pending `look` of the last stage beat, per speaker; a line consumes only its own speaker's entry */
  const stageLook = new Map<string, string>();
  const placeIn = (text: string): Place | null => places.find((p) => p.name && text.toLowerCase().includes(p.name.toLowerCase())) ?? null;
  const placePoint = (p: Place): [number, number, number] => {
    const layer = layerOf(p.level ?? null) as unknown as { layer?: { y?: number }; y?: number } | number | null | undefined;
    const floorY = typeof layer === "number" ? layer : layer?.layer?.y ?? (layer as { y?: number } | undefined)?.y ?? 0;
    return placeGazePoint(p, Number.isFinite(floorY) ? (floorY as number) : 0);
  };
  // a clip fits a non-standing pose only when it was made for it (clipfacts `lying` for "lie"; no seated clip facts yet)
  const clipPose = {
    poseOf: (w: string): string | undefined => poseOf.get(w),
    fits: (w: string, clip: string, pose: string): boolean => pose === "lie" && clipfacts?.[w]?.[clip]?.lying === true,
  };
  // F6: the initial poses (stage.start_pose) count from the first line, before any start/stage event
  for (const [who, p] of Object.entries((stage as any).start_pose ?? {})) {
    if (typeof p === "string" && p && actors.has(who)) poseOf.set(who, p);
  }
  /** a staged pose the rest clip does not fit switches it (k18_true: Mirai staged to sit fell back to sleep_curled) */
  const fitIdle = (who: string, pose: string | undefined): void => {
    const a = actors.get(who);
    const cur = a?.idleName?.();
    if (!a || !cur) return;
    const next = idleForPose(pose, cur, Object.keys(cast[who]?.clips ?? {}), clipfacts?.[who] ?? null);
    if (!next || !a.setIdle?.(next)) return;
    // in a bed: lying sinks BED_TUCK_M under the blanket, sitting up sits its seat on top of it (k19_true: Mirai sunk
    // in the mattress; k23_true: sit_idle stood its feet on the blanket, the seat in the air); lying again undoes the lift
    if (!bedOf(who) || a.act() === "sit") return;
    const up = pose === "lie" ? -(bedLifted.get(who) ?? BED_TUCK_M) : bedLift(clipfacts?.[who]?.[next]);
    if (pose === "lie") bedLifted.delete(who);
    else bedLifted.set(who, up);
    a.teleport(a.pos(), a.yaw(), a.act(), a.y() + up);
  };
  /** the lift fitIdle gave a body sitting up in its bed, undone when it lies back */
  const bedLifted = new Map<string, number>();
  /** a once-clip that ends sitting (wake_up) hands over to a sitting idle; the bed lift waits for the clip's end */
  const afterClip = new Map<string, string>();
  const playOnce = (who: string, clip: string): void => {
    const a = actors.get(who);
    if (!a) return;
    a.play(clip, { once: true });
    const cur = a.idleName?.();
    const next = cur ? idleAfterClip(clip, cur, Object.keys(cast[who]?.clips ?? {}), clipfacts?.[who] ?? null) : null;
    if (!next || !a.setIdle?.(next)) return;
    poseOf.set(who, "sit");
    afterClip.set(who, clip);
  };
  /** the clip / idle a stage directive names (Spark's staging, Nov 3): the idle takes over after the clip */
  const actOut = (who: string, sc0: { clip?: string; idle?: string }): void => {
    const a = actors.get(who);
    if (!a) return;
    const sc = fitStaged(sc0, poseOf.get(who), clipfacts?.[who] ?? null);
    if (sc.idle) a.setIdle?.(sc.idle);
    if (sc.clip) playOnce(who, sc.clip);
    else if (sc.procedural) a.gesture();
  };
  /** actors whose clip this beat's staging named: the text pick of the same beat does not override it */
  const stagedClipWho = new Set<string>();
  /** clips that wait for the walk of their directive to end */
  const onArrive = new Map<string, { clip?: string; idle?: string }>();
  /** actors that walked up to another one (a hug, a lap): the pair is never pushed apart until one of them moves on */
  const together = new Set<string>();
  let nearSeq = 0;
  /** a staged hug clip (kneeling mother + standing child, made chest to chest): the nearest actor is the partner. A
   *  partner sitting in the lap keeps the lap hold (the hug's arms would close over her head); otherwise the smaller
   *  body steps back until the two touch, both face each other, and the pair is not pushed apart (meadow, Nov 3) */
  const hugInPlace = (who: string, sc: { clip?: string; idle?: string }): { clip?: string; idle?: string } => {
    if (!sc.clip || !/hug/i.test(sc.clip)) return sc;
    const a = actors.get(who)!;
    let other: (typeof a) | undefined;
    let best = Infinity;
    for (const b of actors.values()) {
      if (b === a || offstageActors.has(b.who)) continue;
      const d = Math.hypot(b.pos()[0] - a.pos()[0], b.pos()[1] - a.pos()[1]);
      if (d < best && d < a.radius() + b.radius() + 0.6) (best = d), (other = b);
    }
    if (!other) return sc;
    if (/lap/i.test(other.idleName?.() ?? "")) return { idle: sc.idle };
    const [mover, anchor] = a.radius() <= other.radius() ? [a, other] : [other, a];
    const at = hugSpot(mover.pos(), anchor.pos(), mover.radius(), anchor.radius());
    if (at) mover.teleport(at, yawTo(at, anchor.pos()), mover.act(), mover.y());
    anchor.go([], yawTo(anchor.pos(), mover.pos()), anchor.act());
    together.add(a.who);
    together.add(other.who);
    return sc;
  };
  const settleArrivals = (): void => {
    for (const [who, sc] of [...onArrive]) {
      const a = actors.get(who);
      if (!a || a.moving()) continue;
      onArrive.delete(who);
      actOut(who, sc);
    }
  };
  const settleAfterClips = (): void => {
    for (const [who, clip] of afterClip) {
      const a = actors.get(who);
      if (!a || a.clip?.() === clip) continue;
      afterClip.delete(who);
      if (!bedOf(who) || a.act() === "sit") continue;
      const up = bedLift(clipfacts?.[who]?.[a.idleName?.() ?? ""]);
      bedLifted.set(who, up);
      a.teleport(a.pos(), a.yaw(), a.act(), a.y() + up);
    }
  };
  /** the bed an actor lies in: a place with a lie spot she claimed, or whose lie spot she is on */
  const bedOf = (who: string): Place | undefined => {
    const a = actors.get(who);
    if (!a) return undefined;
    const p = a.pos();
    return places.find((pl) => pl.lie && (claims[pl.name] === who || Math.hypot(pl.lie.at[0] - p[0], pl.lie.at[1] - p[1]) < 0.3));
  };
  /** a lying head inside the pillow slides the body toward the foot of the bed, once per rest clip, after the
   *  crossfade settles (k19_true: Mirai's head bone at 0.68 m inside a 0.75 m pillow) */
  const pillowDone = new Map<string, number>();
  /** the last bed settle (critic `bed_saw`): head bone, top under it, mattress under the body, shift */
  let bedSaw: unknown = null;
  const settleBeds = (now: number): void => {
    for (const a of actors.values()) {
      if (poseOf.get(a.who) !== "lie" || a.moving() || offstageActors.has(a.who)) continue;
      const bed = bedOf(a.who);
      if (!bed?.lie) continue;
      const key = `${a.who}|${a.idleName?.() ?? ""}|${bed.name}`;
      const seen = pillowDone.get(key);
      if (seen === undefined) {
        pillowDone.set(key, now);
        continue;
      }
      if (seen < 0 || now - seen < 0.6) continue;
      pillowDone.set(key, -1);
      const hp = headPose(a.group);
      if (!hp) continue;
      const [hx, hz] = bed.lie.head ?? [bed.lie.at[0], bed.lie.at[1] + 1];
      const l = Math.hypot(bed.lie.at[0] - hx, bed.lie.at[1] - hz) || 1;
      const foot: V2 = [(bed.lie.at[0] - hx) / l, (bed.lie.at[1] - hz) / l];
      const p0 = a.pos();
      // the mattress under her body: below her head bone + 0.3 m, never the ceiling
      const base = heightAt(p0[0], p0[1], hp.pos[1] + 0.3);
      if (base === null) continue;
      const sh = pillowShift(hp.pos, foot, heightAt, base, heightOf(a.who) * 0.1);
      bedSaw = { who: a.who, head: hp.pos.map((v) => Math.round(v * 100) / 100), under: heightAt(hp.pos[0], hp.pos[2], base + 0.6), base, foot, shift: sh, t: now };
      if (sh > 0) {
        const p = a.pos();
        a.teleport([p[0] + foot[0] * sh, p[1] + foot[1] * sh], a.yaw(), a.act(), a.y());
      }
    }
  };
  /** deterministic per-line seed for gesture variants: no Math.random in the runtime */
  let lineSeq = 0;
  const handlers: StageHandlers = {
    start(e) {
      const items = Array.isArray((e as any).start) ? (e as any).start : [e];
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const who = typeof it.who === "string" ? it.who : null;
        if (!who || !actors.has(who)) continue;
        const a = actors.get(who)!;
        if (typeof it.pose === "string" && it.pose) {
          poseOf.set(who, it.pose);
          fitIdle(who, it.pose);
        }
        cancelExit(who);
        // what the actor is already doing when the film opens (Squidward painting): after the pose's own idle fit
        const opens = startStaged(it, Object.keys(cast[who]?.clips ?? {}));
        if (opens.idle) actOut(who, opens);
        if (it.offstage) {
          offstageActors.add(who);
        } else {
          offstageActors.delete(who);
        }
        if (it.place) {
          const pl = places.find((p) => p.name === it.place || p.id === it.place);
          if (pl) {
            const pose = typeof it.pose === "string" ? it.pose : undefined;
            // lie / sit on a bed: the same spot and height as the stage.json start (startSpot), one rule for both
            const ss = startSpot(pl, pose, a.pos(), places);
            const spot = pose === "stand_on" && pl.stand_on ? pl.stand_on.at : ss.at;
            const yaw = ss.yaw;
            const act = pose === "sit" ? "sit" : "idle";
            const lvl = pl.level ?? null;
            const y = (layerOf(lvl).layer.y ?? 0) + ss.y;
            claims[pl.name] = who;
            a.teleport(spot, yaw, act, y, act === "sit" ? pl.top : undefined);
          }
        }
      }
    },
    stage(e) {
      lastBeatHadStage = true;
      const who = typeof e.who === "string" ? e.who : null;
      if (!who || !actors.has(who)) {
        warnings.push(`stage: actor "${String(e.who)}" unknown`);
        return;
      }
      if (typeof e.look === "string") stageLook.set(who, e.look);
      else stageLook.delete(who);
      const a = actors.get(who)!;
      const action = typeof e.action === "string" ? e.action : "stay";
      const placeName = typeof e.place === "string" ? e.place : undefined;
      const lookTarget = typeof e.look === "string" ? e.look : undefined;
      const pose = typeof e.pose === "string" ? e.pose : undefined;
      if (pose) {
        poseOf.set(who, pose);
        fitIdle(who, pose);
      }
      const sc = stagedClips(e as { clip?: unknown; idle?: unknown }, Object.keys(cast[who]?.clips ?? {}));
      onArrive.delete(who);
      if (sc.clip) stagedClipWho.add(who);

      const getTargetPos = (tgt?: string): V2 | null => {
        if (!tgt) return null;
        if (actors.has(tgt)) return actors.get(tgt)!.pos();
        const pl = places.find((p) => p.name === tgt || p.id === tgt);
        return pl ? pl.at : null;
      };

      if (action === "stay") {
        // B56: an explicit stay keeps an exiting actor in the room, where she stands now
        if (exiting.has(who) || exitPending.has(who)) {
          cancelExit(who);
          a.go([], a.yaw(), a.act());
        }
        actOut(who, hugInPlace(who, sc));
        return;
      }
      // one of a pair moves on: the pair is over (both may be pushed apart again)
      if (action !== "turn_away" && together.has(who)) together.clear();
      if (action === "turn_away") {
        cancelExit(who);
        const tgtPos = getTargetPos(lookTarget);
        if (tgtPos) {
          const targetYaw = yawTo(a.pos(), tgtPos);
          const turnYaw = (targetYaw + 180) % 360;
          a.go([], turnYaw, a.act());
        } else {
          warnings.push(`stage: turn_away requires look target`);
        }
        actOut(who, sc);
        return;
      }
      if ((action === "come" || action === "goto") && placeName && placeName !== who && actors.has(placeName)) {
        // walk up to another actor: a place made on the spot, `gap` short of her (a lap sits close in)
        const other = actors.get(placeName)!;
        const gap = approachGap([sc.clip, sc.idle], a.radius(), other.radius());
        const at = nearActor(a.pos(), other.pos(), gap);
        const name = `@${placeName}#${nearSeq++}`;
        for (let i = places.length - 1; i >= 0; i--) if (places[i]!.name.startsWith(`@`) && claims[places[i]!.name] === who) (delete claims[places[i]!.name], places.splice(i, 1));
        const lvl = toucher.levelOf(placeName);
        places.push({ name, id: name, kind: "stand", room: roomOfActor(other, lvl)?.room ?? "", level: lvl, at, yaw: yawTo(at, other.pos()), look: other.pos(), obstacle: null, poses: ["stand"] });
        cancelExit(who);
        pendingQueue.push({ kind: "walk", speaker: who, dt: 0, tags: { ...tagsOf(false), enter: true } });
        touch(who, name, undefined, yawTo(at, other.pos()));
        together.add(who);
        together.add(placeName);
        onArrive.set(who, sc);
        return;
      }
      if (action === "come" || action === "goto") {
        if (!placeName) {
          warnings.push(`stage: ${action} requires place -> stay`);
          return;
        }
        const pl = places.find((p) => p.name === placeName || p.id === placeName);
        if (!pl) {
          warnings.push(`stage: place "${placeName}" not in places bank -> stay`);
          return;
        }
        cancelExit(who);
        const tgtPos = getTargetPos(lookTarget);
        const lookYaw = tgtPos ? yawTo(pl.at, tgtPos) : "along";
        pendingQueue.push({ kind: "walk", speaker: who, dt: 0, tags: { ...tagsOf(false), enter: true } });
        touch(who, pl.name, pose, lookYaw);
        onArrive.set(who, sc);
        return;
      }
      if (action === "enter") {
        if (!placeName) {
          warnings.push(`stage: enter requires door place -> stay`);
          return;
        }
        const target = places.find((p) => p.name === placeName || p.id === placeName);
        if (!target) {
          warnings.push(`stage: door place "${placeName}" not in places bank -> stay`);
          return;
        }
        cancelExit(who);
        offstageActors.delete(who);
        pendingQueue.push({ kind: "walk", speaker: who, dt: 0, tags: { ...tagsOf(false), enter: true } });
        const isDoor = (p: Place): boolean => p.kind === "door" || !!p.poses?.includes("door");
        if (!isDoor(target)) {
          // the director named where she goes, not the door: come in through the room's door, then walk there;
          // no door in the room -> walk there from where she is
          const via = places.find((p) => isDoor(p) && p.room === target.room) ?? null;
          if (via) {
            // B64: a room door without a usable yaw still is the entrance, along a fixed side (as B04)
            const viaYaw = typeof via.yaw === "number" && Number.isFinite(via.yaw) ? via.yaw : 0;
            if (viaYaw !== via.yaw) warnings.push(`stage: enter door "${via.name}" has no known side -> yaw 0`);
            const s = interRoomDoorStep(via.at, viaYaw, 1.0);
            a.teleport(s.doorPos, s.yaw, "idle", layerOf(via.level ?? null).layer.y ?? 0);
          } else warnings.push(`stage: enter "${target.name}" is not a door and room "${target.room ?? "?"}" has none -> walks from where she is`);
          const tgt = getTargetPos(lookTarget);
          touch(who, target.name, pose, tgt ? yawTo(target.at, tgt) : "along");
          return;
        }
        const door = target;
        const lvl = door.level ?? null;
        const y = layerOf(lvl).layer.y ?? 0;
        // B04: a door without a usable yaw enters along a fixed side, like exit does
        const doorYaw = typeof door.yaw === "number" && Number.isFinite(door.yaw) ? door.yaw : 0;
        if (doorYaw !== door.yaw) warnings.push(`stage: enter door "${door.name}" has no known side -> yaw 0`);
        const step = interRoomDoorStep(door.at, doorYaw, 1.0);
        a.teleport(step.doorPos, step.yaw, "idle", y);
        passStart(door.id, who);
        enteringBy.set(who, door.id);
        // the step in ends on a cell one can walk on (a table a step inside the door would trap her there)
        const route = toucher.stepIn(door.at, doorYaw, lvl);
        if (!route) warnings.push(`stage: enter "${door.name}": nothing walkable inside the door -> stays in the doorway`);
        const path = route ?? [];
        const end = path.length ? path[path.length - 1]! : step.doorPos;
        const tgtPos = getTargetPos(lookTarget);
        const faceYaw = tgtPos ? yawTo(end, tgtPos) : step.yaw;
        a.go(path, faceYaw, "idle", y);
        return;
      }
      if (action === "exit") {
        const lvl = toucher.levelOf(who);
        const curRoom = roomAt(a.pos(), lvl)?.room;
        const door = places.find((p) => (p.room === curRoom || !curRoom) && (p.kind === "door" || p.poses?.includes("door")));
        if (!door) {
          warnings.push(`stage: exit finds no door in room "${curRoom ?? "?"}" -> stay`);
          return;
        }
        const sideKnown = typeof door.yaw === "number" && Number.isFinite(door.yaw);
        if (!sideKnown) {
          warnings.push(`stage: exit door "${door.name}" has no known exit side -> stops at the door`);
          const r0 = toucher.touch(who, door.name, "door", 0); // door yaw is unusable, face a fixed way
          if (r0 === "walk") exiting.add(who);
          else if (r0 === "skip") offstageActors.add(who);
          else if (r0 === "queued") {
            exitPending.set(who, { door, noSide: true });
            warnings.push(`stage: exit waits for "${who}" to step off the ramp to "${door.name}"`);
          }
          else warnings.push(`stage: exit to "${door.name}" is ${r0} -> stay`);
          return;
        }
        const res = toucher.touch(who, door.name, "door");
        if (res === "walk") {
          exiting.add(who);
          exitThrough.set(who, door);
        }
        else if (res === "skip") offstageActors.add(who);
        else if (res === "queued") {
          exitPending.set(who, { door, noSide: false });
          warnings.push(`stage: exit waits for "${who}" to step off the ramp to "${door.name}"`);
        }
        else warnings.push(`stage: exit to "${door.name}" is ${res} -> stay`);
        return;
      }
      warnings.push(`stage: unknown action "${action}" -> stay`);
    },
    line(e) {
      beatIn(e);
      lastBeatHadStage = false;
      const who = whoOf(e);
      if (who) lastSpeaker = who;
      const inherited = who ? (stageLook.get(who) ?? null) : null;
      if (who) stageLook.delete(who);
      const lookName = typeof e.look === "string" ? e.look : inherited;
      gazeBeat = { speaker: who ?? null, at: lookName, place: lookName ? (places.find((p) => p.name === lookName) ?? null) : null, until: nowT + Math.max(1, Number(e.dur ?? SPEAK_SECONDS)) + GAZE_SILENCE };
      pendingQueue.push({ kind: "line", speaker: who ?? undefined, durationS: Number(e.dur ?? SPEAK_SECONDS), shot: typeof e.shot === "string" ? e.shot : undefined, dt: 0, beat: typeof e.beat === "number" ? e.beat : undefined, tags: tagsOf(!!lookName && lookName !== who && actors.has(lookName)) });
      subs.line({ who: e.who, text: e.text, audio: e.audio });
      if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
        window.dispatchEvent(new CustomEvent("stage_line", { detail: { who: e.who ?? null, text: String(e.text ?? "") } }));  // host hook (clip crutch)
      }
      if (who) actors.get(who)!.speak(Math.max(1, Number(e.dur ?? SPEAK_SECONDS)));
      // the gaze turns the head 60 deg at most: a standing speaker who names whom he talks to turns his body to
      // him (Squidward, Nov 3: SpongeBob said "It's beautiful, Squidward" with his back to him). Seated, lying or
      // walking keeps the body; the head still turns.
      // a line that names no one, two in the room: it is said to the other one (Squidward spoke to his canvas)
      const sp = who ? actors.get(who) : undefined;
      const roomOf = (x: Actor): unknown => roomOfActor(x, toucher.levelOf(x.who))?.room;
      const mates = sp ? [...actors.values()].filter((o) => o !== sp && !offstageActors.has(o.who) && roomOf(o) === roomOf(sp)) : [];
      const addressee = lookName ? (lookName !== who && !offstageActors.has(lookName) ? actors.get(lookName) : undefined) : mates.length === 1 ? mates[0] : undefined;
      if (sp && addressee && sp.act() !== "sit" && poseOf.get(who!) !== "lie" && !sp.moving()) {
        const y = yawTo(sp.pos(), addressee.pos());
        if (Math.abs((((y - sp.yaw()) % 360) + 540) % 360 - 180) > 30) sp.turn(y);
      }
      const pick0 = clipForBeat({ who, text: e.text, gesture: e.gesture, remarks: e.remarks, pose: who ? poseOf.get(who) : undefined, seed: lineSeed((stage as any).seed, lineSeq++) }, cast, aliases, clipPose);
      const pick = pick0 && stagedClipWho.has(pick0.who) ? null : pick0;
      stagedClipWho.clear();
      if (pick?.procedural) actors.get(pick.who)?.gesture();
      else if (pick) playOnce(pick.who, pick.clip);
      const t = touchName(e.touch);
      if (who && t) {
        cancelExit(who);
        touch(who, t);
      }
    },
    narrator(e) {
      beatIn(e);
      gazeBeat = { speaker: null, at: null, place: namedIn(String(e.text ?? "")) ? null : placeIn(String(e.text ?? "")), until: nowT + Math.max(1, Number(e.dur ?? SPEAK_SECONDS)) + GAZE_SILENCE };
      pendingQueue.push({ kind: "narrator", durationS: Number(e.dur ?? SPEAK_SECONDS), shot: typeof e.shot === "string" ? e.shot : undefined, about: namedIn(String(e.text ?? "")), dt: 0, beat: typeof e.beat === "number" ? e.beat : undefined, tags: tagsOf(false) });
      subs.narrator({ text: e.text, audio: e.audio });
      if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
        window.dispatchEvent(new CustomEvent("stage_line", { detail: { who: null, text: String(e.text ?? "") } }));  // host hook (clip crutch)
      }
      const pick0 = clipForBeat({ who: null, text: e.text }, cast, aliases, clipPose);
      const pick = pick0 && stagedClipWho.has(pick0.who) ? null : pick0;
      stagedClipWho.clear();
      if (pick?.procedural) actors.get(pick.who)?.gesture();
      else if (pick) playOnce(pick.who, pick.clip);
      const hadStage = lastBeatHadStage || !!(e as any).stage;
      lastBeatHadStage = false;
      if (!hadStage) {
        const hit = remark(String(e.text ?? ""));
        if (hit) touch(hit.who, hit.place);
      }
    },
    book_end() {
      // К2: the last tag asks the director for the final pull-out unless a Spark plan has the camera
      if (!shots?.active(nowT)) pendingQueue.push({ kind: "tick", dt: 0, tags: { last: true } });
      else warnings.push("LAST_UNDER_PLAN");
      shots?.end(nowT);
    },
    scene_end() {
      // К2: the last tag asks the director for the final pull-out unless a Spark plan has the camera
      if (!shots?.active(nowT)) pendingQueue.push({ kind: "tick", dt: 0, tags: { last: true } });
      else warnings.push("LAST_UNDER_PLAN");
      sceneFirst = true;
      shots?.end(nowT);
    },
    touch(e) {
      const who = whoOf(e);
      const t = touchName(e.object ?? e.place ?? e.touch);
      if (who && t) {
        cancelExit(who);
        touch(who, t);
      }
    },
    mode(e) {
      const m = e.mode === "freestyle" ? "freestyle" : typeof e.mode === "string" ? e.mode : null;
      if (m) setMode(m);
    },
    story(e) {
      if (e.type === "schedule") {
        pieces = ((e.events as any[]) ?? []).filter((x) => x.kind === "story" || x.kind === "exit").length;
      } else if (e.kind === "story" || e.kind === "exit") {
        told++;
        if (c.film) return;
        const w = String(e.what ?? "").replace(/^The story moves on:? ?/, "");
        if (ticker && tickerText) {
          ticker.hidden = false;
          tickerText.textContent = `📖 ${told}/${pieces || "?"} · ${w}`;
          tickerText.style.animationDuration = `${Math.max(8, tickerText.textContent.length * 0.18)}s`;
        }
      }
    },
  };

  let camRoom: string | null = null;
  let camOutline: V2[] = [];
  let camHeight: number | null = null;
  let prevCut: number | null = null;
  const look = new Vector3();
  /** the world point `a` looks at right now, or null */
  const gazeOf = (a: Actor, list: Actor[]): [number, number, number] | null => {
    const cast: GazeActor[] = list.map((o) => ({ who: o.who, room: roomAt(o.pos(), toucher.levelOf(o.who))?.room, pos: o.pos(), eye: o.eye() }));
    const self = cast.find((o) => o.who === a.who);
    return self ? resolveGaze(gazeBeat, nowT, self, cast, placePoint) : null;
  };
  // the film critic's facts (every 0.5 s -> window.__critic, read by bin/record.mjs)
  let lastPlan = "wide";
  // Г8: the active plan's name for the critic, the 0.3 m clamp flag, the meshes a cut hid, the director's fov
  let shotName: string | null = null;
  let shotClamped = false;
  let cutHidden: any[] = [];
  let directorFov: number | null = null;
  let dirMove: { out: ReturnType<typeof director.step>; t0: number; durationS: number } | null = null;
  let dirCut = 0;
  /** the director's last input crew and warnings, for the critic (k15: a pair shot lost a lying actor) */
  let dirSaw: unknown = null;
  let dirCutSaw: unknown = null;
  /** К2: the director's move through the same shotFrame as a Spark plan; false = no `end`, smoothCam path */
  const applyDirectorMove = (now: number): boolean => {
    const m = dirMove;
    if (!m || !m.out.end) return false;
    const o = m.out;
    const act: ActiveShot = {
      shot: { name: o.move ?? o.plan, at: { k: "num", x: 0 }, to: { k: "num", x: m.durationS }, from: { pos: o.cam, look: o.lookRef ?? o.look, fov: o.fov }, end: { pos: o.end!, look: o.lookEndRef ?? o.lookEnd ?? o.look, fov: o.fovEnd }, cut: false, shake: o.shake ?? 0, ease: o.ease ?? "io" },
      index: 0, at: m.t0, to: m.t0 + m.durationS,
    };
    const fr = shotFrame(act, now, boneOf, directorFov ?? c.camera.fov);
    const f = roomAt([fr.pos[0], fr.pos[2]]) ?? (camRoom ? (c.geo.floors ?? []).find((q: any) => q.room === camRoom) : null) ?? (c.geo.floors ?? [])[0];
    let p: V3 = fr.pos;
    if (f?.outline?.length) {
      const floorY = layerOf(f.level ?? null).layer.y ?? 0;
      p = legalCameraPoint(p, { outline: f.outline, rect: roomRect(f.outline), height: isOpen(f.room) ? floorY + 20 : ceilingOf(f.room), floorY });
    }
    if (now < m.t0 + m.durationS && fr.fov !== null && fr.fov !== c.camera.fov) {
      if (directorFov === null) directorFov = c.camera.fov;
      c.camera.fov = fr.fov;
      c.camera.updateProjectionMatrix();
    }
    {
      const q = clearOfBodies(p, fr.look, camBodies());
      if (roomAt([q[0], q[2]])) p = q;
    }
    c.camera.position.set(p[0], p[1], p[2]);
    look.set(fr.look[0], fr.look[1], fr.look[2]);
    c.camera.lookAt(look.x, look.y, look.z);
    c.camera.updateMatrixWorld();
    return true;
  };
  /** every actor on stage as a column for the camera (clearOfBodies): feet to 12 cm over the head bone */
  const camBodies = (): CamBody[] =>
    [...actors.values()]
      .filter((a) => !offstageActors.has(a.who) && a.group.visible)
      .map((a) => ({ pos: a.pos(), y0: a.group.position.y, top: (boneOf(a.who, "head")?.[1] ?? a.group.position.y + heightOf(a.who)) + 0.12, r: a.radius() }));
  const boneOf = (who: string, bone: "head" | "hips"): V3 | null => {
    const a = actors.get(who);
    if (!a) return null;
    let found: any = null;
    a.group.traverse((o) => {
      const n = o.name.toLowerCase();
      if (!found && (n === bone || n.endsWith(`:${bone}`) || n.endsWith(`_${bone}`))) found = o;
    });
    const v = new Vector3();
    if (found) {
      found.getWorldPosition(v);
      return [v.x, v.y, v.z];
    }
    const p = a.pos();
    return [p[0], a.group.position.y + heightOf(who) * (bone === "head" ? 0.93 : 0.5), p[1]];
  };
  /** puts the camera on the active plan (no smoothing, a hard switch); false -> the director has the camera */
  const applyShot = (now: number): boolean => {
    const act = shots?.active(now) ?? null;
    const fr = act ? shotFrame(act, now, boneOf, directorFov ?? c.camera.fov) : null;
    // only what the cut itself hides comes back (a mesh hidden by someone else stays hidden)
    const hide = (fr?.cut ? cutMeshes(c.scene, fr.pos, fr.look) : []).filter((m) => m.visible || cutHidden.includes(m));
    for (const m of cutHidden) if (!hide.includes(m)) m.visible = true;
    for (const m of hide) m.visible = false;
    cutHidden = hide;
    if (!fr) {
      shotName = null;
      shotClamped = false;
      if (directorFov !== null) {
        c.camera.fov = directorFov;
        c.camera.updateProjectionMatrix();
        directorFov = null;
      }
      return false;
    }
    let p: V3 = fr.pos;
    shotClamped = false;
    if (!fr.cut) {
      const f = roomAt([p[0], p[2]]) ?? (camRoom ? (c.geo.floors ?? []).find((q: any) => q.room === camRoom) : null) ?? (c.geo.floors ?? [])[0];
      if (f?.outline?.length) {
        const floorY = layerOf(f.level ?? null).layer.y ?? 0;
        const height = isOpen(f.room) ? floorY + 20 : ceilingOf(f.room);
        const q = legalCameraPoint(p, { outline: f.outline, rect: roomRect(f.outline), height, floorY });
        if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) > 0.3) shotClamped = true;
        p = q;
      }
    }
    if (fr.fov !== null && fr.fov !== c.camera.fov) {
      if (directorFov === null) directorFov = c.camera.fov;
      c.camera.fov = fr.fov;
      c.camera.updateProjectionMatrix();
    }
    c.camera.position.set(p[0], p[1], p[2]);
    look.set(fr.look[0], fr.look[1], fr.look[2]);
    c.camera.lookAt(look.x, look.y, look.z);
    c.camera.updateMatrixWorld();
    shotName = fr.name;
    return true;
  };
  const critic = typeof window !== "undefined"
    ? createCritic(((window as any).__critic ??= []) as CriticFact[], () => {
        const cam = c.camera.position;
        const on = [...actors.values()].filter((a) => !offstageActors.has(a.who));
        // F12: lines can overlap in dur — the latest line's speaker wins while still speaking, not the first timer
        const late = gazeBeat?.speaker && nowT < (gazeBeat?.until ?? 0) ? on.find((a) => a.who === gazeBeat.speaker) : undefined;
        const sp = (late?.speaking() ? late : undefined) ?? on.find((a) => a.speaking());
        return {
          plan: lastPlan,
          shot: shotName,
          move: shotName ?? dirMove?.out.move ?? null,
          dcut: dirCut,
          dir_saw: dirCutSaw,
          bed_saw: bedSaw,
          shot_clamped: shotClamped,
          cam: [cam.x, cam.y, cam.z] as [number, number, number],
          look: [look.x, look.y, look.z] as [number, number, number],
          speaker: sp?.who ?? null,
          fov: c.camera.fov,
          aspect: c.camera.aspect,
          actors: on.map((a) => {
            const e = a.eye();
            const h = heightOf(a.who);
            const g = gazeOf(a, on);
            // measured head bone after animation (F10/F11); unrigged stand-ins keep the gaze/yaw fallback
            const hp = headPose(a.group);
            const faceYaw = hp?.faceYaw ?? (g ? (Math.atan2(g[0] - e[0], g[2] - e[2]) * 180) / Math.PI : a.yaw());
            // rendered feet (group.position.y carries the actor's sit drop `Actor.drop()` and bob; eye() lowers by the
            // same drop), head from the bone so sit follows the pose
            return { who: a.who, pos: a.pos(), y: a.group.position.y, yaw: a.yaw(), faceYaw, facePitch: hp?.facePitch, headPos: hp?.pos, headY: e[1], height: h, clear: sight([cam.x, cam.y, cam.z], e), boneSig: boneSig(a.group) };
          }),
        };
      })
    : null;
  /**
   * Н9: actors never stand inside each other. Per level, after the actors stepped: `separate()` over the capsules.
   * Not counted: offstage and exiting actors, actors off a level (lying on a bed, on a ramp, on a table top), and
   * walkers: the route leads them (pushing a walker off a goal next to someone loops forever); they are set apart
   * once they stop. A seated actor never moves. A standing one steps out at walking speed at most (no jump).
   * A push off the walkable floor (nav bitmap) is refused: that actor stays where it was.
   */
  const spread = (dt: number): void => {
    const step = Math.max(0, dt) * WALK_SPEED;
    const byLevel = new Map<string, Actor[]>();
    for (const a of actors.values()) {
      if (offstageActors.has(a.who) || exiting.has(a.who) || a.moving() || together.has(a.who)) continue;
      const lvl = toucher.levelOf(a.who);
      if (lvl === null) continue;
      (byLevel.get(lvl) ?? byLevel.set(lvl, []).get(lvl)!).push(a);
    }
    for (const [lvl, list] of byLevel) {
      if (list.length < 2) continue;
      const fixed = list.map((a) => a.act() === "sit");
      const r = separate(list.map((a) => a.pos()), list.map((a) => a.radius()), { fixed });
      const L = layerOf(lvl === "" ? null : lvl);
      list.forEach((a, i) => {
        const [x0, z0] = a.pos();
        let [x, z] = r.pos[i]!;
        const d = Math.hypot(x - x0, z - z0);
        if (d === 0) return;
        if (d > step) (x = x0 + ((x - x0) * step) / d), (z = z0 + ((z - z0) * step) / d);
        if (L && !navBit(L.layer, L.bits, x, z)) return;
        a.shove(x, z);
      });
    }
  };
  const update = (dt: number, now: number): void => {
    nowT = now;
    headT = now;
    shots?.tick(now);
    {
      const all = [...actors.values()];
      for (const a of all) a.look(gazeOf(a, all));
    }
    for (const a of actors.values()) {
      // offstage = not in the room: not drawn either (Koshakan: Mama stood by the shelf before her entrance)
      a.group.visible = !offstageActors.has(a.who);
      a.update(dt, now);
    }
    spread(dt);
    settleBeds(now);
    settleAfterClips();
    settleArrivals();
    for (const who of [...exiting]) {
      const act = actors.get(who);
      if (!act?.moving()) {
        const door = exitThrough.get(who);
        if (door && act) {
          // second leg: into the door point, then past the door plane by the capsule radius (+ margin), against the inward yaw
          exitThrough.delete(who);
          const rad = (door.yaw * Math.PI) / 180;
          const out = EXIT_PAST_M;
          const beyond: V2 = [door.at[0] - Math.sin(rad) * out, door.at[1] - Math.cos(rad) * out];
          const lvl = door.level ?? toucher.levelOf(who) ?? null;
          const y = layerOf(lvl).layer.y ?? 0;
          act.go([door.at, beyond], yawTo(door.at, beyond), "idle", y);
          passStart(door.id, who);
          exitDoor.set(who, door.id);
          continue;
        }
        // the last step and the stop land in one update: go offstage on the next one,
        // so no frame both moves and is offstage
        if (!exitSettled.has(who)) {
          exitSettled.add(who);
          continue;
        }
        exitSettled.delete(who);
        exiting.delete(who);
        offstageActors.add(who);
        const d = exitDoor.get(who);
        if (d) (exitDoor.delete(who), passEnd(d, who));
      } else exitSettled.delete(who);
    }
    for (const [who, id] of [...enteringBy]) {
      if (actors.get(who)?.moving()) continue;
      enteringBy.delete(who);
      passEnd(id, who);
    }
    for (const [id, at] of [...doorShut]) {
      if (nowT < at) continue;
      doorShut.delete(id);
      c.door?.(id, false);
    }
    for (const [who, p] of [...exitPending]) {
      if (toucher.levelOf(who) === null) continue;
      const res = p.noSide ? toucher.touch(who, p.door.name, "door", 0) : toucher.touch(who, p.door.name, "door");
      if (res === "queued") continue;
      exitPending.delete(who);
      if (res === "walk") {
        exiting.add(who);
        if (!p.noSide) exitThrough.set(who, p.door);
      }
      else if (res === "skip") offstageActors.add(who);
      else warnings.push(`stage: exit to "${p.door.name}" is ${res} -> stay`);
    }
    toucher.tick();
    const onShot = shots ? applyShot(now) : false;
    const list = [...actors.values()];
    const sorted = [...list].sort((x, y) => (x.who < y.who ? -1 : 1));
    // F5: handlers may fire twice before one update — every queued event reaches the director in order, the camera shows the last
    const queued = pendingQueue.takeAll();
    const events: DEvent[] = queued.length ? queued : [{ kind: "tick", dt } as DEvent];
    let s: ReturnType<typeof director.step> | null = null;
    for (let idx = 0; idx < events.length; idx++) {
      const ev = events[idx];
      const isLast = idx === events.length - 1;
      if (queued.length) ev.dt = isLast ? dt : 0;
      // F1: a line always leads with its own speaker (ignoring stale speaking timers);
      // a narrator leads with the first actor by name; ticks keep the current talker
      let focus: Actor | undefined;
      const onstageList = list.filter((a) => !offstageActors.has(a.who));
      const onstageSorted = sorted.filter((a) => !offstageActors.has(a.who));
      if (ev.kind === "line" && ev.speaker) focus = (!offstageActors.has(ev.speaker) ? list.find((a) => a.who === ev.speaker) : undefined) ?? onstageList.find((a) => a.speaking()) ?? onstageSorted[0] ?? sorted[0];
      else if (ev.kind === "narrator") focus = (ev.about && !offstageActors.has(ev.about) ? list.find((a) => a.who === ev.about) : undefined) ?? onstageSorted[0] ?? sorted[0];
      else focus = onstageList.find((a) => a.speaking()) ?? (ev.speaker && !offstageActors.has(ev.speaker) ? list.find((a) => a.who === ev.speaker) : undefined) ?? (lastSpeaker && !offstageActors.has(lastSpeaker) ? list.find((a) => a.who === lastSpeaker) : undefined) ?? onstageSorted[0] ?? sorted[0];
      focus ??= onstageSorted[0] ?? sorted[0];
      if (!focus) {
        if (!queued.length) return;
        continue;
      }
      if (ev.kind === "line" && !ev.speaker) ev.speaker = focus.who;
      const lvl = toucher.levelOf(focus.who);
      // never leave the camera unplaced (F36): off every floor (a ramp) -> the room under the actor on any level, else the first room
      const f = roomAt(focus.pos(), lvl) ?? roomAt(focus.pos()) ?? (c.geo.floors ?? [])[0];
      if (!f) {
        if (!queued.length) return;
        continue;
      }
      camRoom = f.room;
      camOutline = f.outline ?? [];
      camHeight = ceilingOf(f.room);
      const floorY = layerOf(lvl ?? (f as any).level ?? null).layer.y ?? 0;
      // only the actors of the speaker's room and level are in the frame
      const here = dActors(list).filter((d) => inScene(d, f.room, lvl));
      if (!here.length) {
        if (!queued.length) return;
        continue;
      }
      // the speaker leads (a narrator line: the first actor by name), so the director's room is the one under `focus`
      if (ev.kind !== "line" && ev.kind !== ("walk" as string)) ev.speaker = undefined;
      ev.room = f.room;
      stepBodies = camBodies();
      const out = director.step({
        event: ev,
        actors: here,
        room: { outline: f.outline, ceiling: camHeight, open: isOpen(f.room), floorY },
        rng,
        fov: directorFov ?? c.camera.fov,
        aspect: c.camera.aspect,
        clear: seesPast,
      });
      if (isLast) s = out;
      dirSaw = { ev: ev.kind, speaker: ev.speaker ?? null, tags: ev.tags ?? null, crew: here.map((d) => ({ n: d.name, lv: d.level, lie: !!d.lying, head: d.head?.map((x) => Math.round(x * 100) / 100) })), all: dActors(list).map((d) => [d.name, d.room, d.level]), focus: [f.room, lvl], warn: out.warnings ?? [] };
      if (out.cut !== dirCut) {
        dirSaw = { ...(dirSaw as object), atCut: { cam: out.cam.map((x) => Math.round(x * 100) / 100), look: out.look.map((x) => Math.round(x * 100) / 100), end: out.end ?? null, move: out.move ?? null, lookRef: out.lookRef ?? null } };
        dirCutSaw = dirSaw;
        dirCut = out.cut;
        dirMove = { out, t0: now, durationS: out.moveDurationS ?? 4 };
      } else if (dirMove && out.end) {
        // a drift added to a long static plan starts now; any other refresh keeps the clock
        dirMove = !dirMove.out.end ? { out, t0: now, durationS: out.moveDurationS ?? 4 } : { ...dirMove, out };
      }
    }
    if (!s) return;
    if (onShot) {
      // the plan has the camera; leaving it jumps to the director's frame (prevCut reset -> k = 1)
      prevCut = null;
      lastPlan = s.plan;
      critic?.tick(dt, now);
      return;
    }
    const moveDone = !dirMove?.out.end || now >= dirMove.t0 + dirMove.durationS;
    if (moveDone && directorFov !== null && !onShot && (s.fov === undefined || !!dirMove?.out.end)) {
      c.camera.fov = directorFov;
      c.camera.updateProjectionMatrix();
      directorFov = null;
    }
    if (applyDirectorMove(now)) {
      prevCut = s.cut;
      lastPlan = s.plan;
      critic?.tick(dt, now);
      return;
    }
    const k = s.cut !== prevCut ? 1 : 1 - Math.exp(-4 * dt);  // a cut jumps, inside a plan the camera follows smoothly
    prevCut = s.cut;
    const pos = c.camera.position;
    // F5: the blended position is kept inside the camera room (an L room's notch is outside between two inside frames)
    const sm = smoothCam([pos.x, pos.y, pos.z], s.cam, k, camOutline);
    pos.set(sm[0], sm[1], sm[2]);
    // К2: a static move still carries its lens and its shake
    if (s.fov !== undefined && s.fov !== c.camera.fov) {
      if (directorFov === null) directorFov = c.camera.fov;
      c.camera.fov = s.fov;
      c.camera.updateProjectionMatrix();
    }
    // the same slow hand-held sway as a moving plan (1.1-1.7 Hz); the old sin(37t) was a 6 Hz tremble (k12_storybook)
    if (s.shake) {
      const w = shakeOf(s.shake, now - (dirMove?.t0 ?? 0));
      pos.set(pos.x + w[0], pos.y + w[1], pos.z + w[2]);
    }
    look.set(look.x + (s.look[0] - look.x) * k, look.y + (s.look[1] - look.y) * k, look.z + (s.look[2] - look.z) * k);
    {
      // never through a wall: a step back that leaves every room keeps the camera where it was
      const q = clearOfBodies([pos.x, pos.y, pos.z], [look.x, look.y, look.z], camBodies());
      if (roomAt([q[0], q[2]])) pos.set(q[0], q[1], q[2]);
    }
    c.camera.lookAt(look.x, look.y, look.z);
    c.camera.updateMatrixWorld();
    lastPlan = s.plan;
    critic?.tick(dt, now);
  };

  return {
    warnings: () => [...warnings],
    handlers,
    update,
    api: {
      actors: () => [...actors.values()].map((a) => ({ who: a.who, pos: a.pos(), yaw: a.yaw(), act: a.act(), offstage: offstageActors.has(a.who) })),
      camera: () => ({ pos: [c.camera.position.x, c.camera.position.y, c.camera.position.z], room: camRoom, height: camHeight }),
      subs: () => subs.log(),
      gaze: (who) => {
        const a = actors.get(who);
        return a ? gazeOf(a, [...actors.values()]) : null;
      },
    },
  };
}
