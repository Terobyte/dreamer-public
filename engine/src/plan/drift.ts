import { SNAP_EPS } from "../geom/vec.js";
import type { Issue } from "../types.js";
import type { RoomGeo } from "./rooms.js";
import { msg } from "../report/messages.js";

interface EdgeInfo {
  room: RoomGeo;
  ri: number;
  i: number;
  from: [number, number];
  to: [number, number];
  len: number;
}

export function driftIssues(rooms: RoomGeo[], rawRooms: any[]): Issue[] {
  const out: Issue[] = [];
  const edges: EdgeInfo[] = [];
  rooms.forEach((r) => {
    const ri = rawRooms.findIndex((x: any) => x.id === r.id);
    r.edges.forEach((e) => {
      if (e.arc) return;
      const l = Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1]);
      if (l < 1e-9) return;
      edges.push({ room: r, ri, i: e.i, from: [e.from[0], e.from[1]], to: [e.to[0], e.to[1]], len: l });
    });
  });
  for (let a = 0; a < edges.length; a++) {
    for (let b = a + 1; b < edges.length; b++) {
      const A = edges[a];
      const B = edges[b];
      if (A.room.id === B.room.id) continue;
      if (A.room.level !== B.room.level) continue;
      const da: [number, number] = [A.to[0] - A.from[0], A.to[1] - A.from[1]];
      const db: [number, number] = [B.to[0] - B.from[0], B.to[1] - B.from[1]];
      const la = Math.hypot(da[0], da[1]);
      const lb = Math.hypot(db[0], db[1]);
      const cross = Math.abs(da[0] * db[1] - da[1] * db[0]) / (la * lb);
      const ang = Math.asin(Math.min(1, cross)) * (180 / Math.PI);
      if (ang >= 2 - 1e-9) continue;
      // perpendicular distance between lines
      const ux = da[0] / la;
      const uz = da[1] / la;
      const d = Math.abs((B.from[0] - A.from[0]) * uz - (B.from[1] - A.from[1]) * ux);
      if (d < SNAP_EPS - 1e-9 || d >= 0.5 - 1e-9) continue;
      // projection overlap
      const sA0 = 0;
      const sA1 = la;
      const sB0 = (B.from[0] - A.from[0]) * ux + (B.from[1] - A.from[1]) * uz;
      const sB1 = (B.to[0] - A.from[0]) * ux + (B.to[1] - A.from[1]) * uz;
      const lo = Math.max(Math.min(sA0, sA1), Math.min(sB0, sB1));
      const hi = Math.min(Math.max(sA0, sA1), Math.max(sB0, sB1));
      if (hi - lo <= 1e-9) continue;
      // later room in rooms[] moves
      const ai = rawRooms.findIndex((x: any) => x.id === A.room.id);
      const bi = rawRooms.findIndex((x: any) => x.id === B.room.id);
      const mover = ai > bi ? A : B;
      const other = mover === A ? B : A;
      // fix: vertices of mover's edge projected onto other's line
      const rawShape: any[] = rawRooms[mover.ri].shape;
      const n = rawShape.length;
      const k0 = mover.i;
      const k1 = (mover.i + 1) % n;
      // other line: point + dir
      const op = other.from;
      let odx = other.to[0] - other.from[0];
      let odz = other.to[1] - other.from[1];
      const ol = Math.hypot(odx, odz) || 1;
      odx /= ol;
      odz /= ol;
      const proj = (p: [number, number]): [number, number] => {
        const s = (p[0] - op[0]) * odx + (p[1] - op[1]) * odz;
        return [op[0] + odx * s, op[1] + odz * s];
      };
      const v0raw = rawShape[k0];
      const v1raw = rawShape[k1];
      const p0: [number, number] = [v0raw[0], v0raw[1]];
      const p1: [number, number] = [v1raw[0], v1raw[1]];
      const q0 = proj(p0);
      const q1 = proj(p1);
      const keepBulge = (v: any): unknown => (Array.isArray(v) && v.length === 3 ? v[2] : undefined);
      const b0 = keepBulge(v0raw);
      const b1 = keepBulge(v1raw);
      const val0: unknown = b0 === undefined ? [Math.round(q0[0] * 1e9) / 1e9, Math.round(q0[1] * 1e9) / 1e9] : [Math.round(q0[0] * 1e9) / 1e9, Math.round(q0[1] * 1e9) / 1e9, b0];
      const val1: unknown = b1 === undefined ? [Math.round(q1[0] * 1e9) / 1e9, Math.round(q1[1] * 1e9) / 1e9] : [Math.round(q1[0] * 1e9) / 1e9, Math.round(q1[1] * 1e9) / 1e9, b1];
      const fix: Record<string, unknown> = { [String(k0)]: val0, [String(k1)]: val1 };
      const dd = Math.round(d * 1000) / 1000;
      out.push({
        code: "EDGES_DRIFT",
        stage: "plan",
        path: `/rooms/${mover.ri}/shape`,
        msg: msg("EDGES_DRIFT", {
          path: `/rooms/${mover.ri}/shape`,
          a: `${mover.room.id}#${mover.i}`,
          b: `${other.room.id}#${other.i}`,
          d: String(dd),
        }),
        fix,
      });
    }
  }
  return out;
}
