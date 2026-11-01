"""SAM 3 on Modal: a frame of the place + what to cut out -> PNG mask of the best match.

Feeds `Sam3D.run(..., mask=)` (h0/sam3d_modal.py), so an object is meshed straight
from the room's frame instead of a Muse redraw on white. NOT deployed yet: the app
name is the stub in `SEG_APP` (h0/pipe2/assets.py); deploying it is parked.
"""
import io

import modal

try:
    from pipe2.assets import SEG_APP
except ImportError:  # inside the container pipe2 is not shipped
    SEG_APP = ("dreamer-sam3", "Sam3")

#: a mask under this share of the frame is a miss, not an object
MIN_AREA = 0.005

app = modal.App(SEG_APP[0])
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install("torch", "torchvision", "pillow", "numpy", "git+https://github.com/facebookresearch/sam3.git")
)


class MaskEmpty(Exception):
    """Nothing worth cutting: the asset goes the redraw (Н2) way."""

    code = "MASK_EMPTY"


def _array(mask):
    import numpy as np

    if hasattr(mask, "detach"):
        mask = mask.detach().cpu().numpy()
    a = np.asarray(mask)
    while a.ndim > 2:
        a = a[0]
    return a > 0


def to_png(mask) -> bytes:
    import numpy as np
    from PIL import Image

    out = io.BytesIO()
    Image.fromarray(_array(mask).astype(np.uint8) * 255, mode="L").save(out, "PNG")
    return out.getvalue()


@app.cls(gpu="H100", image=image, secrets=[modal.Secret.from_name("huggingface")],
         timeout=600, scaledown_window=300)
class Sam3:
    @modal.enter()
    def load(self):
        from sam3.model.sam3_image_processor import Sam3Processor
        from sam3.model_builder import build_sam3_image_model

        self.processor = Sam3Processor(build_sam3_image_model())

    def _predict(self, png: bytes, what: str):
        """`[(mask, score), ...]` for every match of `what` in the frame."""
        from PIL import Image

        state = self.processor.set_image(Image.open(io.BytesIO(png)).convert("RGB"))
        found = self.processor.set_text_prompt(state=state, prompt=what)
        return list(zip(found["masks"], found["scores"]))

    @modal.method()
    def mask(self, png: bytes, what: str) -> bytes:
        """PNG mask of the best-scoring match; an empty one or under 0.5% of the frame -> MaskEmpty."""
        found = self._predict(png, what)
        if not found:
            raise MaskEmpty(f"no {what!r} in the frame")
        best = _array(max(found, key=lambda ms: float(ms[1]))[0])
        if best.sum() == 0 or best.sum() < MIN_AREA * best.size:
            raise MaskEmpty(f"{what!r} covers {best.sum()} of {best.size} pixels")
        return to_png(best)
