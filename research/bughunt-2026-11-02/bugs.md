# bugs.md — багхант 2026-11-02 (agy gemini-3.8-flash-high)

Все записи — НЕПРОВЕРЕННЫЕ утверждения охотников. Баг считается доказанным, только когда красный тест падает на своём assertion.

Статус: `red` / `rejected` (проставлено после аудита тестов). ID неизменны. Дубли не найдены (охотники делили зоны). Тяжесть — как у охотника, пересмотр после красных тестов.


## B01 · MAJOR · engine/src/runtime/stage/index.ts:408  (охотник h1)

- **claim:** Действия перемещения stage (goto/come/turn_away/stay) и touch не сбрасывают состояние выполняющегося выхода (exiting, exitThrough, exitPending, exitSettled), из-за чего прервавший выход актёр после прихода к новой цели принудительно выбрасывается со сцены.
- **trigger:** Актёр начинает выход через handlers.stage({ who: "Mama", action: "exit" }) (попадая в exiting и exitThrough), но до двери получает handlers.stage({ who: "Mama", action: "goto", place: "chair" }), успешно доходит до стула и останавливается.
- **expected:** Актёр остаётся на стуле в сцене (offstage: false), прерванный выход полностью отменяется.
- **actual:** В очередном update() цикл по exiting видит остановившегося актёра и старую дверь в exitThrough, принудительно вызывает act.go([door.at, beyond], ...) напрямик в дверь сквозь препятствия и переводит актёра в offstage: true.
- **evidence:**
```ts
        const tgtPos = getTargetPos(lookTarget);
        const lookYaw = tgtPos ? yawTo(pl.at, tgtPos) : "along";
        touch(who, pl.name, pose, lookYaw);
        return;
```
- **status:** fixed (opus) — engine/test/bughunt/b01.test.ts

## B02 · MAJOR · engine/src/runtime/stage/touch.ts:53  (охотник h1)

- **claim:** Очередь pending в createToucher хранит только имя места в Map<string, string>, полностью теряя переданные pose и finishYaw при задержке перемещения на рампе.
- **trigger:** Актёр находится на рампе (levelOf(who) === null), и вызывается toucher.touch(who, "chair", "sit", 90). После схода актёра с рампы на уровень в кадре вызывается toucher.tick().
- **expected:** Повторный вызов в tick() использует сохранённые pose: "sit" и finishYaw: 90, сажая актёра на стул (act: "sit") лицом к цели.
- **actual:** tick() вызывает touch(who, name) без параметров, pose и finishYaw становятся undefined, актёр остаётся стоять (act: "idle") с дефолтным углом, а для мест со slots бронь не разрешается и переводит в stand_at рядом с местом.
- **evidence:**
```ts
    const from = levelOf(who);
    if (from === null) {
      pending.set(who, name);
      return "queued";
    }
```
- **status:** fixed (sonnet) — engine/test/bughunt/b02.test.ts

## B03 · MAJOR · engine/src/runtime/stage/index.ts:633  (охотник h1)

- **claim:** Выбор фокуса камеры focus для события line не проверяет !offstageActors.has(ev.speaker), из-за чего реплика вышедшего персонажа наводит камеру на внесценического актёра и строит вырожденный ракурс в пустую комнату.
- **trigger:** Персонаж покинул сцену (offstageActors.has("Mama") === true), после чего поступает его реплика handlers.line({ who: "Mama", text: "Я ушла!" }).
- **expected:** Фокус камеры отбрасывает внесценического говорящего и выбирает оставшихся на сцене персонажей (onstageList / onstageSorted), показывая их реакцию на реплику.
- **actual:** Строка 633 безусловно выбирает внесценического актёра, комната вне сцены передаётся в director.step, где all актёров оказывается пуст, а режиссёр возвращает совпадающие X и Z для cam и look ([legal[0], eye, legal[2]] и [legal[0], lookY, legal[2]]), направляя камеру строго вниз параллельно вектору up.
- **evidence:**
```ts
      if (ev.kind === "line" && ev.speaker) focus = list.find((a) => a.who === ev.speaker) ?? onstageList.find((a) => a.speaking()) ?? onstageSorted[0] ?? sorted[0];
      else if (ev.kind === "narrator") focus = (ev.about && !offstageActors.has(ev.about) ? list.find((a) => a.who === ev.about) : undefined) ?? onstageSorted[0] ?? sorted[0];
      else focus = onstageList.find((a) => a.speaking()) ?? (ev.speaker && !offstageActors.has(ev.speaker) ? list.find((a) => a.who === ev.speaker) : undefined) ?? (lastSpeaker && !offstageActors.has(lastSpeaker) ? list.find((a) => a.who === lastSpeaker) : undefined) ?? onstageSorted[0] ?? sorted[0];
```
- **status:** fixed (opus) — engine/test/bughunt/b03.test.ts

## B04 · CRIT · engine/src/runtime/stage/index.ts:428  (охотник h1)

- **claim:** Обработчик действия enter не проверяет валидность угла двери door.yaw, что при входе через дверь с неопределённым yaw передаёт undefined в interRoomDoorStep и необратимо превращает координаты актёра в NaN.
- **trigger:** В places.json у двери отсутствует yaw (door.yaw === undefined), и вызывается handlers.stage({ who: "Mama", action: "enter", place: "door" }).
- **expected:** Движок валидирует yaw или использует безопасный дефолт (как в exit: door.yaw ?? 0), сохраняя валидные координаты актёра.
- **actual:** interRoomDoorStep вычисляет Math.sin(undefined * Math.PI / 180), возвращая insidePos: [NaN, NaN], из-за чего teleport и go необратимо портят позицию и поворот актёра значениями NaN.
- **evidence:**
```ts
        const step = interRoomDoorStep(door.at, door.yaw, 1.0);
        a.teleport(step.doorPos, step.yaw, "idle", y);
        const tgtPos = getTargetPos(lookTarget);
        const faceYaw = tgtPos ? yawTo(step.insidePos, tgtPos) : step.yaw;
        a.go([step.insidePos], faceYaw, "idle", y);
```
- **status:** fixed (opus) — engine/test/bughunt/b04.test.ts

## B05 · CRIT · engine/src/runtime/main.ts:241  (охотник h2)

- **claim:** При пустом массиве nav.layers рантайм падает с необработанным TypeError из-за обращения к all[0].layer.
- **trigger:** nav.json с layers: [] (сцена без комнат или без проходимых слоев)
- **expected:** безопасная инициализация навигации или пропуск создания walker без падения страницы
- **actual:** TypeError: Cannot read properties of undefined (reading 'layer')
- **evidence:**
const all = (nav.layers ?? []).map((l: any) => ({ layer: l, bits: unbase64(String(l?.bits ?? "")) }));
  const walker: Walker = makeWalker(all[0].layer, all[0].bits, geo.floors ?? [], geo.spawn.at, {
    layers: all.slice(1),
    ramps: nav.ramps ?? [],
  });
- **status:** fixed (sonnet) — engine/test/bughunt/b05.test.ts

## B06 · MAJOR · engine/bin/dreamer.ts:108  (охотник h2)

- **claim:** Парсинг аргумента --report не проверяет отсутствие значения и поглощает следующий флаг --built как имя файла отчёта, создавая на диске файл с именем "--built".
- **trigger:** dreamer check scene.json --report --built dist
- **expected:** ошибка валидации аргументов командной строки о пропущенном значении флага --report
- **actual:** создается файл отчёта с именем "--built", а флаг --report поглощает аргумент флага --built
- **evidence:**
let reportPath: string | null = null;
  const ri = args.indexOf("--report");
  if (ri >= 0) reportPath = args[ri + 1] ?? null;
- **status:** fixed (sonnet) — engine/test/bughunt/b06.test.ts

## B07 · MAJOR · engine/src/runtime/doors.ts:125  (охотник h2)

- **claim:** touchTarget возвращает идентификатор двери при входных координатах или углах взгляда со значением NaN, так как операции сравнения с NaN возвращают false и обходят проверки дистанции и высоты луча.
- **trigger:** touchTarget([door], [NaN, NaN], 0) или touchTarget([door], [0, 0], NaN)
- **expected:** null (луч с некорректными координатами NaN не должен пересекать дверь)
- **actual:** возвращается id первой двери из списка, так как все проверки t < 0, t > TOUCH_M, s < 0, s > 1 и y < y0 ложны для NaN
- **evidence:**
if (t < 0 || t > TOUCH_M || s < 0 || s > 1 || t >= bestT) continue;
    const y0 = door.def.y0 ?? 0;
    const y1 = door.def.y1 ?? y0 + door.def.height;
    const y = eyeY + t * tanP;
    if (y < y0 - 1e-9 || y > y1 + 1e-9) continue;
- **status:** fixed (sonnet) — engine/test/bughunt/b07.test.ts

## B08 · MAJOR · engine/src/runtime/cams.ts:66  (охотник h2)

- **claim:** В режиме камеры top=1 при пустом массиве мешей геометрии координаты центра и матрица камеры заполняются значениями NaN.
- **trigger:** pickCamera({ spawn: { at: [0, 0], y: 0, yaw: 0 }, meshes: [] }, new URLSearchParams("top=1"), 1.6)
- **expected:** конечные координаты камеры (0, 0) или координаты точки спавна и валидная матрица вида
- **actual:** cx и cz вычисляются как (Infinity + (-Infinity)) / 2 = NaN, camera.position становится (NaN, 100, NaN), а элементы матрицы камеры содержат NaN
- **evidence:**
const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    camera.position.set(cx, geo.spawn.y + 100, cz);
    camera.up.set(0, 0, -1);
    camera.lookAt(cx, geo.spawn.y, cz);
- **status:** fixed (sonnet) — engine/test/bughunt/b08.test.ts

## B09 · MINOR · engine/src/runtime/assets.ts:65  (охотник h2)

- **claim:** fitGlb для группы без мешей вычисляет вертикальную позицию Y как -Infinity.
- **trigger:** fitGlb(new Group(), { min: new Vector3(0, 0, 0), max: new Vector3(1, 1, 1) })
- **expected:** позиционирование группы с конечной координатой Y внутри ограничивающего бокса
- **actual:** для пустой группы glbBox.min.y равен Infinity, в результате чего box.min.y - glbMinY вычисляется как -Infinity
- **evidence:**
const glbCenter = glbBox.getCenter(new Vector3()).multiplyScalar(scale);
  const glbMinY = glbBox.min.y * scale;
  const boxCenter = box.min.clone().add(box.max).multiplyScalar(0.5);
  glbScene.position.set(boxCenter.x - glbCenter.x, box.min.y - glbMinY, boxCenter.z - glbCenter.z);
- **status:** fixed (sonnet) — engine/test/bughunt/b09.test.ts

## B10 · MAJOR · h0/make/book.py:236  (охотник h5)

- **claim:** Шаг voices копирует из директории read только book.txt, отбрасывая остальные файлы глав и ломая контракт валидации load_book на следующем шаге world.
- **trigger:** Запуск конвейера книги, у которой в book.json главы ссылаются на отдельные файлы (например, chapters[0].file = "ch1.txt").
- **expected:** Шаг voices сохраняет все файлы глав, сгенерированные шагом read, чтобы load_book на шаге world успешно их прочитал.
- **actual:** voices копирует только book.txt; валидация _check_input("world") вызывает load_book, которая падает с ValueError: chapters[1].file: 'ch1.txt' not found, обрывая пайплайн.
- **evidence:**
shutil.copy(ctx.prev("read") / "book.txt", ctx.out / "book.txt")
    (ctx.out / "book.json").write_text(json.dumps(book, ensure_ascii=False, indent=2), encoding="utf-8")
    (ctx.out / "voices.json").write_text(json.dumps({"voices": assigned, "warnings": warns}, indent=2))
- **status:** fixed (sonnet) — h0/make/test_bughunt_b10.py

## B11 · MAJOR · h0/make/book.py:271  (охотник h5)

- **claim:** Шаг cast выполняет поверхностное копирование только обычных файлов из cast_dir, пропуская подпапки с клипами анимаций и приводя к ошибке валидации check_cast.
- **trigger:** Запуск make.book с параметром --cast-dir, в котором файлы анимаций лежат в поддиректории (например, clips/walk.glb, как задано в cast.json).
- **expected:** Рекурсивное копирование дерева ассетов cast_dir (аналогично shutil.copytree в make/cast.py), при котором клипы попадают в ctx.out.
- **actual:** Условие f.is_file() пропускает папки, клипы не копируются в ctx.out, и последующий вызов check_cast падает с ошибкой: <who>.clips.<clip>: 'clips/...' missing or not a GLB.
- **evidence:**
for f in sorted(Path(ctx.cast_dir).iterdir()):
        if f.is_file():
            shutil.copy(f, ctx.out / f.name)
    errs = _cast.check_cast(ctx.out)
- **status:** fixed (sonnet) — h0/make/test_bughunt_b11.py

## B12 · MAJOR · h0/make/core.py:89  (охотник h5)

- **claim:** Валидация _run_brief безусловно требует непустой prompt, отклоняя запуск через --book и --scene без позиционного промпта вопреки CLI-спецификации.
- **trigger:** Запуск python3 -m make --book dream/books/jane-eyre --scene tea без указания позиционного промпта (в __main__.py он опционален: nargs="?", default="").
- **expected:** Прогон успешно стартует: seed_from_book и make_brief штатно поддерживают отсутствие промпта при наличии книги и сцены (используя scene_id и book_note).
- **actual:** _run_brief выбрасывает BriefFailed('brief needs a prompt (make.json.prompt is empty)') и прерывает выполнение до вызова генератора брифа.
- **evidence:**
prompt = (ctx.opts.get('prompt') or '').strip()
    if not prompt:
        raise _brief.BriefFailed('brief needs a prompt (make.json.prompt is empty)')
    book, scene = ctx.opts.get('book'), ctx.opts.get('scene')
- **status:** fixed (opus) — h0/make/test_bughunt_b12.py

## B13 · MAJOR · h0/make/stage.py:203  (охотник h5)

- **claim:** Двери в build_places добавляются в обход дедупликации имён _name_places со статичным шаблоном {room} door, порождая дублирующиеся имена мест в одной комнате.
- **trigger:** Построение мира, где в одной комнате расположено две или более двери (например, коридор с дверями в спальню и кухню).
- **expected:** Каждое место двери получает уникальное имя (например, living door, living door 2), как это делает функция _name_places для одинаковых пропов.
- **actual:** Все двери комнаты получают идентичное имя f"{room} door"; в рантайме places.find(...) всегда возвращает первую дверь, вторая дверь недостижима по имени, а словарь claims["... door"] конфликтует между дверями.
- **evidence:**
places.append({"name": f"{room} door", "id": d["id"], "kind": "door", "room": room, "level": lv,
                       "at": at, "yaw": round(yaw, 3), "look": c, "obstacle": None,
                       "poses": ["door"]})
- **status:** fixed (sonnet) — h0/make/test_bughunt_b13.py

## B14 · MAJOR · h0/make/story.py:102  (охотник h5)

- **claim:** Нарушен контракт зависимостей стадий DAG: run_story пытается читать stage/places.json, однако в DAG стадия story выполняется параллельно с world и до stage, поэтому места всегда тихо отсутствуют на чистом прогоне.
- **trigger:** Запуск сцены книги на чистом прогоне (core.run_make с book и scene).
- **expected:** Стадия story либо явно зависит от стадии построения мира и банка мест, либо не рассчитывает на наличие ещё не созданного файла stage/places.json.
- **actual:** places_p.is_file() вычисляется в False, places остаётся None, и режиссёр мизансцены run_staging запускается с пустым банком мест ({}), кэшируя постановку без учёта объектов сцены; при повторном же запуске (--from story) файл уже существует, вызывая расхождение поведения.
- **evidence:**
places = None
        places_p = ctx.run_dir / "stage" / "places.json"
        if places_p.is_file():
            try:
                places = json.loads(places_p.read_text())
- **status:** fixed (opus) — h0/make/test_bughunt_b14.py; тест охотника был неверен, переписан sonnet

## B15 · CRIT · h0/pipe2/floor.py:328  (охотник h6)

- **claim:** Итоговый отчёт report.json и FloorResult.total_usd теряют сумму расходов на прогрев GPU (h100_s) или учитывают её недетерминированно из-за закрытия warmth в finally после формирования отчёта.
- **trigger:** Запуск Floor.run() с включённым warmth (GpuWarmth, k > 0) при завершении очереди ассетов и сборки сцены быстрее периода тика фонового потока (30 с).
- **expected:** report.json["total_usd"] и FloorResult.total_usd включают стоимость k прогретых H100 GPU за время между warmth.start() и warmth.close(), совпадая с событиями в events.jsonl.
- **actual:** Floor._run считывает ledger.spent и сохраняет report.json до вызова warmth.close() на строке 330; списание стоимости GPU в леджер происходит уже после записи отчёта, а при редком случайном срабатывании фонового tick_loop сумма меняется из-за состояния гонки.
- **evidence:**
finally:
            self.deps["assets"].close()
            warmth = self.deps.get("warmth")
            if warmth is not None:
                warmth.close()
- **status:** fixed (opus) — h0/pipe2/test_bughunt_b15.py

## B16 · CRIT · h0/pipe2/gpu.py:56  (охотник h6)

