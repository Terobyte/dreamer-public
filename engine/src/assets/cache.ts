import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type AssetKind, promptFor } from "./templates.js";

/**
 * What the generator was actually asked for, hashed. `size` and `front_deg`
 * only scale an asset at normalization time, so editing them must not
 * regenerate it — they stay out of the key.
 */
export function cacheKey(kind: AssetKind, prompt: string, aspect?: string, ref?: { bytes: Buffer; what: string }): string {
  const base = promptFor(kind, prompt);
  let subject = kind === "object" ? base : `${base}|${aspect ?? "1:1"}`;
  // a reference picture changes what gets drawn; without one the key is the old one byte for byte
  if (ref !== undefined) subject += `|ref|${createHash("sha256").update(ref.bytes).digest("hex")}|${ref.what}`;
  return createHash("sha256").update(subject).digest("hex");
}

export interface CachePaths {
  /** tile/decal: the generated image; object: never used. */
  png: string;
  /** decal only: the image with white cut to alpha. */
  alpha: string;
  /** object only: the image SAM3D was fed. */
  src: string;
  /** object only: the mesh. */
  glb: string;
}

export function cachePaths(cacheDir: string, key: string): CachePaths {
  return {
    png: join(cacheDir, `${key}.png`),
    alpha: join(cacheDir, `${key}.alpha.png`),
    src: join(cacheDir, `${key}.src.png`),
    glb: join(cacheDir, `${key}.glb`),
  };
}

export interface LedgerEntry {
  t: string;
  kind: AssetKind;
  key: string;
  cents: number;
}

/** One line per attempt, failed attempts included: the money trail. */
export function appendLedger(cacheDir: string, entry: LedgerEntry): void {
  appendFileSync(join(cacheDir, "ledger.jsonl"), `${JSON.stringify(entry)}\n`);
}
