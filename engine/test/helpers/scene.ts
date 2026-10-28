import { readFileSync } from "node:fs";

const flatUrl = new URL("../../../specs/examples/demo-flat.scene.json", import.meta.url);

export function demoFlat(): unknown {
  return JSON.parse(readFileSync(flatUrl, "utf-8"));
}

type Op = { op: "add" | "replace" | "remove"; path: string; value?: unknown };

function unescape(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function getParent(root: any, path: string): { parent: any; key: string } {
  const parts = path.split("/").slice(1).map(unescape);
  const key = parts.pop()!;
  let node = root;
  for (const p of parts) {
    node = Array.isArray(node) ? node[Number(p)] : node[p];
  }
  return { parent: node, key };
}

export function patched(ops: Op[]): unknown {
  const root = demoFlat() as any;
  for (const op of ops) {
    const { parent, key } = getParent(root, op.path);
    if (op.op === "remove") {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else if (op.op === "add") {
      if (Array.isArray(parent)) {
        if (key === "-") parent.push(op.value);
        else parent.splice(Number(key), 0, op.value);
      } else parent[key] = op.value;
    } else {
      if (Array.isArray(parent)) parent[Number(key)] = op.value;
      else parent[key] = op.value;
    }
  }
  return root;
}
