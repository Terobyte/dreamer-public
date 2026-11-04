"""Qwen3-TTS VoiceDesign (Apache-2.0) on Modal: a voice described in words -> wavs (voicedesign.py, L177).
modal run voice_design_modal.py --spec spec.json --out DIR      spec: {"text", "instructs": [...], "seeds": N}
writes DIR/d<k>_s<seed>.wav; the seed is fixed per (instruct, seed) so a rerun gives the same voice."""
import json
import os

import modal

image = (modal.Image.debian_slim(python_version="3.12").apt_install("sox", "libsndfile1")
         .pip_install("qwen-tts", "soundfile"))
app = modal.App("dream-voice-design", image=image)
vol = modal.Volume.from_name("dream-hf-cache", create_if_missing=True)


# L4 alone sat 12 min in the queue: any of these GPUs will do
@app.function(gpu=["L4", "A10G", "L40S", "A100-40GB", "T4"], timeout=1200, volumes={"/root/.cache/huggingface": vol})
def design(text, instructs, seeds):
    import io

    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel
    m = Qwen3TTSModel.from_pretrained("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", device_map="cuda:0",
                                      dtype=torch.bfloat16, attn_implementation="sdpa")
    out = []
    for k, ins in enumerate(instructs):
        for s in range(seeds):
            torch.manual_seed(1000 * k + s)
            wavs, sr = m.generate_voice_design(text=text, language="English", instruct=ins)
            b = io.BytesIO()
            sf.write(b, wavs[0], sr, format="WAV")
            out.append({"k": k, "seed": s, "wav": b.getvalue()})
    vol.commit()
    return out


@app.local_entrypoint()
def main(spec: str, out: str):
    with open(spec, encoding="utf-8") as f:
        sp = json.load(f)
    os.makedirs(out, exist_ok=True)
    for r in design.remote(sp["text"], sp["instructs"], sp.get("seeds", 2)):
        p = os.path.join(out, "d%d_s%d.wav" % (r["k"], r["seed"]))
        with open(p, "wb") as f:
            f.write(r["wav"])
        print(p)
