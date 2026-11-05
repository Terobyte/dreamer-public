# Баги и долги: песочница сна (`h0/dream`)

Найдены 2026-10-28 при ручном закрытии фазы 3 (коммит `1f5eccd`) и независимой проверке трёх Luna. Ниже текущий статус, затем исходная оценка и описания находок для истории.

## Исправления 2026-10-28

После разрешения на фиксы переработаны общие механизмы, на которых проявлялись B1–B9; дополнительно проверена остановка прогона:

- **Вызовы LLM:** `RealTransport` отвечает за маршрутизацию провайдеров; память использует тот же `llm.call`, что и остальные роли. Внедрённый transport работает через этот же путь; режим без transport теперь действительно вызывает модель. Результат содержит диагностику fallback и модель/usage/стоимость каждой успешной попытки. Общий счётчик денег защищён от параллельных обновлений.
- **Диагностика:** общий `diagnostics.report` пишет WARNING и структурированное событие в переданный sink. В симуляции ошибки памяти и fallback доходят до JSONL; журнал сериализует запись и выдачу `seq`. Исключения директора также получают событие. Передача завершённых событий из потока директора в цикл защищена отдельной блокировкой.
- **Память:** `Sim` владеет памятью и передаёт её директору. В ней остаются принятые человеческие реплики, начавшиеся NPC-реплики, события, принятые решения и факты; переход обновляет сцену и сбрасывает старый мост. Отклонённые и устаревшие решения не меняют факты. Слияние и отбор запускаются в фоне.
- **Фоновые задачи:** состояние защищено RLock, вызов провайдера идёт вне этой блокировки. Слияния сериализованы, повторный запуск возвращает текущий worker. Добавленные во время запроса архивы сохраняются; изменение исходника отменяет устаревшую сводку. Отбор фактов проверяет сцену и ревизию фактов перед публикацией, при сбое сохраняет доступный набор и допускает повтор.
- **Хронология:** порядок исходников хранится отдельно в `episode_order.json` и переживает перезапуск независимо от имени и mtime файлов. Для старых каталогов без индекса порядок восстанавливается по файловым timestamp с числовым суффиксом при равенстве; точную утраченную историю старых файлов восстановить невозможно. Избыточные `hasattr/getattr` состояния убраны.
- **Реплики:** постановка в очередь отделена от единой точки начала воспроизведения. Только старт пишет `line` с фактическим временем и увеличивает счётчик сыгранных реплик. Приоритет человека соблюдается и в основном цикле; отброшенные NPC-заготовки не попадают в рабочие реплики памяти. Слот использует текст без тегов (`слова / 2.5 + 1`) или переданную измеренную длительность аудио + 0.4 с; таймер масштабируется через общие часы. `Sim.close()` и контекстный менеджер ждут принадлежащие симуляции фоновые задачи перед удалением временной памяти; обёртки запуска закрывают симуляцию явно.

| Пункт | Статус |
|---|---|
| B1, B2, B3, B4, B6, B8, B9, B10 | Исправлены, регрессионные проверки зелёные |
| B7 | Поведенческий баг не подтвердился; избыточные проверки состояния убраны |
| B5 | Текстовый путь и приём измеренной длительности исправлены; подключение настоящего Fish/WAV остаётся в фазе 4 |

Реальные платные API при проверках не вызывались. Перекладка всех исторических `test_contract_*` в тематические файлы остаётся организационным долгом; новые проверки находятся в `test_llm.py`, `test_memory.py`, `test_sim.py`.

## Исходная оценка кода фаз 1–3 до исправлений: 6/10

Логика в основном верная, тестов много. Но код рос из точечных заплаток по раундам судьи, а не из замысла. Фаза 3 прошла 10 раундов: игрок каждый раз чинил ровно то, что назвал судья, и ничего не перестраивал.

### Что красиво
- `fsm.py` — чистый автомат: без сети и без часов, время приходит параметром. Гонки ловятся тестами, стресс-тест с медленным директором реально проверяет `consult_stale`.
- Часы одни на всё, `--speed` сжимает только таймеры.
- Код близок к спеке, ссылки на её разделы стоят прямо в коде.
- 114 офлайн-тестов, ключи нигде не светятся.

### Что не красиво
1. **Фазы не соединены.** Память из фазы 2 не подключена к симуляции из фазы 3 (B2), а в реальном режиме она к тому же молча выключена (B1). Главную гипотезу H19 не проверяет ни один прогон.
2. **Ошибки глотаются** (B3, B6): `except Exception: pass`. Сон идёт, но проверяет уже не то.
3. **Следы заплаток:** проверка решения была написана дважды, и копии разошлись (сведено в `1f5eccd`); поля `Memory` появляются через `hasattr` (B7); два пути импорта.
4. **Тесты разложены по истории, а не по смыслу:** `test_contract_r10`, `r11`, `r12`, `test_debt_f4_f15`, `test_wakeup_debt`. Нужный тест в них не найти.

### Что сделать до фазы 4 (≈ полчаса)
1. Подключить `Memory` к `Sim`.
2. Сделать настоящий transport вместо фейка.
3. Убрать тихие `except`: любая ошибка оставляет событие в логе.
4. Разложить тесты по модулям: `fsm`, `director`, `sim`, `memory`, `llm`.

Без этого фаза 4 на настоящих моделях потратит деньги на прогоны, где память директора не работает.

**На будущее для циклов игрок/судья:** раз в 3–4 раунда давать игроку задачу «перестрой, сохранив поведение», а не только «почини замечание судьи».

## Исходные находки (состояние до исправлений)

### B1. Память директора в реальном режиме молча отключена
- **Где:** `memory.py:226-263` (`merge_from_raw`) и `memory.py:367-390` (`_select_facts`).
- **Что:** LLM вызывается только при переданном transport, и всегда с `fake=True`. Настоящего transport-класса в `llm.py` нет. Поэтому без фейка сжатие эпизодов и выбор фактов просто не запускаются. Если же вызов падает, ошибку глотает `except Exception`.
- **Чем грозит:** H19 (долгий сон без забывания) в реальном прогоне не проверяется, и при этом нигде не видно ошибки.
- **Чинить:** в фазе 4. Нужен реальный transport поверх `_real_complete`, сбой писать в лог.

### B2. Симуляция гоняет директора без памяти
- **Где:** `sim.py`, `Sim.__init__`: `Director(...)` создаётся без `memory=`.
- **Что:** `Memory` из фазы 2 не подключена к циклу из фазы 3. Обе работают только в своих тестах.
- **Чинить:** в фазе 4, до `director_live_check.py`. «Иголка» на 3-м переходе без памяти невозможна.

