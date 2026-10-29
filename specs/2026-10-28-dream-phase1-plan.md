# Dream Phase 1 — ядро: код решает, модель озвучивает

> **For agentic workers:** план идёт через tero: одна `##`-секция = одна фаза = одна строка таблицы 7.2 спеки. Шаги — чекбоксы.

**Goal:** текстовый движок dream, в котором переходы, очередь говорящих, события, цели и замок на строку решает код, а модель только озвучивает строку.

**Architecture:** правки в `h0/dream/` (`fsm.py`, `sim.py`, `dialogue.py`, `director.py`, `bank.py`, `fake.py`, `scenes/*.json`). Каждая фаза — офлайн-тесты на `FakeTransport` (TDD), затем, где спека требует, один платный бенч через `bench_f1.py`, который сам держит потолок денег и считает гейт.

**Tech Stack:** Python 3 stdlib, `unittest`, без новых зависимостей.

**Spec:** `specs/2026-10-28-dream-story-design.md` v1.0. **Норматив — 7.1, 7.2, 7.4, 7.5 и §13 «Долг».** В каждой фазе сначала прочитай её строку таблицы 7.2 **целиком** (колонки «что», «зависит», «гейт») и все пункты Долга с её номером; этот план не пересказывает спеку, он фиксирует имена, тесты и порядок. При расхождении плана со спекой права спека, а расхождение запиши в DEVLOG.md.

### Global Constraints

- Писать только в `h0/dream/**`, `h0/out/dream/**`, `DEVLOG.md`, `PROGRESS.md`, `specs/**`. Новых зависимостей нет.
- Тесты: `cd h0/dream && python3 -m unittest -q`. Они офлайн: ни один тест не ходит в сеть. Файлы тестов не удалять, отдельные тесты переписывать под новое поведение (7.1).
- Ключи не печатать, не писать в логи, DEVLOG и ответы.
- Платный вызов идёт **только** через `python3 h0/dream/bench_f1.py …` (фаза 1.0). Прямой `bank.py`/`sim.py` с живыми моделями запрещён.
- Потолок денег фазы 1 — **$1.80** по `h0/out/dream/bank/f1_ledger.jsonl`. Спайк 1.5 — вне потолка, при условии `потрачено + 0.20 ≤ 1.83`. После второго провала гейта одного шага бенч этого шага больше не запускается (`bench_f1.py` выходит с кодом 3). Тогда фаза сдаётся с записью в DEVLOG «гейт не пройден: …», а решение за хозяином.
- Числа-параметры (`TICK`, `THRESHOLD`, веса давления, `ready_timeout`) лежат в DEFAULTS `fsm.py` или константах `dialogue.py`. Меняешь число — пиши в DEVLOG с цифрами бенча до и после.
- Каждый бенч оставляет строку в DEVLOG.md: шаг, `run_*`, $ за прогон, метрики гейта, PASS/FAIL.

### Review Focus

1. Человек пишет (`human_say`), пока генерация в полёте при новом такте. Ждём, что старая строка не прозвучит: будет `line_discarded {who, reason: human}`. Тест в 1.2a.
2. Последнее слово фразы предмета не уникально среди `objects` (два предмета на `door`). Тогда псевдонима нет, и петля по слову «door» не ловится как предмет. Тест в 1.1.
3. Строка начинается с ремарки или имени из фактов (`[sighs] Well…`, `Maya, stop`). Замок имён её не отвергает. Тест в 1.1.
4. `ready_stale` при `speed 8` срабатывает через 75 реальных секунд, а не через 600. Тест в 1.0.
5. После `transition` в очереди «Just now» остались записи для актёра, которого нет в новой сцене. Ждём, что они ему не доставляются и не попадают никому другому. Тест в 1.3.

---

## 1.0 снять лестницу

Строка 1.0 таблицы 7.2 и вся 7.1. Долг: Д2, Д4, Д5.

