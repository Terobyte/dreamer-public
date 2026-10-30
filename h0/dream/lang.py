"""One language switch for the whole dream (design doc 2026-10-28, 7.2 row 1.5).

The spike is ungated and must leave `en` untouched, so the switch is a late-read
module attribute, never a `from lang import LANG` copy: the prompt constants and
the regexes of dialogue.py are built at import time, while `--lang` arrives from
argv. Read it as `lang.LANG` / call `lang.lang_text(...)` at call time.

`lang_text` swaps the "English only" sentences of the hero, actor, director and
judge rules; the English wording stays the constant everything else imports.
"""

LANG = "en"
LANGS = ("en", "ru")

# left side: the exact English sentences of dialogue.py / director.py
RU_SWAP = (
    ("English only", "Russian only: every spoken word in Cyrillic, no English"),
    ("The lines are English.", "The lines are Russian."),
    (" English.", " Russian: write every value in Cyrillic."),
)


def set_lang(name):
    """Set the dream's language; anything unknown stays `en` (the spike may not
    silently ship a third language into a gated bench)."""
    global LANG
    LANG = name if name in LANGS else "en"
    return LANG


def lang_text(text):
    """The rules in the current language; at `en` the text itself, unchanged."""
    if LANG != "ru" or not text:
        return text
    for en, ru in RU_SWAP:
        text = text.replace(en, ru)
    return text