### B3. Сбой Baseten не попадает в лог
- **Где:** `llm.py:185`.
- **Что:** `except Exception: pass`. Переход на Spark 1.3 происходит, но причина не видна, а в учёте денег не видно, почему вызов стал платным.
- **Чинить:** записать причину в результат вызова.

### B4. Реплика человека пишется в лог как `line`, хотя ещё стоит в очереди
- **Где:** `sim.py`, `human_say`.
- **Что:** если ничего не заготовлено, в лог сразу идёт `{"type": "line", "turn_owner": "human"}` со временем постановки в очередь, а не начала звучания. Для `t` в логе это неточно.
- **Чинить:** при постановке писать `line_queued`, а `line` — в `_cycle_line`, когда реплика стартует.

### B5. Длина реплики захардкожена: 1 с
- **Где:** `sim.py`, `_cycle_line`.
- **Что:** слот реплики `1.0` с вместо длины аудио Fish + 0.4 с (спека §5). На фейках это допустимо.
- **Чинить:** в фазе 4 вместе с `voice.py`.

### B6. Тихие `except Exception`
- **Где:** `memory.py:264`, `memory.py:390`, `llm.py:185`, `sim.py:281` (стресс-тест считает их, это нормально).
- **Что:** ошибки превращаются в «пустой результат». Для эксперимента это хуже падения: сон идёт, но проверяет уже не то.
- **Правило:** любой перехват ошибки оставляет событие в логе.

### B7. Состояние Memory создаётся «по ходу»
- **Где:** `memory.py:176`, `memory.py:241`: `hasattr(self, "_merge_groups")`, `getattr(...)`.
- **Уточнение проверки 2026-10-28:** `_merge_groups` и `_merge_summaries` уже объявлены в `__init__`. Проверка создания полей и первого полного прохода зелёная: состояние не появляется по ходу работы. Исходное описание поведенческого бага не подтвердилось.
- **Остался долг:** убрать избыточные защитные `hasattr/getattr`; это чистка кода, отдельный падающий поведенческий тест для неё не нужен.

### B8. Слияние эпизодов меняет хронологию (P2)
- **Где:** `memory.py`, `_read_raws`, строка 206; потребитель — `merge_from_raw`.
- **Что:** файлы сортируются по имени, где тип архива стоит перед общим порядковым номером. Поэтому `events_archive_002` и `events_archive_003` оказываются раньше старого `working_archive_001`.
- **Воспроизведение:** заархивировать старые реплики через `_archive_working`, затем переполнить очередь событий дважды и запустить слияние. Оно берёт два новых архива событий вместо двух старейших эпизодов; порядок входа в Spark тоже неверный.
- **Чем грозит:** память пересказывает более новые события раньше старых и выбирает неверную пару для сжатия (§7).
- **Чинить:** хранить и использовать хронологический порядок архивов независимо от их типа.

### B9. В тишине NPC опережает поставленную в очередь реплику человека (P2)
- **Где:** `sim.py`, `_maybe_generate_line` и порядок вызовов в `Sim.run`.
- **Что:** после `human_say` в тишине `next_line` содержит реплику человека, но `active_line` ещё пуст. Штатный цикл сначала генерирует новую реплику NPC, затем обрабатывает очередь. NPC начинает первым, человек остаётся ждать его слот.
- **Воспроизведение:** `Sim(speed=20)` → `human_say("hello")` → один штатный шаг `run`. Активная реплика принадлежит NPC, человеческая всё ещё в `next_line`.
- **Чинить:** учитывать очередь человека при генерации NPC. Это пропущенный интеграционный случай J2: ручной вызов `_cycle_line` был исправлен, полный цикл — нет.

### B10. После достижения лимита переходов запускалась следующая консультация — исправлено
- **Найдено:** при проверке трёх переходов после подключения памяти: переходов 3, а в памяти уже 4 принятых решения на сборку.
- **Причина:** лимит проверялся только в начале итерации; после `_tick()` цикл ещё запускал генерацию и консультацию.
- **Исправление:** граница остановки проверяется сразу после `_tick()`, до начала новой работы; уже запущенные задачи завершаются и журнал дочитывается.
- **Регрессия:** `SimLifecycleTest.test_transition_limit_stops_before_starting_another_consult` сначала падал, затем стал зелёным.

## Регрессионные проверки находок

Финальная проверка 2026-10-28: `cd h0/dream && python3 -m unittest -q` — **143 теста, 28.402 с, OK**, без предупреждений об очистке временных каталогов. Отдельный офлайн-прогон на фейках (`speed=200`) — **3 перехода, ровно 3 решения на сборку, 126 консультаций, 95 исходных архивов, 0 событий `*_fail`**. `git diff --check` — чисто.

Добавлены в существующие тематические модули `test_llm.py`, `test_memory.py`, `test_sim.py`. Без `skip` и `expectedFailure`; все проверки теперь должны проходить. Платные API подменены; часы симуляции двигаются вручную, пауз нет.

| Баг | Тесты (класс → метод) |
|---|---|
| B1 | `MemoryOpenBugsTest.test_b1_background_merge_uses_real_wrapper_without_injected_transport`, `test_b1_background_fact_selection_uses_real_wrapper_without_transport` |
| B2 | `SimOpenBugsTest.test_b2_sim_attaches_memory_and_sends_human_line_in_working_layer` |
| B3 | `FallbackDiagnosticsTest.test_b3_result_retains_fallback_reason` |
| B4 | `SimOpenBugsTest.test_b4_queued_human_line_is_not_logged_as_playing`, `test_b4_human_playback_logs_actual_start_time_once` |
| B5 | `SimOpenBugsTest.test_b5_long_text_line_does_not_end_after_one_second`, `test_b5_text_duration_scales_with_speed_and_ignores_tags` |
| B6 | `FallbackDiagnosticsTest.test_b6_baseten_failure_is_logged`; `MemoryOpenBugsTest.test_b6_failed_merge_is_logged_and_keeps_raw_episodes`, `test_b6_failed_fact_selection_is_logged` |
| B7 | `MemoryOpenBugsTest.test_b7_all_memory_state_exists_before_first_operation` — зелёный, описание уточнено выше |
| B8 | `MemoryOpenBugsTest.test_b8_merge_uses_two_oldest_archives_in_chronological_order` |
| B9 | `SimOpenBugsTest.test_b9_idle_human_plays_before_generated_npc_in_normal_run` |

Контракты диагностики: причина платного fallback сохраняется в результате `llm.call` (имя поля не задано); перехваченные ошибки провайдеров и фоновой памяти видны через стандартное Python-логирование уровня WARNING или выше. В симуляции эти события доставляются в общий JSONL. Стресс-тест `run_stress` уже считает исключения в отчёте и в эту регрессию не включён.

