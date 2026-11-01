"""TRELLIS.2-4B on Modal, 1024 cascade pipeline: plain-background PNG -> textured GLB, for pipe2 props.

Same call shape as `dreamer-sam3d` (`Cls.run(name, png, with_ply)` -> {name, glb, ply, sec, baked}),
so pipe2's `ModalMesh(app="dreamer-trellis", cls="Trellis")` swaps it in.
Image and the gated-model swap are copied from anymove/runs/squidward/modal_trellis2.py;
weights are already in the `anymove` volume (hf_cache) on acc2.

deploy: modal deploy h0/trellis_modal.py
usage:  modal run h0/trellis_modal.py --out <dir> --pngs a.png,b.png
returns the scene GLB cut to `faces` and the 200k-face original (`full`) for later cuts.
"""
import os
import time
from pathlib import Path

import modal

COMMIT = "75fbf0183001ed9876c8dbb35de6b68552ee08bd"
REPO = "/opt/trellis2"
ARCH = "8.0;8.6;8.9;9.0"
#: engine TRI_LIMITS: small 1000, furniture 5000, large 8000; SCENE_TRI_LIMIT 300k is an error.
#: TRELLIS' own default (150k) is what made Twelve Oaks lag, so the scene mesh is cut to the key's budget
#: (pipe2 passes `faces` from keys.ts); FACES is the furniture budget for callers that do not.
FACES = 5000
#: the decimator lands near its target, not under it: aim below the budget so `check` stays green
MARGIN = 0.9
#: the kept original: detail for a heavier cut later, without a new 4B run
FULL_FACES = 200_000
TEX = 1024
PIPELINE = "1024_cascade"

vol = modal.Volume.from_name("anymove", create_if_missing=True)

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.10")
    .apt_install("git", "build-essential", "ninja-build", "libgl1", "libglib2.0-0", "libegl1", "libjpeg-dev")
    .pip_install("torch==2.6.0", "torchvision==0.21.0", index_url="https://download.pytorch.org/whl/cu124")
    .pip_install("imageio", "imageio-ffmpeg", "tqdm", "easydict", "opencv-python-headless", "ninja", "trimesh",
                 "transformers==4.57.3", "zstandard", "kornia", "timm==1.0.22", "plyfile", "numpy<2.3",
                 "huggingface_hub", "safetensors", "setuptools", "wheel", "pillow")
    .pip_install("git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8")
    .pip_install("https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/"
                 "flash_attn-2.7.4.post1+cu12torch2.6cxx11abiFALSE-cp310-cp310-linux_x86_64.whl")
    .env({"TORCH_CUDA_ARCH_LIST": ARCH, "MAX_JOBS": "16", "CUDA_HOME": "/usr/local/cuda"})
    .run_commands(
        # Modal's standalone python links extensions with clang++; the image only has gcc (same as sam3d_modal)
        "ln -sf $(which gcc) /usr/local/bin/clang && ln -sf $(which g++) /usr/local/bin/clang++",
        f"git clone https://github.com/microsoft/TRELLIS.2.git {REPO} && cd {REPO} && git checkout {COMMIT}"
        " && git submodule update --init --recursive",
        "mkdir -p /tmp/ext && git clone -b v0.4.0 https://github.com/NVlabs/nvdiffrast.git /tmp/ext/nvdiffrast"
        " && pip install /tmp/ext/nvdiffrast --no-build-isolation",
        "git clone -b renderutils https://github.com/JeffreyXiang/nvdiffrec.git /tmp/ext/nvdiffrec"
        " && pip install /tmp/ext/nvdiffrec --no-build-isolation",
        "git clone --recursive https://github.com/JeffreyXiang/CuMesh.git /tmp/ext/CuMesh"
        " && pip install /tmp/ext/CuMesh --no-build-isolation",
        "git clone --recursive https://github.com/JeffreyXiang/FlexGEMM.git /tmp/ext/FlexGEMM"
        " && pip install /tmp/ext/FlexGEMM --no-build-isolation",
        f"cp -r {REPO}/o-voxel /tmp/ext/o-voxel && pip install /tmp/ext/o-voxel --no-build-isolation --no-deps",
    )
    .env({"HF_HOME": "/vol/hf_cache", "TORCH_HOME": "/vol/torch_cache", "OPENCV_IO_ENABLE_OPENEXR": "1",
          "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True", "PYTHONPATH": REPO})
)
app = modal.App("dreamer-trellis", image=image)


