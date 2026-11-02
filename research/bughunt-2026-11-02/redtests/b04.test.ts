import { describe, it, expect } from "vitest";
import * as stageMod from "./index";

async function resolveInterRoomDoorStep(): Promise<(at: [number, number], yaw: any, d: number) => any> {
  const direct = (stageMod as any).interRoomDoorStep;
  if (typeof direct === "function") return direct;
  // fallback: helper may live in a sibling module; try common locations
  const candidates = ["./doors", "./door", "./rooms", "./geometry", "../stage", "./utils"];
  for (const p of candidates) {
    try {
      const m: any = await import(p);
      if (typeof m?.interRoomDoorStep === "function") return m.interRoomDoorStep;
    } catch { /* ignore, keep searching */ }
  }
  // last resort: scan all exports of index for a function returning {doorPos,insidePos}
  for (const v of Object.values(stageMod as any)) {
    if (typeof v !== "function") continue;
    try {
      const r: any = (v as any)([0, 0], 0, 1.0);
      if (r && Array.isArray(r.insidePos) && r.doorPos) return v as any;
    } catch { /* ignore */ }
  }
  throw new Error("setup: interRoomDoorStep not found in ./index");
}

describe("B04 enter with door.yaw === undefined", () => {
  it("does not produce NaN insidePos (must validate yaw or default like exit)", async () => {
    const fn = await resolveInterRoomDoorStep();
    // trigger: places.json door without yaw, handlers.stage enter calls interRoomDoorStep(door.at, door.yaw, 1.0)
    const doorAt: [number, number] = [5, 7];
    const doorYaw: any = undefined;
    const step: any = fn(doorAt, doorYaw, 1.0);
    const pts: [number, number][] = [step.doorPos, step.insidePos].filter(Boolean);
    // also yaw itself must be finite
    const allNums: number[] = [...pts.flat(), step.yaw];
    for (const n of allNums) {
      expect(Number.isFinite(n), `expected finite coord/yaw but got ${JSON.stringify(step)}`).toBe(true);
    }
  });
});
