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

## Merge и владение

Чистые функции, без сети и без движка.

Файлы: `h0/pipe2/merge.py`, `h0/pipe2/geom.py`, `h0/pipe2/test_merge.py`.

Контракт:
- Каркас (`skeleton: dict`) — валидная по схеме сцена без `props`, `decals`, `cameras`, point-ламп: `version, name, levels, rooms, openings, stairs, spawn, style, materials, assets` (tile-ассеты), `lights` (только `hemi`), `routes` (только waypoint-ы комнат/проёмов).
- Частичный JSON комнаты R (`partial: dict`) содержит только ключи `props, decals, lights, cameras, assets, materials`. Любой другой ключ — нарушение. (с фазы «Владение v2» допустимы также `fixtures`, `cosmetic`; при расхождении главнее «Владение v2»)
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

## Учёт в токенах

Цена Spark заранее неизвестна, поэтому главный потолок Spark — в токенах, доллары — отчётом. Меняет код фазы «Клиент Spark и учёт»; её тесты остаются зелёными без правок.

Файлы: `h0/pipe2/ledger.py`, `h0/pipe2/spark.py`, `h0/pipe2/test_ledger.py`, `h0/pipe2/test_spark.py`.

Контракт:
- `Ledger(path: Path, prices: dict, cap_usd: float, cap_calls: int, cap_tokens: int | None = None, *, clock=time.time)`. `cap_tokens=None` — без потолка токенов: старые вызовы `Ledger(path, prices, cap_usd, cap_calls)` работают как раньше. Живой прогон передаёт его всегда.
- `cost_of(kind, units) -> float` — цена без списания (уже есть): `spark` — `units = {"effort", "in", "out"}` по `prices["spark"][effort]` за 1M токенов; `image` — штуки, `h100_s` — секунды; неизвестная цена → 0.
- `allow(kind, estimate_usd, reserve_tokens: int = 0) -> bool` — проверка и резерв атомарно, в одной критической секции под замком ledger. `False` (и событие `cap_hit`, один раз), если `spent + estimate_usd > cap_usd`, или `kind == "spark"` и `calls >= cap_calls`, или (при `cap_tokens` не `None`) `tokens_used + tokens_reserved + reserve_tokens > cap_tokens`. Иначе: `spent += estimate_usd` (резерв $), `calls_by_kind[kind] += 1`, для `spark` ещё `calls += 1`, `tokens_reserved += reserve_tokens`, `True`. **`cap_calls` ограничивает только `spark`**; `image` и `h100_s` считаются в `calls_by_kind` и ограничены только `cap_usd`. `calls` остаётся простым атрибутом, не property (число вызовов `spark`; тест фазы 2 подменяет `led.calls` объектом `Gate`), проверка — ровно `self.calls >= self.cap_calls`.
- `charge(kind, units, reserved: float = 0.0) -> float` (уже есть) — списывает фактическую стоимость `cost_of(kind, units)` и снимает резерв $ того же `allow`: `spent += cost - reserved`.
- `settle(reserve_tokens: int, actual_tokens: int)` — после вызова, получившего `allow == True`: `tokens_reserved -= reserve_tokens`, `tokens_used += actual_tokens`. После отказа `allow` не зовётся.
- `capped: bool` — публичное; `True` после первого отказа по любому потолку, и дальше каждый `allow` → `False` (освобождённый `settle` резерв потолок не «отпускает»).
- `Spark.ask`: `reserve = text_chars(messages) // 3 + 1500 * n_images(messages) + 64000`, где `text_chars` — сумма длин строкового `content` и `text` у частей `type == "text"`, `n_images` — число частей `type == "image_url"` (base64 картинки в символы не считается); передаёт `ledger.allow("spark", estimate, reserve_tokens=reserve)`; один резерв на `ask` вместе с ретраями; после разрешённого `allow` — `settle(reserve, actual)` в `finally`, `actual = prompt_tokens + completion_tokens` из `usage` (сумма по попыткам); нет `usage` ни у одной попытки → `actual = reserve`. Отказ `allow` → `Answer(valid=False, error="cap")` без вызова транспорта и без `settle`.

