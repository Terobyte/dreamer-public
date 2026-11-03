# Камера, полоса B, версия 2: Spark выбирает приём на бит (план tero)

Перезапуск полосы B. Первая версия (`specs/2026-11-02-camera-moves-b.md`, 9 раундов без SHIP) заставляла Python заново считать, где стоят актёры, и строить точки камеры. Это копия логики рантайма (`startSpot`, `bedSitSpot`, занятость мест, повороты клипов), и она всегда расходилась с рантаймом. Версия 2 эту работу у Python забирает.

**Решение.** Spark выбирает на каждый бит **приём** из закрытого списка и **субъекта**. Python пишет этот выбор в файл `shotplan/moves.json`. Режиссёр рантайма (`director.ts`, фаза К2 полосы A) читает файл и вместо собственного жребия `pickMove` берёт приём Spark. Точки камеры он считает сам по живым актёрам (`resolveMove`). Координат, комнат, препятствий, `clipfacts` и `plan.json` формата Г8 в этой полосе нет.

### Территория полосы

Полоса B: worktree `meta-kb`, ветка `tero/2026-11-02-camera-moves-b`.

- **Пишет только:**
  - `h0/make/shotplan.py` (новый), `h0/make/core.py`, `h0/make/story.py`, `h0/make/__main__.py`, `h0/make/film.py`, `h0/make/critic.py`;
  - тесты `h0/make/test_shotplan.py` (новый), `h0/make/test_critic.py`; в `h0/make/test_core.py` и `h0/make/test_e2e_fake.py` — только настройка под новую стадию и долю бюджета, проверки не ослаблять;
  - `research/feature_map_camera_b.md`.
- **Не пишет:** `engine/**`, `app/**`, `h0/dream/**`, `h0/pipe2/**`, `h0/make/testdata/shotplan_koshakan/**` (фикстура хозяина, только читать). Нужна правка там — `BLOCKED` в долг.
- **Карта кода.** Общий `research/feature_map.md` не трогать. Строки «§2 модули» и «§3 нужно X — используй Y» пишутся в `research/feature_map_camera_b.md`, хозяин переносит их при слиянии.
- **Черновик первой версии** лежит в `refs/tero/20261102-194049862258-2026-11-02-camera-moves-b/phase-00-round09` (`git show <ref>:h0/make/shotplan.py`). Из него можно брать куски: `core.py`, флаг `--camera-style`, `film.py`, `critic.py`. Код про геометрию, `actors_by_beat`, мост `<in> <out>`, `validate_plan` и `plan.json` в новую версию не переносится.

### Игроки, судья, фьюз

- **Игроки:** `--player-schedule claude:claude-sonnet-5-5×6`, 6 раундов. Судья codex gpt-6-luna, эскалация claude:sonnet, тестера нет.
- **Судья.** Блокер — красный тест, нарушение явного пункта фазы или запись вне территории. Крайний случай, которого нет в пунктах, идёт в долг как minor. Требование «сделать то, чего нет в плане» находкой не считается. В частности, **не находки**: позиции актёров, комната, препятствия, `clipfacts`, `plan.json`, `validate_plan`, кэш ответа, `plan.edited.json`, хеш `world`. Всё это либо делает рантайм, либо вынесено в долг (раздел «Не в этой версии»).
- **Фьюз.** Если за 6 раундов нет SHIP, хозяин переносит остаток в `specs/make-debt.md` (раздел «Камера, полоса B») и ставит `[x]` у чекбоксов.

### Общие правила

- **Живые вызовы запрещены:** ни Spark, ни Modal, ни Fish, ни сеть в тестах. `python3 -m make` — только с `--fake`.
- **Тесты:** сначала красный тест, потом код. Новых зависимостей нет. `unittest.TestCase`. Игрок гоняет тесты `h0/make`, весь набор гоняет гейт (`sh tools/gate.sh`).
- **Фикстура — настоящий прогон**, а не пересказ. `h0/make/testdata/shotplan_koshakan/` — файлы прогона Кошакана `runs/20261101-225137` без изменений:
  - `score.json` (5 битов; у битов есть `stage: [{who, action, place, pose, look?}]`, `action` ∈ `stay`/`goto`/`enter`/`exit`; у партитуры `cast`, `start: [{who, place, pose}]`, `scene`);
  - `stage.json` (`start: {who: place}`, `start_pose: {who: pose}`, `objects`);
  - `places.json` (`places: [{name, kind, room, poses, …}]`);
  - `cast.json` (ключи — имена актёров);
  - `catalog.json` — ответ моста `--catalog`, формат ниже.

  Тесты собирают папку прогона во временном каталоге из этих файлов (`story/score.json`, `stage/stage.json`, `stage/places.json`, `cast/cast.json`) и не пишут своих выдуманных партитур, если тесту не нужен особый случай. Особый случай — копия фикстуры с одной правкой в самом тесте.

