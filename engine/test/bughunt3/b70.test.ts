import { describe, expect, it } from "vitest";
import { Bone, Group, AnimationClip, Quaternion, QuaternionKeyframeTrack, Vector3 } from "three";
import { createAnimator, prepareClip } from "../../src/runtime/stage/anim.js";

const quat = (degrees: number): number[] => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), degrees * Math.PI / 180).toArray();

function rig(): Group {
  const root = new Group();
  for (const side of ["l", "r"]) {
    const arm = new Bone();
    arm.name = `upperarm_${side}`;
    root.add(arm);
  }
  return root;
}

function arms(name: string, times: number[], degrees: number[]): AnimationClip {
  const values = degrees.flatMap(quat);
  return new AnimationClip(name, -1, [
    new QuaternionKeyframeTrack("upperarm_l.quaternion", times, values),
    new QuaternionKeyframeTrack("upperarm_r.quaternion", times, values),
  ]);
}

describe("B70: clipfacts trims calibration against the original bind pose", () => {
  it("keeps the calibration cut after idle is activated; direct bind-pose preparation is the control", () => {
    const calibration = arms("action", [0, 0.5, 0.52, 0.6], [0, 0, 90, 90]);
    const control = prepareClip(calibration, rig());
    expect(control.duration).toBeLessThan(0.5);

    const body = rig();
    const idle = arms("idle", [0, 1], [70, 70]);
    const q70 = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 70 * Math.PI / 180);
    // Setting the idle clip's frame zero changes the pose before clipFacts prepares the same source clip.
    createAnimator(body, { idle, action: calibration }, { idle: "idle", life: false });
    expect(body.getObjectByName("upperarm_l")!.quaternion.angleTo(q70)).toBeLessThan(1e-6);
    const afterIdle = prepareClip(calibration, body);
    expect(afterIdle.duration).toBeLessThan(0.5);
  });
});
