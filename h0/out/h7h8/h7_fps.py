"""H7: fps of the IWSDK scene per splat set, flat and inside the IWER (emulated Quest 3) XR session."""
import json
import sys
import time

from playwright.sync_api import sync_playwright

URL = "https://localhost:8081/"
CONFIGS = sys.argv[1].split(";") if len(sys.argv) > 1 else [
    "none", "09_squidward", "pineapple_house", "pineapple_house,squidward_house", "",
]
OUT = sys.argv[2] if len(sys.argv) > 2 else None


def sample(page, secs=8):
    vals = []
    for _ in range(secs):
        time.sleep(1)
        vals.append(page.evaluate("({...window.__splats})"))
    return vals


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=False,
                          args=["--ignore-certificate-errors", "--window-size=1280,800"])
    ctx = b.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 800})
    res = []
    for cfg in CONFIGS:
        page = ctx.new_page()
        page.goto(URL + "?" + cfg)
        page.wait_for_function("window.__splats !== undefined", timeout=60000)
        from urllib.parse import parse_qs
        sp = parse_qs(cfg).get("splats", [""])[0]
        want = 0 if sp == "none" else (len(sp.split(",")) if sp else 4)
        page.wait_for_function(f"window.__splats.loaded >= {want}", timeout=120000)
        time.sleep(3)
        flat = sample(page)
        xr = None
        btn = page.get_by_text("Enter XR")
        if btn.count():
            btn.first.click()
            time.sleep(4)
            xr = sample(page)
            if OUT:
                page.screenshot(path=f"{OUT}/h7_xr_{len(res)}.png")
        r = {"cfg": cfg or "all", "splats": flat[-1]["splats"],
             "flat_fps": [v["fps"] for v in flat], "flat_p95": [v["p95ms"] for v in flat],
             "xr_fps": [v["fps"] for v in xr] if xr else None, "xr_p95": [v["p95ms"] for v in xr] if xr else None}
        print(json.dumps(r), flush=True)
        res.append(r)
        page.close()
    b.close()
