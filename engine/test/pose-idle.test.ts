/** k18_true 50–58 s: "Mirai stay bed sit" on "Good morning, Mama" — the wake_up clip sat her up, then the animator fell
 *  back to her cast idle sleep_curled and she lay down again while speaking. The pose a stage event sets picks the idle. */
import { describe, it, expect } from "vitest";
import { idleForPose } from "../src/runtime/stage/anim.js";

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
