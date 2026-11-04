"""Reference frames -> labelled contact sheets (Spark sees many frames in few pictures)."""
from pathlib import Path

from PIL import Image, ImageDraw

from .topview import FONT


def frames(refs: Path):
    return sorted(p for p in refs.iterdir() if p.suffix.lower() in (".png", ".jpg", ".jpeg"))


def make(refs: Path, out: Path, per=6, w=512):
    out.mkdir(parents=True, exist_ok=True)
    fs = frames(refs)
    sheets = []
    for k in range(0, len(fs), per):
        group = fs[k:k + per]
        thumbs = []
        for f in group:
            im = Image.open(f).convert("RGB")
            im = im.resize((w, int(im.height * w / im.width)))
            thumbs.append((f.name, im))
        h = max(t.height for _, t in thumbs)
        cols = 3
        rows = (len(thumbs) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * w, rows * (h + 22)), "white")
        d = ImageDraw.Draw(sheet)
        for i, (name, t) in enumerate(thumbs):
            x, y = (i % cols) * w, (i // cols) * (h + 22)
            sheet.paste(t, (x, y + 22))
            d.text((x + 4, y + 3), name, fill="black", font=FONT)
        p = out / f"sheet_{k // per:02d}.jpg"
        sheet.save(p, quality=88)
        sheets.append((p, [n for n, _ in thumbs]))
    return sheets
