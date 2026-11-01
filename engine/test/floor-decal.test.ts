import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { patched } from "./helpers/scene.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));

describe("floor decal", () => {
  it("test_floor_decal_plane_up", () => {
    const dir = mkdtempSync(join(tmpdir(), "dreamer-"));
    const scene = patched([
      {
        op: "add",
        path: "/decals/-",
        value: { asset: "d_sea", room: "living", at: [2, -2], rotation: 30, size: { w: 1.2, h: 0.8 } },
      },
    ]);
    const path = join(dir, "s.scene.json");
    writeFileSync(path, JSON.stringify(scene));
    const out = join(dir, "dist");
    const r = spawnSync("node", ["--import", "tsx", "bin/dreamer.ts", "build", path, "--out", out, "--assets", "none"], {
      cwd: ENGINE,
      encoding: "utf-8",
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const build = JSON.parse(readFileSync(join(out, "build.json"), "utf-8"));
    const floor = (build.decals as any[]).filter((d) => d.normal[1] === 1);
    expect(floor.length).toBe(1);
    expect(floor[0].normal).toEqual([0, 1, 0]);
    expect(floor[0].center[0]).toBeCloseTo(2, 6);
    expect(floor[0].center[1]).toBeCloseTo(0 + 0.005, 6);
    expect(floor[0].center[2]).toBeCloseTo(-2, 6);
    // the drawn quad lies flat on that height and faces up
    const geo = JSON.parse(readFileSync(join(out, "geometry.json"), "utf-8"));
    const m = (geo.meshes as any[]).find((x) => x.kind === "decal" && x.material === "d_sea");
    for (let i = 1; i < m.positions.length; i += 3) expect(m.positions[i]).toBeCloseTo(0.005, 6);
    for (let i = 0; i < m.normals.length; i += 3) expect(m.normals.slice(i, i + 3)).toEqual([0, 1, 0]);
    expect(geo.materials.d_sea.transparent).toBe(true);
  }, 90000);
});
