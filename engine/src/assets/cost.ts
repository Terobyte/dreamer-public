import type { AssetKind } from "./templates.js";

/**
 * The whole price list, in whole cents. Money is never a float: a cap of
 * $0.85 has to compare exactly equal to 85 ¢, and 0.85 * 100 does not.
 */
export const IMAGE_CENTS = 1;
export const MESH_CENTS = 15;

/** An object costs its reference image plus the mesh made from it. */
export function priceCents(kind: AssetKind): number {
  return kind === "object" ? IMAGE_CENTS + MESH_CENTS : IMAGE_CENTS;
}

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function totalCents(refs: { kind: AssetKind }[]): number {
  return refs.reduce((sum, r) => sum + priceCents(r.kind), 0);
}

/** Thrown before the first paid call, never during one. */
export class CapError extends Error {
  constructor(
    readonly needCents: number,
    readonly capCents: number,
  ) {
    super(`assets: live needs ${needCents} cents, --max-dollars allows ${capCents}`);
    this.name = "CapError";
  }
}

/**
 * The running tab. Every attempt is charged before it is made, so a failed
 * call costs the same as a good one and the cap can never be overrun.
 */
export class Budget {
  private spentCents = 0;

  constructor(readonly capCents: number) {}

  get spent(): number {
    return this.spentCents;
  }

  /** Books `cents` if they fit; false means the batch has to stop here. */
  take(cents: number): boolean {
    if (this.spentCents + cents > this.capCents) return false;
    this.spentCents += cents;
    return true;
  }
}
