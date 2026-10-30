"""One diagnostic contract for providers and background workers.

Warnings remain visible without a run logger; an optional event sink also
delivers the same structured record to the run's JSONL journal.
usage: report("memory", "memory_merge_fail", error, event_sink)
"""

import logging


def report(component, kind, error, sink=None, **fields):
    event = dict(fields, type=kind, component=component, error=str(error))
    logging.getLogger(component).warning("%s: %s", kind, error)
    if sink is not None:
        sink(event)
    return event


# --- director panel (phase 2.3) ------------------------------------------
# Python folds the log into panel state; the page only draws it. One log type
# belongs to exactly one panel key -- the dictionary of the panel.
PANEL_KEYS = ("schedule", "fired", "pressure", "goals", "pov", "lock", "notes",
              "safety")
PANEL_OF_TYPE = {
    "schedule": "schedule",
    # what the code fired on its own: scheduled events, the door, a consult
    "event": "fired", "door": "fired", "consult": "fired",
    # both carry the same table by actor; only the last tick is shown
    "pressure": "pressure", "silence": "pressure",
    "goal": "goals", "judge": "goals",
    "pov": "pov",
    # the lock on a line: everything that kept a line from being spoken
    "lock_reject": "lock", "loop_cut": "lock", "turn_skip": "lock",
    "line_discarded": "lock",
    "safety_pause": "safety", "input_dropped": "safety",
    "message": "notes",            # the director's notes (fsm.py message {to, note})
}
PANEL_LIST_CAP = 200               # a long run must not grow the panel without end


def panel_state(events):
    """Fold log rows into the director panel. Unknown rows are ignored, so an
    older or newer log never breaks the panel."""
    panel = {"schedule": [], "fired": [], "pressure": {}, "goals": {}, "pov": None,
             "lock": [], "notes": [], "safety": []}
    for row in events or []:
        if not isinstance(row, dict):
            continue
        kind = row.get("type")
        key = PANEL_OF_TYPE.get(kind)
        if key is None:
            continue
        if kind == "schedule":
            panel["schedule"] = [e for e in row.get("events") or []
                                 if isinstance(e, dict)]
        elif key == "pressure":
            table = row.get("pressure")
            panel["pressure"] = {"kind": kind, "t": row.get("t"),
                                 "actors": dict(table) if isinstance(table, dict) else {}}
        elif key == "goals":
            actor = row.get("actor")
            if not actor:
                continue
            goal = dict(panel["goals"].get(actor) or {})
            if kind == "judge":
                goal["judge"] = row.get("answer")
            else:
                goal.update({k: v for k, v in row.items()
                             if k not in ("type", "actor")})
            panel["goals"][actor] = goal
        elif kind == "pov":
            if row.get("hero_owner") in ("npc", "human"):
                panel["pov"] = row["hero_owner"]
        elif kind == "message":
            panel["notes"].append({"to": row.get("to"), "note": row.get("note")})
            del panel["notes"][:-PANEL_LIST_CAP]
        else:
            panel[key].append(dict(row))
            del panel[key][:-PANEL_LIST_CAP]
    return panel
