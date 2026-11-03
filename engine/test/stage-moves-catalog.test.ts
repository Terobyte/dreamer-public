/** К3м v2, rule 1: `bin/moves.ts --catalog` prints the style/move catalogue straight from the tables. */
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { MOVES, SCHEMES, RECORDS } from "../src/runtime/stage/moves.js";
import { STYLES } from "../src/runtime/stage/styles.js";

const run = (...args: string[]) => spawnSync("node", ["--import", "tsx", "bin/moves.ts", ...args], { cwd: process.cwd(), encoding: "utf8" });

describe("moves --catalog (r1)", () => {
  it("r1: 8 styles, disjoint ids, meanings, weights from STYLES", () => {
    const cat = JSON.parse(execFileSync("node", ["--import", "tsx", "bin/moves.ts", "--catalog"], { cwd: process.cwd(), encoding: "utf8" }));
    expect(cat.styles).toHaveLength(8);
    expect([...cat.styles].sort()).toEqual(Object.keys(STYLES).sort());
    const m = Object.keys(cat.moves), s = Object.keys(cat.schemes), r = Object.keys(cat.records);
    expect(new Set([...m, ...s, ...r]).size).toBe(m.length + s.length + r.length);
    expect(m.sort()).toEqual(Object.keys(MOVES).sort());
    expect(s.sort()).toEqual(Object.keys(SCHEMES).sort());
    expect(r.sort()).toEqual(Object.keys(RECORDS).sort());
    for (const g of [cat.moves, cat.schemes, cat.records]) for (const v of Object.values(g)) expect(String(v).length).toBeGreaterThan(0);
    for (const st of Object.keys(STYLES)) expect(cat.weights[st]).toEqual(STYLES[st].weights);
  });
  it("r1: any other argument -> exit 2 and usage", () => {
    for (const args of [[], ["--nope"], ["--catalog", "x"]]) {
      const p = run(...args);
      expect(p.status).toBe(2);
      expect(p.stderr + p.stdout).toMatch(/usage/i);
    }
  });
  it("r1: keys match the h0 testdata catalog when present", () => {
    const f = "../h0/make/testdata/shotplan_koshakan/catalog.json";
    if (!existsSync(f)) return;
    const ref = JSON.parse(readFileSync(f, "utf8"));
    const cat = JSON.parse(execFileSync("node", ["--import", "tsx", "bin/moves.ts", "--catalog"], { encoding: "utf8" }));
    expect(Object.keys(cat).sort()).toEqual(Object.keys(ref).sort());
    for (const k of ["moves", "schemes", "records", "weights"]) expect(Object.keys(cat[k]).sort()).toEqual(Object.keys(ref[k]).sort());
  });
});
