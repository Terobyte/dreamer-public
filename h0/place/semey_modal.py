"""Semey five places on Modal (highskilltero): one CPU container with the stdlib server, state on the Volume.

  cd h0 && modal deploy place/semey_modal.py        -> https://highskilltero--semey-web.modal.run
Secret `dreamer-meta`: META_MODEL_API_KEY, JUDGE_KEY (16 hex), ADMIN_KEY (32 hex). A fresh world starts with claims off;
turn them on with `python -m place.semey_admin <url> claims on`. SAM3D is warmed only while a build runs (--warm).
"""
import os
import subprocess
import threading
import time
from pathlib import Path

import modal

H0 = Path(__file__).resolve().parents[1]
META = H0.parent
CLIENT = Path(os.environ.get("SEMEY_CLIENT", "~/.dreamer-bench/demo-bread/app/dist")).expanduser()
FEATURES = META / "runs" / "yard-kozb7" / "features.json"
SKIP = ["**/__pycache__/**", "**/test_*.py", "**/out/**", "**/*.png", "**/*.jpg", "**/*.glb", "**/*.mp4", "**/*.wav"]

image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    .apt_install("ca-certificates")                    # B56: the slim base has no CA bundle, every https call failed
    .pip_install("pillow", "numpy", "shapely", "requests", "opencv-python-headless", "modal==1.6.2")
    .env({"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1", "PYTHONUNBUFFERED": "1"})
    .add_local_file(META / "engine" / "package.json", "/root/engine/package.json", copy=True)
    .add_local_file(META / "engine" / "package-lock.json", "/root/engine/package-lock.json", copy=True)
    .run_commands("cd /root/engine && npm ci --no-audit --no-fund")
    .add_local_dir(META / "engine" / "bin", "/root/engine/bin", copy=True)
    .add_local_dir(META / "engine" / "src", "/root/engine/src", copy=True)
    .add_local_dir(META / "engine" / "schema", "/root/engine/schema", copy=True)
    .add_local_file(META / "engine" / "tsconfig.json", "/root/engine/tsconfig.json", copy=True)
    .add_local_dir(H0 / "place", "/root/h0/place", ignore=SKIP + ["host/**"], copy=True)
    .add_local_dir(H0 / "pipe2", "/root/h0/pipe2", ignore=SKIP, copy=True)
    .add_local_file(H0 / "keys.py", "/root/h0/keys.py", copy=True)
    .add_local_file(H0 / "llm_http.py", "/root/h0/llm_http.py", copy=True)
    .add_local_file(FEATURES, "/assets/features.json", copy=True)
    .add_local_dir(CLIENT, "/client", copy=True)
    # B51: a broken image fails the deploy, not the first judge
    .run_commands(
        "cd /root/h0 && python -c 'import place.semey, place.shop, place.assets, place.compile, place.spark, pipe2.assets, "
        "pipe2.ledger, pipe2.engine, llm_http, keys, PIL, shapely, modal'",
        "cd /root/h0 && python -m place.semey --selftest /tmp/semey-selftest",
        "node -e 'const [a,b]=process.versions.node.split(\".\").map(Number); if (a<22||(a===22&&b<12)) process.exit(1)' && node --version",
        "python -c \"import urllib.request as u, urllib.error as e; f = lambda: u.urlopen('https://api.meta.ai/', timeout=30); exec('try: f()\\\\nexcept e.HTTPError: pass')\"",
        "test -f /client/index.html && test -d /client/yard && test -d /client/shop2 && ! grep -q '%VITE_' /client/index.html",
    )
)
app = modal.App("semey", image=image)
world = modal.Volume.from_name("semey-world", create_if_missing=True)


@app.function(secrets=[modal.Secret.from_name("dreamer-meta")], volumes={"/data": world}, min_containers=1, max_containers=1,
              cpu=4, memory=6144, timeout=86400)
@modal.concurrent(max_inputs=64)
@modal.web_server(8000, startup_timeout=120)
def web():
    env = {**os.environ, "SEMEY_VOLUME": "semey-world", "PUBLIC_HOST": "highskilltero--semey-web.modal.run,highskilltero--semey-web.us-east.modal.run"}
    cmd = ["python", "-m", "place.semey", "--bind", "0.0.0.0", "--port", "8000", "--data", "/data",
           "--client", "/client", "--features", "/assets/features.json", "--warm"]
    threading.Thread(target=supervise, args=(cmd, "/root/h0", env), daemon=True).start()


def supervise(cmd, cwd, env, popen=subprocess.Popen, sleep=time.sleep):
    """keeps the world server up: when it exits it starts again (1 s, doubling to 30 s while it keeps crashing fast)"""
    delay = 1
    while True:
        t0 = time.monotonic()
        rc = popen(cmd, cwd=cwd, env=env).wait()
        if time.monotonic() - t0 > 60:                 # a healthy run forgets the crash loop before it sleeps (B53)
            delay = 1
        print(f"semey exited ({rc}); restarting in {delay} s", flush=True)
        sleep(delay)
        delay = min(30, delay * 2)
