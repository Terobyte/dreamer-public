# Карта фич Dreamer (код на 2026-11-01, HEAD 9b118fd)

Читай ДО того, как писать код. Порядок для любого агента: §3 «нужно X — используй Y» → §4 дубли (не добавляй пятый клиент Spark, третий поиск пути) → §5 чего нет → только потом новый код. Добавил модуль или публичную функцию — допиши строку в §2 и §3 в том же коммите. Ссылки `файл:строка` проверены скриптом 11-01 (42/42 файла, 35/35 символов на месте); строки сдвигаются, ищи по имени функции. Идентификаторы оставлены как в коде. `?` = не проверено чтением кода. Не читались: `~/.dreamer-bench`, cache/, dist/, node_modules, h0/out, .env.

Пути: `E` = `engine/`, `H` = `h0/`. Все TS-пути относительно `engine/src/`, если не указано иное.

---

## 1. Как всё связано

```
 книга (H/dream/books/<b>/book.json + chN.txt)   или   промпт-сид ("сцена про...")
        |                                                    |
        v                                                    v
 [brief]  make/brief.py  (1 вызов Spark, JSON, схема make/schema/brief.json, 1 ретрай)
        |  -> brief/brief.json  {title, mode: book|seed, book{dir,scene}, style, places[], cast[], scene{where,who,want}}
        v
 [refs]   make/refs/*  (commons / openverse / tavily / fandom + локальные refs книги; pick=first|vision)
        |  -> refs/refs.json, cues.md, refs/<slot>/<n>.png|jpg
        +----------------------+----------------------+
        v                      v                      v
 [world]                 [cast]  (путь A!)       [story]
 make/world.py           make/cast.py            make/story.py
 build_task_md ->        ХОСТ кладёт             book: dream/book.py score_scene
 world/task/TASK.md      run/cast.src/cast.json  seed: story/seed.txt
 -> `python -m pipe2 run` + GLB; код только       -> story/score.json (+ score.edited.json
    проверяет (check_cast)                           от хозяина побеждает)
        |  pipe2:                |  -> cast/cast.json + cast/*.glb (+клипы)
        |  Floor(architect) -> skeleton.json + plan
        |  RoomPipeline x N параллельно: builder -> fix -> critic_layout -> critic_assets
        |  merge.py -> seams.py -> degrade.py
        |  Engine (subprocess `dreamer check/build/shots`) + AssetQueue (Muse Image -> SAM3D Modal)
        |  -> world/run/{scene.json, dist/{geometry.json, nav.json, build.json, check.json, top.svg,
        |                  index.html, runtime.js, assets/, shots/<cam>.png, sheet.png}, events.jsonl}
        +----------------------+----------------------+
                               v
 [stage]  make/stage.py (build_places) + story.run_stage -> stage/places.json + stage/stage.json
        |  {dist, places, cast, mode, book{dir,scene,score}, seed, objects[], voices{}, narrator_voice, start{}}
        v
 [play]   make/play.py : stage.json -> dream/sim.run(...) (Spark Open диалог, Fish голос, SSE /events)
        |  + статика: страница движка dist/index.html?stage=...&sim=...   (runtime/stage/*)
        |  события sim -> bridge.ts -> StageHandlers (line/narrator/touch/mode/story)
        v
 [film]   make/film.py : record.mjs (Playwright, ?film=1) -> <page>.webm + events.json -> ffmpeg
          подкладывает wav каждой реплики (adelay) -> film.mp4   (НЕ стадия DAG, отдельная CLI)
```

Файлы данных на стрелках: `brief.json` -> `refs.json` -> `TASK.md` -> `scene.json`/`skeleton.json` -> `dist/{geometry,nav,build}.json` -> `places.json` -> `stage.json` + `cast.json` + `score.json` -> лог `log.jsonl` + `events.json` + wav -> `film.mp4`.

Оркестратор: `make/core.py:run_make` — DAG `brief -> refs -> (world, cast, story) -> stage`, опционально `check`. Хэш входа стадии `input_hash(stage, version, params, inputs)` (sha256 канонического JSON), манифест, лок (`_Lock`), публикация `.pub/` + симлинки, потолки денег по долям `DEFAULT_SPLIT = brief 2 / refs 3 / world 70 / cast 15 / story 10`.

Параллельные пайплайны вне make:
- `H/dream/sim.py` — песочница сна (hero/actor/director/narrator + Fish + Muse Image + комикс-сервер). `make.play` её вызывает.
- `H/squid_live/` — эксперимент (SpongeBob не шипится). Читать как референс, не импортировать.
- `H/live/rt.py` — голосовой цикл (mic -> ASR Meta/Deepgram -> Spark -> Fish PCM), отдельный.

---

## 2. Карта по модулям

### 2.1 engine/ сборка и проверка (TS, `E/src`)

Сцена `scene.json` (схема `E/schema/engine-scene.schema.json`: version,name,spawn,style,materials,outdoor,levels,rooms,walls,fixtures,stairs,openings,props,decals,lights,assets,cameras,routes; описание `specs/engine-scene.md`). CLI: `node --import tsx bin/dreamer.ts check|build|shots`.

| файл | что делает | ключевое | данные | тесты |
|---|---|---|---|---|
| `bin/dreamer.ts` | CLI. `check <scene> [--report p] [--built dist]`; `build <scene> --out d [--assets none\|cache\|live] [--cache d] [--max-dollars n]`; `shots <dist> [--size WxH] [--ready-timeout s]`. Код выхода 0/1/2, diff с прошлым report | `main`, `runBuild`, `runShotsCmd`, `reportDiff` | in scene.json; out check.json | `build-cli.test.ts`, `demo.test.ts` |
| `bin/record.mjs` | Playwright пишет webm страницы + `events.json` (ms,type,who,text,audio,dur,"ready"). `node record.mjs <url> <out> [maxS] [WxH]`; exit 3 = нет book_end/stop | — | `<page>.webm`, `events.json`, `last.png` | `browser/stage.test.ts` ? (косвенно) |
| `check.ts` | прогон стадий `STAGES = schema, plan, openings, stairs, props, decals, cameras, nav` | `runCheck(raw, {until, builtNav, facts, tris, ...}) -> {report, ctx}` | Report/Passport | `schema.test.ts`, `bugs-*.test.ts` |
| `types.ts`, `ctx.ts` | `Issue`, `Code` (все коды ошибок), `Report`, `Ctx{scene,rooms,levels,openings,graph,props,decals,nav,facts,passport}` | — | — | — |
| `budget.ts` | лимиты: `TRI_LIMITS {small 1000, furniture 5000, large 8000}`, `SCENE_TRI_LIMIT 300000`, `ROOM_POINT_LIGHTS 2` | `propClass(size)`, `budgetIssues(ctx, tris)` | build.json.tris | `budget.test.ts`, `bugs-budget.test.ts` |
| `schema/{parse,validate,refs}.ts` | JSON parse с позициями; ajv-валидация + `applyDefaults`; ссылки по id (`checkRefs`), `sortIssues`, `escapePtr` | `parseScene`, `validate`, `applyDefaults`, `checkRefs` | scene.json | `schema.test.ts` |
| `plan/{rooms,merge,body,drift,lint,street}.ts` | комнаты (дуги bulge, `open: true` дворы), слияние интервалов стен, свободные стены/стекло, дрейф, подсказки улицы | `compileRooms`, `mergeLevel`, `freeWalls`, `wallBody`, `planStage`, `streetHints`, `driftIssues`, `overlapArea` | RoomGeo[], LevelPlan | `rooms.test.ts`, `merge.test.ts`, `yard.test.ts` |
| `openings/{resolve,graph,stage,swing}.ts` | двери/окна в стенах, граф комнат, поворот створки (петля, сектор) | `resolveOpenings`, `roomGraph`, `openingsStage`, `pickHinge`, `applySwing`, `sectorFor` | OpeningGeo[] | `openings.test.ts`, `doors.test.ts` |
| `stairs/{place,stage}.ts` | лестницы/рампы, headroom 2.0 | `placeStairs`, `stairsStage` | StairGeo[] | `stairs-*.test.ts` (3 файла) |
| `props/{place,lint,fact,cats}.ts` | расстановка по ребру/углу/`around`, пересечения OBB, размеры по факту GLB, категории размеров | `placeProps`, `lintProps`, `factIssues`, `factOf`, `CATS`, `edgePoint/edgeNormal/closestOnEdge/nearestEdge` | PropGeo[] | `place.test.ts`, `props-lint.test.ts`, `props-fact.test.ts` |
| `decals/place.ts` | плоские наклейки на стены/пол/кривые рёбра | `placeDecals`, `decalsStage` | DecalGeo[] | `decals.test.ts` |
| `cameras/check.ts` | камеры сцены: `ref`-кадры, лицо в кадре, `CAMERA_NO_REF` | `checkCameras` | cameras[] | `camera-ref.test.ts`, `bugs-camera.test.ts` |
| `nav/{floor,grid}.ts` | растр проходимости 4 см (`CELL`), капсула `CAPSULE_R 0.25`, `STEP_MAX 0.25`, рампы, слои по уровням, битовые маски дверей open/closed | `buildNav`, `isWalkable`, `isWalkableMask`, `navStage`, `stairNavs`, `pointInPoly`, `floorAt`, `levelY`, `rampAt/rampWalkable/rampUnder`, `navBit` | nav.json `{layers[], doors{id:{level,cells}}, ramps}` | `nav.test.ts`, `stairs-nav.test.ts` |
| `routes/{astar,waypoints,stage}.ts` | `routes[]` сцены: A* между точками, waypoint по имени/позиции, кто блокирует | `findRoute`, `findRouteLevels`, `gridOf`, `walkable`, `nearestWalkable(Any)`, `waypoint`, `blockerBetween`, `routesStage` | NavJson | `routes.test.ts`, `stage-route*.test.ts` |
| `geom/{vec,poly,obb,arc}.ts` | V2-математика, полигоны, OBB-пересечения, дуги | `add/sub/scale/len/dist/norm/mid/degFromVec`, `segInt`, `segIntersectionPoint`, `obbIntersects`, `obbPolyIntersects`, `arcFromBulge`, `discretizeArc`, `azToPoint/pointToAz` | — | через place/rooms тесты |
| `report/{report,codes,messages,topsvg,timing}.ts` | отчёт, словарь кодов (stage+level), тексты ошибок, top.svg плана | `makeReport`, `CODES`, `msg`, `suggestField`, `futureHint`, `topSvg`, `mark` | check.json, top.svg | `msg.test.ts`, `topsvg.test.ts` |