- [ ] тест: 10 потоков (`threading.Barrier`) зовут `allow` с `reserve_tokens`, `cap_tokens` вмещает ровно 3 резерва → ровно 3 `True`, событие `cap_hit` одно
- [ ] тест: `settle` освобождает резерв и прибавляет фактические токены; без срабатывания потолка следующий `allow` проходит; после `capped` — `False` даже при освобождённом резерве
- [ ] тест: `Ledger(path, prices, cap_usd, cap_calls)` без `cap_tokens` не ограничивает токены; старые тесты `test_ledger.py`/`test_spark.py` не правились и зелёные
- [ ] тест: 200× `allow("image", 0)` при `cap_calls=3` → все `True`, `capped` ложно, `calls_by_kind["image"] == 200`; `allow("h100_s", est)` упирается только в `cap_usd`
- [ ] тест: `Spark.ask` передаёт `reserve_tokens` по формуле контракта и зовёт `settle` ровно один раз (и при ретраях, и при невалидном ответе); при отказе `allow` `settle` не зовётся; `cap_tokens` меньше резерва → `error="cap"`, транспорт не вызывался
- [ ] тест: сообщение с картинкой `image_url` на 1 МБ base64 → `reserve ≤ 64000 + 1500 + text_chars // 3`

## Адаптер движка

Файлы: `h0/pipe2/engine.py`, `h0/pipe2/keys.ts`, `h0/pipe2/test_engine.py`.

Контракт:
- `Engine(engine_dir: Path, *, shots: bool = True)`, методы: `check(scene: dict, work: Path, built: Path | None = None) -> Report`, `check_full(scene: dict, work: Path) -> Report`, `build(scene: dict, out: Path, assets: str, cache: Path | None) -> None`, `shots(dist: Path, size="960x720") -> None`, `asset_keys(scene: dict) -> list[dict]` (через `h0/pipe2/keys.ts` — та же логика, что `v1/keys.ts`, но импорт движка относительный от `h0/pipe2/`: `{id, kind, key, prompt, size}`). `shots=False` → `shots()` ничего не делает (для тестов). `check` с exit 2 (сбой CLI, не находки) → `EngineError(2, raw)`; ненулевой код `build`/`shots` → `EngineError(code, raw)`.
- `Report = {code: int, errors: list[dict], warnings: list[dict], raw: str}` — из JSON-отчёта `--report`; `code` = код выхода CLI.
- Каждый вызов `check`/`build`/`check_full` работает в своём `tempfile.mkdtemp(dir=work)` (сцена, отчёт, `dist`), не рядом с движком; параллельные вызовы с одним `work` не мешают друг другу.
- `blocking(report) -> list[dict]` = `errors` + те `warnings`, у которых `code == "NAV_ROOM_CUT"` (у движка он уровня warn, `engine/src/report/codes.ts:44`, код выхода не меняет). `green(report) -> bool` = `code == 0` и `blocking(report)` пуст. Остальные warnings ни на что не влияют.
- `check_full(scene, work)`: `check`; если `code == 0` (warnings не важны) → `build --assets none` → `check --built` на этом `dist` → его отчёт; иначе — отчёт `check`. `ROUTE_BLOCKED` появляется только с `--built`, поэтому «зелёная сцена» дальше везде = `green(check_full(...))`.
- Кэш отчётов: `check`/`check_full` кладут `Report` в память экземпляра по ключу `sha256(json.dumps(scene, sort_keys=True))` (+ `built` для `check`); повторный вызов с той же сценой CLI не запускает. Кэш под замком, общий для потоков.
- `Gated(engine, n=2)` — тот же интерфейс; `build` и `shots` под общим `threading.Semaphore(n)`, `check`/`check_full`/`asset_keys` — без семафора.
- `scene_for_room(skeleton, partials, plan, room) -> dict` — `merge` каркаса и только частичного JSON комнаты `room` (это сцена для `check` комнаты, без маскирования соседями).

