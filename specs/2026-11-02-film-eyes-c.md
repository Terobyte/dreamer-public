# Глаза, полоса C: партитура видит места, комната полная по картинке (ночь 3)

Версия плана: 1.2 (Г1 сужен до остатка после багханта 11-02, B14; ручная партитура без предупреждения). Полоса C из трёх параллельных прогонов tero по спеке `specs/2026-11-02-film-eyes.md` (там «Зачем» целиком, хвост Г9–Г10 после слияния полос, приёмка хозяина). Номера фаз сквозные по спеке.

**Зачем эта полоса.** Партитура не видит места: `story` читает `stage/places.json`, который пишет более поздний шаг `stage`, и режиссёр мизансцены получает пустые места. Комната беднее картинки: SAM 3 по слову `bedroom_shelf` берёт только каркас полки, пол и стены — материалы `{"color": …}`, правку критика выбросили целиком из-за одной рамки (`DECAL_OVERLAP`, откат). Цель всей спеки — фильм спальни Кошакана уровня ручного демо Sonnet (`research/live_c9_face_to_face.png`, `LESSONS.md` L140–L144). Срок: подача Meta 4 ноября 21:00 ET.

### Территория полосы

Три полосы идут одновременно в разных worktree (`meta-wa`, `meta-wb`, `meta-wc`), каждая на своей ветке от `tero/2026-11-01-engine-worlds` (коммит правки `startSpot` `5a6b34e` уже в основе). После всех трёх хозяин сливает их в основную ветку.

- **Пишет только:** `h0/make/core.py` (только кортеж зависимостей `story`), `h0/make/story.py`, `h0/pipe2/**` (`floor.py`, `room.py`, новый `surface_rule.py`, `prompts/builder.md`, `prompts/critic_layout.md`), их тесты (`h0/make/test_story_places.py`, `h0/make/test_story_stage.py` — только перенос входа на фикстуру `world/run`, `h0/pipe2/test_*.py`), `research/feature_map_eyes_c.md`.
- **Не пишет (территория других полос):** `engine/**`, `h0/make/stage.py` (только вызывать `build_places`, не менять), `h0/make/cast.py`, `h0/dream/**`. Нужна правка там → `BLOCKED` в долг, не правка.
- **Согласованное исключение из правила карты кода (AGENTS.md):** `research/feature_map.md` полосы не трогают: он общий, и три полосы дали бы конфликт слияния. Строки карты кода (как для §2 и §3) полоса пишет в свой файл `research/feature_map_eyes_c.md` (две таблицы: «§2 модули» и «§3 нужно X — используй Y»); хозяин переносит их в `feature_map.md` коммитом слияния; это и есть «тот же коммит» для общей карты. Правило «Карта кода» ниже для этой полосы читается так: «дописать строку в `research/feature_map_eyes_c.md`».

**Порядок:** Г1 → Г5 → Г6 → Г7. Фазы друг от друга не зависят; Г6 и Г7 обе трогают `room.py`, поэтому идут подряд.

**Игроки:** `--player-schedule claude:claude-sonnet-5-5×1,opencode:baseten/meta-models/muse-spark-open-1026×5,claude:claude-sonnet-5-5×1`, `--player claude:claude-sonnet-5-5`, 7 раундов. Muse contributor (`muse:muse-spark-1.3-contributor`, никогда платная `muse:muse-spark-1.3`) идёт только в полосе B; Sonnet и остальные игроки параллельно можно. Судья codex gpt-6-luna, эскалация claude:sonnet, тестера нет.

### Общие правила (для всех фаз этого плана)

