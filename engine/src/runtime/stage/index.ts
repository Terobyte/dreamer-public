import { Vector3, type PerspectiveCamera, type Scene } from "three";
import type { StageEvent, StageHandlers } from "../bridge.js";
import type { NavRamp } from "../../nav/floor.js";
import { clipForBeat } from "./anim.js";
import { createActor, type Actor } from "./actors.js";
import { createDirector, createPendingQueue, initialYaws, smoothCam, type DActor, type DEvent } from "./director.js";
import type { StageLevel } from "./path.js";
import { floorAt, stageRegex, type Claims, type Place, type V2 } from "./places.js";
import { createToucher } from "./touch.js";
import { createSubs } from "./subs.js";

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
  api: {
    actors(): Array<{ who: string; pos: V2; yaw: number; act: string }>;
    camera(): { pos: [number, number, number]; room: string | null; height: number | null };
    subs(): string[];
  };
}

const SPEAK_SECONDS = 3;

/** Reads stage.json + places + cast, puts the cast on its start places and returns the event handlers and the frame step. */
export async function startStage(c: StageCtx): Promise<Stage> {
  const stageAbs = new URL(c.stageUrl, location.href);
  const stage = await fetch(stageAbs).then((r) => r.json());
  // paths inside stage.json are relative to the run folder: the parent of stage/
  const runBase = new URL("../", stageAbs);
  const placesJson = await fetch(new URL(stage.places, runBase)).then((r) => r.json());
  const places: Place[] = placesJson.places ?? placesJson;
  const castUrl = new URL(stage.cast, runBase);
  const cast: Record<string, { glb: string; height_m?: number; clips?: Record<string, string>; idle?: string; verbs?: Record<string, string[]> }> = await fetch(castUrl).then((r) => r.json());
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
    const at: V2 = sp ? sp.at : [c.geo.spawn.at[0], c.geo.spawn.at[1]];
    const url = new URL(cast[who].glb, castUrl).href;
    const clipUrls: Record<string, string> = {};
    for (const [k, v] of Object.entries(cast[who].clips ?? {})) clipUrls[k] = new URL(v, castUrl).href;
    const a = await createActor(who, url, Number(cast[who].height_m ?? 1.7), at, layerOf(sp?.level ?? null).layer.y, sp?.yaw ?? 0, clipUrls, cast[who].idle);
    if (sp && sp.name === startName) claims[sp.name] = who;
    actors.set(who, a);
  }
  const director = createDirector(rng);
  const roomOfActor = (a: Actor, lvl: string | null): any | null => roomAt(a.pos(), lvl) ?? roomAt(a.pos()) ?? null;
  const dActors = (list: Actor[]): DActor[] =>
    list.map((a) => {
      const lvl = toucherLevel(a.who);
      const f = roomOfActor(a, lvl);
      return { name: a.who, pos: a.pos(), yaw: a.yaw(), height: heightOf(a.who), level: lvl, room: f?.room ?? null, walking: a.moving() };
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

  const toucher = createToucher({
    places,
    claims,
    levels: c.layers.map((l): StageLevel => ({ layer: l.layer, bits: l.bits, y: l.layer.y })),
    ramps: (c.nav.ramps ?? []) as NavRamp[],
    doors: c.nav.doors ?? {},
    doorOpen: c.doorOpen,
    actor: (w) => actors.get(w),
  });
  toucherLevel = (who) => toucher.levelOf(who);
  const touch = (who: string, name: string): void => void toucher.touch(who, name);

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
  const btn = document.createElement("button");
  btn.id = "free";
  btn.hidden = true;
  btn.style.cssText = "position:fixed;top:8px;right:8px;z-index:3;font:14px system-ui,sans-serif;padding:6px 10px";
  // only a book run has the button (F27): seed / free scenes never show it; freestyle is one-way
  const bookRun = stage.mode === "book";
  const setMode = (m: string): void => {
    if (c.film || !bookRun || m === mode || mode === "freestyle" || (m !== "book" && m !== "freestyle")) return;
    mode = m;
    btn.hidden = false;
    btn.classList.toggle("on", m === "freestyle");
    btn.textContent = m === "freestyle" ? "⚡ фристайл: импровизируют" : "⚡ Фристайл [G]";
  };
  const goFree = (): void => {
    if (c.film || mode !== "book" || !c.sim) return;
    btn.textContent = "⚡ переключаю…";
    fetch(`${c.sim.replace(/\/$/, "")}/freestyle`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(
      () => (btn.textContent = "⚡ Фристайл [G] (движок не ответил)"),
    );
  };
  btn.onclick = goFree;
  addEventListener("keydown", (e) => {
    if (e.code === "KeyG" && !e.repeat) goFree();
  });
  document.body.appendChild(btn);
  const ticker = document.createElement("div");
  ticker.id = "story";
  ticker.hidden = true;
  ticker.style.cssText = "position:fixed;top:52px;left:50%;transform:translateX(-50%);width:min(720px,90vw);color:#fff;font:14px system-ui,sans-serif;text-shadow:0 1px 3px #000;white-space:nowrap;overflow:hidden;z-index:2";
  // a running line (F28): the text enters on the right and leaves fully on the left, then again
  const css = document.createElement("style");
  css.textContent = "@keyframes stage-ticker{from{transform:translateX(0)}to{transform:translateX(-100%)}}#story>span{display:inline-block;padding-left:100%;animation:stage-ticker linear infinite}";
  document.head.appendChild(css);
  const tickerText = document.createElement("span");
  ticker.appendChild(tickerText);
  document.body.appendChild(ticker);
  // the run's own mode first: a book run shows the button before any event (F35)
  setMode(stage.freestyle ? "freestyle" : String(stage.mode ?? ""));
  let pieces = 0;
  let told = 0;

  const pendingQueue = createPendingQueue();
  let lastSpeaker: string | null = null;
  const handlers: StageHandlers = {
    line(e) {
      const who = whoOf(e);
      if (who) lastSpeaker = who;
      pendingQueue.push({ kind: "line", speaker: who ?? undefined, durationS: Number(e.dur ?? SPEAK_SECONDS), shot: typeof e.shot === "string" ? e.shot : undefined, dt: 0 });
      subs.line({ who: e.who, text: e.text, audio: e.audio });
      window.dispatchEvent(new CustomEvent("stage_line", { detail: { who: e.who ?? null, text: String(e.text ?? "") } }));  // host hook (clip crutch)
      if (who) actors.get(who)!.speak(Math.max(1, Number(e.dur ?? SPEAK_SECONDS)));
      const pick = clipForBeat({ who, text: e.text, gesture: e.gesture }, cast);
      if (pick) actors.get(pick.who)?.play(pick.clip, { once: true });
      const t = touchName(e.touch);
      if (who && t) touch(who, t);
    },
    narrator(e) {
      pendingQueue.push({ kind: "narrator", durationS: Number(e.dur ?? SPEAK_SECONDS), shot: typeof e.shot === "string" ? e.shot : undefined, dt: 0 });
      subs.narrator({ text: e.text, audio: e.audio });
      window.dispatchEvent(new CustomEvent("stage_line", { detail: { who: null, text: String(e.text ?? "") } }));  // host hook (clip crutch)
      const pick = clipForBeat({ who: null, text: e.text }, cast);
      if (pick) actors.get(pick.who)?.play(pick.clip, { once: true });
      const hit = remark(String(e.text ?? ""));
      if (hit) touch(hit.who, hit.place);
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
        ticker.hidden = false;
        tickerText.textContent = `📖 ${told}/${pieces || "?"} · ${w}`;
        tickerText.style.animationDuration = `${Math.max(8, tickerText.textContent.length * 0.18)}s`;
      }
    },
  };

  let camRoom: string | null = null;
  let camOutline: V2[] = [];
  let camHeight: number | null = null;
  let prevCut: number | null = null;
  const look = new Vector3();
  const update = (dt: number, now: number): void => {
    for (const a of actors.values()) a.update(dt, now);
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
      if (ev.kind === "line" && ev.speaker) focus = list.find((a) => a.who === ev.speaker) ?? list.find((a) => a.speaking()) ?? sorted[0];
      else if (ev.kind === "narrator") focus = sorted[0];
      else focus = list.find((a) => a.speaking()) ?? list.find((a) => a.who === (ev.speaker ?? lastSpeaker)) ?? sorted[0];
      focus ??= sorted[0];
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
  };

  return {
    handlers,
    update,
    api: {
      actors: () => [...actors.values()].map((a) => ({ who: a.who, pos: a.pos(), yaw: a.yaw(), act: a.act() })),
      camera: () => ({ pos: [c.camera.position.x, c.camera.position.y, c.camera.position.z], room: camRoom, height: camHeight }),
      subs: () => subs.log(),
    },
  };
}