B5 проверяется по числу слов без тегов и через переданную измеренную длительность аудио, включая подготовленную NPC-реплику и масштабирование через `--speed`. Получение длительности из настоящего WAV относится к фазе 4, где появятся `voice.py` и медиаконвейер.

Быстрый запуск регрессионных проверок:

```sh
cd h0/dream
python3 -m unittest -v test_llm.FallbackDiagnosticsTest test_memory.MemoryOpenBugsTest test_sim.SimOpenBugsTest test_memory.MemoryConcurrencyTest test_sim.SimLifecycleTest test_sim.ConcurrentJournalTest
```

До исправлений: 14 проверок находок — 13 падений и 1 успешная (B7); полный набор — 128 тестов за 65.369 с. После исправлений все 14 проходят. Добавлены проверки перезапуска, конкурентного слияния, устаревших результатов, повторного отбора после сбоя, фактов/решений, длительности аудио и конкурентной записи JSONL. Два интеграционных теста структуры журнала используют `speed=100`, чтобы не ждать реальные интервалы сборки; проверка медленного директора сохраняет исходные `delay=8`, `speed=20`.

## Закрытые в `1f5eccd`

| # | что | где |
|---|---|---|
| J1 | `sim.py --max-transitions 2` давал 1 переход: консультации в запертой сборке тратили мост следующей сцены | `director.py` `_next_decision` |
| J2 | реплика человека не играла следующей; при тишине не стартовала вовсе | `sim.py` `_cycle_line` |
| J3 | записка неизвестному актёру проходила как `ok` | `fsm.py` `check_messages` |
| J4 | `objects: "abcde"` проходил как 5 объектов | `fsm.py` `check_target` |
| — | проверка решения была написана дважды (`director` и `fsm`), копии разошлись → одна общая | `fsm.py` |
| — | сбой памяти при консультации глотался молча → событие `memory_fail` | `director.py` |

## Охота 2026-10-31 — все движки по урокам (6 охотников: engine×2, pipe2, dream, серверы, уроки↔код)

Статус у всех `reported`. Где указано «воспроизведено», охотник прогнал код, но red-тестов в репо ещё нет. Тяжесть: CRIT — деньги, данные, безопасность, вечный зависон; MAJOR — неверное поведение на реальном вводе; MINOR — край.

### Паттерны (одна причина → несколько багов)
- **P1. Открытая комната = высота 0, и это читается как настоящий потолок.** Сюда входят B14, B15 и парковка «балки открытой комнаты». Открытость надо смотреть в одном месте (`open`), а не через `height`.
- **P2. Псевдокомната свободных стен `"walls"` сортируется первой** (`order.get(a) ?? 0`), а `merge.roomOrder` ставит её последней. Сюда входят B11, B12, B13.
- **P3. Локальные серверы без защиты: чужая вкладка тратит кредиты.** Сюда входят B30, B31, B32, B33, B34.
- **P4. dream: вход забирается при старте работы и теряется, если работа отброшена.** Сюда входят B47, B48.
- **P5. pipe2: resume после капа сломан.** Сюда входят B17, B18, B24, B27.

### Engine (TypeScript)
- **B11 — `at`-проём на интервале со свободной стеной молча пропадает** · MAJOR · P2 · `engine/src/openings/resolve.ts:282-293`. Триггер: demo-flat, свободная стена (-2,12)-(2,12) и окно `at:[0,12]`. Проёмов становится 2 вместо 3, ошибок нет. Воспроизведено. **Статус: fixed** — free-стена получает синтетическое ребро в `edgeOf`, `walls` сортируется последней.
- **B12 — после молчаливого дропа индексы `geos` и `scene.openings` расходятся, и дверь теряет swing/hinge** · MAJOR · P2 · `engine/src/openings/stage.ts:112-115`. Воспроизведено: `front` даёт swing=null. **Статус: fixed** — следствие B11: проём больше не дропается, индексы совпадают.
- **B13 — TypeError в `sRange`, если два проёма делят интервал со свободной стеной** · MAJOR · P2 · `engine/src/openings/resolve.ts:423,586`. Воспроизведено. **Статус: fixed** — `walls` последней, у ребра есть `len`.
- **B14 — STAIR_HEADROOM даёт ложную ошибку (-0.845 м) для пролёта из открытой комнаты** · MAJOR · P1 · `engine/src/stairs/place.ts:135`. Связан с уроком #31: красный каркас останавливает прогон. Воспроизведено. **Статус: fixed** — потолок/перекрытие открытой комнаты игнорируются (`ceil` = Infinity), балки проверяются на построенной высоте (0, как в `build/geometry.ts`), а не на авторской: иначе проверка и меш расходятся (F3).
- **B15 — наклейка на стену открытой комнаты всегда DECAL_OFF_WALL `[0,0]`** · MINOR · P1 · `engine/src/decals/place.ts:274,351`. **Статус: fixed** — высота = колпак общей стены (минимум соседних закрытых и верха свободных стен `walls[i]` на этом участке, см. `wallRoom`/`freeWalls`), 0 если построенной стены нет. Прежний репро `t=0.2` указывал на (6,0) вне общего участка yard/hall (x в [-4,4]), поэтому положительный тест перенесён на `t=0.5`, а `t=0.2` теперь покрыт отрицательным тестом; свободная стена `walls[i]` на границе открытой комнаты даёт колпак `h` (F5).
- **B16 — WASD: стрейф зеркальный, D идёт влево** · MAJOR · `engine/src/runtime/walk.ts:131`. Должно быть `[(f*fx - s*fz)*d, (f*fz + s*fx)*d]`. Проверено на реальном three.js. **Статус: fixed** — знак стрейфа исправлен.
- **B19 — `check --built` принимает устаревшие снимки** · MAJOR · `bin/dreamer.ts:151-182`, `build/write.ts:172-204`. `dist/shots` не чистится; список камер берётся из geometry.json старого dist, а не из сцены. Связано с блоком Е (SHOT_MISSING стал ошибкой) и уроком «критик смотрит на картинку».
  - fixed: `check --built` берёт камеры из сцены (ref подтягивается из geometry.json по id), снимки старого dist не засчитываются; строка `SHOT_MISSING: ...` печатается в stdout.
- **B20 — нечитаемый GLB считается как 0 треугольников, и бюджет проходит** · MAJOR · `build/write.ts:82-92` (`catch { n = 0 }`), `assets/tris.ts:28-45`. По POSTMORTEM бюджет — проверка, а не надежда.
  - fixed: `countTris` не пишет 0 для нечитаемого GLB, а кладёт prop в `tris.unreadable`; `budgetIssues` даёт TRI_PROP_BUDGET, а `runCheck` кладёт её в errors (иначе warn оставлял `ok=true`).
