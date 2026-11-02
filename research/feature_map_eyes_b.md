# Карта кода, полоса B (глаза, ночь 3)

Строки для `research/feature_map.md`; хозяин переносит их коммитом слияния.

## §2 модули

| Модуль | Что делает |
|---|---|
| `engine/src/runtime/stage/clipfacts.ts` | Г4: факты клипа на теле (`clipFacts`: `contact_y`, `face_dir`, `face_yaw`, `head_y`, `lying` по кадрам 0/¼/½/¾), точки кожи (`skinPoints`, `lowestSkinY`), CLI-тело `writeClipfacts(castDir)` → `<cast>/clipfacts.json` |
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
