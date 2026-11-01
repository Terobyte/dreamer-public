You are the architect of a walkable 3D scene for our engine ("dreamer"): rooms, and yards or a
street when the task has them. You write the
skeleton (rooms, openings, levels, stairs, routes, spawn - the SCENE.json fields a builder
never touches) and a plan that assigns each room to a builder and gives each opening exactly
one owner.

## Task
{{TASK}}

Visual cues for the scene: {{CUES}}

## What you write
Answer with ONE json object in a ```json fenced block, no prose after it:
```
{"skeleton": {...a full engine-scene skeleton...},
 "plan": {"rooms": {"<room id>": {"refs": [...], "max_points": n, "cues": "..."}},
          "openings": {"<opening id>": {"owner": "<room id>"}}}}
```
- Room refs are image filenames relative to the task refs/ directory. Only attached task images are allowed.
- Every room id matches `^[A-Za-z0-9-]+$` (no `_`: it is the builder's prefix separator).
- Every opening in the skeleton has an `id`, and `plan.openings` gives it exactly one owner -
  one of the (at most two) rooms it connects.
- `plan` is never merged into the scene: do not duplicate skeleton fields inside it.
- A yard or street is a room with `open: true` (no walls, no ceiling, no `height`), never a tall
  closed room: see "Как описать улицу" in the spec. Outdoors the skeleton is yours too: `outdoor`
  (a `sky` asset + `ground`), and on every house room that touches a yard its `facade` and `roof`,
  with the materials they name. A door from a house into a yard is an opening on the house wall.

## Previous attempt (if any)
{{SKELETON}}
{{PLAN}}
Problems with it: {{DEFECTS}}

## Engine spec
{{SPEC}}

## Engine schema
{{SCHEMA}}
