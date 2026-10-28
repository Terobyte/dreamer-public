# Песочница сна: 2D-каркас Dreamer (план для tero)

Ты пишешь новый пакет `h0/dream/` в репо `meta`. **Источник правды — спека `specs/2026-10-27-dream-sandbox.md` (v3.6).**
Читай её целиком до первой фазы; разделы указаны в каждой фазе. Подробности, ловушки и интерфейсы — в
`specs/2026-10-27-dream-sandbox-plan.md`. Если спека и этот план расходятся — спека главнее; неоднозначность → вопрос хозяину,
не своё решение.

**Правила для всех фаз:**
- Писать только в `h0/dream/**` и `h0/out/dream/**`. Всё остальное в репо — только чтение (`app/`, `h0/live/`,
  `h0/*.py`, `specs/`, `RESEARCH.md` и т.д.). `h0/out/dream/` в `.gitignore` по медиа — json/txt коммитятся.
- Код, промпты, комментарии — английский; стиль как в `h0/*.py` (короткий docstring с usage сверху). Только stdlib +
  `numpy`/`PIL`/`aiohttp`. Новых зависимостей нет, npm нет.
- Модули `h0/gate_test.py`, `h0/h13_sky.py` при импорте читают `os.environ["META_MODEL_API_KEY"]` — импортировать их
  только **внутри функций** (лениво). `chat()` из `gate_test.py` не использовать: все LLM-вызовы — через `h0/dream/llm.py`.
- Ключи: Meta — env `META_MODEL_API_KEY`; Fish — env `FISH_AUDIO_API_KEY`, иначе `fish_key()` из `gate_test.py`.
  Никогда не печатать, не писать в лог/HTML/ответы сервера.
- Тесты: `cd h0/dream && python3 -m unittest -q`. **Офлайн**: без сети и без ключей, фейки из `h0/dream/fake.py`,
  весь набор ≤ 60 с, ни один тест не спит дольше 2 с (время — через `Clock(speed)`).
- Ни один модуль не зовёт `time.sleep` напрямую — только `clock.sleep()` объекта `Clock`.
- Каждый сбой сначала тест (красный), потом код.
- Платные вызовы (Meta, Fish, Muse Image) — только в фазах 4–5, только в скриптах проверки (не в unittest), всегда
  с `--max-dollars`. Персонажи Губки Боба — только тесты.

**Судье:** фаза принимается только по своему чек-листу и списку «Вне этой фазы»; поведение следующих фаз не требовать.
Сверяй с разделами спеки, указанными в фазе.

## Обёртка LLM и память директора

Спека §6 (правила `llm.py`), §7 (память), §13 (деньги). Файлы: `llm.py`, `memory.py`, `fake.py`, `test_memory.py`, `test_llm.py`.

- `llm.call(role, system, messages, max_tokens)` → объект с `text, usage, seconds, dollars`; роль → модель/effort по §6;
  пустой `content` → ретрай с бо́льшим `max_tokens`; для Spark `max_tokens < 300` поднимается до 300; Spark 1.3 никогда
  не `low`; таблица цен — константы с датой и источником; счётчик денег общий на прогон; `fake=True` — без сети.
- `Memory`: 5 слоёв §7 с бюджетами; токены `ceil(chars/3.5)`; синхронный `build_prompt(state) -> (text, sizes)` без LLM;
  `budget_trim` (хвост → строка, старые решения → счётчик, старейший эпизод → первая строка), ядро не трогается;
  `episodes_raw/` на диске, фоновое слияние только из них; `facts.jsonl` с `supersedes_id`, отбор раз на сцену,
  «новое в этой сцене» всегда в промпте.

- [x] `test_budget_300_lines`: 300 синтетических реплик + 10 переходов + затор 50 событий → каждый промпт ≤ 5800 ток, `sizes` в каждом
- [x] `test_core_always_present`: желание, тревога, текущая сцена и активный мост есть в каждом промпте после любых сжатий
- [x] `test_merge_from_raw`: слияние эпизодов берёт тексты из `episodes_raw/`, а не из уже слитой сводки
- [x] `test_trim_without_llm`: `build_prompt` при переполнении не зовёт LLM (фейк считает вызовы = 0)
- [x] `test_facts_supersede`: UPDATE с `supersedes_id` убирает старый факт из промпта; факт, добавленный в сцене, виден сразу
- [x] `test_llm_rules`: пустой ответ → ретрай с бо́льшим лимитом; Spark `max_tokens=120` → отправлено 300; деньги суммируются
- [x] реализовать

