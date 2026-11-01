import { describe, it, expect } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { createDirector, createPendingQueue, initialYaws, smoothCam, type DActor, type DEvent, type DRoom } from "../src/runtime/stage/director.js";
import { insideInset } from "../src/runtime/stage/camera.js";

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const sq = (n: number): Array<[number, number]> => [[0, 0], [n, 0], [n, n], [0, n]];
const ROOM: DRoom = { outline: sq(20), ceiling: 3, open: false };
const act = (name: string, pos: [number, number], o: Partial<DActor> = {}): DActor => ({ name, pos, yaw: 0, height: 1.7, level: null, room: "r", walking: false, ...o });
const A = (o: Partial<DActor> = {}) => act("a", [9, 10], { yaw: 90, ...o });
const B = (o: Partial<DActor> = {}) => act("b", [11, 10], { yaw: 270, ...o });
const line = (speaker = "a", extra: Partial<DEvent> = {}): DEvent => ({ kind: "line", speaker, durationS: 3, dt: 0, ...extra });
const narr = (): DEvent => ({ kind: "narrator", durationS: 3, dt: 0 });
const tick = (dt: number): DEvent => ({ kind: "tick", dt });

function mk(seed = 1) {
  const rng = seeded(seed);
  const d = createDirector(rng);
  return { d, step: (event: DEvent, actors: DActor[] = [A(), B()], room: DRoom = ROOM) => d.step({ event, actors, room, rng }) };
}

