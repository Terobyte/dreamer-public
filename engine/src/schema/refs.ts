import type { Issue } from "../types.js";
import { msg } from "../report/messages.js";

export const EPS = 1e-6;

export function escapePtr(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapeSeg(s: string): string {
  return s.replace(/~1/g, "/").replace(/~0/g, "~");
}

function splitPath(p: string): string[] {
  if (p === "") return [];
  return p.split("/").slice(1).map(unescapeSeg);
}

function childNode(node: unknown, key: string): unknown {
  if (Array.isArray(node)) {
    const i = Number(key);
    return Number.isInteger(i) ? node[i] : undefined;
  }
  if (node !== null && typeof node === "object") return (node as Record<string, unknown>)[key];
  return undefined;
}

function siblingKeys(node: unknown): string[] {
  if (Array.isArray(node)) return node.map((_, i) => String(i));
  if (node !== null && typeof node === "object") return Object.keys(node);
  return [];
}

// Document order: siblings ranked by key position in raw (missing keys last).
function compareDocPaths(a: string, b: string, raw: unknown): number {
  if (a === b) return 0;
  const sa = splitPath(a);
  const sb = splitPath(b);
  let node: unknown = raw;
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const ka = sa[i];
    const kb = sb[i];
    if (ka === undefined) return -1;
    if (kb === undefined) return 1;
    if (ka === kb) {
      node = childNode(node, ka);
      continue;
    }
    const keys = siblingKeys(node);
    const ia = keys.indexOf(ka);
    const ib = keys.indexOf(kb);
    if (ia === -1 && ib === -1) return ka < kb ? -1 : 1;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia < ib ? -1 : 1;
  }
  return 0;
}

export function sortIssues(issues: Issue[], raw?: unknown): Issue[] {
  return issues.sort((x, y) => {
    if (raw !== null && typeof raw === "object") {
      const d = compareDocPaths(x.path, y.path, raw);
      if (d !== 0) return d;
    } else if (x.path !== y.path) {
      return x.path < y.path ? -1 : 1;
    }
    return x.code < y.code ? -1 : x.code > y.code ? 1 : 0;
  });
}

