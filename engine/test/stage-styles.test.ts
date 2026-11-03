/** К2 (camera moves): style table `STYLES` and the one pick function `pickMove`. */
import { describe, it, expect } from "vitest";
import { MOVES, SCHEMES } from "../src/runtime/stage/moves.js";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { STYLES, pickMove, validateStyles } from "../src/runtime/stage/styles.js";

const IDS = ["storybook", "spielberg", "ozu", "anderson", "malick", "fincher", "kubrick", "miyazaki"];
const moving = (id: string): boolean => (MOVES[id] ? MOVES[id].moving : id === "final_pull_out" || id === "oner");
const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };

describe("STYLES", () => {
  it("has eight styles with table numbers", () => {
    expect(Object.keys(STYLES).sort()).toEqual([...IDS].sort());
    expect(STYLES.ozu.move).toBe(0);
    expect(STYLES.ozu.cut).toBe("long");
    expect(STYLES.storybook.cut).toBe("hard");
    expect(STYLES.anderson.height).toEqual([1.2, 1.5]);
    expect(STYLES.malick.fov).toEqual([55, 75]);
    expect(STYLES.fincher.asl).toEqual([2, 4]);
    expect(STYLES.kubrick.symmetry).toBe(0.9);
    expect(Object.keys(STYLES.storybook.weights)).toEqual(["medium", "wide", "close", "push_in", "pull_out"]);
  });
  it("every weight id is in MOVES or SCHEMES, none in both", () => {
    for (const s of Object.values(STYLES)) for (const [id, w] of Object.entries(s.weights)) {
      expect(!!MOVES[id] || !!SCHEMES[id]).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
    }
    for (const id of Object.keys(SCHEMES)) expect(MOVES[id]).toBeUndefined();
  });
  it("unknown id fails at load", () => {
    expect(() => validateStyles({ x: { ...STYLES.ozu, weights: { nope: 1 } } })).toThrow();
  });
});

describe("pickMove", () => {
  it("tag table, storybook and ozu", () => {
    const sb = STYLES.storybook, oz = STYLES.ozu;
    const p = (s: typeof sb, tags: object) => pickMove(s, tags, () => 0.5);
    expect(p(sb, { last: true }).id).toBe("final_pull_out");
    const o = p(oz, { last: true });
    expect(o.id).toBe("wide");
    expect(o.warnings).toContain("TAG_STATIC final_pull_out");
    expect(p(sb, { first: true }).id).toBe("establishing");
    expect(p(sb, { enter: true }).id).toBe("follow_side");
    expect(p(sb, { look: true }).id).toBe("over_the_shoulder");
    expect(p(sb, { last: true, first: true }).id).toBe("final_pull_out");
    expect(p(sb, { enter: true, look: true }).id).toBe("follow_side");
  });
  it("rng 0 = first of pool, 0.999 = last of pool", () => {
    // storybook, moving pool: push_in pull_out; static pool: medium wide close
    expect(pickMove(STYLES.storybook, {}, seq(0, 0)).id).toBe("push_in");
    expect(pickMove(STYLES.storybook, {}, seq(0, 0.999)).id).toBe("pull_out");
    expect(pickMove(STYLES.storybook, {}, seq(0.999, 0)).id).toBe("medium");
    expect(pickMove(STYLES.storybook, {}, seq(0.999, 0.999)).id).toBe("close");
  });
  it("ozu never moving; zero weights never picked; all-zero gives wide", () => {
    let r = 1;
    const rng = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) expect(moving(pickMove(STYLES.ozu, {}, rng).id)).toBe(false);
    for (let i = 0; i < 200; i++) expect(pickMove(STYLES.spielberg, {}, rng).id).not.toBe("oner");
    expect(pickMove({ ...STYLES.ozu, weights: { tatami: 0 } }, {}, rng).id).toBe("wide");
  });
  it("speaker line drops follow_behind/lead; symmetry quarters others", () => {
    const st = { ...STYLES.storybook, move: 1, weights: { follow_behind: 5, lead: 5, drift: 1 } };
    for (let i = 0; i < 20; i++) expect(pickMove(st, {}, seq(i / 20, i / 20), { line: true }).id).toBe("drift");
  });
});

