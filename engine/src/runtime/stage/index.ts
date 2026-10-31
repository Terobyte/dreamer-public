import type { PerspectiveCamera, Scene } from "three";
import type { StageEvent, StageHandlers } from "../bridge.js";
import type { NavRamp } from "../../nav/floor.js";
import { createActor, type Actor } from "./actors.js";
import { directShot, roomRect, type ShotKind } from "./camera.js";
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
  const cast: Record<string, { glb: string; height_m?: number }> = await fetch(castUrl).then((r) => r.json());
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

  const claims: Claims = {};
  const actors = new Map<string, Actor>();
  const fallback = places[0];
  for (const who of names) {
    const startName = stage.start?.[who];
    const sp = places.find((p) => p.name === startName) ?? fallback;
    const at: V2 = sp ? sp.at : [c.geo.spawn.at[0], c.geo.spawn.at[1]];
    const url = new URL(cast[who].glb, castUrl).href;
    const a = await createActor(who, url, Number(cast[who].height_m ?? 1.7), at, layerOf(sp?.level ?? null).layer.y, sp?.yaw ?? 0);
    if (sp && sp.name === startName) claims[sp.name] = who;
    actors.set(who, a);
    c.scene.add(a.group);
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
    if (!bookRun || m === mode || mode === "freestyle" || (m !== "book" && m !== "freestyle")) return;
    mode = m;
    btn.hidden = false;
    btn.classList.toggle("on", m === "freestyle");
    btn.textContent = m === "freestyle" ? "⚡ фристайл: импровизируют" : "⚡ Фристайл [G]";
  };
  const goFree = (): void => {
    if (mode !== "book" || !c.sim) return;
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

  const handlers: StageHandlers = {
    line(e) {
      const who = whoOf(e);
      subs.line({ who: e.who, text: e.text, audio: e.audio });
      if (who) actors.get(who)!.speak(Math.max(1, Number(e.dur ?? SPEAK_SECONDS)));
      const t = touchName(e.touch);
      if (who && t) touch(who, t);
    },
    narrator(e) {
      subs.narrator({ text: e.text, audio: e.audio });
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
        const w = String(e.what ?? "").replace(/^The story moves on:? ?/, "");
        ticker.hidden = false;
        tickerText.textContent = `📖 ${told}/${pieces || "?"} · ${w}`;
        tickerText.style.animationDuration = `${Math.max(8, tickerText.textContent.length * 0.18)}s`;
      }
    },
  };

  let shot: ShotKind = "wide";
  let lastTalk = -100;
  let camRoom: string | null = null;
  let camHeight: number | null = null;
  const update = (dt: number, now: number): void => {
    for (const a of actors.values()) a.update(dt, now);
    toucher.tick();
    const list = [...actors.values()];
    const talker = list.find((a) => a.speaking());
    if (talker) lastTalk = now;
    shot = talker ? "close" : now - lastTalk > 4 ? "wide" : "two";
    const focus = talker ?? list[0];
    if (!focus) return;
    const lvl = toucher.levelOf(focus.who);
    // never leave the camera unplaced (F36): off every floor (a ramp) -> the room under the actor on any level, else the first room
    const f = roomAt(focus.pos(), lvl) ?? roomAt(focus.pos()) ?? (c.geo.floors ?? [])[0];
    if (!f) return;
    camRoom = f.room;
    camHeight = ceilingOf(f.room);
    const floorY = layerOf(lvl ?? (f as any).level ?? null).layer.y ?? 0;
    const s = directShot(shot, list.map((a) => ({ pos: a.pos(), speaking: a.speaking() })), roomRect(f.outline), camHeight, floorY, f.outline);
    c.camera.position.set(...s.pos);
    c.camera.lookAt(...s.look);
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