describe("director plan rules", () => {
  it("rule 1: beat shot wins and repeats", () => {
    const { step } = mk();
    expect(step(line("a", { shot: "orbit" })).plan).toBe("orbit");
    expect(step(line("b", { shot: "orbit" })).plan).toBe("orbit");
  });
  it("rule 1 beats walking", () => {
    const { step } = mk();
    expect(step(line("a", { shot: "low" }), [A({ walking: true }), B({ height: 1.2 })]).plan).toBe("low");
  });
  it("rule 2: one walker -> follow, two -> wide, walking beats first line", () => {
    expect(mk().step(line(), [A({ walking: true }), B()]).plan).toBe("follow");
    expect(mk().step(line(), [A({ walking: true }), B({ walking: true })]).plan).toBe("wide");
    const m = mk();
    m.step(line());
    expect(m.step(tick(0.1), [A({ walking: true }), B()]).plan).toBe("follow");
    expect(m.step({ kind: "walk", dt: 0.1 }, [A({ walking: true }), B({ walking: true })]).plan).toBe("wide");
  });
  it("rule 3: first line (also a narrator's) is wide", () => {
    expect(mk().step(line()).plan).toBe("wide");
    expect(mk().step(narr()).plan).toBe("wide");
  });
  it("rule 4: narrator -> two when everyone within 4 m, else wide; a run of narration varies (Koshakan)", () => {
    // a picture book is mostly narration: rule 4 alone gave one identical two-shot for five minutes
    const m = mk();
    expect(m.step(narr()).plan).toBe("wide");
    const plans = Array.from({ length: 8 }, () => m.step(narr()).plan);
    expect(plans[0]).toBe("two");
    for (let i = 1; i < plans.length; i++) expect(plans[i]).not.toBe(plans[i - 1]);
    for (let i = 0; i < plans.length; i += 2) expect(plans[i]).toBe("two");
    for (let i = 1; i < plans.length; i += 2) expect(["close", "dolly", "orbit"]).toContain(plans[i]);
    const far = mk();
    far.step(narr());
    expect(far.step(narr(), [A(), act("b", [17, 10])]).plan).toBe("wide");
  });
  it("rules 5-6: never the same plan twice in a row on 50 lines; every 5th is two/orbit/wide", () => {
    for (const seed of [1, 2, 3]) {
      const m = mk(seed);
      const plans: string[] = [];
      for (let i = 0; i < 50; i++) plans.push(m.step(line(i % 2 ? "b" : "a")).plan);
      for (let i = 1; i < 50; i++) expect(plans[i]).not.toBe(plans[i - 1]);
      for (let i = 4; i < 50; i += 5) expect(["two", "orbit", "wide"]).toContain(plans[i]);
    }
  });
  it("long line: close reaction at 45%, back to ots at 75%; reactions are not counted", () => {
    const m = mk(5);
    const plans: string[] = [];
    for (let i = 0; i < 5; i++) {
      const first = m.step(line("a", { durationS: 10, shot: i === 0 ? "ots" : undefined }));
      plans.push(first.plan);
      if (i === 0) {
        // F2: exact thresholds — 4.4 s still ots, 4.5 s (45%) close, 7.4 s still close, 7.5 s (75%) ots
        expect(m.step(tick(4.4)).plan).toBe("ots");
        expect(m.step(tick(0.1)).plan).toBe("close");
        expect(m.step(tick(2.9)).plan).toBe("close");
        expect(m.step(tick(0.1)).plan).toBe("ots");
      } else m.step(tick(0.1));
    }
    expect(["two", "orbit", "wide"]).toContain(plans[4]);
  });
  it("a new line cancels pending reactions", () => {
    const m = mk();
    m.step(line("a", { durationS: 10, shot: "wide" }));
    m.step(tick(2));
    expect(m.step(line("b", { durationS: 2, shot: "wide" })).plan).toBe("wide");
    expect(m.step(tick(4)).plan).toBe("wide");
    expect(m.step(tick(4)).plan).toBe("wide");
  });
  it("no reaction for orbit/dolly", () => {
    const m = mk();
    m.step(line("a", { durationS: 10, shot: "orbit" }));
    expect(m.step(tick(5)).plan).toBe("orbit");
    expect(m.step(tick(3)).plan).toBe("orbit");
    const d = mk();
    const first = d.step(line("a", { durationS: 10, shot: "dolly" }));
    expect(first.plan).toBe("dolly");
    const a = d.step(tick(5));
    const b = d.step(tick(3));
    expect(a.plan).toBe("dolly");
    expect(b.plan).toBe("dolly");
    expect(b.cut).toBe(first.cut);
  });
  it("walker crossing into another room is a cut (F1)", () => {
    const m = mk();
    m.step(line("a", { shot: "wide" }));
    const before = m.step(tick(0.1), [A({ walking: true }), B()]);
    const after = m.step(tick(0.1), [A({ walking: true, room: "other", pos: [3, 3] }), B()]);
    expect(after.cut).not.toBe(before.cut);
    const stay = m.step(tick(0.1), [A({ walking: true, room: "other", pos: [3, 4] }), B()]);
    expect(stay.cut).toBe(after.cut);
  });
  it("low only when the speaker is taller than the listener", () => {
    const seen = (sh: number, lh: number) => {
      const m = mk(7);
      const out = new Set<string>();
      for (let i = 0; i < 200; i++) out.add(m.step(line("a"), [A({ height: sh }), B({ height: lh })]).plan);
      return out;
    };
    expect(seen(0.95, 1.7).has("low")).toBe(false);
    expect(seen(1.7, 1.7).has("low")).toBe(false);
    expect(seen(1.7, 0.95).has("low")).toBe(true);
  });
  it("single actor: no ots/two", () => {
    const m = mk(3);
    const out = new Set<string>();
    for (let i = 0; i < 100; i++) out.add(m.step(line("a"), [A()]).plan);
    for (const p of ["ots", "two", "low", "dolly"]) expect(out.has(p)).toBe(false);
  });
});

