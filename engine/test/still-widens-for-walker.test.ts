/** Squidward v43 145.7–148.7 s: the still frame on Squidward coming into the pineapple could not stand back far enough
 *  (the room's wall; pushed further it stood behind it, v42's orange frame), it stayed 1.2 m off his path at fov 44
 *  and he walked up to it, his back two frame heights tall. When the camera cannot stand back, the frame widens as
 *  far as it takes to hold him whole where he comes nearest. Numbers from the v43 critic's cut row. */
import { describe, it, expect } from "vitest";
import { fovToHoldWalker, type DActor } from "../src/runtime/stage/director.js";

const sq: DActor = { name: "Squidward", pos: [589.4, 4.9], yaw: 225, height: 1.8, level: "L0", room: "living", walking: true, walkTo: [588.4, 3.9], walkLeft: 1.41 };
const share = (cam: [number, number], fov: number): number => {
  const [a, b] = [sq.pos, sq.walkTo!];
  const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((cam[0] - a[0]) * dx + (cam[1] - a[1]) * dz) / (dx * dx + dz * dz)));
  const near = Math.hypot(cam[0] - a[0] - dx * t, cam[1] - a[1] - dz * t);
  return sq.height / (2 * near * Math.tan((fov / 2) * (Math.PI / 180)));
};

describe("fovToHoldWalker", () => {
  it("v43: 1.2 m off his path at fov 44 widens until he is whole where he comes nearest", () => {
    const cam: [number, number] = [587.67, 4.75];
    expect(share(cam, 44)).toBeGreaterThan(0.85); // the film's frame: he did not fit
    const fov = fovToHoldWalker(cam, 44, sq);
    expect(share(cam, fov)).toBeLessThanOrEqual(0.85 + 1e-6);
  });
  it("a camera far enough keeps its fov", () => {
    expect(fovToHoldWalker([584, 4.75], 44, sq)).toBe(44);
  });
  it("never wider than a lens the eye takes (90°)", () => {
    expect(fovToHoldWalker([589.0, 4.6], 44, sq)).toBeLessThanOrEqual(90);
  });
});
