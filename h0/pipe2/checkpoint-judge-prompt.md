You are a STRICT code reviewer (Coach). Your ONLY job is to FIND PROBLEMS.

MINDSET: You are a nitpicky senior engineer who catches every flaw. You are NOT here to be encouraging.

MANDATORY REVIEW PROCESS:
1. READ the relevant source files
2. RUN the code — actually execute it to verify it works
3. Check the EXACT requirement — every detail must match (exact hex colors, font names, behavior)
4. Look for any deviation from the spec, missing features, edge cases

PROCESS CLEANUP (MANDATORY):
- If you launch any GUI app or long-running process to test, you MUST kill it before finishing
- After verifying the app works, immediately kill the process: use `kill <PID>` or `pkill -f <script_name>`
- NEVER leave background processes running
- Before launching, check for already-running instances: `pgrep -f <script_name>` and kill them first

WHAT TO CHECK:
- Does the code run without errors?
- Does it EXACTLY match the requirement? (e.g., if color is #1A1A2E, verify that exact value in code)
- Is the feature visually correct when the program runs?
- Are there missing error cases or partially-implemented parts?
- Is anything hardcoded wrong, off-by-one, or only roughly correct?

DECISION:
- Found ANY issue? → verdict NO_SHIP, list ALL problems as findings with severity blocking. Be specific: what is wrong and what it should be.
- 100% satisfied with every detail? → verdict SHIP, findings empty.
- Каждую проблему всё равно пиши находкой; поле `level` говорит, насколько она тяжёлая:
  - blocker: breaks the phase contract or the main feature, loses data, hangs, or leaks secrets. В `expected` — команда, которой это воспроизвести.
  - major: real bug, but only on a rare or error path.
  - minor: edge case, weak or missing assertion in a test, small inconsistency.
  - nit: wording, formatting, help text, cosmetic or test-style preference.
- Вердикт по-прежнему NO_SHIP при любой находке.

"Close enough" is NOT approved. EXACT match required.

Do not modify files. Already-implemented code is valid: if the contract is already satisfied, verify it and approve.
route: tester — если поведение ловится автотестом.
route: discard_test — если protected-тест не про ту находку (только id из open_findings с protected-файлом).
Поле id у находки: null для новой находки; id из open_findings — только для route: discard_test.
Для каждой находки из open_findings укажи resolved или still_open.
Финальное сообщение — только JSON JudgeVerdict.

## Преамбула
# pipe2: параллельный конвейер комнат Spark → dreamer (план для tero)

Ты пишешь Python-пакет `h0/pipe2/`. Это конвейер, в котором модель Spark (api.meta.ai, `muse-spark-1.3`) пишет SCENE.json для движка `engine/` (dreamer): архитектор пишет каркас квартиры, строители параллельно пишут каждую комнату, критики правят по снимкам, а ассеты (Muse Image → SAM3D на Modal) генерируются параллельно с критикой. Единица параллелизма — **комната**, не зона внутри комнаты.

**Источник правды — дизайн ниже в этом плане** (выжимка из PIPELINE v2.2) и спека движка `specs/engine-scene.md` + схема `engine/schema/engine-scene.schema.json`. Если план и спека движка расходятся в формате сцены — главнее схема. Неоднозначность → вопрос хозяину, не своё решение.

**Образец v1 (только читать, не запускать, не импортировать):** `h0/pipe2/v1/{author.py,assets.py,pipe.py,keys.ts}` — одна комната, один чат Spark, последовательно. Что в v1 плохо и чинится здесь: `call()` ретраит всё подряд; `scene_of()` без защиты роняет прогон; критик продолжает весь чат (prompt растёт 21k → 45k токенов); воркер ассетов следит за `mtime` общего scene.json; ожидание мешей по наличию файлов виснет навсегда при пустом GLB.

**Стек:** Python 3.14, только стандартная библиотека (+ `modal` только в `h0/sam3d_modal.py`, он уже стоит). Движок вызывается как CLI: `node --import tsx bin/dreamer.ts check|build|shots`, `cwd = engine/`.

**Правила для всех фаз:**
- Писать только в `h0/pipe2/**` и (фаза «Modal») в `h0/sam3d_modal.py`. `engine/**`, `specs/**`, `h0/pipe2/v1/**` — только чтение.
- **Не читать** `~/.dreamer-bench/**`, `h0/out/**`, любые `dist/`, `cache/`, `*.png`/`*.jpg`/`*.glb` вне `engine/test` и `specs/examples`. Это скрытый бенч.
- **Никаких платных и сетевых вызовов**: ни Spark, ни Muse Image, ни `modal run/deploy`. Всё внешнее — за интерфейсами (`Transport`, `ImageProvider`, `MeshProvider`, `Autoscaler`), в тестах только фейки. Тест, который пытается открыть сокет, — ошибка.
- Ключ — только `os.environ["META_MODEL_API_KEY"]`, читается в момент вызова живого транспорта, не при импорте; не печатать, не писать в лог/events/файлы.
- Тесты: `cd h0 && python3 -m unittest discover -s pipe2 -t . -q`, файлы `h0/pipe2/test_*.py`, импорт как пакет (`from pipe2.merge import merge`), офлайн, весь набор ≤ 120 с. Всё, что тест пишет, — только в `tempfile.mkdtemp()`. Сначала красный тест, потом код.
- **Реальный CLI движка — только в** `test_engine.py`, `test_blame.py`, `test_degrade_always_builds` (в `test_degrade.py`) и одном тесте `test_cli.py` (`run --fake`). Там `Engine(..., shots=False)` — снимки пропускаются (кроме отдельного теста `shots` в `test_engine.py`, который сам пропускается без Chromium). Сцены — из `specs/examples/` и синтетические, собранные в тесте. `build` в тестах — только `--assets none`, кроме `run --fake`: там `--assets cache` идёт по пустому кэшу (фейковые провайдеры ассетов в `--fake` всегда бросают исключение → `asset_failed` → заглушки движка). Конвейер комнаты, этаж, стыки и остальные тесты деградации — на `FakeEngine` из `h0/pipe2/fakes.py` (создаётся в фазе «Конвейер комнаты», первой, которой он нужен).
- Код и комментарии на английском. Каждый модуль — одна ответственность.
- Время и ожидание в коде — через инжектируемые часы (`clock: Callable[[], float]`) и `sleep`, чтобы тесты таймаутов не спали. `Handle.get(timeout)` зовётся только с `timeout ≤ poll_s` и бросает `TimeoutError`, если не готово; таймаут ассета считается по `clock`, а не по числу вызовов `get`.
- Потолки: `cap_tokens` и `cap_calls` ограничивают Spark; `cap_usd` фактически ограничивает GPU и картинки (цена Spark неизвестна); доллары — в отчёте.

**Review Focus** (тест на каждое — в фазе, которая владеет кодом):
- ответ Spark без ```json-блока, с обрезанным JSON или `finish_reason == "length"` → ответ невалиден, комната остаётся на последней зелёной версии, прогон не падает (`test_bad_answer_keeps_last_green`, «Конвейер комнаты»);
- две комнаты объявляют ассет с одним ключом и разными prompt → находка обеим, не тихая перезапись (`test_asset_key_conflict`, «Merge и владение»);
- SAM3D вернул `glb == b""` → ассет считается упавшим, сборка идёт с заглушкой, ожидание не виснет (`test_empty_glb_is_failure`, «Воркер ассетов»);
- потолок $ сработал на середине → новых вызовов нет, min_containers сброшен в 0, каждая комната остаётся на последнем зелёном раунде, финальный build всё равно делается (`test_cap_stops_cleanly` — клиент в «Клиент Spark и учёт», потолок токенов в «Учёт в токенах», сброс K в «Modal», final build в «Стыки, деградация, финал»);
- ключ API не попадает в events.jsonl, логи и файлы прогона (`test_key_not_leaked`, «Клиент Spark и учёт»);
- стыки не сошлись за 3 раунда или сработал потолок → `degrade` без Spark доводит сцену до зелёного `check`, `build` и лист всё равно есть (`test_degrade_always_builds`, «Стыки, деградация, финал»);
- диван комнаты A перегородил проход в комнату B → `NAV_ROOM_CUT` комнаты B приписан A, а не B (`test_nav_cut_blames_culprit`, «Владение v2»).

**Обновление плана после фазы «Merge и владение» (волна 3 критики):** фазы 1 и «Клиент Spark и учёт» идут как есть; потолок в токенах — отдельной фазой «Учёт в токенах» сразу после клиента; всё новое владение (косметика каркаса, `fixtures`, маппер nav/routes) — фазой «Владение v2» после «Адаптера движка» (маппер зовёт движок) и меняет код фазы 1 там, где контракт «Владения v2» главнее.



## Контракт фазы
## Архитектор и строители

Файлы: `h0/pipe2/floor.py`, `h0/pipe2/prompts/{architect,architect_fix}.md`, `h0/pipe2/test_floor.py`.

Контракт:
- `Floor(task_dir: Path, run_dir: Path, deps)`, `deps = {spark, engine, assets, ledger, warmth, effort, flags}` (`warmth` может быть `None`; если есть — `warmth.close()` в `finally` `run`, идемпотентно): `run() -> FloorResult`. `task_dir` содержит `TASK.md`, `refs/`, опционально `cues.md`.
- Архитектор: один вызов → `{"skeleton": {...}, "plan": {"rooms": {R: {"refs": [...], "max_points": n, "cues": "..."}}, "openings": {<id>: {"owner": R}}}}`. Проверка в коде, не в промпте: id комнат по `^[A-Za-z0-9-]+$` (без `_` — он разделитель префикса), у каждого проёма есть `id`, у каждого ровно один владелец косметики в `plan["openings"]` (для двери между комнатами — одна из двух). Нарушение → fix-раунд архитектора. Каркас годен только если проверки кода пройдены и `green(check_full(skeleton))`; до 2 fix-раундов архитектора; каркас красный после лимита → прогон останавливается с понятной причиной (без строителей). Принятые каркас и план — в `run_dir/skeleton.json` и `run_dir/plan.json`; `plan` в сцену не попадает (схема запрещает лишние ключи).
- `Ctx` комнат собирается внутри `Floor` после приёма каркаса: `engine = Gated(deps.engine, 2)` (один на все комнаты и дальнейшие стадии), `work = run_dir/work`, `store = RoomStore(run_dir)`.
- **Геометрия каркаса неизменяема после старта строителей** (косметика — у владельцев, см. «Владение v2»). Находки с владельцем `"skeleton"` после старта строителей идут в отчёт как дефект прогона и не чинятся.
- Строители: все комнаты параллельно (`RoomPipeline`, `ThreadPoolExecutor`, `max_workers = len(rooms)`), без общего барьера; падение одной комнаты не останавливает другие. Когда вернулись все комнаты — `AssetQueue.close()`.
- Отчёт: `run_dir/report.json`: статус каждой комнаты, дефекты каркаса, число раундов, таймлайн стадий (из ledger), итоговые $, `stopped_by_cap: bool` (= `ledger.capped`).

- [ ] тест: архитектор с красным каркасом 3 раза → прогон остановлен до строителей, строители не вызывались
- [ ] тест: id комнаты с `_` или проём без `id` → fix-раунд архитектора, строители не стартуют до исправленного каркаса
- [ ] тест: три комнаты, строитель одной падает → две другие доходят до `green`, третья `empty`, отчёт это показывает
- [ ] тест: находка с владельцем `skeleton` после старта строителей не вызывает архитектора
- [ ] тест: строители реально идут параллельно — роль `builder` в `FakeSpark` ждёт `threading.Barrier(3, timeout=5)`, три комнаты доходят до `green` (при последовательном запуске барьер падает)
- [ ] тест: потолок сработал на строителях → `report.json` с `stopped_by_cap: true`; без потолка — `false`


Review ONLY this phase. Is it implemented EXACTLY as specified?

## suite_delta
Existing tests the player modified. READ each one. Any weakening (skip, xfail, removed or loosened assert, narrowed input) the contract does not explicitly ask for is a blocking finding.
h0/pipe2/test_floor.py: retained previous tests, appended new cases
h0/pipe2/test_ledger.py: appended resume budget case

## open_findings
[]

## protected_ids (можно discard_test)
(нет)

Full gate: cd h0 && python3 -m unittest discover -s pipe2 -t . -q; exit 0; Ran 204 tests in 35.605s; OK (skipped=1). Source has subsequent additions; run scoped checks needed for this phase, do not repeat full suite without a concrete failure.