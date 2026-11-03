/** К1 (camera moves): the atom resolver `resolveMove`, the projection helper `ndcOf`, the scheme planner `planScheme`. */
import { describe, it, expect } from "vitest";
import { insideInset, legalCameraPoint, roomRect, type V3 } from "../src/runtime/stage/camera.js";
import type { DActor, DRoom } from "../src/runtime/stage/director.js";
import { MOVES, SCHEMES, RECORDS, ndcOf, planScheme, resolveMove, type Ctx } from "../src/runtime/stage/moves.js";

const rect = (w: number, d: number): [number, number][] => [[0, 0], [w, 0], [w, d], [0, d]];
const L: [number, number][] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
const BED: DRoom = { outline: [[-3.6, 0], [0, 0], [0, 3.6], [-3.6, 3.6]], ceiling: 2.7, open: false };
const act = (name: string, pos: [number, number], yaw: number, o: Partial<DActor> = {}): DActor => ({ name, pos, yaw, height: 1.7, level: null, room: "r", walking: false, ...o });
const mama = act("Mama", [-1.65, 2.28], 315, { faceYaw: 12, head: [-1.6, 1.05, 2.3] });
const mirai = act("Mirai", [-1.21, 2.63], 180, { height: 1.2, lying: true, head: [-1.3, 0.5, 2.7] });
const seq = (): (() => number) => {
  let s = 7;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
};
const mkCtx = (room: DRoom, actors: DActor[], o: Partial<Ctx> = {}): Ctx => ({ actors, room, fov: 45, aspect: 16 / 9, durationS: 4, rng: seq(), ...o });
const ceilOf = (r: DRoom): number => (r.open ? (r.floorY ?? 0) + 3.5 : r.ceiling);
const headOf = (a: DActor): V3 => a.head ?? [a.pos[0], a.height * 0.9, a.pos[1]];
const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("ndcOf", () => {
  it("a point straight ahead is the centre, one above is +y, behind has no depth", () => {
    const c = ndcOf([0, 0, 5], [0, 0, 0], [0, 0, 5], 50, 16 / 9);
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeCloseTo(0);
    expect(c.depth).toBeCloseTo(5);
    const up = ndcOf([0, Math.tan((25 * Math.PI) / 180) * 5, 5], [0, 0, 0], [0, 0, 5], 50, 16 / 9);
    expect(up.y).toBeCloseTo(1);
    expect(ndcOf([0, 0, -2], [0, 0, 0], [0, 0, 5], 50, 16 / 9).depth).toBeLessThan(0);
  });
  it("a vertical view does not blow up", () => {
    const v = ndcOf([0, 0, 0], [0, 3, 0], [0, 0, 0], 50, 1);
    expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
  });
});

describe("registries", () => {
  it("do not overlap and carry the contract fields", () => {
    for (const id of Object.keys(SCHEMES)) expect(MOVES[id]).toBeUndefined();
    for (const id of Object.keys(RECORDS)) expect(MOVES[id] ?? SCHEMES[id]).toBeUndefined();
    for (const id of ["wide", "medium", "medium_wide", "eye_level", "close", "push_in", "pull_out", "ots", "two", "close_reaction", "dolly_zoom", "arc", "truck"]) expect(MOVES[id]).toBeDefined();
    expect(Object.keys(SCHEMES)).toEqual(expect.arrayContaining(["over_the_shoulder", "reaction_cut", "establishing", "oner", "rhythm_cut", "return_wide", "open_from_light", "final_pull_out"]));
    for (const [id, m] of Object.entries(MOVES)) expect(m.id).toBe(id);
  });
});

