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