- [x] Фикстуры: `FakeTransport(script=(), reply=None, gate=None)` в `fake.py`. Сигнатура `complete(model, effort, system, messages, max_tokens)` прежняя. Хелпер `pump(sim)` по абзацу «Фикстуры» 7.2 кладётся в `test_phase1_util.py`; его импортируют все тесты фазы. Тест `test_fake_reply_and_gate` проверяет, что `reply` получает `system` и что `gate` держит вызов, пока не выставлен.
- [x] Тест `test_ready_no_touch_no_transition`: FSM в `ready` 700 сим-секунд без касания. Нет `transition`, есть ровно один тикет `label == "ready_stale"` после 600 с, второго за тот же `ready` нет.
- [x] Тест `test_ready_stale_scales_with_speed` (Review Focus 4): при `speed=8` тикет `ready_stale` выдаётся на 75-й реальной секунде, на 74-й его нет.
- [x] Тест `test_door_then_touch`: полный `Dialogue + FakeTransport(reply=…)`. При `building → ready` в логе `ready`, затем `door {state: open}`. `_hero_world` содержит `"the <bridge> has swung open"`. Ответ героя с `[[TOUCH:<bridge>]]` даёт `transition.via == "touch"`.
- [x] Снять всё из 7.1: `auto_touch`, `ready_deadline`, L0–L4, `hint_level`, `STALL_LINES`/`cooldown`, `world["pull"]`, исключение `touch != pull`, `filter_actor_line` (`director.py:69` и вызов `dialogue.py:490`). Добавить `"ready_timeout": 600` в DEFAULTS и сделать `ready_stale` в `due`/`begin_consult`. Предложение `HERO_RULES` про `[[TOUCH:…]]` остаётся. `run_stress` выходит из `ready` вбросом `[[TOUCH]]`.
- [x] Инструменты бенча. `--max-seconds` (`default=None`, ветка `is None` в `sim.py:853`) прокинут через `bank.run_scene`. `sim.main()` при окончании по `--max-seconds` выходит с кодом 0 (Д5). В `bank.score` все метрики 7.4, кроме `action_loops`, `loop_cuts`, `lock_rejects`, `turn_skips`, `events_*`. Тест `test_score_r1_baseline`: на `h0/out/dream/bank/run_0_978509..978512` `vocab` = 0.709/0.687/0.700/0.745 ±0.005, `dare_lines` = 1/2/1/0. Если логов r1 нет, тест делает `skipTest`.
- [x] `h0/dream/bench_f1.py`. Запуск `--step STEP --runs N` идёт той же командой, что в 7.2 (`bank.py --scenes roof --talk spark-open --runs N --speed 8 --max-dollars 0.20 --max-seconds 67.5 --out h0/out/dream/bank`). Перед запуском обёртка выходит:
  - с кодом 2, если сумма `dollars` в ledger + 0.20·N > 1.80 (для `1.5`: > 1.83 по всем записям);
  - с кодом 3, если у шага уже две записи с `gate: FAIL`.

  После прогона в ledger дописывается `{step, runs: [run_dir…], dollars, metrics, gate}`, на экран выводится таблица метрик с медианой и PASS/FAIL по `GATES[step]`. `GATES` — словарь порогов, переписанный из колонки «гейт» 7.2 для 1.0, 1.1, 1.2b, 1.2c, 1.3, 1.4, Ф1, включая «живость» и правило медианы (`action_loops`/`dare_lines` = 0 в каждом прогоне, `null` = провал). У 1.2c пороги относительные: обёртка берёт медиану 1.2b из ledger. Запуск `--score RUN_DIR…` бесплатный: только пересчёт, без ledger. Тест `test_bench_f1_budget_refuses` (подменённый ledger на $1.70 → код 2, сеть не трогается) и `test_bench_f1_gate_median`.
- [x] Все тесты зелёные. Затем бенч `python3 h0/dream/bench_f1.py --step 1.0 --runs 1` и строка в DEVLOG. Гейт: `dare_lines = 0`, число переходов идёт в лист.

## 1.1 замок на строку

Строка 1.1 таблицы 7.2. Имена функций — `dialogue.py`, их же импортирует `bank.score`:
`lock_line(text, objects, names) -> tuple[str | None, str | None]` (текст после обрезки ремарок или `None`, причина `len|remarks|objects|name`);
`loop_items(text, objects) -> set[str]` (множество X);
`count_action_loops(rows) -> int`.

- [ ] Тест `test_lock_rejects_all_two_calls`: замок отвергает всё. Значит ≤ 2 вызова транспорта на ход, в логе `turn_skip {who}`, следующая генерация не раньше `clock.scale(4)`.
- [ ] Тесты `lock_line`: > 25 слов → `len`; 4 ремарки → обрезка до 3; 6 → `remarks`; два предмета → `objects`; неизвестное имя → `name`. Review Focus 3: `"[sighs] Well, Maya, stop."` при `Maya` в фактах проходит. Стоп-лист имён и отрезание `'s`/`s` (`Maya's`, `Fridays`) тоже проходят.
- [ ] Тесты `loop_items`: «roof door» — один предмет, а не два; первая ремарка не даёт псевдонимов; псевдоним `dish` → `satellite dish`. Review Focus 2: при `objects = ["roof door", "car door"]` у `door` псевдонима нет.
- [ ] Тест `test_action_loops_synthetic`: один предмет в трёх строках Дэна подряд без `loop_cut` → `count_action_loops ≥ 1`; с `loop_cut` → 0. Тест `test_action_loops_r1`: логи r1 дают 0/0/≥10/0 для 978509/978510/978511/978512 (`skipTest`, если логов нет).
- [ ] Реализация: замок внутри существующего `for attempt in range(2)` (`dialogue.py:420, 473`), `loop_cut` в промпт и снятие предмета на 4 хода. Факт «his sister is Maya» добавляется в `roof.json`. `HERO_RULES` переписывается по 7.2. В `bank.score` добавляются `action_loops`, `loop_cuts`, `lock_rejects`, `turn_skips`.
- [ ] Все тесты зелёные. Затем бенч `--step 1.1 --runs 1` и строка в DEVLOG.

