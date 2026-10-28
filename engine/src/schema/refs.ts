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


  const haveList = (s: Set<string>) => [...s].slice(0, 10).join(", ");
  const ref = (path: string, kind: string, v: string, have: Set<string>) => {
    if (!have.has(v)) out.push({ code: "REF_UNKNOWN", stage: "schema", path, msg: msg("REF_UNKNOWN", { path, kind, v, have: haveList(have) }) });
  };

  if (raw.spawn && typeof raw.spawn.room === "string") ref("/spawn/room", "room", raw.spawn.room, roomIds);

  (raw.rooms ?? []).forEach((r: any, i: number) => {
    if (!r || typeof r !== "object") return;
    if (typeof r.level === "string") ref(`/rooms/${i}/level`, "level", r.level, levelIds);
    if (typeof r.floor === "string") ref(`/rooms/${i}/floor`, "material", r.floor, materialIds);
    if (typeof r.ceiling === "string") ref(`/rooms/${i}/ceiling`, "material", r.ceiling, materialIds);
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
      let cur: string | undefined = p.mount.top_of;
      const chain = new Set<string>([p.id]);
      while (typeof cur === "string" && propById.has(cur)) {
        if (chain.has(cur)) {
          out.push({
            code: "REF_UNKNOWN",
            stage: "schema",
            path: `/props/${i}/mount/top_of`,
            msg: msg("REF_UNKNOWN", { path: `/props/${i}/mount/top_of`, kind: "prop", v: p.mount.top_of, have: haveList(new Set(propIds)) }),
          });
          break;
        }
        chain.add(cur);
        const nxt = (raw.props as any[])[propById.get(cur)!]?.mount;
        cur = nxt && typeof nxt === "object" ? nxt.top_of : undefined;
      }
    }
    if (typeof p.face === "string" && p.face !== "room" && !propById.has(p.face) && !roomIds.has(p.face)) {
      ref(`/props/${i}/face`, "target", p.face, new Set([...propIds, ...roomIds]));
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
  const checkAz = (on: any, base: string) => {
    if (on && typeof on === "object" && "az" in on && typeof on.room === "string" && typeof on.edge === "number") {
      if (roomIds.has(on.room) && edgeValid(on.room, on.edge) && !edgeHasBulge(on.room, on.edge)) {
        out.push({ code: "POS_INVALID", stage: "schema", path: base, msg: msg("POS_INVALID", { path: base }) });
      }
    }
  };
  (raw.openings ?? []).forEach((o: any, i: number) => o?.on && checkAz(o.on, `/openings/${i}/on`));
  (raw.props ?? []).forEach((p: any, i: number) => p?.on && checkAz(p.on, `/props/${i}/on`));
  (raw.decals ?? []).forEach((d: any, i: number) => d?.on && checkAz(d.on, `/decals/${i}/on`));

  (raw.props ?? []).forEach((p: any, i: number) => {
    if (!p || typeof p !== "object" || !Array.isArray(p.at)) return;
    const at = p.at as number[];
    if (Array.isArray(p.face) && p.face.length === 2) {
      const dx = (p.face as number[])[0] - at[0];
      const dz = (p.face as number[])[1] - at[1];
      if (Math.hypot(dx, dz) <= EPS) out.push({ code: "POS_INVALID", stage: "schema", path: `/props/${i}/face`, msg: msg("POS_INVALID", { path: `/props/${i}/face` }) });
    }
    if (typeof p.face === "string" && p.face !== "room" && propById.has(p.face)) {
      const t = (raw.props as any[])[propById.get(p.face)!];
      if (t && Array.isArray(t.at)) {
        const dx = t.at[0] - at[0];
        const dz = t.at[1] - at[1];
        if (Math.hypot(dx, dz) <= EPS) out.push({ code: "POS_INVALID", stage: "schema", path: `/props/${i}/face`, msg: msg("POS_INVALID", { path: `/props/${i}/face` }) });
      }
    }
  });

  return sortIssues(out, raw);
}
