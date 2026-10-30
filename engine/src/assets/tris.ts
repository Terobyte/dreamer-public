import { readGlb } from "./glb.js";

/** Triangles for one primitive count: TRIANGLES take count/3, strips and fans take count-2, the rest draw no triangles. */
function primTris(mode: unknown, count: number): number {
  const m = mode === undefined ? 4 : mode;
  if (m === 4) return Math.floor(count / 3);
  if (m === 5 || m === 6) return Math.max(0, count - 2);
  return 0;
}

/** Node indices reachable from the active scene's roots. */
function reachableNodes(json: ReturnType<typeof readGlb>["json"]): Set<number> {
  const nodes = json.nodes ?? [];
  const scenes = json.scenes ?? [];
  const active = scenes[json.scene ?? 0];
  if (active === undefined) return new Set(nodes.map((_, i) => i));
  const seen = new Set<number>();
  const walk = (i: number): void => {
    if (seen.has(i) || nodes[i] === undefined) return;
    seen.add(i);
    for (const c of nodes[i].children ?? []) walk(c);
  };
  for (const r of active.nodes ?? []) walk(r);
  return seen;
}

/** Triangles in a GLB: every primitive once per reachable node that draws its mesh. */
export function glbTriangles(buf: Buffer): number {
  const { json } = readGlb(buf);
  const acc = json.accessors ?? [];
  const meshTris = (json.meshes ?? []).map((m) =>
    m.primitives.reduce((s, p) => {
      const idx = (p as any).indices;
      const n = idx !== undefined ? (acc[idx] as any)?.count : (acc[p.attributes.POSITION] as any)?.count;
      return s + primTris((p as any).mode, typeof n === "number" ? n : 0);
    }, 0),
  );
  const seen = reachableNodes(json);
  const uses = new Array<number>(meshTris.length).fill(0);
  for (const i of seen) {
    const mesh = json.nodes?.[i]?.mesh;
    if (mesh !== undefined && mesh in uses) uses[mesh]++;
  }
  return meshTris.reduce((s, t, i) => s + t * Math.max(uses[i], 0), 0);
}
