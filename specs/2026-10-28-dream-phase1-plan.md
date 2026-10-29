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

- [ ] Тест `test_bad_goals_keep_bridge`: директор на `FakeTransport` отдаёт кривые `goals`. Мост и `next_scene` остаются, `fail_streak == 0`, в логе `invalid {fields: ["goals"], reason}`.
- [ ] Тест `test_good_extras_reach_next_scene`: корректные `events`/`goals`/`hero_reason` доходят до следующей сцены: строка `schedule` с ними, `hero_reason` приходит событием `t=0, who=[hero]`.
- [ ] Тесты `clean_extras`: `t > 600`, 2 или 6 событий, `who` вне актёров, `goals[].actor` вне актёров — каждый случай даёт дескриптор `invalid`.
- [ ] Реализация: `DIRECTOR_SCHEMA` += поля, `max_tokens` 2200, `BuildFSM(hero=None)`, вызов в `finish_consult` перед `check_target`, перенос в `_apply_transition`.
- [ ] Все тесты зелёные.

## 1.5 спайк: русский

Строка 1.5 таблицы 7.2. Гейта нет, шаг фазу не блокирует.

- [ ] Тест `test_lang_en_score_unchanged`: `bank.score` на логах r1 при `en` побайтно прежний (`skipTest` без логов).
- [ ] Флаг `--lang ru` по 7.2. Затем прогон `python3 h0/dream/bench_f1.py --step 1.5 --runs 1 --lang ru`. В DEVLOG: есть ли `invalid`, что сломалось на кириллице, принимает ли drama-3 русские ремарки. Если обёртка отказала по бюджету (код 2), так и записать.
- [ ] Все тесты зелёные.

## Ф1 итог фазы

Строка Ф1 таблицы 7.2. Код не меняется.

- [ ] Бенч `python3 h0/dream/bench_f1.py --step Ф1 --runs 2`. Гейт Ф1 считается по правилу медианы, бенч-гейты 1.2b–1.4 — на этих же прогонах.
- [ ] Итог фазы в DEVLOG и PROGRESS.md: таблица всех шагов (метрики, $, PASS/FAIL), сумма ledger, пункты Долга §13 (закрыт или открыт). Отдельной строкой: «чтение человеком ≥ 3 (7б) — за хозяином».