- [ ] тест: `check` на `specs/examples/demo.scene.json` → `code == 0`
- [ ] тест: `check` на синтетической сцене с пропсом в дверном проёме → в `errors` есть `PROP_IN_DOORWAY`, `owner_of` (фаза 1) указывает на нужную комнату
- [ ] тест: `asset_keys` на demo совпадает по ключам с тем, что `build --assets none` кладёт в отчёт/кэш (или с `engine/src/assets/cache.ts` `cacheKey`, вызванным через tsx)
- [ ] тест: `build --assets none` + `scene_for_room` даёт `dist/index.html`; снимки (`shots`) — только если в окружении есть Chromium движка, иначе тест пропускается с причиной
- [ ] тест: синтетическая сцена с `NAV_ROOM_CUT` и пропом, перекрывшим маршрут, → в `check_full` есть и `NAV_ROOM_CUT`, и `ROUTE_BLOCKED`; в простом `check` нет `ROUTE_BLOCKED`; `green` ложно, `blocking` содержит оба
- [ ] тест: `blocking`/`green` на отчёте только с не-`NAV_ROOM_CUT` warnings → пусто/истинно; `Engine(..., shots=False).shots()` Chromium не запускает
- [ ] тест: второй `check_full` той же сцены не запускает CLI (счётчик подпроцессов); изменённая сцена — запускает
- [ ] тест: `Gated` поверх заглушки в тесте: 5 потоков `build`/`shots` → одновременно не больше 2; `check` семафор не ждёт

## Владение v2: косметика, fixtures, маппер

Файлы: `h0/pipe2/merge.py`, `h0/pipe2/blame.py`, `h0/pipe2/test_merge.py`, `h0/pipe2/test_merge_v2.py`, `h0/pipe2/test_blame.py`. Здесь контракт главнее фазы «Merge и владение».

Контракт:
- Каркас делится на **геометрию** (неизменяема после старта строителей: `rooms[].shape/circle/level/height`, `openings[].at/on/width/height/sill/kind/id`, `stairs`, `levels`, `spawn`, свободные `walls[]`) и **косметику** (правит владелец комнаты в любом раунде): `rooms[R].walls.material`, `rooms[R].walls.bands`, `rooms[R].edges.*.material`, `rooms[R].floor`, `rooms[R].ceiling`, и у проёмов — `leaf.decal`, `outside.backdrop`.
- `plan` получает `openings: {<opening id>: {"owner": R}}` — у каждого проёма ровно один владелец косметики.
- Частичный JSON комнаты получает два новых ключа: `fixtures` (каждый `fixtures[].room == R`, иначе `OWN_ROOM`) и `cosmetic: {"room": {...только косметические поля R...}, "openings": {<opening id>: {"leaf": {"decal": ...}, "outside": {"backdrop": ...}}}}`. Косметика проёма разрешена только владельцу из `plan["openings"][id]["owner"]`, иначе `OWN_OPENING`. Любое некосметическое поле в `cosmetic` — `OWN_GEOMETRY`, поле отбрасывается.
- `merge` накладывает `cosmetic` поверх копии каркаса (каркас-вход не мутируется) и добавляет `fixtures`.
- **Маппер находок** (`blame.py`), меняет `owner_of`/`split_owners` фазы 1:
  - `split_owners` остаётся только для обратной совместимости; `PROP_HITS_PROP` в нём теперь — одному владельцу пропа по `path`. Тесты `test_merge.py`, ждавшие межкомнатный `PROP_HITS_PROP` у обоих, переписываются на одного владельца по `path`. Дальнейшие фазы зовут только `blame_room`/`blame_global`.
  - `blame_room(scene, issues, room) -> dict[str, list]` (`scene` — из `scene_for_room`): в сцене «каркас + R» любая находка — владельцу R (сам каркас зелёный, значит виноват R), кроме: `ROOMS_OVERLAP`, `ID_DUPLICATE` по id каркаса, находки `/openings/j…` вне `leaf`/`outside`, `/stairs…`, `/levels…` и находки без `path` → `"skeleton"`.
  - В обоих мапперах `/materials/<key>…` и `/assets/<key>…` → комната по префиксу ключа (до первого `_`), если такая комната есть, иначе `"skeleton"`.
  - `blame_global(engine: Engine, work: Path, skeleton, partials, plan, issues) -> dict[str, list]`: `issues` — `blocking(report)` отчёта `check_full`. Находки с путём `/props/i`, `/decals/i`, `/lights/i`, `/cameras/i`, `/fixtures/i` — владельцу объекта; `/rooms/i/(walls|edges|floor|ceiling)…` → `rooms[i].id`; `/openings/j/(leaf|outside)…` → `plan["openings"][openings[j].id]["owner"]`; `PROP_HITS_PROP` — **только** владельцу пропа по `path` (движок записывает на более поздний, `engine/src/props/lint.ts:387`); `NAV_ROOM_CUT`, `NAV_SPAWN_BLOCKED`, `ROUTE_BLOCKED` — **бисекцией**: для каждой комнаты-подозреваемой (в порядке `skeleton["rooms"]`) `engine.check_full` сцены без её частичного JSON; виновник — комната, без которой находка с тем же `code` и `path` исчезает из `blocking`. Не нашёлся → `"skeleton"`. Прочие пути `/rooms…`, `/openings…`, `/stairs…`, `/levels…`, `/spawn…` и находки без пути → `"skeleton"`. Бисекция — только вызовы движка, без Spark; `check_full` подозреваемых идут параллельно (`ThreadPoolExecutor`; `check_full` не под семафором `Gated`), виновник — первый по порядку `skeleton["rooms"]`; число `check_full` на находку ≤ числа комнат.
