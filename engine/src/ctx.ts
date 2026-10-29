import type { PropFact } from "./props/fact.js";
import type { DecalGeo, LevelPlan, NavJson, OpeningGeo, Passport, PropGeo, RoomGeo, Scene } from "./types.js";

export interface Ctx {
  scene: Scene;
  rooms?: RoomGeo[];
  levels?: Map<string, LevelPlan>;
  openings?: OpeningGeo[];
  graph?: Map<string, string[]>;
  props?: PropGeo[];
  decals?: DecalGeo[];
  nav?: NavJson;
  /** measured prop bounds from a built `dist/` (`check --built`) */
  facts?: Record<string, PropFact | null>;
  passport: Passport;
}
