"""H16: an interior is a Muse Image panorama projected onto a room-sized box, not onto a far sphere.

Projection: every box fragment samples the panorama along the ray from the capture point (room centre, eye
height) to itself. From the capture point the room looks exactly like the panorama; when the player steps away,
walls, floor and ceiling stay where the painting put them (planar parallax), only furniture painted into the
walls smears. The question is whether that smear and the box corners stay acceptable within a ~1 m step.
Shots from out/h16/view.html: centre, 1 m steps, a corner, per room and per box size.
usage: python h16_room.py            (generates missing panoramas, then shots)
"""
import base64
import io
import json
import os
import subprocess
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

API = "https://api.meta.ai/v1/images/generations"
OUT = Path(__file__).parent / "out" / "h16"
ROOT = Path(__file__).parent.parent

ROOM = ("Equirectangular 360 degree panorama, 2:1, of a room interior, taken from the exact centre of the room at "
        "eye height. All four walls, the floor and the ceiling are visible; walls are flat and straight, corners "
        "are clear vertical lines; furniture stands against the walls, the middle of the floor is empty. "
        "Horizon exactly at the vertical middle, no people, no text. ")
JOBS = {
    # SpongeBob places are test-only (never in the submission)
    "room_squid": ROOM + "A small cartoon living room inside a stone tiki-head house under the sea: teal walls, "
                         "a round porthole window, a clarinet on a stand, a self-portrait on the wall, a stiff "
                         "armchair, a bookshelf, a rug.",
    "room_flat": ROOM + "An ordinary small city apartment living room, about 4 by 5 meters: beige walls, a window "
                        "with curtains, a grey sofa, a TV on a low cabinet, a bookshelf, a floor lamp, wooden floor.",
}
# (room, width x depth x height in metres): the painting has no scale, so the box size is a guess to compare
SHOTS = [("room_flat", 4, 5, 2.7), ("room_flat", 6, 7, 3.0), ("room_squid", 4, 4, 2.7)]
# (name, x, z, yaw, pitch): camera offset from the capture point, eye height stays 1.6
VIEWS = [("c0", 0, 0, 0, 0), ("c90", 0, 0, 90, 0), ("step_fwd", 0, -1, 0, 0), ("step_side", 1, 0, 0, 0),
         ("step_side_look90", 1, 0, 90, 0), ("corner", 1.2, -1.5, 45, -10), ("down", 0.8, 0, 0, -60)]


def gen(name):
    key = os.environ["META_MODEL_API_KEY"]
    body = json.dumps({"model": "muse-image-1.0", "prompt": JOBS[name], "n": 1, "size": "2048x1024"}).encode()
    t = time.time()
    for _ in range(3):  # sporadic 400 on a valid prompt, a retry passes (H13)
        try:
            req = urllib.request.Request(API, body, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=180))
            Image.open(io.BytesIO(base64.b64decode(d["data"][0]["b64_json"]))).convert("RGB").save(OUT / f"{name}.png")
            return name, round(time.time() - t, 1)
        except Exception as e:
            err = e
    raise RuntimeError(f"{name}: {err}")


def shots():
    from playwright.sync_api import sync_playwright

    srv = subprocess.Popen(["python3", "-m", "http.server", "8716", "-d", str(ROOT)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1)
        with sync_playwright() as p:
            b = p.chromium.launch(channel="chrome", args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = b.new_page(viewport={"width": 960, "height": 720})
            for room, w, d, h in SHOTS:
                for v, x, z, yaw, pitch in VIEWS:
                    q = f"room={room}&w={w}&d={d}&h={h}&x={x}&z={z}&yaw={yaw}&pitch={pitch}"
                    page.goto(f"http://127.0.0.1:8716/h0/out/h16/view.html?{q}")
                    page.wait_for_function("document.title === 'ready'", timeout=30000)
                    page.screenshot(path=str(OUT / f"shot_{room}_{w}x{d}_{v}.png"))
            b.close()
    finally:
        srv.terminate()


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    todo = [n for n in JOBS if not (OUT / f"{n}.png").exists()]
    with ThreadPoolExecutor(len(JOBS)) as ex:
        for name, s in ex.map(gen, todo):
            print(f"{name}: {s} s", flush=True)
    shots()
    print("shots in", OUT)