- **B21 — лимит point-light стоит на комнату и только warn, хотя three.js шейдит все лампы сцены** · MAJOR · `budget.ts:11-12,75-93`. Сцена с 8 лампами по 2 на комнату проходит без замечаний. Это повторяет лаг Twelve Oaks.
  - fixed: лимит point-ламп на сцену = 2 (как на комнату), комнатный уровень теперь error. Старые тесты budget/yard подправлены под это.
- **B22 — камеру над низкой стеной или балюстрадой отвергает CAMERA_OUTSIDE «внутри тела стены»** · MAJOR · `cameras/check.ts:45-62,120-123`: проверка не учитывает высоту, хотя `props/lint.ts:153` её учитывает. Воспроизведено.
  - fixed: если рядом с точкой только стены с явным `h` ниже камеры, камера над ними, а не в теле; контур комнаты полной высоты под камерой по-прежнему блокирует (низкая накладная стена его не маскирует).
- **B35 — второй build с тем же ctx затирает `cam.ref`** · MINOR · `build/geometry.ts:295`, `build/write.ts:148-163`.
  - fixed: geometry копирует камеры, `copyRefs` больше не мутирует сцену.
- **B36 — один GLB, который не загрузился в браузере, вешает `__ready`, и shots падают с exit 2** · MINOR · `runtime/main.ts:347-353`.
  - fixed: упавший `loadGlb` ловится, остаётся коробка и warn `GLB failed`, `__ready` ставится (как у актёров в stage).
- **B37 — имена снимков `A.png`/`a.png` совпадают на APFS** · MINOR · `build/shotnames.ts:13-26`.
  - fixed: `shotBaseNames` сравнивает имена без учёта регистра и формы Unicode (NFC), APFS складывает и то и другое (нашла Луна на ревью Б4).
- **B38 — клавиши залипают при потере фокуса окна** (нет сброса `down` на `blur`) · MINOR · `runtime/walk.ts:109-110`. **Статус: fixed** — `blur` очищает `down`.

### pipe2
- **B17 — после капа или Ctrl-C пишется done.json для недостроенной комнаты, и `--resume` её не перестраивает** · MAJOR · P5 · `h0/pipe2/room.py:272-283`. **Статус: fixed — пустая комната (кап, Ctrl-C) не пишет done.json и остаётся для resume.**
- **B18 — `capped=True` восстанавливается из чекпоинта, поэтому resume с поднятым капом отказывает во всём; `tokens_reserved` убитого процесса тоже не освобождается** · MAJOR · P5 · `h0/pipe2/ledger.py:48,116`. Проверено. **Статус: fixed — resume не берёт `capped` и резервы мёртвого процесса (токены и `usd_reserved`), проверяет кап заново.**
- **B23 — исключение после green выбрасывает green.json комнаты, а `{"crashed":…}` уходит дальше как partial** · MAJOR · `h0/pipe2/floor.py:~367-376`. **Статус: fixed — при падении после green `_build_rooms` берёт green.json комнаты, а не `{"crashed":…}`.**
- **B25 — тёплые H100 (`min_containers=k`, окно 600 с) не попадают ни в ledger, ни в кап** · CRIT (деньги) · `h0/pipe2/gpu.py:33`, `__main__.py:99`: греются ещё до архитектора. Это ~$0.076/мин на GPU, то есть сравнимо с $3.42 прогона. Урок #33/#38 требует греть после каркаса и держать окно ≤120 с. **Статус: fixed — окно 120 с, греем после зелёного каркаса (в Floor), `close` начисляет k × время в `h100_s`.**
- **B28 — откат критика: находки движка (перекрытия 2–43 см) выбрасываются, раунда починки нет, и статус «rolled_back» залипает даже после принятой правки** · MAJOR · `h0/pipe2/room.py:356-377`. Это причина «3 из 5 rolled_back» в прогоне 4: охотник переиграл ответы критиков через движок. **Статус: fixed — принятая следующая правка критика снимает `rolled_back`; находки движка по отвергнутой правке пишутся событием `critic_rejected`. Раунда починки нет.**
- **B29 — `repair_seams` пишет в откаченные комнаты, которых не трогал, и откатывает принятые швы** · MINOR · `h0/pipe2/seams.py:~64-68`. **Статус: fixed — откатываются только комнаты, которые seam_fix трогал.**
- **B24 — resume заново гоняет обоих критиков; поле `role` в green.json никто не читает** · MINOR · P5 · `room.py run/_author`. **Статус: fixed — resume читает `role` из green.json: после critic_layout пропускает его, после critic_assets обоих.**
- **B27 — resume снова платит за картинку объекта, у которого упал меш (`.src.png` игнорируется)** · MINOR · P5 · `assets.py _picture/_cached`. **Статус: fixed — объект с готовым `.src.png` в кэше не платит за картинку снова.**
- **B39 — Python-очередь пишет в кэш сырой sky без проверки 2:1 и шва; `as_png` пропускает обрезанный PNG; GLB проверяется только на непустоту** · MINOR · `h0/pipe2/assets.py:~215` против `engine/src/assets/run.ts:225-247`. Та же семья, что WebP→.png. **Статус: частично — `as_png` отвергает обрезанный PNG (чанки, CRC, IEND); проверка неба 2:1 и шва, GLB глубже непустоты — не сделаны.**
- **B40 — Spark: ретраи не считаются, в предоценке нет входных токенов, поэтому N параллельных вызовов перелетают кап** · MINOR · `spark.py`, `ledger.py allow`. **Статус: fixed — предоценка Spark считает и входные токены промпта.**
- **B41 — траты на картинки и меши (62% денег) не попадают в events.jsonl** · MINOR · `ledger.py charge`. **Статус: fixed — `Ledger.charge` пишет строку события для image и h100_s.**
- **B42 — упавшие shots превращаются в `preview_failed`, и прогон продолжается** · MINOR · `room.py:~434-440`. Урок #35 требует остановить прогон с причиной. **Статус: fixed — упавший preview пишет причину и останавливает комнату исключением (green.json остаётся).**

