/** Hand placement (Nov 3, the user: "доработать кошакана ручками — объятия очень сложные, они постоянно друг на
 *  друге"): a scene may pin an actor by hand from a beat on, as Sonnet's demo did (story.js p0/yaw per segment),
 *  relative to another actor (forward / left / up of her root, yaw off hers) or in world coordinates. The rules
 *  place everyone else; a pin is the last word for the beats it names. */
import { describe, it, expect } from "vitest";
import { parseHand, pinPose } from "../src/runtime/stage/hand.js";

const close = (a: number[], b: number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 3));

describe("hand pins", () => {
  it("parses pins and drops bad ones with a warning", () => {
    const w: string[] = [];
    const pins = parseHand({ version: 1, pins: [
      { beat: 41, who: "Mirai", rel: "Mama", fwd: 0.26, left: 0.15, up: 0.38, yaw: 180 },
      { beat: 12, who: "Mama", at: [1, 2], y: 0.1, yaw: 90 },
      { beat: "x", who: "Mirai" },
      { beat: 3, who: "Mirai" },
    ] }, w);
    expect(pins.map((p) => p.beat)).toEqual([12, 41]);
    expect(w.length).toBe(2);
    expect(parseHand({ pins: "no" }, w)).toEqual([]);
    expect(parseHand(null, [])).toEqual([]);
  });

  it("a relative pin: forward/left of the other's root along her yaw, up from her support, yaw off hers", () => {
    const [p] = parseHand({ version: 1, pins: [{ beat: 1, who: "Mirai", rel: "Mama", fwd: 0.26, left: 0.15, up: 0.38, yaw: 180 }] }, []);
    // holder faces +X (yaw 90): forward +X, left -Z
    const s = pinPose(p!, { pos: [1, -7], yaw: 90, y: 0.2 })!;
    close(s.at, [1.26, -7.15]);
    expect(s.y).toBeCloseTo(0.58, 3);
    expect(s.yaw).toBe(270);
    expect(pinPose(p!, null)).toBeNull();
  });

  it("a world pin ignores any other actor; an omitted yaw or height is null (keep the actor's own)", () => {
    const [p] = parseHand({ version: 1, pins: [{ beat: 1, who: "Mama", at: [1, 2] }] }, []);
    expect(pinPose(p!, null)).toEqual({ at: [1, 2], y: null, yaw: null });
  });
});
