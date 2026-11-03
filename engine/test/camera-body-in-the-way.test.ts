import { describe, it, expect } from "vitest";
import { bodyInTheWay, type CamBody } from "../src/runtime/stage/camera.js";

// Squidward, Nov 3 (film v7, 121 s): "close SpongeBob" was shot from just behind Squidward's head; the frame was the
// back of his head. The sight probe skips the actors, so the director thought the frame was clear. Another actor's
// body on the line from the camera to the subject's head blocks the frame; the subject's own body does not.
const squid: CamBody = { pos: [0.18, -1.86], y0: 0, top: 1.95, r: 0.3 };
const sponge: CamBody = { pos: [-0.59, 0.9], y0: 0, top: 1.25, r: 0.3 };
const spongeHead: [number, number, number] = [-0.59, 1.05, 0.9];

describe("bodyInTheWay", () => {
  it("a camera behind Squidward's head looking at SpongeBob's face: blocked", () => {
    const cam: [number, number, number] = [0.32, 1.6, -2.36];
    expect(bodyInTheWay(cam, spongeHead, [squid, sponge])).toBe(true);
  });
  it("the same look from the side, past Squidward: clear", () => {
    const cam: [number, number, number] = [-2.4, 1.3, -0.6];
    expect(bodyInTheWay(cam, spongeHead, [squid, sponge])).toBe(false);
  });
  it("the subject's own body under its head never blocks", () => {
    const cam: [number, number, number] = [-0.59, 1.1, 2.6];
    expect(bodyInTheWay(cam, spongeHead, [sponge])).toBe(false);
  });
  it("a look over a short body's head (it ends below the line) is clear", () => {
    const low: CamBody = { pos: [-0.2, -0.5], y0: 0, top: 0.7, r: 0.3 };
    const cam: [number, number, number] = [0.2, 1.6, -1.9];
    expect(bodyInTheWay(cam, spongeHead, [low, sponge])).toBe(false);
  });
});
