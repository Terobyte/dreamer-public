import { describe, it, expect } from "vitest";
import { sheetHtml, SHOTS_DEFAULTS } from "../src/build/shots.js";

describe("shots filenames", () => {
  it("test_shot_filenames_globally_unique", () => {
    // "room/left" sanitizes to "room_left", colliding with the literal
    // "room_left" id; the naive suffix for the first collision ("room_left-0")
    // then collides with the third camera's literal id.
    const cameras = [{ id: "room/left" }, { id: "room_left" }, { id: "room_left-0" }];
    const html = sheetHtml(cameras, SHOTS_DEFAULTS);
    const srcs = [...html.matchAll(/class="pane" src="(shots\/[^"]+)"/g)].map((m) => m[1]);
    expect(srcs.length).toBe(cameras.length);
    expect(new Set(srcs).size).toBe(cameras.length);
  });
});
