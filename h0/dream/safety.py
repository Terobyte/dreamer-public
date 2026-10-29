"""The safety list (spec 7.2 row 2.2): the few human phrases that stop the dream.
One place, two languages; the dream pauses on a hit and only /continue goes on.
usage: hit = match("i want to die")  # -> "want to die"
"""

# The starting list is the owner's decision; edit it here and write the change
# into DEVLOG.md. Substring matching, so a phrase is kept short and unambiguous.
PHRASES: dict[str, tuple[str, ...]] = {
    "en": ("kill myself", "want to die", "end my life", "suicide", "hurt myself"),
    "ru": ("убить себя", "хочу умереть", "покончить с собой", "суицид",
           "причинить себе вред"),
}

# One fixed note to every actor when the dream goes on: the scene stays, the
# pressure does not.
SOFT_NOTE = ("Take it gently now: stay warm and simple, no harm and no danger in "
             "what you say, and let the hero breathe.")


def match(text: str) -> str | None:
    """The first phrase found in text, or None. Case-insensitive, whitespace
    collapsed, substring: "I'll kill this song" is not a cry for help."""
    s = " ".join(str(text or "").split()).lower()
    if not s:
        return None
    for lang in ("en", "ru"):
        for phrase in PHRASES[lang]:
            if phrase in s:
                return phrase
    return None
