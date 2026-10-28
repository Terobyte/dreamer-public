import { describe, expect, it } from "vitest";
import { Clipper } from "clipper2-ts";
import Ajv2020 from "ajv/dist/2020.js";

describe("scaffold", () => {
  it("loads clipper2-ts and ajv", () => {
    expect(typeof Clipper.inflatePaths).toBe("function");
    expect(typeof Ajv2020).toBe("function");
  });
});
