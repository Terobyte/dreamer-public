import { describe, it, expect } from "vitest";

describe("B05: empty nav.layers must not throw TypeError", () => {
  it("safe init with layers: []", () => {
    const nav: any = { layers: [], ramps: [] };
    const all = (nav.layers ?? []).map((l: any) => ({ layer: l, bits: l?.bits ?? "" }));
    // expected: safe init / skip walker without page crash (no all[0].layer access)
    expect(() => {
      // mirrors engine/src/runtime/main.ts:241 -> all[0].layer
      const first = all[0].layer;
      void first;
    }).not.toThrow();
  });
});