def _patch_gated():
    """Swap the two gated HF models for open equivalents before the pipeline loads."""
    import timm
    import torch
    import torch.nn.functional as F
    from trellis2.modules import image_feature_extractor as fe
    from trellis2.pipelines import rembg

    class TimmDinoV3(fe.DinoV3FeatureExtractor):
        # same output as the HF DINOv3ViTModel path: all tokens after the last block, then a plain layer_norm
        def __init__(self, model_name: str, image_size=512):
            self.model_name = model_name
            self.model = timm.create_model("vit_large_patch16_dinov3_qkvb.lvd1689m", pretrained=True,
                                           dynamic_img_size=True).eval()
            self.image_size = image_size
            self.transform = fe.transforms.Compose([
                fe.transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])])

        def extract_features(self, image: torch.Tensor) -> torch.Tensor:
            m = self.model
            x = m.patch_embed(image)
            x, rope = m._pos_embed(x)
            x = m.norm_pre(x)
            for blk in m.blocks:
                x = blk(x, rope=rope)
            return F.layer_norm(x, x.shape[-1:])

    class OpenBiRefNet(rembg.BiRefNet):
        def __init__(self, model_name: str = ""):
            super().__init__("ZhengPeng7/BiRefNet")

    fe.DinoV3FeatureExtractor = TimmDinoV3
    rembg.BiRefNet = OpenBiRefNet


@app.cls(gpu="H100", volumes={"/vol": vol}, timeout=1800, scaledown_window=600)  # no cap: N props -> N GPUs
class Trellis:
    @modal.enter()
    def load(self):
        os.chdir(REPO)
        _patch_gated()
        from trellis2.pipelines import Trellis2ImageTo3DPipeline

        self.pipe = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
        self.pipe.cuda()

    @modal.method()
    def run(self, name: str, png: bytes, with_ply: bool = False, faces: int = FACES,
            with_full: bool = True) -> dict:
        import io

        from PIL import Image

        t = time.time()
        mesh = self.pipe.run(Image.open(io.BytesIO(png)), seed=42, pipeline_type=PIPELINE)[0]
        mesh.simplify(16777216)
        glb = _glb(mesh, int(faces * MARGIN))
        full = _glb(mesh, FULL_FACES) if with_full else b""
        # no gaussian splat here: `ply` stays empty, like sam3d with with_ply=False
        return {"name": name, "glb": glb, "full": full, "ply": b"", "sec": round(time.time() - t, 1),
                "baked": True}


def _glb(mesh, target: int) -> bytes:
    """One textured GLB of `mesh` decimated to about `target` faces."""
    import o_voxel

    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs, coords=mesh.coords,
        attr_layout=mesh.layout, voxel_size=mesh.voxel_size, aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=target, texture_size=TEX, remesh=True, remesh_band=1, remesh_project=0)
    path = f"/tmp/{os.getpid()}-{time.time_ns()}.glb"
    glb.export(path, extension_webp=False)
    blob = Path(path).read_bytes()
    os.remove(path)
    return blob


heartbeat = modal.Dict.from_name("dreamer-pipe2-heartbeat", create_if_missing=True)


@app.function(image=modal.Image.debian_slim(), schedule=modal.Period(minutes=2))
def watchdog():
    """Same deadman as dreamer-sam3d: no pipe2 heartbeat for 5 min -> no warm GPUs."""
    last = heartbeat.get("ts")
    if last is None or time.time() - last > 300:
        modal.Cls.from_name("dreamer-trellis", "Trellis")().update_autoscaler(
            min_containers=0, buffer_containers=0, scaledown_window=120)


@app.local_entrypoint()
def main(out: str, pngs: str):
    os.makedirs(out, exist_ok=True)
    jobs = [(os.path.splitext(os.path.basename(p))[0], open(p, "rb").read()) for p in pngs.split(",")]
    for r in Trellis().run.starmap(jobs):
        (Path(out) / (r["name"] + ".glb")).write_bytes(r["glb"])
        (Path(out) / (r["name"] + ".full.glb")).write_bytes(r["full"])
        print(r["name"], f"{r['sec']}s", f"glb={len(r['glb']) // 1024}KB", f"full={len(r['full']) // 1024}KB")