const ROOMS: [string, DRoom, DActor[]][] = [
  ["koshakan", BED, [mama, mirai]],
  ["20x20", { outline: rect(20, 20), ceiling: 3, open: false }, [act("A", [8, 9], 90, { head: [8, 1.5, 9] }), act("B", [11, 9], 270, { head: [11, 1.5, 9] })]],
  ["L", { outline: L, ceiling: 3, open: false }, [act("A", [3, 2], 90, { head: [3, 1.5, 2] }), act("B", [6, 2], 270, { head: [6, 1.5, 2] })]],
  ["narrow", { outline: rect(10, 1.2), ceiling: 2.7, open: false }, [act("A", [3, 0.6], 90, { head: [3, 1.5, 0.6] }), act("B", [6, 0.6], 270, { head: [6, 1.5, 0.6] })]],
  ["floorY3", { outline: rect(8, 8), ceiling: 5.7, open: false, floorY: 3 }, [act("A", [3, 4], 90, { head: [3, 4.5, 4] }), act("B", [5, 4], 270, { head: [5, 4.5, 4] })]],
  ["open", { outline: rect(12, 12), ceiling: 3, open: true }, [act("A", [5, 6], 90, { head: [5, 1.5, 6] }), act("B", [7, 6], 270, { head: [7, 1.5, 6] })]],
];
const ALLOWED_MOVING = new Set(["MOVE_SHRUNK", "MOVE_STATIC", "MOVE_CLAMPED", "MOVE_OCCLUDED", "MOVE_FACE_FALLBACK"]);
const ALLOWED_STATIC = new Set(["MOVE_CLAMPED", "MOVE_FACE_FALLBACK"]);
const warnName = (w: string): string => w.split(" ")[0];
const moved = (r: ReturnType<typeof resolveMove>, actors: DActor[]): boolean => {
  if (!r.end) return false;
  if (dist(r.end.pos, r.from.pos) >= 0.1) return true;
  if (Math.abs((r.end.fov ?? 0) - (r.from.fov ?? 0)) >= 2) return true;
  const look = (p: typeof r.from): V3 => {
    const l = p.look;
    if (Array.isArray(l)) return l;
    const a = actors.find((x) => x.name === l.actor)!;
    const h = l.bone === "hips" ? ((a as any).hips ?? [a.pos[0], 0.25, a.pos[1]]) : headOf(a);
    return [h[0] + l.o[0], h[1] + l.o[1], h[2] + l.o[2]];
  };
  const dir = (p: typeof r.from): V3 => {
    const l = look(p);
    const d: V3 = [l[0] - p.pos[0], l[1] - p.pos[1], l[2] - p.pos[2]];
    const n = Math.hypot(...d);
    return [d[0] / n, d[1] / n, d[2] / n];
  };
  const a = dir(r.from);
  const b = dir(r.end);
  return (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI >= 5;
};

describe("resolveMove: every atom on every room", () => {
  for (const [rn, room, actors] of ROOMS) {
    for (const id of Object.keys(MOVES)) {
      it(`${id} @ ${rn}`, () => {
        const a = actors[0];
        const subject = id === "ots" || id === "two" ? { pair: [actors[0].name, actors[1].name] as [string, string] } : id === "wide" || id === "master" ? { room: true as const } : { actor: a.name };
        const ctx = mkCtx(room, actors, { clear: () => true });
        const r = resolveMove(id, subject, ctx);
        const names = r.warnings.map(warnName);
        expect(names.filter((n) => !(MOVES[id].moving ? ALLOWED_MOVING : ALLOWED_STATIC).has(n))).toEqual([]);
        expect(r.ease).toMatch(/^(lin|io|in|out)$/);
        expect(r.from.fov).toBeGreaterThan(0);
        const floorY = room.floorY ?? 0;
        const law = { outline: room.outline, rect: roomRect(room.outline), height: ceilOf(room), floorY };
        const pts = [r.from, ...(r.end ? [r.end] : [])];
        expect(names).not.toContain("MOVE_NO_LEGAL_POINT");
        if (r.end)
          for (let k = 0; k <= 8; k++) {
            const u = k / 8;
            const x = r.from.pos[0] + (r.end.pos[0] - r.from.pos[0]) * u;
            const z = r.from.pos[2] + (r.end.pos[2] - r.from.pos[2]) * u;
            expect(insideInset(room.outline, [x, z], 0.3 - 1e-3)).toBe(true);
          }
        {
          for (const p of pts) {
            expect(insideInset(room.outline, [p.pos[0], p.pos[2]], 0.3 - 1e-3)).toBe(true);
            const q = legalCameraPoint(p.pos, law);
            expect(dist(q, p.pos)).toBeLessThan(2e-3);
          }
        }
        if (r.end === null || !MOVES[id].moving) expect(r.end === null).toBe(true);
        else if (!names.includes("MOVE_STATIC")) expect(moved(r, actors)).toBe(true);
        if (MOVES[id].moving === false) expect(r.end).toBeNull();
      });
    }
  }
});

describe("resolveMove: specifics", () => {
  const ctx = (): Ctx => mkCtx(BED, [mama, mirai]);
  it("push_in gets closer, pull_out farther", () => {
    const h = headOf(mama);
    const p = resolveMove("push_in", { actor: "Mama" }, ctx());
    if (p.end && !p.warnings.some((w) => w.startsWith("MOVE_STATIC"))) expect(dist(p.end.pos, h)).toBeLessThan(dist(p.from.pos, h));
    expect(p.end).not.toBeNull();
    const o = resolveMove("pull_out", { actor: "Mama" }, ctx());
    expect(o.end).not.toBeNull();
    expect(dist(o.end!.pos, h)).toBeGreaterThan(dist(o.from.pos, h));
  });
  it("dolly_zoom keeps the subject size", () => {
    const room: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
    const a = act("A", [10, 10], 0, { head: [10, 1.5, 10] });
    const r = resolveMove("dolly_zoom", { actor: "A" }, mkCtx(room, [a]));
    expect(r.end).not.toBeNull();
    const size = (p: typeof r.from): number => {
      const h = headOf(a);
      const f = [h[0] - p.pos[0], h[1] - p.pos[1], h[2] - p.pos[2]];
      const l = Math.hypot(...f);
      return l * Math.tan(((p.fov ?? 45) * Math.PI) / 360);
    };
    expect(Math.abs(size(r.end!) / size(r.from) - 1)).toBeLessThan(0.05);
  });
  it("close on lying Mirai looks at her head bone, from >= 0.5 m", () => {
    const r = resolveMove("close", { actor: "Mirai" }, mkCtx(BED, [mama, mirai], { clear: () => true }));
    expect(r.from.look).toEqual({ actor: "Mirai", bone: "head", o: [0, 0, 0] });
    expect(dist(r.from.pos, headOf(mirai))).toBeGreaterThanOrEqual(0.5 - 1e-6);
  });
  it("record ids give a static point and MOVE_RECORD_ONLY", () => {
    for (const id of Object.keys(RECORDS)) {
      const r = resolveMove(id, { actor: "Mama" }, ctx());
      expect(r.end).toBeNull();
      expect(r.warnings.map(warnName)).toEqual(["MOVE_RECORD_ONLY"]);
    }
  });
  it("a room without a legal point: MOVE_NO_LEGAL_POINT at the room centre", () => {
    const room: DRoom = { outline: rect(10, 0.4), ceiling: 2.7, open: false };
    const a = act("A", [3, 0.2], 0, { head: [3, 1.5, 0.2] });
    const r = resolveMove("close", { actor: "A" }, mkCtx(room, [a]));
    expect(r.warnings.some((w) => w.startsWith("MOVE_NO_LEGAL_POINT"))).toBe(true);
    expect(r.end).toBeNull();
    expect(r.from.pos[0]).toBeCloseTo(5, 0);
  });
  it("truck in the L room: the path stays inside and does not cut the notch", () => {
    const room: DRoom = { outline: L, ceiling: 3, open: false };
    const a = act("A", [3.2, 3.2], 0, { head: [3.2, 1.5, 3.2] });
    const r = resolveMove("truck", { actor: "A" }, mkCtx(room, [a, act("B", [1, 1], 0)]));
    const pts = r.end ? [r.from.pos, r.end.pos] : [r.from.pos];
    for (let k = 0; k <= 40; k++) {
      const u = k / 40;
      const p = pts.length === 2 ? [pts[0][0] + (pts[1][0] - pts[0][0]) * u, pts[0][2] + (pts[1][2] - pts[0][2]) * u] : [pts[0][0], pts[0][2]];
      expect(insideInset(L, p as [number, number], 0.3 - 1e-3)).toBe(true);
    }
  });
  it("arc never crosses the 180 line", () => {
    const a = act("A", [8, 9], 90, { head: [8, 1.5, 9] });
    const b = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
    const room: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
    const side = { origin: [9.5, 9] as [number, number], normal: [0, 1] as [number, number], sign: 1 as const };
    const r = resolveMove("arc", { actor: "A" }, mkCtx(room, [a, b], { side }));
    const pts = r.end ? [r.from.pos, r.end.pos] : [r.from.pos];
    for (let k = 0; k <= 16; k++) {
      const u = k / 16;
      const z = pts.length === 2 ? pts[0][2] + (pts[1][2] - pts[0][2]) * u : pts[0][2];
      expect(z - 9).toBeGreaterThan(0);
    }
  });
  it("a false clear on the first point: occluded or moved, never a blind success", () => {
    const clear = (cam: V3): boolean => cam[0] < -2.5;
    const r = resolveMove("close", { actor: "Mama" }, mkCtx(BED, [mama, mirai], { clear }));
    expect(r.warnings.some((w) => w.startsWith("MOVE_OCCLUDED")) || clear(r.from.pos)).toBe(true);
  });
  it("same seed, same bytes", () => {
    const a = JSON.stringify(resolveMove("push_in", { actor: "Mama" }, mkCtx(BED, [mama, mirai])));
    const b = JSON.stringify(resolveMove("push_in", { actor: "Mama" }, mkCtx(BED, [mama, mirai])));
    expect(a).toBe(b);
  });
});

describe("planScheme", () => {
  const A = act("A", [8, 9], 90, { head: [8, 1.5, 9] });
  const B = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
  const room: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
  const beats = (sp: string[]) => sp.map((s, i) => ({ i, kind: "line" as const, speaker: s, actors: ["A", "B"], durationS: 3, tags: {} }));
  it("over_the_shoulder: ots on A, B, A", () => {
    const out = planScheme("over_the_shoulder", beats(["A", "B", "A"]), mkCtx(room, [A, B]));
    expect(out.map((o) => o.move)).toEqual(["ots", "ots", "ots"]);
    expect(out.map((o) => (o.subject as { pair: string[] }).pair.join())).toEqual(["A,B", "A,B", "A,B"]);
    expect(out.map((o) => o.at)).toEqual(["B0", "B1", "B2"]);
    expect(out.map((o) => o.to)).toEqual(["B0e", "B1e", "B2e"]);
  });
  it("oner: from of n+1 equals end of n", () => {
    const out = planScheme("oner", beats(["A", "B", "A"]), mkCtx(room, [A, B]));
    expect(out.length).toBe(3);
    expect(out[0].to).toBe(out[1].at);
    for (let n = 0; n < 2; n++) {
      const e = out[n].resolved.end ?? out[n].resolved.from;
      expect(out[n + 1].resolved.from.pos).toEqual(e.pos);
      expect(out[n + 1].resolved.from.look).toEqual(e.look);
      expect(out[n + 1].resolved.from.fov).toEqual(e.fov);
    }
  });
});

describe("contract fixes (K1 round 2)", () => {
  const faceAngleOf = (a: DActor, cam: V3): number => {
    const h = headOf(a);
    const yaw = ((a.faceYaw ?? a.yaw) * Math.PI) / 180;
    const dx = cam[0] - h[0];
    const dz = cam[2] - h[2];
    const l = Math.hypot(dx, dz) || 1;
    return (Math.acos(Math.max(-1, Math.min(1, (Math.sin(yaw) * dx + Math.cos(yaw) * dz) / l))) * 180) / Math.PI;
  };
  const bearingOf = (x: number, z: number): number => (Math.atan2(x, z) * 180) / Math.PI;

  it("F4: medium_close exists, static, faceMove", () => {
    expect(MOVES.medium_close).toBeDefined();
    expect(MOVES.medium_close.moving).toBe(false);
    expect(MOVES.medium_close.faceMove).toBe(true);
  });
  it("F15: inherited names are MOVE_UNKNOWN, not records/schemes", () => {
    const c = mkCtx(BED, [mama, mirai]);
    expect(() => resolveMove("toString", { actor: "Mama" }, c)).toThrow("MOVE_UNKNOWN");
    expect(() => resolveMove("nope_xyz", { actor: "Mama" }, c)).toThrow("MOVE_UNKNOWN");
    expect(() => planScheme("toString", [], c)).toThrow("MOVE_UNKNOWN");
  });
  it("F14: room subject only for wide/master, else a wide fallback", () => {
    const c = mkCtx(BED, [mama, mirai]);
    const w = resolveMove("wide", { room: true }, c);
    const r = resolveMove("close", { room: true }, c);
    expect(r.end).toBeNull();
    expect(r.from.pos).toEqual(w.from.pos);
    expect(r.warnings.join(" ")).toMatch(/MOVE_ROOM_SUBJECT/);
  });
  it("F14: final_pull_out with no subject falls back to a wide plan", () => {
    const room: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
    const A = act("A", [8, 9], 90, { head: [8, 1.5, 9] });
    const B = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
    const out = planScheme(
      "final_pull_out",
      [{ i: 0, kind: "narrator" as const, actors: [], durationS: 3, tags: {} }],
      mkCtx(room, [A, B]),
    );
    expect(out.length).toBe(1);
    expect(out[0].move).toBe("wide");
    expect(out[0].subject).toEqual({ room: true });
    expect(out[0].resolved.end).toBeNull();
    expect(out[0].resolved.warnings.join(" ")).not.toMatch(/MOVE_ROOM_SUBJECT/);
  });
  it("F5: two keeps the speaker within 60 and the other within 100", () => {
    const room: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
    const A = act("A", [8, 9], 90, { head: [8, 1.5, 9] });
    const B = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
    const r = resolveMove("two", { pair: ["A", "B"] }, mkCtx(room, [A, B], { speaker: "A" }));
    if (!r.warnings.some((w) => w.startsWith("MOVE_FACE_FALLBACK"))) {
      expect(faceAngleOf(A, r.from.pos)).toBeLessThanOrEqual(60 + 1e-9);
      expect(faceAngleOf(B, r.from.pos)).toBeLessThanOrEqual(100 + 1e-9);
    }
  });
  it("F6: follow_side keeps the face (only behind/lead are exempt)", () => {
    const room: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
    const A = act("A", [8, 9], 270, { head: [8, 1.5, 9], faceYaw: 0 });
    const c = mkCtx(room, [A], { speaker: "A", walk: { A: { to: [14, 9] } } });
    const r = resolveMove("follow_side", { actor: "A" }, c);
    const fb = r.warnings.some((w) => w.startsWith("MOVE_FACE_FALLBACK") || w.startsWith("MOVE_STATIC") || w.startsWith("MOVE_OCCLUDED"));
    if (!fb) expect(faceAngleOf(A, r.from.pos)).toBeLessThanOrEqual(100 + 1e-9);
  });
  it("F7: clear is only bypassed by +-15/30/45 shifts, else MOVE_OCCLUDED", () => {
    const room: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
    const A = act("A", [10, 10], 0, { head: [10, 1.5, 10] });
    const wrap = (d: number): number => Math.abs(((d + 540) % 360) - 180);
    const clear = (cam: V3): boolean => wrap(bearingOf(cam[0] - 10, cam[2] - 10)) >= 60;
    const r = resolveMove("push_in", { actor: "A" }, mkCtx(room, [A], { clear }));
    expect(r.warnings.map((w) => w.split(" ")[0])).toContain("MOVE_OCCLUDED");
  });
  it("F17: without MOVE_OCCLUDED the returned points and path honour clear", () => {
    const c = mkCtx(BED, [mama, mirai]);
    const blocked = (cam: V3): boolean => !(cam[0] < -2.5);
    const r = resolveMove("close", { actor: "Mama" }, mkCtx(BED, [mama, mirai], { clear: (p) => blocked(p) }));
    if (!r.warnings.some((w) => w.startsWith("MOVE_OCCLUDED"))) {
      const lookW = (p: typeof r.from): V3 => {
        const l = p.look;
        if (Array.isArray(l)) return l;
        const h = headOf(mama);
        return [h[0] + l.o[0], h[1] + l.o[1], h[2] + l.o[2]];
      };
      const pts = [r.from, ...(r.end ? [r.end] : [])];
      for (const p of pts) expect(blocked(p.pos)).toBe(true);
      if (pts.length === 2) {
        const a = lookW(pts[0]);
        const b = lookW(pts[1]);
        for (let k = 0; k <= 8; k++) {
          const u = k / 8;
          const cam: V3 = [pts[0].pos[0] + (pts[1].pos[0] - pts[0].pos[0]) * u, pts[0].pos[1] + (pts[1].pos[1] - pts[0].pos[1]) * u, pts[0].pos[2] + (pts[1].pos[2] - pts[0].pos[2]) * u];
          const look: V3 = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
          expect(blocked(cam)).toBe(true);
          void look;
        }
      }
    }
  });
  it("F12: oner on a subject-less beat emits wide and restarts the chain", () => {
    const room: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
    const A = act("A", [8, 9], 90, { head: [8, 1.5, 9] });
    const B = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
    const c = mkCtx(room, [A, B]);
    const beats = [
      { i: 0, kind: "narrator" as const, actors: [] as string[], durationS: 3, tags: {} },
      { i: 1, kind: "line" as const, speaker: "A", actors: ["A", "B"], durationS: 3, tags: {} },
    ];
    const out = planScheme("oner", beats, c);
    expect(out.length).toBe(2);
    expect(out[0].move).toBe("wide");
    expect(out[0].subject).toEqual({ room: true });
    expect(out[0].to).toBe("B0e");
    // chain restarts after the gap: beat 1 starts fresh, not from beat 0's end
    const after = planScheme(
      "oner",
      [
        { i: 0, kind: "line" as const, speaker: "A", actors: ["A", "B"], durationS: 3, tags: {} },
        { i: 1, kind: "narrator" as const, actors: [] as string[], durationS: 3, tags: {} },
        { i: 2, kind: "line" as const, speaker: "B", actors: ["A", "B"], durationS: 3, tags: {} },
      ],
      c,
    );
    expect(after.length).toBe(3);
    expect(after[1].move).toBe("wide");
  });
});

describe("round 9 fixes", () => {
  const room: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
  const A = act("A", [10, 10], 0, { head: [10, 1.5, 10] });
  const c0 = (o: Partial<Ctx> = {}): Ctx => mkCtx(room, [A], o);
  it("F1: clear is checked on every probe of a pure look sweep", () => {
    const clear = (c: V3, l: V3): boolean => {
      const p = Math.atan2(l[1] - c[1], Math.hypot(l[0] - c[0], l[2] - c[2]));
      return p < 0.005 || p > 0.11;
    };
    const r = resolveMove("tilt_up", { actor: "A" }, c0({ clear }));
    expect(r.end === null).toBe(true);
  });
  it("F2: clear failing on the path gives MOVE_OCCLUDED, not MOVE_STATIC", () => {
    const clear = (c: V3): boolean => Math.abs(Math.hypot(c[0] - 10, c[1] - 1.5, c[2] - 10) - 2.2) < 0.015 && Math.abs(c[0] - 10) < 0.01;
    const r = resolveMove("push_in", { actor: "A" }, c0({ clear }));
    expect(r.warnings.map(warnName)).toContain("MOVE_OCCLUDED");
    expect(r.warnings.map(warnName)).not.toContain("MOVE_STATIC");
  });
  it("F3: a lying subject without clear fails closed", () => {
    const small: DRoom = { outline: rect(3.6, 3.6), ceiling: 2.7, open: false };
    const l = act("L", [1.4, 1.4], 0, { height: 1.2, lying: true, head: [1.4, 0.5, 1.4] });
    const r = resolveMove("close", { actor: "L" }, mkCtx(small, [l]));
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("F4: ots on a walking pair targets the speaker", () => {
    const a = act("A", [8, 9], 90, { head: [8, 1.5, 9], walking: true });
    const b = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
    const r = resolveMove("ots", { pair: ["A", "B"] }, mkCtx(room, [a, b], { speaker: "B" }));
    expect((r.from.look as { actor: string }).actor).toBe("B");
  });
  it("F5: a walk through an obstacle falls back to static medium", () => {
    const a = act("W", [4, 10], 90, { head: [4, 1.5, 10] });
    const obstacles = [{ min: [9, 0, 9] as V3, max: [11, 2, 11] as V3 }];
    const r = resolveMove("follow_side", { actor: "W" }, mkCtx(room, [a], { walk: { W: { to: [16, 10] } }, obstacles }));
    expect(r.end).toBeNull();
    expect(r.warnings.map(warnName)).toContain("MOVE_STATIC");
  });
  it("F6: actor looks keep o zero, pair looks are world points", () => {
    for (const id of ["pan_to", "tilt_up", "whip_pan"]) {
      const r = resolveMove(id, { actor: "A" }, c0());
      for (const p of [r.from, r.end]) if (p && !Array.isArray(p.look)) expect((p.look as { o: V3 }).o).toEqual([0, 0, 0]);
    }
    const a = act("A", [8, 9], 90, { head: [8, 1.5, 9] });
    const b = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
    const r = resolveMove("ots", { pair: ["A", "B"] }, mkCtx(room, [a, b], { speaker: "B" }));
    expect(Array.isArray(r.from.look)).toBe(true);
  });
  it("F7: ots keeps both heads inside the frame", () => {
    const a = act("A", [8, 9], 90, { head: [8, 1.5, 9] });
    const b = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
    const r = resolveMove("ots", { pair: ["A", "B"] }, mkCtx(room, [a, b], { speaker: "B" }));
    if (r.warnings.some((w) => w.startsWith("MOVE_FACE_FALLBACK"))) return;
    const look = r.from.look as V3;
    for (const h of [headOf(a), headOf(b)]) {
      const n = ndcOf(h, r.from.pos, look, r.from.fov!, 16 / 9);
      expect(Math.abs(n.x)).toBeLessThanOrEqual(0.85 + 1e-9);
      expect(Math.abs(n.y)).toBeLessThanOrEqual(0.85 + 1e-9);
    }
  });
  it("F9: oner chain restarts at push_in after a gap", () => {
    const B = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
    const bt = (i: number, ac: string[]) => ({ i, kind: "line" as const, speaker: ac[0], actors: ac, durationS: 3, tags: {} });
    const out = planScheme("oner", [bt(0, ["A"]), bt(1, []), bt(2, ["B"])], mkCtx(room, [A, B]));
    expect(out.map((o) => o.move)).toEqual(["push_in", "wide", "push_in"]);
  });
  it("F10: open_from_light goes on to the hero", () => {
    const out = planScheme("open_from_light", [{ i: 0, kind: "line", speaker: "A", actors: ["A"], durationS: 4, tags: {} }], c0());
    expect(out.map((o) => o.move)[0]).toBe("master");
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[1].subject).toEqual({ actor: "A" });
  });
});

describe("round fixes: clear, lying, walking pair, framing, schemes", () => {
  const big: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
  const A1 = act("A", [10, 10], 0, { head: [10, 1.5, 10] });
  const lookOf = (p: { look: unknown }, actors: DActor[]): V3 => {
    const l = p.look as any;
    if (Array.isArray(l)) return l as V3;
    const a = actors.find((x) => x.name === l.actor)!;
    const h = l.bone === "hips" ? ((a as any).hips ?? [a.pos[0], 0.25, a.pos[1]]) : headOf(a);
    return [h[0] + l.o[0], h[1] + l.o[1], h[2] + l.o[2]];
  };
  it("F1: a tilt checks clear along the whole look sweep", () => {
    const clear = (c: V3, l: V3): boolean => {
      const p = Math.atan2(l[1] - c[1], Math.hypot(l[0] - c[0], l[2] - c[2]));
      return p < 0.005 || p > 0.11;
    };
    const r = resolveMove("tilt_up", { actor: "A" }, mkCtx(big, [A1], { clear }));
    if (r.end) {
      const a = lookOf(r.from, [A1]);
      const b = lookOf(r.end, [A1]);
      for (let k = 0; k <= 20; k++) {
        const u = k / 20;
        const l: V3 = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
        expect(clear(r.from.pos, l)).toBe(true);
      }
    } else expect(r.warnings.some((w) => /^MOVE_(OCCLUDED|STATIC)/.test(w))).toBe(true);
  });
  it("F2: movement blocked in the middle, rotations do not help -> static MOVE_OCCLUDED", () => {
    const clear = (c: V3): boolean => Math.abs(Math.hypot(c[0] - 10, c[1] - 1.5, c[2] - 10) - 2.2) < 0.015 && Math.abs(c[0] - 10) < 0.01;
    const r = resolveMove("push_in", { actor: "A" }, mkCtx(big, [A1], { clear }));
    expect(r.end).toBeNull();
    expect(r.warnings.map(warnName)).toContain("MOVE_OCCLUDED");
  });
  it("F3: a lying subject without clear does not succeed silently", () => {
    const room: DRoom = { outline: rect(3.6, 3.6), ceiling: 2.7, open: false };
    const l = act("L", [1.4, 1.4], 0, { height: 1.2, lying: true, head: [1.4, 0.5, 1.4] });
    const r = resolveMove("close", { actor: "L" }, mkCtx(room, [l]));
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("F4: ots on a walking pair resolves against the speaker", () => {
    const a = act("A", [8, 9], 90, { head: [8, 1.5, 9], walking: true });
    const b = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
    const r = resolveMove("ots", { pair: ["A", "B"] }, mkCtx(big, [a, b], { speaker: "B" }));
    expect((r.from.look as any).actor).toBe("B");
  });
  it("F5: a straight walk through an obstacle falls back to a static medium", () => {
    const a = act("A", [4, 10], 90, { head: [4, 1.5, 10] });
    const obstacles = [{ min: [9, 0, 9] as V3, max: [11, 3, 11] as V3 }];
    const r = resolveMove("follow_side", { actor: "A" }, mkCtx(big, [a], { obstacles, walk: { A: { to: [16, 10] } } }));
    expect(r.end).toBeNull();
    expect(r.warnings.map(warnName)).toContain("MOVE_STATIC");
  });
  it("F6: actor looks keep o = 0; pair looks are a world point", () => {
    for (const id of ["pan_to", "tilt_up", "whip_pan"]) {
      const r = resolveMove(id, { actor: "A" }, mkCtx(big, [A1]));
      for (const p of [r.from, r.end]) if (p && !Array.isArray(p.look)) expect((p.look as any).o).toEqual([0, 0, 0]);
    }
    const a = act("A", [8, 9], 90, { head: [8, 1.5, 9] });
    const b = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
    const r = resolveMove("ots", { pair: ["A", "B"] }, mkCtx(big, [a, b], { speaker: "B" }));
    expect(Array.isArray(r.from.look)).toBe(true);
  });
  it("F7: ots keeps both heads of the pair in frame", () => {
    const a = act("A", [8, 9], 90, { head: [8, 1.5, 9] });
    const b = act("B", [11, 9], 270, { head: [11, 1.5, 9] });
    const r = resolveMove("ots", { pair: ["A", "B"] }, mkCtx(big, [a, b], { speaker: "B" }));
    if (!r.warnings.some((w) => w.startsWith("MOVE_FACE_FALLBACK") || w.startsWith("MOVE_NO_LEGAL_POINT")))
      for (const h of [a.head!, b.head!]) {
        const n = ndcOf(h, r.from.pos, lookOf(r.from, [a, b]), r.from.fov!, 16 / 9);
        expect(Math.abs(n.x)).toBeLessThanOrEqual(0.85 + 1e-6);
        expect(Math.abs(n.y)).toBeLessThanOrEqual(0.85 + 1e-6);
      }
  });
  it("F8: wide and master frame the whole room (all floor corners ahead and inside)", () => {
    const room: DRoom = { outline: rect(3.6, 3.6), ceiling: 2.7, open: false };
    for (const id of ["wide", "master"]) {
      const r = resolveMove(id, { room: true }, mkCtx(room, []));
      if (r.warnings.some((w) => w.startsWith("MOVE_NO_LEGAL_POINT"))) continue;
      const look = lookOf(r.from, []);
      // a camera inside the room cannot see the corners behind it: the two farthest ones must be ahead
      const far = [...room.outline].sort((a, b) => Math.hypot(b[0] - r.from.pos[0], b[1] - r.from.pos[2]) - Math.hypot(a[0] - r.from.pos[0], a[1] - r.from.pos[2])).slice(0, 2);
      for (const c of far) {
        const n = ndcOf([c[0], 0, c[1]], r.from.pos, look, r.from.fov!, 16 / 9);
        expect(n.depth).toBeGreaterThan(0.1);
        expect(Math.abs(n.x)).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });
  it("F9: an oner restarts its chain after a subject-less beat", () => {
    const bs = [1, 2, 3].map((i) => ({ i, kind: "line" as const, speaker: i === 2 ? undefined : i === 1 ? "A" : "B", actors: i === 2 ? [] : [i === 1 ? "A" : "B"], durationS: 3, tags: {} }));
    const B1 = act("B", [12, 10], 0, { head: [12, 1.5, 10] });
    const ps = planScheme("oner", bs, mkCtx(big, [A1, B1]));
    expect(ps.map((p) => p.move)).toEqual(["push_in", "wide", "push_in"]);
  });
  it("F10: open_from_light opens on the light, then goes to the hero", () => {
    const b = { i: 0, kind: "line" as const, speaker: "A", actors: ["A"], durationS: 3, tags: {} };
    const ps = planScheme("open_from_light", [b], mkCtx(big, [A1]));
    expect(ps.length).toBe(2);
    expect(ps[1].subject).toEqual({ actor: "A" });
  });
});

describe("round 11 fixes", () => {
  const big: DRoom = { outline: rect(20, 20), ceiling: 3, open: false };
  it("F14: a box between the sampled heights blocks a walk", () => {
    const a = act("A", [4, 10], 90, { head: [4, 1.5, 10], faceYaw: 90 });
    const r = resolveMove("follow_side", { actor: "A" }, mkCtx(big, [a], { walk: { A: { to: [16, 10] } }, obstacles: [{ min: [9, 0.7, 9], max: [11, 0.9, 11] }] }));
    expect(r.end).toBeNull();
  });
  it("F15: a static point is never inside an obstacle", () => {
    const a = act("A", [5, 5], 0, { head: [5, 1.5, 5] });
    const room: DRoom = { outline: rect(10, 10), ceiling: 2.7, open: false };
    const p = resolveMove("medium", { actor: "A" }, mkCtx(room, [a])).from.pos;
    const bx = { min: [p[0] - 0.2, p[1] - 0.2, p[2] - 0.2] as V3, max: [p[0] + 0.2, p[1] + 0.2, p[2] + 0.2] as V3 };
    const q = resolveMove("medium", { actor: "A" }, mkCtx(room, [a], { obstacles: [bx] })).from.pos;
    const inside = q.every((v, i) => v >= bx.min[i] && v <= bx.max[i]);
    expect(inside).toBe(false);
  });
  it("F16: ots frames the hips of a lying non-target and needs clear", () => {
    const a = act("A", [10, 10], 0, { head: [10, 1.5, 10] });
    const b = act("B", [10, 11], 0, { height: 1.2, lying: true, head: [10, 0.5, 11] });
    const r = resolveMove("ots", { pair: ["A", "B"] }, mkCtx(big, [a, b], { speaker: "B" }));
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("F17: a static close keeps a close point at <= 100 deg before a wide", () => {
    const a = act("A", [5, 0.4], 0, { head: [5, 1.5, 0.4], faceYaw: 180 });
    const r = resolveMove("close", { actor: "A" }, mkCtx({ outline: rect(10, 10), ceiling: 2.7, open: false }, [a]));
    expect(dist(r.from.pos, [5, 1.5, 0.4])).toBeLessThan(2);
  });
  it("F18/F19: tilt keeps actor refs; pan goes actor to actor", () => {
    const a = act("A", [5, 5], 0, { head: [5, 1.5, 5] });
    const b = act("B", [7, 5], 0, { head: [7, 1.5, 5] });
    const room: DRoom = { outline: rect(10, 10), ceiling: 2.7, open: false };
    const t = resolveMove("tilt_up", { actor: "A" }, mkCtx(room, [a, b]));
    expect(Array.isArray(t.from.look)).toBe(false);
    expect(Array.isArray(t.end?.look)).toBe(false);
    const p = resolveMove("pan_to", { pair: ["A", "B"] }, mkCtx(room, [a, b]));
    expect((p.end?.look as any).actor).toBe("B");
  });
});
