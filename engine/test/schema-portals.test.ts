/** San Andreas doors (stage `Place.to`, make/stage.py portals): scene.json says where a door leads. An opening's `to`
 *  names a door or a portal; `portals` are door spots on an open place (a street has no wall to cut a door in). */
import { describe, it, expect } from "vitest";
import { patched } from "./helpers/scene.js";
import { validate } from "../src/schema/validate.js";

const errs = (raw: unknown) => validate(raw).issues.filter((i) => i.code.startsWith("SCHEMA"));

describe("scene schema: doors that lead elsewhere", () => {
  it("an opening's `to` and a portal are valid", () => {
    const s = patched([
      { op: "add", path: "/openings/0/to", value: "street_door" },
      { op: "add", path: "/portals", value: [{ id: "street_door", room: "living", at: [1, 1], yaw: 0, name: "the street door", to: "front" }] },
    ]);
    expect(errs(s)).toEqual([]);
  });
  it("a portal without id, room or at is not", () => {
    const s = patched([{ op: "add", path: "/portals", value: [{ room: "living", at: [1, 1] }] }]);
    expect(errs(s).length).toBeGreaterThan(0);
  });
  it("an unknown field in a portal is not", () => {
    const s = patched([{ op: "add", path: "/portals", value: [{ id: "p", room: "living", at: [1, 1], colour: "red" }] }]);
    expect(errs(s).length).toBeGreaterThan(0);
  });
});

import { runCheck } from "../src/check.js";
// the street sits apart from the house (no wall between them to cut a door in): the front door's `to` and the
// street's portal are the way there, so the street is reachable from spawn
describe("a room reached only by a door that leads there", () => {
  it("is not ROOM_UNREACHABLE", () => {
    const s: any = patched([
      { op: "add", path: "/openings/0/to", value: "street_door" },
      { op: "add", path: "/rooms/-", value: { id: "street", level: (patched([]) as any).rooms[0].level, open: true, floor: (patched([]) as any).rooms[0].floor, shape: [[40, 0], [60, 0], [60, 20], [40, 20]] } },
      { op: "add", path: "/portals", value: [{ id: "street_door", room: "street", at: [50, 5], yaw: 0, to: "front" }] },
    ]);
    if (s.rooms[2].level === undefined) delete s.rooms[2].level;
    const { report }: any = runCheck(s);
    const codes = [...(report.errors ?? []), ...(report.warnings ?? [])].map((i: any) => i.code);
    expect(codes.filter((c: string) => c.startsWith("SCHEMA"))).toEqual([]);
    expect(codes).not.toContain("ROOM_UNREACHABLE");
  });
});