- **claim:** GpuWarmth.close() при ошибке autoscaler.set не переводит объект в состояние closed и не списывает в леджер стоимость фактически отработанного времени GPU.
- **trigger:** GpuWarmth.start() был выполнен, контейнеры удерживались тёплыми, а последующий вызов autoscaler.set(0, 0, WARM_WINDOW_S) падает с исключением (таймаут, сбой сети или API Modal).
- **expected:** Объект гарантированно помечается закрытым (self._closed = True), и леджер начисляет оплату за фактически отработанное время k * max(0.0, clock - started_at).
- **actual:** Из-за отсутствия блока try...finally выполнение прерывается на строке 56; self._closed остаётся False, а charge('h100_s', ...) не вызывается, приводя к потере учёта расходов.
- **evidence:**
self.autoscaler.set(0, 0, WARM_WINDOW_S)
                self._closed = True
                # B25: k warm H100s bill for every second they are held, busy or not
                charge = getattr(self.ledger, 'charge', None)
                if self._started_at is not None and charge is not None:
- **status:** fixed (opus) — h0/pipe2/test_bughunt_b16.py

## B17 · MAJOR · h0/pipe2/engine.py:188  (охотник h6)

- **claim:** Engine.build и Engine.asset_keys утекают временные каталоги со скопированными изображениями и файлами сцен в /tmp при каждом вызове _stage_scene.
- **trigger:** Любой вызов engine.build(scene, ...) или engine.asset_keys(scene, scene_dir).
- **expected:** Временная папка here, созданная через tempfile.mkdtemp(), гарантированно удаляется после завершения команды dreamer build или keys.ts.
- **actual:** Каталог here создаётся в /tmp и наполняется файлами сцены и референсов, но нигде не удаляется, накапливаясь на диске на протяжении всего прогона вплоть до исчерпания места или inodes.
- **evidence:**
here = Path(tempfile.mkdtemp())
        scene_path = Engine._write_scene(here, scene)
- **status:** fixed (sonnet) — h0/pipe2/test_bughunt_b17.py

## B18 · MAJOR · h0/pipe2/floor.py:417  (охотник h6)

- **claim:** Ожидание готовности очереди всех ассетов этажа обрывается по таймауту одного меша, приводя к падению финальной сборки.
- **trigger:** Сцена с несколькими объектами, генерация которых в очереди суммарно превышает 330 секунд, хотя каждый отдельный меш укладывается в норматив mesh_timeout_s (330 с).
- **expected:** Цикл ожидает опустошения очереди ассетов (assets.idle()), пока каждый отдельный меш не превысил собственный таймаут.
- **actual:** Условие clock() - started >= mesh_timeout_s принудительно прерывает ожидание всей очереди через 330 с, после чего engine.build с флагом --assets cache завершается ошибкой build_failed из-за недостроенных моделей.
- **evidence:**
while not getattr(assets, "idle", lambda: True)():
            if clock() - started >= getattr(assets, "mesh_timeout_s", 330):
                break
            sleep(getattr(assets, "poll_s", 2))
- **status:** fixed (opus) — h0/pipe2/test_bughunt_b18.py; тест охотника был неверен, переписан sonnet

## B19 · CRIT · h0/dream/sim.py:1669  (охотник h7)

- **claim:** При генерации реплики NPC в режиме реального голоса (`fake=False`) метод `_start_line` возвращает `None`, из-за чего `npc_start` возвращает `[None]`, а `_dialogue_turn` падает с `TypeError` при обращении к `ev[0]["type"]`.
- **trigger:** Вызов `_dialogue_turn()` в живом режиме (`fake=False`, `_voice` активен), когда завершилась генерация NPC-реплики при отсутствии активной (`active_line is None`) и следующей (`next_line is None`) реплик.
- **expected:** `_start_line` / `npc_start` возвращают дескриптор события озвучивания либо `_dialogue_turn` проверяет `ev[0] is not None`, не допуская падения цикла симуляции.
- **actual:** `_start_line` возвращает `None` на строке 757, `npc_start` возвращает `[None]`, а строка 1669 пытается прочитать `ev[0]["type"]`, вызывая `TypeError: 'NoneType' object is not subscriptable`.
- **evidence:**
```python
ev = self.npc_start(line)
if ev[0]["type"] == "line_prepared":
    self._prepared_taken = taken
elif ev[0]["type"] == "line_discarded" and taken is not None:
    self._return_taken(taken)
```
- **status:** fixed (opus) — h0/dream/test_bughunt_b19.py

## B20 · MAJOR · h0/dream/sim.py:1933  (охотник h7)

- **claim:** При пробуждении героя (`fsm.awake == True`) симуляция без переданного объекта диалогов (`dialogue is None`) игнорирует пробуждение и зависает в цикле генерации фиктивных реплик вплоть до тайм-аута `max_seconds`.
- **trigger:** Запуск `Sim(dialogue=None)` (конфигурация по умолчанию), в котором FSM переходит в состояние `awake = True` (по вызову `budget_wakeup`, превышению `MAX_ABORTS` или команде `wake_up`).
- **expected:** Основной цикл `run()` немедленно завершает работу с установкой `stop_reason = "awake"`.
- **actual:** Условие `(self.dialogue is not None and self.fsm.awake)` ложно, цикл не прерывается, FSM прекращает тики и консультации, а симулятор вхолостую генерирует строки до исчерпания `max_seconds` и пишет `stop_reason = "timeout"`.
- **evidence:**
```python
if self.stopped or (self.dialogue is not None and self.fsm.awake):
    break
```
- **status:** fixed (opus) — h0/dream/test_bughunt_b20.py

## B21 · MAJOR · h0/dream/fsm.py:383  (охотник h7)

- **claim:** В состоянии FSM `"transition"` решение директора с `abort_build` возвращает вердикт `"abort"`, хотя метод `self.abort` отклоняет отмену как недопустимую для перехода.
- **trigger:** `fsm.finish_consult(now, ticket, {"abort_build": {"reason": "stop"}})` в момент, когда автомат находится в состоянии `"transition"`.
- **expected:** Недопустимая для фазы перехода отмена сборки отклоняется с вердиктом `"invalid"` и не рапортует об успешной отмене.
- **actual:** Поскольку `"transition"` входит в `LOCKED_STATES`, вызывается `self.abort()`, который возвращает ошибку `reason="no_build"` и оставляет автомат в `"transition"`, но `finish_consult` безусловно возвращает вердикт `"abort"`, рапортуя директору об успешной отмене.
- **evidence:**
```python
if abort:
    ev += self.abort(now, abort.get("reason") if isinstance(abort, dict) else abort)
return ev + [self._consult(now, ticket, "abort" if abort else "ok")]
```
- **status:** fixed (sonnet) — h0/dream/test_bughunt_b21.py

## B22 · CRIT · h0/dream/stage_director.py:120  (охотник h7)

- **claim:** Метод `validate_and_merge_staging` падает с `TypeError` при ответе модели, содержащем валидный не-словарный JSON (число, массив или булево значение), из-за отсутствия проверки типа `model_output`.
- **trigger:** `director_fn` возвращает не-словарный JSON (например, `"123"` или `"[{\"beat_id\": 0}]"`), который успешно разбирается `json.loads` и передаётся в `validate_and_merge_staging`.
- **expected:** Не-словарный ответ отсекается как некорректный, фиксируется в `warnings`, и функция безопасно возвращает исходные позиции без падения.
- **actual:** Выражение `"start" in model_output` падает с `TypeError: argument of type 'int' is not iterable` (или `TypeError: list indices must be integers or slices, not str` при списке), аварийно прерывая выполнение.
- **evidence:**
```python
if hand_start is None and model_output and "start" in model_output and isinstance(model_output["start"], list):
    for st in model_output["start"]:
```
- **status:** fixed (sonnet) — h0/dream/test_bughunt_b22.py

## B23 · CRIT · h0/dream/fsm.py:40  (охотник h7)

- **claim:** Функция `check_scene` не проверяет наличие поля `"name"` у объектов актёров, из-за чего недопустимая сцена принимается автоматом и приводит к падению с `KeyError: 'name'` в `sim._apply_transition`.
- **trigger:** Модель директора возвращает блок `next_scene`, в котором у актёра отсутствует поле `"name"` (например, `{"actors": [{"voice": "man"}], "objects": ["o1","o2","o3","o4","o5"]}`).
- **expected:** `check_scene` возвращает ошибку валидации `("next_scene", "bad_type")` и отклоняет запуск сборки.
- **actual:** `check_scene` валидирует только `isinstance(a, dict)` и возвращает `None`, FSM успешно начинает и завершает сборку, а при входе в сцену строка `sim.py:1083` обращается к `a["name"]` и падает с `KeyError`.
- **evidence:**
```python
actors, objects = ns.get("actors"), ns.get("objects")
if not isinstance(actors, list) or not all(isinstance(a, dict) for a in actors) \
        or not _names(objects):
    return "next_scene", "bad_type"
```
- **status:** fixed (sonnet) — h0/dream/test_bughunt_b23.py

## B24 · CRIT · h0/dream/llm.py:364  (охотник h8)

