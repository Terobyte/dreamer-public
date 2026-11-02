# bugs.md — багхант 2026-11-02 (agy gemini-3.8-flash-high)

Все записи — НЕПРОВЕРЕННЫЕ утверждения охотников. Баг считается доказанным, только когда красный тест падает на своём assertion.

Статус у всех: `claimed`. ID неизменны. Дубли не найдены (охотники делили зоны). Тяжесть — как у охотника, пересмотр после красных тестов.


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

Все записи — непроверенные утверждения. Статус `claimed`, пока красный тест не упал на своём assertion.

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b39.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b40.py (тяжесть снижена до MAJOR: теряется метка force в due(), «зависания стройки» нет)

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b41.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b42.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b43.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b44.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b45.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b46.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b47.py (доказан 1 из 3 вариантов нагрузки (choices:[str]))

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b48.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b49.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b50.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b51.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b52.py

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
- **status:** red — engine/test/bughunt2/b53.test.ts (низкая достижимость: make/stage.py:211 всегда пишет yaw; нужен ручной places.json)

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
- **status:** red — engine/test/bughunt2/b56.test.ts

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b58.py

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b60.py (откат history проверит второй тест после фикса)

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b61.py (доказана только половина: пустой data:-кадр; обрыв стрима не проверен)

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
- **status:** red — research/bughunt-2026-11-02/redtests2/test_b62.py
