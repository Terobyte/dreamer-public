// Tests for Н7б contract
import { describe, it, expect } from "vitest";
import { createDirector, type DActor, type DRoom } from "../src/runtime/stage/director.js";

const room: DRoom = {
  outline: [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
  ceiling: 3,
  open: false,
};

describe("director Н7б contract", () => {
  it("item 1: single actor explicit shot orbit and dolly are kept as is and build orbit/dolly frames", () => {
    const dir = createDirector(() => 0.5);
    const actor: DActor = {
      name: "Cat",
      pos: [5, 5],
      yaw: 0,
      height: 1.5,
      level: null,
      room: null,
      walking: false,
    };

    const outOrbit = dir.step({
      event: { kind: "line", speaker: "Cat", shot: "orbit", dt: 0 },
      actors: [actor],
      room,
    });
    expect(outOrbit.plan).toBe("orbit");
    expect(Math.hypot(outOrbit.cam[0] - 5, outOrbit.cam[2] - 5)).toBeGreaterThanOrEqual(2.9);
    expect(outOrbit.look[0]).toBeCloseTo(5, 5);
    expect(outOrbit.look[2]).toBeCloseTo(5, 5);

    const outDolly = dir.step({
      event: { kind: "line", speaker: "Cat", shot: "dolly", dt: 0 },
      actors: [actor],
      room,
    });
    expect(outDolly.plan).toBe("dolly");
    expect(outDolly.cam[0]).toBeCloseTo(5, 1);
    expect(outDolly.cam[2]).toBeCloseTo(9.5, 1);

    for (const shot of ["ots", "two", "low"] as const) {
      const out = dir.step({
        event: { kind: "line", speaker: "Cat", shot, dt: 0 },
        actors: [actor],
        room,
      });
      expect(out.plan).toBe(shot);
    }

    // Random choice without explicit shot remains restricted to wide/close/follow
    const outRandom = dir.step({
      event: { kind: "line", speaker: "Cat", dt: 0 },
      actors: [actor],
      room,
    });
    expect(["wide", "close", "follow"]).toContain(outRandom.plan);
  });

  it("item 2: sequence wide -> close -> follow -> wide -> wide on 5th line of single actor", () => {
    const seq = [0.4, 0.7, 0.1, 0.1];
    let stepCount = 0;
    const rng = () => seq[stepCount++] ?? 0.5;
    const dir = createDirector(rng);
    const actor: DActor = {
      name: "Cat",
      pos: [5, 5],
      yaw: 0,
      height: 1.5,
      level: null,
      room: null,
      walking: false,
    };

    const plans: string[] = [];
    for (let i = 0; i < 5; i++) {
      const out = dir.step({
        event: { kind: "line", speaker: "Cat", dt: 0 },
        actors: [actor],
        room,
      });
      plans.push(out.plan);
    }
    expect(plans).toEqual(["wide", "close", "follow", "wide", "wide"]);
  });

  it("item 3: walking actor during 45% reaction does not clear pending reaction queue", () => {
    const dir = createDirector(() => 0);
    const a1: DActor = { name: "A", pos: [2, 2], yaw: 0, height: 1.6, level: null, room: null, walking: false };
    const a2: DActor = { name: "B", pos: [4, 4], yaw: 180, height: 1.6, level: null, room: null, walking: false };

    // Line with duration 10s (> LONG_LINE=7), creates pending reactions at 4.5s (REACT_AT=0.45)
    dir.step({
      event: { kind: "line", speaker: "A", durationS: 10, dt: 0 },
      actors: [a1, a2],
      room,
    });

    // Advance time before 4.5s, actor starts walking
    a1.walking = true;
    const tickWalk = dir.step({
      event: { kind: "tick", dt: 2 },
      actors: [a1, a2],
      room,
    });
    expect(tickWalk.plan).toBe("follow");

    // Advance time to 4.5s
    const tickReact = dir.step({
      event: { kind: "tick", dt: 2.5 },
      actors: [a1, a2],
      room,
    });

    // The reaction at 45% should fire as close
    expect(tickReact.plan).toBe("close");
  });

  it("item 4: two actors in [5,5], yaw 0 and 180 axis taken from speaker gaze at start of line and kept until end of line (45% reaction does not change it)", () => {
    const dir = createDirector(() => 0);
    const a1: DActor = { name: "a", pos: [5, 5], yaw: 0, height: 1.6, level: null, room: null, walking: false };
    const a2: DActor = { name: "b", pos: [5, 5], yaw: 180, height: 1.6, level: null, room: null, walking: false };
    const room10: DRoom = { outline: [[0, 0], [10, 0], [10, 10], [0, 10]], ceiling: 3, open: false };

    // a starts speaking at yaw 0: axis is faceOf(0) = [0, 1], n = [-1, 0].
    // room center [5,5] == midpoint [5,5] -> toCenter = 0 -> side = 1.
    // Required side: ((x - 5)*(-1) + (z - 5)*0) * 1 > 0 => x < 5.
    const outStart = dir.step({
      event: { kind: "line", speaker: "a", durationS: 10, dt: 0, shot: "close" },
      actors: [a1, a2],
      room: room10,
    });
    expect(outStart.cam[0]).toBeLessThan(5);

    // During the line, speaker a turns to yaw 180 and actors move apart
    a1.yaw = 180;
    a2.pos = [5.4, 5];

    // At 4.5s (45%), listener reaction triggers (close on b)
    const outReact = dir.step({
      event: { kind: "tick", dt: 4.5 },
      actors: [a1, a2],
      room: room10,
    });

    expect(outReact.plan).toBe("close");
    // Axis must be preserved from the start of the line, keeping camera on x < 5
    expect(outReact.cam[0]).toBeLessThan(5);
  });
});