### dream
- **B43 — вечная взаимная блокировка: строка в очереди ждёт рассказчика, а рассказчик ждёт строку** · CRIT · `h0/dream/sim.py:1174-1177` против `:1370-1372`. Триггер: человек говорит, пока стоит переходная наррация. Воспроизведено: 400 тиков, `line_count=1`. **Статус: fixed — `_dialogue_turn` пускает ожидающую наррацию даже при `next_line`, строка стартует после неё.**
- **B44 — `Mind.update` держит 6 самых СТАРЫХ пунктов: новые TRIED/PROMISED выкидываются, старое обещание прибито** · MAJOR · `h0/dream/dialogue.py:379,383`. Должно быть `[-6:]`/`[-TRIED_KEEP:]`, как в сценовом пути на :394. Это (b)+(c) из диагноза «сон гниёт». Воспроизведено. **Статус: fixed — списки режутся `[-6:]`/`[-TRIED_KEEP:]`, остаются новые.**
- **B45 — ответ компрессора без метки (обрезан) стирает knows/promised/tried в `[]`** · MAJOR · `dialogue.py:370-384`. Воспроизведено. **Статус: fixed — список без метки в ответе не трогается.**
- **B46 — вторая реплика человека затирает первую, ещё стоящую в очереди** (первая уже ушла в память и директору) · MAJOR · `sim.py:850`. Воспроизведено. **Статус: fixed — вторая реплика человека уходит в `_human_backlog` за стоящей в `next_line`; `_cycle_line` подтягивает следующую.**
- **B47 — запланированные события и «Just now» героя забираются при старте генерации и теряются при turn_skip или смене эпохи/сцены** · MAJOR · P4 · `sim.py:1391,1398,1355-1367`. **Статус: fixed — взятые события актёра/«Just now» героя (`_gen_taken`) возвращаются в очередь, если ход отброшен (turn_skip, эпоха, сцена).**
- **B48 — события консультации (HUMAN_SAYS, клики) теряются, если ответ директора отброшен, упал или устарел; `ready_stale_fired` и `nudge` тоже** · MAJOR · P4 · `director.py:277-278,311-316`, `fsm.py:330-362`. Это (a). **Статус: fixed — `Director._requeue` возвращает события при None/invalid/stale/ошибке/паузе, `fsm.rearm_consult` перевзводит `ready_stale_fired` и `nudge`.**
- **B49 — Fish TTS синхронно в главном цикле: тик замирает до 4×15 с** · MAJOR · `sim.py:685-706`. Это (d), мёртвый эфир. **Статус: fixed — синтез голоса идёт в фоновом потоке (`_voicing`), строка стартует на первом тике после готовности.**
- **B50 — следующая строка генерируется только после конца текущей, `prepared_npc` почти не заполняется** · MAJOR (дизайн 1.2a, но это механическая причина 8 с тишины) · `sim.py:1368-1378`. Это (d). **Статус: fixed — следующая реплика генерируется, пока играет текущая, и стартует на том же шаге; выброшенная заготовка возвращает события (как B47). Тест 1.2a переписан под это.**
- **B51 — финальная строка cost пишется до join фолд-потоков Dialogue, и `verify_run` падает** · MAJOR при `--talk spark|wonder` · `sim.py:1638-1648`. Это Д7. **Статус: fixed — `run` ждёт `dialogue.wait()` до финальной строки cost; тест правлен: фолд отпускается таймером, иначе join в принципе не мог завершиться (worker освобождался после return `run`).**
- **B52 — после капа Spark Open падает в платный Spark 1.3 мимо капа** · MINOR · `llm.py:359` против `:262-269`. **fixed** — RealTransport не уходит в платный fallback при достигнутом капе, отвечает пусто с warning.
- **B53 — бенч считает мёртвый прогон по потолку; один TimeoutExpired теряет всю пачку** · MINOR · `bench_f1.py:296-305`, `bank.py:35,250`. Это остаток Д7. **fixed** — bank.run_scene ловит TimeoutExpired и отдаёт failed-run, пачка не теряется; bench_f1 не начисляет cap за timeout-мёртвый прогон, а учитывает записанный spend (0 если расходов не было); частичный вывод TimeoutExpired (bytes) декодируется перед разбором outdir=. Хозяин: sim печатает `rundir=` сразу, как создал папку, и bank берёт её при таймауте, даже если `outdir=` не успел.

### Серверы (P3)
- **B30 — dream/server.py: request smuggling мимо Origin-гарда через keep-alive** · CRIT · `h0/dream/server.py:145,162-172,437-448`. Сервер отвечает 403, не читая тело, и тело разбирается как следующий запрос без Origin. Воспроизведено: `SIM GOT: [('say','hello')]`. Фикс: `close_connection=True` на всех ранних выходах. **fixed** — do_POST ставит close_connection=True, пока тело не прочитано.
- **B31 — rt.py `/ws` без проверки Origin/Host: любая вкладка гонит ASR+Spark+Fish** · CRIT · `h0/live/rt.py:249-251`. Открытый хвост PROGRESS подтверждён. **Статус: fixed — `/ws` пускает только Origin `localhost:8091`/`127.0.0.1:8091`, иначе 403.**
- **B32 — live/server.py: CSRF и DNS-rebinding на `/turn` и `/asr`, плюс KeyError без ответа, гонки глобалов, пустой Fish на неизвестный id** · MAJOR · `h0/live/server.py:51-84`. **Статус: fixed — Host и Origin только свои (403 и закрытие соединения), плохое тело → 400, история и `lines` под локом, неизвестный tts id → 404 без вызова Fish.**
- **B33 — squid_live/server.py `/api/talk`: CSRF, ввод без лимита длины, роль `system` от клиента** · MAJOR · `h0/squid_live/server.py:156-185`. **Статус: fixed — Host/Origin только свои, тело ≤ 64 КБ, реплика ≤ 1000 символов, из истории проходят только `user`/`assistant`.**
- **B34 — rt.py: одно упавшее ASR-чанк-задание навсегда убивает детект хода; ошибка Spark пишет пустой ответ в history; ошибка Fish оставляет ход без `done`; `max_msg_size=0` и O(n²) срез** · MAJOR · `h0/live/rt.py:54-87,129-159,186-250`. **Статус: fixed — упавший ASR-чанк считается тишиной, сторож живёт; ошибка Spark/Fish всё равно шлёт `done` и не пишет пустой ответ в history; `max_msg_size` 1 МБ, кадры режутся на месте. Тест ждёт сторожа до 2 с вместо 20 × sleep(0).**
- **B54 — squid_live TTS-кэш не атомарен (обрезанный mp3), листинг каталогов открыт** · MINOR · `h0/squid_live/server.py:128-165`. **Статус: fixed — mp3 пишется во временный файл и переименовывается; листинг каталогов закрыт (404).**

