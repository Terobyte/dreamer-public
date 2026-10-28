import type { Issue } from "../types.js";
import { msg } from "../report/messages.js";

export const EPS = 1e-6;

export function parseScene(text: string): { raw: unknown | null; issues: Issue[] } {
  try {
    return { raw: JSON.parse(text), issues: [] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // only V8's trailing location counts: the quoted input excerpt may itself contain "position N"
    const m = /\bin JSON at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(message);
    const own = firstErrorOffset(text);
    const pos = m ? Number(m[1]) : own >= 0 ? own : text.length;
    const { line, col } = lineCol(text, pos);
    return {
      raw: null,
      issues: [
        {
          code: "SCHEMA_PARSE",
          stage: "schema",
          path: "",
          msg: msg("SCHEMA_PARSE", { L: String(line), C: String(col), reason: message }),
        },
      ],
    };
  }
}

// F33: V8 drops the `position N` suffix for short inputs ("… is not valid JSON"),
// so locate the first syntax error ourselves instead of blaming line 1.
function firstErrorOffset(text: string): number {
  let i = 0;
  let bad = -1;
  const fail = (): false => {
    if (bad < 0) bad = i;
    return false;
  };
  const ws = (): void => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const lit = (word: string): boolean => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return true;
    }
    // F34: input that merely stops short of the keyword is incomplete, so the
    // error belongs at the end of input, not at the keyword's first character.
    if (word.startsWith(text.slice(i))) i = text.length;
    return fail();
  };
  const str = (): boolean => {
    if (text[i] !== '"') return fail();
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i++;
        return true;
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n") return fail();
      i++;
    }
    return fail();
  };
  const num = (): boolean => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!m) return fail();
    i += m[0].length;
    return true;
  };
  const value = (): boolean => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") {
        i++;
        return true;
      }
      for (;;) {
        ws();
        if (!str()) return false;
        ws();
        if (text[i] !== ":") return fail();
        i++;
        if (!value()) return false;
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return true;
        }
        return fail();
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return true;
      }
      for (;;) {
        if (!value()) return false;
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return true;
        }
        return fail();
      }
    }
    if (c === '"') return str();
    if (c === "t") return lit("true");
    if (c === "f") return lit("false");
    if (c === "n") return lit("null");
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return num();
    return fail();
  };
  if (value()) {
    ws();
    if (i < text.length) fail();
  }
  return bad;
}

// F35: JSON whitespace includes a bare CR, which is also a line break; CRLF is one.
function lineCol(text: string, pos: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  const end = Math.min(pos, text.length);
  for (let i = 0; i < end; i++) {
    const c = text[i];
    if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      line++;
      col = 1;
    } else if (c === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}