export function checkRefs(raw: any): Issue[] {
  const out: Issue[] = [];
  const roomIds = new Set<string>((raw.rooms ?? []).map((r: any) => r?.id).filter((x: any) => typeof x === "string"));
  const roomById = new Map<string, any>((raw.rooms ?? []).map((r: any) => [r?.id, r]));
  const levelIds = new Set<string>((raw.levels ?? []).map((l: any) => l?.id).filter((x: any) => typeof x === "string"));
  const materialIds = new Set<string>(Object.keys(raw.materials ?? {}));
  const assetIds = new Set<string>(Object.keys(raw.assets ?? {}));
  const assetKind = new Map<string, string>(Object.entries(raw.assets ?? {}).map(([k, v]: [string, any]) => [k, v?.kind]));
  const propIds: string[] = (raw.props ?? []).map((p: any) => p?.id).filter((x: any) => typeof x === "string");

  const seen = new Map<string, string>();
  const reg = (id: string, path: string) => {
    if (seen.has(id)) {
      out.push({ code: "ID_DUPLICATE", stage: "schema", path, msg: msg("ID_DUPLICATE", { v: id }) });
    } else seen.set(id, path);
  };
  (raw.rooms ?? []).forEach((r: any, i: number) => typeof r?.id === "string" && reg(r.id, `/rooms/${i}/id`));
  (raw.openings ?? []).forEach((o: any, i: number) => typeof o?.id === "string" && reg(o.id, `/openings/${i}/id`));
  (raw.props ?? []).forEach((p: any, i: number) => typeof p?.id === "string" && reg(p.id, `/props/${i}/id`));
  (raw.cameras ?? []).forEach((c: any, i: number) => typeof c?.id === "string" && reg(c.id, `/cameras/${i}/id`));
  (raw.routes ?? []).forEach((r: any, i: number) => typeof r?.id === "string" && reg(r.id, `/routes/${i}/id`));

  (raw.levels ?? []).forEach((l: any, i: number) => typeof l?.id === "string" && reg(l.id, `/levels/${i}/id`));
  (raw.stairs ?? []).forEach((st: any, i: number) => typeof st?.id === "string" && reg(st.id, `/stairs/${i}/id`));


  const haveList = (s: Set<string>) => [...s].slice(0, 10).join(", ");
  const ref = (path: string, kind: string, v: string, have: Set<string>) => {
    if (!have.has(v)) out.push({ code: "REF_UNKNOWN", stage: "schema", path, msg: msg("REF_UNKNOWN", { path, kind, v, have: haveList(have) }) });
  };

  if (raw.spawn && typeof raw.spawn.room === "string") ref("/spawn/room", "room", raw.spawn.room, roomIds);

  (raw.scatter ?? []).forEach((sc: any, i: number) => {
    (Array.isArray(sc?.assets) ? sc.assets : []).forEach((a: unknown, j: number) => {
      if (typeof a !== "string") return;
      if (!assetIds.has(a)) ref(`/scatter/${i}/assets/${j}`, "asset", a, assetIds);
      else if (assetKind.get(a) !== "object") {
        const path = `/scatter/${i}/assets/${j}`;
        out.push({ code: "REF_KIND", stage: "schema", path, msg: msg("REF_KIND", { path, v: a, got: assetKind.get(a) ?? "?", want: "object" }) });
      }
    });
  });

  (raw.stairs ?? []).forEach((st: any, i: number) => {
    if (!st || typeof st !== "object") return;
    if (typeof st.from?.room === "string") ref(`/stairs/${i}/from/room`, "room", st.from.room, roomIds);
    if (typeof st.to?.room === "string") ref(`/stairs/${i}/to/room`, "room", st.to.room, roomIds);
  });

  (raw.rooms ?? []).forEach((r: any, i: number) => {
    if (!r || typeof r !== "object") return;
    if (typeof r.level === "string") ref(`/rooms/${i}/level`, "level", r.level, levelIds);
    if (typeof r.floor === "string") ref(`/rooms/${i}/floor`, "material", r.floor, materialIds);
    if (typeof r.ceiling === "string") ref(`/rooms/${i}/ceiling`, "material", r.ceiling, materialIds);
    if (typeof r.facade === "string") ref(`/rooms/${i}/facade`, "material", r.facade, materialIds);
    if (typeof r.roof?.material === "string") ref(`/rooms/${i}/roof/material`, "material", r.roof.material, materialIds);
    if (r.walls && typeof r.walls.material === "string") ref(`/rooms/${i}/walls/material`, "material", r.walls.material, materialIds);
    if (Array.isArray(r.walls?.bands)) {
      r.walls.bands.forEach(
        (b: any, j: number) => typeof b?.material === "string" && ref(`/rooms/${i}/walls/bands/${j}/material`, "material", b.material, materialIds),
      );
    }
    if (r.edges && typeof r.edges === "object") {
      const n = Array.isArray(r.shape) ? r.shape.length : r.circle ? 1 : 0;
      for (const [k, v] of Object.entries(r.edges as Record<string, any>)) {
        const isIndexKey = /^(0|[1-9]\d*)$/.test(k);
        const idx = isIndexKey ? Number(k) : NaN;
        if (!isIndexKey || idx < 0 || idx >= n) {
          const escaped = `/rooms/${i}/edges/${escapePtr(k)}`;
          out.push({
            code: "REF_UNKNOWN",
            stage: "schema",
            path: escaped,
            msg: msg("REF_UNKNOWN", {
              path: escaped,
              kind: "edge",
              v: k,
              have: haveList(new Set(Array.from({ length: n }, (_, x) => String(x)))),
            }),
          });
          continue;
        }
        if (v && typeof v.material === "string") ref(`/rooms/${i}/edges/${escapePtr(k)}/material`, "material", v.material, materialIds);
      }
    }
    if (Array.isArray(r.beams)) {
      r.beams.forEach((b: any, j: number) => typeof b?.material === "string" && ref(`/rooms/${i}/beams/${j}/material`, "material", b.material, materialIds));
    }
  });

  const checkOn = (on: any, base: string) => {
    if (!on || typeof on !== "object") return;
    if (typeof on.room === "string" && !roomIds.has(on.room)) {
      ref(`${base}/room`, "room", on.room, roomIds);
      return;
    }
    const room = roomById.get(on.room);
    const n = room ? (Array.isArray(room.shape) ? room.shape.length : room.circle ? 1 : 0) : 0;
    if (typeof on.edge === "number" && (on.edge < 0 || on.edge >= n)) {
      out.push({
        code: "REF_UNKNOWN",
        stage: "schema",
        path: `${base}/edge`,
        msg: msg("REF_UNKNOWN", {
          path: `${base}/edge`,
          kind: "edge",
          v: String(on.edge),
          have: haveList(new Set(Array.from({ length: n }, (_, x) => String(x)))),
        }),
      });
    }
  };

  (raw.openings ?? []).forEach((o: any, i: number) => {
    if (!o || typeof o !== "object") return;
    if (o.on) checkOn(o.on, `/openings/${i}/on`);
    if (o.leaf && typeof o.leaf.decal === "string") {
      const k = assetKind.get(o.leaf.decal);
      if (!assetIds.has(o.leaf.decal)) ref(`/openings/${i}/leaf/decal`, "asset", o.leaf.decal, assetIds);
      else if (k !== "decal") {
        out.push({ code: "REF_KIND", stage: "schema", path: `/openings/${i}/leaf/decal`, msg: msg("REF_KIND", { path: `/openings/${i}/leaf/decal`, v: o.leaf.decal, got: k ?? "?", want: "decal" }) });
      }
    }
    if (o.leaf && typeof o.leaf.swing === "string") ref(`/openings/${i}/leaf/swing`, "room", o.leaf.swing, roomIds);
    if (o.outside && typeof o.outside.backdrop === "string") {
      const k = assetKind.get(o.outside.backdrop);
      if (!assetIds.has(o.outside.backdrop)) ref(`/openings/${i}/outside/backdrop`, "asset", o.outside.backdrop, assetIds);
      else if (k !== "decal") {
        out.push({
          code: "REF_KIND",
          stage: "schema",
          path: `/openings/${i}/outside/backdrop`,
          msg: msg("REF_KIND", { path: `/openings/${i}/outside/backdrop`, v: o.outside.backdrop, got: k ?? "?", want: "decal" }),
        });
      }
    }
  });

  const od = raw.outdoor;
  if (od && typeof od === "object") {
    if (typeof od.sky === "string") {
      const k = assetKind.get(od.sky);
      if (!assetIds.has(od.sky)) ref("/outdoor/sky", "asset", od.sky, assetIds);
      else if (k !== "sky") out.push({ code: "REF_KIND", stage: "schema", path: "/outdoor/sky", msg: msg("REF_KIND", { path: "/outdoor/sky", v: od.sky, got: k ?? "?", want: "sky" }) });
    }
    const g = od.ground;
    if (g && typeof g === "object") {
      if (typeof g.material === "string") ref("/outdoor/ground/material", "material", g.material, materialIds);
      if (typeof g.fade === "number" && typeof g.radius === "number" && g.fade > g.radius) {
        out.push({ code: "SCHEMA_TYPE", stage: "schema", path: "/outdoor/ground/fade", msg: msg("SCHEMA_TYPE", { path: "/outdoor/ground/fade" }) });
      }
    }
  }

  for (const [k, v] of Object.entries((raw.assets ?? {}) as Record<string, any>)) {
    // a reference picture only feeds an object's mesh; a tile or decal is drawn whole
    if (v && typeof v === "object" && v.ref !== undefined && v.kind !== "object") {
      const path = `/assets/${escapePtr(k)}/ref`;
      out.push({ code: "REF_KIND", stage: "schema", path, msg: msg("REF_KIND", { path, v: k, got: v.kind ?? "?", want: "object" }) });
    }
    // a sky panorama is equirect 2:1; anything else (or missing) breaks the dome
    if (v?.kind === "sky" && v?.aspect !== "2:1") {
      const path = `/assets/${escapePtr(k)}/aspect`;
      out.push({ code: "SCHEMA_TYPE", stage: "schema", path, msg: msg("SCHEMA_TYPE", { path }) });
    }
  }

  const propById = new Map<string, number>((raw.props ?? []).map((p: any, i: number) => [p?.id, i]));
  (raw.props ?? []).forEach((p: any, i: number) => {
    if (!p || typeof p !== "object") return;
    if (typeof p.room === "string" && !roomIds.has(p.room)) ref(`/props/${i}/room`, "room", p.room, roomIds);
    if (typeof p.asset === "string") {
      const k = assetKind.get(p.asset);
      if (!assetIds.has(p.asset)) ref(`/props/${i}/asset`, "asset", p.asset, assetIds);
      else if (k !== "object") {
        out.push({ code: "REF_KIND", stage: "schema", path: `/props/${i}/asset`, msg: msg("REF_KIND", { path: `/props/${i}/asset`, v: p.asset, got: k ?? "?", want: "object" }) });
      }
    }
    if (p.on) {
      checkOn(p.on, `/props/${i}/on`);
      if (typeof p.on.room === "string" && typeof p.room === "string" && roomIds.has(p.on.room) && p.on.room !== p.room) {
        out.push({ code: "ROOM_REF_MISMATCH", stage: "schema", path: `/props/${i}`, msg: msg("ROOM_REF_MISMATCH", { path: `/props/${i}`, a: p.room, b: p.on.room }) });
      }
    }
    if (p.mount && typeof p.mount === "object" && typeof p.mount.top_of === "string") {
      if (!propById.has(p.mount.top_of)) ref(`/props/${i}/mount/top_of`, "prop", p.mount.top_of, new Set(propIds));
      // one cycle, one record: on its first member in scene order; a prop that
      // only stands on a cycle is not itself a defect
      let cur: string | undefined = p.mount.top_of;
      const chain: string[] = [p.id];
      while (typeof cur === "string" && propById.has(cur)) {
        if (cur === p.id) {
          if (chain.every((id) => propById.get(id)! >= i)) {
            const path = `/props/${i}/mount/top_of`;
            out.push({
              code: "REF_UNKNOWN",
              stage: "schema",
              path,
              msg: msg("REF_UNKNOWN", { path, cycle: [...chain, p.id].join(" → ") }),
            });
          }
          break;
        }
        if (chain.includes(cur)) break;
        chain.push(cur);
        const nxt = (raw.props as any[])[propById.get(cur)!]?.mount;
        cur = nxt && typeof nxt === "object" ? nxt.top_of : undefined;
      }
    }
    // a face target may be a prop, a room or an opening (placement resolves all three)
    const openIds: string[] = (raw.openings ?? []).map((o: any) => o?.id).filter((x: any) => typeof x === "string");
    if (typeof p.face === "string" && p.face !== "room" && !propById.has(p.face) && !roomIds.has(p.face) && !openIds.includes(p.face)) {
      ref(`/props/${i}/face`, "target", p.face, new Set([...propIds, ...roomIds, ...openIds]));
    }
    if (p.around && typeof p.around.center === "string" && !propById.has(p.around.center)) {
      ref(`/props/${i}/around/center`, "prop", p.around.center, new Set(propIds));
    }
  });

  (raw.decals ?? []).forEach((d: any, i: number) => {
    if (!d || typeof d !== "object") return;
    if (typeof d.asset === "string") {
      const k = assetKind.get(d.asset);
      if (!assetIds.has(d.asset)) ref(`/decals/${i}/asset`, "asset", d.asset, assetIds);
      else if (k !== "decal") {
        out.push({ code: "REF_KIND", stage: "schema", path: `/decals/${i}/asset`, msg: msg("REF_KIND", { path: `/decals/${i}/asset`, v: d.asset, got: k ?? "?", want: "decal" }) });
      }
    }
    if (typeof d.room === "string" && !roomIds.has(d.room)) {
      ref(`/decals/${i}/room`, "room", d.room, roomIds);
    }
    if (d.on) {
      checkOn(d.on, `/decals/${i}/on`);
      if (typeof d.on.room === "string" && typeof d.room === "string" && roomIds.has(d.on.room) && d.room !== d.on.room) {
        out.push({ code: "ROOM_REF_MISMATCH", stage: "schema", path: `/decals/${i}`, msg: msg("ROOM_REF_MISMATCH", { path: `/decals/${i}`, a: d.room, b: d.on.room }) });
      }
    }
  });

  if (raw.materials && typeof raw.materials === "object") {
    for (const [k, m] of Object.entries(raw.materials as Record<string, any>)) {
      if (m && typeof m.tile === "string") {
        const ak = assetKind.get(m.tile);
        if (!assetIds.has(m.tile)) ref(`/materials/${escapePtr(k)}/tile`, "asset", m.tile, assetIds);
        else if (ak !== "tile") {
          out.push({ code: "REF_KIND", stage: "schema", path: `/materials/${escapePtr(k)}/tile`, msg: msg("REF_KIND", { path: `/materials/${escapePtr(k)}/tile`, v: m.tile, got: ak ?? "?", want: "tile" }) });
        }
      }
    }
  }

  (raw.walls ?? []).forEach((w: any, i: number) => {
    if (!w || typeof w !== "object") return;
    if (typeof w.level === "string") ref(`/walls/${i}/level`, "level", w.level, levelIds);
    if (typeof w.material === "string") ref(`/walls/${i}/material`, "material", w.material, materialIds);
  });

  (raw.fixtures ?? []).forEach((f: any, i: number) => {
    if (!f || typeof f !== "object") return;
    if (typeof f.room === "string") ref(`/fixtures/${i}/room`, "room", f.room, roomIds);
    if (typeof f.material === "string") ref(`/fixtures/${i}/material`, "material", f.material, materialIds);
    if (typeof f.top === "string") ref(`/fixtures/${i}/top`, "material", f.top, materialIds);
  });

  const edgeCount = (room: any): number => (Array.isArray(room?.shape) ? room.shape.length : room?.circle ? 1 : 0);
  const edgeValid = (roomId: string, edge: number): boolean => {
    const room = roomById.get(roomId);
    if (!room) return true;
    const n = edgeCount(room);
    return Number.isInteger(edge) && edge >= 0 && edge < n;
  };
  const edgeHasBulge = (roomId: string, edge: number): boolean => {
    const room = roomById.get(roomId);
    if (!room) return false;
    if (!edgeValid(roomId, edge)) return false;
    if (room.circle) return true;
    const v = room.shape?.[edge];
    return Array.isArray(v) && v.length === 3 && typeof v[2]?.bulge === "number" && Math.abs(v[2].bulge) > 0;
  };
  const arcAzSpan = (roomId: string, edge: number): [number, number] | null => {
    const room = roomById.get(roomId);
    if (!room) return null;
    if (room.circle && Array.isArray(room.circle?.c) && typeof room.circle?.r === "number") {
      return [0, 360];
    }
    const v = room.shape?.[edge];
    if (!Array.isArray(v)) return null;
    const p0: [number, number] = [v[0], v[1]];
    const nxt = room.shape?.[(edge + 1) % room.shape.length];
    if (!Array.isArray(nxt)) return null;
    const p1: [number, number] = [nxt[0], nxt[1]];
    const b = v.length === 3 && v[2] && typeof v[2].bulge === "number" ? v[2].bulge : 0;
    if (!(Math.abs(b) > 0)) return null;
    const chord: Array<[number, number]> = room.shape.map((u: any) => [u[0], u[1]]);
    let s = 0;
    for (let i = 0; i < chord.length; i++) {
      const a = chord[i];
      const c = chord[(i + 1) % chord.length];
      s += a[0] * c[1] - c[0] * a[1];
    }
    const nIn: [number, number] = (() => {
      const d: [number, number] = [p1[0] - p0[0], p1[1] - p0[1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      const left: [number, number] = [-d[1] / l, d[0] / l];
      return s > 0 ? left : [-left[0], -left[1]];
    })();
    const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const a = d / 2;
    const sg = Math.abs(b) * a;
    const R = (a * a + sg * sg) / (2 * sg);
    const dir: [number, number] = b > 0 ? [-nIn[0], -nIn[1]] : [nIn[0], nIn[1]];
    const m: [number, number] = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    const c: [number, number] = [m[0] + dir[0] * (sg - R), m[1] + dir[1] * (sg - R)];
    const toAz = (p: [number, number]): number => ((Math.atan2(p[0] - c[0], p[1] - c[1]) * 180) / Math.PI % 360 + 360) % 360;
    const start = toAz(p0);
    const end = toAz(p1);
    const apex: [number, number] = [m[0] + dir[0] * sg, m[1] + dir[1] * sg];
    const midAz = toAz(apex);
    const fwd = (x: number): number => ((x % 360) + 360) % 360;
    const span = fwd(end - start);
    return fwd(midAz - start) <= span + 1e-9 ? [start, span] : [end, 360 - span];
  };
  const checkAz = (on: any, base: string) => {
    if (on && typeof on === "object" && "az" in on && typeof on.room === "string" && typeof on.edge === "number") {
      if (!roomIds.has(on.room) || !edgeValid(on.room, on.edge)) return;
      const span = arcAzSpan(on.room, on.edge);
      if (!span) {
        out.push({ code: "POS_INVALID", stage: "schema", path: base, msg: msg("POS_INVALID", { path: base }) });
        return;
      }
      const az = Number(on.az);
      if (!Number.isFinite(az)) return;
      const norm = ((az % 360) + 360) % 360;
      const [start, len] = span;
      const rel = ((norm - start) % 360 + 360) % 360;
      if (rel > len + 1e-9 && Math.abs(rel - 360) > 1e-9) {
        out.push({ code: "POS_INVALID", stage: "schema", path: base, msg: msg("POS_INVALID", { path: base }) });
      }
    }
  };
  (raw.openings ?? []).forEach((o: any, i: number) => o?.on && checkAz(o.on, `/openings/${i}/on`));
  (raw.props ?? []).forEach((p: any, i: number) => p?.on && checkAz(p.on, `/props/${i}/on`));
  (raw.decals ?? []).forEach((d: any, i: number) => d?.on && checkAz(d.on, `/decals/${i}/on`));

  // plan position of a prop: its own `at`, else (top_of) its support's centre
  const posOf = (p: any, depth = 0): number[] | undefined => {
    if (!p || typeof p !== "object" || depth > (raw.props as any[]).length) return undefined;
    // a wall mount moves off its authored `at` onto the wall: only placement knows where
    if (p.mount === "wall") return undefined;
    if (Array.isArray(p.at)) return p.at as number[];
    const sup = p.mount && typeof p.mount === "object" ? p.mount.top_of : undefined;
    if (typeof sup === "string" && propById.has(sup)) return posOf((raw.props as any[])[propById.get(sup)!], depth + 1);
    return undefined;
  };
  // an opening's authored `at` is its plan point (an `on` opening has none here)
  const openAt = new Map<string, number[]>();
  for (const o of (raw.openings ?? []) as any[]) {
    if (o && typeof o.id === "string" && Array.isArray(o.at)) openAt.set(o.id, o.at);
  }
  (raw.props ?? []).forEach((p: any, i: number) => {
    const at = p && typeof p === "object" && !p.around ? posOf(p) : undefined;
    if (!at) return;
    if (Array.isArray(p.face) && p.face.length === 2) {
      const dx = (p.face as number[])[0] - at[0];
      const dz = (p.face as number[])[1] - at[1];
      if (Math.hypot(dx, dz) <= EPS) out.push({ code: "POS_INVALID", stage: "schema", path: `/props/${i}/face`, msg: msg("POS_INVALID", { path: `/props/${i}/face` }) });
    }
    if (typeof p.face === "string" && p.face !== "room" && (propById.has(p.face) || openAt.has(p.face))) {
      const t = propById.has(p.face) ? posOf((raw.props as any[])[propById.get(p.face)!]) : openAt.get(p.face);
      if (t) {
        const dx = t[0] - at[0];
        const dz = t[1] - at[1];
        if (Math.hypot(dx, dz) <= EPS) out.push({ code: "POS_INVALID", stage: "schema", path: `/props/${i}/face`, msg: msg("POS_INVALID", { path: `/props/${i}/face` }) });
      }
    }
  });

  return sortIssues(out, raw);
}