### Уроки, которые код нарушает (anymove и дизайн будущих движков)
- **B55 — лимиты суставов L/R по-прежнему копируются, а не зеркалятся; rig.json (источник) не исправлен, у demon тот же баг** · CRIT (для будущего движка анимации) · `anymove/blender/common.py:58-60`, `anymove/assets/{squidward,demon}/rig.json`. Урок ENGINE_NOTES.md:23-29. `assets/squidward/` не в git. Проверено.
- **B56 — после solve нет проверки «доля кадров в упоре > 30%» и «амплитуда риг/ролик»** · MAJOR · `anymove/mocap/solve.py:392-447`. Урок ENGINE_NOTES:29,66.
- **B57 — единственный гейт — «врущий» score: нет ошибки по конечностям и листа «ролик | риг»** · MAJOR · `anymove/mocap/solve.py:149-154`. Урок ENGINE_NOTES:19-22.
- **B58 — нет проверки стабильности цвета конечностей и обрезки ролика** · MAJOR · `anymove/mocap`. Урок ENGINE_NOTES:30-35.
- **B59 — промпт кодирует цвет через left/right, а не через сторону экрана; число конечностей захардкожено в creature.json** · MAJOR · `anymove/assets/*/creature.json`, `anymove/tools/make_prompt.py:20,32`. Урок ENGINE_NOTES:76-80.
- **B60 — книга: `_book_step` теряет `stage/gesture/shot` бита, а duo.html ставит мизансцену регэкспом по прозе** · MAJOR · `h0/dream/sim.py:1103-1104`, `h0/squid_live/duo.html:295,326`. Уроки #22/#24/#27. Проверено. **Статус: fixed — `line` книжного бита несёт `stage/gesture/shot`; `duo.html` берёт их из события, `DIRECTED`/регэксп — запасной.**
- **B61 — «что движется» не входит в выход архитектора и в схему сцены** · MAJOR (дизайн) · `h0/pipe2/prompts/architect.md`, `engine/src/schema`. Урок engine-motion-question.
- **B62 — во фристайле книжного прогона актёр говорит голосом героя** · MAJOR · `h0/dream/sim.py:700`. У реплики Dialogue нет `actor`, голос берётся у `self.actors[0]`; в книжном плане герой стоит в actors первым → Сквидвард звучит голосом Спанч Боба. Найден в живом прогоне duo `--stall` 2026-10-31. **Статус: fixed (80c8a3d) — голос берётся по `who` реплики.**

### Отклонено / оставлено
- NAV_ROOM_CUT (warn в движке) — не баг для pipe2: `engine.py:23` и так считает его блокирующим. Для других потребителей это MINOR, без ID.
- `at`-проём на ничьей между уровнями: поведение задокументировано (`validate.ts:549`). Без ID.

## Hunt 2026-11-04 — semey live world (4 hunters: H1 state/money, H2 http/security, H3 build races, H4 client)

### B11 — Warm.lock / World.lock order inversion deadlocks the server — CRIT — fixed
- class: concurrency · location: h0/place/semey.py Warm.remove/_maybe_off/tick → on_spend=_spend_line (World.lock); World holds lock → warm.remove/count · found-by: H1 (corroborated: H3)
- trigger: last warm hold released in run_job finally (no world lock) while a claim/watch/admin free holds World.lock
- expected vs actual: no lock cycle vs permanent hang of every request
### B12 — Modal RPCs (autoscaler set, heartbeat Dict) run inside Warm.lock — MAJOR — fixed
- class: concurrency · location: semey.py Warm.add/tick/_maybe_off · found-by: H3 · pattern P1 with B11, B13
- expected vs actual: claim/view never wait on a network call vs they queue behind the RPC
### B13 — failed warm-off is never retried, GPU stays warm — MAJOR — fixed
- class: silent failure / money · location: semey.py Warm._maybe_off (on_since cleared before the try) · found-by: H3
### Pattern P1 — Warm does network I/O and calls back into World under its own lock
- members: B11 B12 B13 · repair: Warm decides under its lock, acts (RPC, on_spend) outside it; off retried by tick until it succeeds
### B14 — asset_cost sums the ledger's cumulative cap_hit row — MAJOR — fixed
- class: money · location: semey.py asset_cost; h0/pipe2/ledger.py cap_hit row carries cost_usd=self.spent · found-by: H1 (corroborated: H3)
- expected vs actual: capped build at ~$3 booked $3 vs ~$6
### B15 — over_budget auto-off only checked on warm spend — MAJOR — fixed
- class: money/contract · location: semey.py _spend_line only; run_job finally and _recover add to spent_usd directly · found-by: H1
- expected vs actual (spec): spent_usd > 20 → claims false + over_budget line vs claims stay true
### B16 — raw wish text shown on the public sign before any rude check — MINOR — fixed
- class: data/contract · location: semey.py claim label=text[:40], run_job Progress label, view · found-by: H1
### B17 — encoded ../ in /parts/<wid>/dist/ serves any file under parts/ — CRIT — fixed
- class: security · location: semey.py _get /parts/ check on raw rel, _safe unquotes and checks only base=parts · found-by: H2
- trigger: GET /parts/<wid>/dist/..%2fwish.txt → 200
### B18 — non-ASCII judge/admin key raises TypeError in compare_digest, connection dropped — MINOR — fixed
- class: input validation · location: semey.py admin key check, _key_ok · found-by: H2 (corroborated: H3)
### B19 — /api/admin with a non-object JSON body crashes the handler — MINOR — fixed
- class: input validation · location: semey.py admin route body.get · found-by: H2 (corroborated: H1)
### B20 — %00 in a path crashes the handler — MINOR — fixed
- class: input validation · location: semey.py _safe resolve() · found-by: H2
### B21 — fix_spec dedup truncates the suffix away for 24-char ids — MINOR — fixed
- class: logic · location: semey.py fix_spec oid = f"{oid}_{n}"[:24] · found-by: H2 (corroborated: H3)
### B22 — progress weights: timings.json "assets": 1.9 overrides the default, bar lies; DEFAULT has assets twice — MINOR — fixed
- class: progress · location: h0/place/progress.py DEFAULT/load_timings, h0/place/timings.json (user file, do not edit) · found-by: H3
### B23 — build_dist has no timeout; a hung engine build holds running + slots_sem forever — MAJOR — fixed
- class: lifecycle · location: h0/place/assets.py build_dist subprocess.run · found-by: H3
### B24 — Space hijacked on confirm/error cards (flow.field is the stale askWish textarea) — MAJOR — fixed
- class: client state · location: app/src/live.js confirm1/keydown handler · found-by: H4
### B25 — mic can stay open forever after cancel / early keyup; mic dead afterwards — MAJOR — fixed
- class: client lifecycle/privacy · location: live.js talk() early return on !flow, recorder.start async race · found-by: H4
### B26 — failed built-place load retried every frame (~60 req/s) — MAJOR — fixed
- class: client error handling · location: live.js loadBuilt catch + per-frame loop; interior.js no res.ok · found-by: H4
### B27 — any tolerated asset 404 shows the fatal "could not load" shell — MAJOR — fixed
- class: client contract · location: app/src/index.ts DefaultLoadingManager.onError · found-by: H4
### B28 — player inside a newly blocked zone is frozen — MINOR — fixed
- class: client collision · location: live.js move/blockedAt · found-by: H4
### B29 — unmapped server errors (403 origin/host/type, 400 fields, ASR 403/429/502) give misleading text — MINOR — fixed
- class: client error mapping · location: live.js ANSWERS / talk · found-by: H4

