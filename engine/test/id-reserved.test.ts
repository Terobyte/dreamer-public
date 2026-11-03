import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runCheck } from "../src/check.js";

// L99: an authored id equal to a generated mesh id (`cap:0`) duplicated mesh ids; check refuses ":" in ids
describe("authored ids cannot take the build's generated names", () => {
  it("a prop id with ':' is refused", () => {
    const s = JSON.parse(readFileSync(new URL("../../specs/examples/demo-flat.scene.json", import.meta.url), "utf8"));
    expect(runCheck(s).report.errors).toEqual([]);
    const p = (s.props ?? []).find((x: any) => typeof x?.id === "string");
    expect(p).toBeTruthy();
    p.id = "cap:0";
    const errs = runCheck(s).report.errors;
    expect(errs.map((e: any) => e.code)).toContain("ID_RESERVED");
  });
});
