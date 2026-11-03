import { describe, it, expect } from "vitest";
import { createBridge } from "../src/runtime/bridge.js";

// D4 (specs/2026-11-02-director-prompt.md, 2а): the sim's own scene change is not the page's
// business (the hero's `goto` moves him), the "загрузка" placard goes to its handler
describe("bridge D4: transition and placard", () => {
  const mk = (handlers?: any) => {
    const warns: string[] = [];
    const infos: string[] = [];
    const book: any[] = [];
    const b = createBridge(
      { door: () => null },
      { post: () => undefined, warn: (m) => warns.push(m), info: (m) => infos.push(m) },
      { scene_end: (e: any) => book.push(e), ...handlers },
    );
    return { b, warns, infos, book };
  };
  it("test_non_book_transition_is_ignored_quietly", () => {
    const { b, warns, infos } = mk();
    b.handle({ type: "transition", via: "npc_walk", to: "bathroom" });
    b.handle({ type: "transition", via: "touch" });
    expect(warns).toEqual([]);
    expect(infos.length).toBe(2);
  });
  it("test_placard_set_and_clear_reach_handler", () => {
    const got: any[] = [];
    const { b, warns } = mk({ placard: (e: any) => got.push(e) });
    b.handle({ type: "placard", door: "door", text: "загрузка", id: "s1" });
    b.handle({ type: "placard", clear: true });
    expect(got.map((e) => e.clear ?? e.door)).toEqual(["door", true]);
    expect(warns).toEqual([]);
  });
});
