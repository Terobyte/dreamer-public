"""Director logic for staging scenes (мизансцена).

Generates `start` and beat `stage` directives using an LLM director,
validates against available places and poses, respects hand-authored
configurations in book.json, and caches results.
"""
import hashlib
import json
import os
from typing import Any, Callable, Dict, List, Optional, Tuple, Set

VALID_ACTIONS = {"stay", "come", "goto", "enter", "exit", "turn_away"}
DEFAULT_POSE = "stand"


def normalize_places(places: Any) -> Dict[str, Any]:
    """The bank as `{name: {room, poses, ...}}`. Accepts that, a list of places, or the
    `stage/places.json` envelope `{"places": [...], "warnings": [...]}`."""
    if isinstance(places, dict) and isinstance(places.get("places"), list):
        places = places["places"]
    if isinstance(places, list):
        return {p["name"]: p for p in places if isinstance(p, dict) and p.get("name")}
    return places if isinstance(places, dict) else {}


def compute_director_cache_key(paragraphs: List[str], places: Dict[str, Any], model_name: str = "spark-contributor",
                               beats: Optional[List[Dict[str, Any]]] = None,
                               clips: Optional[Dict[str, List[str]]] = None) -> str:
    payload: Dict[str, Any] = {
        "paragraphs": paragraphs,
        "places": places,
        "model": model_name
    }
    # the beat list and the clips change the question: a new key (an old answer without clips stays valid for old calls)
    if beats is not None or clips is not None:
        payload.update(beats=beats, clips=clips, v=2)
    dumped = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(dumped.encode("utf-8")).hexdigest()


def call_director_with_retry(
    director_fn: Callable[[str], str],
    prompt: str,
    warnings: List[str]
) -> Optional[Dict[str, Any]]:
    for attempt in range(2):
        try:
            raw = director_fn(prompt)
            if not raw or not raw.strip():
                if attempt == 0:
                    warnings.append("director returned empty response on attempt 1, retrying")
                    continue
                warnings.append("director returned empty response after retry")
                return None
            # Parse JSON: find outer braces if model included markdown fences
            text = raw.strip()
            if text.startswith("```"):
                lines = text.splitlines()
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].startswith("```"):
                    lines = lines[:-1]
                text = "\n".join(lines).strip()
            return json.loads(text)
        except Exception as exc:
            if attempt == 0:
                warnings.append(f"director returned broken JSON on attempt 1, retrying: {exc}")
                continue
            else:
                warnings.append(f"director failed after retry: {exc}")
                return None
    return None


def build_director_prompt(
    paragraphs: List[str],
    cast: List[str],
    places: Dict[str, Any],
    needed_beats: Optional[List[int]] = None,
    beats: Optional[List[Dict[str, Any]]] = None,
    clips: Optional[Dict[str, List[str]]] = None,
) -> str:
    places_info = {}
    for name, p in normalize_places(places).items():
        places_info[name] = {
            "room": p.get("room", ""),
            "poses": p.get("poses", [])
        }
    out: Dict[str, Any] = {
        "instruction": (
            "Determine staging (start placement and beat-by-beat movements) for the scene. "
            "Available actions: stay, come, goto, enter, exit, turn_away. "
            "Return JSON: {start: [{who, place, pose, offstage?: bool}], stage: [{beat_id, who, action, place?, pose?, look?}]}"
        ),
        "cast": cast,
        "places": places_info,
        "paragraphs": paragraphs,
        "needed_beats": needed_beats
    }
    if beats is not None:
        out["beats"] = [{k: b[k] for k in ("id", "kind", "who", "text") if b.get(k) is not None} for b in beats]
        out["instruction"] = (
            "Determine staging beat by beat: where everyone starts, who moves where on which beat, and what each body "
            "DOES. A children's picture-book film: when the text says someone runs, jumps, falls, sits down, laughs, "
            "hugs, climbs into a lap, the audience must SEE it, so that beat gets the matching clip. "
            "Actions: stay, come, goto, enter, exit, turn_away. `place` is a place name, or another actor's name = "
            "walk up to that actor (to hug, to sit by them, to climb into their lap). "
            "`clip` = one of THAT actor's clips (list `clips`), played once on that beat (after the walk, when there "
            "is one). `idle` = one of that actor's clips that loops afterwards until the next change (a seated clip "
            "after sitting down on the grass, a lap clip while held). Leave clip out on beats where nobody does "
            "anything new. beat_id is the `id` of a beat in `beats`. "
            "A start `idle` is what that actor is already doing when the film opens (painting at an easel). "
            "Return JSON: {start: [{who, place, pose, offstage?: bool, idle?}], "
            "stage: [{beat_id, who, action, place?, pose?, look?, clip?, idle?}]}"
        )
    if clips is not None:
        out["clips"] = clips
    return json.dumps(out, ensure_ascii=False, indent=2)


