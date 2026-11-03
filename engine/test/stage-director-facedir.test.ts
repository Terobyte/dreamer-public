/** К2: faceDir — крупный план берёт сторону лица (faceYaw), а не тела (yaw). */
import { describe, it, expect } from "vitest";
import { createDirector, faceDir, type DActor, type DRoom } from "../src/runtime/stage/director.js";

const ROOM: DRoom = { outline: [[-5, -5], [5, -5], [5, 5], [-5, 5]], ceiling: 3, open: false };
const act = (o: Partial<DActor> = {}): DActor => ({ name: "a", pos: [0, 0], yaw: 0, height: 1.7, level: null, room: "R", walking: false, ...o });

const closeCam = (a: DActor) => {
  const d = createDirector(() => 0.5);
  return d.step({ event: { kind: "line", speaker: "a", durationS: 2, dt: 0, shot: "close" }, actors: [a], room: ROOM }).cam;
};

describe("faceDir", () => {
  it("body back (yaw 180), head to camera (faceYaw 0): close is on the face side", () => {
    const a = act({ yaw: 180, faceYaw: 0 });
    expect(faceDir(a)).toEqual([0, 1]);
    const cam = closeCam(a);
    // face looks +z: camera must stand at +z of the actor, not behind at -z
    expect(cam[2] - a.pos[1]).toBeGreaterThan(0);
  });

  it("mirror: body to camera (yaw 0), head back (faceYaw 180): close is behind", () => {
    const a = act({ yaw: 0, faceYaw: 180 });
    const cam = closeCam(a);
    expect(cam[2] - a.pos[1]).toBeLessThan(0);
  });
});