### Контракт `shotplan/moves.json` (общий с полосой A, менять только через хозяина)

```json
{"version": 1, "scene": "bedroom", "style": "storybook",
 "beats": {"2": {"move": "follow_side", "subject": {"actor": "Mama"}},
           "3": {"move": "close", "subject": {"actor": "Mirai"}},
           "4": {"hold": true}},
 "warnings": []}
```

- `scene` — `score.scene`. `style` — ID из `catalog.styles`.
- Ключи `beats` — индекс бита в `score.beats` строкой (`"0"` … `"n-1"`; индексы `story/score.json` и `story/score.ru.json` совпадают). Бит без ключа — режиссёр выбирает сам по стилю.
- Значение — либо `{"move": <ID>, "subject": <субъект>}`, либо `{"hold": true}` (продолжить предыдущий план, без нового). Других полей нет.
- `move` ∈ разрешённые ID: `catalog.moves` ∪ `catalog.schemes` без `oner`, `rhythm_cut`, `open_from_light` ∪ `catalog.records`. Эти три схемы рантайм не исполняет, поэтому Spark их не предлагают.
- Субъект: `{"actor": имя}`, `{"pair": [имя, имя]}` (два разных) или `{"room": true}`. Имена — из `score.cast`. `{"room": true}` допустим только для `wide`, `master`, `establishing`.
- Ключи в файле отсортированы, отступ 2 (`json.dumps(…, indent=2, sort_keys=True, ensure_ascii=False)`), в конце перевод строки. Это даёт побайтное равенство.

### Контракт каталога (`--catalog` моста полосы A)

`node --import tsx bin/moves.ts --catalog` с `cwd = engine/` печатает в stdout JSON:
`{"styles": [id…], "moves": {id: смысл}, "schemes": {id: смысл}, "records": {id: смысл}, "weights": {style: {id: вес}}}`.
Мост появится только при слиянии с полосой A. До этого каталог берётся через одну функцию `shotplan.catalog() -> dict`, тесты её подменяют фикстурой `catalog.json`. В живом прогоне нет `engine/bin/moves.ts` или вызов упал → стадия `ok` без `moves.json`, предупреждение `SHOTPLAN_NO_CATALOG <текст>`.

### Не в этой версии (долг, не находки)

Кэш ответа Spark, `plan.edited.json`, `SHOTPLAN_STALE`, хеш `world`, картинка комнаты в промпте, геометрические проверки (`SHOT_OUTSIDE`, `SHOT_IN_PROP`), `back_frames` в критике, сквозной тест `make.film --camera-style ozu` (нужен рантайм полосы A — это приёмка хозяина после слияния).

---

## К3b. make: Spark выбирает приём на бит

Зоны: `h0/make/shotplan.py` (новый), `h0/make/core.py`, `h0/make/story.py`, `h0/make/__main__.py`, `h0/make/film.py`, `h0/make/critic.py`, тесты `h0/make/test_shotplan.py` (новый), `h0/make/test_critic.py`, настройка `test_core.py`/`test_e2e_fake.py`, `research/feature_map_camera_b.md`.

Правила. Каждое проверяется своим тестом (номер правила в имени теста: `test_r1_…`).

1. **Стадия в DAG.** `core.default_stages()` получает `S("shotplan", ("stage",), 1, _run_shotplan, ("fake", "camera_style"))`. `DEFAULT_SPLIT` = `{brief 2, refs 3, world 70, cast 15, story 8, shotplan 2}`, сумма 100. Тест: стадия есть, зависит только от `stage`, сумма долей 100.
2. **Поле в `stage.json`.** `story.run_stage` всегда пишет `"moves": "shotplan/moves.json"`: путь от папки прогона, независимо от того, будет ли файл. Версия стадии `stage` поднимается с 2 до 3, чтобы старые прогоны пересобрали `stage.json`. Стадия `shotplan` пишет только в свою папку. Тест: `stage.json` после `run_stage` содержит поле; версия `stage` = 3.
3. **`camera_style`.** Задаётся флагом `--camera-style <id>` в `__main__.py` (рядом с `--lang`) и попадает в `ctx.opts` как остальные параметры прогона. Ключ добавляется в `OPTIONAL_PARAMS` и входит в хеш стадии `shotplan`, но не стадии `stage`. Тест: смена `camera_style` пересчитывает `shotplan`, а `stage` берётся из кэша.
4. **Промпт** — функция `shotplan.prompt(run_dir, cat, style) -> str`, без побочных эффектов. В тексте есть:
   - список битов: индекс, `kind`, `who` (для реплики), текст, действия `stage` словами («Mama: goto bed, pose sit, look Mirai»);
   - начальная мизансцена из `score.start` («Mirai: bed, lie»);
   - имена мест из `places.json` и актёров из `score.cast`;
   - разрешённые ID с одной строкой смысла каждый (только разрешённые, см. контракт);
   - стиль сцены и его веса из `catalog.weights[style]`;
   - формат ответа (ниже) и правило: бит со сменой мизансцены (`goto`, `enter`, `exit`, смена позы относительно прошлого бита) снимается субъектом, в который входит этот актёр.

   Тест на фикстуре: в промпте есть все разрешённые ID и нет `oner`; есть строка с весом `push_in` стиля `storybook`; есть «Mirai» с позой `lie`; бит 2 помечен как смена мизансцены (Мама `goto`). Два вызова дают одинаковую строку.
