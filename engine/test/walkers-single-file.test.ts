/** Squidward v22 video 2:27–2:39: both went to SpongeBob's front door in one beat, one route, through the door to one
 *  spot and on in the house: two walkers inside each other the whole way (`spread` lets walkers be). Two walkers too
 *  close go single file: the one behind waits until the one ahead is a capsule's width off. */
import { describe, it, expect } from "vitest";
import { yieldPace } from "../src/runtime/stage/separate.js";

const w = (who: string, pos: [number, number], yaw: number, moving = true) => ({ who, pos, yaw, radius: 0.3, moving });

describe("yieldPace", () => {
  it("the one behind waits, the one ahead walks", () => {
    // both walk +z (yaw 0); Squidward 0.3 m behind SpongeBob
    const p = yieldPace([w("SpongeBob", [0, 1], 0), w("Squidward", [0, 0.7], 0)]);
    expect(p.get("SpongeBob")).toBe(1);
    expect(p.get("Squidward")).toBe(0);
  });
  it("on one spot (through one door) the first by name walks", () => {
    const p = yieldPace([w("Squidward", [5, 5], 90), w("SpongeBob", [5, 5], 90)]);
    expect(p.get("SpongeBob")).toBe(1);
    expect(p.get("Squidward")).toBe(0);
  });
  it("far enough apart both walk", () => {
    const p = yieldPace([w("SpongeBob", [0, 1], 0), w("Squidward", [0, 0], 0)]);
    expect(p.get("SpongeBob")).toBe(1);
    expect(p.get("Squidward")).toBe(1);
  });
  it("one standing still is no reason to wait (spread sets them apart once stopped)", () => {
    const p = yieldPace([w("SpongeBob", [0, 1], 0, false), w("Squidward", [0, 0.7], 0)]);
    expect(p.get("Squidward")).toBe(1);
  });
  it("walking toward each other neither waits for ever: the one with the other ahead waits, the other passes", () => {
    const p = yieldPace([w("SpongeBob", [0, 1], 180), w("Squidward", [0, 0.6], 0)]);
    expect([p.get("SpongeBob"), p.get("Squidward")].sort()).toEqual([0, 1]);
  });
  it("one going through a door does not stop for one coming up behind (v30 189.8–191.3 s: Squidward stood in the pineapple's door, SpongeBob walked into him)", () => {
    // each ahead of the other at the door: by name Squidward would wait; he is in the doorway, SpongeBob waits
    const p = yieldPace([{ ...w("Squidward", [5.82, -7.78], 315), first: true }, w("SpongeBob", [5.6, -7.6], 135)]);
    expect(p.get("Squidward")).toBe(1);
    expect(p.get("SpongeBob")).toBe(0);
  });
});