- Тест-стенд: синтетический каркас из 4 комнат (коридор + 3 комнаты с дверями из коридора), строится в тесте, проверяется настоящим `check`/`check_full`.

- [ ] тест: `cosmetic` меняет материал стен и `leaf.decal` своей двери; чужой двери → `OWN_OPENING`; `shape` в `cosmetic` → `OWN_GEOMETRY`
- [ ] тест: `fixtures` чужой комнаты → `OWN_ROOM`, своей — в сцене
- [ ] тест `test_nav_cut_blames_culprit`: проп комнаты A перекрывает дверь из коридора в B → `blame_global` отдаёт `NAV_ROOM_CUT` владельцу A
- [ ] тест: `PROP_HITS_PROP` через проём уходит одному владельцу по `path` — и в `blame_global`, и в `split_owners`; переписанные тесты `test_merge.py` зелёные
- [ ] тест: `ROUTE_BLOCKED` из-за пропа комнаты A → A; маршрут, перекрытый геометрией каркаса → `"skeleton"`; число `check_full` на находку ≤ числа комнат (счётчик-обёртка над `Engine`)
- [ ] тест: `blame_room` приписывает R находку nav в сцене «каркас + R»; `ROOMS_OVERLAP`, `ID_DUPLICATE` по id каркаса, `/openings/j/at`, `/stairs…`, `/levels…` → `"skeleton"`
- [ ] тест: `REF_KIND` по `/materials/A_x/tile` → A (и в `blame_room`, и в `blame_global`); ключ без префикса комнаты → `"skeleton"`; находка без `path` → `"skeleton"`
- [ ] тест: неизвестный материал (`REF_UNKNOWN`) в `cosmetic` комнаты A → находка у A, не у `"skeleton"` (и в `blame_room`, и в `blame_global`)

## Воркер ассетов

Файлы: `h0/pipe2/assets.py`, `h0/pipe2/test_assets.py`.

Контракт:
- `ImageProvider.generate(prompt: str, size: str) -> bytes` (PNG); `MeshProvider.submit(name: str, png: bytes) -> Handle`, `Handle.get(timeout: float) -> dict {"glb": bytes, "sec": float, "baked": bool}` — зовётся с `timeout ≤ poll_s`, не готово → `TimeoutError`. Живые реализации: `MuseImage` (`/v1/images/generations`, `muse-image-1.0`) и `ModalMesh` (`modal.Cls.from_name("dreamer-sam3d", "Sam3D")().run.spawn(name, png)` + `FunctionCall.get`) — в тестах не вызываются.
- `AssetQueue(cache: Path, images, meshes, ledger, *, mesh_timeout_s=330, poll_s=2, clock, sleep)` (180 с работы + ~150 с холодного старта). Интерфейс целиком:
  - `put(room, keys: list[dict])` — ключи из `Engine.asset_keys`; возвращается сразу; уже лежащие в кэше пропускаются; объект = картинка → сразу `submit` меша; tile/decal = только картинка. Файлы кэша — как ждёт движок: `<key>.png`, `<key>.glb` (для объекта исходник `<key>.src.png`, как в v1). После `close()` — ключи не берутся, событие `asset_late` на каждый, сборка идёт с заглушкой движка.
  - `done(room) -> bool`: все ключи комнаты завершены. **Завершён = файл записан, ИЛИ провайдер бросил исключение, ИЛИ `glb == b""`, ИЛИ по `clock` с `submit` прошло `mesh_timeout_s`.** Исключение или пустой `glb` → один повтор `submit`; второй отказ или таймаут → событие `asset_failed`, сборка идёт с заглушкой движка.
  - `wait(room)` — цикл `done` + `sleep(poll_s)`, никогда не ждёт без верхней границы.
  - `close()` — новых ключей больше не будет (зовёт вызывающий код, когда последняя комната закончила критику с ассетами); `closed: bool` — публичное.
  - `idle() -> bool` — очередь пуста и ничего не в работе.
