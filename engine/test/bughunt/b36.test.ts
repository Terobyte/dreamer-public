import { describe, it, expect } from "vitest";
import { checkRefs } from "../../src/schema/refs.js";

describe("B36: duplicate level ids are not reported", () => {
  it("reports ID_DUPLICATE at /levels/1/id", () => {
    const issues = checkRefs({ levels: [{ id: "L0", y: 0 }, { id: "L0", y: 3.5 }] });
    const dup = issues.filter((i) => i.code === "ID_DUPLICATE").map((i) => i.path);
    expect(dup).toEqual(["/levels/1/id"]);
  });
});
