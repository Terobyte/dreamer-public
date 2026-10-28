import type { Path64 } from "clipper2-ts";
import type { Ctx } from "../ctx.js";
import type { DecalGeo, PropGeo } from "../types.js";
import type { V2 } from "../geom/vec.js";
import { obbCorners } from "../geom/obb.js";
import type { AuthorEdge } from "../props/place.js";
import { edgeNormal, edgePoint } from "../props/place.js";
import { round3 } from "./report.js";

/** pixels per metre: X to the right, Z down */
const S = 40;
/** viewBox margin around the floors, in metres */
const MARGIN = 0.5;
/** edge labels sit this far inside the room */
const LABEL_IN = 0.35;

function f(x: number): string {
  const v = round3(x);
  return Object.is(v, -0) ? "0" : String(v);
}

function pts(poly: V2[]): string {
  return poly.map((p) => `${f(p[0] * S)},${f(p[1] * S)}`).join(" ");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pathToPoly(path: Path64): V2[] {
  return path.map((p) => [p.x / 1000, p.y / 1000] as V2);
}

function centroid(poly: V2[]): V2 {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p[0];
    z += p[1];
  }
  const n = poly.length || 1;
  return [x / n, z / n];
}

export function topSvg(ctx: Ctx): string {
  const scene = ctx.scene as any;
  const rooms = (ctx.rooms ?? []) as Array<{ id: string; level: string; outline: V2[]; edges: AuthorEdge[] }>;
  const openings = ((ctx.openings ?? []) as any[]).filter((g) => g && !g.error);
  const props = (ctx.props ?? []) as PropGeo[];
  const decals = ((ctx.decals ?? []) as DecalGeo[]).filter((d) => !d.noWall);
  const cameras: any[] = scene.cameras ?? [];

  let lo: V2 = [Infinity, Infinity];
  let hi: V2 = [-Infinity, -Infinity];
  for (const r of rooms) {
    for (const p of r.outline) {
      lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
      hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
    }
  }
  if (!Number.isFinite(lo[0])) {
    lo = [0, 0];
    hi = [0, 0];
  }
  const vx = (lo[0] - MARGIN) * S;
  const vy = (lo[1] - MARGIN) * S;
  const vw = (hi[0] - lo[0] + 2 * MARGIN) * S;
  const vh = (hi[1] - lo[1] + 2 * MARGIN) * S;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(vx)} ${f(vy)} ${f(vw)} ${f(vh)}" ` +
      `width="${f(vw)}" height="${f(vh)}">`,
  );

  out.push(`<g class="floors" fill="#e8e4d8" stroke="#b0aca0" stroke-width="0.5">`);
  for (const r of rooms) out.push(`<polygon class="floor" data-id="${esc(r.id)}" points="${pts(r.outline)}"/>`);
  out.push(`</g>`);

  out.push(`<g class="body" fill="#6b6b60" stroke="none">`);
  for (const [levelId, plan] of ctx.levels ?? new Map()) {
    const paths = (plan.body ?? []) as Path64[];
    for (let k = 0; k < paths.length; k++) {
      out.push(
        `<polygon class="body" data-id="${esc(String(levelId))}.wall.${k}" points="${pts(pathToPoly(paths[k]))}"/>`,
      );
    }
  }
  out.push(`</g>`);

  out.push(`<g class="openings" fill="none" stroke="#2b7fd4" stroke-width="1">`);
  for (const g of openings) {
    if (Array.isArray(g.corridor) && g.corridor.length > 0) {
      out.push(`<polygon class="corridor" data-id="${esc(String(g.id))}" points="${pts(g.corridor)}"/>`);
    }
    if (Array.isArray(g.sector) && g.sector.length > 0) {
      out.push(`<polygon class="sector" data-id="${esc(String(g.id))}" points="${pts(g.sector)}"/>`);
    }
  }
  out.push(`</g>`);

  out.push(`<g class="props" fill="none" stroke="#b03a2e" stroke-width="1">`);
  for (const p of props) {
    out.push(`<polygon class="prop" data-id="${esc(p.id)}" points="${pts(obbCorners(p.obb))}"/>`);
  }
  out.push(`</g>`);

  out.push(`<g class="decals" stroke="#7b2fbe" stroke-width="2">`);
  for (const d of decals) {
    const t: V2 = [-d.normal[1], d.normal[0]];
    const a: V2 = [d.center[0] - t[0] * (d.w / 2), d.center[2] - t[1] * (d.w / 2)];
    const b: V2 = [d.center[0] + t[0] * (d.w / 2), d.center[2] + t[1] * (d.w / 2)];
    out.push(
      `<line class="decal" data-id="decal.${d.i}" x1="${f(a[0] * S)}" y1="${f(a[1] * S)}" ` +
        `x2="${f(b[0] * S)}" y2="${f(b[1] * S)}"/>`,
    );
  }
  out.push(`</g>`);

  out.push(`<g class="cameras" fill="#1d7a46" stroke="none">`);
  for (let i = 0; i < cameras.length; i++) {
    const cam = cameras[i];
    if (!Array.isArray(cam?.pos)) continue;
    out.push(
      `<circle class="camera" data-id="${esc(String(cam.id ?? i))}" ` +
        `cx="${f(cam.pos[0] * S)}" cy="${f(cam.pos[2] * S)}" r="4"/>`,
    );
  }
  out.push(`</g>`);

  out.push(`<g class="labels" font-family="monospace" font-size="10" fill="#202020">`);
  for (const r of rooms) {
    const c = centroid(r.outline);
    out.push(`<text class="room" data-id="${esc(r.id)}" x="${f(c[0] * S)}" y="${f(c[1] * S)}">${esc(r.id)}</text>`);
  }
  for (const r of rooms) {
    for (const e of r.edges) {
      const q = edgePoint(e, 0.5);
      const n = edgeNormal(e, q);
      const x = q[0] + n[0] * LABEL_IN;
      const z = q[1] + n[1] * LABEL_IN;
      const id = `${r.id}#${e.i}`;
      out.push(`<text class="edge" data-id="${esc(id)}" x="${f(x * S)}" y="${f(z * S)}">${esc(id)}</text>`);
    }
  }
  for (const g of openings) {
    const id = String(g.id);
    out.push(
      `<text class="opening" data-id="${esc(id)}" x="${f(g.center[0] * S)}" y="${f(g.center[1] * S)}">${esc(id)}</text>`,
    );
  }
  for (const p of props) {
    out.push(
      `<text class="prop" data-id="${esc(p.id)}" x="${f(p.obb.c[0] * S)}" y="${f(p.obb.c[1] * S)}">${esc(p.id)}</text>`,
    );
  }
  out.push(`</g>`);
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}
