"""API keys in one place: environment first, then the gitignored meta/.env.

A key is never printed or logged; a missing key is an error naming the variable only."""
import os

ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")

VARS = {
    "META": "META_MODEL_API_KEY",
    "BASETEN": "BASETEN_API_KEY",
    "FISH": "FISH_AUDIO_API_KEY",
    "IMAGE": "META_MODEL_API_KEY",
}


class MissingKey(RuntimeError):
    """No key found. The message carries the variable name, never a value."""


def _from_file(var, path=None):
    try:
        with open(path or ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith(var + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def get(name, env_file=None):
    """Key for META / BASETEN / FISH / IMAGE; MissingKey if neither env nor meta/.env has it."""
    var = VARS[name]
    # never log or print the value; only the variable name goes into the error
    value = os.environ.get(var, "").strip() or _from_file(var, env_file)
    if not value:
        raise MissingKey("%s is not set (env or meta/.env)" % var)
    return value