5. **Ответ Spark** — JSON `{"style"?: id, "beats": [{"beat": i, "move": id, "subject": {...}} | {"beat": i, "hold": true}]}`. `Spark.ask` уже разбирает JSON и отдаёт `Answer` с `valid` и `scene` (`pipe2/spark.py:123`). Разбор — функция `shotplan.parse(scene, cat, score) -> (dict | None, warnings)`, где `scene` — `ans.scene` (или `None`, если `ans.valid` ложно):
   - `scene` не объект или `beats` не список → `None` и текст ошибки;
   - элемент без целого `beat` в `[0, n)` или повтор `beat` → элемент выкидывается, `BEAT_INVALID B<i>`;
   - `move` не из разрешённых → элемент выкидывается, `MOVE_UNKNOWN B<i> <id>`; бит остаётся режиссёру;
   - неверный субъект (имя не из `score.cast`, пара из одного имени, `room` не у `wide`/`master`/`establishing`) → элемент выкидывается, `SUBJECT_INVALID B<i>`;
   - `hold` на бите 0 → выкидывается, `HOLD_FIRST`.

   Тесты: по одному на каждую строку списка; `{"beats":[{}]}` → элемент выкинут, ответ не `None`.
6. **Вызов Spark.** Обвязка — как `_spark_director` в `story.py:51–72`: `Ledger(ctx.out / "events.jsonl", load_prices(), float("inf"), 2)`, `Spark(core._spark_transport(), ledger)`, вызов `spark.ask("shotplan", "moves", <номер попытки>, msgs, "high")`, не больше 2 вызовов. Если `parse` вернул `None`, второй вызов получает промпт плюс текст ошибки. Снова `None` → стадия `ok` без `moves.json`, предупреждение `SHOTPLAN_INVALID`. Трата попадает в учёт прогона через `ctx.spend(ledger.spent)`. Тесты (фейковый Spark): битый → повтор, и во втором сообщении есть текст ошибки; два битых → нет файла, `SHOTPLAN_INVALID`; третьего вызова нет.
7. **Стиль файла.** `camera_style` задан и есть в `catalog.styles` → он; задан, но неизвестен → `storybook` и `STYLE_UNKNOWN <id>` (Spark при этом всё равно вызывается). Не задан → `style` из ответа Spark, если он есть в `catalog.styles`; неизвестный → `storybook` и `STYLE_UNKNOWN <id>`. Иначе `storybook`. Тесты на все три случая.
8. **Запись.** `moves.json` строго по контракту: только принятые биты, `warnings` — все предупреждения разбора. Формат побайтно детерминирован. Тест на фикстуре: фейковый ответ с `follow_side` на Маму (бит 2), `close` на Мирай (бит 3), `hold` (бит 4) и одним `MOVE_UNKNOWN` даёт ровно файл из примера контракта плюс предупреждение. Два прогона дают одинаковые байты.
9. **`--fake`.** Spark не вызывается. Пишется `moves.json` с `beats: {}`, стиль по правилу 7, без ответа Spark; каталог — через `catalog()`, при его отсутствии `--fake` всё равно пишет файл, стиль `camera_style` или `storybook`. Без `--fake` и без `--live` стадия `shotplan` пропускается, как прочие (`_fast_stub`). Тест: `python3 -m make --fake` на фикстуре проходит, файл есть, два прогона побайтно равны.
10. **`film.py`.** `page_url(run_dir, static_port, sim_port, camera_style=None)` (`film.py:30`) добавляет `&camera_style=<id>`, если стиль задан. `record_scene` и `film` передают его дальше, у CLI `make.film` появляется флаг `--camera-style` (рядом с `--lang`, `film.py:188`). Тест: URL содержит параметр, если он задан, и не содержит, если не задан.
11. **`critic.py`.** `shots()` группирует факты по полю `dcut`, иначе по `shot`, если они есть в `critic.jsonl` (поля пишет рантайм К2). Если нет ни того ни другого (старый прогон), остаётся прежняя эвристика `critic.py:61–69`. Тесты: два плана с одинаковым `plan`, но разным `dcut` — это два плана; движение камеры внутри одного `dcut` не режет план; старый формат — прежний результат.

Проверки:
- [ ] красные тесты по правилам 1–11 на фикстуре `shotplan_koshakan`
- [ ] код; `research/feature_map_camera_b.md` дописан; старые тесты `h0/make` зелёные; гейт зелёный
