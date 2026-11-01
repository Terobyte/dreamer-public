"""Bounded parallel repairs of findings that only appear on the merged floor."""

import copy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from pipe2.blame import SKELETON, blame_global
from pipe2.engine import blocking, green
from pipe2.merge import merge
from pipe2.room import _pretty, _prompt, _user


@dataclass
class SeamResult:
    partials: dict
    rounds: int = 0
    unresolved: dict = field(default_factory=dict)
    rolled_back: list = field(default_factory=list)
    touched: list = field(default_factory=list)


def repair_seams(ctx, partials, *, max_rounds=3):
    original = copy.deepcopy(partials)
    current = copy.deepcopy(partials)
    result = SeamResult(current)
    for attempt in range(max_rounds + 1):
        scene, _ = merge(ctx.skeleton, current, ctx.plan)
        report = ctx.engine.check_full(scene, ctx.work)
        if green(report):
            result.unresolved = {}
            return result
        grouped = blame_global(ctx.engine, ctx.work, ctx.skeleton, current, ctx.plan, blocking(report))
        result.unresolved = grouped
        owners = [r['id'] for r in ctx.skeleton.get('rooms', []) if r['id'] in grouped and r['id'] != SKELETON]
        if attempt == max_rounds or getattr(ctx.spark.ledger, 'capped', False) or not owners:
            break
        def fix(room):
            text = _prompt('seam_fix', ROOM=room, PARTIAL=_pretty(current.get(room, {})),
                           FINDINGS=_pretty(grouped[room]), SKELETON=_pretty(ctx.skeleton))
            messages = [_user(text, [])]
            ctx.store.save_messages(room, 'seam_fix', attempt, messages)
            answer = ctx.spark.ask('seam_fix', room, attempt, messages, ctx.effort.get('seam_fix', 'high'))
            if not answer.valid:
                return room, None
            ctx.store.save(room, 'seam_fix', attempt, answer.scene)
            candidate = copy.deepcopy(answer.scene)
            # Assets were closed before seams. Freeze known prompts and report new
            # keys via the queue, which will leave them as engine placeholders.
            old = (original.get(room) or {}).get('assets') or {}
            for key, spec in (candidate.get('assets') or {}).items():
                if key in old and isinstance(spec, dict):
                    spec.pop('reissue', None)
                    spec['prompt'] = old[key].get('prompt', '')
            one, violations = merge(ctx.skeleton, {room: candidate}, ctx.plan)
            if violations or not green(ctx.engine.check_full(one, ctx.work)):
                return room, None
            fresh = set(candidate.get('assets') or {}) - set(old)
            if fresh:
                ctx.assets.put(room, [k for k in ctx.engine.asset_keys(one) if k['id'] in fresh])
            return room, candidate
        with ThreadPoolExecutor(max_workers=len(owners)) as pool:
            for room, candidate in pool.map(fix, owners):
                if room not in result.touched:
                    result.touched.append(room)
                if candidate is not None:
                    current[room] = candidate
        result.rounds += 1
    for room in result.unresolved:
        # B29: only a room a seam fix touched has anything to roll back
        if room != SKELETON and room in original and room in result.touched:
            current[room] = copy.deepcopy(original[room])
            result.rolled_back.append(room)
    return result
