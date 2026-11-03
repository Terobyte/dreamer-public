/** Squidward, Nov 3 (v18 20–22 s): the last fallback (`unblock` of the wide) asked the probe about the look point
 *  between the heads; SpongeBob's head, behind a chair back, was never asked about. The frame it gives back sees every
 *  head that is in it. */
import { describe, it, expect } from "vitest";
import { unblock, type DActor, type DRoom } from "../src/runtime/stage/director.js";
import { roomRect, snapInside } from "../src/runtime/stage/camera.js";
import { ndcOf } from "../src/runtime/stage/moves.js";

const ROOM: DRoom = { outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]], ceiling: 3, open: false };
const sbHead: [number, number, number] = [-2.25, 0.59, 0.1];
const crew: DActor[] = [
  { name: "SpongeBob", pos: [-2.25, 0.1], yaw: 60, height: 1.0, head: sbHead, level: null, room: "r", walking: false },
  { name: "Squidward", pos: [0.7, 2.0], yaw: 240, height: 1.8, head: [0.7, 1.15, 2.0], level: null, room: "r", walking: false },
];
const hidden = (c: number[]): boolean => c[2] > 0.8 && c[1] < 1.6;
const clear = (c: [number, number, number], l: [number, number, number]): boolean =>
  Math.hypot(l[0] - sbHead[0], l[1] - sbHead[1], l[2] - sbHead[2]) < 0.05 ? !hidden(c) : true;

describe("unblock asks about the heads, not the look point", () => {
  it("a two-shot with SpongeBob behind the chair back moves to where his head is seen", () => {
    const out: any = { plan: "wide", cut: 1, cam: [-2.75, 1.12, 2.75], look: [-0.78, 0.87, 1.05], fov: 55 };
    const law: any = { outline: ROOM.outline, rect: roomRect(ROOM.outline), height: 3, floorY: 0 };
    const o = unblock(out, { actors: crew, room: ROOM, clear, aspect: 16 / 9 } as any, snapInside, law);
    const p = ndcOf(sbHead, o.cam, o.look, o.fov ?? 55, 16 / 9);
    const inFrame = p.depth > 0.2 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1;
    expect(inFrame && hidden(o.cam)).toBe(false);
  });
});
