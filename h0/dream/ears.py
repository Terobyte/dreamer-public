"""Ears: measure a Fish voice from its free library sample, since we cannot listen (L177).

Every voice in the public Fish library carries a ~15 s sample mp3 and the text it reads, i.e. exactly
how it sounds in TTS, free. Open models turn the sample into numbers:
  sex, age     audeering wav2vec2 age-gender  (right on adults; cartoon voices fool it)
  wer, pace    whisper-small transcript vs the sample's own text; words per second
  lang_p       whisper's language-ID distribution: English read by a Russian leaks into ru
               (ru_share 0.2-0.6), British English leaks into cy = Welsh (cy_share), American into nothing
  f0           median pitch by autocorrelation, Hz
Calibrated on the 23 voices of voices.json; a plain accent classifier ("canada" for all) and CLAP were blind.
Heavy deps (torch, transformers, ffmpeg) load on first measure(), not at import.
usage: python3 ears.py <fish_id> [...]
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "..", "out", "dream", "ears")
SR = 16000
LANGS = ["en", "ru", "uk", "pl", "de", "kk", "es", "fr", "nl", "it", "pt", "sv", "cy", "hi", "ja", "zh"]
VERSION = 2   # bump when a measurement changes; older cache files are measured again
_m = {}


def meta(vid, cache=CACHE):
    os.makedirs(cache, exist_ok=True)
    p = os.path.join(cache, vid + ".json")
    if not os.path.exists(p):
        req = urllib.request.Request("https://api.fish.audio/model/" + vid, headers={"User-Agent": "dream-ears"})
        with urllib.request.urlopen(req, timeout=20) as r:
            m = json.load(r)
        with open(p, "w") as f:
            json.dump(m, f)
    with open(p) as f:
        return json.load(f)


def audio(vid, m, cache=CACHE):
    import numpy as np
    p = os.path.join(cache, vid + ".mp3")
    if not os.path.exists(p):
        with urllib.request.urlopen(m["samples"][0]["audio"], timeout=30) as r:
            data = r.read()
        with open(p, "wb") as f:
            f.write(data)
    pcm = subprocess.run(["ffmpeg", "-v", "quiet", "-i", p, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(pcm, np.float32).copy()


def f0_median(x):
    """plain autocorrelation pitch over voiced 40 ms frames -> median Hz"""
    import numpy as np
    n, hop, out = int(0.04 * SR), int(0.01 * SR), []
    for i in range(0, len(x) - n, hop):
        f = x[i:i + n] - x[i:i + n].mean()
        if np.sqrt((f ** 2).mean()) < 0.02:
            continue
        ac = np.correlate(f, f, "full")[n - 1:]
        lo, hi = SR // 400, SR // 60
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] > 0.4 * ac[0]:
            out.append(SR / k)
    return float(np.median(out)) if out else None


def _model(name):
    if name not in _m:
        if name == "asr":
            from transformers import pipeline
            _m[name] = pipeline("automatic-speech-recognition", model="openai/whisper-small", return_timestamps=True)
        else:
            _m[name] = _agegender()
    return _m[name]


def _agegender():
    import torch
    import torch.nn as nn
    from transformers import Wav2Vec2Processor
    from transformers.models.wav2vec2.modeling_wav2vec2 import Wav2Vec2Model, Wav2Vec2PreTrainedModel

    class Head(nn.Module):
        def __init__(s, c, n):
            super().__init__()
            s.dense = nn.Linear(c.hidden_size, c.hidden_size)
            s.dropout = nn.Dropout(0.0)
            s.out_proj = nn.Linear(c.hidden_size, n)

        def forward(s, x):
            return s.out_proj(s.dropout(torch.tanh(s.dense(s.dropout(x)))))

    class AG(Wav2Vec2PreTrainedModel):
        def __init__(s, c):
            super().__init__(c)
            s.wav2vec2 = Wav2Vec2Model(c)
            s.age = Head(c, 1)
            s.gender = Head(c, 3)
            s.post_init()

        def forward(s, v):
            h = s.wav2vec2(v)[0].mean(1)
            return s.age(h), torch.softmax(s.gender(h), -1)

    name = "audeering/wav2vec2-large-robust-24-ft-age-gender"
    return Wav2Vec2Processor.from_pretrained(name), AG.from_pretrained(name).eval()


def lang_probs(x):
    """whisper's first-token language distribution over LANGS (tensors go to the model's device: MPS)"""
    import torch
    a = _model("asr")
    tok = a.tokenizer
    ids = [tok.convert_tokens_to_ids("<|%s|>" % l) for l in LANGS]
    f = a.feature_extractor(x[:30 * SR], sampling_rate=SR, return_tensors="pt").input_features
    f = f.to(a.model.device, a.model.dtype)
    start = torch.tensor([[tok.convert_tokens_to_ids("<|startoftranscript|>")]], device=a.model.device)
    with torch.no_grad():
        lg = a.model(input_features=f, decoder_input_ids=start).logits[0, -1]
    p = torch.softmax(lg[ids].float(), -1).cpu().numpy()
    return {l: float("%.2g" % v) for l, v in zip(LANGS, p)}


def words(t):
    return re.findall(r"[a-z']+", (t or "").lower())


def wer(ref, hyp):
    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        p, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (r[i - 1] != h[j - 1]))
    return d[len(h)] / max(1, len(r))


def shares(lp):
    """non-English mass from the other languages (p(en) rounds to 1.0), ru+uk share, cy share"""
    ne = max(1e-9, sum(v for l, v in lp.items() if l != "en"))
    return float("%.2g" % ne), round((lp.get("ru", 0) + lp.get("uk", 0)) / ne, 2), round(lp.get("cy", 0) / ne, 2)


def measure(vid, cache=CACHE):
    """-> {id, title, langs, tags, uses, likes, dur, age, sex{female,male,child}, heard, wer, pace_wps, f0,
    lang_p, p_nonen, ru_share, cy_share}; cached per id. Raises when the voice has no sample."""
    import torch
    p = os.path.join(cache, vid + ".ears.json")
    if os.path.exists(p):
        with open(p) as f:
            r = json.load(f)
        if r.get("v") == VERSION:
            return r
    m = meta(vid, cache)
    if not m.get("samples") or not m["samples"][0].get("audio"):
        raise ValueError("no sample")
    x = audio(vid, m, cache)
    x30 = x[:30 * SR]
    r = {"v": VERSION, "id": vid, "title": m.get("title"), "langs": m.get("languages"), "tags": m.get("tags"),
         "uses": m.get("task_count"), "likes": m.get("like_count"), "dur": round(len(x) / SR, 1)}
    proc, ag = _model("agegender")
    with torch.no_grad():
        age, g = ag(proc(x30, sampling_rate=SR, return_tensors="pt").input_values)
    r["age"] = round(float(age[0, 0]) * 100)
    r["sex"] = dict(zip(["female", "male", "child"], [round(float(v), 2) for v in g[0]]))
    asr = _model("asr")({"raw": x30, "sampling_rate": SR}, generate_kwargs={"language": "en"})
    text = m["samples"][0].get("text")
    r["heard"] = asr["text"][:120]
    r["wer"] = round(wer(text, asr["text"]), 2) if text else None
    r["pace_wps"] = round(len(words(asr["text"])) / max(1.0, min(len(x) / SR, 30)), 2)
    r["f0"] = round(f0_median(x30) or 0)
    r["lang_p"] = lang_probs(x30)
    r["p_nonen"], r["ru_share"], r["cy_share"] = shares(r["lang_p"])
    with open(p, "w") as f:
        json.dump(r, f, indent=1)
    return r


def measure_wav(path, text, title=None):
    """the same facts for a local wav that reads `text` (a designed voice, a clone's line); not cached"""
    import numpy as np
    import torch
    pcm = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(pcm, np.float32).copy()[:30 * SR]
    proc, ag = _model("agegender")
    with torch.no_grad():
        age, g = ag(proc(x, sampling_rate=SR, return_tensors="pt").input_values)
    heard = _model("asr")({"raw": x, "sampling_rate": SR}, generate_kwargs={"language": "en"})["text"]
    r = {"id": os.path.basename(path), "title": title or os.path.basename(path), "langs": ["en"], "tags": [],
         "uses": 0, "dur": round(len(x) / SR, 1), "age": round(float(age[0, 0]) * 100),
         "sex": dict(zip(["female", "male", "child"], [round(float(v), 2) for v in g[0]])),
         "heard": heard[:120], "wer": round(wer(text, heard), 2),
         "pace_wps": round(len(words(heard)) / max(1.0, len(x) / SR), 2), "f0": round(f0_median(x) or 0),
         "lang_p": lang_probs(x)}
    r["p_nonen"], r["ru_share"], r["cy_share"] = shares(r["lang_p"])
    return r


if __name__ == "__main__":
    for vid in sys.argv[1:]:
        try:
            print(json.dumps(measure(vid), ensure_ascii=False))
        except Exception as e:
            print(vid, "ERR", type(e).__name__, e)