### 2.2 engine/ build (геометрия в dist)

| файл | что делает | ключевое | данные | тесты |
|---|---|---|---|---|
| `build/write.ts` | оркестрация build: пишет `check.json, top.svg, nav.json, geometry.json, index.html, runtime.js (esbuild), build.json` | `writeDist`, `bundleRuntime`, `countTris`, `cutPlaced`, `BuildJson{ok,seconds,assets{used,fallback,missing,cut?{id:{from,to}}},props{fact},tris,doors[]}` | dist/ | `build-cli.test.ts`, `build-geometry.test.ts`, `asset-cut.test.ts` |
| `build/geometry.ts` | вся геометрия: `Geometry{meshes, floors[{room,level,y,outline}], materials, lights, cameras, spawn, style, outdoor}` | `buildGeometry(ctx, assetFiles, glbSizes)`, `materialTable` | geometry.json | `build-geometry.test.ts` |
| `build/{walls,slab,floors,roof,beams,stairs,doors,fixtures,decals,props,mesh,color,materials,page,shots,shotnames}.ts` | стены с вырезами, плиты/дыры, earClip, крыша, балки, лестницы+перила, двери (`doorDefs`), окна-фикстуры, MeshBuilder, цвет-заглушка по id (`grayOf`), `placeAssets` (GLB в dist + размеры), html-страница, `runShots` (Playwright, лист `sheet.png`), `shotBaseNames` | `intervalMeshes`, `extrudeFace`, `earClip`, `roofMeshes`, `stairMeshes`, `doorMeshes`, `fixtureGeos`, `propMeshes`, `planeMesh`, `boxMesh`, `placeAssets`, `runShots`, `serveDist`, `sheetHtml` | dist/shots/`<cam>`.png | `build-geometry`, `walls-fixtures`, `build-things`, `build-shots`, `browser/shots.test.ts` |

### 2.3 engine/ assets (ценники, кэш, провайдеры)

| файл | что делает | ключевое | данные | тесты |
|---|---|---|---|---|
| `assets/templates.ts` | `AssetKind = tile\|decal\|object\|sky`, шаблон промпта, размер по aspect | `promptFor(kind, prompt)`, `sizeFor(aspect)` | — | `assets-cache.test.ts` |
| `assets/cache.ts` | ключ кэша = sha256 шаблонного промпта (+aspect кроме object); `size`/`front_deg` в ключ НЕ входят | `cacheKey(kind, prompt, aspect, ref?)` (с `ref` в ключ входят sha256 байтов картинки и `what`; без `ref` ключ прежний), `cachePaths(dir,key)` -> `<key>.png/.alpha.png/.src.png/.glb`, `appendLedger` -> `ledger.jsonl` | cache dir | `assets-cache.test.ts` |
| `assets/cost.ts` | деньги в центах: `IMAGE_CENTS 1`, `MESH_CENTS 15`; потолок | `priceCents`, `dollarsToCents`, `totalCents`, `class Budget`, `CapError` | — | `assets-cache`, `assets-live.test.ts` |
| `assets/run.ts` | список ассетов сцены, чего нет в кэше, живой прогон (картинка -> альфа -> меш), режимы `none\|cache\|live` | `sceneAssets`, `missingAssets(scene, cache, sceneDir?)`, `runAssets` (`opts.sceneDir`: `ref.image` читается только внутри папки сцены, иначе `failed` `REF_PATH`/`REF_MISSING`; провайдер без `fromRef` → `warnings` `REF_IGNORED`; `ref.mode` `mask` (по умолчанию) → `ObjectProvider.fromScene`, иначе/при сбое путь Н2 с `MASK_FALLBACK` `empty\|error\|unavailable`, ни одного через маску → `MASK_ALL_FALLBACK`; поза SAM3D в `<key>.pose.json` → `build.json assets.pose`), `resolvedAssets(..., sceneDir?)` | AssetReport | `assets-live.test.ts` (25), `build-assets.test.ts`, `asset-ref.test.ts`, `asset-mask.test.ts` |
| `assets/batch.ts` | пул параллельных задач, `IMAGE_CONCURRENCY = 16` | `pool(items, limit, fn)` | — | `assets-live` |
| `assets/glb.ts` | GLB 2.0 reader/writer + нормализация SAM3D: front -> +Z (`front_deg`), низ на y=0, центр по footprint | `readGlb`, `writeGlb`, `normalizeGlb` | .glb | `glb.test.ts` (18) |
| `assets/tris.ts` | треугольники GLB | `glbTriangles(buf)` | — | `glb.test.ts` |
| `assets/cut.ts` | срез GLB под лимит треугольников (meshopt simplify), `build` режет копию в dist, кэш нетронут | `cutGlb(buf, tris)` | `CUT_EMPTY`, `CUT_OVER` | `asset-cut.test.ts` |
| `assets/alpha.ts` | белый фон -> альфа (наклейки/объекты) | `cutWhite(png)` | — | `foliage-cutout.test.ts` |
| `assets/sky.ts` | шов панорамы неба | `seamSky`, `inpaintSky(png, edit)`, `SEAM_PROMPT` | — | `assets-live` ? |
| `assets/providers/muse-image.ts` | Muse Image `meta-models/muse-image-1` на `api.meta-models.ai`; ключ ТОЛЬКО из env `META_MODEL_API_KEY` | `MuseImageProvider(opts)`, `RetryableError` | — | `assets-live` (с мок-fetch) |
| `assets/providers/sam3d.ts` | SAM3D по HTTP `/v1/3d/generations` (model `meta-models/sam-3d-objects`) | `Sam3dProvider.mesh(png,name)` | — | `assets-live` |
| `assets/providers/fake.ts` | оффлайн-провайдеры для тестов | `FakeImageProvider`, `FakeObjectProvider`, `fakePng(w,h,rgb,whiteCorners)`, `fakeGlb()` | — | почти все assets-тесты |
| `assets/providers/types.ts` | швы `ImageProvider{generate,edit?}`, `ObjectProvider{mesh}` | — | — | — |

