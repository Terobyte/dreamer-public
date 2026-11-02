"""Muse Image backgrounds/portraits with fallback, max 2 at once (spec 9, 13).
usage: cd h0/dream && python3 -m unittest test_media -q
"""

import base64
import io
import json
import os
import shutil
import struct
import threading
import urllib.request
import zlib

try:
    from llm import charge_image
except ImportError:
    from .llm import charge_image

IMAGE_API = "https://api.meta.ai/v1/images/generations"
RETRIES = 3
STYLE = "Flat 2D comic panel, soft pastel colors. "
TIMEOUT = 180


def _image_key():
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    import keys
    return keys.get("IMAGE")


def real_transport(prompt, out_path, size="1024x1024"):
    """One Muse Image call; on sporadic 400 the caller retries (h13_sky.gen)."""
    key = _image_key()
    body = json.dumps({"model": "muse-image-1.0", "prompt": prompt,
                       "n": 1, "size": size}).encode()
    req = urllib.request.Request(
        IMAGE_API, body,
        {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.load(r)
    raw = base64.b64decode(data["data"][0]["b64_json"])
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(raw)
    charge_image(1)
    return out_path


def fake_transport(prompt, out_path, size="1024x1024"):
    """Offline stand-in: a tiny valid PNG so downstream code has a file."""
    try:
        from PIL import Image
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        Image.new("RGB", (8, 8), (200, 210, 220)).save(out_path)
        return out_path
    except Exception:
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n")
        return out_path


def _text_chunk(text):
    """PNG tEXt chunk: the caption/name survives in the file itself, so a
    fallback picture still says which place or character it stands for."""
    data = b"Comment\x00" + str(text).encode("utf-8", "replace")
    return (struct.pack(">I", len(data)) + b"tEXt" + data
            + struct.pack(">I", zlib.crc32(b"tEXt" + data) & 0xffffffff))


def _write_minimal_png(path, width, height, rgb, text=None):
    """Valid solid-color PNG via zlib/struct only (F16): the stdlib floor when
    Pillow is unavailable, so a fallback path is always a real decodable image."""
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    row = bytes([0]) + bytes(rgb) * width
    idat = zlib.compress(row * height, 9)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr)
                + (_text_chunk(text) if text else b"")
                + chunk(b"IDAT", idat) + chunk(b"IEND", b""))
    return path


def background_prompt(place):
    return STYLE + "Background, no people, no text. " + place


def portrait_prompt(who, prev=""):
    tail = (" Resembles: %s." % prev) if prev else ""
    return (STYLE + "Portrait on a plain white background (mix-blend-mode: multiply). "
            + who + tail)


class Images:
    """Image generation with fallback: a failed background reuses the previous
    one with the new place as caption; a failed portrait is a named silhouette.
    The dream never waits on a picture (spec 9)."""

    def __init__(self, transport=None, max_parallel=2, prev_background=None):
        self.transport = transport or real_transport
        self.max_parallel = min(2, max(1, int(max_parallel)))
        self._sem = threading.Semaphore(self.max_parallel)
        self.prev_background = prev_background

    def _write_caption(self, path, text):
        """Fallback background (spec 9): the previous background with the new
        place as caption -- drawn on the picture and kept in a tEXt chunk, so
        the place is never lost even on the stdlib-only path."""
        src = self.prev_background if (self.prev_background
                                       and os.path.exists(self.prev_background)) else None
        caption = str(text)[:120]
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        try:
            from PIL import Image, ImageDraw, PngImagePlugin
            img = (Image.open(src).convert("RGB") if src
                   else Image.new("RGB", (512, 256), (200, 210, 220)))
            ImageDraw.Draw(img).text((10, 10), caption[:60], fill=(30, 30, 30))
            info = PngImagePlugin.PngInfo()
            info.add_text("Comment", caption)
            img.save(path, pnginfo=info)
            return path
        except Exception:
            return _write_minimal_png(path, 512, 256, (200, 210, 220), text=caption)

    def _write_silhouette(self, path, name):
        """Fallback portrait (spec 9): a silhouette carrying the character name,
        in the drawing and in a tEXt chunk (stdlib-only path included)."""
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        label = str(name)[:40]
        try:
            from PIL import Image, ImageDraw, PngImagePlugin
            img = Image.new("RGB", (256, 256), (235, 235, 235))
            d = ImageDraw.Draw(img)
            d.ellipse([88, 40, 168, 120], fill=(60, 60, 70))
            d.ellipse([78, 120, 178, 240], fill=(60, 60, 70))
            d.text((10, 236), label, fill=(30, 30, 30))
            info = PngImagePlugin.PngInfo()
            info.add_text("Comment", label)
            img.save(path, pnginfo=info)
            return path
        except Exception:
            return _write_minimal_png(path, 256, 256, (235, 235, 235), text=label)

    def _fallback_file(self, kind, prompt, out_path, fallback, name=None):
        if fallback is not None:
            return fallback
        if kind == "portrait":
            return self._write_silhouette(out_path, name or prompt)
        return self._write_caption(out_path, name or prompt)

    def generate(self, kind, prompt, out_path, size="1024x1024", fallback=None,
                 name=None):
        """Returns {ok, path, fallback?}; path always exists on disk, so every
        sim log entry points at a real file (spec 4). `name` is the place or
        character the fallback must carry (spec 9)."""
        err = None
        with self._sem:
            for _ in range(RETRIES):
                try:
                    self.transport(prompt, out_path, size) if (
                        getattr(self.transport, "__code__", None) is not None and
                        "size" in getattr(self.transport, "__code__", {}).co_varnames
                    ) else self.transport(prompt, out_path)
                    if kind == "background":
                        self.prev_background = out_path
                    return {"ok": True, "path": out_path, "diagnostic": None}
                except Exception as e:
                    err = e
        fb = self._fallback_file(kind, prompt, out_path, fallback, name)
        diag = {"type": "image_fail", "kind": kind,
                "error": "%s: %s" % (type(err).__name__, err)}
        return {"ok": False, "path": fb, "fallback": fb, "diagnostic": diag,
                "error": diag}
