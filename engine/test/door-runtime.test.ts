import { describe, it, expect } from "vitest";
import { TURN_S, makeDoor, touchTarget, type DoorDef } from "../src/runtime/doors.js";
import { createBridge } from "../src/runtime/bridge.js";

const DEF: DoorDef = {
  id: "front",
  rooms: ["living", "yard"],
  hinge_at: [0.45, 4],
  swing: "living",
  width: 0.9,
  height: 2.1,
  open: false,
  closed_end: [-0.45, 4],
  open_end: [0.45, 3.1],
};

describe("door state", () => {
  it("test_door_open_turns_in_0_6s_toward_swing", () => {
    const d = makeDoor(DEF);
    expect(d.angle()).toBeCloseTo(0, 6);
    d.open();
    d.update(TURN_S / 2);
    expect(Math.abs(d.angle())).toBeGreaterThan(30);
    expect(Math.abs(d.angle())).toBeLessThan(60);
    d.update(TURN_S);
    expect(Math.abs(d.angle())).toBeCloseTo(90, 0);
    expect(d.state()).toBe("open");
    expect(d.blocks()).toBe(false);
  });

  it("test_door_lock_closes_and_refuses_open", () => {
    const d = makeDoor({ ...DEF, open: true });
    expect(Math.abs(d.angle())).toBeCloseTo(90, 0);
    d.lock();
    d.update(TURN_S + 0.1);
    expect(d.angle()).toBeCloseTo(0, 6);
    expect(d.state()).toBe("locked");
    d.open();
    d.update(TURN_S + 0.1);
    expect(d.angle()).toBeCloseTo(0, 6);
    expect(d.blocks()).toBe(true);
    d.close();
    expect(d.state()).toBe("locked");
  });

  it("test_door_touch_needs_distance_and_gaze", () => {
    const d = makeDoor(DEF);
    // the leaf lies along x at z=4; stand 1 m south of it, face +z (yaw 0)
    expect(touchTarget([d], [0, 3], 0)).toBe("front");
    expect(touchTarget([d], [0, 3], 180)).toBe(null);
    expect(touchTarget([d], [0, 1], 0)).toBe(null);
  });
});

describe("sim bridge", () => {
  function setup() {
    const calls: Array<[string, string]> = [];
    const posts: Array<[string, any]> = [];
    const warns: string[] = [];
    const engine = {
      door: (id: string) =>
        id === "front"
          ? { open: () => calls.push(["open", id]), close: () => calls.push(["close", id]), lock: () => calls.push(["lock", id]) }
          : null,
    };
    const bridge = createBridge(engine, { post: (p, b) => posts.push([p, b]), warn: (m) => warns.push(m) });
    return { calls, posts, warns, bridge };
  }

  it("test_bridge_door_open_calls_engine_door", () => {
    const { calls, bridge } = setup();
    bridge.handle({ type: "door", object: "front", state: "open" });
    bridge.handle({ type: "door", object: "front", state: "locked" });
    expect(calls).toEqual([["open", "front"], ["lock", "front"]]);
  });

  it("test_bridge_touch_posts_exactly_one_event", () => {
    const { posts, bridge } = setup();
    bridge.touch("front");
    expect(posts).toEqual([["/event", { type: "touch", object: "front" }]]);
  });

  it("test_bridge_unknown_type_and_door_do_not_throw", () => {
    const { calls, warns, bridge } = setup();
    expect(() => bridge.handle({ type: "move", to: [1, 2] })).not.toThrow();
    expect(() => bridge.handle({ type: "door", object: "ghost", state: "open" })).not.toThrow();
    expect(() => bridge.handle(null)).not.toThrow();
    expect(calls).toEqual([]);
    expect(warns.length).toBe(3);
  });
});
