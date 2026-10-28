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
