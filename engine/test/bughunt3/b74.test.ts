import { describe, expect, it } from "vitest";
import { runCheck } from "../../src/check.js";
import { demoFlat } from "../helpers/scene.js";

describe("B74: cyclic around.center reference", () => {
  it("reports the self-reference before the around prop disappears", () => {
    const healthy = runCheck(demoFlat());
    expect(healthy.ctx.props?.filter((p) => p.id.startsWith("chairs."))).toHaveLength(4);

    const scene = demoFlat() as any;
    scene.props[1].around.center = "chairs";
    const { report, ctx } = runCheck(scene);

    // Downstream symptom: the four copies are never placed (with the schema error the pipeline
    // stops before props exist, so ctx.props is undefined) and lintProps emits no unplaced-prop issue.
    expect(ctx.props?.some((p) => p.id.startsWith("chairs.")) ?? false).toBe(false);
    expect([...report.errors, ...report.warnings].some((i) => i.path === "/props/1")).toBe(false);

    // Expected from the bug report: reject the cycle at schema validation.
    expect(report.errors).toContainEqual(
      expect.objectContaining({ code: "REF_UNKNOWN", path: "/props/1/around/center" }),
    );
  });
});
