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
      return `${params.path}: неверный тип или диапазон`;
    case "SCHEMA_REQUIRED":
      return `${params.path}: отсутствует обязательное поле`;
    case "SCHEMA_EXCLUSIVE":
      return `${params.path}: взаимоисключающие поля ${params.keys}`;
    case "ID_DUPLICATE":
      return `дублирующийся id "${params.v}"`;
    case "REF_UNKNOWN":
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
    default:
      return `${params.path ?? ""}: ${code}`;
  }
}
