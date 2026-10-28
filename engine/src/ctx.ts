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
  passport: Passport;
}
