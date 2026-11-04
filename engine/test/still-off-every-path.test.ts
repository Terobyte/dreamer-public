/** Squidward v35 141.9–144 s (critic): a still follow_side on SpongeBob running to his pineapple stood 1.1 m high on
 *  the line Squidward trudged after him; Squidward walked past the lens, his body half the frame for two seconds.
 *  A still camera keeps off the path of every walker, not only the one it holds. */
import { describe, it, expect } from "vitest";
import { offWalkPaths, type DActor } from "../src/runtime/stage/director.js";
import { snapInside } from "../src/runtime/stage/camera.js";

const ROOM: [number, number][] = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
const walker = (name: string, pos: [number, number], yaw: number, left: number): DActor =>
  ({ name, pos, yaw, height: 1.8, level: null, room: "R", walking: true, walkLeft: left, head: [pos[0], 1.7, pos[1]] });

/** distance from c to the walker's remaining line */
const off = (c: [number, number], w: DActor): number => {
  const f: [number, number] = [Math.sin((w.yaw * Math.PI) / 180), Math.cos((w.yaw * Math.PI) / 180)];
  const along = Math.max(0, Math.min(w.walkLeft ?? 2, (c[0] - w.pos[0]) * f[0] + (c[1] - w.pos[1]) * f[1]));
  return Math.hypot(c[0] - (w.pos[0] + f[0] * along), c[1] - (w.pos[1] + f[1] * along));
};

describe("offWalkPaths", () => {
  it("a camera on the path of the one walking behind is put off it", () => {
    const bob = walker("SpongeBob", [0, 0], 90, 6); // runs along +x
    const sq = walker("Squidward", [-3, -2], 90, 8); // trudges along z = -2
    const q = offWalkPaths([3, -2.2], [bob, sq], snapInside, ROOM, "SpongeBob");
    // v36 141–143.5 s: 1.2 m was not enough — a 1.1 m high camera 1.2 m off a 1.8 m walker had his body for a frame;
    // one the frame does not hold passes 2 m off, whole in the frame
    expect(off(q, sq)).toBeGreaterThanOrEqual(2 - 1e-6);
    expect(off(q, bob)).toBeGreaterThanOrEqual(1.2 - 1e-6);
  });
  // v41 147–151 s: the still frame on Squidward (1.9 m) coming into the pineapple stood 1.2 m off his path; he walked
  // up to it two frame heights tall. The clearance is how far back the frame must be to hold the walker whole.
  it("the held walker's path is kept as far off as it takes to frame him head to feet", () => {
    const sq: DActor = { ...walker("Squidward", [0, 0], 90, 4), height: 1.9 };
    const fov = 45;
    const whole = 1.9 / (2 * 0.85 * Math.tan((fov / 2) * (Math.PI / 180)));
    const q = offWalkPaths([2, 1.2], [sq], snapInside, ROOM, "Squidward", fov);
    expect(off(q, sq)).toBeGreaterThanOrEqual(whole - 1e-6);
  });
  // v42 146.5–147.5 s (user: "почему картинка становится оранжевой"): pushed 2.6 m off Squidward's path in the round
  // pineapple, the camera stood behind its wall, the sight probe saw nobody, the frame was the wall for a second.
  // The push goes only as far as the probe still sees; the farthest seen spot wins, else the camera stays.
  it("the push stops where the sight probe stops seeing", () => {
    const sq: DActor = { ...walker("Squidward", [0, 0], 90, 4), height: 1.9 };
    const sees = (c: [number, number]): boolean => c[1] < 2; // a wall at z = 2
    const q = offWalkPaths([2, 1.2], [sq], snapInside, ROOM, "Squidward", 45, sees);
    expect(sees(q)).toBe(true);
    expect(off(q, sq)).toBeGreaterThan(1.5); // as far as it can, not left on 1.2
    const stuck = offWalkPaths([2, 1.2], [sq], snapInside, ROOM, "Squidward", 45, () => false);
    expect(stuck).toEqual([2, 1.2]);
  });
  it("a camera off every path stays where it is", () => {
    const bob = walker("SpongeBob", [0, 0], 90, 6);
    expect(offWalkPaths([3, 4], [bob], snapInside, ROOM, "SpongeBob")).toEqual([3, 4]);
  });
});
