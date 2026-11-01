"""SAM 3D Objects on Modal: plain-background PNGs -> GLB mesh + gaussian splat PLY.

usage: modal run h0/sam3d_modal.py --out h0/out/glb_sam3d --pngs h0/out/images_v2/pineapple_house.png,...
needs: modal secret `huggingface` with HF_TOKEN (access to facebook/sam-3d-objects granted)
"""
import os
import sys
import tempfile
from pathlib import Path

import modal

REPO = "/opt/s3d"
CKPT = "/ckpt"

image = (
    modal.Image.from_registry("nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04", add_python="3.11")
    .apt_install("git", "build-essential", "ninja-build", "libgl1", "libglib2.0-0", "libegl1")
    .env({
        "CUDA_HOME": "/usr/local/cuda",
        "CONDA_PREFIX": "/usr/local/cuda",  # notebook/inference.py copies this into CUDA_HOME
        "TORCH_CUDA_ARCH_LIST": "9.0",  # H100 only, keeps the pytorch3d build short
        "FORCE_CUDA": "1",
        # pypi.ngc.nvidia.com doesn't resolve inside Modal builders; its packages are on plain PyPI anyway
        "PIP_EXTRA_INDEX_URL": "https://download.pytorch.org/whl/cu121",
        "PIP_FIND_LINKS": "https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.5.1_cu121.html",
        "LIDRA_SKIP_INIT": "true",
    })
    .pip_install("torch==2.5.1", "torchvision==0.20.1", "torchaudio==2.5.1", "wheel", "setuptools", "packaging", "ninja")
    .run_commands(
        f"git clone https://github.com/facebookresearch/sam-3d-objects {REPO}",
        # something in requirements caps transformers<4.40; without a pin pip backtracks through every release
        f"cd {REPO} && pip install -e '.[dev]' 'transformers[sentencepiece]==4.39.3'",
        # pytorch3d / flash_attn import torch at build time, so no isolated build env;
        # that also means the project's own hatchling backend has to be installed by hand.
        # Modal's standalone python was built with clang and links extensions with clang++; the image only has gcc
        "ln -sf $(which gcc) /usr/local/bin/clang && ln -sf $(which g++) /usr/local/bin/clang++",
        f"cd {REPO} && pip install hatchling hatch-requirements-txt editables"
        f" && pip install --no-build-isolation -e '.[p3d]'",
        f"cd {REPO} && pip install --no-build-isolation -e '.[inference]'",
        f"cd {REPO} && python patching/hydra",
        "pip install 'huggingface-hub[cli]<1.0' scipy",
        # texture baking goes through utils3d -> nvdiffrast, which none of the extras pull in
        "pip install --no-build-isolation git+https://github.com/NVlabs/nvdiffrast",
    )
    # texture baking renders splats with the 'inria' backend by default, and diff_gaussian_rasterization
    # isn't installed (its import fails silently); gsplat is, and the renderer supports it.
    # Only the defaults change: lines comparing `== "inria"` keep their branch.
    # Separate layer so the heavy builds above stay cached.
    .run_commands(
        f"sed -i '/== \"inria\"/! s/\"inria\"/\"gsplat\"/' {REPO}/sam3d_objects/model/backbone/tdfy_dit/utils/render_utils.py"
        f" {REPO}/sam3d_objects/model/backbone/tdfy_dit/renderers/gaussian_render.py",
    )
)

app = modal.App("dreamer-sam3d", image=image)
ckpt_vol = modal.Volume.from_name("sam3d-ckpt", create_if_missing=True)


def white_bg_mask(rgb):
    """Near-white pixels connected to the border are background; everything else is the object."""
    import numpy as np
    from scipy import ndimage

    white = (rgb.astype(int).min(axis=2) > 235)
    labels, _ = ndimage.label(white)
    border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    bg = np.isin(labels, border[border > 0])
    return ndimage.binary_opening(~bg, iterations=2)


@app.cls(gpu="H100", volumes={CKPT: ckpt_vol}, secrets=[modal.Secret.from_name("huggingface")],
         timeout=1800, scaledown_window=600)  # no container cap: N objects fan out to N GPUs
