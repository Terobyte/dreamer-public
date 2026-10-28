"""H16 squid: an EMPTY cartoon room panorama for the walls + a seamless floor tile for a real floor plane.
The painted floor smears when you step (it is not a true plane), so the floor is real geometry with its own texture.
usage: python h16_squid.py
"""
from concurrent.futures import ThreadPoolExecutor

import h16_room as h

FLOOR = ("Seamless tileable texture, top-down orthographic view, flat even lighting, no shadows, "
         "no perspective, no objects, the pattern repeats with no visible edges. ")
h.JOBS = {
    # SpongeBob places are test-only (never in the submission)
    "room_squid_empty": h.ROOM.replace("furniture stands against the walls, the middle of the floor is empty",
                                       "the room is completely EMPTY, no furniture at all, bare floor")
                        + "A small cartoon room inside a stone tiki-head house under the sea: teal stone walls, "
                          "a round porthole window, flat grey-teal stone tile floor.",
    "floor_squid": FLOOR + "Cartoon grey-teal stone floor tiles with thin dark grout lines, soft painterly style.",
}
_gen = h.gen


def gen(name):
    if name.startswith("floor"):  # square tile, same endpoint
        import json, os, io, base64, urllib.request
        from PIL import Image
        body = json.dumps({"model": "muse-image-1.0", "prompt": h.JOBS[name], "n": 1, "size": "1024x1024"}).encode()
        for _ in range(3):
            try:
                req = urllib.request.Request(h.API, body, {"Authorization": f"Bearer {os.environ['META_MODEL_API_KEY']}",
                                                           "Content-Type": "application/json"})
                d = json.load(urllib.request.urlopen(req, timeout=180))
                Image.open(io.BytesIO(base64.b64decode(d["data"][0]["b64_json"]))).convert("RGB").save(h.OUT / f"{name}.png")
                return name
            except Exception as e:
                err = e
        raise RuntimeError(f"{name}: {err}")
    return _gen(name)[0]


if __name__ == "__main__":
    with ThreadPoolExecutor(2) as ex:
        print(list(ex.map(gen, [n for n in h.JOBS if not (h.OUT / f"{n}.png").exists()])))
