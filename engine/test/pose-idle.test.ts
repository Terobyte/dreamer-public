/** k18_true 50–58 s: "Mirai stay bed sit" on "Good morning, Mama" — the wake_up clip sat her up, then the animator fell
 *  back to her cast idle sleep_curled and she lay down again while speaking. The pose a stage event sets picks the idle. */
import { describe, it, expect } from "vitest";
import { idleAfterClip, idleForPose } from "../src/runtime/stage/anim.js";

const FACTS = { sleep_curled: { lying: true }, wake_up: { lying: true }, sit_idle: { lying: false }, stand_idle: { lying: false }, idle_warm: { lying: false } };
const MIRAI = ["sleep_curled", "wake_up", "sit_idle", "stand_idle", "walk"];

describe("idle follows the staged pose", () => {
  it("a lying idle gives way to sit_idle when she is staged to sit", () => {
    expect(idleForPose("sit", "sleep_curled", MIRAI, FACTS)).toBe("sit_idle");
  });
  it("a lying idle gives way to stand_idle when she is staged to stand", () => {
    expect(idleForPose("stand_at", "sleep_curled", MIRAI, FACTS)).toBe("stand_idle");
  });
  it("lie keeps a lying idle", () => {
    expect(idleForPose("lie", "sleep_curled", MIRAI, FACTS)).toBeNull();
  });
  it("lie after sitting goes back to a lying idle", () => {
    expect(idleForPose("lie", "sit_idle", MIRAI, FACTS)).toBe("sleep_curled");
  });
  it("a standing idle is left alone on a sit (Mama on the bed edge sits by the procedural legs)", () => {
    expect(idleForPose("sit", "idle_warm", ["idle_warm", "sit_idle"], FACTS)).toBeNull();
  });
  it("no clip facts: nothing changes", () => {
    expect(idleForPose("sit", "sleep_curled", MIRAI, null)).toBeNull();
  });
});

// k24_true 38–42 s: wake_up sat Mirai up and stretched; when it ended the animator fell back to sleep_curled and she
// dropped onto the bed for 2 s, then sat up again on "Good morning". A clip that ends sitting hands over to a sitting idle.
describe("the idle after a clip continues its last pose", () => {
  const F = { ...FACTS, wake_up: { lying: true, end_lying: false }, giggle_back: { lying: true, end_lying: true } };
  it("a clip ending sitting turns a lying idle into sit_idle", () => {
    expect(idleAfterClip("wake_up", "sleep_curled", MIRAI, F)).toBe("sit_idle");
  });
  it("a clip ending lying keeps the lying idle", () => {
    expect(idleAfterClip("giggle_back", "sleep_curled", [...MIRAI, "giggle_back"], F)).toBeNull();
  });
  it("a standing idle is left alone", () => {
    expect(idleAfterClip("wake_up", "stand_idle", MIRAI, F)).toBeNull();
  });
  it("no end pose measured: nothing changes", () => {
    expect(idleAfterClip("wake_up", "sleep_curled", MIRAI, FACTS)).toBeNull();
  });
});
