"""Semey five places on Modal (highskilltero): one CPU container with the stdlib server, state on the Volume.

  cd h0 && modal deploy place/semey_modal.py        -> https://highskilltero--semey-web.modal.run
Secret `dreamer-meta`: META_MODEL_API_KEY, JUDGE_KEY (16 hex), ADMIN_KEY (32 hex). A fresh world starts with claims off;
turn them on with `python -m place.semey_admin <url> claims on`. SAM3D is warmed only while a build runs (--warm).
"""
import os
import subprocess
from pathlib import Path

import modal

H0 = Path(__file__).resolve().parents[1]
META = H0.parent
CLIENT = Path(os.environ.get("SEMEY_CLIENT", "~/.dreamer-bench/demo-bread/app/dist")).expanduser()
FEATURES = META / "runs" / "yard-kozb7" / "features.json"
SKIP = ["**/__pycache__/**", "**/test_*.py", "**/out/**", "**/*.png", "**/*.jpg", "**/*.glb", "**/*.mp4", "**/*.wav"]

image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    .pip_install("pillow", "numpy", "shapely", "requests", "opencv-python-headless")
    .env({"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1", "PYTHONUNBUFFERED": "1"})
    .add_local_file(META / "engine" / "package.json", "/root/engine/package.json", copy=True)
    .add_local_file(META / "engine" / "package-lock.json", "/root/engine/package-lock.json", copy=True)
    .run_commands("cd /root/engine && npm ci --no-audit --no-fund")
    .add_local_dir(META / "engine" / "bin", "/root/engine/bin")
    .add_local_dir(META / "engine" / "src", "/root/engine/src")
    .add_local_dir(META / "engine" / "schema", "/root/engine/schema")
    .add_local_file(META / "engine" / "tsconfig.json", "/root/engine/tsconfig.json")
    .add_local_dir(H0 / "place", "/root/h0/place", ignore=SKIP + ["host/**"])
    .add_local_dir(H0 / "pipe2", "/root/h0/pipe2", ignore=SKIP)
    .add_local_file(H0 / "keys.py", "/root/h0/keys.py")
    .add_local_file(H0 / "llm_http.py", "/root/h0/llm_http.py")
    .add_local_file(FEATURES, "/assets/features.json")
    .add_local_dir(CLIENT, "/client")
)
app = modal.App("semey", image=image)
world = modal.Volume.from_name("semey-world", create_if_missing=True)


@app.function(secrets=[modal.Secret.from_name("dreamer-meta")], volumes={"/data": world}, min_containers=1, max_containers=1,
              cpu=4, memory=6144, timeout=86400)
@modal.concurrent(max_inputs=64)
@modal.web_server(8000, startup_timeout=120)
def web():
    env = {**os.environ, "SEMEY_VOLUME": "semey-world", "PUBLIC_HOST": "highskilltero--semey-web.modal.run"}
    subprocess.Popen(["python", "-m", "place.semey", "--bind", "0.0.0.0", "--port", "8000", "--data", "/data",
                      "--client", "/client", "--features", "/assets/features.json", "--warm"], cwd="/root/h0", env=env)
