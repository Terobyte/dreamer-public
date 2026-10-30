"""Replay a saved, fixed prompt to compare latency, reasoning and validity."""

import base64
import json
from pathlib import Path


def load_messages(path):
    path = Path(path)
    messages = json.loads(path.read_text())
    for message in messages:
        content = message.get('content')
        if not isinstance(content, list):
            continue
        for i, part in enumerate(content):
            if part.get('type') != 'image_url' or 'path' not in part:
                continue
            image = (path.parent / part['path']).resolve()
            if not image.is_relative_to(path.parent.resolve()):
                raise ValueError('message image escapes the room directory')
            mime = 'png' if image.suffix.lower() == '.png' else 'jpeg'
            content[i] = {'type': 'image_url', 'name': part.get('name', image.name),
                          'image_url': {'url': 'data:image/%s;base64,%s' % (
                              mime, base64.b64encode(image.read_bytes()).decode())}}
    return messages


def percentile(values, q):
    if not values:
        return 0.0
    values = sorted(values)
    pos = (len(values) - 1) * q
    lo, hi = int(pos), min(int(pos) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (pos - lo)


def measure(spark, prompt_from, *, role, effort, n=15, room=None):
    root = Path(prompt_from)
    plan = json.loads((root / 'plan.json').read_text())
    room = room or next(iter(plan['rooms']))
    if room not in plan['rooms']:
        raise ValueError('unknown room')
    from pipe2.room import room_path
    messages = load_messages(room_path(root / 'rooms', room) / (role + '_0.messages.json'))
    answers = []
    for k in range(n):
        if getattr(spark.ledger, 'capped', False) or getattr(spark.ledger, 'closed', False):
            break
        answers.append(spark.ask(role, room, k, messages, effort))
    latency = [a.latency_s for a in answers]
    reasoning = [a.usage.get('reasoning_tokens', 0) for a in answers]
    result = {'n': len(answers), 'valid_share': sum(a.valid for a in answers) / max(1, len(answers)),
              'latency_p50': percentile(latency, .5), 'latency_p90': percentile(latency, .9),
              'reasoning_p50': percentile(reasoning, .5), 'reasoning_p90': percentile(reasoning, .9)}
    print('n  latency p50/p90 (s)  reasoning p50/p90  valid')
    print('%d  %.3f/%.3f  %.1f/%.1f  %.1f%%' % (result['n'], result['latency_p50'],
          result['latency_p90'], result['reasoning_p50'], result['reasoning_p90'], result['valid_share'] * 100))
    return result
