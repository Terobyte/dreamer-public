/**
 * Koshakan bedroom (Nov 2, "камера странная"): Mama's 1.2 s walks got a `follow` cut, then a narration cut 1.2 s
 * later and a walk-end cut 0.3 s after that — shots of 0.5–1.5 s. A walk shorter than FOLLOW_MIN_M gets no cut,
 * neither when it starts nor when it ends; a long walk still gets its follow and keeps it until the walker stops.
 */
import { describe, it, expect } from "vitest";
import { createDirector, FOLLOW_MIN_M, type DActor, type DEvent, type DRoom } from "../src/runtime/stage/director.js";

const ROOM: DRoom = { outline: [[0, 0], [20, 0], [20, 20], [0, 20]], ceiling: 3, open: false };
const act = (name: string, pos: [number, number], o: Partial<DActor> = {}): DActor => ({ name, pos, yaw: 0, height: 1.7, level: null, room: "r", walking: false, ...o });
const narr: DEvent = { kind: "narrator", durationS: 5, dt: 0 };
const tick = (dt: number): DEvent => ({ kind: "tick", dt });

function mk() {
  let s = 1;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const d = createDirector(rng);
  return (event: DEvent, actors: DActor[]) => d.step({ event, actors, room: ROOM, rng });
}

describe("director: a short walk is not a shot", () => {
  it("a walk with less than FOLLOW_MIN_M left neither cuts in nor cuts out", () => {
    const step = mk();
    const still = [act("Mama", [9, 10]), act("Mirai", [11, 10])];
    const c0 = step(narr, still).cut;
    step(tick(3), still);
    const walking = [act("Mama", [9, 10], { walking: true, walkLeft: FOLLOW_MIN_M - 0.5 }), act("Mirai", [11, 10])];
    const w = step(tick(0.5), walking);
    expect(w.plan).not.toBe("follow");
    expect(w.cut).toBe(c0);
    expect(step(tick(0.5), still).cut).toBe(c0); // the walk ended: still no cut
  });

  it("a long walk cuts to follow and keeps it while the walk runs short, until the walker stops", () => {
    const step = mk();
    const still = [act("Mama", [9, 10]), act("Mirai", [11, 10])];
    const c0 = step(narr, still).cut;
    step(tick(3), still);
    const f = step(tick(0.1), [act("Mama", [9, 10], { walking: true, walkLeft: FOLLOW_MIN_M + 2 }), act("Mirai", [11, 10])]);
    expect(f.plan).toBe("follow");
    expect(f.cut).toBe(c0 + 1);
    const late = step(tick(0.1), [act("Mama", [9, 10], { walking: true, walkLeft: 0.3 }), act("Mirai", [11, 10])]);
    expect(late.plan).toBe("follow");
    expect(late.cut).toBe(c0 + 1);
    expect(step(tick(0.1), still).cut).toBe(c0 + 2); // stopped: the follow ends with a cut
  });

  it("an actor with no walkLeft (unknown route) counts as a long walk, as before", () => {
    const step = mk();
    const still = [act("Mama", [9, 10]), act("Mirai", [11, 10])];
    step(narr, still);
    expect(step(tick(0.1), [act("Mama", [9, 10], { walking: true }), act("Mirai", [11, 10])]).plan).toBe("follow");
  });

  it("a line during a short walk does not pick follow", () => {
    const step = mk();
    const still = [act("Mama", [9, 10]), act("Mirai", [11, 10])];
    step(narr, still);
    const p = step({ kind: "line", speaker: "Mama", durationS: 3, dt: 0 }, [act("Mama", [9, 10], { walking: true, walkLeft: 1 }), act("Mirai", [11, 10])]).plan;
    expect(p).not.toBe("follow");
  });
});

describe("director: a wide is a locked-off camera", () => {
  it("while someone walks inside a wide, the camera stays where the cut put it; only the look pans", () => {
    const step = mk();
    const still = [act("Mama", [9, 10]), act("Mirai", [11, 10])];
    const a = step(narr, still);
    expect(a.plan).toBe("wide");
    const b = step(tick(0.5), [act("Mama", [7.5, 11], { walking: true, walkLeft: 1 }), act("Mirai", [11, 10])]);
    expect(b.cut).toBe(a.cut);
    expect(b.cam).toEqual(a.cam);
    expect(b.look).not.toEqual(a.look);
  });

  it("a new cut to wide frames afresh", () => {
    const step = mk();
    const a = step(narr, [act("Mama", [9, 10]), act("Mirai", [11, 10])]);
    const b = step(narr, [act("Mama", [4, 4]), act("Mirai", [6, 4])]);
    step(narr, [act("Mama", [4, 4]), act("Mirai", [6, 4])]);
    const c = step({ kind: "narrator", durationS: 5, dt: 0, shot: "wide" }, [act("Mama", [4, 4]), act("Mirai", [6, 4])]);
    expect(c.plan).toBe("wide");
    expect(c.cam).not.toEqual(a.cam);
    void b;
  });
});
