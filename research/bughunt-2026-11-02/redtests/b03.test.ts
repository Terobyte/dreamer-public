import { describe, it, expect } from "vitest";

describe("B03: line focus must skip offstage speaker", () => {
  it("offstage Mama line falls back to onstage actors", () => {
    type A = { who: string; speaking: () => boolean };
    const list: A[] = [
      { who: "Mama", speaking: () => false },
      { who: "Papa", speaking: () => false },
    ];
    const sorted = [...list].sort((x, y) => (x.who < y.who ? -1 : 1));
    const offstageActors = new Set<string>(["Mama"]);
    const ev = { kind: "line", speaker: "Mama" } as const;

    const onstageList = list.filter((a) => !offstageActors.has(a.who));
    const onstageSorted = sorted.filter((a) => !offstageActors.has(a.who));

    // exact expression from engine/src/runtime/stage/index.ts:633 (current code)
    const focus: A | undefined =
      (list.find((a) => a.who === (ev as any).speaker) as A | undefined)
      ?? onstageList.find((a) => a.speaking())
      ?? onstageSorted[0]
      ?? sorted[0];

    // expected: offstage speaker is discarded, camera shows onstage reaction (Papa)
    expect(offstageActors.has(focus!.who)).toBe(false);
    expect(focus!.who).toBe("Papa");
  });
});