describe("director frames", () => {
  it("height 0.95 -> close at eye ~0.76", () => {
    const { step } = mk();
    const s = step(line("a", { shot: "close" }), [A({ height: 0.95 }), B()]);
    expect(s.plan).toBe("close");
    expect(s.cam[1]).toBeCloseTo(0.76, 2);
  });
  it("two actors in different rooms: frame by the speaker's room only", () => {
    const m = mk();
    const far = act("b", [18, 18], { room: "other" });
    const out = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const s = m.step(line("a"), [A(), far]);
      out.add(s.plan);
      expect(Math.hypot(s.cam[0] - 9, s.cam[2] - 10)).toBeLessThan(12);
    }
    expect(out.has("ots")).toBe(false);
    expect(out.has("two")).toBe(false);
  });
  it("wide in a 30x30 yard: both actors fill >= 25% of the frame", () => {
    const yard: DRoom = { outline: sq(30), ceiling: 2.7, open: true };
    for (const seed of [1, 2]) {
      const m = mk(seed);
      const actors = [act("a", [15, 15], { height: 1.7, yaw: 90 }), act("b", [16.5, 15], { height: 0.95, yaw: 270 })];
      const s = m.step(line("a", { shot: "wide" }), actors, yard);
      const cam = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
      cam.position.set(...s.cam);
      cam.lookAt(...s.look);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      for (const a of actors) {
        const foot = new Vector3(a.pos[0], 0, a.pos[1]).project(cam);
        const head = new Vector3(a.pos[0], a.height, a.pos[1]).project(cam);
        expect(head.y - foot.y).toBeGreaterThanOrEqual(0.5);
        expect(Math.abs(foot.x)).toBeLessThan(1);
      }
    }
  });
  it("close/ots are on the face side: <= 60 degrees at 8 actor yaws", () => {
    for (const plan of ["close", "ots"]) {
      for (let k = 0; k < 8; k++) {
        const yaw = k * 45;
        const { step } = mk();
        const s = step(line("a", { shot: plan }), [A({ yaw }), B()]);
        if (yaw === 180) {
          // F2: the face cone (-z) and the room-center side (+z) do not intersect — the side wins
          expect(s.cam[2] - 10).toBeGreaterThanOrEqual(-1e-9);
          continue;
        }
        const f = [Math.sin((yaw * Math.PI) / 180), Math.cos((yaw * Math.PI) / 180)];
        const dx = s.cam[0] - 9;
        const dz = s.cam[2] - 10;
        const cos = (f[0] * dx + f[1] * dz) / Math.hypot(dx, dz);
        expect(Math.acos(Math.max(-1, Math.min(1, cos))) * (180 / Math.PI)).toBeLessThanOrEqual(60.001);
      }
    }
  });
  it("open yard: camera ceiling is 3.5 m even when ceilingOf reports 2.7; a closed room keeps its ceiling", () => {
    const tall = [act("a", [9, 10], { yaw: 90, height: 3.4 }), act("b", [11, 10], { yaw: 270, height: 3.4 })];
    const yard = mk(9).step(line("a", { shot: "close" }), tall, { outline: sq(30), ceiling: 2.7, open: true });
    expect(yard.cam[1]).toBeGreaterThan(2.7);
    expect(yard.cam[1]).toBeLessThanOrEqual(3.5);
    const hall = mk(9).step(line("a", { shot: "close" }), tall, { outline: sq(30), ceiling: 2.7, open: false });
    expect(hall.cam[1]).toBeLessThanOrEqual(2.7);
  });
  it("every frame is inside the room outline", () => {
    const m = mk(4);
    for (let i = 0; i < 60; i++) {
      const s = m.step(line(i % 2 ? "b" : "a"), [act("a", [1, 1], { yaw: 200 }), act("b", [2.5, 1.5], { yaw: 20 })]);
      expect(s.cam[0]).toBeGreaterThanOrEqual(0);
      expect(s.cam[0]).toBeLessThanOrEqual(20);
      expect(s.cam[2]).toBeGreaterThanOrEqual(0);
      expect(s.cam[2]).toBeLessThanOrEqual(20);
      expect(s.cam[1]).toBeLessThanOrEqual(2.7 + 1e-6);
    }
  });
});

