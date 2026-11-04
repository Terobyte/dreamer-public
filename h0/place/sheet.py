"""ref | result sheet: each Street View frame next to the engine shot from the same pano and heading."""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

from .topview import FONT


def make(run: Path, refs: Path, out: Path, ids=None, w=480):
    views = json.loads((run / "views.json").read_text())
    shots = run / "world" / "dist" / "shots"
    rows = [v for v in views if (shots / f"{v['id']}.png").exists() and (ids is None or v["id"] in ids)]
    h = int(w * 9 / 16)
    sheet = Image.new("RGB", (2 * w, len(rows) * (h + 20)), "white")
    d = ImageDraw.Draw(sheet)
    for i, v in enumerate(rows):
        y = i * (h + 20)
        a = Image.open(refs / v["ref"]).convert("RGB")
        a = a.resize((w, int(a.height * w / a.width))).crop((0, 0, w, h))
        b = Image.open(shots / f"{v['id']}.png").convert("RGB").resize((w, h))
        sheet.paste(a, (0, y + 20)); sheet.paste(b, (w, y + 20))
        d.text((4, y + 2), f"{v['id']}  Street View | engine", fill="black", font=FONT)
    sheet.save(out, quality=88)
    return out


if __name__ == "__main__":
    run = Path(sys.argv[1]); refs = Path(sys.argv[2]).expanduser()
    ids = sys.argv[4].split(",") if len(sys.argv) > 4 else None
    print(make(run, refs, Path(sys.argv[3]), ids))
