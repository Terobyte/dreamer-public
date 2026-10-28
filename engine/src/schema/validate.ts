import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import schemaJson from "../../schema/engine-scene.schema.json" with { type: "json" };
import type { Issue, Scene } from "../types.js";
import { msg, futureHint } from "../report/messages.js";
import { checkRefs, escapePtr, sortIssues } from "./refs.js";

const AjvClass = (Ajv2020 as unknown as { default?: new (opts: object) => any }).default ?? (Ajv2020 as unknown as new (opts: object) => any);
const ajv = new AjvClass({ allErrors: true, strict: false });
const validateFn = ajv.compile(schemaJson);

const FUTURE_PATTERNS: Array<{ re: RegExp; prefix: string }> = [
  { re: /^\/walls(\/|$)/, prefix: "/walls" },
  { re: /^\/fixtures(\/|$)/, prefix: "/fixtures" },
  { re: /^\/stairs(\/|$)/, prefix: "/stairs" },
  { re: /^\/shafts(\/|$)/, prefix: "/shafts" },
  { re: /^\/holes(\/|$)/, prefix: "/holes" },
  { re: /^\/columns(\/|$)/, prefix: "/columns" },
  { re: /^\/behaviors(\/|$)/, prefix: "/behaviors" },
  { re: /^\/takes(\/|$)/, prefix: "/takes" },
];

function futurePrefix(path: string): string | null {
  for (const f of FUTURE_PATTERNS) {
    if (f.re.test(path)) return f.prefix;
  }
  const spans = /^\/rooms\/\d+\/spans(\/|$)/.exec(path);
  if (spans) return path.slice(0, path.indexOf("/spans") + "/spans".length);
  const collider = /^\/props\/\d+\/collider(\/|$)/.exec(path);
  if (collider) return path.slice(0, path.indexOf("/collider") + "/collider".length);
  return null;
}

function collectPaths(node: unknown, base: string, out: Map<string, unknown>): void {
  out.set(base, node);
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectPaths(v, `${base}/${i}`, out));
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectPaths(v, `${base}/${escapePtr(k)}`, out);
    }
  }
}

function collectFutureIssues(raw: unknown): Issue[] {
  const paths = new Map<string, unknown>();
  collectPaths(raw, "", paths);
  const out: Issue[] = [];
  const seen = new Set<string>();
  for (const p of paths.keys()) {
    if (p === "") continue;
    const fp = futurePrefix(p);
    if (fp && !seen.has(fp)) {
      seen.add(fp);
      const h = futureHint(fp);
      out.push({ code: "SCHEMA_FUTURE_FIELD", stage: "schema", path: fp, msg: msg("SCHEMA_FUTURE_FIELD", { path: fp, when: h.when, instead: h.instead }) });
    }
  }
  return out;
}

interface Slot {
  priority: number;
  issue: Issue;
}

function ajvErrorPath(e: ErrorObject): string {
  if (e.keyword === "required") return `${e.instancePath}/${escapePtr(String((e.params as any).missingProperty))}`;
  if (e.keyword === "additionalProperties") return `${e.instancePath}/${escapePtr(String((e.params as any).additionalProperty))}`;
  return e.instancePath;
}

function isBranchNoise(e: ErrorObject): boolean {
  // anyOf/oneOf/if/then/else wrappers and exclusive-pair `not` are handled by code below
  return e.keyword === "anyOf" || e.keyword === "oneOf" || e.keyword === "if" || e.keyword === "then" || e.keyword === "else" || e.keyword === "not";
}

function setSlot(slots: Map<string, Slot>, path: string, priority: number, issue: Issue): void {
  const cur = slots.get(path);
  if (!cur || priority > cur.priority) slots.set(path, { priority, issue });
}

function nodeAt(raw: any, path: string): any {
  if (path === "") return raw;
  const parts = path.split("/").slice(1).map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = raw;
  for (const p of parts) {
    if (node === null || node === undefined) return undefined;
    node = Array.isArray(node) ? node[Number(p)] : node[p];
  }
  return node;
}

