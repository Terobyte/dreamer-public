# Dreamer make: план для tero (день и ночь 2026-10-31)

Основание — спека `specs/2026-10-31-dreamer-make.md` v0.6 (прочитать целиком перед каждой фазой; критики в `specs/critique/make-v0.*`). Этот файл — только порядок фаз и чекбоксы; контракты, формулы, поля, фикстуры и тесты — в спеке, раздел «Стадии», «Фейки», «Фазы для tero». При расхождении права спека.

**Порядок:** М0 → М1 → М2 → М3 → М4 → М5 → М6 → Б1 → Б2 → Б3 → Б4 (блок Б — баги охоты 10-31, внизу; make важнее, сдача 4 ноября). Ветку `tero/make-one-prompt` tero заводит сам от текущей (ночь 10-30 + правки хозяина 10-31 уже закоммичены).

**Игроки и раунды (хозяин 10-31):** расписание фазы Sonnet ×1 → Muse ×6 → Opus ×1 (`--player-schedule claude:claude-sonnet-5-5×1,muse:muse-spark-1.3×6,claude:claude-opus-5-5×1`), 8 раундов. Судья codex gpt-6-luna, тестера нет, эскалация claude:sonnet.

**Фьюз:** нет SHIP за 8 раундов — хозяин-ведущий доделывает фазу в дереве или записывает долг в `specs/make-debt.md` и идёт к следующей фазе. Ночь не должна встать на одной фазе.

**Общие правила.**
- Сегодня (10-31) ни одного живого вызова: Spark, Muse Image, Modal, MuAPI, Fish, Commons/Fandom/Openverse/Tavily — даже бесплатного. В тестах сеть запрещена (`urllib.request.urlopen` → `AssertionError`, как в `h0/dream/test_freestyle.py`). Ключи не читать и не печатать.
- Сначала красный тест, потом код. Без новых зависимостей (stdlib в Python; в `engine/` — только то, что уже в `package.json`).
- Не читать `~/.dreamer-bench/**`, `h0/out/**`, `cache/`, чужие `dist/` (кроме фикстуры `h0/make/testdata/**/dist/`).
- **Номера строк в спеке устарели** для `h0/dream/sim.py`: хозяин 10-31 дописал «книга → фристайл» (`go_freestyle`, `_book_story`, `_free_pieces*`, `_free_events`, `_free_scene_dict`, `_free_exit`, аргумент `run(..., freestyle=False)`, события SSE `mode`/`story`/`schedule`). Искать функции по имени (`run`, `_load_book_plan`, `_seed_first_scene`, `main`, `go_freestyle`), не по номеру. Это поведение не ломать: `test_freestyle.py` и все `test_bugs_*` зелёные.
- `h0/squid_live/duo.py`, `duo.html`, `server.py` не менять; `duo.html` — образец для режима сцены (камера, субтитры, кнопка «Фристайл» и бегущая строка `story`).
- Зоны записи: `h0/make/**`, `engine/src/runtime/stage/**`, `engine/src/runtime/main.ts`, `engine/src/runtime/bridge.ts`, `engine/test/**` (новые тесты), `h0/dream/sim.py`, `h0/dream/fsm.py`, `h0/dream/books/jane-eyre/book.json`, `h0/dream/test_*.py` (новые), `.gitignore`, `specs/make-debt.md`.
- Гейт фазы — `sh tools/gate.sh` (его гоняет tero): `h0/dream` unittest, `h0/make` unittest (discover), `engine` `npx vitest run`, кроме файлов из `tools/gate_skip.txt` (открытые репро багов). Всё зелёное. `tools/gate.sh` не менять; `tools/gate_skip.txt` меняет только блок Б.