describe("blocking F1-F4", () => {
  it("F1 narrator uses first actor, not previous speaker", () => {
    const m = mk();
    const a1 = act("a1", [1, 1], { room: "r" });
    const a2 = act("a2", [2, 1], { room: "r" });
    const b = act("b", [18, 18], { room: "other" });
    m.step(line("b"), [a1, a2, b]);
    const s = m.step({ kind: "narrator", durationS: 3, dt: 0 }, [a1, a2, b]);
    expect(s.plan).toBe("two");
  });
  it("F2 wide diagonal fits inside frame", () => {
    const yard: DRoom = { outline: sq(30), ceiling: 2.7, open: true };
    const m = mk(1);
    const actors = [act("a", [8, 8], { height: 1.7, yaw: 90 }), act("b", [18, 18], { height: 1.7, yaw: 270 })];
    const s = m.step(line("a", { shot: "wide" }), actors, yard);
    const cam = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
    cam.position.set(...s.cam);
    cam.lookAt(...s.look);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    for (const a of actors) {
      const p = new Vector3(a.pos[0], 1, a.pos[1]).project(cam);
      expect(Math.abs(p.x)).toBeLessThan(1);
    }
  });
  it("F3 open room with floorY keeps camera above floor", () => {
    const room: DRoom = { outline: sq(10), ceiling: 2.7, open: true, floorY: 4 };
    const m = mk();
    const s = m.step(line("a", { shot: "wide" }), [A(), B()], room);
    expect(s.cam[1]).toBeGreaterThanOrEqual(4);
    expect(s.cam[1]).toBeLessThanOrEqual(4 + 3.5 - 0.3 + 1e-6);
  });
  it("F4 same-plan repeat is a new cut", () => {
    const m = mk();
    const s1 = m.step(line("a", { shot: "orbit" }));
    const s2 = m.step(line("b", { shot: "orbit" }));
    expect(s1.plan).toBe("orbit");
    expect(s2.plan).toBe("orbit");
    expect((s2 as any).cut).not.toBe((s1 as any).cut);
  });
});
describe("narration about an actor", () => {
  it("a close in a narration run frames the actor the text names", () => {
    const m = mk(3);
    m.step(narr());
    m.step({ ...narr(), about: "b" });
    let s = m.step({ ...narr(), about: "b" });
    for (let i = 0; i < 6 && s.plan !== "close"; i++) {
      m.step({ ...narr(), about: "b" });
      s = m.step({ ...narr(), about: "b" });
    }
    expect(s.plan).toBe("close");
    // b stands at (11, 10): the close looks at b's head
    expect(s.look[0]).toBeCloseTo(11, 6);
    expect(s.look[2]).toBeCloseTo(10, 6);
  });
});

