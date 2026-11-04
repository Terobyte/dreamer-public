"""Spark (contributor model only) with pictures, JSON out, one retry with the error text."""
import base64
import io
import json
import re
import time

from PIL import Image

import keys
import llm_http

URL = "https://api.meta.ai/v1/chat/completions"
MODEL = "muse-spark-1.3-contributor"


def img_part(img: Image.Image, max_side=1024, q=85):
    im = img.convert("RGB")
    im.thumbnail((max_side, max_side))
    b = io.BytesIO()
    im.save(b, "JPEG", quality=q)
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()}}


def parse_json(text):
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    raw = m.group(1) if m else text[text.find("{"): text.rfind("}") + 1]
    return json.loads(raw)


def ask(system, parts, effort="high", log=None, validate=None, max_tokens=32000):
    """parts: list of str / image parts. Returns (obj, meta)."""
    content = [p if isinstance(p, dict) else {"type": "text", "text": p} for p in parts]
    messages = [{"role": "system", "content": system}, {"role": "user", "content": content}]
    auth = "Bearer " + keys.get("META")
    last = None
    for attempt in range(2):
        t = time.time()
        r = llm_http.post(URL, auth, {"model": MODEL, "reasoning_effort": effort, "max_tokens": max_tokens,
                                      "messages": messages}, timeout=600, retries=2)
        text = r["content"] or ""
        meta = {"s": round(time.time() - t, 1), "usage": r.get("usage")}
        if log:
            log.write_text(text)
        try:
            obj = parse_json(text)
            if validate:
                validate(obj)
            return obj, meta
        except Exception as e:  # one retry with the error
            last = e
            messages += [{"role": "assistant", "content": text},
                         {"role": "user", "content": f"That answer did not pass: {e}. Reply again with the full corrected JSON only."}]
    raise RuntimeError(f"spark answer failed twice: {last}")
