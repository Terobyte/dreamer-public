# Pipe2 paused checkpoint — 2026-10-29

Paused at the owner's request. This is a backup checkpoint, not a SHIP verdict.
Base: `848de61` (`tero/tero-pipe2`). The original staged Tero phase is preserved separately on `codex/tero-phase7-original-checkpoint`.

## State

- Phase 7 (architect and builders): implementation preserved and extended. Independent judge used the real Tero `judge_prompt` from `src/loop/prompts.py`. Verdict: **NO_SHIP**.
- Judge findings still open: `lights: null` can crash skeleton validation; an extra malformed `plan.rooms` entry can crash ref resolution; `on.az` on a shared curved edge is not handled.
- Phases 8–10: draft implementations and tests are preserved for seams/degradation/final build, GPU lifecycle, and CLI/measure/resume. They have **not** passed independent phase judges.
- Last completed full run: `cd h0 && python3 -m unittest discover -s pipe2 -t . -q`: 211 tests, OK, 1 skipped, 132.102 seconds. This exceeds the plan's 120-second target under that run's concurrent load.
- A subsequently added regression is RED: `pipe2.test_degrade.DegradeTest.test_dependents_in_other_rooms_are_removed_too`. Degradation currently removes dependent props only in the same room; dependencies in other rooms need fixing.
- No paid generation, model API calls, Modal deployments or GPU runs were performed during this continuation.

## Resume

Start with phase 7's three judge findings, rerun `pipe2.test_floor`, and obtain a new phase-7 verdict with Tero's judge prompt. Then review phases 8, 9 and 10 separately, fixing each until SHIP. Do not treat later drafts as already approved.

Local implementation checkpoint: `/private/tmp/dreamer-pipe2-finish`.
The existing `meta` and `meta-world` worktrees were not overwritten.