**Блок Б — баги охоты 2026-10-31 (фазы Б1–Б4, после М6).** Описание каждого бага — `bugs.md`, раздел «Охота 2026-10-31». Красные репро-тесты уже в репо и **не входят в гейт**, пока их файл стоит в `tools/gate_skip.txt`. Правила блока:
- репро-тест — это контракт: его утверждения не ослаблять; если тест доказуемо неверен, поправить его и записать почему в `bugs.md` у этого бага;
- когда все тесты файла зелёные, удалить его строку из `tools/gate_skip.txt` (так тест попадает в гейт и дальше охраняет починку); больше этот список никто не меняет;
- у починенного бага в `bugs.md` статус `fixed` и одна строка «как»;
- `h0/squid_live/duo.html` можно трогать только для B60 (мизансцена из полей бита вместо регэкспа по прозе), остальное в `duo.*` не менять.

---

## М0. Каркас, DAG, манифест

Пакет `make` в `h0/make/` (`cd h0 && python3 -m make`), стадии — заглушки, пишущие файл-маркер. Спека: «Принципы», «DAG», «Манифест, хэш, публикация», «Деньги», «Папка прогона», «CLI».

- [x] `make.json`, `input_hash` по формуле спеки (`stage, version, params, inputs`), пропуск при совпадении, перезапуск при изменении входного файла, `STAGE_VERSION` или `params` (в т.ч. `--fake`)
- [x] падение стадии → `<stage>.tmp/` и `status: failed`, повтор удаляет `.tmp/` (кроме `world`: остаётся для `--resume`); `--from X` перезапускает X и потомков, предков не трогает; `--fresh`
- [x] `--only stage` без `world/` → `missing input: world/…`, ничего не запущено
- [x] три заглушки `world`/`cast`/`story` по 0.3 с пересекаются по времени (параллельно)
- [x] лок `.lock` (O_EXCL + pid): второй процесс → ошибка; лок мёртвого pid снимается
- [x] `--max-dollars` + `--split`: фиксированные доли, стоп новых стадий при сумме трат ≥ D (`failed`, причина `budget`)
- [x] `runs/` в `.gitignore`; `!h0/make/testdata/**/dist/` исключение

## М1. brief

Спека: «`brief` — промпт → план».

- [x] схема `h0/make/schema/brief.json`, проверка кодом; enum `voice` = ключи `h0/dream/voices.json`
- [x] сценарный Spark-фейк (по образцу `ScenarioSpark`, `pipe2/fakes.py`); невалидный ответ → один повтор с текстом ошибки → `failed`
- [x] слияние с `book.json` (тест на `h0/dream/books/gwtw`): имена и пол из книги, конфликт имени/пола → ошибка схемы

## М2. refs

Спека: «`refs` — найти и отобрать картинки», «Фейки».

- [x] провайдеры `commons`, `fandom`, `openverse`, `tavily` в `h0/make/refs/` на stdlib, один интерфейс `search(query, n)`; тесты на записанных JSON в `h0/make/testdata/refs/`
- [x] лицензии: Commons `CC BY-SA 4.0` → `usable_for_submission: true`, `Fair use` → `false`; fandom и tavily всегда `false`; без `TAVILY_API_KEY` tavily не вызывается
- [x] скачивание параллельно (фейковый загрузчик), фильтр: короткая сторона ≥ 512, PNG/JPEG по сигнатуре; WebP/SVG/GIF отброшены
- [x] `--pick first` детерминирован; `--pick vision` на сценарном фейке; `refs.json` со всеми кандидатами и `kept`; `cues.md`

## М3. world + story + Джейн Эйр

Спека: «`world`», «`story`».

- [x] адаптер `brief + refs → world/task/TASK.md` (тест-снимок, по шаблону `anymove/runs/pineapple/task/TASK.md`, правило «без имён»)
- [x] argv `pipe2 run` со всеми тремя `--cap-*` и `--effort` (тест на argv, без запуска); `--fake` копирует фикстуру `world_run/`; упавший `world` продолжает с `--resume`, `--from world --fresh` начинает заново
- [x] `story`: `book` через `book.score_scene` (с `score.edited.json` и без; другая `scene` → ошибка), `seed` → `seed.txt`; флаг `--freestyle` записывается в `stage.json` и доходит до `sim.run(freestyle=True)`
- [x] `h0/dream/books/jane-eyre/book.json` на главу XIII: каст и голоса по спеке, `aliases` с `I`/`me` → `Jane Eyre`, `narrator_voice: "woman"`; `python3 book.py books/jane-eyre --scene <id> --stats` даёт ≥ 20 битов `line`, `unattributed` ≤ 40 %; тест на это
- [x] `narrator_voice` читается симом; книги без поля — прежний голос рассказчика

