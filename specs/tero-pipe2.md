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
- Тесты, которые зовут движок, используют реальный CLI движка на сценах из `specs/examples/` и на синтетических сценах, собранных в тесте. `build` в тестах — только `--assets none`.
- Код и комментарии на английском. Каждый модуль — одна ответственность.
- Время в коде — через инжектируемые часы (`clock: Callable[[], float]`), чтобы тесты таймаутов не спали.

**Review Focus** (тест на каждое — в фазе, которая владеет кодом):
- ответ Spark без ```json-блока, с обрезанным JSON или `finish_reason == "length"` → ответ невалиден, комната остаётся на последней зелёной версии, прогон не падает (`test_bad_answer_keeps_last_green`);
- две комнаты объявляют ассет с одним ключом и разными prompt → находка обеим, не тихая перезапись (`test_asset_key_conflict`);
- SAM3D вернул `glb == b""` → ассет считается упавшим, сборка идёт с заглушкой, ожидание не виснет (`test_empty_glb_is_failure`);
- потолок $ сработал на середине → новых вызовов нет, min_containers сброшен в 0, каждая комната остаётся на последнем зелёном раунде, финальный build всё равно делается (`test_cap_stops_cleanly`);
- ключ API не попадает в events.jsonl, логи и файлы прогона (`test_key_not_leaked`).

## Merge и владение

Чистые функции, без сети и без движка.

Файлы: `h0/pipe2/merge.py`, `h0/pipe2/geom.py`, `h0/pipe2/test_merge.py`.

Контракт:
- Каркас (`skeleton: dict`) — валидная по схеме сцена без `props`, `decals`, `cameras`, point-ламп: `version, name, levels, rooms, openings, stairs, spawn, style, materials, assets` (tile-ассеты), `lights` (только `hemi`), `routes` (только waypoint-ы комнат/проёмов).
- Частичный JSON комнаты R (`partial: dict`) содержит только ключи `props, decals, lights, cameras, assets, materials`. Любой другой ключ — нарушение.
- `merge(skeleton: dict, partials: dict[str, dict], plan: dict) -> tuple[dict, list[dict]]` возвращает смёрженную сцену и список нарушений `{"owner": R, "code": str, "msg": str, "path": str}`. Нарушения не бросают исключение. Объект-нарушитель в сцену не попадает (кроме дедупа ассетов). Коды нарушений (свои, не движка): `OWN_ROOM` (`props[].room`/`decals[].room`/`on.room` ≠ R), `OWN_LIGHT_OUTSIDE` (point-лампа вне полигона/круга R по `pos[0], pos[2]`), `OWN_LIGHT_BUDGET` (ламп больше `plan["rooms"][R]["max_points"]`, лишние отбрасываются с конца), `OWN_HEMI` (hemi у строителя — вырезается), `OWN_PREFIX` (`props[].id`, `cameras[].id`, ключи `assets` и `materials` без префикса `R_`), `OWN_ASSET_CONFLICT` (тот же ключ ассета, разный `prompt` — обоим владельцам), `OWN_KEY` (лишний ключ верхнего уровня).
- Одинаковый ключ ассета с одинаковым `prompt` — дедуп, без нарушения.
- Порядок в результате детерминирован: комнаты в порядке `skeleton["rooms"]`, внутри комнаты — порядок частичного JSON.
- `owner_of(scene: dict, issue: dict) -> str | None` — владелец находки движка `check` по `issue["path"]` (JSON-pointer по индексу): `/props/i…` → `props[i].room`, `/decals/i…` → `room` или `on.room`, `/lights/i…` → комната, в чьём полигоне `pos`, `/cameras/i…` → по префиксу id, `/rooms/i` → `rooms[i].id`, `/openings…`, `/stairs…`, `/levels…`, `/spawn…`, путь без индекса и находки без `path` (`ID_DUPLICATE` с `v`, `ROOMS_OVERLAP` с `a`/`b`) → `"skeleton"`. Префикс id — до первого `_`, сопоставляется с id комнат.
- `split_owners(scene, issues) -> dict[str, list[dict]]`. Если находка `PROP_HITS_PROP` (или любой код с `a`/`b` по двум пропсам) затрагивает пропсы двух комнат, она попадает обоим.
- `geom.py`: `in_room(room: dict, x: float, z: float) -> bool` для `shape` (полигон, граница включительно, EPS 1e-6) и `circle`.

- [x] тест: `specs/examples/demo.scene.json` разрезан в тесте на каркас и частичные JSON по комнатам (с префиксами id, добавленными тестом) → `merge` даёт сцену, у которой те же объекты, что у исходной (с точностью до переименования), без нарушений
- [x] тест: каждое из нарушений `OWN_*` ловится на синтетическом частичном JSON, объект-нарушитель выкинут, остальные объекты комнаты на месте
- [x] тест `test_asset_key_conflict` и тест дедупа одинакового prompt
- [x] тест: `owner_of` на каждой форме пути из контракта, включая `ID_DUPLICATE` и `ROOMS_OVERLAP` → `"skeleton"`
- [x] тест: `split_owners` отдаёт межкомнатную пару обоим владельцам
- [x] тест: `in_room` на полигоне (внутри, снаружи, на ребре, в вершине) и круге

## Клиент Spark и учёт

Файлы: `h0/pipe2/spark.py`, `h0/pipe2/ledger.py`, `h0/pipe2/test_spark.py`, `h0/pipe2/test_ledger.py`.

Контракт:
- `Transport` — протокол `post(body: dict, timeout: float) -> dict` (сырой JSON ответа `/v1/chat/completions`); исключения `TransportError(status: int | None, retryable: bool)`. `HttpTransport` — живая реализация на `urllib` (`https://api.meta.ai/v1/chat/completions`), в тестах не вызывается; ключ берёт при каждом `post`.
- `Spark(transport, ledger, *, model="muse-spark-1.3", clock=time.time, sleep=time.sleep)`; `ask(role: str, room: str, round_no: int, messages: list, effort: str) -> Answer`. `body`: `model`, `reasoning_effort=effort`, `max_tokens=64000`, `messages`. `Answer = {text, finish_reason, usage, latency_s, valid: bool, scene: dict | None, error: str | None}`.
- Ретраи: только `TransportError` с `retryable=True` (429, 5xx, обрыв соединения/таймаут сокета), максимум 2, пауза `20 * attempt + jitter(0..5)` через инжектируемый `sleep`. 4xx (кроме 429) — без ретрая, `valid=False`.
- Разбор: `parse_scene(text) -> dict` — последний ```json-блок, иначе первый `{`; любые ошибки → `ValueError`. `ask` ловит его: `valid=False`, `error` с причиной. `finish_reason != "stop"` → `valid=False`.
- `Ledger(path: Path, prices: dict, cap_usd: float, cap_calls: int)`: `record(event: dict)` дописывает строку в `events.jsonl` (поля: `ts, kind, role, room, round, effort, latency_s, prompt_tokens, completion_tokens, reasoning_tokens, finish_reason, valid, cost_usd`); `charge(kind, units)`; `allow(kind, estimate_usd) -> bool` — до вызова: `spent + estimate > cap_usd` или `calls >= cap_calls` → `False` и событие `cap_hit` (один раз). `prices` — из `h0/pipe2/prices.json`: `{"spark": {"<effort>": {"in": ..., "out": ...}}, "image": ..., "h100_s": ...}` за 1M токенов / за штуку / за секунду; неизвестная цена Spark = `null` → стоимость считается 0, но `calls` всё равно ограничены.
- `Spark.ask` проверяет `ledger.allow` до вызова; `False` → `Answer(valid=False, error="cap")` без вызова транспорта.

- [x] тест: 429, 503 и обрыв → ретрай до 2 раз, третий отказ → `valid=False`; 400 → ни одного ретрая (считается число вызовов фейкового транспорта)
- [x] тест: `finish_reason="length"`, текст без JSON, обрезанный JSON → `valid=False` с причиной, без исключения
- [x] тест: `body` содержит `max_tokens=64000` и переданный effort
- [x] тест: `events.jsonl` получает строку на каждый вызов с полями контракта; стоимость считается по `prices`
- [x] тест `test_cap_stops_cleanly` (часть клиента): после срабатывания потолка транспорт больше не вызывается, событие `cap_hit` одно
- [x] тест `test_key_not_leaked`: фейковый ключ в env не появляется в events.jsonl и в `repr`/`str` ответов

## Адаптер движка

Файлы: `h0/pipe2/engine.py`, `h0/pipe2/keys.ts`, `h0/pipe2/test_engine.py`.

Контракт:
- `Engine(engine_dir: Path)`: `check(scene: dict, work: Path, built: Path | None = None) -> Report`, `build(scene: dict, out: Path, assets: str, cache: Path | None) -> None`, `shots(dist: Path, size="960x720") -> None`, `asset_keys(scene: dict) -> list[dict]` (через `h0/pipe2/keys.ts` — та же логика, что `v1/keys.ts`, но импорт движка относительный от `h0/pipe2/`: `{id, kind, key, prompt, size}`).
- `Report = {code: int, errors: list[dict], warnings: list[dict], raw: str}` — из JSON-отчёта `--report`; `code` = код выхода CLI.
- Сцена пишется во временный файл внутри `work`, не рядом с движком.
- `scene_for_room(skeleton, partials, plan, room) -> dict` — `merge` каркаса и только частичного JSON комнаты `room` (это сцена для `check` комнаты, без маскирования соседями).

- [ ] тест: `check` на `specs/examples/demo.scene.json` → `code == 0`
- [ ] тест: `check` на синтетической сцене с пропсом в дверном проёме → в `errors` есть `PROP_IN_DOORWAY`, `owner_of` указывает на нужную комнату
- [ ] тест: `asset_keys` на demo совпадает по ключам с тем, что `build --assets none` кладёт в отчёт/кэш (или с `engine/src/assets/cache.ts` `cacheKey`, вызванным через tsx)
- [ ] тест: `build --assets none` + `scene_for_room` даёт `dist/index.html`; снимки (`shots`) — только если в окружении есть Chromium движка, иначе тест пропускается с причиной

## Конвейер комнаты

Файлы: `h0/pipe2/room.py`, `h0/pipe2/prompts/{builder,fix,critic_layout,critic_assets}.md`, `h0/pipe2/test_room.py`.

Контракт:
- `RoomPipeline(room: str, ctx: Ctx)`, где `Ctx` несёт `skeleton, plan, spark, engine, assets (AssetQueue), store (RoomStore), effort: dict[role, str], flags`. `run() -> RoomResult {room, status: "green"|"rolled_back"|"empty", rounds, partial}`.
- Шаги: строитель → `merge` → `check` сцены комнаты → до 2 fix-раундов → ключи ассетов в очередь → `build --assets none` → `shots` → критик раскладки → `check` → ждать «ассеты комнаты завершены» (см. фазу «Воркер ассетов») → `build --assets cache` → `shots` → критик с ассетами → `check`.
- **Fix-раунд** — новый вызов, не продолжение чата: вход = промпт `fix.md` + текущий частичный JSON + находки этой комнаты (`check` + нарушения `merge`) + каркас + спека. История не передаётся.
- **Обе критики выполняются всегда.** Флаг `flags.skip_layout_critic_if_meshes_ready` (по умолчанию `False`) — только для режима «прод».
- **Заморозка промптов:** после ответа критика существующие ключи `assets` получают старый `prompt` обратно. Исключение: критик с ассетами может пометить ассет `"reissue": true` — один раз на комнату; тогда prompt получает суффикс ` #v2`, событие `reissue` в ledger. Второй `reissue` в той же комнате игнорируется с событием.
- Невалидный ответ (любой роли) или `check` с ошибками после лимита раундов → откат к последней зелёной версии (`status="rolled_back"`); зелёной нет → `partial = {}` (`status="empty"`).
- `RoomStore(root)`: `save(room, role, round_no, partial)` → `rooms/<R>/<role>_<round>.json`; `last_green(room) -> dict | None`. Файлы — источник истины, возобновление читает их.
- Промпты: английский, на основе `TASK` из `v1/author.py`; строителю — каркас, его строка `plan`, рефы его комнаты (картинки), cues, спека, схема; запрет трогать чужие комнаты и `hemi`; требование префикса `R_`.

- [ ] тест `test_bad_answer_keeps_last_green`: фейковый Spark отдаёт зелёного строителя, затем мусор у критика → комната остаётся на версии строителя
- [ ] тест: `check` красный → fix-раунд получает находки только своей комнаты и НЕ получает историю предыдущих сообщений (проверяется по `messages` в фейке)
- [ ] тест: 3 красных подряд → `rolled_back`; ни одного зелёного → `empty`
- [ ] тест: заморозка промпта и `reissue` один раз (второй игнорируется)
- [ ] тест: обе критики вызываются, даже если фейковый воркер сообщил «меши готовы» до критика раскладки
- [ ] тест: файлы `rooms/<R>/<role>_<round>.json` появляются на каждом шаге, `last_green` их читает

## Архитектор, этаж и стыки

Файлы: `h0/pipe2/floor.py`, `h0/pipe2/prompts/{architect,architect_fix,seam_fix}.md`, `h0/pipe2/test_floor.py`.

Контракт:
- `Floor(task_dir: Path, run_dir: Path, ctx)`: `run() -> FloorResult`. `task_dir` содержит `TASK.md`, `refs/`, опционально `cues.md`.
- Архитектор: один вызов → `{"skeleton": {...}, "plan": {"rooms": {R: {"refs": [...], "max_points": n, "cues": "..."}}}}`. `plan` хранится в `run_dir/plan.json`, в сцену не попадает (схема запрещает лишние ключи). `check` каркаса; до 2 fix-раундов архитектора; каркас красный после лимита → прогон останавливается с понятной причиной (без строителей).
- **Каркас неизменяем после старта строителей.** Находки с владельцем `"skeleton"` после старта строителей идут в отчёт как дефект прогона и не чинятся.
- Строители: все комнаты параллельно (`ThreadPoolExecutor`, `max_workers = len(rooms)`), без общего барьера; падение одной комнаты не останавливает другие.
- Цикл стыков: `merge` всех комнат → `check` всей сцены → `split_owners` → fix-раунд (`seam_fix.md`) каждому затронутому владельцу параллельно → снова `check`; максимум 3 раунда. После лимита → каждая комната с нерешённой находкой откатывается к версии до цикла стыков. `NAV_ROOM_CUT` в этом цикле считается блокирующим.
- Финал: `build --assets cache` → `shots` → `run_dir/report.json`: статус каждой комнаты, дефекты каркаса, число раундов, таймлайн стадий (из ledger), итоговые $.

- [ ] тест: архитектор с красным каркасом 3 раза → прогон остановлен до строителей, строители не вызывались
- [ ] тест: три комнаты, строитель одной падает → две другие доходят до `green`, третья `empty`, отчёт это показывает
- [ ] тест: межкомнатная находка в цикле стыков уходит обоим владельцам; после 3 красных раундов — откат
- [ ] тест: находка с владельцем `skeleton` после старта строителей не вызывает архитектора
- [ ] тест: строители реально идут параллельно (фейковый Spark с задержкой через инжектируемые часы/события — общее время < суммы)

## Воркер ассетов

Файлы: `h0/pipe2/assets.py`, `h0/pipe2/test_assets.py`.

Контракт:
- `ImageProvider.generate(prompt: str, size: str) -> bytes` (PNG); `MeshProvider.submit(name: str, png: bytes) -> Handle`, `Handle.get(timeout: float) -> dict {"glb": bytes, "sec": float, "baked": bool}`. Живые реализации: `MuseImage` (`/v1/images/generations`, `muse-image-1.0`) и `ModalMesh` (`modal.Cls.from_name("dreamer-sam3d", "Sam3D")().run.spawn(name, png)` + `FunctionCall.get`) — в тестах не вызываются.
- `AssetQueue(cache: Path, images, meshes, ledger, *, mesh_timeout_s=180, clock)`: `put(room, keys: list[dict])` — ключи из `Engine.asset_keys`; уже лежащие в кэше пропускаются; объект = картинка → сразу `submit` меша; tile/decal = только картинка. Файлы кэша — как ждёт движок: `<key>.png`, `<key>.glb` (для объекта исходник `<key>.src.png`, как в v1).
- `done(room) -> bool`: все ключи комнаты завершены. **Завершён = файл записан, ИЛИ провайдер бросил исключение, ИЛИ `glb == b""`, ИЛИ прошло `mesh_timeout_s`.** Упавший ассет → событие `asset_failed`, сборка идёт с заглушкой движка.
- `wait(room, poll_s=2)` использует `done`, никогда не ждёт без верхней границы.
- `idle() -> bool` — очередь пуста и ничего не в работе (для сброса min_containers).
- Каждая картинка и меш — `ledger.allow` до вызова и `charge` после.

- [ ] тест `test_empty_glb_is_failure`
- [ ] тест: меш, который «висит», → через `mesh_timeout_s` по фейковым часам ассет упавший, `wait` возвращается
- [ ] тест: картинка объекта сразу уходит в `submit`, не дожидаясь остальных картинок комнаты
- [ ] тест: ключ, уже лежащий в кэше, не генерируется повторно; одинаковый ключ из двух комнат генерируется один раз
- [ ] тест: `idle()` истинно только когда всё завершено

## Modal: автоскейлер, сторож, без PLY

Файлы: `h0/sam3d_modal.py`, `h0/pipe2/gpu.py`, `h0/pipe2/test_gpu.py`.

Контракт:
- `sam3d_modal.py`: `run(self, name, png, with_ply: bool = True)` — при `False` ключ `"ply"` = `b""` и `/tmp/o.ply` не читается (GPU-время то же: `out["gs"]` нужен запеканию); `main()` пишет `ply`, только если он непустой. `scaledown_window=600`. Добавить `heartbeat = modal.Dict.from_name("dreamer-pipe2-heartbeat", create_if_missing=True)` и `@app.function(schedule=modal.Period(minutes=2))` `watchdog()`: если `heartbeat["ts"]` старше 300 с или нет → `modal.Cls.from_name("dreamer-sam3d", "Sam3D")().update_autoscaler(min_containers=0)`. Ничего не деплоить и не запускать.
- `gpu.py`: `Autoscaler` — протокол `set(min_containers: int, buffer_containers: int = 0)`; `ModalAutoscaler` вызывает `update_autoscaler` **на экземпляре** `modal.Cls.from_name(...)()` (у класса метода нет в modal 1.6.2). `GpuWarmth(autoscaler, assets: AssetQueue, heartbeat, *, k: int, clock)`: `start()` → `set(k)`; `tick()` (раз в цикл конвейера) пишет heartbeat и, если `assets.idle()` и все комнаты прошли постановку ключей, → `set(0)` один раз; `close()` → `set(0)` (идемпотентно, вызывается в `finally`).
- Потолок $ сработал (`ledger` `cap_hit`) → `GpuWarmth` сразу `set(0)`.

- [ ] тест: `with_ply=False` — проверяется на фейковом `out` без GPU (логика вынесена в чистую функцию `pack_result(name, out, with_ply, sec, baked) -> dict` внутри `sam3d_modal.py`, импортируемую без запуска modal), и `main` не пишет пустой `.ply`
- [ ] тест: `GpuWarmth` ставит K на старте, сбрасывает в 0, когда очередь опустела, ровно один раз, и при `cap_hit`
- [ ] тест: `close()` идемпотентен; heartbeat пишется на каждом `tick`
- [ ] тест: `ModalAutoscaler` зовёт метод на экземпляре (фейковый модуль `modal`, подставленный в `sys.modules`)

## CLI, замер effort и сухой прогон

Файлы: `h0/pipe2/__main__.py`, `h0/pipe2/measure.py`, `h0/pipe2/fakes.py`, `h0/pipe2/test_cli.py`.

Контракт:
- `python3 -m pipe2 run <task_dir> --run-dir <dir> --cap-usd <n> --cap-calls <n> [--k <n>] [--effort role=level ...] [--fake]` (из `h0/`). Без `--cap-usd` живой прогон не стартует (exit 2). `--fake` — все провайдеры из `fakes.py` (детерминированные сцены для синтетической задачи), сеть не нужна.
- `python3 -m pipe2 measure --role builder|critic --effort high|medium|max --n 15 --prompt-from <run_dir> --cap-usd <n>` — шаг 0: n вызовов одного промпта, в `events.jsonl` латентность и токены, в конце таблица p50/p90 латентности и reasoning, доля валидных. В тестах — только с фейковым транспортом.
- `--resume <run_dir>` продолжает с файлов `rooms/` (готовые комнаты не перезапускаются).
- По сигналу SIGINT/SIGTERM — `GpuWarmth.close()`, ledger закрыт, отчёт с пометкой `interrupted`.

- [ ] тест: `run --fake` на синтетической задаче из двух комнат (создаётся в тесте) доходит до `report.json` со статусом `green` у обеих и `dist/index.html`
- [ ] тест: `run` без `--cap-usd` → exit 2 и транспорт не создан
- [ ] тест: `measure` с фейковым транспортом печатает p50/p90 и пишет n событий
- [ ] тест: `--resume` не вызывает строителя для комнаты с зелёным файлом
- [ ] тест: SIGTERM посреди фейкового прогона → `set(0)` вызван, `report.json` с `interrupted`
