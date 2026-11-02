import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DEvent, type DRoom } from "../src/runtime/stage/director.js";
import { createBridge, type StageEvent } from "../src/runtime/bridge.js";

const sq = (n: number): Array<[number, number]> => [[0, 0], [n, 0], [n, n], [0, n]];
const ROOM: DRoom = { outline: sq(20), ceiling: 3, open: false };
const act = (name: string, pos: [number, number], o: Partial<DActor> = {}): DActor => ({
  name,
  pos,
  yaw: 0,
  height: 1.7,
  level: null,
  room: "bedroom",
  walking: false,
  ...o,
});

describe("stage-blocking and director offstage", () => {
  it("offstage actor does not enter director pivot or crew until enter", () => {
    const mirai = act("Мирай", [5, 5], { offstage: false });
    const mama = act("Мама", [1, 1], { offstage: true });
    const director = createDirector(() => 0.5);

    // Narrator event: pivot should be Mirai, not Mama
    const out = director.step({
      event: { kind: "narrator", durationS: 3, dt: 0 },
      actors: [mama, mirai],
      room: ROOM,
    });
    // Camera look should focus near Mirai (5, 5), not Mama (1, 1)
    expect(out.look[0]).toBeCloseTo(5, 0.5);
    expect(out.look[2]).toBeCloseTo(5, 0.5);
  });

  it("bridge passes start and stage events", () => {
    const events: any[] = [];
    const warns: string[] = [];
    const bridge = createBridge(
      { door: () => null },
      { post: () => undefined, warn: (m) => warns.push(m) },
      {
        start: (e: any) => events.push(e),
        stage: (e: any) => events.push(e),
        line: (e: any) => events.push(e),
      } as any
    );

    bridge.handle({ type: "start", who: "Мирай", place: "bed", pose: "lie" });
    bridge.handle({ type: "stage", who: "Мама", action: "enter", place: "door" });
    bridge.handle({ type: "line", who: "Мама", text: "Привет" });

    expect(warns).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["start", "stage", "line"]);
  });

  it("runtime enter clears offstage and positions actor at door", () => {
    const mama = act("Мама", [0, 0], { offstage: true, room: "corridor" });
    expect(mama.offstage).toBe(true);
  });

  it("runtime exit moves to door and marks actor offstage", () => {
    const mama = act("Мама", [5, 5], { offstage: false, room: "bedroom" });
    expect(mama.offstage).toBe(false);
  });
});
