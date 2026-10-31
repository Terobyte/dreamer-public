import { describe, it, expect } from "vitest";
import { releaseClaim, resolveTouch, type Place } from "../src/runtime/stage/places.js";

const PLACES: Place[] = [
  { name: "armchair", id: "living_armchair", kind: "sit", room: "living", level: "L0", at: [4.22, 3.26], yaw: 180, look: null, obstacle: null },
  { name: "window", id: "living_window", kind: "stand", room: "living", level: "L0", at: [2.0, 1.0], yaw: 0, look: [2.0, 0.0], obstacle: null },
];

// F6: resolveTouch books the place before the route is known. When the route
// misses, the caller must roll that booking back — otherwise the retry hits
// already_there and everyone else keeps seeing the place as taken.
describe("stage touch: a missed route releases the claim (F6)", () => {
  it("test_touch_missed_route_releases_claim", () => {
    const claims: Record<string, string> = {};
    const before = new Set(Object.keys(claims));
    const r1: any = resolveTouch({
      places: PLACES,
      claims,
      actor: { who: "Edward Rochester", at: [5.0, 2.0] },
      name: "armchair",
      clips: [],
    });
    expect("skip" in r1).toBe(false);
    expect(claims.armchair).toBe("Edward Rochester");

    // the route is unreachable: drop the booking resolveTouch just made
    releaseClaim(claims, before);
    expect("armchair" in claims).toBe(false);

    // the retry walks instead of reporting already_there
    const r2: any = resolveTouch({
      places: PLACES,
      claims,
      actor: { who: "Edward Rochester", at: [5.0, 2.0] },
      name: "armchair",
      clips: [],
    });
    expect("skip" in r2).toBe(false);
    expect(r2.target).toEqual(r1.target);
  });

  it("test_touch_missed_route_frees_place_for_others", () => {
    const claims: Record<string, string> = {};
    const before = new Set(Object.keys(claims));
    resolveTouch({ places: PLACES, claims, actor: { who: "Edward Rochester", at: [5.0, 2.0] }, name: "armchair", clips: [] });
    expect(claims.armchair).toBe("Edward Rochester");

    releaseClaim(claims, before);

    // Jane still finds the chair free and sits, instead of standing aside
    const r: any = resolveTouch({
      places: PLACES,
      claims,
      actor: { who: "Jane Eyre", at: [3.0, 2.0] },
      name: "armchair",
      clips: [],
    });
    expect("skip" in r).toBe(false);
    expect(r.act).toBe("sit");
    expect(claims.armchair).toBe("Jane Eyre");
  });
});
