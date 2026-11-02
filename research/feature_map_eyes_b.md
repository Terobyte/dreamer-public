# Карта кода, полоса B (глаза, ночь 3)

Строки для `research/feature_map.md`; хозяин переносит их коммитом слияния.

## §2 модули

| Модуль | Что делает |
|---|---|
| `engine/src/runtime/stage/clipfacts.ts` | Г4: факты клипа на теле (`clipFacts`: `contact_y`, `face_dir`, `face_yaw`, `head_y`, `lying` по кадрам 0/¼/½/¾), точки кожи (`skinPoints`, `lowestSkinY`), CLI-тело `writeClipfacts(castDir)` → `<cast>/clipfacts.json` |
| `engine/src/runtime/stage/shotplan.ts` | Г8: исполнитель плана съёмки `shotplan/plan.json`: разбор (`parseShotplan`, `parseShotTime`), часы плана (`createShotClock`: `t0`, `B<i>`/`B<i>e`/`END`, активный план), кадр плана (`shotFrame`: `ease`, `shake`, `look` на кость), срез (`cutMeshes`); `stage/index.ts` ставит камеру из плана или из `director.ts` |
| `engine/bin/rec_event.mjs` | Г8: `pickEvent(e)` — поля события для `events.json` (с `beat`); `record.mjs` встраивает его текст в страницу |
| `engine/bin/dreamer.ts clipfacts <cast dir>` | команда: зовёт `writeClipfacts`, печатает предупреждения; её вызывает `h0/make/cast.py run_cast` (ошибка → `CLIPFACTS_FAILED`) |

## §3 нужно X — используй Y

| Нужно | Используй |
|---|---|
| факты клипа (куда смотрит лицо, где кожа касается опоры, лёжа ли) | `clipFacts(root, clip, heightM)` (`runtime/stage/clipfacts.ts`); готовые — `<cast>/clipfacts.json` |
| мировые точки кожи после скиннинга / нижняя точка кожи | `skinPoints(root)` / `lowestSkinY(root)` (`runtime/stage/clipfacts.ts`) |
| подготовить загруженное тело под рост (масштаб `holder`, центр XZ, ноги на 0) | `prepareActorBody(body, heightM)` (`runtime/stage/actors.ts`) |
| выбрать анимацию клипа из GLB (по имени, иначе первая) | `pickAnimation(animations, name)` (`runtime/stage/actors.ts`) |
| клип так, как его играет рантайм (треки по костям, обрезка калибровки, корень на месте) | `prepareClip(clip, root)` (`runtime/stage/anim.ts`) |
| посадить кожу на опору при любой позе | последний параметр `createActor(..., facts)`: `holder.position.y = −contact_y`, плавно за `fade` |
| вести камеру по плану съёмки (вместо правил `director.ts`) | `stage.json` → `shotplan: "shotplan/plan.json"` или `StageCtx.plan`; разбор/часы/кадр — `parseShotplan` / `createShotClock` / `shotFrame` (`runtime/stage/shotplan.ts`) |
| ease плана (`lin`/`io`/`in`/`out`) и детерминированная тряска камеры | `easeOf(name)` / `shakeOf(a, tau)` (`runtime/stage/shotplan.ts`) |
| какие стены/потолок спрятать, чтобы камера видела сквозь них | `cutMeshes(scene, cam, look)` (`runtime/stage/shotplan.ts`; меши по `userData.kind`, его ставит `meshOf` в `runtime/main.ts`) |
| конец сцены книги в рантайме | обработчики `book_end` / `scene_end` (`transition` с `cause: "book"`) в `StageHandlers` (`runtime/bridge.ts`) |
| индекс бита книги в событии | поле `beat` у `line`/`narrator` книжного режима (`h0/dream/sim.py`); в `events.json` — через `pickEvent` (`engine/bin/rec_event.mjs`) |