### Fix pass 2026-11-04 — haiku red tests, all red at their own assertion, then green
- server: h0/place/test_semey_bugs_world.py (B11–B15), test_semey_bugs_http.py (B16–B21), test_semey_bugs_build.py (B22–B23); `cd h0 && python3 -m unittest place.test_semey place.test_semey_bugs_world place.test_semey_bugs_http place.test_semey_bugs_build` → 52 OK
- client (bench, not in git): ~/.dreamer-bench/demo-bread/app/test/live_bugs.test.mjs (B24–B29) → 11/11; B24, B25, B26b, B27, B29c are structural checks of the source, the rest behavioral
- P1 fixed at the source: Warm decides under its lock, RPCs and on_spend outside it, the autoscaler state it applied is tracked and tick re-sends it (a restart starts from "unknown" and sends off — also closes "_recover never switches the autoscaler off")
- B15: World._book is the only place money is added; B22 floor = a quarter of DEFAULT, timings.json untouched; B23 timeout 900 s → code 124
- e2e look on a local server with the rebuilt client: five signs, door, no 4xx/5xx

## Hunt 2026-11-04 (b) — parking notes of the same hunt, promoted (stop-hook review + automated security review)
### B30 — main prints the judge key to stdout (lands in Modal logs) — MINOR — fixed
- class: security/observability · location: h0/place/semey.py main print(...?k={judge_key}) · found-by: H2 parking, security review
### B31 — slow-drip clients: 15 s per recv, no whole-request deadline; 48 slow sockets hold every server thread — MAJOR — fixed
- class: availability · location: semey.py H.timeout=15, BoundedServer(limit=48) · found-by: H2 parking
- expected vs actual: a request that is not fully read within a deadline is closed vs it holds a thread as long as one byte per 15 s arrives
### B32 — semey_modal starts the server with a bare Popen; a crash leaves the container up and the world dead — MAJOR — fixed
- class: lifecycle · location: h0/place/semey_modal.py web() · found-by: H3 parking
### B33 — Rate never prunes keys; one entry per IP forever — MINOR — fixed
- class: resource leak · location: semey.py Rate.ok · found-by: H2 parking
### B34 — after a restart nobody switches the autoscaler off (a crash mid-build leaves the GPU warm) — MAJOR — fixed
- class: money · location: semey.py World._recover / Warm · found-by: H1 parking · note: covered by the P1 fix (Warm.applied starts unknown, the first tick sends off); test owed
### B35 — build_place ignores fill_cache's missing list: every object missing (GPU down) still ships an empty room as "built" — MAJOR — fixed
- class: silent failure · location: semey.py build_place after fill_cache · found-by: H3 parking
- expected vs actual: all 3D objects missing → the build fails (the slot frees, the try is refunded) vs an empty shell is built and booked
### B36 — semey_admin crashes on a non-JSON error body and on a missing argument (free / claims without N / on|off) — MINOR — fixed
- class: input validation · location: h0/place/semey_admin.py call() json.loads, main rest[0] · found-by: H2 parking
### B37 — client poll has no in-flight guard: a slow server stacks /api/slots requests every 2 s — MINOR — fixed
- class: client · location: app/src/live.js setInterval api('/api/slots') · found-by: H4 parking
### B38 — a built place that goes away is removed without disposing its meshes/materials/textures — MINOR — fixed
- class: client resource leak · location: live.js applySlots unload branch · found-by: H4 parking
### B39 — window error / unhandledrejection show the fatal "could not load" shell over a world that already runs — MAJOR — fixed
- class: client contract · location: app/src/index.ts addEventListener('error'|'unhandledrejection') · found-by: H4 parking
### B40 — X-Forwarded-For: last hop trusted, unverified against Modal's proxy — MAJOR — partly fixed: the probe is in (admin status `you`, test B40 green locally); trust itself verified only after deploy
- class: security (rate-limit bypass if the proxy does not append) · location: semey.py H._ip · found-by: H2 parking, security review
- manual verify after deploy: admin status reports the caller ip as the server sees it; call it with and without `X-Forwarded-For: 1.2.3.4` — the ip must not become 1.2.3.4
### not code: /video.mp4 is missing from the client (the "Watch the recording" links 404) — owed content; putting the film online is Tero's action