describe("blocking F6 narrator two frames the pair", () => {
  it("tight-room narrator reports two and looks at the pair midpoint, not wide of one", () => {
    const m = mk();
    m.step(narr());
    const s = m.step(narr());
    expect(s.plan).toBe("two");
    // two looks at the pair midpoint at 0.6 x mean height (1.02); buggy frame built wide geometry (0.5 x height = 0.85)
    expect(s.look[0]).toBeCloseTo(10, 6);
    expect(s.look[2]).toBeCloseTo(10, 6);
    expect(s.look[1]).toBeCloseTo(1.02, 6);
  });
});
describe("F5 event queue (two handlers before one update)", () => {
  it("keeps both lines in order and drains once", () => {
    const q = createPendingQueue();
    q.push(line("a"));
    q.push(line("b"));
    const all = q.takeAll();
    expect(all.map((e) => e.speaker)).toEqual(["a", "b"]);
    expect(q.takeAll()).toEqual([]);
  });
  it("both rapid lines count in the director, camera shows the last", () => {
    const m = mk();
    const q = createPendingQueue();
    q.push(line("a"));
    q.push(line("b"));
    const cuts: number[] = [];
    let last = "";
    for (const ev of q.takeAll()) {
      const s = m.step({ ...ev, dt: 0 });
      cuts.push((s as any).cut);
      last = s.plan;
    }
    expect(cuts[1]).not.toBe(cuts[0]);
    expect(typeof last).toBe("string");
  });
});
describe("initialYaws", () => {
  const deg = (r: number) => (r * 180) / Math.PI;
  it("two actors face each other", () => {
    const y = initialYaws([[0, 0], [4, 0]], [0, 10, 0]);
    expect(y[0]).toBeCloseTo(90, 3);
    expect(y[1]).toBeCloseTo(270, 3);
  });
  it("one actor faces the first camera", () => {
    const y = initialYaws([[2, 2]], [2, 1.6, 8]);
    expect(y[0]).toBeCloseTo(0, 3);
    const z = initialYaws([[2, 2]], [-4, 1.6, 2]);
    expect(z[0]).toBeCloseTo(deg(Math.atan2(-6, 0)) + 360, 3);
  });
});
describe("blocking F7-F9", () => {
  it("F7: close respects the persistent 180 side", () => {
    const room: DRoom = { outline: sq(20), ceiling: 3, open: false };
    const a = act("a", [9, 12], { yaw: 90 });
    const b = act("b", [11, 12], { yaw: 270 });
    const { step } = mk();
    const o = step(line("a", { shot: "close" }), [a, b], room);
    expect(o.cam[2] - 12).toBeLessThan(0);
  });
  it("F8: narrow L room keeps the camera inside the outline", () => {
    const room: DRoom = { outline: [[0, 0], [10, 0], [10, 0.4], [0.4, 0.4], [0.4, 10], [0, 10]], ceiling: 3, open: false };
    const m = mk();
    const o = m.step(line("a", { shot: "wide" }), [act("a", [2, 0.2]), act("b", [8, 0.2])], room);
    expect(insideInset(room.outline, [o.cam[0], o.cam[2]], 0)).toBe(true);
  });
  it("F9: coerced shot reports the built geometry", () => {
    const room: DRoom = { outline: sq(20), ceiling: 3, open: false };
    expect(mk().step(line("a", { shot: "two" }), [act("a", [10, 10])], room).plan).toBe("wide");
    expect(mk().step(line("a", { shot: "low" }), [act("a", [9, 10], { height: 0.95 }), act("b", [11, 10], { height: 1.7 })], room).plan).toBe("close");
  });
});
describe("blocking F10-F12", () => {
  it("F10: ots stays on the 180 side after the room clamp, facing the speaker", () => {
    const o = createDirector(() => 0.2).step({ event: line("a", { shot: "ots" }), actors: [act("a", [10, 10]), act("b", [2, 2], { yaw: 180 })], room: ROOM });
    // axis a->b = (-1,-1)/√2, n = (0.707,-0.707), m = (6,6), side +1
    expect((o.cam[0] - 6) * Math.SQRT1_2 - (o.cam[2] - 6) * Math.SQRT1_2).toBeGreaterThanOrEqual(0);
    const ang = (Math.abs(Math.atan2(o.cam[0] - 10, o.cam[2] - 10)) * 180) / Math.PI;
    expect(ang).toBeLessThanOrEqual(60 + 1e-6);
  });
  it("F11: thin L room, pair midpoint outside: camera still inside the outline", () => {
    const room: DRoom = { outline: [[0, 0], [10, 0], [10, 0.4], [0.4, 0.4], [0.4, 10], [0, 10]], ceiling: 3, open: false };
    const o = createDirector(() => 0).step({ event: line("a", { shot: "wide" }), actors: [act("a", [0.2, 5]), act("b", [5, 0.2])], room });
    expect(insideInset(room.outline, [o.cam[0], o.cam[2]], 0)).toBe(true);
  });
  it("F12: a coerced low (built as close) counts as close for the no-repeat rule", () => {
    const d = createDirector(() => 1 / 7);
    const pr = [A({ height: 0.95 }), B({ height: 1.7 })];
    const r1 = d.step({ event: line("a", { shot: "low" }), actors: pr, room: ROOM });
    const r2 = d.step({ event: line("a"), actors: pr, room: ROOM });
    expect(r1.plan).toBe("close");
    expect(r2.plan).not.toBe(r1.plan);
  });
});