- **claim:** При пустом первом ответе модели повторная попытка с удвоенным лимитом токенов выполняется без проверки лимита расходов, приводя к перерасходу бюджета.
- **trigger:** Вызов llm.call() для платной модели с установленным лимитом set_cap(), когда остаток бюджета меньше стоимости второй попытки, а первая попытка вернула пустую строку.
- **expected:** Перед выполнением повторного дорогостоящего запроса проверяется cap, и при его исчерпании вызов прерывается с ошибкой cap.
- **actual:** Проверка _cap выполняется только один раз до входа в цикл; вторая попытка с limit = max_tokens * 2 + 100 выполняется безусловно и повторно списывает деньги через _charge().
- **evidence:**
for limit in (max_tokens, max_tokens * 2 + 100):
        extra = {}
        if isinstance(transport, RealTransport) and ROLE_TEMPERATURE.get(role) is not None:
            extra["temperature"] = ROLE_TEMPERATURE[role]
        piece = transport.complete(model=model, effort=effort, system=system,
- **status:** fixed (opus) — h0/dream/test_bughunt_b24.py; тест охотника был неверен, переписан sonnet

## B25 · MAJOR · h0/dream/book.py:308  (охотник h8)

- **claim:** При разборе абзаца книги с несколькими цитатами авторская ремарка между репликами ошибочно дублируется в закадровое повествование.
- **trigger:** Параграф книги, содержащий несколько цитат с ремаркой автора между ними длиной от 4 слов, например: '"War!" shouted India, cupping her hand to his ear. "They want to fight the Yankees!"'.
- **expected:** Текст между цитатами сохраняется только в поле "tag" реплики персонажа, а блок narration формируется исключительно из текста после всех цитат.
- **actual:** Цикл for a, b in spans[1:] начинает срез с конца первой цитаты (qe0 + 1), из-за чего авторская ремарка между кавычками попадает в rest и выводится как отдельный бит narration для озвучки диктором.
- **evidence:**
rest, last = [], qe0 + 1
    for a, b in spans[1:]:
        rest.append(p[last:a])
        last = b + 1
    rest.append(p[last:])
- **status:** fixed (sonnet) — h0/dream/test_bughunt_b25.py

## B26 · MAJOR · h0/dream/dialogue.py:875  (охотник h8)

- **claim:** Фоновое сжатие памяти персонажей модифицирует состояние Mind без блокировки _mind_lock, вызывая состояние гонки с основным потоком диалога.
- **trigger:** Работа Dialogue с флагом background=True, когда рабочий поток _fold выполняет m.update(), пока основной поток вызывает _own_view() или memory_text().
- **expected:** Мутация полей памяти (so_far, knows, tried_by) защищена блокировкой self._mind_lock, предотвращая чтение неконсистентных данных.
- **actual:** Метод m.update() изменяет словари и списки памяти без захвата self._mind_lock (блокировка берется только после update для обновления cursor и busy), что приводит к гонке данных при чтении из основного потока.
- **evidence:**
reply = self._call("compress", SCENE_MEMORY_RULES, user)
                ok = m.update(reply, lines=lines, actors=cast_names or (), names=names)
            else:
                reply = self._call("compress", MEMORY_RULES.format(name=name), user)
                ok = m.update(reply)
- **status:** fixed (opus) — h0/dream/test_bughunt_b26.py

## B27 · MAJOR · h0/dream/dub.py:48  (охотник h8)

- **claim:** Создание файла log.jsonl.novoice до завершения озвучки блокирует повторный запуск при сбое, навсегда оставляя сессию недоозвученной.
- **trigger:** Падение процесса dub() (таймаут сети, ошибка TTS API, завершение процесса) во время синтеза реплик и последующий перезапуск команды.
- **expected:** При повторном запуске озвучивание продолжается или перезапускается заново для получения готового лога.
- **actual:** Так как log.jsonl.novoice уже создан до начала цикла генерации, повторный вызов dub() на строке 43 видит существующий файл и мгновенно возвращает (0, 0), оставляя log.jsonl не озвученным.
- **evidence:**
hero, voices, looks, place, pool = cast_of(scene, profile)
    voice = voice or Voice(pool=pool)
    rows = _rows(log)
    shutil.copyfile(log, log + ".novoice")
    n = 0
- **status:** fixed (sonnet) — h0/dream/test_bughunt_b27.py

## B28 · MAJOR · h0/llm_http.py:132  (охотник h9)

- **claim:** Метод `llm_http._once` падает с необработанным `AttributeError` вместо вызова `TransportError`, если в ответе API элемент `choices` или `message` не является словарём.
- **trigger:** Вызов `llm_http.post(...)`, при котором сервер вернул JSON вида `{"choices": ["hello"]}` или `{"choices": [{"message": "hello"}]}`.
- **expected:** Функция отлавливает несоответствие формату схемы и выбрасывает `TransportError(retryable=False)`.
- **actual:** Выражения `first.get("message")` или `(first.get("message") or {}).get("content")` вызывают `AttributeError: 'str' object has no attribute 'get'`, который не перехватывается в `post()` и аварийно завершает вызывающий код.
- **evidence:**
first = choices[0] or {}
    content = (first.get("message") or {}).get("content") or (first.get("delta") or {}).get("content") or ""
    if not isinstance(content, str):
        raise TransportError("content is %s, not str" % type(content).__name__, 200, False)
- **status:** fixed (sonnet) — h0/test_bughunt_b28.py

## B29 · CRIT · h0/live/rt.py:297  (охотник h9)

- **claim:** Обработчик веб-сокета падает и обрывает сессию при получении невалидного JSON или JSON не-словаря в текстовом фрейме.
- **trigger:** Клиент отправляет по открытому WebSocket текстовое сообщение с не-JSON строкой (например, `"ping"`) или JSON не-объектом (например, `"[1, 2]"` или `"null"`).
- **expected:** Некорректный текстовый фрейм безопасно игнорируется или валидируется без закрытия сокета и сброса активной сессии диалога.
- **actual:** `json.loads(msg.data)` бросает `JSONDecodeError`, либо `.get(...)` бросает `AttributeError`; исключение не перехватывается внутри цикла, завершает `ws_handler`, отменяет фоновые задачи (`bg.cancel()`, `s.reply.cancel()`) и принудительно разрывает соединение.
- **evidence:**
elif msg.type == aiohttp.WSMsgType.TEXT:
                    s.progress = json.loads(msg.data).get("progress", s.progress)
- **status:** fixed (sonnet) — h0/live/test_bughunt_b29.py

## B30 · MAJOR · h0/live/server.py:92  (охотник h9)

- **claim:** Эндпоинт `POST /asr` обрывает TCP-соединение мёртвым сокетом при ошибках распознавания или некорректном заголовке длины тела.
- **trigger:** Клиент отправляет запрос `POST /asr` с некорректным значением заголовка `Content-Length: abc` либо с пустым/повреждённым WAV-телом, на которое Meta ASR возвращает ошибку 400.
- **expected:** Сервер возвращает клиенту HTTP-статус 400 или 502 согласно контракту сервиса («a bad body gets an answer, not a dead socket»).
- **actual:** Необработанные `ValueError` (при парсинге длины) или `urllib.error.HTTPError` (из `transcribe()`) приводят к падению потока обработчика без отправки HTTP-ответа и закрытию сокета.
- **evidence:**
if self.path == "/asr":
            self.send_json({"text": transcribe(self.body()), "ms": round((time.time() - t0) * 1000)})
- **status:** fixed (sonnet) — h0/live/test_bughunt_b30.py

## B31 · MAJOR · h0/gate_test.py:76  (охотник h9)

- **claim:** Цикл из трёх попыток в `chat()` фиктивен и прерывается при первой же сетевой или HTTP-ошибке из-за отсутствия блока обработки исключений.
- **trigger:** Временный сбой сети или возврат статуса 429/500/503 от `api.meta.ai` при обращении к `chat()`.
- **expected:** Функция перехватывает ошибку запроса и повторяет попытку до трёх раз.
- **actual:** Вызов `urllib.request.urlopen` не обёрнут в `try...except`, поэтому `urllib.error.HTTPError`/`URLError` немедленно завершает функцию на нулевой попытке, приводя к падению `live/server.py:103`.
- **evidence:**
for attempt in range(3):
        req = urllib.request.Request(API, json.dumps(body).encode(),
                                     {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        t0, first, text = time.time(), None, ""
        with urllib.request.urlopen(req, timeout=120) as r:
- **status:** fixed (sonnet) — h0/test_bughunt_b31.py

## B32 · MAJOR · tools/ptest.py:104  (охотник h9)

- **claim:** Модуль параллельного запуска тестов ложно считает успешно пройденными тесты, завершившиеся с кодом возврата 5.
- **trigger:** Любой тестовый класс `unittest`, завершающий процесс с кодом выхода 5 (например, через `sys.exit(5)`).
- **expected:** `ptest.py` фиксирует ненулевой код возврата как падение (`FAIL`), добавляет имя класса в `failed` и возвращает код выхода 1.
- **actual:** Условие `elif rc and rc != 5:` вычисляется в `False`, результат помечается как `ok`, имя не попадает в `failed`, а `ptest.py` возвращает код 0 (успех).
- **evidence:**
elif rc and rc != 5:  # 5: no tests ran (a module whose tests are all skipped by name)
                failed.append(name)
                print(f"FAIL {name} ({dt:.1f}s)\n{out}", flush=True)
            else:
                print(f"ok   {name} ({dt:.1f}s)", flush=True)
- **status:** fixed (sonnet) — tools/test_bughunt_b32.py

## B33 · MAJOR · h0/world/twelve_oaks/run.py:198  (охотник h9)

- **claim:** Функция `author()` аварийно завершается с `NameError` при исчерпании лимита раундов генерации.
- **trigger:** Вызов `author(rounds=N)`, в котором функция `check()` находит ошибки валидации во всех N раундах.
- **expected:** Функция завершает цикл, выводит сообщение о неудаче валидации после всех раундов и штатно завершает работу.
- **actual:** На строке 198 происходит падение с ошибкой `NameError: name 'tag' is not defined`, так как переменная `tag` не определена в области видимости `author`.
- **evidence:**
msgs.append({"role": "user", "content": "dreamer check found errors. Fix them and return both blocks in full again.\n" + short(rep)})
    print(f"{tag}: still errors after all rounds")
- **status:** parked — research/bughunt-2026-11-02/redtests/test_b33.py (мёртвый мир twelve_oaks, LESSONS L148)

## B34 · CRIT · h0/world/twelve_oaks/run.py:271  (охотник h9)

- **claim:** Сборка ассетов сцены завершается с `FileNotFoundError` из-за неверного пути к директории готовых моделей `READY`.
- **trigger:** Запуск `python3 h0/world/twelve_oaks/run.py assets` для сцены `SCENE.json`, содержащей промпты `"READY oak #v2"`, `"READY rotunda"`, `"READY ironbench"`, `"READY plankbench"`.
- **expected:** Скрипт копирует готовый GLB из директории исходных моделей проекта в кэш.
- **actual:** Переменная `GWTW` указывает на `HERE.parent` (`h0/world`), путь `h0/world/scene/glb/...` не существует в файловой системе, и `shutil.copy` падает с `FileNotFoundError: [Errno 2] No such file or directory`.
- **evidence:**
if prompt.startswith("READY "):
            src = GWTW / "scene" / READY[prompt.split()[1]]
            if not (CACHE / f"{key}.glb").exists():
                shutil.copy(src, CACHE / f"{key}.glb")
- **status:** parked — research/bughunt-2026-11-02/redtests/test_b34.py (мёртвый мир twelve_oaks, LESSONS L148)


## B35 · MAJOR · engine/src/assets/run.ts:197  (охотник h4)

- **claim:** При ошибках чтения reference-изображений (refError) ассеты добавляются в fallback и failed, но не попадают в report.missing, из-за чего проверка dreamer check --built тихо пропускает отсутствующие GLB-модели объектов.
- **trigger:** Сцена содержит проп, ссылающийся на ассет с недопустимым или отсутствующим ref.image (например, ref: { image: "missing.png", what: "chair" }); запуск runAssets(scene, { mode: "cache", ... }) и последующая проверка runCheck(scene, { missingAssets: report.missing }).
- **expected:** Ассет должен включаться в report.missing (missing: [...report.missing, ...bad.map((r) => r.id)]), а runCheck при проверке сборки должен возвращать ошибку ASSET_MISSING.
- **actual:** mergedReport не добавляет bad в missing (missing содержит только report.missing), в build.json поле assets.missing оказывается пустым, и runCheck возвращает ok: true, маскируя отсутствие 3D-модели.
- **evidence:**
```ts
if (bad.length === 0) return report;
return {
  ...report,
  fallback: [...report.fallback, ...bad.map((r) => r.id)],
  failed: [...(report.failed ?? []), ...bad.map(refFailure)],
};
```
- **status:** fixed (sonnet) — engine/test/bughunt/b35.test.ts

## B36 · MAJOR · engine/src/schema/refs.ts:89  (охотник h4)

- **claim:** Функция checkRefs не регистрирует идентификаторы уровней (levels), из-за чего дублирующиеся ID уровней не выявляются валидацией и приводят к тихой перезаписи и искажению высот в движке.
- **trigger:** Сцена с повторяющимся id в массиве levels (например, levels: [{ id: "L0", y: 0 }, { id: "L0", y: 3.5 }]).
- **expected:** Ошибка валидации ID_DUPLICATE на пути /levels/1/id.
- **actual:** Ошибок нет (errors: []), схема валидна; далее lint.ts перезаписывает уровень в ctx.levels.set(), а floor.ts через find() выбирает первый уровень, вызывая тихий рассинхрон геометрии.
- **evidence:**
```ts
(raw.rooms ?? []).forEach((r: any, i: number) => typeof r?.id === "string" && reg(r.id, `/rooms/${i}/id`));
(raw.openings ?? []).forEach((o: any, i: number) => typeof o?.id === "string" && reg(o.id, `/openings/${i}/id`));
(raw.props ?? []).forEach((p: any, i: number) => typeof p?.id === "string" && reg(p.id, `/props/${i}/id`));
(raw.cameras ?? []).forEach((c: any, i: number) => typeof c?.id === "string" && reg(c.id, `/cameras/${i}/id`));
(raw.routes ?? []).forEach((r: any, i: number) => typeof r?.id === "string" && reg(r.id, `/routes/${i}/id`));
```
- **status:** fixed (sonnet) — engine/test/bughunt/b36.test.ts

## B37 · MAJOR · engine/src/assets/sky.ts:115  (охотник h4)

- **claim:** В inpaintSky координата обрезки left вычисляется как нецелое число для 2:1 панорам с нечётной высотой, что приводит к 2-байтовому сдвигу индексов и повреждению цветовых каналов и прозрачности.
- **trigger:** Вызов inpaintSky с 2:1 панорамой, у которой высота h нечётная (например, 10×5 или 1002×501).
- **expected:** Смещение left должно быть целым числом пикселей (Math.floor(w / 2 - h / 2)), сохраняя 4-байтовое выравнивание RGBA-каналов.
- **actual:** left имеет дробную часть .5 (например, 2.5), байтовый индекс s = (y * w + left + x) * 4 сдвигается на 2 байта (s % 4 === 2), из-за чего каналы Red и Blue меняются местами, а альфа-канал прозрачности перезаписывается значениями зелёного канала.
- **evidence:**
```ts
const { width: w, height: h } = src;
const rolled = roll(src, w / 2);
const left = w / 2 - h / 2;
const gap = Math.max(2, Math.round(w * GAP));
const feather = Math.max(1, Math.round(w * FEATHER));
```
- **status:** fixed (sonnet) — engine/test/bughunt/b37.test.ts; тест охотника был неверен, переписан sonnet

## B38 · MINOR · engine/src/build/fixtures.ts:164  (охотник h3, sonnet)

- **claim:** Нормали боковых граней fixture берутся как правый перпендикуляр направления from→to, поэтому при обратном порядке from/to нормали смотрят внутрь тела.
- **trigger:** Комната outline [[0,-0.01],[4,-0.01],[4,3],[0,3]], один fixture kind:"counter", material:"m". Вариант A: from [0,0], to [4,0]. Вариант B: from [4,0], to [0,0].
- **expected:** Нормаль задней грани (z=0) равна [0,0,-1] в обоих вариантах.
- **actual:** A даёт [0,0,-1], B даёт [0,0,1] (внутрь тела); остальные боковые грани в B инвертированы так же, освещение сторон перевёрнуто.
- **evidence:**
```ts
const d = norm2([b[0] - a[0], b[1] - a[1]]);
const n: V3 = [d[1], 0, -d[0]];
```
- **status:** fixed (opus) — engine/test/bughunt/b38.test.ts


# Заход 2 — дифф коммита 637c21a (5 охотников agy gemini-3.8-flash-high)

Все записи — непроверенные утверждения. Статус проставлен после красных тестов (red / rejected).

## B39 · CRIT · h0/dream/sim.py:1689  (охотник g1)

- **claim:** Взаимная блокировка (deadlock) между `_cycle_line` и `_dialogue_turn` при наличии подготовленной реплики NPC (`prepared_npc`) и запланированного повествования (`_narrate`): симуляция намертво зависает в цикле `run()` до таймаута `max_seconds`.
- **trigger:** В `Sim` с активным `dialogue` находится подготовленная реплика `sim.prepared_npc = "Hi"` (заготовленная через `npc_start` во время звучания предыдущей реплики). В этот момент в очередь `sim._narrate` попадает событие (например, через строку 485 от мирового события без персонажей в сцене или строку 1128 при переходе сцены).
- **expected:** На очередном тике `_dialogue_turn` запускает генерацию закадрового голоса (`self._start_narration`), освобождает очередь `_narrate`, после чего `_cycle_line` воспроизводит `prepared_npc` (аналогично тому, как в B43 было разрешено для `next_line`: `not self._narrate`).
- **actual:** `_dialogue_turn` на строке 1689 видит `self.prepared_npc is not None` и делает ранний `return`, никогда не доходя до `_start_narration` на строке 1700. Одновременно `_cycle_line` на строке 1457 видит `self._narrate` и делает ранний `return`, отказываясь запускать `prepared_npc`. Симуляция бесконечно крутится в холостом цикле вплоть до истечения `max_seconds` со статусом `timeout`.
- **evidence:**
```python
        # sim.py:1457 in _cycle_line:
        if self._narrate or self._narrating:
            # F1: the narrator speaks before the first line -- a queued line
            # (human or prepared NPC) waits for the pending/in-flight narration
            return

        # sim.py:1689 in _dialogue_turn:
        # B43: a queued line waits for pending narration (_cycle_line), so the
        # narration must still be allowed to start here or both wait forever
        if (busy or self.prepared_npc is not None
                or (self.next_line is not None and not self._narrate)):
            return

        # sim.py:1700 in _dialogue_turn:
        if self._narrate:
            self._start_narration(self._narrate.pop(0))
            return
```
- **status:** fixed (opus) — h0/dream/test_bughunt_b39.py; `_dialogue_turn` пускает закадр при любой очередной реплике (next_line или prepared_npc), не только при next_line

## B40 · MAJOR · h0/dream/fsm.py:354  (охотник g1)

- **claim:** Метод `rearm_consult` не восстанавливает флаг `force_pending` при сбросе форсированной консультации директора (`hint == "force"`), навсегда теряя признак готовности перехода и приводя к зависанию стройки.
- **trigger:** По истечении `idle >= self.p["force"]` автомат взводит `force_fired = force_active = force_pending = True`. В `begin_consult` сбрасывается `self.force_pending = False` и формируется билет с `hint="force"`. Во время консультации происходит прерывание (пауза безопасности `safety_pause`, ошибка транспорта LLM или stale), вызывающее `director._requeue(ticket, queued)` -> `fsm.rearm_consult(ticket)`.
- **expected:** `rearm_consult(ticket)` восстанавливает `self.force_pending = True` (по аналогии с `nudge_pending` и `ready_stale_fired`), чтобы метод `due(now)` продолжал возвращать `"force"` для повторной попытки форсированной консультации.
- **actual:** `rearm_consult` обрабатывает только `ready_stale` и `nudge`, полностью игнорируя `hint == "force"`. Флаг `self.force_pending` остаётся `False`. Метод `fsm.due(now)` на строке 310 проверяет `if self.force_pending: return "force"`, но поскольку флаг сброшен, а `self.force_fired` уже `True` (строка 273 не сработает повторно), `due(now)` больше никогда не возвращает `"force"`. В режиме `_free_story` при наличии неразыгранных кусков книги (`idle_ok = False`, строка 1920) консультации могут инициироваться только через `due(now)`; в результате `_maybe_consult` больше никогда не вызывает директора, и симуляция зависает в состоянии ожидания перехода.
- **evidence:**
```python
    def rearm_consult(self, ticket):
        """Undo the one-shot flags begin_consult spent when its reply was dropped."""
        hint = ticket.get("hint")
        if hint == "ready_stale" and self.state == "ready" and ticket["epoch"] == self.build_epoch:
            self.ready_stale_fired = False
        elif hint == "nudge" and ticket["epoch"] == self.build_epoch:
            self.nudge_pending = True
            self.nudge_delivered = ticket["nudged_before"]
```
- **status:** fixed (opus) — h0/dream/test_bughunt_b40.py; `rearm_consult` возвращает `force_pending` для сброшенной force-консультации

## B41 · MAJOR · h0/dream/fsm.py:424  (охотник g1)

- **claim:** При включённом режиме одиночного мира (`no_build=True`) метод `finish_consult` возвращает вердикт `"build"`, несмотря на то, что автомат отклонил старт стройки событием `invalid`, приводя к рассинхронизации памяти директора и автомата.
- **trigger:** `BuildFSM(..., no_build=True)` (используется для сценариев без перехода между мирами, например в `make/play.py`), и директор присылает решение начать стройку: `{"bridge": "door", "destination": "garden", "next_scene": {...}}`.
- **expected:** Автомат отклоняет запуск стройки и возвращает вердикт консультации `"invalid"`, чтобы директор не считал стройку начавшейся (по аналогии с недопустимым `abort` в B21).
- **actual:** Метод `self.start_build()` возвращает событие ошибки `{"type": "invalid", "fields": ["start_build"], "reason": "no_build"}` и оставляет автомат в `"idle"`. Однако строка 424 безусловно возвращает событие консультации с `verdict="build"`. Директор (`director.py:362`) видит `verdict == "build"` и вызывает `self.memory.record_decision(decision)` и `self.memory.set_bridge("door")`, считая, что стройка активна, тогда как FSM остался в покое.
- **evidence:**
```python
        self.fail_streak = 0
        ev += self.start_build(now, bridge, decision.get("destination"),
                               decision.get("next_scene"), decision.get("hero_next"))
        return ev + [self._consult(now, ticket, "build")]
```
- **status:** fixed (opus) — h0/dream/test_bughunt_b41.py; отказ `start_build` (no_build) даёт вердикт `invalid`, pending_wakeup сохраняется

## B42 · MAJOR · h0/dream/fsm.py:412  (охотник g1)

- **claim:** В состоянии FSM `"idle"` решение директора с `abort_build` возвращает вердикт `"ok"`, хотя попытка отмены стройки отклоняется как невалидная (`reason="no_build"`), маскируя ошибку директора от системы повторов.
- **trigger:** Вызов `fsm.finish_consult(now, ticket, {"abort_build": {"reason": "stop"}})` в момент, когда автомат находится в состоянии `"idle"` и `ticket["label"] != "forced"`.
- **expected:** Недопустимая для фазы покоя отмена сборки отклоняется с вердиктом `"invalid"` (по аналогии с фиксом коммита 637c21a для фазы `transition`: `verdict = "invalid" if ab[0]["type"] == "invalid" else "abort"`).
- **actual:** Строка 406 логирует невалидность отмены `ev.append(self._e(now, "invalid", fields=["abort_build"], reason="no_build"))`. Однако далее строка 407 проверяет `bridge = decision.get("bridge")` (None), и строка 412 безусловно возвращает `verdict = "ok"`, рапортуя директору об успешном применении некорректного решения и блокируя возврат входных событий через `_requeue`.
- **evidence:**
```python
        if abort:
            ev.append(self._e(now, "invalid", fields=["abort_build"], reason="no_build"))
        bridge = decision.get("bridge")
        if bridge is None:
            if ticket["label"] == "forced":
                self.pending_wakeup = pending  # invalid reply: the next ticket carries it again
                return ev + self._bad(now, ticket, ["bridge"], "null_bridge")
            return ev + [self._consult(now, ticket, "ok")]
```
- **status:** fixed (opus) — h0/dream/test_bughunt_b42.py; abort в idle без bridge — вердикт `invalid`

## B43 · MAJOR · h0/dream/sim.py:1077  (охотник g1)

- **claim:** Метод `_apply_transition` не сбрасывает счётчик серии реплик актёров `_actor_streak` и метки активности (`_spoke_last`, `_silent_ticks`), из-за чего актёры новой сцены оказываются заблокированы от вступления в диалог с первого же тика.
- **trigger:** В предыдущей сцене актёры произнесли 2 реплики подряд (`self._actor_streak == 2 >= ACTOR_STREAK_MAX`), после чего совершается переход в новую сцену (`_touch` -> `_apply_transition`) в режиме с живым игроком (`hero_owner == "human"`).
- **expected:** Переход в новую сцену сбрасывает счётчики активности персонажей старой сцены (`_actor_streak = 0`, `_spoke_last = None`, `_silent_ticks = {}`), как это сделано в соседнем коде смены сцены `_book_scene_end` (строки 1282-1287).
- **actual:** `_apply_transition` оставляет `_actor_streak = 2`. На первом же тике новой сцены метод `_pick_speaker` (строка 1575) вычисляет `blocked = self._actor_streak >= ACTOR_STREAK_MAX` (True). Так как `human = True`, строка 1591 отбрасывает всех актёров новой сцены (`if blocked and (human or ...): continue`), возвращая `(None, None)` («тишина»). Актёры новой сцены принудительно заблокированы и не могут заговорить первыми, пока человек не подаст реплику.
- **evidence:**
```python
        # sim.py:1077 in _apply_transition:
        self.transcript = self.transcript[-2:]
        self._notes = {}
        self._notes_seen = {}
        self._notes_shown = {}
        self._hero_world = ["you have just arrived in %s" % self.place]
        # missing: self._actor_streak = 0, self._spoke_last = None, self._silent_ticks = {}
        # compare with sim.py:1282 in _book_scene_end:
        # self._spoke_last = None
        # self._silent_ticks = {}
        # self._addressed = {}
        # self._event_hits = {}
        # self._actor_streak = 0
```
- **status:** fixed (opus) — h0/dream/test_bughunt_b43.py; общий `Sim._new_scene_turns()` для `_apply_transition` и `_book_scene_end`: streak, spoke_last, silent/addressed/event_hits

## B44 · CRIT · h0/dream/sim.py:1067  (охотник g1)

- **claim:** `_apply_transition` не очищает `prepared_npc` и метаданные заготовленной реплики от предыдущей сцены, из-за чего реплика выбывшего актёра озвучивается и воспроизводится в новой сцене.
- **trigger:** До перехода в новую сцену была подготовлена реплика NPC (`sim.prepared_npc = "Wait here!"`, `_prepared_meta = {"who": "Squidward"}`). Происходит переход в сцену с новым составом персонажей (`["Sandy"]`).
- **expected:** `_apply_transition` очищает заготовленные реплики предыдущей сцены (`prepared_npc = None`), предотвращая утечку реплик между сценами.
- **actual:** `prepared_npc` сохраняется. При первом же тике новой сцены `_cycle_line` (строка 1465) берёт `self.prepared_npc` и запускает воспроизведение реплики Сквидварда в новой сцене, где Сквидварда нет в касте и нет его голоса в `_actor_voices`, ломая ракурс камеры и воспроизводя чужую реплику.
- **evidence:**
```python
    def _apply_transition(self):
        self.n_transitions += 1
        ns = self.fsm.next_scene
        self.hero_next = self.fsm.hero_next
        self.place = self.fsm.destination or "scene %d" % self.n_transitions
        ...
        self.transcript = self.transcript[-2:]
        self._notes = {}
        self._notes_seen = {}
        self._notes_shown = {}
        # self.prepared_npc, self._prepared_meta, self._prepared_taken not cleared
```
- **status:** fixed (opus) — h0/dream/test_bughunt_b44.py; тот же `_new_scene_turns()` сбрасывает prepared_npc старого состава (событие line_discarded reason=scene)

## B45 · CRIT · h0/dream/llm.py:366  (охотник g2)

- **claim:** Проверка лимита расходов перед повторной попыткой (`_price(model, ...)`) проверяет начальную модель роли `model`, а не фактически использованную платную модель из первой попытки (`used` / `SPARK_MODEL`). Для ролей с бесплатной первичной моделью (`SPARK_OPEN_MODEL`) стоимость ретрая оценивается в $0.0, из-за чего повторный запрос на платной модели обходит проверку `cap` и приводит к перерасходу бюджета (регрессия фикса B24).
- **trigger:** Вызов `llm.call("hero", ...)` с установленным `set_cap(6.0)`, когда первичный вызов к Baseten (`SPARK_OPEN_MODEL`) завершился ошибкой и сработал fallback на платную модель Meta (`SPARK_MODEL`), списав $5.0 и вернув пустой ответ `""`, при этом остаток бюджета ($1.0) меньше стоимости повторной попытки ($5.0).
- **expected:** Повторный запрос пропускается, так как стоимость ретрая на платной модели ($5.0) превышает остаток бюджета ($1.0), а в `diagnostics` регистрируется ошибка исчерпания капы.
- **actual:** `_price(model, est_prompt, limit)` вызывается с `model = SPARK_OPEN_MODEL`, возвращая 0.0. Условие `get_spent() + 0.0 > _cap[0]` ложно, выполнение цикла продолжается, запускается повторная попытка, снова срабатывает fallback на `SPARK_MODEL`, списывая еще $5.0 (всего потрачено $10.0 при лимите $6.0).
- **evidence:**
```python
    for limit in (max_tokens, max_tokens * 2 + 100):
        # the retry is optional: skip it when its worst case would cross the cap
        if attempts and _cap[0] is not None and \
                get_spent() + _price(model, est_prompt, limit) > _cap[0] + 1e-9:
            diagnostics.append({"type": "cap", "component": "llm", "role": role, "model": model,
                                "error": "cap $%.2f: empty reply, paid retry skipped" % _cap[0]})
            break
```
- **status:** fixed (opus) — h0/dream/test_bughunt_b45.py; ретрай оценивается по самой дорогой модели из роли и ответивших попыток. Тест охотника был неверен (1.17M токенов при max_tokens=50, ни одна оценка по лимиту его не пропустит), переписан на честные числа

## B46 · MAJOR · h0/dream/dub.py:45  (охотник g2)

- **claim:** При штатной ошибке синтеза речи (`voice.synthesize` вернул `ok=False`) `dub` модифицирует строки лога добавлением поля `"dur"` без `"audio"`, из-за чего перезаписанный `log.jsonl` перестает быть побайтово идентичным `log.jsonl.novoice`. При повторном запуске проверка `filecmp.cmp` считает лог успешно озвученным и немедленно возвращает `(0, 0)`, навсегда блокируя озвучку сессии (недочинённый случай B27).
- **trigger:** Вызов `dub.dub(run, scene)` в условиях временной недоступности TTS API (все повторные попытки в `Voice.synthesize` исчерпаны, возвращен fallback `{"ok": False, "audio": None, "pause": ...}`), с последующим повторным вызовом `dub.dub(run, scene)` после восстановления связи с TTS.
- **expected:** Первый вызов не считает сессию озвученной, а второй вызов обнаруживает отсутствие `"audio"` в строках и успешно синтезирует недостающие файлы.
- **actual:** Первый вызов инкрементирует `n` на каждой строке и записывает `r["dur"] = res["pause"]` в `log.jsonl`. Второй вызов видит существующий `log.jsonl.novoice` и несовпадение файлов по содержимому (`not filecmp.cmp(...) == True`), принимает сессию за уже озвученную и возвращает `(0, 0)`, навсегда оставляя сессию без единого аудиофайла.
- **evidence:**
```python
    log = os.path.join(run, "log.jsonl")
    # the backup is made before voicing: a log still equal to it was never rewritten (a crash)
    if os.path.exists(log + ".novoice") and not filecmp.cmp(log, log + ".novoice", shallow=False):
        return 0, 0
...
        n += 1
        path = os.path.join(run, "audio", "line_%03d.wav" % n)
        res = voice.synthesize(r["text"], label, path)
        r["dur"] = res["pause"]
        if res["ok"]:
            r["audio"] = os.path.relpath(res["audio"], run)
```
- **status:** fixed (sonnet) — h0/dream/test_bughunt_b46.py; `dub` пропускает только полностью озвученный лог, иначе переозвучивает с `.novoice` (повтор заново генерирует и картинки)

## B47 · MAJOR · h0/llm_http.py:94  (охотник g2)

- **claim:** Парсер потоковых ответов `_parse` в `llm_http` не проверяет типы элементов `choices` и `delta`, из-за чего при нестандартном формате SSE-ответа возникают необработанные `AttributeError` и `TypeError`, не перехватываемые блоком `except (ValueError, UnicodeDecodeError)` и аварийно завершающие работу клиента в обход `TransportError` (недочинённый случай B28 для SSE).
- **trigger:** Вызов `llm_http.post(...)`, при котором сервер прислал SSE-стрим с нетипичным форматом choices или delta, например `b'data: {"choices": ["hello"]}\n\n'`, `b'data: {"choices": [{"delta": "hello"}]}'` или `b'data: {"choices": [{"delta": {"content": 123}}]}\n\n'`.
- **expected:** Функция распознает нарушение схемы ответа и выбрасывает `TransportError(retryable=False)`.
- **actual:** `_parse` вызывает `ch.get("delta")` или `out += content`, порождая `AttributeError: 'str' object has no attribute 'get'` либо `TypeError: can only concatenate str (not "int") to str`. В `_once` блок `except (ValueError, UnicodeDecodeError)` пропускает эти исключения наружу.
- **evidence:**
```python
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            data = json.loads(line[5:])
            usage = data.get("usage") or usage
            for ch in data.get("choices", []):
                out += (ch.get("delta") or {}).get("content") or ""
```
и обработчик в `_once`:
```python
    try:
        data = _parse(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise TransportError("bad json: %s" % type(exc).__name__, None, False) from None
```
- **status:** fixed (sonnet) — h0/test_bughunt_b47.py; `_once` ловит AttributeError/TypeError парсера как TransportError("bad json"); все 3 варианта нагрузки покрыты

## B48 · MAJOR · h0/dream/dialogue.py:976  (охотник g2)

- **claim:** В `Dialogue.hero_line` проверка правил реплики (`repeats`, `uses_bit`, `hush`) находится внутри условия `break`. Если на второй попытке модель выдает реплику, нарушающую эти правила, цикл завершается естественным путем, но код после цикла выполняет только проверку `if not text: return None` и возвращает запрещенную реплику.
- **trigger:** Вызов `Dialogue.hero_line`, когда обе попытки генерации вернули повторяющуюся реплику из недавнего контекста либо вопрос при активном режиме `hush` (когда герой уже задал подряд `QUESTION_RUN` вопросов).
- **expected:** При неудаче обеих попыток метод отклоняет реплику и возвращает `None`.
- **actual:** На первой попытке реплика не проходит проверку, `break` не выполняется, формируется подсказка; на второй попытке проверка `not repeats and not uses_bit and not (hush and "?")` снова не выполняется, `break` не срабатывает, цикл `range(2)` завершается. Переменная `text` содержит строку из второй попытки, поэтому проверка `if not text:` не срабатывает, и метод возвращает запрещенную/повторяющуюся реплику в сцену.
- **evidence:**
```python
        text = None
        for attempt in range(2):
            raw = self._call("hero", self.hero_system(), user, who=self.hero)
            cand = _clean_spoken(raw, "hero", self.hero)
            in_role = cand.startswith("[")
            text, why = lock_line(cand, objects, names) if cand and in_role else (None, None)
            if text and not repeats(text, recent) and not uses_bit(
                    text, own) and not (hush and "?" in text):
                break
            if why:
                self._reject(self.hero, why, cand)
                user += lock_hint(why, cand)
                continue
            user += ("\n(No question this time.)" if in_role and hush and "?" in cand else
                     "\n(Say or do something new.)" if in_role else
                     "\n(Stay %s: one spoken line of yours, starting with [direction].)" % self.hero)
        if not text:
            return None
```
- **status:** rejected (opus) — тот же контракт «один ретрай», что у `actor_line` (там повтор на второй попытке принимается явно, `attempt == 0`; комментарий 1.2c): после ретрая реплика идёт, иначе тишина. Менять — решение продукта; тест удалён

## B49 · CRIT · h0/pipe2/floor.py:94  (охотник g3)

- **claim:** Функция `_edge_center` падает с необработанным `AttributeError: 'int' object has no attribute 'get'`, если модель-архитектор вернула вершины контура комнаты с 3 координатами (например, 3D `[x, z, y]`), аварийно обрывая валидацию скелета `skeleton_defects` до проверки движком.
- **trigger:** Вызов `skeleton_defects(skeleton, plan)` со скелетом, где контур комнаты содержит 3D-координаты `[[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]]`, и задан проём с привязкой к ребру `{"id": "o1", "on": {"room": "r1", "edge": 0, "t": 0.5}}`.
- **expected:** Согласно контракту `_edge_center` (*«None when the spec or the edge geometry is malformed (the engine reports that instead)»*), функция возвращает `None` при некорректном формате ребра, позволяя `skeleton_defects` завершить обход и передать геометрию на штатную валидацию движком.
- **actual:** Выражение `shape[edge][2].get("bulge", 0)` безусловно считает 3-й элемент словарем; для `[0, 0, 0]` третий элемент равен `0` (`int`), вызов `.get()` выбрасывает `AttributeError`, который не перехватывается в `_edge_center`, `_opening_rooms` и `skeleton_defects`, приводя к падению цикла `_architect`.
- **evidence:**
```python
    length = math.hypot(bx - ax, bz - az)
    if length <= 0:
        return (ax, az)
    bulge = shape[edge][2].get("bulge", 0) if len(shape[edge]) > 2 else 0
    if not isinstance(bulge, (int, float)) or not math.isfinite(bulge):
        return None
```
- **status:** fixed (sonnet) — h0/pipe2/test_bughunt_b49.py; `_edge_center`: не-словарь в вершине — None (дефект ребра)

## B50 · CRIT · h0/pipe2/floor.py:513  (охотник g3)

- **claim:** Метод `Floor._finish` перехватывает сбой деактивации тёплых GPU (`_close_warmth`) и сохраняет ошибку в `result.final_errors`, но не обновляет `result.status` в `"failed"`, из-за чего процесс `pipe2` завершается с кодом 0 (успех), скрывая утечку запущенных облачных H100.
- **trigger:** Успешное завершение сборки сцены (`final_errors` изначально пуст, `FloorResult.status == "done"` на строке 475), при котором последующий вызов `_close_warmth()` выбрасывает исключение (таймаут или сетевой сбой API Modal при попытке `autoscaler.set(0, 0, WARM_WINDOW_S)`).
- **expected:** При ошибке закрытия ресурсов статус `result.status` переключается в `"failed"`, а CLI `pipe2` возвращает код выхода 1, сигнализируя о критическом сбое освобождения GPU.
- **actual:** `_finish` добавляет `{"kind": "warmth_close_failed", "error": ...}` в `result.final_errors`, но оставляет `result.status == "done"`. Код выхода `__main__.py` равен 0, вызывающий пайплайн считает прогон успешным, а контейнеры GPU остаются прогретыми в облаке и продолжают тарифицироваться.
- **evidence:**
```python
    def _finish(self, result: FloorResult) -> FloorResult:
        # the warm GPUs bill at close: close them first, then read the money totals
        try:
            self._close_warmth()
        except Exception as exc:
            result.final_errors.append({"kind": "warmth_close_failed", "error": str(exc)})
        for key, value in self._report_fields().items():
            setattr(result, key, value)
        self._write_report(result)
        return result
```
- **status:** fixed (sonnet) — h0/pipe2/test_bughunt_b50.py; ошибка закрытия warmth переводит этаж в `failed`

## B51 · MAJOR · h0/make/story.py:114  (охотник g3)

- **claim:** Стадия `run_story` передаёт постановщику кэш-директорию `cache_dir = ctx.run_dir / "story"`, которая на чистом прогоне создаётся как обычный каталог и затем удаляется публикацией `core._publish`, полностью уничтожая кэш постановок и приводя к повторным платным вызовам Spark при перезапусках.
- **trigger:** Чистый запуск сцены книги (`core.run_make` с параметрами `book` и `scene`, `fake=False`).
- **expected:** Результаты работы постановщика (`stage_<hash>.json`) сохраняются внутри `ctx.out`, переносясь публикацией в `.pub/story-<ts>`, чтобы повторный запуск сцены (например, `make --from story`) повторно использовал кэш мизансцены без вызова LLM.
- **actual:** `run_staging` создаёт директорию `run_dir / "story"` и записывает туда `stage_<hash>.json`. При завершении стадии `_publish` на строках 384–388 в `core.py` обнаруживает `run_dir / "story"` как каталог без симлинка (`final.exists() and not final.is_symlink()`), перемещает его в `story.old`, заменяет симлинком на опубликованный `ctx.out` и удаляет `story.old` через `shutil.rmtree`, безвозвратно уничтожая закэшированный ответ. Повторный запуск вынужден повторно выполнять платный вызов Spark к директору.
- **evidence:**
```python
        score = _book.score_scene(b["dir"], b["scene"], places=places, director=director,
                                  cache_dir=ctx.run_dir / "story")
```
в связке с `h0/make/core.py:384`:
```python
    if final.exists() and not final.is_symlink():  # старая папка без ссылки
        legacy = run_dir / f"{sid}.old"
        os.replace(final, legacy)
        os.replace(link, final)
        shutil.rmtree(legacy, ignore_errors=True)
```
- **status:** fixed (sonnet+opus) — h0/make/test_bughunt_b51.py; кэш постановки пишется в ctx.out и публикуется со story, прошлые stage_*.json копируются (как tone-*); fake-прогон кэш не пишет. Тест переведён на живой путь с подменённым директором

## B52 · MAJOR · h0/make/stage.py:258  (охотник g3)

- **claim:** Дедупликация имён дверей в `build_places` проверяет только места с `q["kind"] == "door"`, порождая коллизии идентичных имён мест в комнате, если в ней расположен проп с базовым именем `door`.
- **trigger:** Построение банка мест для мира, где в комнате `living` находится проп с базовым именем `door` (например, `id="living_door"`, получивший имя `"living door"` при наличии второго пропа `door` в сцене), а также дверной проём со `swing: "living"`.
- **expected:** Дверной проём получает уникальное имя (например, `"living door 2"`), исключающее совпадение с уже существующими местами в комнате.
- **actual:** Подсчёт `taken = sum(1 for q in places if q["kind"] == "door" and q["room"] == room)` игнорирует проп (у которого `kind: "stand"`), возвращает `0` и присваивает двери имя `"living door"`. В итоговом `places.json` появляются два места с одинаковым именем `"living door"`, из-за чего рантайм `places.find(...)` и `stage_director` разрешают дверь в декоративный проп.
- **evidence:**
```python
        # two doors on one room: ` 2`, ` 3` like _name_places
        n = f"{room} door"
        taken = sum(1 for q in places if q["kind"] == "door" and q["room"] == room)
        places.append({"name": n if not taken else f"{n} {taken + 1}", "id": d["id"], "kind": "door", "room": room, "level": lv,
                       "at": at, "yaw": round(yaw, 3), "look": c, "obstacle": None,
                       "poses": ["door"]})
```
Поиск багов в указанной зоне по заданной линзе завершён, все 4 дефекта подтверждены воспроизводимыми кейсами. Готов ответить на вопросы или перейти к подготовке тестов/исправлений, когда будет снят read-only режим.
- **status:** fixed (sonnet) — h0/make/test_bughunt_b52.py; имя двери — первое свободное `<room> door`, `<room> door 2`…

## B53 · CRIT · engine/src/runtime/stage/touch.ts:83  (охотник g4)

- **claim:** Навигация к объекту с неопределённым углом поворота (`place.yaw === undefined`) через `resolveTouch` и `createToucher.touch` передаёт `undefined` в качестве угла доворота (`finishYaw`) в `actor.go()`. При остановке на месте `actor.update()` вычисляет разность углов `wrap(finish.yaw - cur)` как `NaN`, угол поворота актёра необратимо становится `NaN`, признак завершения движения `finish` никогда не сбрасывается, и актёр навсегда зависает в состоянии `moving() === true`.
- **trigger:** Место в `places.json` не содержит угла `yaw` (например, `{ name: "chair", kind: "sit", room: "r", level: "L0", at: [1, 0], yaw: undefined, poses: ["sit"] }`), и вызывается `toucher.touch("Bob", "chair", "sit")` (или без позы `toucher.touch("Bob", "chair")`).
- **expected:** Движок валидирует угол места и применяет безопасный дефолт (0 или угол по ходу движения `"along"`), актёр завершает перемещение с конечным углом `yaw` и переходит в `moving() === false`.
- **actual:** `r.yaw` возвращается как `undefined`, `actors.ts:275` вычисляет `wrap(undefined - cur) = NaN`, `a.yaw()` становится `NaN`, условие `Math.abs(dy) < 1` ложно для `NaN`, `finish` никогда не сбрасывается в `null`, и `a.moving()` навсегда остаётся `true`.
- **evidence:**
```ts
// engine/src/runtime/stage/places.ts:84
      const yaw = pose === "lie" && place.lie ? place.lie.yaw : place.yaw;
      return { place, target: spot?.at ?? place.at, yaw, act: pose === "sit" ? "sit" : "idle", pose, claim: free };
// engine/src/runtime/stage/touch.ts:82-83
    const fin = finishYaw === "along" ? along() : finishYaw;
    a.go(route.path, fin !== undefined ? fin : r.yaw, r.act, route.ys);
// engine/src/runtime/stage/actors.ts:274-278
      if (!path.length && finish) {
        const dy = wrap(finish.yaw - cur);
        cur += Math.max(-360 * dt, Math.min(360 * dt, dy));
```
- **status:** fixed (opus) — engine/test/bughunt2/b53.test.ts; toucher падает на «along»/текущий yaw, `actor.go` не принимает нечисловой yaw (инвариант)

## B54 · MAJOR · engine/src/runtime/cams.ts:71  (охотник g4)

- **claim:** В режиме камеры `top=1` при отсутствии или неопределённости координаты высоты точки спавна `geo.spawn.y` вертикальная позиция камеры Y и элементы матрицы вида `camera.matrixWorld` заполняются значениями `NaN`.
- **trigger:** Вызов `pickCamera({ spawn: { at: [0, 0] }, meshes: [] }, new URLSearchParams("top=1"), 1.6)` (по схеме сцены поле `spawn.y` опционально).
- **expected:** Координата Y камеры вычисляется с безопасным значением по умолчанию `0 + 100 = 100` (как сделано в `main.ts:243`: `geo.spawn.y ?? 0`), а матрица `camera.matrixWorld` содержит только конечные числа.
- **actual:** Выражение `geo.spawn.y + 100` даёт `NaN`, `camera.position.y` становится `NaN`, а последующий вызов `camera.lookAt(cx, geo.spawn.y, cz)` заполняет матрицу `camera.matrixWorld` значениями `NaN`.
- **evidence:**
```ts
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    camera.position.set(cx, geo.spawn.y + 100, cz);
    camera.up.set(0, 0, -1);
    camera.lookAt(cx, geo.spawn.y, cz);
    camera.updateMatrixWorld();
```
- **status:** rejected — призрак: geo.spawn.y всегда задан, geometry.ts:296/309

## B55 · MAJOR · engine/src/runtime/stage/index.ts:777  (охотник g4)

- **claim:** При формировании списка актёров комнаты `here` для режиссёра камеры список фильтруется из общего массива всех актёров `dActors(list)` вместо сценических `dActors(onstageList)`, из-за чего внесценический персонаж (`offstage: true`) попадает в `here`, и реплика вышедшего персонажа наводит камеру на внесценического актёра.
- **trigger:** Персонаж покинул сцену (`offstageActors.has("Mama") === true`) в той же комнате, где находится сценический актёр ("Bob"), после чего поступает реплика `handlers.line({ who: "Mama", text: "Я ушла!" })`.
- **expected:** Список `here` отфильтровывает внесценических персонажей (`!offstageActors.has(...)`), а режиссёр `director.step` наводит камеру на сценического актёра (Bob), показывая его реакцию.
- **actual:** Строка 777 включает внесценическую "Mama" в `here`, `director.step` выбирает её как `named` говорящего (`all.find(a => a.name === ev.speaker)`) и направляет камеру на координаты внесценического актёра.
- **evidence:**
```ts
      // only the actors of the speaker's room and level are in the frame
      const here = dActors(list).filter((d) => d.room === f.room && d.level === lvl);
      if (!here.length) {
        if (!queued.length) return;
        continue;
      }
      // the speaker leads (a narrator line: the first actor by name), so the director's room is the one under `focus`
      if (ev.kind !== "line") ev.speaker = undefined;
      const out = director.step({
        event: ev,
        actors: here,
```
- **status:** rejected — призрак: director.ts:164 фильтрует offstage-актёров

## B56 · MAJOR · engine/src/runtime/stage/index.ts:421  (охотник g4)

- **claim:** Обработчик действия `action === "stay"` в `stage()` не вызывает функцию `cancelExit(who)`, из-за чего команда остаться на месте во время выполняющегося выхода не сбрасывает состояние выхода (`exiting`, `exitThrough`), и остановившийся актёр принудительно выбрасывается со сцены.
- **trigger:** Актёр начинает выход через `handlers.stage({ who: "Bob", action: "exit" })`, но затем получает команду остаться `handlers.stage({ who: "Bob", action: "stay" })` и останавливается.
- **expected:** Действие `stay` отменяет начавшийся выход (`cancelExit("Bob")`), актёр остаётся на сцене (`offstage: false`).
- **actual:** Ветка `action === "stay"` выполняет ранний `return` без вызова `cancelExit(who)`. В очередном `update()` цикл по `exiting` видит остановившегося актёра (`!act?.moving()`), берёт дверь из `exitThrough` и через `act.go([door.at, beyond])` переводит актёра в `offstage: true`.
- **evidence:**
```ts
      if (action === "stay") {
        return;
      }
```
- **status:** fixed (opus) — engine/test/bughunt2/b56.test.ts; явный `stay` у выходящего актёра отменяет выход и останавливает его

## B57 · CRIT · engine/src/runtime/stage/index.ts:175  (охотник g4)

- **claim:** При инициализации высоты спавна актёров выражение `layerOf(sp?.level ?? null).layer.y` падает с необработанным `TypeError` при пустом массиве `layers: []`, либо вычисляет высоту Y как `NaN` при отсутствии у слоя свойства `y` (`layer.y === undefined`).
- **trigger:** Вызов `startStage` с пустым массивом слоёв `layers: []` либо со слоем без высоты `layers: [{ layer: { level: null }, bits: ... }]`.
- **expected:** Безопасное чтение высоты с дефолтом `layerOf(...)?.layer?.y ?? 0` (аналогично строкам 391, 465, 645, 712, 775 движка).
- **actual:** При `layers: []` функция `layerOf` возвращает `undefined` и строка 175 падает с `TypeError: Cannot read properties of undefined (reading 'layer')`. При `layer.y === undefined` вычисляется `undefined + 0 = NaN`, актёр создаётся с высотой `y: NaN`, из-за чего `toucher.levelOf` навсегда возвращает `null`, и все команды `touch` бессрочно застревают в очереди `queued`.
- **evidence:**
```ts
  const layerOf = (level: string | null) => c.layers.find((l) => l.layer.level === level) ?? c.layers[0];
// ...
  const a = await createActor(who, url, Number(cast[who].height_m ?? 1.7), at, layerOf(sp?.level ?? null).layer.y + (spot?.y ?? 0), spot?.yaw ?? sp?.yaw ?? 0, clipUrls, cast[who].idle, clipfacts?.[who] ?? null);
```
- **status:** rejected — призрак: main.ts:242 подставляет пустой слой при layers=[]

## B58 · MAJOR · tools/gate.sh:46  (охотник g5)

- **claim:** При аварийном завершении подоболочки любого из тестовых наборов (`dream`, `make`, `py`, `engine`) до записи статуса выхода файл `*.rc` не создаётся, из-за чего `tools/gate.sh` тихо пропускает упавший набор и завершается с кодом 0 (ложный зелёный гейт).
- **trigger:** Подоболочка одного из наборов тестов убита сигналом (например, OOM-killer при нехватке памяти или сбой процесса до `echo $? >"$logs/dream.rc"`), в результате чего файл `$logs/dream.rc` отсутствует на диске.
- **expected:** Скрипт `gate.sh` проверяет наличие ожидаемых результатов всех запущенных наборов, при отсутствии отчёта фиксирует падение (`rc=1`) и выводит ошибку о незавершённом прогоне.
- **actual:** Условие `[ -f "$logs/$s.rc" ] || continue` молча пропускает набор в обоих проходах (`green` и `red`), блок с ошибкой не выполняется, переменная `rc` остаётся равной `0`, и гейт рапортует об успешном прохождении проверки.
- **evidence:**
```sh
rc=0
for pass in green red; do
  for s in dream make py engine; do
    [ -f "$logs/$s.rc" ] || continue
    c=$(cat "$logs/$s.rc")
    if [ "$c" = 0 ]; then [ $pass = green ] || continue; else [ $pass = red ] || continue; rc=1; fi
    echo "== $s (exit $c)"
    cat "$logs/$s"
  done
done
exit $rc
```
- **status:** fixed (sonnet) — tools/test_bughunt_b58.py; отсутствующий `.rc` в gate.sh — красный «suite did not finish»

## B59 · MAJOR · tools/ptest.py:104  (охотник g5)

- **claim:** Регрессия и неполный фикс бага B32 в коммите `637c21a`: модуль параллельного запуска тестов считает успешно пройденным тестовый модуль (`ok`), в котором `unittest` зафиксировал код возврата 5 («NO TESTS RAN»), пропуская невыполненные тесты с кодом выхода 0.
- **trigger:** Передача в `tools/ptest.py` любого тестового модуля, в котором не было выполнено ни одного теста (например, пустой тестовый файл, закомментированные тесты, опечатка в имени класса или использование функций `def test_*` без наследования от `unittest.TestCase`).
- **expected:** Ненулевой код возврата 5 от `unittest` (введённый в Python для сигнализации о пустом прогоне в CI) фиксируется как падение (`FAIL`), имя модуля добавляется в `failed`, а `ptest.py` завершается с кодом 1.
- **actual:** Проверка `not (rc == 5 and "NO TESTS RAN" in out)` вычисляется в `False`, условие `elif` не срабатывает, модуль попадает в ветку `else`, печатает `ok <name>`, не добавляется в `failed`, и `ptest.py` возвращает код 0 (ложный зелёный гейт).
- **evidence:**
```python
            elif rc and not (rc == 5 and "NO TESTS RAN" in out):  # 5 is ok only when unittest says no tests ran (all skipped by name)
                failed.append(name)
                print(f"FAIL {name} ({dt:.1f}s)\n{out}", flush=True)
            else:
                print(f"ok   {name} ({dt:.1f}s)", flush=True)
```
- **status:** rejected — строка 104 уже требует «NO TESTS RAN» в выводе, фикс B32 корректен

## B60 · MAJOR · h0/live/server.py:114  (охотник g5)

- **claim:** Соседний код с тем же классом дефекта, что и исправленный в коммите `637c21a` баг B30: вызов `chat()` в эндпоинте `POST /turn` не защищён обработкой исключений, обрывает соединение мёртвым сокетом при сетевых ошибках Meta AI API и необратимо повреждает сессионную историю `history`.
- **trigger:** Клиент отправляет валидный запрос `POST /turn`, но апстрим `api.meta.ai` возвращает ошибку (HTTP 401/403/429/500/502) или происходит сбой сети/таймаут после исчерпания попыток в `chat()`.
- **expected:** По аналогии с обработчиком `/asr`, сервер отлавливает ошибку апстрима (`(OSError, ValueError)`), возвращает клиенту HTTP-статус 502 (`{"error": "turn failed: ..."}`) и откатывает добавленное в `history` сообщение пользователя.
- **actual:** Исключение `urllib.error.HTTPError`/`URLError` не перехватывается, рабочий поток падает, соединение закрывается без отправки HTTP-ответа (dead socket / connection reset). При этом строка `history.append({"role": "user", ...})` уже выполнена, а реплика ассистента не добавлена, что навсегда ломает чередование реплик в истории живой сессии.
- **evidence:**
```python
            with lock:  # one turn at a time: history is one live session
                history.append({"role": "user", "content": user})
                line, ttft, _ = chat(SQUIDWARD_LOAD, history)
                history.append({"role": "assistant", "content": line})
                spoken = line.replace(OPEN, "").strip()
                tid = uuid.uuid4().hex[:8]
                lines[tid] = spoken
            self.send_json({"line": spoken, "opened": OPEN in line, "tts": f"/tts/{tid}",
                            "ttft": round((ttft or 0) * 1000), "ms": round((time.time() - t0) * 1000)})
```
- **status:** fixed (sonnet) — h0/live/test_bughunt_b60.py; /turn: сбой chat() — 502 и откат history

## B61 · MAJOR · h0/gate_test.py:83  (охотник g5)

- **claim:** Регрессия и недочинённый случай B31 в коммите `637c21a`: парсинг SSE-стрима в `chat()` падает с необработанным `JSONDecodeError` на пустых строках `data:`, а обрывы стрима посреди чтения (`RemoteDisconnected`, `TimeoutError`) не перехватываются блоком `except (HTTPError, URLError)` и прерывают цикл без повтора попыток.
- **trigger:** Сервер `api.meta.ai` отправляет пустой SSE-фрейм вида `data:\n` (keep-alive) либо сбрасывает TCP-соединение во время итерации по телу ответа `for raw in r:`.
- **expected:** Парсер безопасно пропускает пустые/невалидные фрагменты SSE, а таймауты и разрывы соединения сокета перехватываются и вызывают повторную попытку запроса (до 3 раз).
- **actual:** `line.startswith("data:")` истинно для `data:`, срез `line[5:]` даёт пустую строку, и `json.loads("")` падает с `json.decoder.JSONDecodeError`. Ошибки разрыва соединения стрима (`http.client.RemoteDisconnected`, `socket.timeout`, `TimeoutError`) не являются подклассами `urllib.error.URLError`, поэтому исключение не ловится блоком `except` и аварийно завершает вызов на первой же попытке.
- **evidence:**
```python
                    line = raw.decode().strip()
                    if not line.startswith("data:") or line == "data: [DONE]":
                        continue
                    for ch in json.loads(line[5:]).get("choices", []):
                        piece = (ch.get("delta") or {}).get("content")
                        if piece:
                            first = first or time.time() - t0
                            text += piece
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
```
- **status:** fixed (sonnet) — h0/test_bughunt_b61.py; `gate_test.chat` пропускает пустой data:-кадр, обрыв потока (OSError/HTTPException) повторяется

## B62 · MAJOR · h0/live/rt.py:234  (охотник g5)

- **claim:** Состояние гонки при параллельном распознавании аудио-чанков приводит к инверсии порядка слов и повреждению промежуточного текста `type="partial"`.
- **trigger:** Пользователь произносит фразу, нарезанную VAD на два последовательных чанка (задачи `task1` и `task2` в `self.chunks`), при этом HTTP-запрос второго чанка завершается раньше первого из-за сетевых задержек.
- **expected:** Промежуточные события `partial` отправляют транскрипт строго в исходном хронологическом порядке речи пользователя.
- **actual:** Когда `task2` завершается первым, `task1` ещё не завершён (`done` пуст). Затем завершается `task1`: в списке `self.chunks` задача `task2` уже имеет статус `done`, поэтому `[_text(c) for c in self.chunks if c.done()]` возвращает `[text2]`, а выражение `done + [text]` склеивает `[text2, text1]`, отправляя клиенту фразу с переставленными задом наперёд частями предложения.
- **evidence:**
```python
    async def transcribe(self, pcm):
        t = time.time()
        text = await meta_asr(self.s.http, pcm)
        if text:  # show what is heard so far: finished chunks of this turn plus this one
            done = [_text(c) for c in self.chunks if c.done()]
            await self.s.send(type="partial", text=join(done + [text]))
        return text, round((time.time() - t) * 1000), len(pcm) / 32000
```
- **status:** fixed (sonnet) — h0/live/test_bughunt_b62.py; partial собирается в порядке `self.chunks`; тесту добавлены офлайн-заглушки gate_test/load_test

# Заход 3 — широкий (8 охотников agy gemini-3.8-flash-high; k3 build/ ответил NONE)

Все записи — непроверенные утверждения. Статус проставлен после красных тестов (red / rejected). Дубль shotplan.ts:229 (k1 и k2) склеен.

## B63 · MAJOR · engine/src/runtime/stage/index.ts:567  (охотник k1)

- **claim:** Обработчик события `narrator` при обнаружении ремарки перемещения не вызывает `cancelExit(hit.who)`, из-за чего прервавший выход персонаж после прихода к новому месту принудительно выбрасывается со сцены старой дверью выхода.
- **trigger:** Персонаж начинает выход через `handlers.stage({ who: "Mama", action: "exit" })` (попадая в `exiting` и `exitThrough`), но до двери поступает событие `handlers.narrator({ text: "Mama went to the chair." })` (где `"chair"` — место из банка мест), и персонаж доходит до стула.
- **expected:** Перемещение по ремарке отменяет выполняющийся выход (`cancelExit("Mama")`), и персонаж остаётся у стула на сцене (`offstage: false`).
- **actual:** `cancelExit` не вызывается (в отличие от действий `come`, `goto`, `turn_away`, `enter`, `line` и `touch`), запись двери остаётся в `exitThrough`; при остановке актёра у стула цикл `exiting` в строках 756–770 находит старую дверь, принудительно вызывает `act.go([door.at, beyond])` и переводит персонажа в `offstage: true`.
- **evidence:**
```ts
      if (!hadStage) {
        const hit = remark(String(e.text ?? ""));
        if (hit) touch(hit.who, hit.place);
      }
```

- **status:** fixed (opus) — engine/test/bughunt3/b63.test.ts; любой приказ движения идёт через локальный `touch`, который отменяет выход. Тест охотника был неверен: stage+narrator подряд — один бит, и мизансцена бита по дизайну бьёт ремарку; ремарка перенесена в следующий бит

## B64 · MAJOR · engine/src/runtime/stage/index.ts:472  (охотник k1)

- **claim:** При обработке `action === "enter"` с целевым местом, не являющимся дверью, условие телепортации к двери комнаты требует `Number.isFinite(via.yaw)`, из-за чего при отсутствии явного `yaw` у двери персонаж не ставится в проём двери и входит в сцену прямо из своего внесценического положения без предупреждения.
- **trigger:** В комнате с дверью без явно заданного угла (`door.yaw === undefined`, допустимо схемой) для персонажа вне сцены вызывается `handlers.stage({ who: "Mama", action: "enter", place: "bed" })`.
- **expected:** Движок использует безопасный дефолтный угол двери (0, как сделано в строке 484 для прямых дверей), телепортирует актёра в проём двери комнаты `via` и ведёт его от двери к кровати.
- **actual:** Проверка `typeof via.yaw === "number" && Number.isFinite(via.yaw)` оказывается ложной, вызов `a.teleport` пропускается, ветка `else if (!via)` также не срабатывает (так как дверь существует), персонаж удаляется из `offstageActors` на своей исходной позиции за сценой (например, у полки) и идёт к кровати оттуда без каких-либо предупреждений.
- **evidence:**
```ts
          const via = places.find((p) => isDoor(p) && p.room === target.room) ?? null;
          if (via && typeof via.yaw === "number" && Number.isFinite(via.yaw)) {
            const s = interRoomDoorStep(via.at, via.yaw, 1.0);
            a.teleport(s.doorPos, s.yaw, "idle", layerOf(via.level ?? null).layer.y ?? 0);
          } else if (!via) warnings.push(`stage: enter "${target.name}" is not a door and room "${target.room ?? "?"}" has none -> walks from where she is`);
```

- **status:** fixed (opus) — engine/test/bughunt3/b64.test.ts; дверь комнаты без yaw — вход по yaw 0 с предупреждением (как B04)

## B65 · MAJOR · engine/src/runtime/stage/shotplan.ts:229  (охотник k1)

- **claim:** Функция `shotFrame` вычисляет результирующий FOV через тернарную проверку `f0 === null ? null : ...`, из-за чего в кадре с неуказанным начальным `from.fov` явно заданный конечный `end.fov` полностью игнорируется и угол обзора камеры никогда не меняется.
- **trigger:** Кадр плана съёмки с переходом FOV без явного `from.fov`: `{ name: "zoom", at: 0, to: 2, from: { pos: [0, 1, 2], look: [0, 1, 0] }, end: { pos: [0, 1, 2], look: [0, 1, 0], fov: 30 } }`.
- **expected:** `shotFrame` вычисляет интерполированный или конечный угол обзора `fov: 30`, и `applyShot` обновляет `c.camera.fov`.
- **actual:** `f0` вычисляется как `null`, строка 229 возвращает `fov: null`, игнорируя `f1 = 30`, и `applyShot` в строке 669 `index.ts` пропускает обновление проекции камеры.
- **evidence:**
```ts
  const f0 = s.from.fov ?? null;
  const f1 = end.fov ?? f0;
  return {
    name: s.name,
    pos: [p[0] + sh[0], p[1] + sh[1], p[2] + sh[2]],
    look: mix(lookAt(s.from.look), lookAt(end.look)),
    fov: f0 === null ? null : f0 + ((f1 ?? f0) - f0) * e,
    cut: s.cut,
  };
```

- **status:** fixed (sonnet+opus) — engine/test/bughunt3/b65.test.ts; без `from.fov` зум идёт от fov камеры до плана (`shotFrame(..., baseFov)`), без него — конечный fov

## B66 · MAJOR · engine/src/runtime/stage/touch.ts:91  (охотник k1)

- **claim:** Очередь отложенных навигаций `pending` в `createToucher` не имеет механизма очистки при внешней смене позиции персонажа, из-за чего отложенный на рампе вызов `touch` сохраняется и немедленно исполняется в `tick()`, срывая актёра с нового места.
- **trigger:** Персонаж находится на рампе (`levelOf(who) === null`), вызывается `toucher.touch(who, "kitchen")` (возвращает `"queued"`). Затем до схода с рампы поступает `handlers.start({ who, place: "bed", pose: "sit" })`, телепортирующий актёра на кровать на уровне L0.
- **expected:** Новое позиционирование/инициализация персонажа через `start` отменяет отложенное движение; персонаж остаётся сидеть на кровати.
- **actual:** В следующем кадре `toucher.tick()` видит, что персонаж теперь на уровне (`levelOf(who) !== null`), достаёт устаревший запрос из `pending` и вызывает `touch(who, "kitchen")`, заставляя персонажа встать с кровати и пойти на кухню.
- **evidence:**
```ts
  const tick = (): TouchResult[] => {
    const out: TouchResult[] = [];
    for (const [who, q] of [...pending]) if (levelOf(who) !== null) out.push(touch(who, q.name, q.pose, q.finishYaw));
    return out;
  };
```

- **status:** fixed (opus) — engine/test/bughunt3/b66.test.ts; `cancelExit` снимает и отложенный на рампе touch (`toucher.cancel`)

## B67 · MAJOR · engine/src/runtime/stage/shotplan.ts:161  (охотник k1)

- **claim:** Расчёт времени старта `at: "prev"` жестко берет окончание предыдущего по индексу кадра `plan.shots[k - 1].to`, не проверяя, был ли этот предыдущий кадр отброшен (`skipped`), из-за чего кадр привязывается к времени невалидного кадра вместо последнего сыгранного.
- **trigger:** План съёмки содержит последовательность кадров: кадр 0 (`at: 0, to: 2`), кадр 1 (`at: 2, to: 1` — отбрасывается при валидации через `staticallyEmpty` с занесением в `skipped`), кадр 2 (`at: "prev", to: 5`).
- **expected:** Кадр 2 отсчитывает `"prev"` от последнего действительного кадра (кадр 0, завершившийся в `t0 + 2`).
- **actual:** Строка 161 вызывает `timeOf(plan.shots[0].to, 0)` на отброшенном кадре 1, получая время `t0 + 1`, из-за чего кадр 2 начинает показ в `t0 + 1` (раньше, чем фактически завершился кадр 0).
- **evidence:**
```ts
  const timeOf = (t: ShotTime, k: number): number | null => {
    if (t.k === "num") return t0 === null ? null : t0 + t.x;
    if (t.k === "prev") return k === 0 ? t0 : timeOf(plan.shots[k - 1].to, k - 1);
    if (t.k === "end") return endAt === null ? null : endAt + t.off;
```

- **status:** fixed (sonnet) — engine/test/bughunt3/b67.test.ts; `prev` отсчитывается от последнего неотброшенного кадра

## B68 · MAJOR · engine/src/runtime/stage/pose.ts:19  (охотник k2)

- **claim:** Функция `sideOf(n)` ошибочно классифицирует кости ног, чьи базовые имена начинаются на `"l"` и имеют суффикс правой стороны (например, `lowerleg_r`, `lowerleg.r`, `leg_r`, `lower_leg_r`), как левые (`"L"`), из-за чего `findLegs()` удаляет правое колено как дубликат стороны.
- **trigger:** Скелет с именами костей голеней `lowerleg_l` и `lowerleg_r` (или `leg_l` и `leg_r`) при вызове `findLegs(root)`, `sitLegs(root)` или `legHeights(root)`.
- **expected:** `sideOf` возвращает `"L"` для `lowerleg_l` и `"R"` для `lowerleg_r`; `findLegs` находит оба колена, `sitLegs` сгибает оба колена на 85°, а `legHeights` усредняет длины обеих голеней.
- **actual:** Проверка `/^l/.test(n)` срабатывает на очищенных именах `lowerlegr` и `legr` раньше, чем проверка суффикса `/r$/`, возвращая сторону `"L"` для обеих костей. В `findLegs` правое колено удаляется из-за совпадения ключа стороны (`c.pri < b.pri` ложно). В результате `sitLegs` сгибает только левое колено персонажа, оставляя правую ногу торчащей прямо вперёд в позе сидения, а `legHeights` замеряет только левую голень.
- **evidence:**
```typescript
const sideOf = (n: string): string => {
  if (n.includes("left")) return "L";
  if (n.includes("right")) return "R";
  if (/^l/.test(n) || /l$/.test(n)) return "L";
  if (/^r/.test(n) || /r$/.test(n)) return "R";
  return "mid";
};
```

- **status:** fixed (sonnet) — engine/test/bughunt3/b68.test.ts; сторона берётся только рядом со словом конечности (lowerleg_r, thigh.L, L_Knee, LeftLeg)

## B69 · MAJOR · engine/src/runtime/stage/actors.ts:255  (охотник k2)

- **claim:** Метод `teleport()` не сбрасывает запланированное завершение движения `finish = null`, из-за чего телепортированный во время ходьбы актёр продолжает считаться движущимся (`moving() === true`), на следующем тике отворачивается от точки телепортации к старому `finish.yaw` и меняет позу на старый `finish.act`.
- **trigger:** Вызов `a.teleport(at, newYaw, newAct)` в момент, когда актёр шёл или поворачивался после вызова `a.go(...)` (`finish !== null`).
- **expected:** `teleport` мгновенно прерывает любое активное перемещение и доворот (`finish = null`), фиксируя заданные координаты, угол `newYaw` и позу `newAct`, переводя `moving()` в `false`.
- **actual:** `teleport` сбрасывает только массив точек пути `path = []`, сохраняя `finish`. Метод `moving()` продолжает возвращать `true`, а на следующем тике `update()` условие `!path.length && finish` начинает поворачивать актёра к старому `finish.yaw`, после чего принудительно восстанавливает старое действие `act = finish.act` (например, усаживает вставшего персонажа в воздух) и старую высоту сиденья `finish.seat`.
- **evidence:**
```typescript
    teleport(at: V2, newYaw: number, newAct: "idle" | "sit" = "idle", newY?: number, st?: number) {
      x = at[0];
      z = at[1];
      cur = newYaw;
      act = newAct;
      sitOn(st);
      if (newY !== undefined) {
        y = newY;
        segY = newY;
      }
      path = [];
      apply(clock, false);
    },
```

- **status:** rejected — actors.ts teleport уже сбрасывает `path = []; finish = null` (строки 256–258)

## B70 · MAJOR · engine/src/runtime/stage/clipfacts.ts:180  (охотник k2)

- **claim:** `writeClipfacts` перед расчётом фактов запускает `createAnimator` с активацией позы покоя (`idle`), из-за чего верхние кости рук выходят из Т-позы, и последующий вызов `prepareClip` внутри `clipFacts` считывает в `bind` согнутые руки вместо bind pose, ломая отрезание калибровочной Т-позы клипов.
- **trigger:** Вызов `writeClipfacts(castDir)` для персонажа с анимацией покоя `idle`, в которой руки опущены вдоль тела, и клипами, начинающимися с калибровочной Т-позы (0..0.5 с).
- **expected:** `prepareClip` замеряет исходную Т-позу скелета (bind pose), определяет границу выхода из Т-позы (`calibrationEnd`) и отрезает калибровочную фазу клипа (`cutHead`), чтобы замеры параметров клипа отражали полезную анимацию.
- **actual:** `createAnimator` в строке 180 переводит скелет в `idle`, поворачивая плечи на ~70°. Затем `clipFacts` -> `prepareClip` считывает `bind` с уже повернутых костей. В кадре 0 клипа руки в Т-позе отклоняются от опущенного `bind` на >30°, функция `calibrationEnd` считает кадр 0 выходом из Т-позы и возвращает 0. Калибровочная Т-поза не отрезается, и в кадре `s = 0` замеряются параметры калибровочной Т-позы вместо начала действия.
- **evidence:**
```typescript
    // as createActor: the animator puts the idle frame on first, then the body is fitted (feet on y = 0)
    const body = gltf.scene as Object3D;
    createAnimator(body, clips, { idle: c.idle, seed: who, life: false });
    const { holder } = prepareActorBody(body, heightM);
    const facts: Record<string, unknown> = {};
    for (const [name, clip] of Object.entries(clips)) {
      const f = clipFacts(holder, clip, heightM);
```

- **status:** fixed (opus) — engine/test/bughunt3/b70.test.ts; bind-поза рук запоминается на кости при первом `prepareClip` (`userData.bindQuat`, массив — переживает clone)

## B71 · CRIT · engine/src/budget.ts:34  (охотник k4)

- **claim:** Функция `budgetIssues` обращается к свойству `tris.by_prop[String(p?.id)]` без проверки наличия объекта `by_prop`, что приводит к падению с необработанным `TypeError` при отсутствии опционального поля `by_prop` в переданных данных о треугольниках.
- **trigger:** Вызов `runCheck(scene, { tris: { total: 0 } as any })` или запуск проверки сцены с `build.json`, в котором поле `tris` содержит только `total` без `by_prop`.
- **expected:** Безопасное обращение вида `tris.by_prop?.[String(p?.id)]` (аналогично проверкам `tris.unreadable ?? []` и `scene.props ?? []`), не приводящее к фатальной ошибке.
- **actual:** Падение процесса с `TypeError: Cannot read properties of undefined (reading '<prop_id>')`.
- **evidence:**
```ts
  ((scene.props ?? []) as any[]).forEach((p, i) => {
    const n = tris.by_prop[String(p?.id)];
    if (typeof n !== "number" || !p?.size) return;
    const limit = TRI_LIMITS[propClass(p.size)];
```

- **status:** rejected — внутри движка `by_prop` обязателен (budget.ts:19, build/write.ts:145); граница усилена (opus): `check --built` берёт `tris` из build.json с диска только с объектом `by_prop` (bin/dreamer.ts)

## B72 · MAJOR · engine/bin/dreamer.ts:106  (охотник k4)

- **claim:** Обработчик подкоманды `clipfacts` вызывает `writeClipfacts(args[1])` без предварительной проверки существования директории и без блока перехвата ошибок, из-за чего при указании несуществующего пути процесс завершается с необработанным исключением Node.js (`ENOENT`) и кодом 1 вместо стандартного сообщения в `console.error` и кода завершения 2.
- **trigger:** Запуск `dreamer clipfacts non_existent_cast_dir`.
- **expected:** Проверка существования пути (или перехват `ENOENT`) с выводом понятной ошибки в `console.error` и возвратом кода выхода 2, как во всех остальных командах CLI `dreamer`.
- **actual:** Необработанное исключение `Error: ENOENT: no such file or directory, open 'non_existent_cast_dir/cast.json'` с полным стектрейсом и кодом выхода 1.
- **evidence:**
```ts
  if (args[0] === "clipfacts" && args[1]) {
    // G4: <cast dir>/clipfacts.json: contact_y / face_dir / head_y / lying of every clip of every actor
    // (static import: this tsx's vendored ESM parser fails on a dynamic import() in this file)
    for (const w of await writeClipfacts(args[1])) console.warn(w);
    console.log(`clipfacts: ${join(args[1], "clipfacts.json")}`);
```

- **status:** fixed (opus) — engine/test/bughunt3/b72.test.ts; `clipfacts` без cast.json — сообщение и код 2. Баг был реален, отклонение «нет теста» снято: тест через spawnSync, как b06

## B73 · MAJOR · engine/src/runtime/main.ts:175  (охотник k4)

- **claim:** При асинхронной замене placeholder-меша на загруженную GLB-модель в группу `root` не копируется свойство `userData.kind`, а исходный меш с `userData.kind = src.kind` удаляется из сцены, из-за чего объект в сцене теряет метку типа пропа.
- **trigger:** Загрузка любой сцены с 3D-моделями пропов (`src.glb`).
- **expected:** Назначение `root.userData.kind = mesh.userData.kind` (или `src.kind`) перед добавлением модели в `scene`, чтобы загруженный проп сохранял идентификацию в Three.js сцене.
- **actual:** `root.userData.kind` остаётся `undefined`, исходный меш удаляется через `scene.remove(mesh)`, и объект перестаёт распознаваться как проп при обходах дерева сцены.
- **evidence:**
```ts
        loadGlb(src, { min: mesh.geometry.boundingBox!.min, max: mesh.geometry.boundingBox!.max }).then((root) => {
          root.name = mesh.name;
          root.visible = mesh.visible;
          // the sun traverse below runs before the GLB lands: flag the real
          // meshes on swap, or they never cast/receive shadows (F4)
          if (sunShadows) root.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
          markNoblock(root, mesh.name);
          scene.remove(mesh);
          scene.add(root);
          objects.set(mesh.name, root);
```

- **status:** rejected — потребителей `userData.kind` у GLB-пропа нет (cutMeshes ищет только wall/band/cap/reveal/ceiling); инвариант всё же сохранён одной строкой в main.ts (opus)

## B74 · MAJOR · engine/src/schema/refs.ts:289  (охотник k4)

- **claim:** Функция `checkRefs` не проверяет циклы и самореференс в свойстве `around.center`, из-за чего пропы с замкнутой ссылкой на центр успешно проходят валидацию схемы, но не могут быть размещены в `placeProps` и затем игнорируются в `lintProps`, бесследно исчезая из сцены без сообщений об ошибке.
- **trigger:** Валидная сцена с пропом, у которого `around: { center: "<свой_же_id>", n: 4, r: 1.5 }` (или взаимный цикл между двумя пропами `A.around.center = "B"`, `B.around.center = "A"`).
- **expected:** Ошибка схемы `REF_UNKNOWN` или `POS_INVALID` на пути `/props/0/around/center` о невозможности циклической ссылки.
- **actual:** Валидация возвращает `{ ok: true, errors: [] }`, но проп не может вычислить центр в `placeProps`, не попадает в геометрию сцены, а `lintProps` пропускает его (`if (raw.around) return;`), приводя к тихой потере объекта.
- **evidence:**
```ts
    if (p.around && typeof p.around.center === "string" && !propById.has(p.around.center)) {
      ref(`/props/${i}/around/center`, "prop", p.around.center, new Set(propIds));
    }
```

- **status:** fixed (sonnet) — engine/test/bughunt3/b74.test.ts; цикл/самоссылка `around.center` — REF_UNKNOWN; промежуточный assert теста поправлен (после ошибки схемы `ctx.props` нет)

## B75 · CRIT · h0/make/story.py:67  (охотник k5)

- **claim:** Вызов `ctx.spend(ledger.spent)` при каждом обращении к `director` квадратично накручивает учёт расходов стадии `story`, суммируя уже учтённые траты и преждевременно исчерпывая лимит бюджета `max_dollars`.
- **trigger:** Запуск `run_make(..., fake=False)`, где для сцены вызывается как режиссура расстановки (`_book.score_scene`), так и генерация тонов реплик (`_tone.add_tones`, добавленная в коммите `3248a3c`).
- **expected:** В `ctx.spend` должна передаваться стоимость только текущего обращения к LLM либо разовый итог трат шага, чтобы `ctx.usd` в манифесте `make.json` совпадал с реальной стоимостью вызовов `ledger.spent`.
- **actual:** Метод `ctx.spend(usd)` прибавляет переданное число к `self.usd += float(usd)`. Так как `ledger.spent` кумулятивен, первый вызов добавляет $C_1$, а второй вызов добавляет $C_1 + C_2$, раздувая `ctx.usd` до $2C_1 + C_2$ (и более при любых повторах), что преждевременно валит последующие шаги по лимиту `man.spent() >= max_dollars` с ошибкой `budget`.
- **evidence:**
```python
        ans = spark.ask("story", "stage", 0, msgs, "medium")
        ctx.spend(ledger.spent)
        return json.dumps(ans.scene, ensure_ascii=False) if ans.valid and isinstance(ans.scene, dict) else ""
```

- **status:** fixed (sonnet) — h0/make/test_bughunt_b75.py; `ctx.spend` получает прирост `ledger.spent`

## B76 · MAJOR · h0/make/stage.py:117  (охотник k5)

- **claim:** Функция `_pick_surface` проверяет позу `"sit"` раньше `"stand_on"`, из-за чего для ступеней и табуретов (`poses = ["stand_on", "sit"]`) ветка `stand_on` оказывается недостижимым мёртвым кодом, а вместо верхней рабочей площадки тихо выбирается нижняя широкая ступенька.
- **trigger:** Объект типа `step` или `stool` высотой $\le 0.6$ м (например, двухступенчатый табурет) с открытыми поверхностями: нижняя ступенька площадью 0.2 м² на высоте 0.2 м и верхняя площадка площадью 0.12 м² на высоте 0.4 м.
- **expected:** По спецификации `film-eyes-a` (раздел Г3) для объектов с позой `stand_on` должна выбираться самая высокая поверхность (`max(c, key=lambda s: s["y"])`), то есть площадка на высоте 0.4 м.
- **actual:** Порядок итерации `("lie", "sit", "stand_on")` первым берёт `"sit"`, отбирает обе поверхности (`area >= 0.1, y < 1.2`) и немедленно возвращает `max(c, key=lambda s: s["area"])` — нижнюю ступеньку. В результате `pl["top"]` ошибочно выставляется в 0.2 м вместо 0.4 м, а блок `if pose == "stand_on"` на строке 128 никогда не выполняется.
- **evidence:**
```python
    for pose in ("lie", "sit", "stand_on"):
        if pose not in poses:
            continue
...
        if pose == "stand_on":
            return max(c, key=lambda s: s["y"])
        return max(c, key=lambda s: s["area"])
```

- **status:** fixed (sonnet) — h0/make/test_bughunt_b76.py; при позе `stand_on` берётся самая высокая поверхность

## B77 · MAJOR · h0/make/play.py:115  (охотник k5)

- **claim:** При запуске воспроизведения сцены из книги в английском режиме отсутствие файла `story/score.json` тихо замалчивается и подменяется нережиссированной партитурой вместо падения с ошибкой контракта.
- **trigger:** Запуск `python3 -m make.play runs/<id>` для книги на английском языке (`lang="en"`, по умолчанию), если стадия `story` не сгенерировала `story/score.json` либо файл был повреждён или удалён.
- **expected:** Завершение с исключением `FileNotFoundError`, как это явно сделано для русского режима строками 109–112 (`if not score_p.is_file(): raise FileNotFoundError(...)`).
- **actual:** Проверка `score_p.is_file()` даёт `False`, `score` становится `None`, и `sim._load_book_plan` тихо запускает генерацию сырого плана из текста книги (`bookmod.score_scene` без `places` и `director`), полностью обходя подготовленные режиссером мизансцены.
- **evidence:**
```python
        else:
            score_p = run_dir / "story" / "score.json"
        score = json.loads(score_p.read_text()) if score_p.is_file() else None
        plan = sim._load_book_plan(b["dir"], [b["scene"]], score)
```

- **status:** fixed (sonnet) — h0/make/test_bughunt_b77.py; en без story/score.json — FileNotFoundError, как ru

## B78 · MAJOR · h0/make/film.py:112  (охотник k5)

- **claim:** Функция `record_scene` синхронно блокируется на 10 минут при аварийном завершении процесса `make.play`, выдавая ложное сообщение о тайм-ауте сцены вместо немедленного падения с ошибкой упавшего сервера.
- **trigger:** Запуск `make.film` на прогоне, в котором `make.play` аварийно падает во время воспроизведения сцены (например, ошибка генерации голоса Fish TTS или исключение в цикле симулятора).
- **expected:** Немедленное прерывание ожидания при выходе процесса `play` (`play.poll() is not None`) с пробросом кода возврата и лога ошибки процесса симулятора.
- **actual:** `subprocess.run` блокируется до истечения `max_s` (600 секунд), так как страница в Puppeteer никогда не получит событие `book_end` от мертвого сервера, после чего выбрасывает неинформативный `RuntimeError("record.mjs exit 1: the scene did not reach its end in 600s")`, скрывая реальную причину падения.
- **evidence:**
```python
        url = page_url(run_dir, static_port, sim_port)
        r = subprocess.run(["node", "bin/record.mjs", url, str(rec), str(max_s), size], cwd=ENGINE)
        if r.returncode != 0:
            raise RuntimeError(f"record.mjs exit {r.returncode}: the scene did not reach its end in {max_s}s")
```

- **status:** fixed (opus) — h0/make/test_bughunt_b78.py; record.mjs идёт через Popen, make.play опрашивается раз в секунду, его смерть останавливает запись с его кодом. Тест охотника был противоречив (ждал старое сообщение о таймауте и запрещал poll живого play), переписан

## B79 · CRIT · h0/pipe2/floor.py:316  (охотник k6)

- **claim:** Функция `attach_refs` отбрасывает только предметы, смонтированные непосредственно на контейнер, но оставляет вложенные смонтированные предметы, создавая висячие ссылки `mount.top_of` на удалённые объекты и приводя к ошибке валидации `REF_UNKNOWN` и срыву финальной сборки.
- **trigger:** Сцена со вложенным монтажом на перерисовываемом контейнере: контейнер `bedroom_shelf`, на нём коробка `bedroom_box` (`mount.top_of: bedroom_shelf`), а в коробке игрушка `bedroom_toy` (`mount.top_of: bedroom_box`).
- **expected:** При очистке содержимого контейнера транзитивно удаляются все смонтированные на него уровни предметов либо очищаются ссылки, чтобы не оставлять ссылок на удалённые ID.
- **actual:** `bedroom_box` удаляется из `scene["props"]`, но `bedroom_toy` остаётся со ссылкой на `bedroom_box`. Валидатор `engine/src/schema/refs.ts` выдаёт ошибку `REF_UNKNOWN: /props/.../mount/top_of`, `dreamer build` завершается с кодом 2, `engine.build` выбрасывает `EngineError`, и статус этажа `FloorResult.status` становится `"failed"`.
- **evidence:**
```python
        mount = prop.get("mount") if isinstance(prop, dict) else None
        host = None
        if isinstance(mount, dict):
            host = mount.get("top_of") or mount.get("tier_of")
        if isinstance(host, str) and host in containers:
            if warnings is not None:
                warnings.append("CONTAINED %s in %s" % (prop.get("id"), host))
            continue
        kept.append(prop)
```

- **status:** fixed (sonnet) — h0/pipe2/test_bughunt_b79.py; снятие смонтированного повторяется до неподвижной точки (транзитивно)

## B80 · MAJOR · h0/pipe2/floor.py:286  (охотник k6)

- **claim:** Извлечение короткого имени пропа через `rsplit("_", 1)[-1]` отсекает всё до последнего подчёркивания, из-за чего составные и нумерованные идентификаторы контейнеров распознаются как суффиксы, блокируя режим `redraw` и портя промпт генерации изображения.
- **trigger:** Сцена с контейнерами, имеющими цифровые или описательные суффиксы (например, `bedroom_table_1`, `living_shelf_small`, `bedroom_nightstand_left`).
- **expected:** Из идентификатора корректно извлекается тип мебели (например, путём отсечения префикса комнаты `rid + "_"`), сопоставляется со списком `CONTAINERS`, активирует режим `redraw` и формирует валидное описание в `ref["what"]`.
- **actual:** Переменная `short` получает значение `"1"`, `"small"` или `"left"`. Проверка `short in CONTAINERS` возвращает `False`, режим `redraw` не включается, смонтированные на стол предметы не удаляются, а генератору изображений уходит искажённый запрос `"Only 1, whole, on a plain white background..."`.
- **evidence:**
```python
        short = str(prop.get("id") or aid).rsplit("_", 1)[-1]
        ref = {"image": images[rid], "what": short}
        if short in CONTAINERS:
            ref["mode"] = "redraw"
            ref["what"] = short + " with everything standing on it and inside it"
```

- **status:** fixed (sonnet) — h0/pipe2/test_bughunt_b80.py; тип мебели — после снятия префикса комнаты первое слово из CONTAINERS (предел эвристики: `table_lamp` считается столом)

## B81 · MAJOR · h0/pipe2/surface_rule.py:35  (охотник k6)

- **claim:** Функция `plain_surfaces` проверяет наличие ключа через `"tile" in mat`, ошибочно принимая материалы со значением `{"tile": None}` (или JSON `{"tile": null}`) за текстурированные и пропуская сплошные заливки цветом в комнатах с референсами.
- **trigger:** Материал комнаты с референсным изображением, где модель вернула `{"color": "#fff", "tile": None}` (в JSON: `{"color": "#fff", "tile": null}`).
- **expected:** Функция `plain_surfaces` проверяет не просто наличие ключа, а непустую строку тайла (`bool(mat.get("tile"))`), выдавая замечание `PLAIN_SURFACE` для любого материала без текстуры.
- **actual:** Условие `"tile" in mat` вычисляется в `True`, проверка пропускает материал через `continue`, замечание `PLAIN_SURFACE` не генерируется, и движок строит плоскую одноцветную стену/пол в нарушение правила.
- **evidence:**
```python
        mat = materials.get(mid)
        if isinstance(mat, dict) and "tile" in mat:
            continue
        found.append({"code": "PLAIN_SURFACE", "owner": room_id, "path": "/materials/" + mid,
```

- **status:** rejected — `tile: null` не проходит схему (engine/schema/engine-scene.schema.json:35), `_accept` (h0/pipe2/room.py:347-352) сохраняет кандидата только после зелёной проверки; тест удалён

## B82 · MAJOR · h0/pipe2/engine.py:128  (охотник k6)

- **claim:** Методы `_check_uncached` и `_check_full_uncached` создают временные папки через `self._room(work)` (`tempfile.mkdtemp`), но нигде их не удаляют, приводя к постоянной утечке файлов сцен, отчётов, дистрибутивов сборки и скриншотов Playwright на диске.
- **trigger:** Вызовы проверок `engine.check(...)` или `engine.check_full(...)` во время работы критиков, сшивки швов (`seams`) и деградации сцен.
- **expected:** Временная папка каждого запуска CLI гарантированно очищается в блоке `finally` после завершения команды и считывания отчёта (как это реализовано для `_stage_scene` в `Engine.build`).
- **actual:** Созданные каталоги накапливаются в директории `work/` до конца процесса, накапливая сотни мегабайт сборок `dist/` и скриншотов браузера без очистки.
- **evidence:**
```python
    def _check_uncached(self, scene: dict, work: str | os.PathLike, built: str | os.PathLike | None) -> dict:
        here = self._room(work)
        scene_path = self._write_scene(here, scene)
        report_path = here / "report.json"
```

- **status:** fixed (sonnet) — h0/pipe2/test_bughunt_b82.py; временные папки check/check_full удаляются в finally

## B83 · MAJOR · h0/dream/sim.py:1163  (охотник k7)

- **claim:** Метод `Sim._book_human_say` при произнесении реплики живым игроком в книжном режиме не применяет сценические директивы `stage` текущего бита и не передаёт метаданные партитуры в `_start_line`.
- **trigger:** Симуляция в режиме книги с `hero_owner == "human"`. Текущий бит партитуры книги для героя содержит мизансцену `stage` (например, `[{"who": "Hero", "action": "goto", "place": "door"}]`) и метаданные (`gesture`, `remarks`). Игрок произносит реплику через `sim.human_say("текст")` в окне ожидания `BOOK_PROMPT_WAIT`.
- **expected:** `_book_human_say` эмитит сценические события `stage` (как это делает `_book_step` на строках 1198–1204) и передаёт `stage`, `gesture`, `remarks`, `shot`, `tone` в `_start_line`.
- **actual:** `_book_human_say` только увеличивает курсор книги и вызывает `_start_line` с фиксированным набором полей `owner`, `who`, `role`, `source`, `text`, `beat`. Поле `stage` не обрабатывается и не эмитится (персонажи не выполняют мизансцену), а метаданные бита теряются.
- **evidence:**
```python
        beat_i = self.book["cursor"]
        self.book["cursor"] += 1
        self.book["wait_since"] = None
        self._diagnostic(self.status())
        return out + [self._start_line({"owner": "human", "who": self.hero, "role": "hero",
                                        "source": "human", "text": clean, "beat": beat_i})]
```

- **status:** fixed (opus) — h0/dream/test_bughunt_b83.py; `_book_human_say` эмитит stage бита (общий `_book_beat_stage`) и передаёт BOOK_BEAT_META в `_start_line`

## B84 · MAJOR · h0/dream/director.py:245  (охотник k7)

- **claim:** Метод `Director._live_decision` перехватывает любые исключения LLM и возвращает `{"messages": []}`, из-за чего FSM на нефорсированных консультациях фиксирует вердикт `"ok"`, безвозвратно теряя накопленные события и блокируя повторный взвод триггеров.
- **trigger:** Директор в живом режиме (`fake=False`). В автомат поступает консультация по `hint == "nudge"` или `ready_stale`, либо свободная консультация с переданными событиями `events=[...]`. Вызов `llm_call` выбрасывает исключение (сетевой сбой, HTTP 500, таймаут или некорректный JSON).
- **expected:** Ошибка распознаётся как сбой директора, вызывается `_requeue(ticket, queued)`: события возвращаются в `self.pending`, а FSM вызывает `rearm_consult(ticket)` для восстановления `nudge_pending = True` или `ready_stale_fired = False`.
- **actual:** `_live_decision` возвращает `{"messages": []}`. В FSM `finish_consult` видит `bridge: None` и для любого тикета кроме `forced` возвращает успешный вердикт `"ok"`. В `_finish` проверка `verdicts[-1] in ("invalid", "stale")` оказывается ложной, `_requeue` не вызывается: входящие события теряются, а `fsm.rearm_consult` не вызывается, навсегда отключая повторный вызов консультации.
- **evidence:**
```python
        except Exception as e:
            self.errors.append(e)
            self._publish([dict(report("director", "director_fail", e), t=self.clock.now())])
            return {"messages": []}
```

- **status:** fixed (opus) — h0/dream/test_bughunt_b84.py; сбой живого директора — None, FSM даёт `invalid`, события возвращаются в очередь, триггер перевзводится

## B85 · MAJOR · h0/dream/director.py:258  (охотник k7)

- **claim:** В `Director._write_prompt` ротация файлов промптов сортирует записи каталога по `key=lambda f: int(f[:-4])` без фильтрации имени, приводя к падению с `ValueError` после вызова `fsm.begin_consult` и вечной блокировке автомата в состоянии `in_flight = True`.
- **trigger:** В каталоге `outdir/consults` оказывается любой текстовый файл с нечисловым именем (например, `prompt.txt`, `notes.txt` или `.txt`), и вызывается `director.consult_async(now)`.
- **expected:** Сортировка фильтрует только файлы с числовыми именами либо исключение записи файла перехватывается с откатом `self.fsm.in_flight = False`.
- **actual:** Вызов `int(f[:-4])` бросает необработанный `ValueError: invalid literal for int() with base 10`. Метод `consult_async` падает после того, как `self.fsm.begin_consult(now)` уже выставил `self.fsm.in_flight = True`, поток `_finish` не запускается, флаг `in_flight` в FSM никогда не сбрасывается, и все последующие консультации навсегда блокируются (`fsm.due()` возвращает `None`).
- **evidence:**
```python
        files = sorted((f for f in os.listdir(d) if f.endswith(".txt")),
                       key=lambda f: int(f[:-4]))
        while len(files) > 50:
            try:
                os.remove(os.path.join(d, files.pop(0)))
```

- **status:** fixed (opus) — h0/dream/test_bughunt_b85.py; ротация берёт только `NNN.txt`

## B86 · MAJOR · h0/dream/fsm.py:291  (охотник k7)

- **claim:** Метод `BuildFSM.touch` не проверяет флаг пробуждения `self.awake`, допуская недопустимый переход спящего автомата из состояния `"ready"` в `"transition"` после пробуждения героя.
- **trigger:** Автомат находится в состоянии `ready` (`self.state == "ready"`), вызывается `fsm.budget_wakeup(now)` (или директор возвращает `wake_up`), устанавливая `fsm.awake = True`. После этого вызывается `fsm.touch(now, fsm.bridge)`.
- **expected:** При `self.awake == True` автомат отклоняет касание моста и не переходит в `"transition"` (возвращает `[]` или событие `input` без смены состояния, аналогично `tick` и `begin_consult`).
- **actual:** Метод `touch` не проверяет `self.awake`, видит `self.state == "ready"` и безусловно вызывает `self._transition(now, "touch")`, возвращая событие перехода в новую сцену, из-за чего вызывающий `Sim._touch` запускает `_apply_transition()` для уже завершённого сна.
- **evidence:**
```python
        if self.state == "building":
            # the door is still closed: a world fact for the hero, no instruction to actors
            return [self._e(now, "door", state="closed", object=obj,
                            build_pct=self.build_pct(now))]
        if self.state == "ready":
            return self._transition(now, "touch")
```

- **status:** fixed (opus) — h0/dream/test_bughunt_b86.py; `touch` у проснувшегося автомата — простой input, без перехода

## B87 · MAJOR · h0/dream/sim.py:1122  (охотник k7) (в работе)

- **claim:** Метод `Sim._apply_transition` при переходе в сцену без дескриптора `next_scene` (`ns is None`) не вызывает `self.fsm.new_scene()`, оставляя автомат FSM навсегда заблокированным в состоянии `"transition"`.
- **trigger:** Стройка запущена вызовом `fsm.start_build(now, bridge, destination)` без явного `next_scene` (`next_scene=None`), после готовности двери выполняется переход `_touch(bridge)` при исчерпанном списке `_free_book`.
- **expected:** Метод `_apply_transition` сбрасывает автомат в исходное состояние новой сцены через `self.fsm.new_scene(now, self.scene["objects"], actors=self.actors)` даже при отсутствии нового дескриптора.
- **actual:** Вызов `self.fsm.new_scene` находится исключительно внутри ветки `if ns:`. В ветке `else:` обновляется только `self.scene`, а `fsm.new_scene` не вызывается. Автомат FSM навсегда остаётся в `state == "transition"`, перестаёт обрабатывать тики (`tick()` возвращает `[]`), а `due()` и `begin_consult()` блокируются.
- **evidence:**
```python
            for e in self.fsm.new_scene(self.clock.now(), self.scene["objects"],
                                        actors=self.actors):
                if self.logger:
                    self.logger.write_event(e)
...
        else:
            self.scene = dict(self.scene, events=[], goals=[])
```

- **status:** rejected — переход без `next_scene` запускается только при непустом `_free_book`, откуда сцена берётся (h0/dream/sim.py:1074-1077, 1380, 1387); тест удалён

## B88 · MAJOR · h0/dream/voice_tone.py:72  (охотник k8)

- **claim:** Функция `add_tones` не перехватывает ошибки парсинга кэша, аварийно завершая работу с необработанным `JSONDecodeError`, если файл кэша поврежден или пуст (0 байт).
- **trigger:** Вызов `voice_tone.add_tones(score, director, cache_dir)` при наличии в `cache_dir` пустого (0 байт) или оборванного файла `tone-<sha256>.json` от прерванного ранее прогона.
- **expected:** Поврежденный файл кэша игнорируется с записью предупреждения в `warnings`, и опрашивается `director(prompt)` согласно контракту функции («A broken answer leaves the lines as written»).
- **actual:** `json.load(f)` выбрасывает `json.decoder.JSONDecodeError`, который ничем не перехвачен, приводя к падению сборки в `h0/make/story.py`.
- **evidence:**
```python
    if path and os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            tones = json.load(f)
    else:
```

- **status:** fixed (sonnet) — h0/dream/test_bughunt_b88.py; битый/пустой кэш тона — промах, директор спрашивается снова

## B89 · MAJOR · h0/dream/author.py:206  (охотник k8)

- **claim:** Функция `cast` при пустом ответе модели `{}` или несовпадающих именах/ключах персонажей возвращает `({}, "partial")` на первой же попытке, прекращая цикл и пропуская вторую попытку из `range(ATTEMPTS)` с ложным статусом частичного успеха при 0 подобранных голосов.
- **trigger:** Вызов `author.cast(d, ...)` при возврате моделью на первой попытке `"{}"` или словаря с галлюцинированными ключами персонажей/несуществующими id из `menu`.
- **expected:** При `len(out) == 0` цикл `for _ in range(ATTEMPTS)` переходит к следующей попытке, а при исчерпании попыток возвращает `({}, note)`.
- **actual:** Выполняется безусловный `return out, ("ok" if len(out) == len(people) else "partial")`, возвращающий `({}, "partial")` сразу на первой попытке без повторного запроса к модели.
- **evidence:**
```python
        out, used = {}, set()
        for name, rid in picks.items():
            if name in menu and rid in {c["id"] for c in menu[name]} and rid not in used:
                out[name] = rid
                used.add(rid)
        return out, ("ok" if len(out) == len(people) else "partial")
```

- **status:** fixed (sonnet) — h0/dream/test_bughunt_b89.py; пустой подбор голосов идёт на вторую попытку

## B90 · MAJOR · h0/dream/author.py:68  (охотник k8)

- **claim:** Парсер `_json` аварийно падает с `JSONDecodeError`, если ответ LLM с markdown-блоком ```json предваряется любым сопроводительным текстом.
- **trigger:** Вызов `_json(text)` с ответом модели вида `"Here is the scene:\n```json\n{...}\n```"`.
- **expected:** JSON-объект успешно извлекается из блока кода markdown и десериализуется в словарь.
- **actual:** Проверка `s.startswith("```")` ложна из-за вступительного текста, строка `s` не очищается от маркдауна и передается в `json.loads(s)` целиком, вызывая `json.decoder.JSONDecodeError`.
- **evidence:**
```python
def _json(text):
    s = (text or "").strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[-1].rsplit("```", 1)[0]
    return json.loads(s)
```

- **status:** rejected — оба вызывающих `_json` ловят ошибку и повторяют запрос (h0/dream/author.py:128-135, 186-194); тест удалён

## B91 · MAJOR · h0/dream/author.py:163  (охотник k8)

- **claim:** Функция `candidates` посимвольно нарезает `person["voice"]["search"]` на 3 отдельных символа, если модель вернула поисковые слова строкой согласно формулировке схемы `AUTHOR_SCHEMA`.
- **trigger:** Вызов `candidates(person, search)` с персонажем, у которого поле `"search"` сгенерировано строкой (например, `{"voice": {"search": "old man, cowboy"}}`).
- **expected:** Поиск в библиотеке Fish выполняется по словам/фразам запроса целиком.
- **actual:** Срез `[:3]` берет первые 3 символа строки, и функция выполняет три однобуквенных запроса `search("o")`, `search("l")`, `search("d")`; если же передано число, падает с `TypeError`.
- **evidence:**
```python
def candidates(person, search):
    """Voices the library really has for one person: the look, not the memory."""
    seen, out = set(), []
    for term in (person["voice"].get("search") or [])[:3]:
        try:
            found = search(str(term))
```

- **status:** fixed (sonnet) — h0/dream/test_bughunt_b91.py; строковый `search` — один запрос

## B92 · MAJOR · h0/dream/inputs.py:35  (охотник k8)

- **claim:** Функция `sanitize` для спикера `"actor"` повреждает разрешенный тег `[[LOOK:...]]`, если внутри него есть знак `=`, вырезая внутренности до висячих скобок `[ ]` и генерируя ложное событие `input_rejected`.
- **trigger:** Вызов `sanitize("See [[LOOK: target=Alice]] here", "actor")` или `sanitize("[[LOOK: door=kitchen]]", "actor")`.
- **expected:** Тег `[[LOOK:...]]` полностью сохраняется без повреждений, так как входит в `ACTOR_TAGS`.
- **actual:** Регулярное выражение `_SINGLE` сопоставляется с внутренними скобками `[LOOK: target=Alice]`, предикат `keep` вычисляет `False` (так как паттерн не может начинаться с `[[`), заменяет тег на пробел и возвращает `'See [ ] here'`, записывая `[LOOK: ...]` в `input_rejected`.
- **evidence:**
```python
        allowed = lambda s: s[2:-2].split(":")[0].strip().upper() in ACTOR_TAGS
        text = _cut(_DOUBLE, text, removed, keep=allowed)
        text = _cut(_ENGINE, text, removed)
        text = _cut(_SINGLE, text, removed,
                    keep=lambda s: "=" not in s or s.startswith("[[") or s.endswith("]]"))
```

- **status:** fixed (sonnet) — h0/dream/test_bughunt_b92.py; для актёра одиночные скобки внутри `[[...]]` не режутся

## B93 · CRIT · h0/dream/llm.py:348  (охотник k8)

- **claim:** Функция `_piece_parts` падает с `TypeError` при разборе ответа модели, если словарь `usage` содержит `None` в полях токенов.
- **trigger:** Ответ транспорта с объектом `usage`, содержащим `None`, например `{"content": "hello", "usage": {"prompt_tokens": None, "completion_tokens": None}}`.
- **expected:** При отсутствии числового значения токенов используются расчетные значения по умолчанию `prompt_tok` и `_tokens(text)`.
- **actual:** `usage.get("prompt_tokens", prompt_tok)` возвращает `None` из-за присутствия ключа со значением `None`, после чего `int(None)` выбрасывает `TypeError: int() argument must be a string, a bytes-like object or a real number, not 'NoneType'`.
- **evidence:**
```python
    return (text, int(usage.get("prompt_tokens", prompt_tok)),
            int(usage.get("completion_tokens", _tokens(text))))
```

- **status:** fixed (opus) — h0/dream/test_bughunt_b93.py; null в usage — оценка, как у отсутствующего ключа

## B94 · MAJOR · h0/dream/server.py:288  (охотник k8)

- **claim:** Метод `_ab_order` в `server.py` аварийно падает с `TypeError` при числовом идентификаторе пары в `pairs.json`, роняя эндпоинт GET `/api/ab`.
- **trigger:** Запрос к `GET /api/ab` при наличии в `pairs.json` записи с числовым id: `{"id": 1, "runs": {"bank/run_1": "v1", "bank/run_2": "v2"}}`.
- **expected:** Сервер приводит id пары к строке и возвращает список пар с рандомизированным порядком A/B.
- **actual:** Выражение `self.viewer.ab_salt + pair["id"]` вызывает `TypeError: can only concatenate str (not "int") to str`, приводя к ошибке 500.
- **evidence:**
```python
    def _ab_order(self, pair):
        """A and B for a pair: the two runs, shuffled by the server's salt."""
        runs = sorted(pair["runs"])
        if random.Random(self.viewer.ab_salt + pair["id"]).random() < 0.5:
            runs.reverse()
        return runs
```

- **status:** fixed (sonnet) — h0/dream/test_bughunt_b94.py; id пары приводится к str

## B95 · MAJOR · h0/live/server.py:84  (охотник k9)

- **claim:** Эндпоинт `GET /tts/<id>` не обрабатывает сетевые и HTTP-ошибки Fish Audio API (`stream_tts`), приводя к аварийному завершению рабочего потока и обрыву TCP-соединения мёртвым сокетом без HTTP-статуса ошибки.
- **trigger:** Запрос клиента `GET /tts/<id>` с валидным идентификатором реплики из `lines` при возврате сервисом Fish Audio ошибки (например, HTTP 429 Too Many Requests, HTTP 401 Unauthorized, HTTP 500) или сетевом таймауте.
- **expected:** Сервер перехватывает сбой (`(OSError, ValueError)`) и возвращает клиенту HTTP-ответ с кодом 502 согласно контракту сервиса («a bad body/upstream gets an answer, not a dead socket»).
- **actual:** Необработанное исключение `urllib.error.HTTPError` / `URLError` / `TimeoutError` прерывает `do_GET()`, рабочий поток падает без отправки HTTP-заголовков и закрывает сокет (dead socket / connection reset).
- **evidence:**
```python
        elif self.path.startswith("/tts/"):
            if not self.trusted():
                return
            with lock:
                text = lines.get(self.path[5:])  # get: the audio tag may fetch twice
            if not text:
                self.send_error(404)  # B32: no Fish call for an unknown id
                return
            self.stream_tts(text)
```

- **status:** fixed (sonnet) — h0/live/test_bughunt_b95.py; сбой Fish до первых байт — 502; там же отрицательный Content-Length в `Handler.body` (тот же дефект, что B98)

## B96 · MAJOR · h0/live/rt.py:59  (охотник k9)

- **claim:** Функция-генератор `spark()` не вызывает `r.raise_for_status()`, из-за чего HTTP-ошибки Meta AI API (401, 429, 500) тихо проглатываются, а клиенту по WebSocket отправляется ложное событие `done` без сообщения об ошибке.
- **trigger:** Запуск диалогового хода через WebSocket, при котором запрос к `api.meta.ai` возвращает HTTP-статус ошибки (401 Unauthorized, 429 Rate Limit, 500 Server Error) с не-SSE телом ошибки.
- **expected:** `spark()` вызывает `r.raise_for_status()`, выбрасывая `aiohttp.ClientResponseError`, который перехватывается блоком `except Exception as e:` в `Session.respond()` и передаётся клиенту в поле `m["error"]`.
- **actual:** Без `r.raise_for_status()` генератор читает строки тела ошибки, не совпадающие с `data:`, штатно завершает итерацию с нулевым количеством токенов, а `Session.respond()` отправляет клиенту `type="done"` с пустым текстом и без поля ошибки в объекте `metrics`.
- **evidence:**
```python
    async with http.post("https://api.meta.ai/v1/chat/completions", json=body,
                         headers={"Authorization": f"Bearer {META_KEY}"}) as r:
        async for raw in r.content:
            line = raw.decode().strip()
            if line.startswith("data:") and line != "data: [DONE]":
                for ch in json.loads(line[5:]).get("choices", []):
                    if piece := (ch.get("delta") or {}).get("content"):
                        yield piece
```

- **status:** fixed (sonnet) — h0/live/test_bughunt_b96.py; `r.raise_for_status()`, ошибка в done.metrics; фейку теста добавлен статус

## B97 · MAJOR · h0/live/rt.py:171  (охотник k9)

- **claim:** Функция `join()` аварийно завершается с необработанным `IndexError` при наличии в списке пробельных строк, что приводит к краху и остановке фоновой корутины распознавания речи `turns.watch()`.
- **trigger:** Вызов `join(parts)` со списком фрагментов, содержащим пробельную строку (например, `["Hello", "   "]`), возникшую из-за непустого пробельного сегмента от ASR.
- **expected:** Функция `join()` проверяет непустоту списка `new` (`if words and new:`) перед обращением к `new[0]`, игнорируя пробельные элементы.
- **actual:** `filter(None, parts)` пропускает непустые пробельные строки (`bool("   ") == True`), вызов `part.split()` возвращает пустой список `new = []`, и обращение `new[0]` падает с `IndexError: list index out of range`, убивая задачу `turns.watch()`.
- **evidence:**
```python
    for part in filter(None, parts):
        new = part.split()
        if words:
            words[-1] = re.sub(r"[.,:;!]+$", "", words[-1])
            a, b = (re.sub(r"\W", "", w).lower() for w in (words[-1], new[0]))
            if b and (a == b or (len(b) >= 3 and a.endswith(b))):  # not "hi" + "I"
                new = new[1:]
        words += new
```

- **status:** rejected — ASR вызывает `.strip()`, `join` пропускает пустую строку (h0/live/rt.py:87, 230-246); тест удалён

## B98 · MAJOR · h0/squid_live/server.py:191  (охотник k9)

- **claim:** Обработчик `POST /api/talk` не проверяет неотрицательность заголовка `Content-Length`, позволяя отрицательным значениям обходить лимит `MAX_BODY` и зависать в бесконечном чтении `rfile.read(-1)`.
- **trigger:** HTTP-клиент отправляет запрос `POST /api/talk` с заголовком `Content-Length: -1`.
- **expected:** Сервер валидирует диапазон длины тела (`0 <= n <= MAX_BODY`) и отклоняет отрицательные значения статусом 400 Bad Request.
- **actual:** Проверка `if n > MAX_BODY:` вычисляется в `False` (`-1 > 65536` ложно), после чего вызывается `self.rfile.read(-1)`, который в `io.BufferedReader` читает поток до EOF; на открытом соединении поток сервера зависает навсегда, а при закрытии сокета вычитывает неограниченный объём данных в память.
- **evidence:**
```python
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > MAX_BODY:
                self.close_connection = True
                return self.send_error(413)
            req = json.loads(self.rfile.read(n))
```

- **status:** fixed (sonnet) — h0/squid_live/test_bughunt_b98.py; отрицательный Content-Length — 400