/** the K2 fixture: 30 alternating beats, Mama + lying Mirai, seeds 7..9 */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ROOM: DRoom = { outline: [[-3.6, 0.6], [0.4, 0.6], [0.4, 4.2], [-3.6, 4.2]], ceiling: 2.7, open: false, floorY: 0 };
const CREW: DActor[] = [
  { name: "Mama", pos: [-1.65, 2.28], yaw: 315, faceYaw: 12, height: 1.7, level: null, room: "R", walking: false, head: [-1.6, 1.05, 2.3] },
  { name: "Mirai", pos: [-1.21, 2.63], yaw: 180, height: 1.2, level: null, room: "R", walking: false, lying: true, head: [-1.2, 0.45, 2.65] },
];
function run(style: string, seed: number) {
  const rng = mulberry32(seed);
  const d = createDirector(rng, { style });
  const outs: any[] = [];
  let prev = -1;
  const cuts: number[] = [];
  let clock = 0;
  for (let i = 0; i < 30; i++) {
    const dur = 4 + 2 * rng();
    const o = d.step({ event: { kind: "line", speaker: i % 2 ? "Mirai" : "Mama", durationS: dur, dt: i ? 5 : 0, beat: i, room: "R", tags: i === 0 ? { first: true } : {} }, actors: CREW, room: ROOM, rng });
    clock += i ? 5 : 0;
    if (o.cut !== prev) { outs.push(o); cuts.push(clock); prev = o.cut; }
  }
  return { outs, cuts };
}

describe("K2 fixture properties", () => {
  for (const style of IDS) for (const seed of [7, 8, 9]) {
    it(`${style} seed ${seed}: outputs stay in the style ranges`, () => {
      const st = STYLES[style];
      const { outs, cuts } = run(style, seed);
      // K2 debt (Nov 3): at least 12 plans for every style on 30 lines, ASL inside the style's range as far as
      // 5 s lines allow (a cut lands on a line), the camera at the style's height (no wall or ceiling in the way here)
      expect(outs.length).toBeGreaterThanOrEqual(12);
      const gaps = cuts.slice(1).map((c, i) => c - cuts[i]);
      const asl = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      expect(asl).toBeGreaterThanOrEqual(Math.min(st.asl[0], 5) - 1e-9);
      expect(asl).toBeLessThanOrEqual(Math.ceil(st.asl[1] / 5) * 5 + 1e-9);  // a hold is 5 or 10 s here
      for (const o of outs) {
        expect(o.cam[1]).toBeGreaterThanOrEqual(ROOM.floorY + st.height[0] - 0.05);
        expect(o.cam[1]).toBeLessThanOrEqual(ROOM.floorY + Math.max(st.height[1], 1.7) + 1e-3);
        expect(o.cam[1]).toBeLessThanOrEqual(ROOM.ceiling - 0.1 + 1e-3);
        if (o.fov !== undefined) {
          expect(o.fov).toBeGreaterThanOrEqual(st.fov[0] - 1e-6);
          expect(o.fov).toBeLessThanOrEqual(st.fov[1] + 1e-6);
        }
        if (o.shake !== undefined) {
          expect(o.shake).toBeGreaterThanOrEqual(0);
          expect(o.shake).toBeLessThanOrEqual(st.shake[1] + 1e-9);
        }
        if (st.move === 0) expect(o.end).toBeUndefined();
      }
    });
  }
  it("ozu: low camera, no end, no shake; anderson stands higher by >= 0.3 m", () => {
    const oz = run("ozu", 7).outs, an = run("anderson", 7).outs;
    const mean = (a: any[]) => a.reduce((s, o) => s + o.cam[1], 0) / a.length;
    for (const o of oz) { expect(o.cam[1]).toBeLessThanOrEqual(0.9 + 1e-3); expect(o.shake ?? 0).toBe(0); }
    expect(mean(an) - mean(oz)).toBeGreaterThanOrEqual(0.3);
  });
  it("storybook and spielberg differ in the set of moves", () => {
    const set = (s: string) => new Set(run(s, 7).outs.map((o) => o.move));
    expect([...set("storybook")].sort()).not.toEqual([...set("spielberg")].sort());
  });
});