- Учёт: перед каждой картинкой и мешем `est = ledger.cost_of(kind, units_est)` (`image`: 1; `h100_s`: `mesh_timeout_s`) и `ledger.allow(kind, est)`; отказ → ассет упавший (`asset_failed`), без вызова провайдера. После — `ledger.charge(kind, units, reserved=est)` (`units` меша = `sec` из ответа; отказ/таймаут → `units_est`).

- [ ] тест `test_empty_glb_is_failure`
- [ ] тест: меш, который «висит» (`get` всегда `TimeoutError`), → через `mesh_timeout_s` по фейковым часам ассет упавший, `wait` возвращается; `get` ни разу не звался с `timeout > poll_s`
- [ ] тест: картинка объекта сразу уходит в `submit`, не дожидаясь остальных картинок комнаты
- [ ] тест: ключ, уже лежащий в кэше, не генерируется повторно; одинаковый ключ из двух комнат генерируется один раз
- [ ] тест: `idle()` истинно только когда всё завершено
- [ ] тест: `put` после `close()` — провайдеры не вызываются, событие `asset_late`, `closed` истинно; на каждый ассет `allow` до вызова и `charge(..., reserved=est)` после (фейковый ledger)

## Конвейер комнаты

Файлы: `h0/pipe2/room.py`, `h0/pipe2/fakes.py` (создаётся здесь: `FakeSpark` — ответы по сценарию на роль, запоминает `messages`; `FakeEngine` — тот же интерфейс, что `Engine` (включая метод `check_full`), отчёты по сценарию, `build` пишет заглушку `dist/index.html`, считает вызовы и максимум одновременных `build`/`shots`), `h0/pipe2/prompts/{builder,fix,critic_layout,critic_assets}.md`, `h0/pipe2/test_room.py`.

Контракт:
- `RoomPipeline(room: str, ctx: Ctx)`, где `Ctx` несёт `skeleton, plan, spark, engine, assets (AssetQueue), store (RoomStore), work: Path, effort: dict[role, str], flags`. `run() -> RoomResult {room, status: "green"|"rolled_back"|"empty", rounds, partial}`.
- Проверка комнаты везде = `engine.check_full(scene_for_room(...), work)`, «зелёный» = `green(report)`.
- Шаги: строитель → `merge` → проверка → до 2 fix-раундов → ключи ассетов в очередь → `build --assets none` → `shots` → критик раскладки → проверка → ждать «ассеты комнаты завершены» (`AssetQueue.wait`) → `build --assets cache` → `shots` → критик с ассетами → проверка.
- **Fix-раунд** — только после строителя; новый вызов, не продолжение чата: вход = промпт `fix.md` + текущий частичный JSON + находки этой комнаты (`blame_room` по `blocking` проверки + нарушения `merge`) + каркас + спека. История не передаётся.
- **Критик:** невалидный ответ или красная проверка после него → fix-раундов нет, откат к последней зелёной версии, `status="rolled_back"`, дальше конвейер идёт от неё (критик с ассетами работает от отката). Строитель и 2 fix-раунда красные (или невалидные) → `partial = {}`, `status="empty"`, критики не зовутся.
- **Обе критики выполняются всегда.** Флаг `flags.skip_layout_critic_if_meshes_ready` (по умолчанию `False`) — только для режима «прод».
- **Заморозка промптов:** после ответа критика существующие ключи `assets` получают старый `prompt` обратно. Исключение: критик с ассетами может пометить ассет `"reissue": true` — один раз на комнату; тогда prompt получает суффикс ` #v2`, событие `reissue` в ledger, новый ключ сразу уходит в `assets.put(room, …)`. Второй `reissue` в той же комнате игнорируется с событием.
- Роли: `builder|fix|critic_layout|critic_assets` (они же ключи `effort`). `round_no` — номер вызова этой роли в комнате с 0: `builder_0`, `fix_0`, `fix_1`, `critic_layout_0`, `critic_assets_0`.
- `RoomStore(root)`: `save(room, role, round_no, partial)` → `rooms/<R>/<role>_<round>.json`; `save_messages(room, role, round_no, messages)` → `rooms/<R>/<role>_<round>.messages.json` (вход вызова Spark); `finish(room, result)` → `rooms/<R>/done.json` (`RoomResult`, пишется в конце `run`); `last_green(room) -> dict | None`. Файлы — источник истины, возобновление читает их.
- Промпты: английский, на основе `TASK` из `v1/author.py`; строителю — каркас, его строка `plan`, рефы его комнаты (картинки), cues, спека, схема; запрет трогать чужие комнаты и `hemi`; требование префикса `R_`. Промпт строителя перечисляет ключи частичного JSON (`props, decals, lights, cameras, assets, materials, fixtures, cosmetic`) и id проёмов, где он владелец косметики (из `plan["openings"]`). Критикам — снимки только своих камер (`R_*`), находки только по своим объектам, дословно `Objects of another room seen through an opening are not yours.` («объекты другой комнаты за проёмом не твои»).