### 2.4 engine/ runtime (страница)

URL-параметры: `?cam=<id>` (камера из сцены), `?top`/режимы (`cams.ts pickCamera`), `?stage=<url stage.json>`, `?sim=<url sim>`, `?film=1`. Готовность: `window.__ready = true`, API `window.__dreamer`. События окна: `door_touch`, `stage_line`.

| файл | что делает | ключевое | тесты |
|---|---|---|---|
| `runtime/main.ts` | старт страницы: three-сцена из geometry.json, текстуры/GLB, свет (point + hemi), ходьба, двери, outdoor, stage | `start()` | `browser/page.test.ts` |
| `runtime/assets.ts` | загрузка текстур/GLB, подгонка GLB в бокс, вырезание тёмных текселей | `loadMaps`, `loadGlb`, `fitGlb`, `cutDarkTexels` | `browser/assets.test.ts`, `walk-look` |
| `runtime/walk.ts` | игрок: `EYE 1.6`, `SPEED 1.4`, капсула по nav, мышь | `makeWalker`, `controls`, `mouseLook` | `bugs-walk`, `walk-look` |
| `runtime/doors.ts` | дверь вращается вокруг петли, блокирует клетки nav, «касание» лучом | `makeDoor`, `touchTarget`, `setCells`, `sweepOf`, `TURN_S 0.6`, `TOUCH_M 1.2` | `door-runtime`, `door-blockers` |
| `runtime/cams.ts` | выбор камеры страницы (walk / cam / top) | `pickCamera`, `yawDir`, `lookDir` | `cams.test.ts` |
| `runtime/outdoor.ts` | небо-купол + круглая земля с затуханием | `addOutdoor` | `browser/outdoor.test.ts` |
| `runtime/bridge.ts` | sim <-> engine: SSE `/events` sim -> `StageHandlers {line,narrator,touch,mode,story}`; алиасы `snapshot->mode`, `schedule/event->story`; обратно `simPost` | `createBridge`, `connectSim`, `simPost` | `stage-bridge.test.ts` |

### 2.5 engine/ runtime/stage (книжная сцена: актёры, камера, жизнь)

| файл | что делает | ключевое | данные | тесты |
|---|---|---|---|---|
| `stage/index.ts` | `startStage`: читает `stage.json`, `places.json`, `cast.json`; ставит актёров на `start`; обработчики событий; кадр `update(dt)`: актёры, toucher, очередь режиссёра, плавная камера | `startStage(StageCtx) -> {handlers, update, api{actors,camera,subs}}`; кнопка freestyle и ticker (кроме `?film=1`) | stage.json | `browser/stage.test.ts`, `stage-round8.test.ts` |
| `stage/actors.ts` | актёр: GLB + высота `height_m`, ходьба по путям, поворот, поза `idle\|sit` (`SIT_DROP 0.45`), `speak(sec)`, `play(clip)`; запасной ящик если GLB не грузится | `createActor`, `Actor{go,moving,speak,speaking,play,y,pos,yaw,act,update}`, `WALK_SPEED 1.4` | cast.json | `stage-anim`, `stage-round8` |
| `stage/anim.ts` | AnimationMixer на персонажа: ретаргет по имени кости, срез калибровочной T-позы (`calibrationEnd`), root на месте, кроссфейд, rest-поза (`UPRIGHT`), выбор клипа по тексту | `createAnimator`, `Animator{play,idle,update,has,current,alive,...}`, `pickClip(text, who, cast, aliases)`, `clipForBeat(beat, cast)`, `DEFAULT_VERBS` (wake,hug,flick,stroke,leap,fall,sit,walk) | cast `clips`,`verbs`,`idle` | `stage-anim` (19), `stage-anim-pick` |
| `stage/life.ts` | процедурный idle: дыхание (chest), перенос веса (spine), взгляд головой по сторонам, кивки при речи; кости по именам-кандидатам; руки/таз не трогает | `createLife(root, seed) -> Life{before, after}` | — | `stage-life.test.ts` |
| `stage/director.ts` | чистый режиссёр камеры: банк планов `BANK = ots, close, two, wide, orbit, dolly, low, follow`; реакции, правило 180, очередь событий, сглаживание | `createDirector(rng, {snap})`, `step(DirectorInput) -> {plan,cam,look,cut}`, `createPendingQueue`, `initialYaws`, `smoothCam`, `fallbackFrame` | DEvent{line,narrator,walk,tick} | `stage-director` (38), `-room`, `-occlusion` |
| `stage/camera.ts` | прямоугольник комнаты, зажим камеры внутрь (inset 0.3, ceil gap 0.3), кадр по виду плана | `roomRect`, `clampCamera`, `insideInset`, `snapInside`, `directShot(kind: wide\|two\|close)` | — | `stage-camera*.test.ts` |
| `stage/sight.ts` | луч от камеры к цели: мешает ли мир (актёры не мешают), кэш на сетке 10 см | `createSight(world, skip) -> (cam, look) => clear` | — | `stage-sight.test.ts` |
| `stage/places.ts` | банк мест: `Place{name,id,kind: sit\|stand\|door,room,level,at,yaw,look,obstacle,size}`; `claims` (место занято -> встать сбоку `SIDE_M 0.8`); `stageRegex` (фраза -> {who,place}) | `resolveTouch`, `releaseClaim`, `stageRegex`, `yawTo`, `floorAt(floors,p,level)` | places.json | `stage-places`, `stage-touch-claim`, `stage-regex-unicode` |
| `stage/path.ts` | BFS по nav-слою (8 соседей, без срезания углов), obstacles, открытые двери; межуровневый маршрут через рампы | `findPath(layer,bits,from,to,opts)`, `findStageRoute` | nav.json | `stage-path`, `stage-route(-hops)` |
| `stage/touch.ts` | «подойди к объекту X»: маршрут, этажи, очередь, результат `walk\|skip\|unreachable\|queued\|no_actor` | `createToucher(ctx)` | — | `stage-touch-claim` |
| `stage/subs.ts` | субтитры + озвучка (`Audio` по `r.audio`), лог для теста | `createSubs(sim, doc)`, `audioUrl` | wav из `/out/...` | `browser/stage.test.ts` |

### 2.6 h0/make (python -m make)

CLI: `cd h0 && python3 -m make "<промпт>" [--book DIR --scene ID] [--run DIR] [--only X|--from X] [--until X] [--fresh] [--fake] [--check] [--max-dollars N] [--split brief:2,...] [--effort] [--mesh sam3d] [--pick first|vision] [--freestyle]`. Прогоны в `meta/runs/<ts>/`. Отдельно: `python3 -m make.play runs/<id> [--freestyle] [--fake] [--port N]`, `python3 -m make.film runs/<a> [runs/<b>] --out film.mp4 [--max 600] [--size WxH]`.