- **Живых вызовов нет:** ни Spark, ни Muse, ни Modal, ни Fish, ни GPT. `make`, `make.play`, `pipe2` запускаются только с `--fake`; `make.film` не запускается совсем (флага `--fake` у него нет). В Python-тестах сеть запрещена, в TS `fetch` подменяется. Ключи не читать.
- **Spark в h0** — только через `pipe2.spark.Spark(core._spark_transport(), Ledger(...))`, как `_spark_director` в `h0/make/story.py`; новых клиентов не писать.
- **Тесты:** сначала красный тест, потом код. Python-тесты на `unittest.TestCase`. Порогов по реальному времени нет. Игрок гоняет только тесты своей фазы и соседние старые; весь набор гоняет гейт (на машине идут три прогона, полный набор у каждого игрока кладёт машину).
- **Зависимости:** новых нет. В `engine/` только то, что уже есть в `package.json` (`three` 0.185, `@gltf-transform/core` 4.5); `three` работает в node без WebGL.
- **Карта кода:** фаза, которая добавляет модуль или публичную функцию, в том же коммите дописывает строку в `research/feature_map_eyes_c.md` (таблицы «§2» и «§3», см. «Территория»). Читать `research/feature_map.md` можно и нужно: есть похожая функция в карте — использовать её, не писать вторую.
- **Что не читать:** `~/.dreamer-bench/**`, `h0/out/**`, `cache/`, `runs/**`, чужие `dist/`, `anymove/**` (кроме фикстур `h0/make/testdata/**` и книги `h0/dream/books/koshakan/**`).
- **Что не трогать:** `h0/squid_live/**`, `tools/gate.sh`, `tools/gate_skip.txt`, хуки хозяина в `runtime/main.ts`, событие `stage_line`. Старые тесты не ослаблять.
- **Имена:** в `engine/` уже есть `build/shots.ts` и `test/build-shots.test.ts` (снимки камер сборки, другое). Всё новое про план съёмки называется `shotplan`, слово `shots` для него не используется.
- **Обратная совместимость:** старый прогон без `surfaces`, `clipfacts.json` и плана играется как сейчас: каждый новый вход необязателен, его отсутствие — предупреждение, не ошибка.
- **Детерминизм:** случайный выбор только через переданный `rng`/сид.
- **Гейт фазы:** `sh tools/gate.sh` весь зелёный.

### Судья, фьюз, долг

- **Судья.** Блокер — красный тест или нарушение явного пункта фазы, включая запись вне территории полосы. Крайний случай, которого нет в пунктах, идёт как minor в долг. Требование «сделать то, чего нет в плане» находкой не считается.
- **Фьюз:** нет SHIP за 7 раундов → хозяин дословно пишет остаток в `specs/make-debt.md` (раздел «Глаза, ночь 3, полоса C») и ставит `[x]` у чекбоксов фазы. Галочка при долге не значит «сделано».
- Нет входа фазы → фаза пишет `BLOCKED: <чего нет>` в тот же раздел и не делает своё.

## Г1. `story` получает места мира, а не будущего `stage`

Зоны: `h0/make/story.py` (`run_story`), тест `h0/make/test_story_places.py` (новый), `h0/make/test_story_stage.py` (только вход). `core.py` уже исправлен (B14), фаза его не трогает.

**Большая часть Г1 уже в основе** (багхант 11-02, B14): у `story` зависимости `("refs", "world")`, версия 3 (`core.py:201`); `run_story` берёт места из `stage.build_places(world/run)`, если есть `world/run/dist/geometry.json` (`story.py:101–109`); тесты `h0/make/test_bughunt_b14.py` и `test_core.test_parallel_stubs_overlap` (`story` стартует после конца `world`). **Осталось** (это и есть работа фазы): убрать запасной путь — чтение `stage/places.json` в `run_story` (`story.py:108–112`, сейчас он срабатывает, когда `world/run` нет), добавить предупреждение `story: no world, staging without places`, и тесты контракта ниже, которых ещё нет (хеш, `MissingInput`, прямой вызов без мира). `test_story_stage.py` сейчас кладёт места в `stage/places.json`; после фазы он кладёт фикстуру `world/run` (как `test_bughunt_b14.py` через `make.testdata.synth_world`) — это перенос входа, не ослабление проверки.

Было до B14: стадия `story` зависела только от `refs` и брала места из `ctx.run_dir/"stage"/"places.json"`, который пишет более поздний `stage.write_stage`. На свежем прогоне `places=None`, режиссёр Н10 не знал ни одного места, и каждый `goto` превращался в `stay`.