- [ ] тест `test_bad_answer_keeps_last_green`: фейковый Spark отдаёт зелёного строителя, затем мусор у критика → комната остаётся на версии строителя
- [ ] тест: проверка красная → fix-раунд получает находки только своей комнаты и НЕ получает историю предыдущих сообщений (проверяется по `messages` в фейке)
- [ ] тест: строитель + 2 fix-раунда красные → `empty`, `partial == {}`; зелёный строитель, затем красная проверка после критика раскладки → `rolled_back` на версии строителя, fix-раундов нет, критик с ассетами получает версию строителя
- [ ] тест: заморозка промпта и `reissue` один раз (второй игнорируется); новый ключ `#v2` сразу попадает в `assets.put`
- [ ] тест: обе критики вызываются, даже если фейковый воркер сообщил «меши готовы» до критика раскладки
- [ ] тест: файлы `rooms/<R>/<role>_<round>.json` и `.messages.json` появляются на каждом шаге, `done.json` — в конце, `last_green` их читает
- [ ] тест: промпт строителя содержит все 8 ключей частичного JSON и id своих проёмов из `plan["openings"]`, но не чужих
- [ ] тест: в `messages` критиков — только снимки камер `R_*` и фраза про объекты за проёмом

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

## Стыки, деградация, финал

Файлы: `h0/pipe2/seams.py`, `h0/pipe2/degrade.py`, `h0/pipe2/floor.py` (подключает их после строителей), `h0/pipe2/prompts/seam_fix.md`, `h0/pipe2/test_seams.py`, `h0/pipe2/test_degrade.py`.

Контракт:
- Цикл стыков (`seams.py`): `merge` всех комнат → `engine.check_full` всей сцены → `blame_global` по `blocking` → fix-раунд (`seam_fix.md`) каждому затронутому владельцу, кроме `"skeleton"`, параллельно → снова `check_full`; до `green`, максимум 3 раунда. После лимита → каждая комната с нерешённой находкой откатывается к версии до цикла стыков (из `RoomStore`). `seam_fix.md` запрещает новые ключи `assets` (очередь уже закрыта; новый ключ → `asset_late` и заглушка).
- **Деградация без Spark** (`degrade(engine, work, skeleton, partials, plan) -> tuple[dict, list]`): пока `green(check_full(scene))` ложно — первая находка из `blocking`, владелец по `blame_global`: находка про объект → объект убирается вместе с пропсами, которые на него ссылаются (`mount.top_of`, `around.center` или `face`); находка не про объект с владельцем-комнатой → комната уходит в каркас без частичного JSON; владелец `"skeleton"` у находки, которой нет в `blocking(check_full(skeleton))` (появилась только после merge), → частичные JSON комнат убираются по одному в обратном порядке `skeleton["rooms"]`, пока она не исчезнет. Не-блокирующие warnings ничего не удаляют. Число `check_full` самого `degrade` (без бисекции `blame_global`) ≤ объектов + комнат + 2 (начальная проверка и одна проверка каркаса); объекты = `props + decals + lights + cameras + fixtures`. Исчерпано → `scene = skeleton` (он зелёный с момента приёма каркаса). `build` движка не собирает сцену с ошибками (`engine/bin/dreamer.ts:222–225`), поэтому final build идёт только по зелёной сцене. Каждое удаление — в отчёт.
- Все `build`/`shots` идут через `Ctx.engine` (`Gated`); `shots` с exit 2 (`EngineError`) — один повтор, потом комната без листа с пометкой.
- Финал `Floor.run`: стыки → `degrade` при необходимости (и сразу, если `ledger.capped`) → ждать `assets.idle()` (цикл `sleep(poll_s)`, не дольше `mesh_timeout_s` по `clock`) → `build --assets cache` → `shots` (лист и для комнат, тронутых циклом стыков) → `run_dir/report.json` дополняется: удалённое `degrade`, раунды стыков, листы.