## М4. stage (банк мест) + сим

Спека: «`stage` — банк мест», «`play`» (часть «Сим»), «Фейки». Фикстура `h0/make/testdata/world_run/` собирается `build_world_run.sh` реальным билдом движка с `fakeGlb`/`fakePng`.

- [ ] фикстура `world_run/` (2 комнаты, дверь со створкой, ≥ 5 предметов: диван, кресло, стол, лампа `on` стол, ковёр `solid:false`) и `cast/` (cast.json + 2 GLB от `fakeGlb`)
- [ ] `places.json`: позиции из `geometry.json` (GLB: `glbYaw` радианы → градусы; плейсхолдер: центр AABB + yaw из scene.json; тест «GLB = плейсхолдер» ± 1° / ± 0.05 м), размер из `size`, диван/кресло → `sit`, `on`-лампа и ковёр без места и препятствия, копии `around`, имена с повторами, точка двери по числовому примеру, предмет без клетки nav → предупреждение
- [ ] `h0/make/testdata/expect_touch.json` — 4 случая с заранее посчитанными числами (спека, «Фиксированные ожидания»)
- [ ] `stage.json` по схеме спеки
- [ ] `sim.run(plan=…)`, `no_build=True` (`start_build` → `invalid`, `reason: "no_build"`), `sim.seed_start(text, transport, objects)`; `test_phase3_seed`, `test_freestyle`, `test_book_play` и `test_bugs_*` зелёные без правок
- [ ] `h0/make/play.py --fake` в `book` и `seed` (и `book --freestyle`) пишет `log.jsonl` по критерию сквозного теста; `duo.py` не изменён

## М5. Сцена в рантайме движка

Спека: «Сцена в рантайме движка», «Контракт `touch`», «Проверки».

- [ ] `engine/src/runtime/stage/places.ts` (`resolveTouch`, `stageRegex`) — vitest на 4 случаях `expect_touch.json`, числа из файла, не из `resolveTouch`
- [ ] `path.ts` (BFS по `nav.json` с дверями и `obstacle`), `camera.ts` (в контуре комнаты с отступом 0.3, ниже `height − 0.3`) — vitest
- [ ] `actors.ts` (GLB, рост по `height_m`, процедурная ходьба/кивок, `sit` = −0.45 м), `subs.ts` (строки `line`/`narrator`, `Audio` по `r.audio`)
- [ ] книга → фристайл в режиме сцены как в `duo.html`: кнопка «⚡ Фристайл [G]» шлёт `POST <sim>/freestyle`, событие `mode: freestyle` переключает её, `story` — бегущая строка; без `?stage=` кнопки нет
- [ ] мост: `createBridge` получает обработчики `line`, `narrator`, `touch`, `mode`, `story`; прочие — как сейчас
- [ ] браузерный тест в `engine/test/browser/` по спеке (фейковый SSE из `log.jsonl`, 4 случая, актёр ≤ 0.3 м / ± 10°, камера внутри комнаты); без `?stage=` прежние браузерные тесты зелёные

## М6. cast путь A + сквозной `--fake`

Спека: «`cast`», «Сквозной тест М6».

- [ ] `cast`: проверка `cast.json`/GLB (GLB читается, `height_m` ∈ [0.5, 2.5], `voice` ∈ `voices.json`), ошибки по полю
- [ ] сквозной тест: `python3 -m make "<промпт из фикстуры>" --fake --run <tmp>` → все стадии кроме `check` `ok`; `stage.json` по схеме; каждый `name` из `objects` есть в `places.json`; повторный запуск ничего не запускает; без `--fake` в ту же папку — перезапуск всего (тест argv, без сети)
- [ ] `play.py --fake` в `book` и `seed` поверх результата сквозного прогона: в `seed` строка с `touch: "armchair"`, в `book` — ремарка случая 3
- [ ] `PROGRESS.md`: раздел «Dreamer make» — что сделано, что в долге, команды живого прогона на 11-01

