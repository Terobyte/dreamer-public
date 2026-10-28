import { Clipper, FillRule } from "clipper2-ts";
import type { Path64 } from "clipper2-ts";
import type { Ctx } from "../ctx.js";
import type { Issue, Stage } from "../types.js";
import type { V2 } from "../geom/vec.js";
import type { Interval } from "../plan/merge.js";
import { EPS } from "../geom/vec.js";
import { msg } from "../report/messages.js";
import { resolveOpenings } from "./resolve.js";
import type { OpeningGeo } from "./resolve.js";
import { applySwing } from "./swing.js";
import { roomGraph } from "./graph.js";

const STAGE: Stage = "openings";

interface RoomRec {
  id: string;
  level: string;
  height: number;
  edges: Array<{ i: number; from: V2; to: V2; normalIn: V2 }>;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function cutPath(g: OpeningGeo): Path64 {
  const e0 = chordEnds(g);
  const dx = e0[1][0] - e0[0][0];
  const dz = e0[1][1] - e0[0][1];
  const chord = Math.hypot(dx, dz);
  let ux: number;
  let uz: number;
  let hl: number;
  let mx: number;
  let mz: number;
  if (chord > EPS) {
    ux = dx / chord;
    uz = dz / chord;
    hl = chord / 2;
    mx = (e0[0][0] + e0[1][0]) / 2;
    mz = (e0[0][1] + e0[1][1]) / 2;
  } else {
    ux = g.axis[0];
    uz = g.axis[1];
    hl = g.width / 2;
    mx = g.center[0];
    mz = g.center[1];
  }
  const hd = g.thickness / 2 + EPS;
  const px = -uz;
  const pz = ux;
  const corner = (a: number, b: number): { x: number; y: number } => ({
    x: Math.round((mx + ux * a + px * b) * 1000),
    y: Math.round((mz + uz * a + pz * b) * 1000),
  });
  return [corner(hl, hd), corner(-hl, hd), corner(-hl, -hd), corner(hl, -hd)];
}

function chordEnds(g: OpeningGeo): [V2, V2] {
  // chord endpoints on the wall axis (arc points on arcs, per spec)
  return g.ends;
}

export function openingsStage(ctx: Ctx): Issue[] {
  const scene = ctx.scene as any;
  const issues: Issue[] = [];

  const geos = resolveOpenings(ctx);
  (ctx as any).openings = geos as never;

  for (const g of geos) {
    if (g.error) issues.push(g.error);
  }

  const graph = roomGraph(ctx);
  (ctx as any).graph = graph;

  const rooms: RoomRec[] = (ctx as any).rooms ?? [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const order = new Map(rooms.map((r, i) => [r.id, i]));
  const sideEdge = (g: OpeningGeo, room: string): { i: number; from: V2; to: V2; normalIn: V2 } | undefined => {
    const side = g.interval.sides.find((s) => s.room === room);
    if (!side) return undefined;
    return roomById.get(room)?.edges.find((e) => e.i === side.edge);
  };

  // swing / hinge / sector for doors with a leaf
  const spawnRoom: string = scene.spawn?.room;
  const dist = new Map<string, number>();
  if (typeof spawnRoom === "string") {
    dist.set(spawnRoom, 0);
    const q = [spawnRoom];
    while (q.length > 0) {
      const cur = q.shift()!;
      for (const nb of graph.get(cur) ?? []) {
        if (!dist.has(nb)) {
          dist.set(nb, dist.get(cur)! + 1);
          q.push(nb);
        }
      }
    }
  }
  const list: any[] = scene.openings ?? [];
  geos.forEach((g, gi) => {
    if (g.error) return;
    const o = list[gi];
    if (g.kind !== "door" || !o.leaf) return;
    let swingRoom: string;
    if (typeof o.leaf.swing === "string") swingRoom = o.leaf.swing;
    else if (g.rooms.length === 1) swingRoom = g.rooms[0];
    else {
      swingRoom = g.rooms[0];
      let best = dist.get(swingRoom) ?? -1;
      for (const r of g.rooms.slice(1)) {
        const d = dist.get(r) ?? -1;
        if (d > best) {
          best = d;
          swingRoom = r;
        }
      }
    }
    let se = sideEdge(g, swingRoom);
    // inward normal at the opening position, oriented into the swing room;
    // a side edge's fixed normalIn is wrong on arcs, so use g.normalIn
    let nSwing: V2;
    if (swingRoom === g.rooms[0]) nSwing = [g.normalIn[0], g.normalIn[1]];
    else nSwing = [-g.normalIn[0], -g.normalIn[1]];
    if (!se) {
      const re = sideEdge(g, g.rooms[0]);
      se = re;
    }
    applySwing(g, {
      swingRoom,
      hinge: (o.leaf.hinge as "left" | "right" | undefined) ?? null,
      nSwing,
      swingFrom: se ? se.from : g.center,
      swingTo: se ? se.to : g.center,
      leafOpen: o.leaf.open !== false,
      kind: g.kind,
    });
  });

  // passport
  const pass = (ctx.passport.openings as unknown[]) ?? [];
  for (const g of geos) {
    if (g.error) continue;
    pass.push({
      id: g.id,
      edge: g.edge,
      m: g.m,
      rooms: g.rooms,
      swing: g.swing,
      hinge: g.hinge,
      hinge_at: g.hingeAt,
      center: g.center,
      sill: g.sill,
      height: g.height,
      corridor: g.corridor,
      sector: g.sector,
    });
  }
  ctx.passport.openings = pass as never;

  // edges passport: list openings per edge
  for (const e of ctx.passport.edges as Array<{ id: string; openings?: string[] }>) {
    const ids = geos.filter((g) => !g.error && g.edge === e.id).map((g) => g.id);
    if (ids.length > 0) e.openings = ids;
  }

  // body cuts
  const levels = (ctx as any).levels as Map<string, { intervals: Interval[]; body: Path64[] }>;
  if (levels) {
    const byLevel = new Map<string, OpeningGeo[]>();
    for (const g of geos) {
      if (g.error) continue;
      const l = byLevel.get(g.intervalLevel) ?? [];
      l.push(g);
      byLevel.set(g.intervalLevel, l);
    }
    for (const [lvl, plan] of levels) {
      let body = plan.body;
      for (const g of byLevel.get(lvl) ?? []) {
        // flatten first (arc body between the chord ends), then cut by the chord
        if (g.flatten) {
          const band = g.flatten.map((p) => ({ x: Math.round(p[0] * 1000), y: Math.round(p[1] * 1000) }));
          body = Clipper.difference(body, [band], FillRule.NonZero);
        }
        body = Clipper.difference(body, [cutPath(g)], FillRule.NonZero);
      }
      plan.body = body;
    }
  }

  // reachability, only with no other errors on this stage
  if (issues.length === 0 && typeof spawnRoom === "string") {
    const spawnLevel = roomById.get(spawnRoom)?.level;
    if (spawnLevel) {
      const rawRooms: any[] = scene.rooms ?? [];
      for (let i = 0; i < rawRooms.length; i++) {
        const r = rawRooms[i];
        if (r?.level !== spawnLevel) continue;
        if (r?.id === spawnRoom) continue;
        if (!dist.has(r?.id)) {
          const path = `/rooms/${i}`;
          issues.push({
            code: "ROOM_UNREACHABLE",
            stage: STAGE,
            path,
            msg: msg("ROOM_UNREACHABLE", { path, room: String(r?.id) }),
          });
        }
      }
      void order;
    }
  }

  return issues;
}
