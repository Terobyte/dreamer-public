import { Vector3, type PerspectiveCamera, type Scene } from "three";
import type { StageEvent, StageHandlers } from "../bridge.js";
import type { NavRamp } from "../../nav/floor.js";
import { aliasesOf, clipForBeat } from "./anim.js";
import { createActor, type Actor } from "./actors.js";
import { createDirector, createPendingQueue, initialYaws, smoothCam, type DActor, type DEvent } from "./director.js";
import type { StageLevel } from "./path.js";
import { interRoomDoorStep } from "./path.js";
import { floorAt, stageRegex, startSpot, yawTo, type Claims, type Place, type V2 } from "./places.js";
import { createToucher } from "./touch.js";
import { createSubs } from "./subs.js";
import { createSight } from "./sight.js";
import { createCritic, boneSig, headPose, type CriticFact } from "./critic.js";

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

/** Reads stage.json + places + cast, puts the cast on its start places and returns the event handlers and the frame step. */
export async function startStage(c: StageCtx): Promise<Stage> {
  const locHref = typeof location !== "undefined" ? location.href : "http://localhost/";
  const stageAbs = new URL(c.stageUrl || "stage/stage.json", locHref);
  const stage: any = (c as any).stage ?? (await fetch(stageAbs).then((r) => r.json()));
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
  const cast: Record<string, { glb?: string; height_m?: number; clips?: Record<string, string>; idle?: string; verbs?: Record<string, string[]>; aliases?: string[] }> =
    (c as any).cast ?? (await fetch(castUrl).then((r) => r.json()));
  const names = Object.keys(cast);

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
    const spot = sp && sp.name === startName ? startSpot(sp, stage.start_pose?.[who]) : null;
    const at: V2 = spot ? spot.at : sp ? sp.at : [c.geo.spawn.at[0], c.geo.spawn.at[1]];
    const url = new URL(cast[who].glb, castUrl).href;
    const clipUrls: Record<string, string> = {};
    for (const [k, v] of Object.entries(cast[who].clips ?? {})) clipUrls[k] = new URL(v, castUrl).href;
    const a = await createActor(who, url, Number(cast[who].height_m ?? 1.7), at, layerOf(sp?.level ?? null).layer.y + (spot?.y ?? 0), spot?.yaw ?? sp?.yaw ?? 0, clipUrls, cast[who].idle);
    if (sp && sp.name === startName) claims[sp.name] = who;
    actors.set(who, a);
  }
  const director = createDirector(rng);
  // the director sees the furniture: a frame whose sightline the world blocks is moved (actors never block)
  const sight = createSight(c.scene, () => [...actors.values()].map((a) => a.group));
  const offstageActors = new Set<string>();
  /** actors walking to a door on `exit`: they become offstage only once they stop there */
  const exiting = new Set<string>();
  const roomOfActor = (a: Actor, lvl: string | null): any | null => roomAt(a.pos(), lvl) ?? roomAt(a.pos()) ?? null;
  const dActors = (list: Actor[]): DActor[] =>
    list.map((a) => {
      const lvl = toucherLevel(a.who);
      const f = roomOfActor(a, lvl);
      return {
        name: a.who,
        pos: a.pos(),
        yaw: a.yaw(),
        height: heightOf(a.who),
        level: lvl,
        room: f?.room ?? null,
        walking: a.moving(),
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
  const touch = (who: string, name: string, pose?: string, finishYaw?: number | "along"): void => void toucher.touch(who, name, pose, finishYaw);

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
  const handlers: StageHandlers = {
    start(e) {
      const items = Array.isArray((e as any).start) ? (e as any).start : [e];
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const who = typeof it.who === "string" ? it.who : null;
        if (!who || !actors.has(who)) continue;
        const a = actors.get(who)!;
        exiting.delete(who);
        if (it.offstage) {
          offstageActors.add(who);
        } else {
          offstageActors.delete(who);
        }
        if (it.place) {
          const pl = places.find((p) => p.name === it.place || p.id === it.place);
          if (pl) {
            const pose = typeof it.pose === "string" ? it.pose : undefined;
            const spot = pose === "lie" && pl.lie ? pl.lie.at : pose === "stand_on" && pl.stand_on ? pl.stand_on.at : pl.at;
            const yaw = pose === "lie" && pl.lie ? pl.lie.yaw : pl.yaw;
            const act = pose === "sit" ? "sit" : "idle";
            const lvl = pl.level ?? null;
            const y = layerOf(lvl).layer.y ?? 0;
            claims[pl.name] = who;
            a.teleport(spot, yaw, act, y);
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

      const getTargetPos = (tgt?: string): V2 | null => {
        if (!tgt) return null;
        if (actors.has(tgt)) return actors.get(tgt)!.pos();
        const pl = places.find((p) => p.name === tgt || p.id === tgt);
        return pl ? pl.at : null;
      };

      if (action === "stay") {
        return;
      }
      if (action === "turn_away") {
        const tgtPos = getTargetPos(lookTarget);
        if (tgtPos) {
          const targetYaw = yawTo(a.pos(), tgtPos);
          const turnYaw = (targetYaw + 180) % 360;
          a.go([], turnYaw, a.act());
        } else {
          warnings.push(`stage: turn_away requires look target`);
        }
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
        const tgtPos = getTargetPos(lookTarget);
        const lookYaw = tgtPos ? yawTo(pl.at, tgtPos) : "along";
        touch(who, pl.name, pose, lookYaw);
        return;
      }
      if (action === "enter") {
        if (!placeName) {
          warnings.push(`stage: enter requires door place -> stay`);
          return;
        }
        const door = places.find((p) => p.name === placeName || p.id === placeName);
        if (!door) {
          warnings.push(`stage: door place "${placeName}" not in places bank -> stay`);
          return;
        }
        exiting.delete(who);
        offstageActors.delete(who);
        const lvl = door.level ?? null;
        const y = layerOf(lvl).layer.y ?? 0;
        const step = interRoomDoorStep(door.at, door.yaw, 1.0);
        a.teleport(step.doorPos, step.yaw, "idle", y);
        const tgtPos = getTargetPos(lookTarget);
        const faceYaw = tgtPos ? yawTo(step.insidePos, tgtPos) : step.yaw;
        a.go([step.insidePos], faceYaw, "idle", y);
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
        const res = toucher.touch(who, door.name, "door");
        if (res === "walk") exiting.add(who);
        else if (res === "skip") offstageActors.add(who);
        else warnings.push(`stage: exit to "${door.name}" is ${res} -> stay`);
        return;
      }
      warnings.push(`stage: unknown action "${action}" -> stay`);
    },
    line(e) {
      lastBeatHadStage = false;
      const who = whoOf(e);
      if (who) lastSpeaker = who;
      const inherited = who ? (stageLook.get(who) ?? null) : null;
      if (who) stageLook.delete(who);
      const lookName = typeof e.look === "string" ? e.look : inherited;
      gazeBeat = { speaker: who ?? null, at: lookName, place: lookName ? (places.find((p) => p.name === lookName) ?? null) : null, until: nowT + Math.max(1, Number(e.dur ?? SPEAK_SECONDS)) + GAZE_SILENCE };
      pendingQueue.push({ kind: "line", speaker: who ?? undefined, durationS: Number(e.dur ?? SPEAK_SECONDS), shot: typeof e.shot === "string" ? e.shot : undefined, dt: 0 });
      subs.line({ who: e.who, text: e.text, audio: e.audio });
      if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
        window.dispatchEvent(new CustomEvent("stage_line", { detail: { who: e.who ?? null, text: String(e.text ?? "") } }));  // host hook (clip crutch)
      }
      if (who) actors.get(who)!.speak(Math.max(1, Number(e.dur ?? SPEAK_SECONDS)));
      const pick = clipForBeat({ who, text: e.text, gesture: e.gesture, remarks: e.remarks }, cast, aliases);
      if (pick && !pick.procedural) actors.get(pick.who)?.play(pick.clip, { once: true });
      const t = touchName(e.touch);
      if (who && t) touch(who, t);
    },
    narrator(e) {
      gazeBeat = { speaker: null, at: null, place: namedIn(String(e.text ?? "")) ? null : placeIn(String(e.text ?? "")), until: nowT + Math.max(1, Number(e.dur ?? SPEAK_SECONDS)) + GAZE_SILENCE };
      pendingQueue.push({ kind: "narrator", durationS: Number(e.dur ?? SPEAK_SECONDS), shot: typeof e.shot === "string" ? e.shot : undefined, about: namedIn(String(e.text ?? "")), dt: 0 });
      subs.narrator({ text: e.text, audio: e.audio });
      if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
        window.dispatchEvent(new CustomEvent("stage_line", { detail: { who: null, text: String(e.text ?? "") } }));  // host hook (clip crutch)
      }
      const pick = clipForBeat({ who: null, text: e.text }, cast, aliases);
      if (pick) actors.get(pick.who)?.play(pick.clip, { once: true });
      const hadStage = lastBeatHadStage || !!(e as any).stage;
      lastBeatHadStage = false;
      if (!hadStage) {
        const hit = remark(String(e.text ?? ""));
        if (hit) touch(hit.who, hit.place);
      }
    },
    touch(e) {
      const who = whoOf(e);
      const t = touchName(e.object ?? e.place ?? e.touch);
      if (who && t) touch(who, t);
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
  const critic = typeof window !== "undefined"
    ? createCritic(((window as any).__critic ??= []) as CriticFact[], () => {
        const cam = c.camera.position;
        const on = [...actors.values()].filter((a) => !offstageActors.has(a.who));
        // F12: lines can overlap in dur — the latest line's speaker wins while still speaking, not the first timer
        const late = gazeBeat?.speaker && nowT < (gazeBeat?.until ?? 0) ? on.find((a) => a.who === gazeBeat.speaker) : undefined;
        const sp = (late?.speaking() ? late : undefined) ?? on.find((a) => a.speaking());
        return {
          plan: lastPlan,
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
            // rendered feet (group.position.y carries SIT_DROP and bob), head from the bone so sit follows the pose
            return { who: a.who, pos: a.pos(), y: a.group.position.y, yaw: a.yaw(), faceYaw, facePitch: hp?.facePitch, headPos: hp?.pos, headY: e[1], height: h, clear: sight([cam.x, cam.y, cam.z], e), boneSig: boneSig(a.group) };
          }),
        };
      })
    : null;
  const update = (dt: number, now: number): void => {
    nowT = now;
    {
      const all = [...actors.values()];
      for (const a of all) a.look(gazeOf(a, all));
    }
    for (const a of actors.values()) a.update(dt, now);
    for (const who of [...exiting]) {
      if (!actors.get(who)?.moving()) {
        exiting.delete(who);
        offstageActors.add(who);
      }
    }
    toucher.tick();
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
      if (ev.kind === "line" && ev.speaker) focus = list.find((a) => a.who === ev.speaker) ?? onstageList.find((a) => a.speaking()) ?? onstageSorted[0] ?? sorted[0];
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
      const here = dActors(list).filter((d) => d.room === f.room && d.level === lvl);
      if (!here.length) {
        if (!queued.length) return;
        continue;
      }
      // the speaker leads (a narrator line: the first actor by name), so the director's room is the one under `focus`
      if (ev.kind !== "line") ev.speaker = undefined;
      const out = director.step({
        event: ev,
        actors: here,
        room: { outline: f.outline, ceiling: camHeight, open: isOpen(f.room), floorY },
        rng,
        fov: c.camera.fov,
        aspect: c.camera.aspect,
        clear: sight,
      });
      if (isLast) s = out;
    }
    if (!s) return;
    const k = s.cut !== prevCut ? 1 : 1 - Math.exp(-4 * dt);  // a cut jumps, inside a plan the camera follows smoothly
    prevCut = s.cut;
    const pos = c.camera.position;
    // F5: the blended position is kept inside the camera room (an L room's notch is outside between two inside frames)
    const sm = smoothCam([pos.x, pos.y, pos.z], s.cam, k, camOutline);
    pos.set(sm[0], sm[1], sm[2]);
    look.set(look.x + (s.look[0] - look.x) * k, look.y + (s.look[1] - look.y) * k, look.z + (s.look[2] - look.z) * k);
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