Контракт:
- у `story` зависимости `("refs", "world")`. Хеш входа `story` включает выход `world` через общее правило предков `core.py`, поэтому пересборка мира пересобирает партитуру. Упал `world` → `story` `blocked` по общему правилу;
- `run_story` передаёт в `score_scene` результат `stage.build_places(ctx.run_dir/"world"/"run")` (тот же словарь `{"places", "warnings"}`, что пишет `write_stage`). Файл `stage/places.json` она больше не читает. Нет папки `world/run` при прямом вызове `run_story` → `places=None` и `"story: no world, staging without places"` в `score["warnings"]`; предупреждение попадает только в сгенерированную партитуру: если есть `score.edited.json` той же сцены, он берётся дословно, без добавлений (ручная правка побеждает как есть; старый `test_story.test_edited_same_scene_wins` остаётся без изменений и зелёным). `h0/make/test_story.py` фаза не трогает; Через `run_make` такой случай не наступает: без успешного `world` проверка входов (`core.py:431–440`) не пускает `story`;
- `build_places` не меняется; места у `story` и `stage` совпадают, потому что это одна функция на одном входе.

- [ ] красный тест: свежий `--fake` прогон книжной сцены → `score_scene` (подменённый в тесте с записью аргументов) получил `places` из `build_places(world/run)` фикстуры с местом `bed` (фикстура `world/run` содержит обязательные для `build_places` файлы `scene.json`, `dist/geometry.json`, `dist/nav.json` и проп-кровать с мешем; `dist/build.json` можно опустить, `stage.py:124`), и это происходит до запуска `stage`; прямой вызов `run_story` с тестовым `Ctx` без `world/run` → `places=None` и предупреждение; `run_make(only="story")` без успешного `world` → `MissingInput`, `story` не запускается; правка `world/run/scene.json` меняет хеш входа `story`
- [ ] код; старые тесты `h0/make` зелёные; гейт зелёный

## Г5. мебель с содержимым перерисовывается целиком

Зоны: `h0/pipe2/floor.py` (`attach_refs`, `floor.py:239–282`; поле `warnings` в `FloorResult` и передача его в `attach_refs` из `Floor.run`, `floor.py:405`), `h0/pipe2/prompts/builder.md` (только правило про содержимое), тест `h0/pipe2/test_ref_containers.py` (новый).

Сейчас `ref.what` — id пропа (`bedroom_shelf`), режим не задан, значит `mask` (`assets.py:198`). SAM 3 выделяет каркас без книг и корзины. Ручная проверка Sonnet (01.11): «полка со всем, что на ней и в ней», перерисованная на белом, даёт в SAM3D полную полку. Путь `redraw` уже есть (`assets.py:83`, Н2).

Контракт:
- `ref` лежит в ассете пропа (`scene["assets"][prop["asset"]]["ref"]`), как сейчас. Несколько пропов могут делить ассет (`merge.py:97–103`); сейчас `attach_refs` перезаписывает `ref` на каждом пропе, и побеждает последний. Г5 меняет это: `ref` ставится, только если у ассета его ещё нет, поэтому `what` и `mode` задаёт первый по порядку `scene["props"]` проп. Если у ассета уже есть `ref` с другой картинкой (ассет делят комнаты с разными кадрами, `merge.py:212–224`), ассет копируется под ключом `<aid>__<room>` с собственным `ref`, и проп переводится на копию; `what` для любого `object` с `ref` — короткое имя: последнее слово id после `_` (`bedroom_shelf` → `shelf`);
- **контейнеры** — последнее слово из списка `CONTAINERS = {shelf, shelves, bookshelf, bookcase, nightstand, dresser, cabinet, cupboard, sideboard, desk, table, windowsill}`. У них `ref.mode = "redraw"` и `what = "<имя> with everything standing on it and inside it"`;
- пропы, чей `mount` — объект с ключом `top_of` или `tier_of` (второй добавляет полоса A, Г3; здесь это просто ключ словаря, схему C не трогает; тест зовёт `attach_refs` на сыром словаре без `Engine.check`, проверка схемой — после слияния A и C), указывающим на id пропа-контейнера, у ассета которого после этой функции есть `ref`, убираются из `scene["props"]`: их уже нарисовали внутри контейнера. Удаление идёт после проставления всех `ref`, по порядку пропов. `attach_refs(scene, plan, scene_dir, warnings=None)` дописывает в переданный список строку `CONTAINED <id> in <container id>` на каждый убранный проп; `FloorResult` получает поле `warnings: list = field(default_factory=list)`; `Floor.run` создаёт список `warnings = []` до вызова `attach_refs` (`floor.py:405`), передаёт его туда, а потом тот же список — в `FloorResult(..., warnings=warnings)` (`floor.py:431`), и он попадает в `world/run/report.json` через `_write_report` (`asdict`). У контейнера без `ref` содержимое остаётся. Свет сцены (`lights`) от этого не зависит: он не привязан к пропам;
- в `builder.md` строка: «если у комнаты есть картинка, то, что стоит на мебели или внутри неё, не выноси отдельным предметом».