## 1.2a такт

Строка 1.2a таблицы 7.2. Долг: Д3. Шаг только офлайн, бенча нет.

- [x] Тест `test_no_second_generation_in_flight`: `FakeTransport(gate=…)`, вызов держится дольше `scale(TICK)×6`. Второй генерации нет, пока первый вызов в полёте.
- [x] Тест `test_first_free_tick_immediate`: по окончании `active_line` генерация стартует на том же шаге `pump`, далее не чаще `scale(TICK)`.
- [x] Тест `test_human_discards_in_flight` (Review Focus 1): `human_say` при генерации в полёте даёт `line_discarded {who, reason: "human"}`, старая строка не попадает в лог `line`.
- [x] Реализация по 7.2: `TICK = 4`, свободный такт, `_turn_epoch` вместо `_human_epoch`, `last_tick = now − scale(TICK)`, поля `who, reason` у обоих `line_discarded`.
- [x] Все тесты зелёные.

## 1.2b давление и молчание

Строка 1.2b таблицы 7.2. Долг: Д2 (исключить `roof3.json` из `bank.main`). Имя: `Sim._pressure(name) -> dict` с полями события `pressure` из 7.4.

- [ ] Тест `test_pressure_formula`: на заглушке Dialogue `p = 3·addressed + 2·event_hit + 1·goal_open + 0.5·min(ticks_silent, 6) − 2·spoke_last`. Проверить затухание `addressed` через 2 свободных такта и что такты тишины не меняют `spoke_last`.
- [ ] Тест `test_two_actor_lines_block_actors`: после двух строк актёров подряд актёр не выбирается, а `pressure` пишется. Герой добирает порог тишиной: `max_actor_streak ≤ 2` на 40 ходах.
- [ ] Тест `test_roof3_rotation`: сцена `roof3`, 40 ходов. Названный по имени отвечает следующим в ≥ 80% случаев, у каждого из 3 актёров ≥ 5 строк. В последовательности актёрских строк без строк героя есть «A, B, A» и «A, B, C».
- [ ] Тест `test_no_silence_while_in_flight`: задержка > `scale(TICK)×6`, `silence` нет.
- [ ] Тест `test_human_counts_as_hero`: `human_say` сбрасывает серию актёров, а герой-NPC получает `spoke_last`.
- [ ] Реализация: выбор по давлению вместо `_next_speaker`, `THRESHOLD = 2.0`, лог `silence`/`pressure`. Добавить `scenes/roof3.json` (Max; Dan, Maya, neighbor) и исключить его в `bank.main`. Метрики `silence_turns`, `silences_per_line`, `max_actor_streak`, если 1.0 их не досчитал.
- [ ] Все тесты зелёные. Затем бенч `--step 1.2b --runs 2` и строка в DEVLOG.

## 1.2c короткий контекст

Строка 1.2c таблицы 7.2.

- [ ] Тест `test_transcript_keep_4`: промпт актёра содержит не больше 4 последних строк транскрипта. `COMPACT_EVERY` и окно `mind`/`compact` сверены под 4.
- [ ] `TRANSCRIPT_KEEP` 8 → 4.
- [ ] Все тесты зелёные. Затем бенч `--step 1.2c --runs 1` (сравнение с медианой 1.2b из ledger) и строка в DEVLOG.

## 1.3 расписание событий

Строка 1.3 таблицы 7.2. Долг: Д1, Д3.

- [ ] Тест `test_events_fire_in_silence`: события `roof.json` срабатывают при полной тишине в срок `t_sim = (now − scene_start)·speed`, лог `schedule` при старте и `event` в срок.
- [ ] Тест `test_old_scene_events_dead`: после `transition` событие прежней сцены не срабатывает.
- [ ] Тест `test_pending_dropped_for_absent_actor` (Review Focus 5): запись «Just now» для актёра, которого нет в новой сцене, не доставляется никому.
- [ ] Тест `test_situation_hero_as_event_any_scene` (Д1): у сцены `bus` `situation_hero` приходит герою событием `t=0`, а не из начального `_hero_world`.
- [ ] Реализация по 7.2: `events` в сцене, `self.scene_start`, проверка на каждом шаге `_tick`, `self._pending` по получателю вместо `_actor_events`, рост `_turn_epoch` по событию, `event_hit` в давлении. Стартовые события крыши лежат в `roof.json` (§9 и событие Дэна `t=0`), импульсы героя разделены. В `bank.score` добавить `events_fired`/`events_planned`.
- [ ] Все тесты зелёные. Затем бенч `--step 1.3 --runs 1` и строка в DEVLOG.

## 1.4 цель актёра

