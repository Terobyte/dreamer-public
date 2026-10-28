import { describe, it, expect } from "vitest";
import type { Code, Issue } from "../src/types.js";
import { caseNames, caseScene, runCase } from "./helpers/broken.js";

// codes whose spec template carries a numeric placeholder
// ({d}, {S}, {v}, {h}, {y0}, {L}, {x}, {m0}); {v} in REF_UNKNOWN and
// ID_DUPLICATE is a name, not a number, so those stay out.
const NUMERIC: Code[] = [
  "SCHEMA_PARSE",
  "ROOMS_OVERLAP",
  "EDGES_DRIFT",
  "OPENING_NO_WALL",
  "OPENING_OFF_EDGE",
  "OPENING_TOO_HIGH",
  "PROP_HITS_WALL",
  "PROP_HITS_PROP",
  "PROP_OUTSIDE_ROOM",
  "PROP_CEILING_LOW",
  "PROP_ABOVE_CEILING",
  "DECAL_OFF_WALL",
];

function sceneIds(s: any): string[] {
  const ids: string[] = [];
  for (const key of ["rooms", "openings", "props", "cameras", "routes"]) {
    for (const o of s[key] ?? []) if (typeof o?.id === "string") ids.push(o.id);
  }
  return ids;
}

function hasAddress(i: Issue, ids: string[]): boolean {
  if (/[A-Za-z_][\w-]*#\d+/.test(i.msg)) return true;
  if (/decal\.\d+/.test(i.msg)) return true;
  if (i.path && i.msg.includes(i.path)) return true;
  return ids.some((id) => i.msg.includes(id));
}

describe("messages", () => {
  for (const kind of ["broken", "warn"] as const) {
    for (const name of caseNames(kind)) {
      it(`test_msg_numbers ${kind}/${name}`, () => {
        const r = runCase(kind, name);
        const issues = kind === "broken" ? r.errors : r.warnings;
        expect(issues.length).toBe(1);
        const i = issues[0];
        expect(i.msg.length).toBeGreaterThan(0);
        expect(i.msg).not.toContain("{");
        expect(i.msg).not.toContain("undefined");
        expect(i.msg).not.toContain("NaN");
        if (i.code !== "SCHEMA_PARSE") expect(hasAddress(i, sceneIds(caseScene(kind, name) ?? {}))).toBe(true);
        if (NUMERIC.includes(i.code)) expect(/\d/.test(i.msg)).toBe(true);
      });
    }
  }
});