function exclusiveKeys(raw: any, path: string): string {
  const node = nodeAt(raw, path);
  if (!node || typeof node !== "object") return "";
  const has = (...ks: string[]) => ks.filter((k) => k in node);
  const pairs: string[][] = [
    ["shape", "circle"],
    ["at", "on"],
    ["face", "yaw"],
    ["tile", "color"],
    ["t", "m", "az"],
    ["around", "at"],
    ["around", "face"],
    ["around", "yaw"],
  ];
  for (const pair of pairs) {
    const hit = has(...pair);
    if (pair[0] === "t" ? hit.length > 1 : hit.length === pair.length && pair.every((k) => k in node)) {
      if (pair[0] === "t") return hit.join(", ");
      return pair.join(", ");
    }
  }
  // on triad fallback: list present keys
  const tri = has("t", "m", "az");
  if (tri.length > 1) return tri.join(", ");
  return "";
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function applyExclusiveAndRequired(raw: any, slots: Map<string, Slot>): void {
  const structural = new Set<string>();
  for (const [p, s] of slots) if (s.issue.code !== "SCHEMA_FUTURE_FIELD") structural.add(p);
  // F13: only an error exactly on the object blocks manual checks;
  // an unrelated child error (e.g. unknown field) must not suppress them.
  const hasErr = (objPath: string): boolean => structural.has(objPath);
  const required = (path: string) => {
    setSlot(slots, path, 3, { code: "SCHEMA_REQUIRED", stage: "schema", path, msg: msg("SCHEMA_REQUIRED", { path }) });
  };
  const exclusive = (path: string) => {
    const keys = exclusiveKeys(raw, path) || "?";
    setSlot(slots, path, 5, { code: "SCHEMA_EXCLUSIVE", stage: "schema", path, msg: msg("SCHEMA_EXCLUSIVE", { path, keys }) });
  };
  if (Array.isArray(raw?.rooms)) {
    raw.rooms.forEach((r: any, i: number) => {
      if (!isObj(r) || hasErr(`/rooms/${i}`)) return;
      if ("shape" in r && "circle" in r) exclusive(`/rooms/${i}`);
      if (!("shape" in r) && !("circle" in r)) {
        const path = `/rooms/${i}/shape`;
        setSlot(slots, path, 3, { code: "SCHEMA_REQUIRED", stage: "schema", path, msg: msg("SCHEMA_REQUIRED", { path }) });
      }
    });
  }
  for (const arr of ["openings", "props", "decals"] as const) {
    if (Array.isArray(raw?.[arr])) {
      raw[arr].forEach((o: any, i: number) => {
        if (!isObj(o) || hasErr(`/${arr}/${i}`)) return;
        if ("at" in o && "on" in o) exclusive(`/${arr}/${i}`);
        else if (!("at" in o) && !("on" in o)) {
          if (arr === "openings" || arr === "decals") required(`/${arr}/${i}/at`);
          else if (!("around" in o) && !(isObj(o.mount) && "top_of" in o.mount)) required(`/${arr}/${i}/at`);
        }
      });
    }
  }
  if (Array.isArray(raw?.decals)) {
    raw.decals.forEach((d: any, i: number) => {
      if (!isObj(d) || hasErr(`/decals/${i}`)) return;
      if ("at" in d && !("room" in d)) required(`/decals/${i}/room`);
    });
  }
  if (Array.isArray(raw?.props)) {
    raw.props.forEach((p: any, i: number) => {
      if (!isObj(p) || hasErr(`/props/${i}`)) return;
      // F14: `on` placement is allowed only with mount: wall.
      if ("on" in p && p.mount !== "wall") {
        setSlot(slots, `/props/${i}/on`, 1, { code: "SCHEMA_TYPE", stage: "schema", path: `/props/${i}/on`, msg: msg("SCHEMA_TYPE", { path: `/props/${i}/on` }) });
      }
      // F21: `y` offset only makes sense for wall-mounted props.
      if ("y" in p && p.mount !== "wall") {
        setSlot(slots, `/props/${i}/y`, 1, { code: "SCHEMA_TYPE", stage: "schema", path: `/props/${i}/y`, msg: msg("SCHEMA_TYPE", { path: `/props/${i}/y` }) });
      }
      if ("face" in p && "yaw" in p) exclusive(`/props/${i}`);
      if ("around" in p) {
        if ("at" in p || "face" in p || "yaw" in p) exclusive(`/props/${i}`);
      }
    });
  }
  if (raw?.materials && typeof raw.materials === "object") {
    for (const [k, m] of Object.entries(raw.materials as Record<string, any>)) {
      if (!isObj(m) || hasErr(`/materials/${escapePtr(k)}`)) continue;
      if ("tile" in m && "color" in m) exclusive(`/materials/${escapePtr(k)}`);
      if (!("tile" in m) && !("color" in m)) {
        const path = `/materials/${escapePtr(k)}/tile`;
        setSlot(slots, path, 3, { code: "SCHEMA_REQUIRED", stage: "schema", path, msg: msg("SCHEMA_REQUIRED", { path }) });
      }
    }
  }
  const walkOn = (node: any, base: string) => {
    if (Array.isArray(node)) node.forEach((v, i) => walkOn(v, `${base}/${i}`));
    else if (node && typeof node === "object") {
      if ("room" in node && "edge" in node && !hasErr(base)) {
        const keys = (["t", "m", "az"] as const).filter((k) => k in node);
        if (keys.length > 1) {
          setSlot(slots, base, 5, {
            code: "SCHEMA_EXCLUSIVE",
            stage: "schema",
            path: base,
            msg: msg("SCHEMA_EXCLUSIVE", { path: base, keys: keys.join(", ") }),
          });
        } else if (keys.length === 0) {
          required(`${base}/t`);
        }
      }
      for (const [k, v] of Object.entries(node)) walkOn(v, `${base}/${escapePtr(k)}`);
    }
  };
  walkOn(raw, "");
}

function codeChecks(raw: any): Array<{ path: string }> {
  const out: Array<{ path: string }> = [];
  if (Array.isArray(raw?.rooms)) {
    raw.rooms.forEach((r: any, i: number) => {
      if (Array.isArray(r?.shape)) {
        r.shape.forEach((v: any, j: number) => {
          if (Array.isArray(v) && v.length === 3 && v[2] && typeof v[2] === "object" && "bulge" in v[2]) {
            const b = (v[2] as any).bulge;
            if (typeof b === "number" && (b === 0 || Math.abs(b) > 1)) {
              out.push({ path: `/rooms/${i}/shape/${j}/2/bulge` });
            }
          }
        });
      }
      if (r?.walls && Array.isArray(r.walls.bands)) {
        let prev = -Infinity;
        let bad = false;
        for (const band of r.walls.bands) {
          const to = (band as any)?.to;
          // non-numeric `to` is already reported by ajv as SCHEMA_TYPE on its own path
          if (typeof to !== "number") continue;
          if (!(to > prev) || (typeof r.height === "number" && to > r.height)) {
            bad = true;
            break;
          }
          prev = to;
        }
        if (bad) out.push({ path: `/rooms/${i}/walls/bands` });
      }
    });
  }
  return out;
}

export function validate(raw: unknown): { scene: Scene | null; issues: Issue[] } {
  const slots = new Map<string, Slot>();
  for (const f of collectFutureIssues(raw)) setSlot(slots, f.path, 4, f);
  const futurePaths = new Set([...slots.values()].filter((s) => s.issue.code === "SCHEMA_FUTURE_FIELD").map((s) => s.issue.path));

  const ok = validateFn(raw);
  if (!ok) {
    const errors = (validateFn.errors ?? []) as ErrorObject[];
    for (const e of errors) {
      if (isBranchNoise(e)) continue;
      const path = ajvErrorPath(e);
      if (futurePaths.has(path)) continue;
      let underFuture = false;
      for (const fp of futurePaths) {
        if (path === fp || path.startsWith(fp + "/")) {
          underFuture = true;
          break;
        }
      }
      if (underFuture) continue;
      if (e.keyword === "additionalProperties") {
        const k = String((e.params as any).additionalProperty);
        setSlot(slots, path, 2, { code: "SCHEMA_UNKNOWN_FIELD", stage: "schema", path, msg: msg("SCHEMA_UNKNOWN_FIELD", { path, k }) });
      } else if (e.keyword === "required") {
        setSlot(slots, path, 3, { code: "SCHEMA_REQUIRED", stage: "schema", path, msg: msg("SCHEMA_REQUIRED", { path }) });
      } else {
        // type, minimum, maximum, exclusiveMinimum, enum, const, minItems, pattern, prefixItems, ...
        setSlot(slots, path === "" ? "/" : path, 1, {
          code: "SCHEMA_TYPE",
          stage: "schema",
          path,
          msg: msg("SCHEMA_TYPE", { path }),
        });
      }
    }
  }

  // Collapse descendants of collapsed anyOf nodes (mount/face): one SCHEMA_TYPE per node.
  // F36: a branch may also fail deeper down (a point2 element type), so drop every
  // descendant issue, SCHEMA_TYPE included, not just the direct children.
  const isCollapsedAnyOf = (p: string): boolean =>
    p.endsWith("/mount") || p.endsWith("/face") || /^\/routes\/\d+\/path\/\d+$/.test(p);
  for (const p of [...slots.keys()]) {
    for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) {
      const anc = p.slice(0, i);
      const as = slots.get(anc);
      if (as && as.issue.code === "SCHEMA_TYPE" && isCollapsedAnyOf(anc)) {
        slots.delete(p);
        break;
      }
    }
  }
  // REQUIRED under an EXCLUSIVE node is noise from the rejected branch shape.
  for (const [p, s] of [...slots]) {
    if (s.issue.code !== "SCHEMA_REQUIRED") continue;
    for (const [q, t] of slots) {
      if (t.issue.code === "SCHEMA_EXCLUSIVE" && (p === q || p.startsWith(q + "/"))) {
        slots.delete(p);
        break;
      }
    }
  }
  // F11: manual checks only on structurally clean nodes.
  applyExclusiveAndRequired(raw, slots);

  // F23: a code check at `objPath` is only noise from an already-broken ancestor;
  // errors on unrelated descendants (e.g. a sibling band's unknown field) must not suppress it.
  const hasErrAncestor = (objPath: string): boolean => {
    for (const p of slots.keys()) if (p === objPath || objPath.startsWith(p + "/")) return true;
    return false;
  };
  for (const c of codeChecks(raw)) {
    if (hasErrAncestor(c.path)) continue;
    setSlot(slots, c.path, 1, { code: "SCHEMA_TYPE", stage: "schema", path: c.path, msg: msg("SCHEMA_TYPE", { path: c.path }) });
  }

  const issues = [...slots.values()].map((s) => s.issue);

  if (ok && raw && typeof raw === "object") {
    issues.push(...checkRefs(raw as any));
  }

  // Pass raw to sortIssues so errors keep SCENE.json document order (F18).
  if (issues.length > 0) return { scene: null, issues: sortIssues(issues, raw) };

  return { scene: applyDefaults(raw as any), issues: [] };
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

export function applyDefaults(raw: any): Scene {
  const s = deepClone(raw);
  s.openings ??= [];
  s.props ??= [];
  s.decals ??= [];
  s.lights ??= [];
  s.cameras ??= [];
  s.routes ??= [];
  s.spawn.yaw ??= 0;
  s.style ??= {};
  s.style.ambient ??= 1.0;
  s.style.exterior ??= "#808080";
  for (const m of Object.values(s.materials ?? {}) as any[]) {
    if (m && typeof m === "object" && "tile" in m) m.repeat_m ??= 1.0;
  }
  for (const r of s.rooms as any[]) {
    if (r.walls && typeof r.walls === "object") r.walls.thickness ??= 0.12;
    for (const b of r.beams ?? []) {
      b.w ??= 0.2;
      b.h ??= 0.25;
    }
  }
  const openingDefaults: Record<string, { height: number; sill: number }> = {
    door: { height: 2.1, sill: 0 },
    window: { height: 1.2, sill: 0.9 },
    arch: { height: 2.1, sill: 0 },
    gap: { height: 2.1, sill: 0 },
  };
  const roomCeil = new Map<string, number>();
  for (const r of s.rooms as any[]) if (typeof r?.id === "string" && typeof r?.height === "number") roomCeil.set(r.id, r.height);
  const SNAP = 0.1;
  const ptSegDist = (p: number[], a: number[], b: number[]): number => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
  };
  // F32: a bulged edge is an arc; its chord misses the wall by the sagitta, so a
  // point that lies on the arc has to be measured against the arc itself.
  // `bulge` = sagitta / half-chord, positive = outward from the chord polygon
  // (spec "Соглашения"), so the outward normal follows the polygon winding.
  const ptArcDist = (p: number[], a: number[], b: number[], bulge: number, outSign: number): number => {
    const cx = b[0] - a[0];
    const cz = b[1] - a[1];
    const c = Math.hypot(cx, cz);
    if (c === 0 || bulge === 0) return ptSegDist(p, a, b);
    const half = c / 2;
    const sag = bulge * half;
    const R = (half * half + sag * sag) / (2 * sag);
    const nx = (outSign * cz) / c;
    const nz = (-outSign * cx) / c;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const o = [mid[0] + nx * (sag - R), mid[1] + nz * (sag - R)];
    const apex = [mid[0] + nx * sag, mid[1] + nz * sag];
    const ang = (q: number[]): number => Math.atan2(q[1] - o[1], q[0] - o[0]);
    const diff = (u: number, v: number): number => Math.abs(Math.atan2(Math.sin(u - v), Math.cos(u - v)));
    const d = Math.hypot(p[0] - o[0], p[1] - o[1]);
    if (d === 0) return Math.abs(R);
    const apexAng = ang(apex);
    if (diff(ang(p), apexAng) <= diff(ang(a), apexAng) + 1e-12) return Math.abs(d - Math.abs(R));
    return Math.min(Math.hypot(p[0] - a[0], p[1] - a[1]), Math.hypot(p[0] - b[0], p[1] - b[1]));
  };
  const roomEdges = new Map<string, Array<[number[], number[]]>>();
  const roomArcs = new Map<string, Array<{ a: number[]; b: number[]; bulge: number; outSign: number }>>();
  const roomBulges = new Map<string, number[]>();
  const roomSign = new Map<string, number>();
  // a circle room is one closed arc edge (index 0): t = 0 at az = 0 (+Z), t grows with az
  const roomCircles = new Map<string, { c: number[]; r: number }>();
  for (const r of s.rooms as any[]) {
    if (typeof r?.id === "string" && r.circle && Array.isArray(r.circle.c) && typeof r.circle.r === "number") {
      roomCircles.set(r.id, { c: r.circle.c, r: r.circle.r });
    }
    if (typeof r?.id !== "string" || !Array.isArray(r?.shape) || r.circle) continue;
    const pts = r.shape as number[][];
    const segs: Array<[number[], number[]]> = [];
    let area2 = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      area2 += a[0] * b[1] - b[0] * a[1];
    }
    const outSign = area2 >= 0 ? 1 : -1;
    const arcs: Array<{ a: number[]; b: number[]; bulge: number; outSign: number }> = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      segs.push([a, b]);
      const bulge = a.length === 3 && a[2] && typeof (a[2] as any).bulge === "number" ? (a[2] as any).bulge : 0;
      if (bulge !== 0) arcs.push({ a, b, bulge, outSign });
    }
    roomEdges.set(r.id, segs);
    roomArcs.set(r.id, arcs);
    roomBulges.set(
      r.id,
      segs.map((_, i) => {
        const v = pts[i];
        return Array.isArray(v) && v.length === 3 && v[2] && typeof (v[2] as any).bulge === "number" ? (v[2] as any).bulge : 0;
      }),
    );
    roomSign.set(r.id, outSign);
  }
  const adjacentRooms = (at: [number, number]): string[] => {
    const ids: string[] = [];
    for (const r of s.rooms as any[]) {
      if (typeof r?.id !== "string") continue;
      // F20: circle rooms have no `shape` polygon; test membership/boundary against the circle itself.
      if (r.circle && Array.isArray(r.circle.c) && typeof r.circle.r === "number") {
        const dist = Math.hypot(at[0] - r.circle.c[0], at[1] - r.circle.c[1]);
        if (dist <= r.circle.r + SNAP + 1e-9) ids.push(r.id);
        continue;
      }
      if (!Array.isArray(r?.shape)) continue;
      const pts = r.shape as number[][];
      let inside = false;
      for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
        const [xi, zi] = pts[a];
        const [xj, zj] = pts[b];
        if ((zi > at[1]) !== (zj > at[1]) && at[0] < ((xj - xi) * (at[1] - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) {
        ids.push(r.id);
        continue;
      }
      let onBoundary = false;
      for (const [a, b] of roomEdges.get(r.id) ?? []) {
        if (ptSegDist(at, a, b) <= SNAP + 1e-9) {
          onBoundary = true;
          break;
        }
      }
      if (!onBoundary) {
        for (const arc of roomArcs.get(r.id) ?? []) {
          if (ptArcDist(at, arc.a, arc.b, arc.bulge, arc.outSign) <= SNAP + 1e-9) {
            onBoundary = true;
            break;
          }
        }
      }
      if (onBoundary) ids.push(r.id);
    }
    return ids;
  };
  // F38: an `on` position is measured along the edge, which for a bulged edge is an
  // arc, not its chord. Describe the arc once (centre, radius, start angle, sweep)
  // and read both the point and the local tangent off it.
  const arcOf = (a: number[], b: number[], bulge: number, outSign: number) => {
    const cx = b[0] - a[0];
    const cz = b[1] - a[1];
    const c = Math.hypot(cx, cz);
    const half = c / 2;
    const sag = bulge * half;
    const R = (half * half + sag * sag) / (2 * sag);
    const nx = (outSign * cz) / c;
    const nz = (-outSign * cx) / c;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const o = [mid[0] + nx * (sag - R), mid[1] + nz * (sag - R)];
    const ang = (q: number[]): number => Math.atan2(q[1] - o[1], q[0] - o[0]);
    const a0 = ang(a);
    const wrap = (x: number): number => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const span = wrap(ang(b) - a0);
    // the arc is the one running through the apex, which picks the sweep's sign
    const apex = [mid[0] + nx * sag, mid[1] + nz * sag];
    const sweep = wrap(ang(apex) - a0) <= span ? span : span - 2 * Math.PI;
    return { o, R: Math.abs(R), a0, sweep, len: Math.abs(R) * Math.abs(sweep) };
  };
  const edgeBulge = (room: string, edge: number): number => roomBulges.get(room)?.[edge] ?? 0;
  // point and tangent at a fraction of the edge, straight or bulged
  const edgeAt = (room: string, edge: number, frac: number): { p: number[]; dir: number[] } | null => {
    const circ = roomCircles.get(room);
    if (circ) {
      if (edge !== 0) return null;
      const ang = Math.PI / 2 - 2 * Math.PI * frac;
      return { p: [circ.c[0] + circ.r * Math.cos(ang), circ.c[1] + circ.r * Math.sin(ang)], dir: [-Math.sin(ang), Math.cos(ang)] };
    }
    const seg = roomEdges.get(room)?.[edge];
    if (!seg) return null;
    const [a, b] = seg;
    const bulge = edgeBulge(room, edge);
    if (bulge === 0) return { p: [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac], dir: [b[0] - a[0], b[1] - a[1]] };
    const g = arcOf(a, b, bulge, roomSign.get(room) ?? 1);
    const ang = g.a0 + g.sweep * frac;
    return { p: [g.o[0] + g.R * Math.cos(ang), g.o[1] + g.R * Math.sin(ang)], dir: [-Math.sin(ang), Math.cos(ang)] };
  };
  const edgeLen = (room: string, edge: number): number => {
    const circ = roomCircles.get(room);
    if (circ) return edge === 0 ? 2 * Math.PI * circ.r : 0;
    const seg = roomEdges.get(room)?.[edge];
    if (!seg) return 0;
    const bulge = edgeBulge(room, edge);
    if (bulge === 0) return Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]);
    return arcOf(seg[0], seg[1], bulge, roomSign.get(room) ?? 1).len;
  };
  // `az` is the direction from the arc centre (0 = +Z, 90 = +X); undefined when off the arc
  const fracAtAz = (room: string, edge: number, az: number): number | undefined => {
    const wrap = (x: number): number => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const rad = (az * Math.PI) / 180;
    if (roomCircles.has(room)) return edge === 0 ? wrap(rad) / (2 * Math.PI) : undefined;
    const seg = roomEdges.get(room)?.[edge];
    const bulge = edgeBulge(room, edge);
    if (!seg || bulge === 0) return undefined;
    const g = arcOf(seg[0], seg[1], bulge, roomSign.get(room) ?? 1);
    const rel = wrap(Math.PI / 2 - rad - g.a0);
    const frac = (g.sweep >= 0 ? rel : rel - 2 * Math.PI) / g.sweep;
    return frac >= -1e-9 && frac <= 1 + 1e-9 ? Math.min(1, Math.max(0, frac)) : undefined;
  };
  const parallel = (u: number[], v: number[]): boolean => {
    const ul = Math.hypot(u[0], u[1]);
    const vl = Math.hypot(v[0], v[1]);
    return ul > 0 && vl > 0 && Math.abs(u[0] * v[1] - u[1] * v[0]) / (ul * vl) < 0.035;
  };
  // F15: only rooms adjacent along the opening's own interval count for gap height.
  const gapSides = (riding: string, ridingEdge?: number, frac?: number): string[] => {
    const sides = [riding];
    if (ridingEdge === undefined) return sides;
    const here = edgeAt(riding, ridingEdge, typeof frac === "number" ? frac : 0.5);
    if (!here) return sides;
    for (const [id, osegs] of roomEdges) {
      if (id === riding) continue;
      const sign = roomSign.get(id) ?? 1;
      for (let i = 0; i < osegs.length; i++) {
        const [a, b] = osegs[i];
        const bulge = edgeBulge(id, i);
        // the opening position itself must lie on the neighbour edge
        const dist = bulge === 0 ? ptSegDist(here.p, a, b) : ptArcDist(here.p, a, b, bulge, sign);
        if (dist > SNAP + 1e-9) continue;
        // and both edges must run the same way there, so a perpendicular touch is not a side
        const dir = bulge === 0 ? [b[0] - a[0], b[1] - a[1]] : [-(here.p[1] - arcOf(a, b, bulge, sign).o[1]), here.p[0] - arcOf(a, b, bulge, sign).o[0]];
        if (parallel(here.dir, dir)) {
          sides.push(id);
          break;
        }
      }
    }
    for (const [id, circ] of roomCircles) {
      if (id === riding) continue;
      const dx = here.p[0] - circ.c[0];
      const dz = here.p[1] - circ.c[1];
      if (Math.abs(Math.hypot(dx, dz) - circ.r) > SNAP + 1e-9) continue;
      if (parallel(here.dir, [-dz, dx])) sides.push(id);
    }
    return sides;
  };
  for (const o of s.openings as any[]) {
    const d = openingDefaults[o.kind] ?? { height: 2.1, sill: 0 };
    if (o.kind === "gap" && o.height === undefined) {
      const rooms = new Set<string>();
      if (o.on && typeof o.on.room === "string" && roomCeil.has(o.on.room)) {
        let frac: number | undefined;
        if (typeof o.on.t === "number") frac = o.on.t;
        else if (typeof o.on.m === "number" && typeof o.on.edge === "number") {
          const L = edgeLen(o.on.room, o.on.edge);
          // a circle edge is closed, so `m` wraps around its length
          if (L > 0) frac = roomCircles.has(o.on.room) ? (((o.on.m % L) + L) % L) / L : o.on.m / L;
        } else if (typeof o.on.az === "number" && typeof o.on.edge === "number") {
          frac = fracAtAz(o.on.room, o.on.edge, o.on.az);
        }
        for (const id of gapSides(o.on.room, typeof o.on.edge === "number" ? o.on.edge : undefined, frac)) rooms.add(id);
      } else if (Array.isArray(o.at)) {
        for (const id of adjacentRooms(o.at)) rooms.add(id);
      }
      const hs = [...rooms].map((id) => roomCeil.get(id)).filter((h): h is number => typeof h === "number");
      o.height = hs.length > 0 ? Math.min(...hs) : d.height;
    } else o.height ??= d.height;
    o.sill ??= d.sill;
    if (o.leaf) o.leaf.open ??= true;
  }
  for (const p of s.props as any[]) {
    p.mount ??= "floor";
    p.solid ??= true;
    if (p.mount === "wall") p.y ??= 1.0;
  }
  for (const d of s.decals as any[]) {
    d.y ??= 1.6;
  }
  for (const l of s.lights as any[]) {
    l.color ??= "#ffffff";
    l.power ??= 1.0;
  }
  for (const a of Object.values(s.assets ?? {}) as any[]) {
    a.aspect ??= "1:1";
    a.front_deg ??= 0;
  }
  for (const c of s.cameras as any[]) {
    c.fov ??= 60;
  }
  return s as Scene;
}