Строка 1.4 таблицы 7.2. Имена: `Dialogue.judge(goal, last4) -> "YES" | "NO"`, `Sim._judge_yes`, `Sim._judge_last_line`.

- [ ] Тест `test_goal_done_by_code`: строка Max со словом «fired» без вопроса Дэна о работе в предыдущей строке даёт `goal {status: done, by: code}`, и открывается следующая цель. С вопросом Дэна цель не закрывается (`not_after`).
- [ ] Тест `test_judge_two_yes`: для цели с `judge: true` после двух `YES` подряд пишется `done, by: judge`. `NO` сбрасывает счёт. Вызовов не больше одного на 4 строки, свободный такт они не блокируют.
- [ ] Тест `test_goal_open_in_pressure`: при открытой цели у актёра `goal_open = 1`.
- [ ] Реализация: `goals` в `roof.json` (2–3 цели), логи `goal`/`judge`, метрики `goals_done`, `goal_first_line`, `judge_calls`.
- [ ] Все тесты зелёные. Затем бенч `--step 1.4 --runs 1` и строка в DEVLOG.

## 1.4b поля директора

Строка 1.4b таблицы 7.2. Шаг только офлайн. Имя: `fsm.clean_extras(d, hero) -> dict | None`.

- [x] Тест `test_bad_goals_keep_bridge`: директор на `FakeTransport` отдаёт кривые `goals`. Мост и `next_scene` остаются, `fail_streak == 0`, в логе `invalid {fields: ["goals"], reason}`.
- [x] Тест `test_good_extras_reach_next_scene`: корректные `events`/`goals`/`hero_reason` доходят до следующей сцены: строка `schedule` с ними, `hero_reason` приходит событием `t=0, who=[hero]`.
- [x] Тесты `clean_extras`: `t > 600`, 2 или 6 событий, `who` вне актёров, `goals[].actor` вне актёров — каждый случай даёт дескриптор `invalid`.
- [x] Реализация: `DIRECTOR_SCHEMA` += поля, `max_tokens` 2200, `BuildFSM(hero=None)`, вызов в `finish_consult` перед `check_target`, перенос в `_apply_transition`.
- [x] Все тесты зелёные.

## 1.5 спайк: русский

Строка 1.5 таблицы 7.2. Гейта нет, шаг фазу не блокирует.

- [x] Тест `test_lang_en_score_unchanged`: `bank.score` на логах r1 при `en` побайтно прежний (`skipTest` без логов).
- [x] Флаг `--lang ru` по 7.2. Затем прогон `python3 h0/dream/bench_f1.py --step 1.5 --runs 1 --lang ru`. В DEVLOG: есть ли `invalid`, что сломалось на кириллице, принимает ли drama-3 русские ремарки. Если обёртка отказала по бюджету (код 2), так и записать.
- [x] Все тесты зелёные.

## Ф1 итог фазы

Строка Ф1 таблицы 7.2. Код не меняется.

- [ ] Бенч `python3 h0/dream/bench_f1.py --step Ф1 --runs 2`. Гейт Ф1 считается по правилу медианы, бенч-гейты 1.2b–1.4 — на этих же прогонах.
- [ ] Итог фазы в DEVLOG и PROGRESS.md: таблица всех шагов (метрики, $, PASS/FAIL), сумма ledger, пункты Долга §13 (закрыт или открыт). Отдельной строкой: «чтение человеком ≥ 3 (7б) — за хозяином».

## 2.1 POV

Строка 2.1 таблицы 7.2 (Фаза 2 «Игрок внутри»). Шаг офлайн, бенча нет.

**Правила фаз 2.1–3.3:**
- **Не-fake путь.** Ни один тест не создаёт `Sim(fake=False)`: у `Sim` нет параметра transport, а директор при `fake=False` зовёт платный Wonder. Где нужен не-fake путь (TTS), тест делает так:
  - строит `Sim(fake=True, outdir=tmp, memory=<фейк>, media={"voice": Stub()})`;
  - затем ставит `sim.fake = False`;
  - патчит `director.llm_call` моком с `assert_not_called()`.
- **`llm_call`.** Ни один тест не зовёт его без `_transport`.
- **`use_scene`.** Он меняет глобалы модуля, поэтому каждый тест, который его зовёт, делает `addCleanup(use_scene, "start")`.
- **Настоящая память.** Тесты, которым она нужна, берут `Dialogue` + `FakeTransport(reply=…)`, а не заглушку `_ScriptedDialogue`. Перед `pump` гейт фейка открывают (`gate.set()`): `pump` ждёт поток `join(2)`, а фейк держит 5 с.
- **Сцена с 3+ актёрами** — `scenes/roof3.json`: герой Max, актёры Dan, Maya, neighbor.

