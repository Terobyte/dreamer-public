import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../src/check.js";
import { writeDist } from "../src/build/write.js";
import { fakePng } from "../src/assets/providers/fake.js";
import { patched } from "./helpers/scene.js";

describe("camera bugs", () => {
  it("B22 camera above a low wall is not inside the wall body", () => {
    const scene = patched([
      {
        op: "add",
        path: "/walls",
        value: [{ level: "L0", from: [-1, 8], to: [1, 8], material: "olive", h: 0.5 }],
      },
      {
        op: "add",
        path: "/cameras",
        value: [{ id: "over", pos: [0, 1.6, 8], look: [0, 1.6, 0] }],
      },
    ]);
    const { report } = runCheck(scene);
    const outside = [...report.errors, ...report.warnings].filter((i) => i.code === "CAMERA_OUTSIDE");
    expect(outside.map((i) => i.msg)).toEqual([]);
  });

  it("B35 second writeDist with the same ctx still resolves the camera ref", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bug35-"));
    const scenePath = join(dir, "demo-flat.scene.json");
    writeFileSync(join(dir, "myref.png"), fakePng(8, 8, [10, 20, 30]));
    const scene = patched([{ op: "add", path: "/cameras/0/ref", value: "myref.png" }]);
    writeFileSync(scenePath, JSON.stringify(scene));
    const { ctx, report } = runCheck(scene);

    const out1 = join(dir, "dist1");
    const out2 = join(dir, "dist2");
    await writeDist(ctx, report, out1, { startedAt: Date.now(), scenePath });
    await writeDist(ctx, report, out2, { startedAt: Date.now(), scenePath });

    const g2 = JSON.parse(readFileSync(join(out2, "geometry.json"), "utf-8"));
    expect(g2.cameras[0].ref).toBe("refs/0-myref.png");
    expect(existsSync(join(out2, "refs", "0-myref.png"))).toBe(true);
  }, 120000);
});
