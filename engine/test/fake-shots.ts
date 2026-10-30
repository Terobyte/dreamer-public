import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakePng } from "../src/assets/providers/fake.js";

/**
 * `check --built` wants a snapshot per camera in `dist/shots` (SHOT_MISSING
 * is an error since block Д). Tests that only care about the other built
 * checks drop a stand-in PNG for every camera of the built geometry.
 */
export function fakeShots(dist: string): void {
  const g = JSON.parse(readFileSync(join(dist, "geometry.json"), "utf-8")) as { cameras?: { id: string }[] };
  mkdirSync(join(dist, "shots"), { recursive: true });
  for (const cam of g.cameras ?? []) writeFileSync(join(dist, "shots", `${cam.id}.png`), fakePng(8, 8, [1, 2, 3]));
}