Имена:
- `Sim.hero_owner: "npc" | "human"` (по умолчанию `"npc"`).
- `POST /pov {"hero_owner": …}` проверяет значение, затем делает `sim.submit("pov", …)` → `_drain_inbox` → `Sim.set_pov(owner) -> list[dict]`.
- `GET /api/hero` отдаёт живое состояние, а не лог.
  - Без живого сна → `409 {"error": "no live dream"}`.
  - Тело — `{facts: [str], diary: [str]}`: `facts` — тексты фактов с `hidden_from_hero: false`, `diary` = `[profile["soul"]["diary"]]`.
  - Профиль — `sim.dialogue.profile`, а без `dialogue` (fake) — `load_profile(sim.profile)`.
- Подготовленная строка: `prepared_npc` (строка), её говорящий — `_prepared_meta["who"]`.

Правило:
- При `human` герой молчит, пока игрок не скажет.
- Актёры после двух своих строк подряд ждут игрока, как ждали героя (серия ≤ 2).
- Без актёров `_pick_speaker` при `human` никого не выбирает.

- [ ] Тест `test_pov_human_silences_npc_hero`: после `set_pov("human")` 30 × `pump` на `Dialogue` + `FakeTransport` → ни одной `line` героя с `turn_owner: npc`; в `pressure` нет записи героя; в логе ровно одна `pov {t, hero_owner: human}`.
- [ ] Тест `test_pov_back_to_npc_resumes`: `human` → `npc` → за 30 × `pump` появляется `line` героя с `turn_owner: npc`; `sim.dialogue.mind(hero)` — тот же объект, что до `human`.
- [ ] Тест `test_pov_discards_hero_in_flight`: генерация героя в полёте (`_gen_who` = герой, гейт закрыт) → `set_pov("human")` → `_turn_epoch` вырос на 1; после `gate.set()` и одного `pump` → `line_discarded {who: hero, reason: human}`, нет `transition`.
- [ ] Тест `test_pov_keeps_actor_in_flight`: в полёте строка актёра → после `set_pov("human")`, `gate.set()` и `pump` строка актёра выходит (`line` актёра есть, `line_discarded` нет).
- [ ] Тест `test_pov_drops_prepared_hero`: `prepared_npc` готов и `_prepared_meta["who"]` = герой → после `set_pov("human")` его нет, в логе `line_discarded {who: hero, reason: human}`.
- [ ] Тест `test_server_pov`: `POST /pov {"hero_owner": "human"}` → 200 и после `_drain_inbox` `sim.hero_owner == "human"`; `{"hero_owner": "x"}` → 400; чужой `Origin` → 403 (как у `/say`); без живого сна → 409; `GET /api/hero` → 200 с `facts` (только не скрытые) и `diary`.
- [ ] `comic.html` содержит `fetch('/pov'` с `Content-Type: application/json` и `fetch('/api/hero'` (§9). Лог `pov` идёт через `_emit`.
- [ ] Все тесты зелёные.

## 2.2 предохранитель

Строка 2.2 таблицы 7.2. Шаг офлайн.

Имена:
- новый `safety.py` с `PHRASES: dict[str, tuple[str, ...]]` (`"en"`, `"ru"`) и `match(text) -> str | None`;
- `Clock.pause()`, `Clock.resume()`;
- `Sim.safety_paused: bool`;
- `POST /continue` (путь как у `/pov`: `submit` → `_drain_inbox`);
- `SOFT_NOTE` — одна фиксированная записка актёрам.

Правила:
- **Пауза** останавливает строки, директора, таймеры `fsm`, события, картинки и TTS. `_drain_inbox` продолжает работать, иначе «продолжить» не дойдёт.
- **Совпадение.** `match` идёт сразу после `sanitize`, и `human_say` возвращается до любого `_emit`. Поэтому реплика:
  - не ставится в `next_line`;
  - не попадает в `memory` (ни `input`, ни `line_queued`);
  - не зовёт директора.

  `safety_pause` пишется через `_diagnostic`.
- **Новая реплика во время паузы** проверяется `match`. Если совпадения нет, она отбрасывается: `input_dropped {t, reason: safety}` через `_diagnostic`.

- [x] Тест `test_safety_match`: `match` работает без учёта регистра, после схлопывания пробелов, по подстроке.
  - Стартовый список (решение хозяина, правится в `safety.py`, запись в DEVLOG): en `kill myself`, `want to die`, `end my life`, `suicide`, `hurt myself`; ru `убить себя`, `хочу умереть`, `покончить с собой`, `суицид`, `причинить себе вред`.
  - «I'll kill this song» → `None`.
- [x] Тест `test_safety_pauses_everything`. Тест **не** использует `manual_clock`: он патчит `clock.time.monotonic` до создания `Sim(...)`, иначе `Clock.t0` взят с настоящих часов, и двигает её руками.
  - `human_say("i want to die")` → `safety_pause {t, matched: "want to die"}`.
  - Нет `line` с `turn_owner: human`, `len(director.prompts)` не вырос.
  - Затем 50 × (`_tick(); _maybe_generate_line(); _maybe_consult(-1e9)`), между шагами `monotonic` сдвигается на 5 с. После этого: `FakeTransport.calls` не растёт, нет `line`/`event`/`consult`, `fsm.state` тот же, `sim.clock.now()` тот же.
