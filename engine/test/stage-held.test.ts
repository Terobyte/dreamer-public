/** Squidward, Nov 3 ("почему сквид неподвижен? там есть мольберт анимация кларнет анимация"): the duo page put a
 *  brush in his right hand while he painted; the engine had no way to hold anything, so at the easel he only stood.
 *  A cast member's `held` names an object per clip: it rides the bone, at its size in metres, seen only while that
 *  clip (or idle) plays. */
import { describe, it, expect } from "vitest";
import { Bone, Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { attachHeld } from "../src/runtime/stage/held.js";

const rig = () => {
  const holder = new Group();
  holder.scale.setScalar(2.4); // the cast scales a 0.75-unit rig to 1.8 m
  const body = new Group();
  const hand = new Bone();
  hand.name = "hand_R";
  hand.position.set(0.1, 0.6, 0);
  body.add(hand);
  holder.add(body);
  holder.updateMatrixWorld(true);
  return { holder, body, hand };
};
const stick = (len: number) => new Mesh(new BoxGeometry(0.02, len, 0.02), new MeshBasicMaterial());

describe("held objects ride a bone, one clip each", () => {
  it("a brush sits on the hand at its size in metres, whatever the rig's scale", () => {
    const { holder, body, hand } = rig();
    const brush = stick(0.5);
    const h = attachHeld(body, { paint: { obj: brush, bone: "hand_R", size_m: 0.3 } });
    expect(h.warnings).toEqual([]);
    expect(brush.parent).toBe(hand);
    holder.updateMatrixWorld(true);
    const s = new Box3().setFromObject(brush).getSize(new Vector3());
    expect(Math.max(s.x, s.y, s.z)).toBeCloseTo(0.3, 3);
  });
  it("only the clip playing now shows its object", () => {
    const { body } = rig();
    const brush = stick(0.5);
    const clar = stick(0.6);
    const h = attachHeld(body, { paint: { obj: brush, bone: "hand_R", size_m: 0.3 }, clarinet: { obj: clar, bone: "hand_r", size_m: 0.62 } });
    h.show("paint");
    expect([brush.visible, clar.visible]).toEqual([true, false]);
    h.show("clarinet");
    expect([brush.visible, clar.visible]).toEqual([false, true]);
    h.show("idle");
    expect([brush.visible, clar.visible]).toEqual([false, false]);
  });
  it("a bone the rig does not have is a warning, nothing hangs in the air", () => {
    const { body } = rig();
    const brush = stick(0.5);
    const h = attachHeld(body, { paint: { obj: brush, bone: "paw_R", size_m: 0.3 } });
    expect(brush.parent).toBeNull();
    expect(h.warnings[0]).toMatch(/paw_R/);
  });
});