- [ ] тест: межкомнатный `PROP_HITS_PROP` в цикле стыков → `seam_fix` получает только владелец пропа по `path`; геометрическая находка двух комнат без единственного виновника → `"skeleton"`, fix-раунд никому; после 3 красных раундов — откат
- [ ] тест `test_degrade_always_builds` (реальный движок): синтетическая сцена с межкомнатным дефектом, фейковый Spark никогда его не чинит → после 3 раундов `degrade` убирает нарушителя, `build --assets none` даёт `dist/index.html`, отчёт перечисляет удалённое; второй случай: пропы комнат A и B каждый по отдельности перекрывают коридор (бисекция → `"skeleton"`) → `degrade` снимает частичные JSON в обратном порядке, `dist/index.html` всё равно есть
- [ ] тест: `degrade` убирает проп вместе с пропсами, ссылающимися на него через `mount.top_of`/`around.center`/`face`; число `check_full` ≤ объектов + комнат + 2; находка не уходит → итог = каркас
- [ ] тест: не-блокирующий warning первым в отчёте → `degrade` ничего не удаляет из-за него
- [ ] тест: потолок сработал на стадии стыков → `degrade` + final build без вызовов Spark
- [ ] тест: в стыках и финале `FakeEngine` фиксирует максимум одновременных `build`/`shots` ≤ 2; `shots` с exit 2 → один повтор, потом комната без листа с пометкой

## Modal: автоскейлер, сторож, без PLY

Файлы: `h0/sam3d_modal.py`, `h0/pipe2/gpu.py`, `h0/pipe2/test_gpu.py`.

Контракт:
- `sam3d_modal.py`: `run(self, name, png, with_ply: bool = True)` — при `False` ключ `"ply"` = `b""` и `/tmp/o.ply` не читается (GPU-время то же: `out["gs"]` нужен запеканию); сборка ответа — чистая `pack_result(name, out, with_ply, sec, baked) -> dict`. Запись файлов из `main()` вынесена в чистую `save_result(out_dir: Path, r: dict)`: пишет `ply`, только если он непустой. `scaledown_window=600`. Добавить `heartbeat = modal.Dict.from_name("dreamer-pipe2-heartbeat", create_if_missing=True)` и `@app.function(image=modal.Image.debian_slim(), schedule=modal.Period(minutes=2))` `watchdog()` (лёгкий образ: иначе функция наследует CUDA-образ приложения): если `heartbeat["ts"]` старше 300 с или нет → `modal.Cls.from_name("dreamer-sam3d", "Sam3D")().update_autoscaler(min_containers=0, buffer_containers=0, scaledown_window=120)`. **Все три параметра всегда**: по docstring modal 1.6.2 неуказанные параметры сохраняют прошлое значение. Ничего не деплоить и не запускать. В тестах модуль импортируется с фейковым `modal` в `sys.modules`.
- `gpu.py`: `Autoscaler` — протокол `set(min_containers: int, buffer_containers: int, scaledown_window: int)`, все три обязательны; `ModalAutoscaler` вызывает `update_autoscaler` **на экземпляре** `modal.Cls.from_name(...)()` (у класса метода нет в modal 1.6.2). `GpuWarmth(autoscaler, assets: AssetQueue, ledger: Ledger, heartbeat: MutableMapping, *, k: int, clock)` (живой — `modal.Dict`, в тестах `dict`): `start()` → сначала heartbeat (`heartbeat["ts"] = clock()`), потом `set(k, 0, 600)` (иначе сторож обнулит K на старте); `tick()` пишет heartbeat и делает сброс один раз, если `ledger.capped`, или `assets.closed and assets.idle()`; `close()` → сброс (идемпотентно, в `finally`). Сброс везде = `set(0, 0, 120)`. Опустевшая на время очередь (одна комната готова, другая ещё думает) K не сбрасывает.