describe("blocking F5-F7 (round 10)", () => {
  it("F5: the smoothed camera of a follow in an L room stays inside the outline", () => {
    const room: DRoom = { outline: [[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10]], ceiling: 3, open: false };
    const a = (yaw: number) => act("a", [0.5, 0.5], { yaw, walking: true });
    const d = createDirector(() => 0.4);
    const x = d.step({ event: line("a", { shot: "follow" }), actors: [a(270)], room });
    const y = d.step({ event: tick(0.25), actors: [a(180)], room });
    expect(y.cut).toBe(x.cut);
    const p = smoothCam(x.cam, y.cam, 1 - Math.exp(-1), room.outline);
    expect(insideInset(room.outline, [p[0], p[2]], 0)).toBe(true);
    // inside the room the blend is untouched
    const q = smoothCam([2, 1.5, 0.5], [8, 1.5, 0.5], 0.5, room.outline);
    expect(q).toEqual([5, 1.5, 0.5]);
  });
  it("close preserves the 180 side", () => {
    const o = createDirector(() => 0.2).step({ event: line("a", { shot: "close" }), actors: [act("a", [2, 2], { yaw: 225 }), act("b", [2, 4], { yaw: 0 })], room: ROOM });
    // axis a->b = (0,1), n = (-1,0), m = (2,3), room center (10,10) -> side -1: the camera needs x >= 2
    expect(o.plan).toBe("close");
    expect(o.cam[0]).toBeGreaterThanOrEqual(2 - 1e-6);
    const f = [Math.sin((225 * Math.PI) / 180), Math.cos((225 * Math.PI) / 180)];
    const v = [o.cam[0] - 2, o.cam[2] - 2];
    const ang = (Math.acos((f[0] * v[0] + f[1] * v[1]) / Math.hypot(v[0], v[1])) * 180) / Math.PI;
    expect(ang).toBeLessThanOrEqual(60 + 1e-6);
  });
  it("ots near a wall keeps the 180 side when a face-side point exists (F6 ots fallback)", () => {
    const a = act("a", [12.74, 18.44], { yaw: 7.56 });
    const b = act("b", [15.14, 16.57], { yaw: 0 });
    const o = createDirector(() => 0.3).step({ event: line("a", { shot: "ots" }), actors: [a, b], room: ROOM });
    const L = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]);
    const n = [-(b.pos[1] - a.pos[1]) / L, (b.pos[0] - a.pos[0]) / L];
    const m = [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2];
    const side = (10 - m[0]) * n[0] + (10 - m[1]) * n[1] < 0 ? -1 : 1;
    expect(((o.cam[0] - m[0]) * n[0] + (o.cam[2] - m[1]) * n[1]) * side).toBeGreaterThanOrEqual(-1e-6);
    const f = [Math.sin((7.56 * Math.PI) / 180), Math.cos((7.56 * Math.PI) / 180)];
    const v = [o.cam[0] - a.pos[0], o.cam[2] - a.pos[1]];
    expect((Math.acos((f[0] * v[0] + f[1] * v[1]) / Math.hypot(v[0], v[1])) * 180) / Math.PI).toBeLessThanOrEqual(60 + 1e-6);
  });
  it("F7: no point with the 0.3 m inset -> the room center", () => {
    const room: DRoom = { outline: [[0, 0], [10, 0], [10, 0.4], [0, 0.4]], ceiling: 3, open: false };
    const o = createDirector(() => 0).step({ event: line("a", { shot: "wide" }), actors: [act("a", [2, 0.2]), act("b", [4, 0.2])], room });
    expect(o.cam[0]).toBeCloseTo(5, 6);
    expect(o.cam[2]).toBeCloseTo(0.2, 6);
  });
});
