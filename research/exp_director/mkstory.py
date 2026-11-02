import json, sys
from pathlib import Path
src = Path("/Users/terobyte/Desktop/Projects/Active/anymove/runs/koshakan/demo/story.js").read_text()
spark = json.loads(Path(sys.argv[1]).read_text())
inj = f"""
const SPARK = {json.dumps(spark)};
const conv = (s) => s.walk ? walk(s.walk, s.a, s.b, {{ at: s.at, y: s.y ?? 0, ...(s.yaw1 !== undefined ? {{ yaw1: s.yaw1 }} : {{}}), ...(s.xf ? {{ xf: s.xf }} : {{}}) }}) : s;
bedroom.actors = Object.fromEntries(Object.entries(SPARK.actors).map(([k, v]) => [k, {{ segs: v.segs.map(conv) }}]));
bedroom.shots = SPARK.shots;
"""
i = src.index("export default")
Path(sys.argv[2]).write_text(src[:i] + inj + src[i:])
