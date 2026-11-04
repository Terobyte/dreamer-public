import { describe, expect, it } from "vitest";
import { cleanSubtitle } from "../src/runtime/stage/subs.js";

describe("cleanSubtitle", () => {
  it("drops the voice's delivery marks and keeps the words", () => {
    expect(cleanSubtitle("[soft whisper, close] Good morning my <emphasis>moonbeam</emphasis>, sunrise waits [pause] [playful hush] for us"))
      .toBe("Good morning my moonbeam, sunrise waits for us");
    expect(cleanSubtitle("[warm] Let us look at the armchair. [[TOUCH:armchair]]")).toBe("Let us look at the armchair.");
    expect(cleanSubtitle("I'm here, <whisper>darling</whisper> [soft breath] close sleepy eyes")).toBe("I'm here, darling close sleepy eyes");
  });
  it("leaves plain text alone", () => {
    expect(cleanSubtitle("It was Mama's word. Just for Mirai.")).toBe("It was Mama's word. Just for Mirai.");
    expect(cleanSubtitle("2 < 3 and 4 > 1")).toBe("2 < 3 and 4 > 1");
  });
});