| файл | что делает | ключевое | данные | тесты |
|---|---|---|---|---|
| `__main__.py` | argparse -> `core.run_make`; код выхода 1 при failed/blocked | `main` | — | `test_core` |
| `core.py` | DAG, манифест, хэши, лок, публикация, доли денег, `--fake` стабы | `run_make`, `default_stages`, `input_hash`, `canonical`, `parse_split`, `Stage`, `Ctx`, `MissingInput`, `LockError` | `make.json`, `manifest`, `<stage>/marker.txt` | `test_core`, `test_ancestor_hash`, `test_cap_hash`, `test_budget_guard`, `test_split_guard` |
| `brief.py` | промпт (+ сцена книги) -> brief.json; проверка кодом по `schema/brief.json`; согласованность place type (indoor/outdoor) и `query` | `make_brief(prompt, ask, book_note, expect_book)` (answer + 1 ретрай с текстом ошибки), `validate`, `spark_ask(spark, effort)`, `book_context`, `seed_from_book`, `ScenarioBrief` (фейк), `BriefFailed` | brief.json | `test_brief*.py` (9 файлов) |
| `refs/__init__.py` | поиск и отбор картинок | `run_refs(brief, out, providers, loader, pick, ask, local)`, `gather`, `download_filter`, `book_local`, `sniff` | refs.json, cues.md | `test_refs*.py` |
| `refs/{commons,openverse,tavily,fandom,_common}.py` | провайдеры; лицензия `usable()`; fandom = только ориентир, не для сабмита | `search(query, n, fetch)` | — | `test_refs` |
| `refs/fake.py`, `testkit.py` | оффлайн ответы / `OfflineTransport` Spark | `providers()`, `image`, `vision_ask`; `offline_spark_module` | testdata/refs | все |
| `world.py` | brief+refs -> TASK.md -> `pipe2 run` (subprocess, cwd=h0); `--fake` копирует фикстуру `testdata/world_run` | `build_task_md`, `pipe2_argv`, `run_world`, `DEFAULT_CAPS {usd 20, calls 400, tokens 4M}` | world/task/TASK.md, world/run/ | `test_world*.py` (5) |
| `cast.py` | ПУТЬ A: проверяет cast.json + GLB (валидатор glTF на питоне, клипы, idle, голоса из `dream/voices.json`). Генерации персонажей НЕТ | `check_cast`, `run_cast`, `default_idle`, `_glb_ok`, `_gltf_doc_ok`, `_clip_problem` | cast/cast.json | `test_cast`, `test_cast_clips` |
| `story.py` | book: `dream/book.score_scene` -> score.json (учитывает `score.edited.json`); seed: seed.txt; `run_stage` пишет stage.json; `run_sim` | `run_story`, `run_stage`, `run_sim` | story/score.json | `test_story`, `test_story_hash_rel`, `test_stage_hash_book` |
| `stage.py` | банк мест из построенного мира: позиция/yaw из geometry.json, размер из scene.json, двери из build.json, snap на nav; `SIT = sofa,couch,chair,armchair,bench,bed,stool,seat` -> kind `sit`, остальное `stand`; двери `door`; `pick_start` | `build_places(world_run)`, `write_stage`, `pick_start`, `_Nav.snap`, `_name_places` | places.json, stage.json | `test_stage_places`, `test_stage_snap`, `test_stage_start_*`, `test_stage_fix` |
| `play.py` | stage.json -> `sim.run`, статик-сервер dist, ожидание зрителя | `play`, `serve_static`, `static_url` | log.jsonl | `test_play`, `test_play_wait`, `test_e2e_fake` |
| `film.py` | запись сцен в mp4: record.mjs + ffmpeg adelay для wav | `film`, `record_scene`, `mux_cmd`, `concat_cmd`, `page_url`, `TAIL_MS 2500` | film.mp4 | `test_film.py` |

### 2.7 h0/pipe2 (строитель мира)

CLI: `cd h0 && python3 -m pipe2 run <task_dir> --run-dir D [--cap-usd N --cap-calls N --cap-tokens N] [--k 2] [--effort role=high|medium|max ...] [--resume] [--fake] [--mesh sam3d]`; `python3 -m pipe2 measure --role ... --effort ... --prompt-from F [--n 15] [--room R]`.

| файл | что делает | ключевое | тесты |
|---|---|---|---|
| `__main__.py` | запуск, сигналы, тик прогрева GPU каждые 30 с, фейк-режим | `run(args)`, `main`, `_efforts` | `test_cli` |
| `floor.py` | архитектор: skeleton + plan один раз, потом комнаты параллельно; починка скелета до 2 раундов | `Floor.run -> FloorResult`, `skeleton_defects`, `MAX_ARCHITECT_FIX_ROUNDS`, `attach_refs(scene, plan, scene_dir)` (кадр комнаты → `ref` у всех её `object`) | `test_floor`, `test_bugs_floor`, `test_floor_ref_names`, `test_ref_assets` |
| `room.py` | конвейер комнаты: builder -> fix (до `MAX_FIX_ROUNDS 2`) -> critic_layout -> critic_assets; `RoomStore` (green-файлы для resume) | `RoomPipeline.run -> RoomResult`, `RoomStore`, `shot_filenames`, `engine_spec()` | `test_room`, `test_bugs_room` |
| `merge.py` | сборка частичных сцен комнат в скелет, владельцы находок | `merge(skeleton, partials, plan)`, `owner_of`, `split_owners` | `test_merge`, `test_merge_v2` |
| `blame.py` | чья комната виновата в находке движка (бисекция) | `blame_room`, `blame_global`, `NAV_CODES` | `test_blame` |
| `seams.py` | ремонт стыков (параллельно, `max_rounds=3`) | `repair_seams(ctx, partials)` | `test_seams` |
| `degrade.py` | если не чинится: убрать блокирующий контент без новых вызовов | `degrade(engine, work, skeleton, partials, plan)` | `test_degrade` |
| `engine.py` | движок как Python-интерфейс (subprocess `dreamer`), в temp-каталоге, мемо по хэшу сцены, `Gated` | `Engine.check/build/shots`, `green(report)`, `blocking`, `scene_for_room`, `shots_retry`, `KEYS_TS` | `test_engine` |
| `keys.ts` | печатает ключи ассетов сцены через `sceneAssets/promptFor/sizeFor` движка (единый источник ключа) | CLI | `test_engine` |
| `spark.py` | клиент Spark: 1 вызов = 1 Answer; `MODEL = muse-spark-1.3-contributor`, `MAX_TOKENS 64000`, ретраи транспорта `MAX_RETRIES 2` с `RETRY_BASE_S`; невалидный JSON не бросает, возвращает `valid=False` | `Spark.ask(role, room, round_no, messages, effort)`, `HttpTransport`, `parse_scene`, `Answer`, `reserve_of` | `test_spark`, `test_paid_model` |
| `ledger.py` | журнал событий jsonl + потолки usd/calls/tokens, резервы, `resume` | `Ledger.allow/charge/settle/record`, `Ledger.reserve` (как `allow`, но отказ не ставит `capped`: можно ждать), `load_prices` (`prices.json`) | `test_ledger`, `test_bugs_ledger`, `test_mesh_wait` |
| `assets.py` | Muse Image (`muse-image-1.0`) -> SAM3D на Modal (`dreamer-sam3d`, таймаут 330 с), очередь по ключам, по комнатам | `AssetQueue.put/wait/done/close`, `MuseImage`, `ModalMesh`, `png_complete`, `as_png` | `test_assets`, `test_bugs_assets` |
| `gpu.py` | прогрев GPU: `min_containers`, окно 120 с, всегда сброс при выходе | `GpuWarmth.start/tick/close`, `ModalAutoscaler` | `test_gpu` |
| `geom.py` | точка в комнате (дуги) | `in_room`, `room_polygon` | через floor |
| `measure.py` | повторный замер сохранённого промпта (латентность, валидность) | `measure`, `percentile` | `test_cli` ? |
| `fakes.py` | фейки: `FakeSpark`, `FakeEngine`, `ScenarioSpark`, `FakeLedger`, `FakeAutoscaler`, `FailedImages`, `FailedMeshes`, `synthetic_task()` | — | везде |
| `prompts/*.md` | architect, architect_fix, builder, fix, critic_layout, critic_assets, seam_fix | — | `test_package` |
| `v1/` | старый пайплайн (author/assets/pipe) — не использовать | — | — |
| `CHECKPOINT.md` | пауза 10-29, открытые находки phase 7 (устарел, но показывает долги: `lights: null`, `on.az` на кривом ребре) | — | — |

### 2.8 h0/dream (песочница, книга, голос)

