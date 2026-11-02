// The fields of a sim event that bin/record.mjs keeps in events.json (Г8: `beat`, the score beat index, for the shot plan).
// Self-contained: record.mjs inlines this function's text into the page (addInitScript), so no imports or outer names here.
export function pickEvent(e) {
  return { type: e.type, who: e.who, text: e.text, audio: e.audio, dur: e.dur, beat: e.beat };
}
