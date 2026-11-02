import { describe, it, expect, vi } from "vitest";
import { createToucher } from "./touch.js";

describe("B02: pending touch must keep pose and finishYaw", () => {
  it("tick replays touch with saved finishYaw", () => {
    let actorY = 5; // on ramp: matches no level
    const go = vi.fn();
    const ctx: any = {
      places: [{ name: "chair", level: "L1", target: [10, 0], yaw: 0 } as any],
      claims: {} as any,
      levels: [{ y: 0, layer: { level: "L1" } } as any],
      ramps: [] as any,
      doors: {},
      doorOpen: () => false,
      actor: (_who: string) => ({
        pos: () => [0, 0] as any,
        y: () => actorY,
        go: (...args: any[]) => (go as any)(...args),
      }),
      warnings: [],
    };
    const toucher = createToucher(ctx);
    const first = toucher.touch("bob", "chair", "sit", 90);
    expect(first).toBe("queued");
    expect(go).not.toHaveBeenCalled();

    // actor steps off the ramp onto the level
    actorY = 0;
    toucher.tick();

    expect(go).toHaveBeenCalledTimes(1);
    const yaw = (go.mock.calls[0] as any[])[1];
    // saved finishYaw=90 must survive the queue; buggy code replays without it and falls back to place yaw (0)
    expect(yaw).toBe(90);
  });
});