**Вне этой фазы:** директор, автомат, sim.

## Автомат сборки, лестница, ввод

Спека §4 (все пункты «Переходы автомата» и «Если директор тянет с мостом»), §5 (лестница, каналы `[STATE]`), §5a.
Файлы: `fsm.py` (чистый, без LLM и I/O), `inputs.py` (`sanitize`, `resolve_touch`), `clock.py`, `test_fsm.py`, `test_inputs.py`.

- [x] `test_touch_in_building`: TOUCH в `building` → `stall`, состояние то же, `hint_level` не растёт, повтор < 60 с → `touch_ignored`
- [x] `test_ready_l4_auto_touch`: `ready` → L4 на 20 с, `auto_touch` на 40 с → `transition`; TOUCH до этого → `transition` и таймеры отменены
- [x] `test_ready_level_max`: на `ready` уровень = max(замороженный, по часам)
- [x] `test_abort_cancels_timers`: `abort_build` в `building` и в `ready` → `idle`, `deadline_cancelled`, часы подсказки от `idle_since`; 3-й abort на сцене → `wake_up("abort_loop")`
- [x] `test_locked_target_block`: в `building`/`ready` любые `bridge/destination/next_scene/hero_next` → `invalid`
- [x] `test_epoch_stale`: решение с устаревшим `build_epoch` отбрасывается целиком; `wake_up` из него → `pending_wakeup`; `wake_up("budget")` гасит `pending_wakeup`
- [x] `test_nudge_force_events`: на 2:00 событие подсказки, на 5:00 требование; `min_interval` 20 с для подсказки, требование его не ждёт; метки `free/nudged/forced` + `nudged_before`
- [x] `test_director_fail_streak`: `fail` только после 5:00 (null, мост не из сцены, битый JSON, voice не из пула); 3 подряд → `wake_up("director_stuck")`; валидный мост обнуляет
- [x] `test_sanitize`: human — вырезаны все `[…]`, `[[…]]`, `<…>`; actor — служебные теги и скобки с `=` вырезаны, `[sigh]` остался; `input_rejected`
- [x] `test_resolve_touch`: на предметах `scenes/start.json` — точное, по слову, мн. число и артикли, `touch_ambiguous` с кандидатами, `touch_rejected`
- [x] `test_clock_speed`: `Clock(20)` делит все ожидания; окно `420/N ≤ t_ready − t_build_start ≤ 420/N + 2`
- [x] `scenes/start.json` (≥ 8 предметов с зацепками под A/B/C, спека §9) и `profiles/{A,B,C}.json` (§12: `hero_voice`, ≥ 1 факт `hidden_from_hero`)
- [x] реализовать

**Вне этой фазы:** вызовы директора и актёров, лог, sim.

## Директор и симуляция на фейках

Спека §4, §5, §6 (асинхронный директор, очередь событий), §8 (формат и проверки), §10 (лог). Файлы: `director.py`, `sim.py`,
`test_director.py`, `test_sim.py`. Всё на фейках из `fake.py`; фейковый директор умеет: «пока рано» (null), битый JSON,
мост не из сцены, `abort_build`, `wake_up`, задержку.