- [ ] тест: `pack_result(..., with_ply=False)` на фейковом `out` без GPU → `"ply" == b""`; `save_result` не пишет пустой `.ply`, непустой пишет; модуль импортирован с фейковым `modal` в `sys.modules`
- [ ] тест: `GpuWarmth` пишет heartbeat до `set(k, 0, 600)`; временно пустая очередь без `close()` K не сбрасывает; после `close()` + `idle()` — `set(0, 0, 120)` ровно один раз; при `ledger.capped` — на ближайшем `tick`
- [ ] тест: `close()` идемпотентен; heartbeat пишется на каждом `tick`
- [ ] тест: `ModalAutoscaler` зовёт метод на экземпляре со всеми тремя параметрами (фейковый модуль `modal`, подставленный в `sys.modules`)

## CLI, замер effort и сухой прогон

Файлы: `h0/pipe2/__main__.py`, `h0/pipe2/measure.py`, `h0/pipe2/fakes.py` (дополняется: фейковые провайдеры ассетов — всегда бросают исключение, фейковый автоскейлер, синтетическая задача), `h0/pipe2/floor.py` (добавляет `Floor(..., resume: bool = False)` и `Floor.interrupt()`), `h0/pipe2/test_cli.py`.

Контракт:
- `python3 -m pipe2 run <task_dir> --run-dir <dir> --cap-usd <n> --cap-calls <n> --cap-tokens <n> [--k <n>] [--effort role=level ...] [--resume] [--fake]` (из `h0/`). Живой прогон без любого из `--cap-usd`, `--cap-calls`, `--cap-tokens` не стартует (exit 2). `--fake` — все провайдеры из `fakes.py` (детерминированные сцены для синтетической задачи), сеть не нужна. `--fake`: Spark, картинки, меши и автоскейлер — из `fakes.py`; движок настоящий, `Engine(engine_dir, shots=False)`. Без снимков критик получает сообщение без картинок — не ошибка.
- `run` собирает `deps` для `Floor`; `GpuWarmth.start()` — до архитектора (t=0); затем daemon-поток крутит `tick_loop(warmth, stop: threading.Event, sleep, interval=30)` (`tick()` + `sleep(interval)`, пока не выставлен `stop`); `stop` выставляется, когда `Floor.run` вернулся.
- `--resume` (флаг, без значения) → `Floor(..., resume=True)` в `--run-dir`: каркас и план — из `<run-dir>/skeleton.json` и `<run-dir>/plan.json` (архитектор не вызывается); комната с `<run-dir>/rooms/<R>/done.json` берёт `partial` из него и не перезапускается, остальные — с начала конвейера комнаты.
- `python3 -m pipe2 measure --role builder|critic_layout|critic_assets --effort high|medium|max --n 15 --prompt-from <run_dir> [--room <R>] --cap-usd <n> --cap-calls <n> --cap-tokens <n>` — шаг 0: n вызовов одного промпта из `<run_dir>/rooms/<R>/builder_0.messages.json` (`--role builder`) или `<run_dir>/rooms/<R>/<role>_0.messages.json` (`--role critic_layout|critic_assets`); `R` по умолчанию — первая комната `<run_dir>/plan.json`. В `events.jsonl` латентность и токены, в конце таблица p50/p90 латентности и reasoning, доля валидных. В тестах — только с фейковым транспортом.
- По сигналу SIGINT/SIGTERM — обработчик `on_signal(signum, frame)`: `Floor.interrupt()` (новых вызовов Spark нет, `run` возвращается с отчётом `interrupted`), `GpuWarmth.close()`, ledger закрыт.

- [ ] тест (реальный движок, `Engine(..., shots=False)`): `run --fake` на синтетической задаче из двух комнат (создаётся в тесте) доходит до `report.json` со статусом `green` у обеих и `dist/index.html`
- [ ] тест: `run` без любого из `--cap-usd`/`--cap-calls`/`--cap-tokens` → exit 2 и транспорт не создан
- [ ] тест: `measure` с фейковым транспортом читает `rooms/<R>/builder_0.messages.json`, печатает p50/p90 и пишет n событий
- [ ] тест: `--resume` не вызывает архитектора и строителя для комнаты с `done.json`
- [ ] тест: фейковый Spark посреди прогона зовёт `on_signal(signal.SIGTERM, None)` напрямую → `set(0, 0, 120)` вызван, `report.json` с `interrupted`
- [ ] тест: `tick_loop` синхронно, фейковый `sleep` двигает часы и после 40 тиков выставляет `stop` → между записями heartbeat нет промежутка > 60 с; в `run --fake` `start()` — до первого вызова архитектора
