import type { Code } from "../types.js";

function nearestField(got: string, known: string[]): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const k of known) {
    const d = levenshtein(got, k);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return bestD <= 2 ? best : null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

const KNOWN_FIELDS = (
  "version name spawn room at yaw style ambient exterior materials tile color repeat_m " +
  "levels id y rooms level height shape circle c r floor ceiling walls material thickness bands to edges " +
  "beams from w h openings kind width on edge t m az height sill leaf decal open swing hinge glass " +
  "outside backdrop props asset cat size d mount top_of face around center n start solid decals lights " +
  "pos power assets prompt aspect front_deg cameras ref look fov routes path"
).split(" ");

export function suggestField(got: string): string | null {
  return nearestField(got, KNOWN_FIELDS);
}

export function futureHint(path: string): { when: string; instead: string } {
  if (/^\/(walls|fixtures)(\/|$)/.test(path)) return { when: "в фазе 2", instead: "опиши как props" };
  if (/^\/stairs(\/|$)/.test(path)) return { when: "в фазе 5", instead: "убери, второй уровень — отдельной сценой" };
  if (/spans/.test(path) || /^\/(shafts|holes|columns)(\/|$)/.test(path) || /\/collider(\/|$)/.test(path)) {
    return { when: "в v0.2", instead: "убери поле" };
  }
  return { when: "в v1", instead: "убери поле" };
}

export function msg(code: Code, params: Record<string, string>): string {
  switch (code) {
    case "SCHEMA_PARSE":
      return `JSON не разобран: строка ${params.L}, столбец ${params.C}: ${params.reason}. Комментарии и висящие запятые запрещены`;
    case "SCHEMA_UNKNOWN_FIELD": {
      const near = suggestField(params.k);
      return `${params.path}: неизвестное поле ${params.k}${near ? `; возможно ${near}` : ""}`;
    }
    case "SCHEMA_FUTURE_FIELD":
      return `${params.path}: поле появится ${params.when}; сейчас ${params.instead}`;
    case "SCHEMA_TYPE":
      if (params.id !== undefined) return `${params.path}: id "${params.id}" — только латиница, цифры, _ и -`;
      return `${params.path}: неверный тип или диапазон`;
    case "SCHEMA_REQUIRED":
      return `${params.path}: отсутствует обязательное поле`;
    case "SCHEMA_EXCLUSIVE":
      return `${params.path}: взаимоисключающие поля ${params.keys}`;
    case "ID_DUPLICATE":
      return `дублирующийся id "${params.v}"`;
    case "REF_UNKNOWN":
      if (params.cycle) return `${params.path}: цикл top_of: ${params.cycle}; убери одну из опор`;
      return `${params.path}: ${params.kind} "${params.v}" не найден; есть: ${params.have}`;
    case "REF_KIND":
      return `${params.path}: ассет "${params.v}" имеет kind ${params.got}, нужен ${params.want}`;
    case "ROOM_REF_MISMATCH":
      return `${params.path}: room "${params.a}" != on.room "${params.b}"`;
    case "POS_INVALID":
      return `${params.path}: неверная позиция`;
    case "ROOMS_OVERLAP":
      return `${params.a} и ${params.b} пересекаются на ${params.S} м²`;
    case "EDGES_DRIFT":
      return `${params.a} и ${params.b} разошлись на ${params.d} м`;
    case "ROOM_SELF_INTERSECT":
      return `${params.path}: контур комнаты "${params.room ?? "?"}" самопересекается (рёбра ${params.edges ?? "?"})`;
    case "OPENING_NO_WALL":
      return `${params.id}: ближайшая стена ${params.at} в ${params.d} м (нужно < 0.10)`;
    case "OPENING_OFF_EDGE":
      return `${params.id}: [${params.m0}, ${params.m1}] вне интервала ${params.edge} [${params.a}, ${params.b}]`;
    case "OPENING_OVERLAP":
      return `${params.id}: пересекает ${params.other} на ${params.edge}`;
    case "OPENING_TOO_HIGH":
      return `${params.id}: sill + height ${params.v} > потолок ${params.room} ${params.h}`;
    case "OPENING_NO_OUTSIDE":
      return `${params.id}: за проёмом нет комнаты (${params.edge}), нужен outside`;
    case "PROP_HITS_WALL":
      return `${params.id} заходит в стену ${params.edge} на ${params.d} м`;
    case "PROP_HITS_PROP":
      return `${params.id} входит в ${params.other} на ${params.d} м`;
    case "PROP_IN_DOORWAY":
      return `${params.id} в коридоре ${params.opening}`;
    case "PROP_IN_SWING":
      return `${params.id} в секторе ${params.opening}`;
    case "PROP_OUTSIDE_ROOM":
      return `${params.id}: центр (${params.x}, ${params.z}) вне ${params.room}${
        params.other ? `; он в ${params.other}` : "; он вне всех комнат"
      }`;
    case "PROP_NO_FACING":
      return `${params.id}: нужен face или yaw`;
    case "PROP_ON_TOO_SMALL":
      return `${params.id}: след ${params.w} × ${params.d} м не лежит на опоре ${params.other} ${params.sw} × ${params.sd} м`;
    case "PROP_CEILING_LOW":
      return `${params.id}: низ ${params.y0} м < ${params.min}`;
    case "PROP_ABOVE_CEILING":
      return `${params.id}: верх ${params.y1} м выше потолка ${params.room} ${params.h} м на ${params.d} м`;
    case "PROP_WALL_NOT_FOUND":
      return `${params.id}: ближайшая стена ${params.edge} в ${params.d} м (нужно < ${params.need})`;
    case "PROP_SIZE_ODD":
      return `${params.id}: размер не похож на ${params.cat}: ${params.bad}`;
    case "FACE_ROOM_FAR":
      return `${params.id}: от at до внутренней грани ${params.edge} ${params.d} м (> ${params.max}); задай yaw или точку`;
    case "ROOM_UNREACHABLE":
      return `${params.room}: комната недостижима из spawn`;
    case "DECAL_OFF_WALL":
      if (params.kind === "y") {
        return `decal.${params.i} на ${params.edge}: y [${params.y0}, ${params.y1}] вне [0, ${params.h}]`;
      }
      if (params.kind === "m") {
        return `decal.${params.i}: m [${params.m0}, ${params.m1}] вне интервала ${params.edge} [${params.a}, ${params.b}]`;
      }
      return `decal.${params.i}: ближайшая стена ${params.edge} в ${params.d} м (нужно < 0.10)`;
    case "DECAL_ON_OPENING":
      return `decal.${params.i} на ${params.edge}: попадает на проём ${params.opening}`;
    case "DECAL_OVERLAP":
      return `decal.${params.i} на ${params.edge}: пересекает decal.${params.other}`;
    case "DECAL_HIDDEN":
      return `decal.${params.i} на ${params.edge}: закрыта предметом ${params.id} в ${params.d} м от грани (нужно ≥ 0.15)`;
    case "ROUTE_BLOCKED":
      return `${params.route}: застрял в (${params.x}, ${params.z}) по пути к ${params.target}; мешает ${params.what}`;
    case "NAV_SPAWN_BLOCKED":
      return `spawn в ${params.what}`;
    case "NAV_ROOM_CUT":
      return `${params.room}: капсула r ${params.r} м не проходит в комнату из spawn`;
    case "CAMERA_OUTSIDE":
      if (params.kind === "y") {
        return `камера ${params.id}: y ${params.y} вне [${params.a}, ${params.b}] комнаты ${params.room}`;
      }
      if (params.kind === "in") {
        return `камера ${params.id}: pos (${params.x}, ${params.y}, ${params.z}) внутри ${params.what}`;
      }
      return `камера ${params.id}: pos (${params.x}, ${params.y}, ${params.z}) вне всех комнат`;
    default:
      return `${params.path ?? ""}: ${code}`;
  }
}