- [x] Тест `test_safety_drops_input_while_paused`: во время паузы `human_say("hello")` → `input_dropped {reason: safety}`, нет `line_queued`.
- [x] Тест `test_safety_no_tts`: `Sim` собран по общему правилу, `Stub.synthesize(text, label, out_path)` считает вызовы и возвращает `{"ok": False, "pause": 0.2}` (`_start_line` читает `res["ok"]` и `res["pause"]`). Во время паузы `_start_line` не зовёт `synthesize`, после `/continue` зовёт.
- [x] Тест `test_safety_ignores_npc`: строка актёра со словом `suicide` паузу не ставит. Проверяется только ввод человека: `human_say` и `POST /event`.
- [x] Тест `test_continue_resumes_soft`: `POST /continue` → флаг снят, часы идут с того же `now()`, каждый актёр сцены получает `SOFT_NOTE`. После двух `/continue` подряд `sim._notes[a].count(SOFT_NOTE) == 1` для каждого актёра.
- [x] Тест `test_clock_pause_resume`: пауза на 5 с (мок `time.monotonic`) → после `resume` `now()` больше значения до паузы на 0 (± 1e-9), а не на 5.
- [x] Реализация по 7.2: флаг проверяют `_dialogue_turn`, `_maybe_consult`, `_count_line`, консультация из `human_say`, TTS в `_start_line` и картинки; `set_cap` не трогать. `comic.html` содержит `fetch('/continue'` с `Content-Type: application/json`.
- [x] Все тесты зелёные.

## 2.3 дебаг в HTML

Строка 2.3 таблицы 7.2. Шаг офлайн. Решение хозяина: панель считает Python, страница только рисует (в dream нет браузерных тестов).

Имена:
- `diagnostics.panel_state(events: list[dict]) -> dict` с ключами `schedule`, `fired`, `pressure`, `goals`, `pov`, `lock`, `notes`, `safety`;
- `GET /api/panel?run=…`.

Записки директора — тип лога `message {to, note}` (fsm.py:276).

- [x] Тест `test_panel_covers_dictionary`: синтетический лог с одной строкой каждого типа (`schedule`, `door`, `judge`, `pressure`, `silence`, `event`, `goal`, `lock_reject`, `loop_cut`, `turn_skip`, `line_discarded`, `pov`, `safety_pause`, `input_dropped`, `message`, `consult` с `label: ready_stale`). Каждая строка видна в `panel_state`; тест держит таблицу «тип → ключ панели».
- [x] Тест `test_panel_pressure_last_tick`: два `pressure` подряд → в панели только последний, по актёрам.
- [x] Тест `test_panel_ignores_unknown`: строка неизвестного типа не роняет `panel_state` и в панель не попадает.
- [x] Тест `test_server_panel`: `Viewer` (server.py:97) с корнем tmp и `tmp/A/run_1/log.jsonl`; `GET /api/panel?run=A/run_1` → 200 и JSON `panel_state` этого лога; путь вне базы → 404 (как `/events`).
- [x] `comic.html` содержит `'/api/panel'` и опрос раз в 1000 мс. Ошибки консоли проверяет хозяин руками.
- [x] Все тесты зелёные.

## 3.1a до 5 актёров: ядро

Строка 3.1a таблицы 7.2 (Фаза 3 «Сцена шире»). Шаг офлайн.

Имена:
- `fsm.check_scene(ns, voices) -> (field, reason) | None`: размер (1–5 актёров) и голоса. `check_target` зовёт её после проверки `bridge`.
- `DIRECTOR_SCHEMA` (director.py:37, сейчас «1 or 2») говорит «1 to 5 actors».
- `COMPACT_EVERY = 4` остаётся: на нём стоят тесты test_dialogue.py. Новая `dialogue.compact_every(n_actors) -> int` возвращает `COMPACT_EVERY if n < 3 else 8` (7.2). Пробел «окно 4 строки, свёртка 8» (dialogue.py:20) — строкой в DEVLOG.
- `Dialogue.scene_mind: Mind`. При ≥ 3 актёрах:
  - один вызов compress на свёртку сворачивает `scene_mind` целиком (so_far/knows/promised/tried);
  - `mind(a)` актёра читает so_far/knows/promised из `scene_mind`, а `tried` — только пункты из своих строк (`who == a`), без отдельного compress на актёра;
  - у героя своя `Mind`.