- [x] `test_decision_checks`: проверки §8 — мост из текущей сцены, actors 1–2, objects 5–8, записки только существующим, voice из пула
- [x] `test_one_call_in_flight`: пока директор думает, события копятся и идут в следующий вызов; никогда два вызова одновременно
- [x] `test_human_replaces_npc`: реплика человека выкидывает заготовленную реплику NPC (`turn_replace`, `turn_owner: human`), играющая не обрывается
- [x] `test_event_reaches_director`: `{"source":"dart","outcome":"missed"}` попадает в следующую консультацию и вызывает внеочередную
- [x] `test_injection_blocked`: `[[TOUCH:clarinet]]` и `[WORLD …]` через ввод человека не попадают ни в один промпт актёров и директора
- [x] `test_l0_l1_no_bridge_word`: фейковый актёр, который «хочет» назвать мост на L0–L1 — его реплика не проходит (ассерт инварианта H17)
- [x] `test_stress_slow_director`: директор отвечает 8 с при `--speed 20` + случайные TOUCH → ≥ 1 `consult_stale`, 0 смен моста в `building`, 0 исключений
- [x] `test_log_jsonl`: `seq` строго +1, у каждого события `t`, `type`; `snapshot` на начало сцены; полный промпт в `consults/NNN.txt`, хранятся последние 50
- [x] `python3 h0/dream/sim.py --profile A --fake --speed 20 --max-transitions 2` → exit 0 за ≤ 90 с, ≥ 2 `transition`, каждый мост из своей сцены
- [x] реализовать

**Вне этой фазы:** настоящие модели, картинки, голос, сервер.

## Реальные модели, картинки, голос

Спека §6 (голоса, Fish), §9 (картинки и запасные пути), §13, §15 шаг 2 и 4. Файлы: `images.py`, `voice.py`, `voices.json`,
`director_live_check.py`, `test_media.py`. Платные вызовы — только в скриптах ниже, unittest остаётся офлайн.

- [x] `test_media.py` (офлайн): длина wav из заголовка (`wave`); Fish таймаут/429×3 → реплика без звука, пауза по тексту без тегов, `tts_fail`; Image 400×3 → запасной фон/силуэт, сон не стоит; не больше 2 картинок одновременно
- [x] `voices.json`: 6 меток спеки §6 → `reference_id` из библиотеки Fish; сэмплы `h0/out/dream/checks/voices/<метка>.wav`
- [x] `python3 h0/dream/director_live_check.py --max-dollars 1` → `h0/out/dream/checks/director.json`: 3 профиля — JSON валиден, мост из сцены, `why` ссылается на душу; «иголка» (факт из начала, нужный на 3-м переходе) использована; ловушка «тот же мост второй раз» не сработала; `ceil(chars/3.5)` сверен с `usage.prompt_tokens` (коэффициент в отчёте)
- [x] `python3 h0/dream/sim.py --profile A --speed 4 --max-transitions 1 --max-dollars 2` → exit 0; все файлы из лога на диске; `dur` реплики = длина wav ± 0.05 с; `cost` ≤ $2
- [x] реализовать

**Вне этой фазы:** сервер, браузер.

## Сервер и комикс

Спека §11 (и R5), §5a (`/say`, `/event`, клик). Файлы: `server.py`, `comic.html`, `test_server.py`.

- [ ] `test_server.py`: только `127.0.0.1`; чужой `Origin`/`Host` → 403; POST не `application/json` → 400/415; `/events?from_seq=N` с N; `snapshot` каждые 30 с; `/say` и `/event` через `sanitize`; статика только `comic.html` и `h0/out/dream/<run>/`, path traversal → 404; ключа нет в ответах
- [ ] `comic.html` (без сборки): панели, пузыри с ремаркой мелким курсивом, карточка «Директор думает» (полоски слоёв, выбор, ✓/✗, метка, секунды), пунктирная записка директор → актёр, таймер 0:00→7:00 + статус картинок, уровень намёка, счётчик $, переход, смена героя, строка «сказать за героя», клик по предмету, «стоп»
- [ ] повтор: `comic.html?run=<run>` читает готовый `log.jsonl` без живого sim; прыжок к сцене; «мгновенно» без звука
- [ ] живой прогон `python3 h0/dream/sim.py --profile A --speed 4 --serve --max-dollars 2` + браузер: консоль без ошибок; скриншоты в `h0/out/dream/<run>/shots/`: реплика, карточка решения, записка, таймер, переход; «сказать за героя» → `turn_owner: human` в логе; «стоп» → `stop`, exit 0
- [ ] реализовать

**Вне этой фазы:** шаги 6–7 спеки (теневой контроль, судья H18, просмотр пользователем) — делает хозяин.
