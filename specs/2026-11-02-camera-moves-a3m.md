# Камера, полоса A, К3м версия 2: режиссёр берёт выбор Spark (план tero)

Заменяет фазу «К3м. engine: мост для make и стиль в рантайме» спеки `specs/2026-11-02-camera-moves-a.md`. Отдельный `tero go` в `meta-ka` после SHIP фазы К2. Старую К3м из того прогона хозяин останавливает.

**Почему.** В первой версии Python заранее считал, где стоят актёры, а мост строил по этому фиксированные точки камеры. Python копировал логику рантайма (`startSpot`, `bedSitSpot`, занятость мест, повороты клипов) и всегда с ней расходился: полоса B не сошлась за 9 раундов. В версии 2 Spark только выбирает приём и субъекта на бит (файл `shotplan/moves.json`, его пишет полоса B, `specs/2026-11-02-camera-moves-b2.md`). Режиссёр К2 и так выбирает приём на событие и ставит камеру по живым актёрам (`resolveMove`). Здесь он учится брать готовый выбор вместо своего жребия `pickMove`.

### Территория

- **Пишет только:** `engine/bin/moves.ts` (новый, только `--catalog`), `engine/src/runtime/stage/index.ts`, `engine/src/runtime/stage/director.ts`, одна строка в `engine/src/runtime/main.ts` (`?camera_style=`), тесты `engine/test/stage-moves-catalog.test.ts` (новый), `engine/test/stage-director-forced.test.ts` (новый), `research/feature_map_camera_a.md`.
- **Не пишет:** `h0/**`, `app/**`, `engine/src/runtime/stage/moves.ts` и `styles.ts` (К1/К2 готовы; нужна правка — `BLOCKED` в долг).
- Карта кода: строки в `research/feature_map_camera_a.md`, хозяин переносит при слиянии.

### Игроки, судья, фьюз

- Игроки `--player-schedule claude:claude-sonnet-5-5×6`, 6 раундов; судья codex gpt-6-luna, эскалация claude:sonnet, тестера нет.
- Блокер — красный тест, нарушение явного пункта или запись вне территории. Крайний случай, которого нет в пунктах, — minor в долг. Мост `<in.json> <out.json>`, `planScheme` в рантайме, `plan.notes` — **не в этой версии**, это не находки.
- Фьюз: 6 раундов без SHIP → остаток в `specs/make-debt.md` («Камера, полоса A»).
- Тесты `vitest`, сначала красный тест. Гейт `sh tools/gate.sh` зелёный. Детерминизм — только через переданный `rng`.

### Контракт `shotplan/moves.json` (общий с полосой B)

```json
{"version": 1, "scene": "bedroom", "style": "storybook",
 "beats": {"2": {"move": "follow_side", "subject": {"actor": "Mama"}},
           "3": {"move": "close", "subject": {"actor": "Mirai"}},
           "4": {"hold": true}},
 "warnings": []}
```

Ключ — индекс бита в партитуре. Значение — `{move, subject}` или `{hold: true}`. `move` ∈ `MOVES` ∪ `SCHEMES` без `oner`/`rhythm_cut`/`open_from_light` ∪ `RECORDS`. Субъект: `{actor}`, `{pair: [a, b]}`, `{room: true}` (только у `wide`/`master`/`establishing`). Путь к файлу — поле `stage.json.moves` (`"shotplan/moves.json"`, от папки прогона).

---

## К3м2. engine: режиссёр на выборе Spark, каталог, стиль

Правила, у каждого свой тест (`r<N>` в имени):

1. **Каталог.** `node --import tsx bin/moves.ts --catalog` (с `cwd = engine/`) печатает `{"styles": [...], "moves": {id: смысл}, "schemes": {...}, "records": {...}, "weights": {style: {id: вес}}}` из `STYLES`/`MOVES`/`SCHEMES`/`RECORDS` без своих копий. Любой другой аргумент → код 2 и строка использования. Тест: 8 стилей, множества ID не пересекаются, у каждого непустой смысл, `weights` совпадают со `STYLES[s].weights`; вывод совпадает по ключам с `h0/make/testdata/shotplan_koshakan/catalog.json` (если файла нет в ветке — тест пропускается).
2. **Чтение файла.** `startStage` читает `stage.moves` так же, как `stage.shotplan` (`index.ts`, рядом с разбором `shotplan`): поле нет, файл не читается или не JSON → без выбора Spark, предупреждение `stage: moves "<путь>" not readable -> director`. Проверка формы: `version !== 1` или `beats` не объект → файл игнорируется целиком, предупреждение. Элемент с ID вне разрешённых или с неверным субъектом → игнорируется только он, `MOVE_UNKNOWN B<i>` / `SUBJECT_INVALID B<i>`. Для тестов — `StageCtx.moves?` (готовый объект, как `shotplan`).
3. **Стиль.** Порядок: `moves.style` (если есть в `STYLES`) → `StageCtx.cameraStyle` (`main.ts` передаёт `?camera_style=`) → `storybook`. Результат идёт в `createDirector(rng, {snap, style})`. Тесты: `moves.style = "ozu"` → ни одного `end`; нет файла и `cameraStyle: "anderson"` → `anderson`; ничего → `storybook`.
4. **Принуждённый приём.** `DEvent.forced?: {move, subject}`. `index.ts` кладёт его в событие бита `beat`, если в `moves.beats[beat]` есть `move`. Режиссёр на таком событии не вызывает `pickMove` и теги не применяет. ID схемы раскладывается в атом по таблице «Схемы в режиссёре» (`over_the_shoulder` → `ots` на говорящего и т. д.), запись (`RECORDS`) — как в К1, статичная точка и `MOVE_RECORD_ONLY`. Субъект: `actor` → этот актёр, `pair` → пара, `room` → комната. Дальше обычный `resolveMove` с тем же `ctx`. Если `resolveMove` не нашёл законной точки, режиссёр поступает как с собственным выбором (fallback К1/К2), добавляя предупреждение `FORCED_FALLBACK B<i> <id>`. Тесты: `forced: close` на Мирай на событии с тегом `look` → `move == close`, не `over_the_shoulder`; `forced: over_the_shoulder` → атом `ots`; `forced: dutch` → `MOVE_RECORD_ONLY`; `forced` на актёра вне сцены → fallback и `FORCED_FALLBACK`.
5. **`hold`.** `moves.beats[beat] = {hold: true}` → на событиях этого бита смена бита план не режет (`cut` не растёт), камера продолжает текущий план. Новая реплика внутри бита режет по правилу склейки стиля, как обычно. Смена комнаты режет всегда, предупреждение `HOLD_IGNORED B<i>`. Тесты: `hold` → `cut` тот же; `hold` при смене комнаты → `cut +1`, `HOLD_IGNORED`.
6. **Бит без записи** → поведение К2 без изменений (жребий стиля, теги). Тест: файл с одним битом не меняет выбор на остальных (тот же `rng` → те же `move`, что без файла).
7. **Приоритет Г8.** Если у сцены есть и `shotplan` (Г8), и `moves`, план Г8 приоритетнее, как сегодня; `moves` действует там, где плана Г8 нет. Тест на фейковой сцене.
8. **Факт критика.** `move` в факте — принуждённый ID, если он был (после раскладки схемы — атом), иначе как в К2. Тест читает JSONL.

Проверки:
- [ ] красные тесты по правилам 1–8
- [ ] код; `research/feature_map_camera_a.md` дописан; все существующие тесты режиссёра и `shotplan` зелёные; гейт зелёный