- Лог `prompt {t, who, tokens}` пишет `Dialogue._call(role, system, user, who=None)` через `event_sink` для ролей hero и actor (`hero_line`/`actor_line` передают имя). `tokens = llm._tokens(llm._prompt_text(system, messages))`, второй формулы нет.
- `use_scene(x)`: `x` — имя в `scenes/`, путь (относительно `dirname(sim.__file__)`) или dict сцены. Фикстуры лежат в `h0/dream/testdata/`, не в `scenes/`: `scenes/` берёт `bank.main`.

- [ ] Тест `test_check_scene_actor_count`: при валидных `bridge` и `objects` 1 и 5 актёров → `None`; 0 и 6 → `("next_scene", "bad_size")`.
- [ ] Тест `test_compact_every_by_cast`: `compact_every(2) == 4`, `compact_every(3) == 8`, `compact_every(5) == 8`; `COMPACT_EVERY == 4`.
- [ ] Тест `test_shared_mind_plus_tried`: roof3, `Dialogue` + `FakeTransport` → на одну свёртку ровно 1 вызов роли compress; у Dan и Maya `memory_text` одинаковый, `tried_text` разный; `mind("Max")` — не `scene_mind`.
- [ ] Тест `test_prompt_log_five_actors`: `use_scene("testdata/five.json")` (5 актёров), `Sim(fake=True, outdir=tmp, dialogue=Dialogue(load_profile("A"), transport=FakeTransport(reply=…)))` (без `dialogue` строки — заглушки и `prompt` не пишется), `manual_clock(self, sim)`, затем 40 × `pump`. Ожидается:
  - `prompt` есть у каждого говорившего;
  - `max(tokens) ≤ 5800`;
  - `bank.score([json.loads(l) for l in open(tmp / "log.jsonl")])["max_prompt_tokens"]` равен тому же максимуму.
- [ ] Все тесты зелёные.

## 3.1b шёпот и записки

Строка 3.1b таблицы 7.2. Шаг офлайн.

Решение хозяина по синтаксису: шёпот — тег `[[whisper Имя]]` в ответе актёра. `<whisper>` занят тегом голоса drama-3 (dialogue.py:51).

Как это работает:
- `sanitize(raw, "actor")` режет все `[[…]]`, кроме `ACTOR_TAGS`. Поэтому `actor_line` читает `_WHISPER = re.compile(r"\[\[\s*whisper\s+([^\[\]]+?)\s*\]\]", re.I)` из `raw` **до** `sanitize` и кладёт `whisper_to` в словарь строки.
- Вся строка — шёпот адресату. Озвучивается строка, обёрнутая в `<whisper>…</whisper>`.
- Адресат-актёр получает текст через `self._pending[to]`, адресат-герой — через `_hero_world`.
- В `sim.transcript`, `Dialogue.log` и во вход сжатия `scene_mind` идёт только `[Dan whispers to Maya]`.

- [x] Тест `test_whisper_only_addressee`: roof3, ответ Dan `[[whisper Maya]] it's me` → следующий промпт Maya (`FakeTransport.sent`) содержит `it's me`, промпты neighbor и Max — нет; в `sim.transcript` — `[Dan whispers to Maya]` без текста.
- [x] Тест `test_whisper_to_hero`: ответ Dan `[[whisper Max]] look up` → `look up` есть в следующем промпте Max (`FakeTransport.sent`, system героя); в промптах Maya и neighbor — нет. `_hero_world` напрямую не проверять: его обнуляет начало хода героя.
- [x] Тест `test_whisper_unknown_addressee`: адресата нет в сцене → строка идёт как обычная, тег снят.
- [x] Тест `test_voice_whisper_untouched`: `<whisper>тихо</whisper>` без `[[whisper …]]` остаётся тегом голоса, как в Фазе 1.
- [x] Тест `test_whisper_not_in_shared_mind`: при 3 актёрах текст шёпота не попадает во вход compress `scene_mind` (`FakeTransport.sent` для роли compress).
- [x] Записки директора: `messages[].to` — строка или список имён актёров. `check_messages` принимает строку или список и проверяет каждое имя (сейчас список всегда даёт `unknown_recipient`); `_deliver_messages` разворачивает список, и у каждой строки лога `message` поле `to` — строка (`Sim._emit` кладёт `_notes` по ключу `to`, список там — TypeError). Обновить `DIRECTOR_SCHEMA`/`LOCKED_SCHEMA` и `notes_given`.
- [x] Тест `test_note_to_two_actors`: roof3, `to: ["Dan", "Maya"]` → в `sim._notes` записка ровно один раз у Dan и у Maya, у neighbor её нет. `to: ["Dan", "Max"]` (герой) и `to: ["Dan", "Nobody"]` → `("messages", "unknown_recipient")`.
- [x] Тест `test_whisper_not_in_lock_words`: тег `[[whisper …]]` не считается в лимит слов и ремарок замка 1.1.
- [x] Все тесты зелёные.

## 3.2 рассказчик

Строка 3.2 таблицы 7.2. Шаг офлайн. Живой Spark Open — только в бенче 3.4, вне плана.

