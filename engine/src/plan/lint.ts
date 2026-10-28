import type { Ctx } from "../ctx.js";
import type { Issue } from "../types.js";
import { compileRooms } from "./rooms.js";

export function planStage(ctx: Ctx): Issue[] {
  const { rooms, issues } = compileRooms(ctx.scene);
  ctx.rooms = rooms;
  ctx.passport.edges = rooms.flatMap((r) =>
    r.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      len: e.len,
      arc: e.arc,
      normal_in: e.normalIn,
    })),
  );
  return issues;
}