class Sam3D:
    @modal.enter()
    def load(self):
        import subprocess

        if not os.path.exists(f"{CKPT}/hf/pipeline.yaml"):
            subprocess.run(["hf", "download", "--repo-type", "model", "--local-dir", f"{CKPT}/dl",
                            "--max-workers", "4", "facebook/sam-3d-objects"], check=True)
            os.rename(f"{CKPT}/dl/checkpoints", f"{CKPT}/hf")
            ckpt_vol.commit()
        sys.path.append(f"{REPO}/notebook")
        os.chdir(REPO)
        from inference import Inference

        self.inf = Inference(f"{CKPT}/hf/pipeline.yaml", compile=False)

    @modal.method()
    def run(self, name: str, png: bytes, with_ply: bool = True, mask=None) -> dict:
        import io
        import time

        import numpy as np
        from PIL import Image

        t = time.time()
        rgb = np.array(Image.open(io.BytesIO(png)).convert("RGB"))
        if mask is None:
            mask = white_bg_mask(rgb)
        elif isinstance(mask, (bytes, bytearray)):
            # a SAM 3 PNG mask of the object in this very frame: no white background to look for
            mask = np.array(Image.open(io.BytesIO(mask)).convert("L")) > 127
        rgba = self.inf.merge_mask_to_rgba(rgb, mask)
        # Inference.__call__ hardcodes mesh postprocess off; call the pipeline directly to get a textured GLB
        kw = dict(stage1_only=False, with_mesh_postprocess=True, with_layout_postprocess=False,
                  stage1_inference_steps=None, pointmap=None)
        baked = True
        try:
            out = self.inf._pipeline.run(rgba, None, 42, with_texture_baking=True, use_vertex_color=False, **kw)
        except Exception as e:
            import traceback

            traceback.print_exc()
            print(f"{name}: texture baking failed ({e!r}), retrying with vertex colors")
            baked = False
            out = self.inf._pipeline.run(rgba, None, 42, with_texture_baking=False, use_vertex_color=True, **kw)
        return pack_result(name, out, with_ply, time.time() - t, baked)


#: what `pipeline.run` puts in `out` about where the object sits in the frame
POSE_KEYS = ("rotation", "translation", "scale")


def _plain(value):
    if hasattr(value, "detach"):
        value = value.detach().cpu()
    return value.tolist() if hasattr(value, "tolist") else value


def pack_result(name, out, with_ply, sec, baked):
    ply = b""
    if with_ply:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "o.ply"
            out["gs"].save_ply(str(path))
            ply = path.read_bytes()
    glb = out["glb"].export(file_type="glb") if out.get("glb") is not None else b""
    pose = {k: _plain(out[k]) for k in POSE_KEYS if k in out} or None
    return {"name": name, "glb": glb, "ply": ply, "sec": round(sec, 1), "baked": baked, "pose": pose}


def save_result(out_dir: Path, result: dict):
    name = result["name"]
    if not isinstance(name, str) or name in ("", ".", "..") or any(c in name for c in ("/", "\\", "\x00")):
        raise ValueError("unsafe asset name")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for ext in ("glb", "ply"):
        if result.get(ext):
            (out_dir / (name + "." + ext)).write_bytes(result[ext])


heartbeat = modal.Dict.from_name("dreamer-pipe2-heartbeat", create_if_missing=True)


@app.function(image=modal.Image.debian_slim(), schedule=modal.Period(minutes=2))
def watchdog():
    import time
    last = heartbeat.get("ts")
    if last is None or time.time() - last > 300:
        modal.Cls.from_name("dreamer-sam3d", "Sam3D")().update_autoscaler(
            min_containers=0, buffer_containers=0, scaledown_window=120)


@app.local_entrypoint()
def main(out: str, pngs: str):
    os.makedirs(out, exist_ok=True)
    jobs = [(os.path.splitext(os.path.basename(p))[0], open(p, "rb").read()) for p in pngs.split(",")]
    for r in Sam3D().run.starmap(jobs):
        save_result(Path(out), r)
        print(r["name"], f"{r['sec']}s", f"glb={len(r['glb']) // 1024}KB", f"ply={len(r['ply']) // 1024}KB", "baked" if r["baked"] else "vertex-color")