### Fix pass (b) 2026-11-04
- server: h0/place/test_semey_bugs_more.py (B30–B36, B40), red at own assertion except B34 (green on arrival: the P1 fix already sends off on the first tick after a restart; kept as regression)
- client: ~/.dreamer-bench/demo-bread/app/test/live_bugs2.test.mjs (B37–B39), red on the old copy (LIVE_JS/INDEX_TS env), green now; B39 structural
- `cd h0 && python3 -m unittest discover -s place -p "test_*.py" -t .` OK (61 semey tests); client 14/14; e2e look clean, the start line prints `?k=<judge key>`
- extra: BoundedServer.handle_error drops client hang-ups (ConnectionError) instead of a traceback per scanner
- B31 deadline 20 s for the whole request (headers, POST body); a big file download after that is not cut
- still open, not code: /video.mp4 (Tero's film), Space+mic by hand with a real microphone, B40 after deploy

## Hunt 2026-11-04 (c) — final pre-deploy sweep (3 sonnet hunters: H1 deploy/lifecycle, H2 money/security, H3 client contract) + first real deploy
### B41 — Modal prints the region host `highskilltero--semey-web.us-east.modal.run`; PUBLIC_HOST knows only the bare one → 403 host on the printed link — MINOR — fixed
- class: deploy config · location: h0/place/semey.py make_handler _host_ok/_origin_ok, semey_modal.py PUBLIC_HOST · found-by: senior (deploy)
- expected vs actual: both modal hosts of the app serve and accept same-origin POSTs vs only the bare one
### B42 — autoscaler RPC runs under World.lock: _release_locked → warm.remove → _after_off → _sync → a.set(...) — MAJOR — fixed
- class: lock discipline (rest of B12) · location: semey.py _release_locked / Warm._after_off / _sync, callers watch, admin free, _recover · found-by: H2
- expected vs actual: no RPC under World.lock (slots/claims keep answering while Modal is slow) vs every request blocks for the RPC
### B43 — admin free with place 2.0 → KeyError, no reply; admin CLI crashes on `free abc` and on a missing key (None header) — MINOR — fixed
- class: input validation · location: semey.py admin free (place in FREE_PLACES then st["places"][str(place)]); semey_admin.py main/call · found-by: H2
### B44 — server 400 nick/text shows the bare word ("nick") and Back goes to the wish step, the nick can never be fixed — MINOR — fixed
- class: client error mapping · location: live.js claim 400 branch · found-by: H3
### B45 — invalid nick / too-short wish: Next does nothing, no message — MINOR — fixed
- class: client UX · location: live.js nick/wish checks · found-by: H3
### B46 — held W sticks after window blur (keyup lost), player walks alone — MINOR — fixed
- class: client input · location: live.js keydown/keyup, no blur handler · found-by: H3
### B47 — "Sending…" card has no buttons and api() no timeout: a stalled request freezes the page until reload — MINOR — fixed
- class: client lifecycle · location: live.js api(), sending card · found-by: H3
### B48 — retry after a lost claim response says "already built" (403 used) while the build is running — MINOR — fixed
- class: client state machine · location: live.js claim 403 used mapping · found-by: H3
### B49 — /video.mp4 served without Range / Accept-Ranges: Safari will not play it, no seeking — MINOR — fixed
- class: serving · location: semey.py _file · found-by: H3
### B50 — dist built without .env carries the literal `%VITE_VIDEO_URL%`: "Watch the recording" links are dead (live on the first deploy) — MAJOR — fixed
- class: build config · location: app/index.html SEMEY_VIDEO + link href, .env gitignored · found-by: H3 parking, confirmed by senior on the deployed dist
### verified after deploy
- B40: admin status `you` = 50.208.132.118 with and without `X-Forwarded-For: 1.2.3.4` → trust holds behind Modal's proxy — fixed (verified)
### B51 — the Modal image runs none of the spec's build-time checks (imports, --selftest, node ≥ 22.12, client files): a broken image shows up only at the first judge — MAJOR — fixed
- class: deploy contract · location: h0/place/semey_modal.py image · found-by: H1
### B52 — live mode dies whole (fatal "could not load") when localStorage throws (site data blocked) — MINOR — fixed
- class: client robustness · location: live.js keyAndToken / semey_nick · found-by: H1
### B53 — supervise sleeps the stale crash-loop delay once after a healthy run — MINOR — fixed
- class: logic · location: semey_modal.py supervise · found-by: H1
### note: B43 also covers `semey_admin claims <not on|off>` silently sending off (H1 #3); B42 corroborated by H1; B49 corroborated by H1 parking

### Fix pass (c) 2026-11-04 — sonnet red tests, red at own assertion on the old code, green now
- server: h0/place/test_semey_bugs_c.py (B41 B42 B43 B49), test_semey_bugs_c2.py (B43b B51 B53) → full place suite 72 OK; selftest ok
- client: test/live_bugs3.test.mjs (B44–B48, B50), live_bugs4.test.mjs (B52, red on HEAD live.js via LIVE_JS) → green; tsc clean
- B42: Warm.remove_later (hold drops at once, RPC + booking on their own thread); B41: PUBLIC_HOST is a comma list, Origin must match the Host used; B49: one byte range, 206/416, Accept-Ranges; B50: vite.config default + runtime '%' guard; B51: image runs imports, --selftest, node ≥ 22.12, client files and no '%VITE_' at build
- not mine: test/film_bugs.test.mjs F2 red on the uncommitted film edits of demo.js (another session's work in progress)
### B54 — my B47 edit put a `//` comment mid one-line api(): live.js stopped parsing, the client build failed; the slicing tests stayed green — CRIT — fixed
- class: regression (syntax) · location: app/src/live.js api() · found-by: senior (worktree build)
- lesson: structural/sliced tests never parse the whole module — a parse check of every client module + a real `vite build` with no leftover tokens belong in the client suite
### B50 (re-opened, then fixed) — vite's %ENV% html replacement ignores a default set in vite.config: the literal still shipped; now the html carries __SEMEY_VIDEO__ and a transformIndexHtml plugin always fills it (VITE_VIDEO_URL or /video.mp4); verified in a real build
### B55 — the image had no `modal` package (server's volume.commit / SAM3D warm import it in the subprocess) — MAJOR — fixed: caught red by the new B51 build check on the redeploy, green after pip modal==1.6.2
### B56 — the node:22-bookworm-slim base has no ca-certificates: every https call from the container (Spark, Muse, ASR) fails CERTIFICATE_VERIFY_FAILED, so no build can pass — CRIT — fixed: apt ca-certificates + a build-time https probe to api.meta.ai (an HTTPError answer passes, an SSL/URL error fails the image); found by the gate-2 real build (failed in 7 s, why=URLError), reproduced inside the live container
### gate 2 on Modal (19:08–19:11 ET): real build `wc8581e52ad44` "a small bakery with fresh bread" on a cold GPU, claim → built 184 s; Playwright on the public link: loaded, walked in and out with W, still there after reload, 0 responses ≥ 400 (scratchpad e2e/live_e2e.mjs)
### B57 — inside a judge's built place the hint pill says "Walk up to a place on the ground floor…" (insideNow knows only shop2) — MINOR — reported
- class: client UX · location: live.js hintFor / insideNow · found-by: senior (gate 2 frames)
### B58 — Spark's wall tile prompt describes the room layout ("beige plaster, lower half pale green"); the tile repeats every 1.5 m so the walls come out in horizontal bands (the L187(3) class: a tile prompt must be one uniform surface) — MAJOR — reported
- class: generation quality · location: semey.py WISH_PLACE "wall"/"floor" + fix_spec · found-by: senior (gate 2 frames)
### parked: a white 0.6 m panel on the back wall inside wc8581e52ad44 — not in decals/props/lights of the scene; likely the block's own facade piece behind the 0.15 m gap; look after the deadline
### note on IDs: the 2026-11-04 semey hunts started at B11 while the 2026-10-31 hunt already used B11–B62 — semey IDs (B11–B58 under the "Hunt 2026-11-04" headings) are read within their sections; the next hunt starts at B63
### fix (B57, B58 of hunt c): hintFor checks the loaded judge rooms in their local frame; WISH_PLACE asks for one uniform material per tile and fix_spec appends TILE_RULE to wall/floor — red tests test_semey_bugs_d.py, live_bugs5.test.mjs → green
### B59 — while a place builds, the progress sign (3D, 3.6 m) is cut by the top of the screen at the slot and the hint pill (top:18px) sits on top of it: the judge cannot read stage/% /time — MAJOR — fixed: pill at bottom:28px, the building hint carries stage · pct · m:ss; red test app/test/live_bugs6.test.mjs → green, client 08f9524, deployed
- class: client UX · location: live.js #lv-hint css + hintFor 'building' · found-by: senior (recorded spare, frames 40–195 s)
- fix plan: pill moves to the bottom of the screen; near a building place the pill itself carries stage · pct · m:ss
