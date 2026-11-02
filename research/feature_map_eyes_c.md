# feature_map, полоса C «Глаза» (переносит хозяин коммитом слияния)

## §2 модули

| модуль | что делает |
|---|---|
| `h0/make/story.py:run_story` | `build_places(world/run)` → `score_scene(places)`; без `world/run` → `places=None` + `story: no world, staging without places` в `warnings` (ручная `score.edited.json` берётся дословно) |

## §3 нужно X — используй Y

| нужно | используй |
|---|---|
| места для партитуры (story/stage) | `stage.build_places(run_dir/"world"/"run")` — один вход `world/run` (`scene.json`, `dist/geometry.json`, `dist/nav.json`), тот же словарь `{places, warnings}` |
| зависимости story | `core.default_stages()["story"].deps == ("refs", "world")` (версия 3), хеш входа story включает выход world через правило предков |

## §3 нужно X — используй Y (Г5)

| Нужно | Используй |
|---|---|
| проп-контейнер рисуется целиком с содержимым; проп на нём не выносится | `pipe2.floor.attach_refs` (`CONTAINERS`, `ref.mode=redraw`, предупреждения `CONTAINED` → `FloorResult.warnings` → `report.json`) |