def validate_and_merge_staging(
    model_output: Optional[Dict[str, Any]],
    paragraphs: List[str],
    cast: List[str],
    places: Dict[str, Any],
    hand_start: Optional[List[Dict[str, Any]]],
    hand_stage_by_beat: Dict[int, List[Dict[str, Any]]],
    warnings: List[str],
    clips: Optional[Dict[str, List[str]]] = None,
) -> Tuple[List[Dict[str, Any]], Dict[int, List[Dict[str, Any]]]]:
    if model_output is not None and not isinstance(model_output, dict):
        warnings.append("staging: model output is not a dict, ignored")
        model_output = None
    places = normalize_places(places)
    cast_set = set(cast) if cast else None
    valid_places = set(places.keys())

    # 1. Start positions
    final_start: List[Dict[str, Any]] = []
    hand_start_who = set()
    if hand_start:
        for st in hand_start:
            who = st.get("who")
            if who:
                hand_start_who.add(who)
                final_start.append(dict(st))

    if hand_start is None and model_output and "start" in model_output and isinstance(model_output["start"], list):
        for st in model_output["start"]:
            if not isinstance(st, dict):
                continue
            who = st.get("who")
            if not who:
                continue
            if cast_set is not None and who not in cast_set:
                warnings.append(f"start: unknown actor '{who}' ignored")
                continue
            if who in hand_start_who:
                # hand-authored wins
                continue

            place = st.get("place")
            pose = st.get("pose", DEFAULT_POSE)
            offstage = bool(st.get("offstage", False))

            if place not in valid_places:
                warnings.append(f"start: place '{place}' for actor '{who}' not in places bank")
                # place remains or stays, but pose checked against place
            if place in valid_places:
                avail_poses = places[place].get("poses", [])
                if avail_poses and pose not in avail_poses:
                    pose = DEFAULT_POSE

            entry = {"who": who, "place": place, "pose": pose}
            if offstage:
                entry["offstage"] = True
            idle = st.get("idle")
            if idle and clips is not None and idle in (clips.get(who) or []):
                entry["idle"] = idle
            elif idle:
                warnings.append(f"start: idle '{idle}' is not a clip of '{who}' -> dropped")
            final_start.append(entry)

    # 2. Stage beats
    final_stage: Dict[int, List[Dict[str, Any]]] = {}

    # Gather hand-authored beats
    for beat_id, st_list in hand_stage_by_beat.items():
        final_stage[beat_id] = [dict(s) for s in st_list]

    if model_output and "stage" in model_output and isinstance(model_output["stage"], list):
        for st in model_output["stage"]:
            if not isinstance(st, dict):
                continue
            beat_id = st.get("beat_id", 0)
            try:
                beat_id = int(beat_id)
            except (ValueError, TypeError):
                beat_id = 0

            who = st.get("who")
            if not who:
                continue
            if cast_set is not None and who not in cast_set:
                warnings.append(f"beat {beat_id}: unknown actor '{who}' ignored")
                continue

            # Check if hand-authored entry exists for (beat_id, who)
            existing_for_beat = final_stage.setdefault(beat_id, [])
            if any(e.get("who") == who for e in existing_for_beat):
                continue

            action = st.get("action", "stay")
            if action not in VALID_ACTIONS:
                warnings.append(f"beat {beat_id}: unknown action '{action}' for '{who}' -> fallback to stay")
                action = "stay"

            place = st.get("place")
            pose = st.get("pose")
            look = st.get("look")

            # walking up to another actor: `place` is that actor's name (come / goto only)
            to_actor = action in ("come", "goto") and cast_set is not None and place in cast_set
            if to_actor and place == who:
                warnings.append(f"beat {beat_id}: '{who}' goes to herself -> stay")
                action, place, to_actor = "stay", None, False
            # Check mandatory place
            if action in ("come", "goto", "enter") and not to_actor:
                if not place or place not in valid_places:
                    warnings.append(f"beat {beat_id}: action '{action}' requires valid place in bank, got '{place}' -> stay")
                    action = "stay"
                    place = None

            if action == "turn_away":
                # place not needed
                place = None

            # Validate pose if place is known
            if place and place in valid_places and pose:
                avail_poses = places[place].get("poses", [])
                if avail_poses and pose not in avail_poses:
                    pose = DEFAULT_POSE

            # Validate look
            if look:
                target_valid = (look in valid_places) or (cast_set is None or look in cast_set)
                if not target_valid:
                    warnings.append(f"beat {beat_id}: unknown look target '{look}' -> look dropped")
                    look = None

            item: Dict[str, Any] = {"who": who, "action": action}
            if place:
                item["place"] = place
            if pose:
                item["pose"] = pose
            if look:
                item["look"] = look
            # a clip the director names must be one of this actor's (another actor's clip on her rig is garbage)
            for key in ("clip", "idle"):
                c = st.get(key)
                if not c:
                    continue
                if clips is not None and c in (clips.get(who) or []):
                    item[key] = c
                else:
                    warnings.append(f"beat {beat_id}: {key} '{c}' is not a clip of '{who}' -> dropped")

            existing_for_beat.append(item)

    return final_start, final_stage


