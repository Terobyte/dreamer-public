// Camera catalogue for the shot planner (lane B): `node --import tsx bin/moves.ts --catalog`.
// Everything is read from the runtime tables; nothing is copied here.
import { MOVES, SCHEMES, RECORDS } from "../src/runtime/stage/moves.js";
import { STYLES } from "../src/runtime/stage/styles.js";

const meanings = (t: Record<string, { meaning: string }>): Record<string, string> => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.meaning]));

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--catalog") {
  process.stderr.write("usage: node --import tsx bin/moves.ts --catalog\n");
  process.exit(2);
}
const catalog = {
  styles: Object.keys(STYLES),
  moves: meanings(MOVES as any),
  schemes: meanings(SCHEMES),
  records: meanings(RECORDS),
  weights: Object.fromEntries(Object.entries(STYLES).map(([k, s]) => [k, s.weights])),
};
process.stdout.write(JSON.stringify(catalog, null, 2) + "\n");
