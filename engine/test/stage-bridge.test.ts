import { describe, it, expect } from "vitest";
import { createBridge } from "../src/runtime/bridge.js";

describe("bridge stage handlers", () => {
  const mk = (handlers?: any) => {
    const warns: string[] = [];
    const b = createBridge({ door: () => null }, { post: () => undefined, warn: (m) => warns.push(m) }, handlers);
    return { b, warns };
  };
  it("test_bridge_routes_line_narrator_touch_mode_story", () => {
    const got: any[] = [];
    const h = Object.fromEntries(["line", "narrator", "touch", "mode", "story"].map((k) => [k, (e: any) => got.push([k, e.type])]));
    const { b, warns } = mk(h);
    for (const t of ["line", "narrator", "touch", "mode", "story"]) b.handle({ type: t });
    expect(got.map((g) => g[0])).toEqual(["line", "narrator", "touch", "mode", "story"]);
    expect(warns).toEqual([]);
  });
  it("test_bridge_without_handlers_warns_as_before", () => {
    const { b, warns } = mk();
    b.handle({ type: "line" });
    expect(warns[0]).toContain('unknown type "line"');
  });
});