def _cache_path(cache_dir: str, key: str) -> str:
    return os.path.join(cache_dir, "stage_%s.json" % key)


def run_staging(
    book_dir: str,
    paragraphs: List[str],
    cast: List[str],
    places: Optional[Dict[str, Any]],
    scene: Dict[str, Any],
    director: Optional[Callable[[str], str]],
    warnings: List[str],
    cache_dir: Optional[str] = None,
    beats: Optional[List[Dict[str, Any]]] = None,
    clips: Optional[Dict[str, List[str]]] = None,
) -> Tuple[List[Dict[str, Any]], Dict[int, List[Dict[str, Any]]]]:
    """One director call per scene; hand-authored `start`/`stage` of the scene win.

    The model is called only when the scene lacks `start` or `stage`. Answers are
    cached by sha256(paragraphs + places + model) in `cache_dir` when it is given."""
    places = normalize_places(places)
    # a field that is present in book.json wins even when empty
    hand_start = list(scene["start"]) if isinstance(scene.get("start"), list) else None
    has_stage = isinstance(scene.get("stage"), dict)
    hand_stage: Dict[int, List[Dict[str, Any]]] = {}
    for k, v in (scene.get("stage") or {}).items():
        try:
            hand_stage[int(k)] = list(v) if isinstance(v, list) else [v]
        except (TypeError, ValueError):
            warnings.append("stage: bad beat id %r in book.json ignored" % (k,))
    output = None
    need_model = director is not None and (hand_start is None or not has_stage)
    if need_model:
        key = compute_director_cache_key(paragraphs, places, "spark-contributor", beats=beats, clips=clips)
        path = _cache_path(cache_dir, key) if cache_dir else None
        if path and os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as f:
                    output = json.load(f)
            except (OSError, ValueError):
                output = None
        if output is None:
            prompt = build_director_prompt(paragraphs, list(cast or []), places, beats=beats, clips=clips)
            output = call_director_with_retry(director, prompt, warnings)
            if output is not None and path:
                os.makedirs(cache_dir, exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(output, f, ensure_ascii=False)
    return validate_and_merge_staging(
        output, paragraphs, list(cast or []), places, hand_start, hand_stage, warnings, clips=clips)