CLI: `python3 h0/dream/sim.py [--profile A|B|C] [--seed "текст"] [--fake] [--speed] [--max-transitions] [--max-dollars 20] [--serve --port 8770] [--scene] [--text] [--talk spark-open|spark|wonder|haiku|opus] [--max-seconds] [--book DIR] [--score F] [--hero npc|human] [--lang en|ru]`; `python3 h0/dream/book.py <book_dir> --scene ID [--out score.json] [--stats]`; `bank.py`, `dub.py`, `author.py`, `server.py` — свои main.

| файл | что делает | ключевое | данные | тесты |
|---|---|---|---|---|
| `sim.py` (2353 стр.) | главный цикл: сцена, FSM стройки, режиссёр async, диалог, Fish, Muse Image, лог, книга, freestyle, safety, POV | `run(...)`, `Sim`, `use_scene`, `load_profile`, `_load_book_plan`, `seed_start`, `line_duration`, `verify_run`, `Logger`; события `line, narrator, touch, goal, schedule, story, book, book_end, mode, snapshot, cost, safety_pause, loop_cut, turn_skip, transition, stop...` | `h0/out/dream/<profile>/<run>/log.jsonl`, wav, png | `test_sim`, `test_bugs_sim_*`, `test_phase1_*` |
| `director.py` | LLM-директор: 1 вызов в полёте, очередь событий, `validate_decision`, `seed_scene` | `Director.consult_async/drain_events/wait`, `validate_decision`, `seed_scene` | — | `test_director`, `test_bugs_director` |
| `dialogue.py` | реплики героя/актёров, судья, рассказчик, память мыслей `Mind`, замок на строку (`lock_line`), петли (`loop_items`, `count_action_loops`), поиск объектов/имён в тексте | `Dialogue.hero_line/actor_line/judge/narrate/compact/new_scene`, `remarks`, `find_objects`, `names_in`, `repeats`, `uses_bit`, `prompt_version` | — | `test_dialogue`, `test_phase1_lock`, `test_bugs_dialogue` |
| `memory.py` | 5 слоёв памяти директора, бюджеты токенов, факты | `Memory.add_line/add_event/record_decision/build_prompt/apply_facts/merge_from_raw`, `tokens` | — | `test_memory` |
| `fsm.py` | машина стройки idle -> building -> ready -> transition, проверки решений | `BuildFSM`, `check_scene`, `check_target`, `clean_extras` | — | `test_fsm` |
| `llm.py` | обёртка LLM: роли -> (модель, effort), ретрай пустого ответа с большим лимитом, счётчик денег, потолок | `call(role, system, messages, max_tokens, fake, _transport)`, `resolve(role)`, `set_cap`, `get_spent`, `charge_fish`, `charge_image`, `set_talk_model`, `RealTransport`, `ROLE_TABLE`, `TALK_MODELS` | — | `test_llm`, `test_baseten`, `test_bugs_llm_bench` |
| `voice.py` | Fish TTS: `Voice.synthesize(text, label, out_path)`, `strip_tags`, `wav_seconds`, тишина при 3 провалах; `MODEL = "drama-3"`; пул `voices.json` (old_woman, old_man, woman, man, child, creature, scarlett, rhett ...) | `Voice`, `real_transport`, `fake_transport`, `load_pool`, `fish_key`, `character_reference_id` | wav | `test_contract_fish*`, `test_bugs_voice` |
| `images.py` | Muse Image фон/портрет, макс 2 одновременно, fallback | `Images.generate`, `background_prompt`, `portrait_prompt`, `real_transport` | png | `test_media` |
| `book.py` | глава -> черновой score без LLM (beats `line`/`narration`, поле `who/text/tag/para`; в sim пробрасываются `stage/gesture/shot`) | `load_book`, `find_scene`, `parse_scene`, `score_scene`, `split_narration`, `split_paras`, `stats` | book.json, score.json | `test_book`, `test_jane_eyre_book`, `test_book_play` |
| `author.py` | Wonder пишет целую сцену (душа героя, актёры, подбор голоса Fish через `fish_search`) | `author_scene`, `write_scene`, `cast`, `to_scene` | scenes/*.json | `test_author` |
| `bank.py` | прогон банка сцен текстом + метрики (MATTR, молчания, серии) | `run_scene`, `score`, `mattr` | `h0/out/dream/bank/sheet_*.md` | `test_ab`? |
| `dub.py` | озвучить и нарисовать текстовый прогон постфактум | `dub`, `cast_of` | — | `test_dub` |
| `server.py` | комикс-сервер: `GET /api/status,/api/hero,/api/runs,/api/panel,/api/ab,/events (SSE),/out/*,/ab`; `POST /say,/event,/pov,/continue,/stop,/freestyle` | `Viewer`, `ViewerHandler`, `read_rows`, `fold_snapshot` | comic.html | `test_server`, `test_bugs_server` |
| `lang.py` | `--lang en\|ru`: подменяет английские фразы в правилах героя/актёра/директора/судьи (`lang_text`); перевода книги и смены голоса НЕТ | `set_lang`, `lang_text`, `LANG` | — | `test_phase1_lang` |
| `inputs.py`, `safety.py`, `human.py`, `diagnostics.py`, `clock.py`, `fake.py` | санитайзер ввода и `resolve_touch(value, objects)`; список стоп-фраз `match`; метрики «человечности»; единый `report(component, kind, error)`; `Clock(speed)`; `FakeTransport(script, reply, gate)` | — | — | `test_inputs`, `test_phase2_safety`, `test_phase1_human`, ... |
| `books/` | gwtw, jane-eyre (демо), koshakan, ohenry, sherlock + picks | `book.json {title,author,pov,narrator_voice,cast{name:{sex,voice,look}},chapters[{n,file,scenes[{id,paras,place,cast,aliases}]}]}` | — | — |
| `scenes/` | 8+ готовых сцен-банка (roof, laundromat, bus, kitchen, hospital, school, ferry, elevator) + twelve_oaks | — | — | — |

### 2.9 Modal / GPU / прочее в h0

| файл | что | заметка |
|---|---|---|
| `sam3_modal.py` | Modal app SAM 3 (`SEG_APP` в `pipe2/assets.py`, заглушка `dreamer-sam3`, не развёрнут): `Sam3.mask(png, what) -> PNG` лучшего совпадения, пусто или < 0.5% кадра → `MaskEmpty` (`MASK_EMPTY`) | маска по тексту для Н2б |
| `sam3d_modal.py` | Modal app `dreamer-sam3d`, H100, `Sam3D.run(name, png, with_ply, mask=None)` (с `mask` белый фон не ищется; `pose` из `out` в результате), `scaledown_window=600`, без лимита контейнеров (N объектов -> N GPU); `watchdog` по расписанию каждые 2 мин; CLI `modal run h0/sam3d_modal.py --out D --pngs a.png,b.png` | единственный Modal app с моделью |
| `sam3d_buildcheck.py` | проверка импортов образа SAM3D на T4 | — |
| `muapi_3d.py` | PNG -> GLB через muapi (Tripo/Meshy); читает ключ из `music-video/.env` | платный, $0.30-0.50 за меш |
| `gen_images.py`, `h13_*.py`, `h16_*.py`, `actor_test.py`, `gate_test.py`, `hint_test.py`, `load_test.py` | эксперименты/ранние тесты (H13 небо+шов, H16 комната Сквидварда, дверь-гейт, лестница намёков) | `gate_test` импортируется `live/rt.py` |
| `world/twelve_oaks/` | старая ручная сборка (POSTMORTEM.md: плохо, 2M треугольников) | не образец |
| `live/` | `rt.py` (WebSocket: mic -> ASR -> Spark -> Fish PCM), `server.py`, `asr_bench.py` | 3 теста |
| `prompts/` | промпты ранних H-экспериментов | — |

### 2.10 squid_live (референс, НЕ часть конвейера)

`duo.py` (запуск sim с duo_scene.json, `--book --score --freestyle`), `server.py` (:8790, `/api/talk`: Spark + Fish drama-3), `write_score.py` (Opus/Wonder/Spark пишут и «ставят» score), `duo.html` (518 строк three.js: процедурные жесты `limb`, `pick`, `direct`, `stageFrom`, `walkOff`, `buildStreet`, `goDoor`), `index.html` (игрок от первого лица). Тесты: 3 в `test_bugs_server.py`.

Чего из squid_live НЕТ в движке (проверено по `duo.html` и `runtime/stage`):
- процедурные жесты по голосовой ремарке (`pick(who,text,remarks)`: wave/react/facepalm/shrug/armscross/jump/droop) — в движке жесты только клипами cast (`pickClip`) и `life.ts`;
- структурный `stage` в бите партитуры (`DIRECTED[text].stage = [{who, place}]`) — sim пробрасывает `stage` в событие (`sim.py:1194`), но `stage/index.ts` его не читает, ставит людей только `stageRegex` по тексту (L11);
- `walkOff`/переход на улицу через дверь, `buildStreet` (вторая сцена по двери), `goDoor`;
- подписи на дверях (`doorLabel`), «пятно-тень» под актёром (`blob`), текстура «дырочки» (`holes`);
- первое лицо игрока, говорящего с NPC (`/api/talk`);
- режим «книга -> freestyle по кнопке G» ЕСТЬ в движке (`stage/index.ts`), перенесён.
Перенесено в движок: банк мест (в `make/stage.py` из пропов), claims, камера-режиссёр (банк планов), клипы anymove, idle-слой, sight-проба.

### 2.11 tools, app, specs

| файл | что |
|---|---|
| `tools/gate.sh` | гейт tero (см. раздел 6) |
| `tools/ptest.py` | `python3 tools/ptest.py [-j N] [--cwd DIR] module...` — unittest-классы параллельно, один процесс на класс |
| `tools/gate_skip.txt` | список пропускаемых файлов (сейчас пуст, только комментарий) |
| `app/` | IWSDK/WebXR приложение (старое): `src/{splats,dissolve,assets,env,panel,robot*}.ts` 336 строк; не связано с `engine/` кроме статики `app/public` для squid_live |
| `specs/` | `engine-scene.md` (контракт сцены), `2026-10-31-dreamer-make.md` (make), `2026-11-01-engine-anim-camera.md` (А1-А4), `2026-11-01-engine-worlds.md` (ночь 2: Н7-Н15), `tero-*.md` |
| `LESSONS.md` | реестр уроков L1-L33+ со статусами (читать перед новой спекой) |
| `engine/docs/critic.md` | как гонять критика ПО КАРТИНКАМ (референс | снимок) — это критик мира, не фильма; `street.md` — как описывать улицу/двор/дом |

---

## 3. Если тебе нужно X — используй Y

| Нужно | Используй |
|---|---|
| проверить сцену (ошибки/варнинги) | `node --import tsx engine/bin/dreamer.ts check scene.json`; в коде `runCheck` (`check.ts`); из Python `pipe2.engine.Engine.check` |
| собрать dist из scene.json | `dreamer build --out D --assets none\|cache\|live`; `build/write.ts writeDist`; Python `Engine.build` |
| снимки камер сцены | `dreamer shots <dist>` (`build/shots.ts runShots`) -> `dist/shots/<cam>.png`, `sheet.png`; Python `engine.shots_retry` |
| имена файлов снимков | `build/shotnames.ts shotBaseNames`; в pipe2 `room.shot_filenames` |
| предмет по картинке места (вырезать и перерисовать на белом → SAM3D) | `ref: {image, what, mode: "redraw"}` у `object` в сцене; `ImageProvider.fromRef` (`MuseImageProvider.fromRef` = `edit` на `/v1/images/edits`); в pipe2 — `floor.py attach_refs` |
| предмет прямо из кадра места по маске (SAM 3 → SAM3D, без перерисовки) | `ref: {image, what}` (mode `mask` по умолчанию); `ObjectProvider.fromScene`; в pipe2 — `ModalMesh.from_scene` / `AssetQueue` (`SEG_APP`), фейки `FakeSegmenter`/`FakeSam3D`/`FakeSceneMeshes` |
| кэш-ключ ассета | `assets/cache.ts cacheKey(kind, prompt, aspect, ref?)`; из Python только через `pipe2/keys.ts` (`Engine.asset_keys`) |
| пути файлов кэша ассета | `cachePaths(dir, key)` |
| цена/потолок денег (engine) | `assets/cost.ts Budget`, `priceCents`, `CapError` |
| потолок денег (pipe2) | `pipe2/ledger.py Ledger.allow/charge/settle` |
| резерв меша, который ждёт идущие меши вместо `cap` (pipe2) | `pipe2/assets.py AssetQueue._mesh_allow/_mesh_charge` поверх `Ledger.reserve` |
| потолок денег (dream) | `dream/llm.py set_cap / get_spent / _charge / charge_fish / charge_image` |
| вызов Spark с ретраем JSON (make brief) | `make/brief.py make_brief(prompt, ask)`: 1 ретрай с текстом ошибки валидации |
| вызов Spark (pipe2: транспорт, ретраи сети, резерв токенов) | `pipe2/spark.py Spark(transport, ledger).ask(role, room, round, messages, effort)`, транспорт `HttpTransport` |
| разобрать JSON из ответа модели | `pipe2/spark.py parse_scene`; в dream `author._json`, `dialogue` ? |
| вызов LLM по роли в dream (hero/actor/judge/narrator/director) | `dream/llm.py call(role, system, messages)` |
| выбрать модель/effort по роли | `llm.ROLE_TABLE`, `llm.resolve(role)`, `llm.set_talk_model` |
| Fish TTS (реплика -> wav) | `dream/voice.py Voice.synthesize(text, label, out_path)`; ключ `voice.fish_key()` |
| длительность wav | `voice.wav_seconds(path)`; оценка без аудио `sim.line_duration` |
| убрать теги `[..]` из текста для пауз | `voice.strip_tags` |
| голос по роли/имени | `dream/voices.json` + `voice.load_pool`, `character_reference_id` |
| картинка Muse Image (TS) | `assets/providers/muse-image.ts MuseImageProvider` |
| картинка Muse Image (Python, пакет) | `pipe2/assets.py MuseImage`; для dream `dream/images.py Images` |
| меш SAM3D (из движка по HTTP) | `assets/providers/sam3d.ts Sam3dProvider` |
| меш SAM3D (Modal, параллельно на N GPU) | `pipe2/assets.py ModalMesh`/`AssetQueue`; `h0/sam3d_modal.py` |
| прогрев GPU | `pipe2/gpu.py GpuWarmth` |
| фейковые провайдеры для тестов (engine) | `assets/providers/fake.ts` (`FakeImageProvider`, `FakeObjectProvider`, `fakePng`, `fakeGlb`); `engine/test/fake-shots.ts`; `test/helpers/{scene,broken,timing}.ts` |
| фейки для тестов pipe2 | `pipe2/fakes.py` (`FakeSpark`, `FakeEngine`, `ScenarioSpark`, `FakeAutoscaler`, `synthetic_task`) |
| фейки для make | `make --fake`, `make/testdata/world_run` (готовый мир), `testdata/cast`, `refs/fake.py`, `testkit.OfflineTransport`, `brief.ScenarioBrief` |
| фейки для dream | `dream/fake.py FakeTransport(script, reply, gate)`, `voice.fake_transport`, `images.fake_transport` |
| хеш входа этапа make | `make/core.py input_hash(stage, version, params, inputs)` |
| хеш сцены в pipe2 (мемо проверок) | `pipe2/engine.py _scene_hash` |
| демо-сцена в тестах движка | `specs/examples/demo-flat.scene.json` + `test/helpers/scene.ts demoFlat/patched` |
| путь по навмешу (рантайм, стадия) | `runtime/stage/path.ts findPath` / `findStageRoute` (с рампами и дверями) |
| путь по навмешу (check, `routes[]`) | `routes/astar.ts findRoute`, `findRouteLevels` |
| проходима ли точка | `nav/grid.ts isWalkable`, `isWalkableMask(open\|closed)`; в Python `make/stage.py _Nav` |
| привязать точку к ближайшей проходимой | `routes/astar.ts nearestWalkable`; Python `make/stage.py _Nav.snap` |
| уровень (этаж) по высоте ног | `nav/floor.ts floorAt / levelY`; комната под точкой `runtime/stage/places.ts floorAt(floors,p,level)` |
| точка в полигоне | `nav/floor.ts pointInPoly` (TS), `pipe2/geom.py in_room` (Py) |
| место в банке мест | `runtime/stage/places.ts` типы + `resolveTouch`; построить банк `make/stage.py build_places` |
| фраза «X идёт к Y» -> кто и куда | `places.ts stageRegex(places, cast)` |
| подойти к объекту/месту | `stage/touch.ts createToucher(...).touch`, события `touch` в bridge |
| занятое место | `places.ts Claims`, `resolveTouch` (встаёт сбоку `SIDE_M`), `releaseClaim` |
| сесть (поза) | `Actor.go(path, yaw, "sit")` (`SIT_DROP 0.45`) |
| найти кость по имени | `Object3D.getObjectByName` (так делает `anim.ts`); кандидаты имён `life.ts PICK`; регэкспы `anim.ts ARM`, `ROOT` |
| ретаргет клипа на скелет | `anim.ts createAnimator` (по имени кости, срезает калибровочный кадр) |
| кроссфейд клипа | `Animator.play(name)` / `Animator.idle()`; параметр `fade` |
| клип по тексту реплики | `anim.ts pickClip` / `clipForBeat` (+ `cast.verbs`) |
| проверить cast.json/GLB/клипы | `make/cast.py check_cast` |
| процедурное дыхание/взгляд/кивки | `stage/life.ts createLife`; включается в `createAnimator(..., {life:true})` |
| выбрать план камеры/склейку | `stage/director.ts createDirector().step(...)` |
| зажать камеру в комнату | `stage/camera.ts clampCamera / snapInside / roomRect` |
| проекция в кадр / влезает ли в кадр | `director.ts` считает `hfov/tanH/tanV` по `fov`, `aspect` (около стр. 485); отдельной общей `project()` нет |
| мешает ли мебель обзору | `stage/sight.ts createSight(world, skip)` |
| начальные повороты актёров | `director.ts initialYaws` |
| субтитры | `stage/subs.ts createSubs` (подписи + озвучка), `audioUrl` |
| связь sim <-> страница | `runtime/bridge.ts createBridge/connectSim/simPost`; SSE `/events` в `dream/server.py` |
| запись фильма | `python3 -m make.film runs/<id> --out f.mp4` (`record.mjs` + ffmpeg) |
| сыграть сцену make-прогона | `python3 -m make.play runs/<id> [--fake]` |
| партитура сцены из книги | `dream/book.py score_scene(dir, scene_id)`; руками править -> `story/score.edited.json` |
| разбить рассказ на предложения | `book.split_narration`, `split_paras` |
| определить кто говорит в абзаце | `book._para_beats` (`_from_tag`, `_by_position`) |
| список объектов/имён в тексте | `dialogue.find_objects`, `names_in`, `remarks` |
| обработать ввод игрока | `dream/inputs.py sanitize`, `resolve_touch` |
| стоп-фразы безопасности | `dream/safety.py match` |
| модель памяти директора | `dream/memory.py Memory` |
| карта связей комнат | `openings/graph.py roomGraph`; для книги — вручную (L23) |
| нормализовать GLB (перёд на +Z, низ в 0) | `assets/glb.ts normalizeGlb` (поворот только по авторскому `front_deg`) |
| число треугольников GLB | `assets/tris.ts glbTriangles` |
| урезать меш под бюджет пропа | `assets/cut.ts cutGlb` (в сборке: `build/write.ts cutPlaced`) |
| размер/класс пропа | `budget.ts propClass`; категории `props/cats.ts CATS` |
| пересечение объектов (OBB) | `geom/obb.ts obbIntersects`, `obbPolyIntersects` |
| дуги/кривые стены | `geom/arc.ts arcFromBulge`, `discretizeArc` |
| вид сверху плана | `report/topsvg.ts topSvg` -> `dist/top.svg` |
| параллельный пул с лимитом | `assets/batch.ts pool` (TS); `AssetQueue` / `ThreadPoolExecutor` в pipe2 |
| тесты python параллельно | `tools/ptest.py` |
| правило цен/кто платный | `pipe2/prices.json`, `test_paid_model.py` (охранный тест от платной модели) |
| деньги на оценку Spark-вызова | `pipe2/spark.py reserve_of`, `text_chars`, `n_images` |
| единый отчёт о сбое провайдера | `dream/diagnostics.py report` |
| ожидание зрителя перед игрой | `make/play.py _wait_for_viewer`, `play(wait_viewer=True)` |
| refs: лицензии | `make/refs/_common.py usable()` |
| рефы книги локально | `make/refs/__init__.py book_local` |

---

## 4. Дубли и почти-дубли

| что | место 1 | место 2 | заметка |
|---|---|---|---|
| поиск пути по растру nav | `engine/src/routes/astar.ts:162 findRoute` (A*, check/routes) | `engine/src/runtime/stage/path.ts:12 findPath` (BFS, рантайм сцены) | разные алгоритмы и разные снапы; обе знают nav-слои и рампы |
| привязка точки к проходимой клетке | `routes/astar.ts` `nearestWalkable` / `nearestWalkableAny` | `h0/make/stage.py:35 _Nav` / `:51 snap` (Python-копия nav-логики, `SNAP_R=1.0`) | Python перечитывает nav.json самостоятельно |
| точка в полигоне | `nav/floor.ts:10 pointInPoly` | `pipe2/geom.py:91 in_room`; `pipe2/floor.py:51 _contains` | Py-копии TS-геометрии |
| площадь полигона | `geom/poly.ts:4 signedArea` | `build/slab.ts:8 signedArea2` | две копии в TS |
| EPS | `geom/vec.ts` `EPS`, `schema/parse.ts:4`, `schema/refs.ts:4` | — | три объявления `EPS = 1e-6` |
| дуга/край комнаты | `props/place.ts` (`AuthorEdge`, `edgePoint`...) | `plan/rooms.ts:9 AuthorEdge`; `pipe2/floor.py:69 _edge_center`, `:63 _on_circle` | `AuthorEdge` объявлен в двух TS-файлах; Py-копия |
| валидатор glTF/GLB | `engine/src/assets/glb.ts:136 readGlb` | `h0/make/cast.py:65 _gltf_doc_ok`, `:136 _glb_ok` | Py проверяет чужие GLB (cast), TS читает SAM3D |
| «куда смотрит фронт» / yaw | `runtime/stage/places.ts:36 yawTo` (0=+Z, 90=+X) | `make/stage.py:22 _front` | одна конвенция, два кода |
| клиент Spark | `pipe2/spark.py:42 HttpTransport` (contributor, ретраи, резерв токенов) | `dream/llm.py:303 _post` + `RealTransport`; `squid_live/server.py:67 _post`; `live/rt.py` | четыре HTTP-клиента Meta/Baseten |
| ключи | `dream/llm.py:225 _baseten_key`, `voice.py:68 fish_key`, `images.py:26 _image_key` | `squid_live/server.py:76 _baseten_key`, `:115 _fish_key`; `live/rt.py` из `gate_test.fish_key` | читают .env каждый по-своему |
| Fish TTS | `dream/voice.py:129 real_transport` (drama-3) | `squid_live/server.py:124 speak`; `live/rt.py` (PCM stream); вне repo `career/orchestration/tg.py` (s2-pro, Гаврилов) | разные модели: dream = `drama-3`, tg.py = `s2-pro` |
| Muse Image | `engine/src/assets/providers/muse-image.ts:40` (`muse-image-1`, api.meta-models.ai) | `pipe2/assets.py:71 MuseImage` (`muse-image-1.0`, api.meta.ai); `dream/images.py:37`; `h0/gen_images.py` | разные endpoint и имена моделей |
| SAM3D | `engine/src/assets/providers/sam3d.ts:17 Sam3dProvider` (HTTP meta-models) | `pipe2/assets.py:108 ModalMesh` (Modal `dreamer-sam3d`); `h0/world/twelve_oaks/sam3d_par.py` | боевой путь pipe2 = Modal; engine HTTP-провайдер = путь `--assets live` |
| учёт денег | `engine/src/assets/cost.ts:39 Budget` (центы) | `pipe2/ledger.py:24 Ledger` (usd/calls/tokens); `dream/llm.py:135 _charge`; `make/core.py Ctx.spend` | четыре счётчика, не связаны |
| выбор жеста/клипа по тексту | `runtime/stage/anim.ts:378 pickClip` | `squid_live/duo.html:205 pick` (по ремарке голоса); `dream/dialogue.py:433 remarks` | pick из squid в движок не перенесён |
| «кто куда идёт» по тексту | `places.ts:94 stageRegex` | `squid_live/duo.html:329 stageFrom` (+STAGE регэкспы) | движок взял регэксп, структурное поле `stage` не читает |
| камера-режиссёр | `runtime/stage/director.ts:140 createDirector` | `squid_live/duo.html:251 direct`; `engine/src/runtime/cams.ts` (камеры сцены) | squid — исходник идеи |
| поиск объектов в тексте | `dream/dialogue.py:492 find_objects` | `places.ts stageRegex`; `make/refs` не связан | русские/английские имена: разные регэкспы |
| длительность реплики | `dream/sim.py:151 line_duration` | `voice.py:45 wav_seconds`; `record.mjs` берёт `dur` из события | — |
| карточка места из пропов | `make/stage.py:109 build_places` (Py, из geometry+scene) | `places.ts` (TS читает результат) | банк строится на стороне Python, рантайм только читает |
| fake-провайдеры | `engine/src/assets/providers/fake.ts`, `engine/test/fake-shots.ts` | `pipe2/fakes.py`, `dream/fake.py`, `make/testkit.py`, `make/refs/fake.py` | пять независимых наборов |
| SSE-сервер/просмотрщик | `dream/server.py` | `squid_live/server.py`, `live/server.py` | три сервера |

---

## 5. Чего нет (проверено grep по `engine/src` и `h0`)

| что | статус | где частично |
|---|---|---|
| поза лёжа / стоять на предмете / сидеть на предмете с позой | НЕТ лёжа и стоять-на. Есть только `act: idle\|sit` (`actors.ts`, `SIT_DROP 0.45`) и `Place.kind: sit\|stand\|door`; `make/stage.py` кладёт `bed` в `SIT` (сидит, а не лежит) | L2, спека Н8-Н9 |
| коллизии актёр-актёр | НЕТ. Только `claims` (занятое место, встаёт сбоку `SIDE_M`) и `obstacle` пропов в `path.ts` | L4, Н9 |
| взгляд/внимание на цель (gaze/attention) | НЕТ целевого взгляда. `life.ts` смотрит головой «по сторонам» случайно; `initialYaws` ставит стартовый поворот лицом к ближайшему; `sight.ts` — про камеру, не про актёров | L5, Н11 |
| критик фильма | НЕТ. `make.film` только пишет. Есть критик ПО КАРТИНКАМ мира: `pipe2/prompts/critic_layout.md`, `critic_assets.md`, `engine/docs/critic.md` | L15, Н13 |
| `--lang` | ЧАСТИЧНО. `sim.py --lang en\|ru` и `bank.py --lang` через `dream/lang.py` (подмена английских фраз в правилах). В `make`, `book.json`, голосах Fish языка нет | L21, Н14 |
| `make.book` | НЕТ. Есть `make --book DIR --scene ID` на ОДНУ сцену и `dream/book.py` | L22, Н15 |
| instancing / `InstancedMesh` | НЕТ (grep пуст). `around`-копии пропа — отдельные меши `<id>.<k>` | — |
| определение `front_yaw` у GLB | НЕТ. Только авторский `assets.<id>.front_deg` и `normalizeGlb` | — |
| свет по комнатам | ЧАСТИЧНО. `lights[]` глобальный список (`point` с `pos`, `hemi`), глобальный `style.ambient`; бюджет «не более 2 point на комнату» проверяет `budget.ts budgetIssues`; комнатных групп/ambient на комнату нет | L19 (экспозиция) |
| пространства имён сцен (namespaces) | НЕТ в движке. В pipe2 соглашение: id комнаты-автора с префиксом `<room>_` (`RoomPipeline.prefix`), владельцы в `merge._record_contributor`; одна сцена = один мир | L23 |
| генерация персонажей в make | НЕТ. `cast` — путь A: хост кладёт `cast.json`+GLB в `run/cast.src` | `make/cast.py` |
| авто-риг, mocap-idle | НЕТ (L29, L31) | `life.ts` процедурно |
| структурный бит `stage/gesture/shot` в движке | ЧАСТИЧНО: `gesture`, `shot`, `touch` читаются; `stage` — нет | L11 |
| обход препятствий актёрами | ЕСТЬ в `path.ts` (obstacles из places). Проверка полноты — L13 | — |
| траву не считать преградой для камеры | НЕТ (`sight.ts` считает кочки) | L14, Н12 |
| `legalCameraPoint` | НЕТ одной функции (L16) | `camera.ts snapInside`, `director.ts unblock` |
| автовыбор голоса по персонажу | НЕТ; голос в `book.json cast.<name>.voice` вручную; `author.py` подбирает через поиск Fish | L24 |
| живая стройка во время сцены | НЕТ (М7 в спеке make) | — |
| схема ответа персонажа `{line,gesture,action,place}` | НЕТ (L8) | — |
| расписание занятий NPC без LLM | НЕТ (L7, L10) | — |

---

## 6. Тесты и гейт

Гейт: `sh tools/gate.sh` (из корня meta; <= 1-2 мин по плану). Запускает четыре набора параллельно и печатает зелёные первыми, красные последними:
1. dream: `python3 tools/ptest.py --cwd h0/dream test_*` (unittest, один процесс на класс);
2. make: `python3 tools/ptest.py --cwd h0 make.test_*`;
3. py: `cd h0 && python3 -m pytest -q -n 6 pipe2` + отдельным процессом каждый `h0/live/test_*.py` и `h0/squid_live/test_*.py` (у обоих `test_bugs_server.py`, поэтому порознь);
4. engine: `cd engine && npx vitest run` (`engine/vitest.config.ts`; браузерные тесты `test/browser/*` используют Playwright).
Файлы из `tools/gate_skip.txt` пропускаются (сейчас пуст). Один набор: `cd engine && npx vitest run test/stage-director.test.ts`; `cd h0/dream && python3 -m unittest test_fsm`; `cd h0 && python3 -m unittest make.test_core`; `cd h0 && python3 -m pytest pipe2/test_room.py -q`.

Примерное число тестов (подсчёт `it(`/`def test_`, `.each` и параметры не считал):
| область | файлов | тестов |
|---|---|---|
| engine (vitest) | 79 (из них 10 browser) | ~615 (browser ~34) |
| h0/dream | ~65 | ~614 |
| h0/make | 36 | ~263 |
| h0/pipe2 | 22 | ~240 |
| h0/live | 2 | 3 |
| h0/squid_live | 1 | 3 |

Что чем покрыто: stage/anim/director — `engine/test/stage-*.test.ts` (по модулю один файл); nav/маршруты — `nav`, `routes`, `stairs-nav`, `stage-route*`; ассеты — `assets-cache`, `assets-live`, `glb`, `build-assets`; make — по файлу на стадию + `test_e2e_fake`; sim — `test_sim`, `test_phase*`, `test_bugs_*`, `test_contract_*`. Платные вызовы в тестах запрещены: все провайдеры подменяются фейками; `pipe2/test_paid_model.py` и `h0/dream/test_baseten.py` сторожат модель.

Правила tero (из CLAUDE.md пользователя): muse-игроки только `muse:muse-spark-1.3-contributor`; `muse-spark-1.3` платная. Код: `pipe2/spark.py MODEL`, `dream/llm.py SPARK_MODEL` уже указывают на contributor.