- [ ] красные тесты: `bedroom_shelf` с картинкой → `mode redraw`, `what` с «everything standing on it and inside it»; `bedroom_bed` → без `mode`, `what = "bed"`; `bedroom_toyhouse` с `mount: {top_of: bedroom_shelf}` при картинке → убран из `scene["props"]`, в списке `warnings` ровно `CONTAINED bedroom_toyhouse in bedroom_shelf`; то же с `mount: {tier_of: bedroom_shelf, tier: 1}` → убран; без картинки → остался, `warnings` пуст; проп на `bedroom_bed` (не контейнер) с картинкой → остался; `FloorResult(...).warnings` попадает в `report.json`; ассет, общий для `bedroom_shelf` (первый) и `bedroom_box`, получает `ref` контейнера, оба пропа остаются; один ассет в двух комнатах с разными картинками → второй проп на копии `<aid>__<room>` со своей картинкой, первый — на исходном; `builder.md` содержит правило
- [ ] код; старые тесты `h0/pipe2` зелёные; гейт зелёный

## Г6. критик не теряет правку из-за одной детали

Зоны: `h0/pipe2/room.py` (`_critic`, новый помощник рядом), тест `h0/pipe2/test_critic_partial.py` (новый).

Прогон 11-01: `critic_assets` дважды отклонён за `DECAL_OVERLAP` одной рамки, правка откатилась целиком (`_rollback`), и комната осталась на черновике строителя.

Контракт, по порядку при `_accept(...) == (False, findings)` для правки критика:
1. **один повтор:** тот же критик получает свою отклонённую правку (`candidate`) на месте `{{PARTIAL}}` своего промпта, а не `self.partial`, и `findings` отдельным абзацем («исправь только это, остальное верни как было»): `_critic_messages` получает необязательный параметр `partial`, по умолчанию `self.partial`. Ответ проходит `_accept`. Принято → `green`. Повтор — один вызов Spark того же `role`, учтённый в ledger;
2. **отбрасывание:** если все находки после повтора имеют код из `DROPPABLE = {DECAL_OVERLAP, DECAL_OFF_WALL, DECAL_ON_OPENING}` и `path` вида `/decals/<i>` или `/decals/<i>/<поле>` (`DECAL_OFF_WALL` даёт и `/decals/<i>/at`, `/decals/<i>/y`; `i` — первый сегмент после `/decals/`), наклейка `i` объединённой сцены ищется в правке (по `id`, если он есть, иначе по совпадению канонического JSON). Все найдены → они удаляются из правки, правка снова проходит `_accept`. Принято → `green`. Хоть одна не найдена (принадлежит не этой правке) → шаг 3;
3. иначе — прежний `_rollback()`.

События: `critic_retry {room, role, findings}`, `critic_dropped {room, role, paths}`; прежнее `critic_rejected` пишется только перед откатом.