Имена:
- `ROLE_TABLE['narrator'] = (SPARK_OPEN_MODEL, "minimal")`. Без этой строки `resolve` уходит в платный `SPARK_MODEL`.
- `Dialogue.narrate(cause, context) -> str`.
- Лог `narrator {t, text, cause: transition | event}`.

Событие, «которое никто не видит», — это `who: []` в расписании 1.3.

Вызов рассказчика занимает слот `_gen_thread`, как строка, поэтому он идёт раньше первой строки новой сцены. Результат несёт `role="narrator"`. `_dialogue_turn` пишет `narrator` и не зовёт `npc_start`, `_note_line` и `_count_line`.

- [ ] Тест `test_narrator_role_open`: `llm.resolve("narrator")` даёт `SPARK_OPEN_MODEL`.
- [ ] Тест `test_narrator_on_transition`: после `transition` ровно одна `narrator {cause: transition}`, и она раньше первой `line` новой сцены.
- [ ] Тест `test_narrator_on_unseen_event`: событие `who: []` → одна `narrator {cause: event}`; событие с `who` → рассказчик молчит.
- [ ] Тест `test_narrator_rate`: два события в один такт → не больше одной реплики на событие. Реплика рассказчика не считается строкой ни в давлении, ни в `lines` и не даёт `line`.
- [ ] Реализация: реплика видна в `comic.html` отдельным стилем; `FakeTransport.reply` различает роль по `system`.
- [ ] Все тесты зелёные.

## 3.3 сон из строки

Строка 3.3 таблицы 7.2. Шаг офлайн.

Имена:
- `Director(transport=None)` передаётся как `_transport` в `llm_call`.
- Чистая `director.seed_scene(text, transport) -> dict | None` делает до двух попыток; сцена проверяется `fsm.check_scene` из 3.1a.
- `sim.SEED_TRANSPORT = None` — переменная модуля, её патчит тест.
  - `--seed` с `--fake` при `SEED_TRANSPORT is None` → exit 2 `seed: --fake needs a transport`.
  - Живой seed идёт только после `set_cap`.
- CLI:
  - `main(argv=None)` → `ap.parse_args(argv)`;
  - флаг `--seed "текст"`;
  - `--profile` по умолчанию `None` (без `--seed` → `"A"`, как раньше);
  - с `--seed` метка прогона в `run()` — `seed` вместо профиля.
- Первая сцена:
  - `use_scene(dict)` из `next_scene`, `place` = `destination` ответа, `events` = [];
  - лог `consult {label: seed}`;
  - профиль души не читается.

- [ ] Тест `test_seed_starts_scene`. Патчи: `sim.SEED_TRANSPORT` (FakeTransport отдаёт валидную `next_scene`) и `sim.run` (запоминает `START_SCENE` и kwargs, пишет пустой `tmp/log.jsonl`, возвращает `(tmp, tmp/log.jsonl)`); `addCleanup(use_scene, "start")`. `main` передаёт первую строку лога через `run(..., first_events=[{"type": "consult", "label": "seed", ...}])`, `Sim` пишет её сразу после `snapshot`. Вызов `main` обёрнут в `assertRaises(SystemExit)` (`main` всегда кончается `sys.exit`).
  - Вызов: `main(["--seed", "two strangers stuck in a lift", "--fake"])`.
  - Первая сцена взята из ответа, в kwargs `run` есть `first_events` с `label: seed`.
- [ ] Тест `test_seed_no_profile_file`: `Sim(fake=True, profile=None, outdir=tmp)` под моком `open` → ни одного пути под `profiles/`. `load_profile(None)` берёт только героя сцены и файл не открывает (сейчас `Sim.__init__` зовёт `load_profile(profile)` всегда).
- [ ] Тест `test_seed_bad_director`: transport дважды отдаёт сцену, не прошедшую `check_scene` → `SystemExit.code == 2`, в stderr `seed: director failed`.
- [ ] Тест `test_seed_fake_no_transport`: `--seed x --fake` без патча → `SystemExit.code == 2`, в stderr `seed: --fake needs a transport`, ни одного вызова `llm_call`.
- [ ] Тест `test_seed_and_profile_conflict`: `--seed` с явным `--profile A` → `SystemExit.code == 2` и понятное сообщение.
- [ ] Все тесты зелёные.

## Ф2–Ф3 итог

Код не меняется.

- [ ] Полный набор `cd h0/dream && python3 -m unittest -q` зелёный трижды подряд (ловим тайминговые флаки).
- [ ] Итог в DEVLOG и PROGRESS.md:
  - таблица шагов 2.1–3.3;
  - решения хозяина: список фраз 2.2, тег шёпота 3.1b, формат `messages[].to`, `compact_every` и пробел окна;
  - что ждёт денег (3.1c, 3.4) и что ждёт спеки (Фаза 4);
  - отдельной строкой: «ручная проверка панели и кнопок в браузере — за хозяином».
