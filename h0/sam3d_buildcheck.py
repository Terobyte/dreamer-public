"""Builds the SAM 3D image and checks the heavy imports; no HF secret needed."""
import modal

from sam3d_modal import image

app = modal.App("dreamer-sam3d-buildcheck", image=image)


@app.function(gpu="T4", timeout=600)
def check():
    import torch, pytorch3d, kaolin, flash_attn, gsplat, sam3d_objects  # noqa: F401
    from pytorch3d import _C  # noqa: F401  compiled CUDA ops
    print("torch", torch.__version__, "cuda", torch.cuda.is_available(), "p3d", pytorch3d.__version__, "kaolin", kaolin.__version__)


@app.local_entrypoint()
def main():
    check.remote()