- [ ] красные тесты (фейковый Spark): правка с `DECAL_OVERLAP` → повтор исправил → принята, `critic_retry`; повтор снова с наложением → наклейка убрана, остальная правка принята, `critic_dropped` с путём; находка не из списка (`PROP_HITS_WALL`) → откат как раньше, `critic_rejected`; наложение с наклейкой скелета (нет в правке) → откат; повтор вернул сразу `DECAL_OVERLAP` и `PROP_HITS_WALL` → откат, `critic_rejected`, без `critic_dropped`; `DECAL_OFF_WALL` с путём `/decals/<i>/at` → наклейка найдена и убрана; запрос повтора к фейковому Spark содержит отклонённую правку (её уникальную наклейку), а не прежний `self.partial`, и текст каждой находки (`code` и `path`) отдельным абзацем
- [ ] код; старые тесты `h0/pipe2` зелёные; гейт зелёный

## Г7. комната по картинке: текстуры и полная опись

Зоны: `h0/pipe2/surface_rule.py` (новый), `h0/pipe2/room.py` (только вызов в `_findings` и условная вставка блока описи в `_critic_messages`), `h0/pipe2/prompts/critic_layout.md` (только описание), тест `h0/pipe2/test_ref_surfaces.py` (новый).

Контракт:
- `plain_surfaces(scene, room_id, has_ref) -> list[finding]`: у комнаты с картинкой (`plan.rooms[room].refs` не пуст) материал пола и стен должен быть плиткой. `rooms[].floor` и `rooms[].walls.material` — строковые id; сам материал — `scene["materials"][id]`, у него есть `tile` или только `color`. Проверяются все материалы стен комнаты: `walls.material`, `walls.bands[].material` и `material` каждого значения объекта `edges` (ключи — строковые индексы рёбер, `{"2": {"material": …}}`), если они есть (`specs/engine-scene.md:86–87`). Комната `open: true` без стен — проверяется только пол. Материал без `tile` (или id без записи в `materials`) — нарушение. Иначе находка `{"code": "PLAIN_SURFACE", "owner": <room>, "path": "/materials/<id>", "field": <поле комнаты>, "msg": "<room> <field> uses <id> without a tile: room has a picture, draw a tile from it and assign it"}`, где `field` — точное место: `floor`, `walls.material`, `walls.bands[<n>].material` или `edges["<k>"].material`. Строитель меняет поверхности через `cosmetic.room.*` и материалы с префиксом комнаты (`merge.py:235, 298`); сообщение называет и поле, и id, чтобы правка попала в нужное место. `RoomPipeline._findings` (`room.py:360`) добавляет эти находки к своим, поэтому их закрывает обычный цикл правки строителя. Потолок не проверяется;
- `critic_layout.md` с картинкой начинается с задания описи: «перечисли каждый видимый на картинке предмет: мебель, то, что на ней, на стенах, на полу. Всё, чего нет в сцене, добавь, если это не содержимое контейнера». Задание описи хранится в `critic_layout.md` как отдельный блок, а `_critic_messages` вставляет его только для `role == "critic_layout"` и комнаты с картинкой (тот же признак, что у `plain_surfaces`); без картинки текст сообщения как до фазы.

- [ ] красные тесты: комната с картинкой, `floor: "m_floor"`, `materials.m_floor = {color}` → `PLAIN_SURFACE` с путём `/materials/m_floor`; `{tile}` → нет; то же отдельно для `walls.material`, полосы `walls.bands[0].material` и ребра `edges: {"2": {"material": "m_wall"}}` (`edges` — объект с ключами-индексами ребра, `engine-scene.schema.json:130`; `color` → находка с `field` `edges["2"].material`, `tile` → нет); комната `open: true` с картинкой и плиточным полом → нет находок; без картинки и `color` → нет; `floor` и `walls.material` с id, которого нет в `materials`, → по находке на каждый, путь `/materials/<id>`; сообщение `critic_layout` с картинкой содержит задание описи, без картинки — нет
- [ ] код; старые тесты `h0/pipe2` зелёные; гейт зелёный