## Б1. dream: очередь реплик, консультации, голос (B43 B46 B47 B48 B49 B51 B60)

Файлы тестов: `h0/dream/test_bugs_sim_queue.py`, `test_bugs_sim_flow.py`, `test_bugs_director.py`. Зоны: `h0/dream/sim.py`, `director.py`, `fsm.py`, `voice.py`, `h0/squid_live/duo.html` (только B60), `bugs.md`, `tools/gate_skip.txt`.

- [ ] B43: строка человека в очереди стартует после переходной наррации, взаимной блокировки нет
- [ ] B46 + B47: вторая реплика человека не затирает первую; события и «Just now» героя не теряются на `turn_skip`/смене сцены
- [ ] B48: события консультации (HUMAN_SAYS, клики, `ready_stale_fired`, `nudge`) переживают отброшенный/упавший/устаревший ответ директора
- [ ] B49: синтез голоса не блокирует тик (фон), B51: финальная строка cost после join фолдов Dialogue
- [ ] B60: `line` книжного бита несёт `stage`/`gesture`/`shot`; `duo.html` ставит мизансцену по ним, регэксп — запасной
- [ ] три файла зелёные и убраны из `tools/gate_skip.txt`; `test_freestyle.py` и прочий гейт зелёные

## Б2. dream: сервер и LLM (B30 B52 B53)

Файлы тестов: `h0/dream/test_bugs_server.py`, `test_bugs_llm_bench.py`. Зоны: `h0/dream/server.py`, `llm.py`, `bench_f1.py`, `bank.py`, `bugs.md`, `tools/gate_skip.txt`.

- [ ] B30: отвергнутый POST дочитывает или закрывает соединение — тело не становится следующим запросом
- [ ] B52: после капа Spark Open не уходит в платный Spark 1.3 мимо капа
- [ ] B53: один `TimeoutExpired` не теряет пачку; мёртвый прогон не считается по потолку
- [ ] два файла зелёные и убраны из `tools/gate_skip.txt`

## Б3. engine: проёмы, открытые комнаты, ходьба (B11–B16 B38)

Файлы тестов: `engine/test/bugs-openings.test.ts`, `bugs-openroom.test.ts`, `bugs-walk.test.ts`. Зоны: `engine/src/openings/**`, `engine/src/stairs/**`, `engine/src/decals/**`, `engine/src/runtime/walk.ts`, `bugs.md`, `tools/gate_skip.txt`.

- [ ] P2 (B11 B12 B13): псевдокомната `"walls"` сортируется последней, как в `merge.roomOrder`; `at`-проём на свободной стене не пропадает, индексы `geos`/`openings` не расходятся, `sRange` не падает
- [ ] P1 (B14 B15): открытость комнаты читается из `open`, а не из `height == 0`
- [ ] B16: стрейф D вправо; B38: клавиши сбрасываются на `blur`
- [ ] три файла зелёные и убраны из `tools/gate_skip.txt`; golden-тесты движка зелёные

## Б4. engine: бюджет, check --built, камеры (B19 B20 B21 B22 B35 B37)

Файлы тестов: `engine/test/bugs-budget.test.ts`, `bugs-built.test.ts`, `bugs-camera.test.ts`. Зоны: `engine/src/build/**`, `engine/src/assets/**`, `engine/src/cameras/**`, `engine/src/budget*`, `engine/bin/dreamer.ts`, `bugs.md`, `tools/gate_skip.txt`.

- [ ] B20: нечитаемый или отсутствующий GLB — ошибка бюджета, не 0 треугольников
- [ ] B21: лимит point-light на сцену и на комнату, уровень error
- [ ] B19: `check --built` берёт камеры из сцены и не принимает устаревшие снимки; B37: имена снимков уникальны без учёта регистра
- [ ] B22: камера над низкой стеной не считается внутри стены (учёт высоты); B35: второй `writeDist` с тем же ctx сохраняет `cam.ref`
- [ ] три файла зелёные и убраны из `tools/gate_skip.txt`; `tools/gate_skip.txt` пуст (кроме комментария)
