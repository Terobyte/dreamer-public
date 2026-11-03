import type { OBB } from "./geom/obb.js";

export type Stage =
  | "schema"
  | "plan"
  | "openings"
  | "stairs"
  | "props"
  | "decals"
  | "cameras"
  | "nav"
  | "routes"
  | "assets";

export type Code =
  | "SCHEMA_PARSE"
  | "SCHEMA_UNKNOWN_FIELD"
  | "SCHEMA_FUTURE_FIELD"
  | "SCHEMA_TYPE"
  | "SCHEMA_REQUIRED"
  | "SCHEMA_EXCLUSIVE"
  | "ID_DUPLICATE"
  | "ID_RESERVED"
  | "REF_UNKNOWN"
  | "REF_KIND"
  | "ROOM_REF_MISMATCH"
  | "POS_INVALID"
  | "ROOM_SELF_INTERSECT"
  | "ROOMS_OVERLAP"
  | "EDGES_DRIFT"
  | "ROOM_LOOKS_OUTDOOR"
  | "WALL_HEIGHT_MISMATCH"
  | "ASSET_FAILED"
  | "OPENING_NO_WALL"
  | "OPENING_OFF_EDGE"
  | "OPENING_OVERLAP"
  | "OPENING_TOO_HIGH"
  | "OPENING_NO_OUTSIDE"
  | "ROOM_UNREACHABLE"
  | "STAIR_EXIT_OUTSIDE"
  | "STAIR_HEADROOM"
  | "PROP_HITS_WALL"
  | "PROP_HITS_PROP"
  | "PROP_IN_DOORWAY"
  | "PROP_IN_SWING"
  | "PROP_OUTSIDE_ROOM"
  | "PROP_NO_FACING"
  | "PROP_ON_TOO_SMALL"
  | "PROP_CEILING_LOW"
  | "PROP_ABOVE_CEILING"
  | "PROP_WALL_NOT_FOUND"
  | "PROP_SIZE_ODD"
  | "FACE_ROOM_FAR"
  | "DECAL_OFF_WALL"
  | "DECAL_ON_OPENING"
  | "DECAL_OVERLAP"
  | "DECAL_HIDDEN"
  | "CAMERA_OUTSIDE"
  | "NAV_SPAWN_BLOCKED"
  | "NAV_ROOM_CUT"
  | "ROUTE_BLOCKED"
  | "TRI_PROP_BUDGET"
  | "TRI_SCENE_BUDGET"
  | "CAMERA_NO_REF"
  | "SHOT_MISSING"
  | "ASSET_MISSING"
  | "POINT_LIGHT_BUDGET";

export interface Issue {
  code: Code;
  stage: Stage;
  path: string;
  msg: string;
  copy?: number;
  fix?: Record<string, unknown>;
  /** numbers behind the message (budget checks) */
  data?: Record<string, unknown>;
}

export interface StageStatus {
  stage: Stage;
  status: "pass" | "fail" | "skipped";
}

export interface Passport {
  edges: unknown[];
  snaps: unknown[];
  openings: unknown[];
  props: unknown[];
  decals: unknown[];
  /** only present when the scene has stairs (spec "Лестницы") */
  stairs?: unknown[];
}

export interface Report {
  ok: boolean;
  stages: StageStatus[];
  passport: Passport;
  errors: Issue[];
  warnings: Issue[];
  /** only from the second `check` into the same `--report` path on */
  diff?: { fixed: Issue[]; new: Issue[] };
}

export type Scene = Record<string, any>;
export type RoomGeo = Record<string, any>;
export type LevelPlan = Record<string, any>;
export type OpeningGeo = Record<string, any>;
export interface PropGeo {
  id: string;
  src: number;
  copy?: number;
  room: string;
  obb: OBB;
  y: [number, number];
  wall: string | null;
  solid: boolean;
  size: { w: number; d: number; h: number };
}
export type DecalGeo = Record<string, any>;
export type NavJson = Record<string, any>;
