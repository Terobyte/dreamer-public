# Карта кода: камера, полоса B v2 (хозяин переносит в feature_map.md при слиянии)

## §2 модули
- `h0/make/shotplan.py` — стадия `shotplan`: Spark выбирает приём и субъекта на бит → `shotplan/moves.json` (`catalog()`, `allowed()`, `prompt()`, `parse()`, `run_shotplan()`).

## §3 нужно X — используй Y
- Нужен список разрешённых приёмов камеры → `shotplan.allowed(cat)`; каталог → `shotplan.catalog()` (мост `bin/moves.ts --catalog`).
- Нужно проверить ответ Spark про камеру → `shotplan.parse(scene, cat, score)`.
- Нужен стиль камеры в страницу/плёнку → `--camera-style` у `make` и `make.film`, `film.page_url(..., camera_style)`.
- Нужно разбить critic.jsonl на планы → `critic.shots()` (поля `dcut`/`shot`, иначе старая эвристика).
