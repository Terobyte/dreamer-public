export interface CatSize {
  w: number;
  d: number;
  h: number;
  /** upper bound for h outside the ×1.6 tolerance (chair: tall backs) */
  hMax?: number;
}

/** Plausible sizes per `cat` (spec "Формат SCENE.json"), tolerance ×0.5…×1.6. */
export const CATS: Record<string, CatSize> = {
  sofa: { w: 2.0, d: 0.9, h: 0.85 },
  armchair: { w: 0.85, d: 0.85, h: 1.0 },
  chair: { w: 0.5, d: 0.5, h: 0.95, hMax: 1.6 },
  table: { w: 1.2, d: 0.8, h: 0.75 },
  bed: { w: 1.6, d: 2.0, h: 0.6 },
  shelf: { w: 1.0, d: 0.35, h: 1.8 },
  lamp: { w: 0.4, d: 0.4, h: 0.5 },
  vase: { w: 0.25, d: 0.25, h: 0.4 },
  plant: { w: 0.5, d: 0.5, h: 1.0 },
  tv: { w: 1.2, d: 0.08, h: 0.7 },
};
