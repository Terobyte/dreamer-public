import { expect, test } from "vitest";
import { runCheck } from "../src/check.js";
import { demoFlat } from "./helpers/scene.js";

function withFreeWall(openings: any[]): any {
  const scene = demoFlat() as any;
  scene.walls = [{ level: "L0", from: [-2, 12], to: [2, 12], material: "white" }];
  scene.openings = openings;
  return scene;
}

test("B11 at-opening on a free wall is resolved", () => {
  const scene = demoFlat() as any;
  scene.walls = [{ level: "L0", from: [-2, 12], to: [2, 12], material: "white" }];
  scene.openings.push({ id: "free-window", kind: "window", at: [0, 12], width: 1, height: 1, sill: 1, outside: { backdrop: "d_sea" } });

  const { ctx } = runCheck(scene, { until: "openings" });
  expect((ctx as any).openings.map((g: any) => g.id)).toContain("free-window");
});

test("B12 free-wall opening does not shift door leaf metadata", () => {
  const scene = withFreeWall([
    { id: "free-window", kind: "window", at: [0, 12], width: 1, height: 1, sill: 1, outside: { backdrop: "d_sea" } },
    { id: "front", kind: "door", at: [0, 4], width: 0.9, height: 2.1, sill: 0, leaf: { decal: "d_door", open: true } },
  ]);

  const { report } = runCheck(scene);
  const front = (report.passport.openings as any[]).find((opening) => opening.id === "front");
  expect(front.swing).toBe("living");
  expect(front.hinge).toBe("left");
});

test("B13 overlapping openings on a free-wall interval do not throw", () => {
  const scene = withFreeWall([
    { id: "free-window-a", kind: "window", on: { room: "hall", edge: 2, t: 0.5 }, width: 1, height: 1, sill: 1, outside: { backdrop: "d_sea" } },
    { id: "free-window-b", kind: "window", on: { room: "hall", edge: 2, t: 0.55 }, width: 1, height: 1, sill: 1, outside: { backdrop: "d_sea" } },
  ]);

  expect(() => runCheck(scene, { until: "openings" })).not.toThrow();
});
