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


def compute_director_cache_key(paragraphs: List[str], places: Dict[str, Any], model_name: str = "spark-contributor") -> str:
    payload = {
        "paragraphs": paragraphs,
        "places": places,
        "model": model_name
    }
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
    needed_beats: Optional[List[int]] = None
) -> str:
    places_info = {}
    for name, p in (places or {}).items():
        places_info[name] = {
            "room": p.get("room", ""),
            "poses": p.get("poses", [])
        }
    return json.dumps({
        "instruction": (
            "Determine staging (start placement and beat-by-beat movements) for the scene. "
            "Available actions: stay, come, goto, enter, exit, turn_away. "
            "Return JSON: {start: [{who, place, pose, offstage?: bool}], stage: [{beat_id, who, action, place?, pose?, look?}]}"
        ),
        "cast": cast,
        "places": places_info,
        "paragraphs": paragraphs,
        "needed_beats": needed_beats
    }, ensure_ascii=False, indent=2)


def validate_and_merge_staging(
    model_output: Optional[Dict[str, Any]],
    paragraphs: List[str],
    cast: List[str],
    places: Dict[str, Any],
    hand_start: Optional[List[Dict[str, Any]]],
    hand_stage_by_beat: Dict[int, List[Dict[str, Any]]],
    warnings: List[str]
) -> Tuple[List[Dict[str, Any]], Dict[int, List[Dict[str, Any]]]]:
    places = places or {}
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

    if model_output and "start" in model_output and isinstance(model_output["start"], list):
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

            # Check mandatory place
            if action in ("come", "goto", "enter"):
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

            existing_for_beat.append(item)

    return final_start, final_stage
