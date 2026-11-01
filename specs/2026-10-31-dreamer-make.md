# Dreamer make: всё в одну кучу — по частям или одним промптом

_Версия **v0.6** (2026-10-31), итог цикла критики._ Хозяин: Tero. Исполнитель: tero, ветка `make/one-prompt` (от ветки, куда влита ночь 10-30). Журнал критики — в конце._

## Зачем

Всё нужное уже построено, но живёт кусками: мозг (`h0/dream`: директор, диалог, книга → партитура, фристайл, рассказчик, голос), мир (`h0/pipe2` + `engine/`: комнаты, двор, двери, бюджет, лист «реф | результат»), сцена (`h0/squid_live/duo.py` + `duo.html`: куклы, камера, бронь мест). Склеивает их руками человек, а рефы ищет Claude через фандом-API.

Цель — один конвейер:
- **одним промптом:** `python3 -m make "Jane meets Rochester in Thornfield's library"` → мир, каст, партитура, сцена играется;
- **по частям:** любая стадия запускается отдельно, если её входы на месте; остальное берётся из кэша;
- **во время сцены (М7, после дедлайна):** если фристайл уводит в место, которого нет, оно строится живьём, пока актёры тянут время, а дверь открывается на настоящих 100 %.

**Объём.** Новый движок не пишем, но новой работы много: оркестратор, стадии `brief` и `refs`, банк мест, **режим сцены в рантайме движка** (актёры из GLB, путь по nav, камера, субтитры), `h0/make/play.py`, `book.json` Джейн Эйр, фейки. Хозяин 10-31: объём не режем, всё одним планом tero на день и ночь.

## Решение хозяина 10-31

Сегодня только код и офлайн-тесты на фейках. Ни одного живого вызова (Spark, Muse, Modal, MuAPI, Fish, поиск рефов), даже бесплатного. Живые прогоны — 11-01.

## Принципы

1. **Оркестратор — код, не LLM.** Порядок стадий фиксирован (DAG ниже). LLM (Spark/Wonder) — только внутри стадий. Claude в продукте не вызывается.
2. **Стадия = объявленные входы → выход в своей папке.** Пропуск по хэшу, атомарная публикация (ниже).
3. **Параллельно только то, что независимо:** `world`, `cast`, `story` после `refs`.
4. **Без новых зависимостей.** Новый код — stdlib (`urllib.request`, `json`, `hashlib`, `concurrent.futures`, `zlib`/`struct` для фейковых PNG). Существующий `h0/muapi_3d.py` уже тянет `requests`; новым кодом мы его не расширяем.
5. **Деньги — потолок на стадию**, не общий межпроцессный счётчик (ниже).

## DAG

```
brief ──▶ refs ──┬──▶ world ──┬──▶ stage ──▶ play
                 ├──▶ cast  ──┤
                 └──▶ story ──┘
          world ──▶ check (по флагу --check)
```

| стадия | обязательные входы | выход |
|---|---|---|
| `brief` | промпт (`make.json.prompt`), `book.json` если указан | `brief/brief.json` |
| `refs` | `brief/brief.json` | `refs/refs.json`, `refs/<slot>/*`, `refs/cues.md` |
| `world` | `brief.json`, `refs/` | `world/task/`, `world/run/` (`dist/`, `scene.json`, `events.jsonl`) |
| `cast` | `brief.json`, `refs/` | `cast/cast.json`, `cast/<who>.glb` |
| `story` | `brief.json` (+ книга) | `story/score.json` или `story/seed.txt` |
| `stage` | `world/run/`, `cast/cast.json`, `story/` | `stage/places.json`, `stage/stage.json` |
| `play` (не стадия, команда) | `stage/stage.json` | лог сима, страница движка |
| `check` | `world/run/dist/`, `refs/` | `check/sheet.png` (критик — только `--critic`) |

`--only X` и `--from X` требуют, чтобы входы X лежали на диске с валидным манифестом; иначе — ошибка `missing input: <стадия>/<файл>`, без молчаливого запуска предков.

## Манифест, хэш, публикация

- `make.json`: `{prompt, created, stages: {<id>: {status: ok|failed|running, input_hash, version, started, finished, usd}}}`.
- **`input_hash`** = sha256 канонического JSON (`sort_keys`, без пробелов): `{stage, version, params, inputs: [[relpath, sha256(file)] …]}`. `version` — константа `STAGE_VERSION` в коде стадии (растёт при изменении логики). `inputs` — все файлы из выходных папок предков, отсортированные по пути; `params` — флаги, влияющие на стадию (`--effort`, потолок, `--pick`).
- **Пропуск:** `status == ok` и `input_hash` совпал → стадия не запускается.
- **Публикация:** стадия пишет в `<stage>.tmp/`, после успеха `os.replace` в `<stage>/`, потом обновляется манифест (тоже через временный файл + `os.replace`). Упавшая стадия оставляет `<stage>.tmp/` и `status: failed`; следующий запуск удаляет `.tmp/` и начинает стадию заново.
- **Потомки:** после перезапуска стадии у всех потомков хэш входа меняется сам, и они перезапускаются. `--from X` = принудительно X + все потомки.
- **Один процесс на папку:** `runs/<id>/.lock` через `os.open(O_CREAT|O_EXCL)` с pid; если pid мёртв, лок снимается.

## Деньги

Общего межпроцессного счётчика нет и в этой работе не будет. Есть так:
- `--max-dollars D` делится заранее по стадиям (по умолчанию `brief 2 %`, `refs 3 %`, `world 70 %`, `cast 15 %`, `story 10 %`; флаг `--split`);
- стадия передаёт свою долю в уже существующие ограничители: `pipe2 run --cap-usd <доля> --cap-calls <N> --cap-tokens <N>` (флаги pipe2 необязательные, `pipe2/__main__.py:39`, — оркестратор передаёт все три всегда), `dream.llm.set_cap` (`h0/dream/llm.py`), свой счётчик для MuAPI в обёртке `cast`;
- после стадии её фактические траты пишутся в `make.json.stages.<id>.usd` (из ledger pipe2, `llm.get_spent()`, счётчика `cast`). **Доли фиксированы и не перераспределяются**: `world`, `cast`, `story` идут параллельно, «следующей» стадии нет. Если сумма фактических трат уже ≥ `D`, новые стадии не запускаются (`status: failed`, причина `budget`).
- `--effort` прокидывается в pipe2 как есть: `role=high|medium|max`, роли `architect, architect_fix, builder, fix, critic_layout, critic_assets, seam_fix` (`pipe2/__main__.py:61`).

## Папка прогона

```
runs/<id>/            # в .gitignore
  make.json  .lock
  brief/brief.json
  refs/refs.json  refs/cues.md  refs/<slot>/<n>.png|jpg
  world/task/ (TASK.md, cues.md, refs/ — формат anymove/runs/pineapple/task/)
  world/run/  (выход pipe2 run как есть: scene.json, dist/, events.jsonl …)
  cast/cast.json  cast/<who>.glb
  story/score.json | story/seed.txt  [+ story/score.edited.json — правка хозяина]
  stage/places.json  stage/stage.json
  check/sheet.png
```

## Стадии

### `brief` — промпт → план
Один вызов Spark через `pipe2/spark.py` (JSON-режим), ответ проверяет код по схеме `make/schema/brief.json`; невалидный → один повтор с текстом ошибки → `failed`.
Поля: `title`, `mode` (`book` | `seed`), `book` (`{dir, scene}` или `null`), `style` (одна строка для всех картинок), `places[]` (`id` `[a-z0-9]+`, `type` `room|yard`, `size_m` `[w, d]`, `level`, `next_to[]`, `query` — строка поиска рефов, `provider_hint` `commons|fandom|any`, `fandom_wiki` или `null`), `cast[]` (`who`, `sex` `male|female`, `age` `child|adult|old`, `look`, `voice` — **ключ из `h0/dream/voices.json`**, схема даёт enum этих ключей, `query`), `scene` (`where` — id места, `who[]`, `want`).
С книгой: `cast` (имена, `sex`) и места сцены берутся из `book.json`, Spark только дописывает `look`, `query`, `voice`, `size_m`. Конфликт имени или пола с `book.json` — ошибка схемы.

### `refs` — найти и отобрать картинки
Провайдеры `make/refs/` на stdlib, интерфейс один: `search(query, n) -> [Candidate]`, `Candidate = {url, page_url, provider, title, width, height, license, license_url, author, usable_for_submission}`.

| провайдер | ключ | когда | `usable_for_submission` |
|---|---|---|---|
| `commons` (MediaWiki API, `prop=imageinfo&iiprop=url|size|extmetadata`) | нет | реальные места, эпоха, костюмы, портреты | `true`, если `LicenseShortName` ∈ {Public domain, PD-*, CC0, CC BY *, CC BY-SA *} |
| `fandom` (тот же клиент, хост `<wiki>.fandom.com`) | нет | вымышленные и мультяшные миры | всегда `false`: фан-вики, только как реф |
| `openverse` (`api.openverse.org/v1/images/`) | нет | запасной | по полю `license` по тому же списку |
| `tavily` (`POST api.tavily.com/search`, `include_images`) | `TAVILY_API_KEY` | последний запасной; без ключа выключен | всегда `false` |

- Порядок: `provider_hint` → остальные по таблице сверху вниз, пока не набрано 12 кандидатов на слот.
- Скачивание параллельно (`ThreadPoolExecutor`, до 8), фильтр: короткая сторона ≥ 512 px, тип PNG/JPEG по сигнатуре байтов; остальное (WebP, SVG, GIF) — отбрасывается, без конвертации (конвертировать WebP без библиотек нечем).
- **Отбор `--pick first|vision`, по умолчанию `first`:** первые 3 кандидата по порядку провайдера и размеру. `vision` — один вызов Spark на слот через `pipe2/spark.py` (умеет `image_url`, `spark.py:119`), до 6 картинок, ответ `{"keep": [i…], "cues": "…"}`; поддержка картинок моделью проверяется живьём 11-01, до этого `vision` есть только на фейке.
- `cues.md`: с `vision` — признаки от Spark; с `first` — заголовки и описания со страниц (`title`, `extmetadata.ImageDescription`) по слотам.
- `refs.json` пишет **все** кандидаты с полями выше и `kept: bool`. Рефы в продукт не попадают никогда; в видео и сабмит (лист «реф | результат») — только `usable_for_submission: true`, лист с другими рефами помечается `private`.
- Личное место без рефов: `query: null`, слот пустой, признаки — из `look`/слов пользователя; `check` его не сравнивает.

### `world` — мир
Адаптер `brief + refs → world/task/` (TASK.md по шаблону `anymove/runs/pineapple/task/TASK.md`: места, размеры, соседи, уровни, `style`, правило «без имён»), затем `python3 -m pipe2 run world/task --run-dir world.tmp/run --cap-usd … --cap-calls … --cap-tokens … [--effort …]`. pipe2 и engine эта стадия не меняет.
- **Исключение из правила публикации:** упавший `world` **не** удаляет `world.tmp/`, а следующий запуск продолжает его с `--resume` (`pipe2/__main__.py:51`): оплаченные картинки и меши не выбрасываются. Удалить можно только явным `--from world --fresh`.
- Флаги `--cap-*` у pipe2 не обязательные (`__main__.py:39`): оркестратор передаёт **все три** всегда; тест проверяет argv.

### `cast` — персонажи
- `cast.json`: `{who: {glb, voice, sex, look, height_m}}`; `voice` — **метка** из `voices.json` (`Voice` ищет по метке, `voice.py:167`), не id.
- **Путь A (MVP):** `cast.json` и GLB кладёт хозяин руками; стадия проверяет файлы (GLB читается, `height_m` ∈ [0.5, 2.5], `voice` ∈ `voices.json`).
- **Путь B:** картинка персонажа (Muse Image по `look`, без имён) → `h0/muapi_3d.py <slug> <out> <png>` подпроцессом (`--cast-slug`, ключ читается при импорте, `muapi_3d.py:8`, — никогда не импорт в тестах). В фазы этой ночи путь B не входит.

### `story` — сцена
- `mode: book`: `story/score.json` = `book.score_scene(dir, scene)` (`book.py:332`); `story/score.edited.json` (правка хозяина) с той же `scene` важнее; другая `scene` — ошибка.
- `mode: seed`: `story/seed.txt` — одна строка (`sim.py:2002`).
- **Книга → фристайл** как есть: `POST /freestyle` → `Sim.go_freestyle` (`sim.py:1186`), флаг `--freestyle`.
- **Джейн Эйр.** `h0/dream/books/jane-eyre/` пока без `book.json` (только `jane-eyre.txt`, `excerpts/`, `SOURCE.md`). Фаза М3 добавляет `book.json` на **главу XIII** (чай с Рочестером в гостиной Торнфилда): `pov: "Jane Eyre"`, каст `Jane Eyre` (female, `woman`), `Edward Rochester` (male, `man`), `Mrs. Fairfax` (female, `old_woman`), `Adèle` (female, `child`); `aliases` включают `I` → `Jane Eyre` и `me` → `Jane Eyre` (повествование от первого лица: `said I`, `I replied`); границы абзацев сцены — по тексту файла, их проверяет `load_book`. Приёмка: `python3 book.py books/jane-eyre --scene <id> --stats` даёт ≥ 20 битов `line`, доля `unattributed` ≤ 40 %. Голос рассказчика для книги от первого лица — поле `narrator_voice` в `book.json` (метка, по умолчанию прежний `old_man`, `sim.py:206`); для Джейн Эйр — `woman`.

### `stage` — банк мест
**Адаптер `world/run/ → stage/places.json`** (Python):
- **позиция и поворот** — из `dist/geometry.json` → `meshes[]` с `kind: "prop"`: у GLB-предмета `glbPos` `[x, y, z]` и `glbYaw` — **в радианах** (`Math.atan2`, `engine/src/build/props.ts:46`), адаптер переводит в градусы `yaw = degrees(glbYaw) mod 360`; у плейсхолдера — центр AABB его `positions` и `yaw` из `scene.json` (градусы). Тест: один и тот же предмет в фикстуре с GLB и без даёт одинаковые `yaw` (± 1°) и точку места (± 0.05 м). Так покрыты и предметы без `at` (`mount`/`on`/`around` и копии `id.0`, `id.1`) — у них есть меш;
- **размер** `{w, d, h}` — `size` из `scene.json` (у копий — `size` исходного `id`); `fact` из `build.json` не используется (бывает в разы больше авторского);
- **комната** — `meshes[].room`; **высота комнаты** — `scene.json.rooms[].height`;
- `solid: false` (ковёр, подушка) → места нет и препятствия нет; `on`/`mount` (лампа на столе, картина на стене) → места нет (`stand`-место даёт опорный предмет), препятствия нет;
- **вид места** `kind` по последнему слову `id` после `room_`: ∈ {sofa, couch, chair, armchair, bench, bed, stool, seat} → `sit`; иначе `stand`;
- **перед** предмета — направление `yaw` (0° = +Z, 90° = +X, как `engine/src/nav/floor.ts`); точка места = центр + перед · (`d/2 + 0.45`) (`sit`: `d/2 − 0.1`), затем ближайшая проходимая клетка `nav.json` того же уровня в радиусе 1 м, иначе места нет, предупреждение;
- `name` — последнее слово `id` (`living_armchair` → `armchair`), при повторе в сцене — с комнатой (`library armchair`), при повторе и так — суффикс ` 2`;
- `obstacle` — осевой bbox прямоугольника `w × d`, повёрнутого на `yaw`, только для `solid` ≠ `false`;
- **двери** из `build.json.doors[]` (`DoorJson`, `engine/src/build/doors.ts:132`): центр проёма `c = (hinge_at + closed_end) / 2`; `u = (open_end − hinge_at) / width` — единичный вектор в комнату, куда открывается створка (`swing`, или `rooms[0]` при `swing: null`); точка места = `c + u · (width + 0.3)` (за дугой створки), `room` = эта комната, `name` = `<room> door`, `kind: door`, `look` = `c`. В фикстуре — числовой пример с проверкой.

`stage/stage.json`: `{dist: "world/run/dist", places: "stage/places.json", cast, mode, book: {dir, scene, score} | null, seed | null, objects: [name…], voices: {label: reference_id}, narrator_voice, start: {who: place_name}}`. `voices` — пул меток для `Voice(pool=…)`.

### `play` — сим + сцена в движке

**Хозяин сцены — страница движка (`dist/index.html`), не `duo.html`.** `duo.html` зашит под круглую комнату R = 4.2 в нуле, Сквидварда с клипами и Губку Боба из коробок (`duo.html:82,89,194,231,264,275`), его сервер не стартует без папки H16 (`server.py:20`). Страница движка уже умеет нашу комнату: стены, свет из `geometry.lights` (`main.ts:176`), проходимость `nav`, двери, мост к симу по SSE (`bridge.ts: connectSim`, `main.ts:227–234`). Поэтому `duo.html` и `buildWorld` в этой работе **не трогаются**, а в рантайм движка добавляется режим сцены.

**Сим (`h0/make/play.py`, новый; `duo.py` не меняется):**
- `sim.run` получает новый необязательный аргумент `plan=None`: если передан, `run` не вызывает `_load_book_plan` сам (`sim.py:1818–1821`), а берёт этот план. Без `plan` — как сейчас.
- `mode: book` → `plan = sim._load_book_plan(book.dir, [book.scene], book.score)`; у каждой сцены плана `dict["objects"] = stage.objects`; `sim.run(plan=plan, book=book.dir, scenes=[book.scene], score=book.score, profile=None, label="make_book", freestyle=…, media=…, serve=port)`.
- `mode: seed` → новая `sim.seed_start(text, transport, objects) -> (scene_dict, first_events)` — вынос кода из `main` вокруг `_seed_first_scene` (`sim.py:2100–2115`) без изменения поведения `main`; имя **не** `seed_scene` (так называется импорт из `director`, `sim.py:24`). `objects` сцены директора заменяются на `objects` места. Затем `use_scene(scene_dict)` и `sim.run(profile=None, label="make_seed", first_events=…, dialogue=Dialogue(…), media=…, serve=port)` — по образцу ветки seed в `main` (`sim.py:2108–2138`). `profile=None` обязательно: по умолчанию `run` берёт душу профиля A.
- **Без переходов:** в MVP мир один. `sim.run` получает `no_build=True` → `BuildFSM.start_build` возвращает событие `invalid` с `reason: "no_build"` и состояние не меняет; директор продолжает сцену на месте. Без флага — как сейчас.
- голоса: `Voice(pool={**load_pool(), **stage.voices})`, рассказчик — `narrator_voice`.
- `--fake`: `sim.run(fake=True)`; для `seed` — `FakeTransport` (`dream/fake.py`); для фристайла — сценарный `Dialogue`-фейк, у героя строка с `[[TOUCH:<name>]]` (тег героя, `dialogue.py:94`).
- статика: `play.py` поднимает `http.server` (stdlib) на `runs/<id>/` и печатает адрес `http://127.0.0.1:<p>/world/run/dist/index.html?sim=http://127.0.0.1:<port>&stage=../../../stage/stage.json`.

**Сцена в рантайме движка (`engine/src/runtime/stage/*.ts`, новый код):** включается только параметром `?stage=`; без него страница работает как сейчас (игрок ходит сам).
- `places.ts` — чистые функции: `resolveTouch({places, claims, actor, name, clips}) -> {place, target, yaw, act} | {skip: "unknown" | "already_there"}` и `stageRegex(places)` (правила ниже);
- `path.ts` — путь актёра BFS по клеткам `nav.json` (тот же формат слоёв, что читает `makeWalker`, `main.ts:188–195`), с учётом дверей (`nav.doors`) и `obstacle` мест;
- `actors.ts` — актёр из `cast/<who>.glb` через `loadGlb` (`runtime/assets.ts:109`, пути от `stage.json`), масштаб — по `height_m`; движение процедурное: покачивание при ходьбе, кивок и лёгкий наклон, пока звучит его реплика; `sit` = опуститься на 0.45 м в точке места (клипов нет);
- `camera.ts` — режиссёр камеры по правилам `duo.html` (общий план / двое / крупно говорящего), но границы — из прямоугольника комнаты актёра (`geometry.floors[].outline`, отступ 0.3 м) и высота ≤ `rooms[].height − 0.3`; камера игрока в режиме сцены выключена;
- `subs.ts` — субтитры и голос: строки SSE `line`/`narrator` → текст и `Audio` по `r.audio` (как `duo.html`), имя — из `r.who`;
- мост: `createBridge` получает обработчики `line`, `narrator`, `touch`; прочие типы — как сейчас (`warn`).
**Контракт `touch`:** `touch` в строке героя (`[[TOUCH]]`, фристайл/seed) → `resolveTouch`; книжные ремарки рассказчика → `stageRegex` (регэксп по `name` места, длинные имена раньше коротких, плюс имена каста: «Mr. Rochester sat in the armchair» → Рочестер → `armchair`) → `resolveTouch`. Правила `resolveTouch`: неизвестное → `skip: unknown` + `console.warn`; уже на месте → `skip: already_there`; свободно → `target = place.at`, бронь; занято другим → `target = place.at + 0.8 м` вбок перпендикулярно `yaw` (сторона ближе к актёру), `act: idle`, бронь не меняется; `sit` → `yaw = place.yaw`, `act: sit`; `stand`/`door` → смотреть на `look`, `act: idle`.
**Фиксированные ожидания (без вызова `resolveTouch` в тесте).** В фикстуре `world_run/` у кресла `living_armchair` известные `at`/`yaw`; тест `h0/make/testdata/expect_touch.json` хранит заранее посчитанные числа:
  1. герой `Edward Rochester`, строка с `[[TOUCH:armchair]]` → `place: "armchair"`, `target` = числа из файла (± 0.05 м), `yaw` = `yaw` кресла (± 2°), `act: "sit"`;
  2. затем `Jane Eyre` с `[[TOUCH:armchair]]` → `place: "armchair"`, `target` = числа «в 0.8 м сбоку» из файла, `act: "idle"`, бронь у Рочестера;
  3. ремарка рассказчика «Mr. Rochester rose and went to the window» → `stageRegex` даёт `{who: "Edward Rochester", place: "window"}`;
  4. `[[TOUCH:piano]]` (нет в сцене) → `skip: "unknown"`, актёр не двигался.
  Эти же 4 случая — в vitest `places.ts` и в браузерном тесте (позиция и поворот актёра через `window.__dreamer` сравниваются с числами файла, а не с выводом `resolveTouch`).
**Проверки:** vitest-юниты `places.ts`, `path.ts`, `camera.ts` (границы); **браузерный тест** в `engine/test/browser/` (playwright уже есть, `page.test.ts`, `serve.ts`): страница фикстуры с `?stage=` и фейковым SSE-сервером, проигрывающим записанный `log.jsonl` (2 реплики, 1 `touch`, 1 ремарка) → число актёров = касту; после каждого из 4 случаев `expect_touch.json` актёр через ≤ 10 с стоит в ≤ 0.3 м от ожидаемой точки и повёрнут ± 10° от ожидаемого `yaw` (через `window.__dreamer`); камера внутри комнаты и ниже потолка на каждом кадре; без `?stage=` прежние браузерные тесты зелёные.

### `check` — проверка
`dreamer check <scene> --built <dist>` + `dreamer shots` уже есть в движке; стадия вызывает их и копирует `sheet.png`. Критик по картинкам — только `--critic`, платный.

## Фейки для офлайн-прогона (`--fake`)

У pipe2 фейки нарочно падают на картинках и мешах (`pipe2/fakes.py:132`), `dream/fake.py` — только транспорт диалога. У движка есть `fakeGlb`/`fakePng` (`engine/src/assets/providers/fake.js`).

| внешний вызов | фейк |
|---|---|
| ref-провайдеры | записанные JSON-ответы API в `h0/make/testdata/refs/` + 3 маленьких JPEG/PNG (≥ 512 px) |
| Spark (`brief`, `vision`) | сценарный транспорт по образцу `ScenarioSpark` (`pipe2/fakes.py`) |
| pipe2 целиком | фикстура готового `world/run/` в `h0/make/testdata/world_run/`: `scene.json` на 2 комнаты (одна дверь со створкой, ≥ 5 предметов: диван, кресло, стол, лампа `on` стол, ковёр `solid:false`), `dist/` от реального билда движка с `fakeGlb`/`fakePng`, `events.jsonl` на 3 строки. Собирается скриптом `h0/make/testdata/build_world_run.sh`, в `.gitignore` — исключение `!h0/make/testdata/**/dist/` |
| каст | `h0/make/testdata/cast/` — `cast.json` + 2 GLB от `fakeGlb` |
| sim / голос | `sim.run(fake=True)` как в `test_freestyle.py`; `FakeTransport`; сценарный `Dialogue` с `[[TOUCH]]` |

**Как `--fake` подменяет стадии.** `--fake` входит в `params` → в `input_hash`. С `--fake`: `world` пишет `world/task/` настоящим адаптером и копирует фикстуру вместо `pipe2 run`; `brief`, `refs`, `story` получают сценарный транспорт; `cast` — путь A на фикстуре.
**Сквозной тест М6:** `python3 -m make "<промпт из фикстуры>" --fake --run <tmp>` → все стадии кроме `check` `ok`; `stage.json` по схеме; каждый `name` из `objects` есть в `places.json`; повторный запуск ничего не запускает; запуск без `--fake` в ту же папку перезапускает всё (тест на argv, без сети); `play.py --fake` в режимах `book` и `seed` пишет первую строку в `log.jsonl`, в `seed` — строку с `touch: "armchair"` (сценарный ответ из фикстуры), в `book` — ремарку рассказчика из `expect_touch.json` случай 3.

## CLI

```
python3 -m make "<промпт>" [--book h0/dream/books/jane-eyre --scene <id>]
python3 -m make "<промпт>" --until refs
python3 -m make --run runs/<id> --only world | --from story [--fresh]
python3 -m make --run runs/<id> --play [--freestyle]      # h0/make/play.py
  --max-dollars 5 [--split world=70,cast=15,…]  --effort builder=medium  --pick first|vision  --check  --critic  --fake
```
`runs/` — папка `meta/runs/`, добавляется в `.gitignore` этой работой.

## Фазы для tero

Один план, все фазы подряд (день и ночь 10-31). Игроки фазы: Sonnet ×1 → Muse ×6 → Opus ×1 (8 раундов). Общие правила как в `specs/tero-pipe2.md`: сеть в тестах запрещена (`urllib.request.urlopen` → `AssertionError`, как в `test_freestyle.py`), сначала красный тест. Код — `h0/make/` (пакет `make`, `cd h0 && python3 -m make`) и `engine/src/runtime/stage/`. **Проверка каждой фазы:** `cd h0 && python3 -m unittest discover -s make -q` зелёный; `cd h0/dream && python3 -m unittest -q` и `cd engine && npx vitest run` (включая `test/browser/`) не краснее, чем до фазы.

**Объём не урезается (решение хозяина 10-31).** Тесты каждой фазы опираются только на уже сделанное: где нужна ещё не написанная стадия — заглушка.

**М0. Каркас + DAG + манифест** (стадии — заглушки, пишущие файл-маркер).
- [ ] `make.json`, `input_hash` по формуле, пропуск при совпадении, перезапуск при изменении входного файла или `STAGE_VERSION`;
- [ ] падение стадии → `.tmp/` и `failed`, повтор удаляет `.tmp/` (кроме `world`: остаётся для `--resume`); `--from X` перезапускает X и потомков, не трогает предков;
- [ ] `--only stage` без `world/` → `missing input: world/…`, ничего не запущено;
- [ ] три заглушки `world`/`cast`/`story` по 0.3 с → пересекаются по времени;
- [ ] лок: второй процесс → ошибка; лок мёртвого pid снимается;
- [ ] доли `--split` и остаток бюджета; `runs/` в `.gitignore`.

**М1. brief.** Схема `brief.json`, enum меток голосов из `voices.json`, повтор на невалидный ответ, слияние с `book.json` (тест на `books/gwtw`: имена и пол из книги, конфликт → ошибка).

**М2. refs.** Четыре провайдера на фикстурах; лицензии Commons (`CC BY-SA 4.0` → `true`, `Fair use` → `false`); fandom и tavily → `false`; без `TAVILY_API_KEY` tavily не вызывается; фильтр размера и сигнатуры; `--pick first` детерминирован; `--pick vision` на сценарном фейке.

**М3. world + story + Джейн Эйр.** TASK.md из `brief` (тест-снимок); argv `pipe2 run` со всеми `--cap-*`; `world` на падении продолжает с `--resume`; `story` для `book` (с `score.edited.json` и без, несовпадение → ошибка) и `seed`; `books/jane-eyre/book.json` гл. XIII с `narrator_voice`, `--stats` по порогам выше; `narrator_voice` читается симом (старые книги без поля — прежний голос).

**М4. stage (банк мест) + сим.**
- [ ] `places.json` из фикстуры `world_run/`: позиции из `geometry.json` (GLB и плейсхолдер), диван → `sit`, `on`-лампа и ковёр без места и препятствия, копии `around`, имена с повторами, точка двери по числовому примеру, предмет у стены без клетки → предупреждение;
- [ ] `stage.json` по схеме;
- [ ] `sim.run(plan=)`, `no_build`, `sim.seed_start` — тесты `h0/dream` (`test_phase3_seed`, `test_freestyle`, `test_book_play`) зелёные без правок;
- [ ] `play.py --fake` в `book` и `seed` по критерию сквозного теста; `duo.py` не изменён.

**М5. сцена в рантайме движка.** `stage/places.ts`, `path.ts`, `actors.ts`, `camera.ts`, `subs.ts`, обработчики моста; vitest-юниты и браузерный тест по списку выше; без `?stage=` всё прежнее зелёное.

**М6. cast путь A + сквозной `--fake`.** Проверка `cast.json`/GLB; сквозной тест М6.

**М7 — после дедлайна.** Живая стройка (ниже), путь B каста, `vision` по умолчанию.

## М7. Живая стройка во время сцены (черновик, не для этой ночи)

Сейчас `duo.py --stall` симулирует стройку таймером (`fsm.p["build"] = minutes * 60`, `duo.py:35`); FSM сама переводит `building → ready` по `p["build"]` (`fsm.py:273`). Сделать настоящей:
1. **Источник прогресса.** `BuildFSM(progress=None)`: без источника — как сейчас. С источником — `progress() -> int 0..100 | "failed"`, `ready` только на 100.
2. **IPC — файл.** Фоновая `world` на одно место пишет `world/<place>/progress.json` `{pct, state, ts}` через `os.replace`; `pct` = 95 · (готовые ассеты / заказанные) по `events.jsonl`, 100 — только при `dist/build.json` с `ok: true`; нет обновлений 120 с → `failed`.
3. **Триггер.** Вместо `no_build`: `start_build` с местом, которого нет в `places.json` → колбэк оркестратора запускает `world` на одну комнату.
4. **Отказ.** `failed` → `abort` с причиной `build_failed`; директор выбирает другое место.
5. **Тянуть время** — обобщённый `STALL_NOTE` с оценкой минут из прошлых `events.jsonl`.
6. **Новая комната в браузере** — событие SSE `{type: "world", place, dist}`; общий кадр координат двух `dist/` — открытый вопрос.
`ready_timeout` (600 с) касается двери после готовности, а не длительности стройки.

## Открыто (решает хозяин)

- Торнфилд для демо: глава XIII книгой, потом кнопка «Фристайл» — предложение по умолчанию.
- Потолок денег на живой прогон 11-01 (оценка: рефы < $0.10, мир ~$2–3.5, каст путь A $0).
- Slug MuAPI для пути B каста.

## Журнал критики

| круг | критик | находок (b/M/m) | принято | отклонено | что изменилось |
|---|---|---|---|---|---|
| v0.1 → v0.2 | Luna (`gpt-6-luna`) | 3 / 9 / 2 | 14 | 0 | DAG и обязательные входы; хэш, публикация, лок; деньги по долям вместо общего счётчика; фейки по каждому клиенту; конкретный алгоритм `places.json` из `scene.json`/`build.json`/`nav.json`; `duo.html` и `buildWorld` названы новой работой; `story` по реальным CLI (`seed` — строка); `vision` по умолчанию выключен; каст путь A руками; лицензии по провайдерам; живая стройка вынесена в М6 с IPC через файл; порядок фаз по зависимостям; чекбоксы с командами. Критика: `archive/critique/make-v0.1-luna.md` |
| v0.2 → v0.3 | Luna | 0 / 3 / 1 | 4 | 0 | bbox из того же размера, что и место (`fact` или `size`); контракт `touch` → место (`objects` = имена мест, `PLACES`/`OBJ`/`STAGE` из `places.json`, неизвестное/занятое/`sit`); точный вызов сима в `duo.py --run` для `book` и `seed` (вынос `sim.seed_scene`; `sim.run(seed=)` — зерно, не текст) и офлайн-тест `play`; границы `buildWorld` (не создаёт renderer/камеру/walker/мост, проверка — golden-хеши движка). Критика: `archive/critique/make-v0.2-luna.md` |
| v0.3 → v0.4 | Luna | 0 / 2 / 0 | 2 | 0 | `--fake` в `params`/хэше, `world` копирует фикстуру `testdata/world_run/` (как собирается — скрипт), точный сквозной тест М5 (статусы, схема, имена, повтор без запусков); решение «куда идти» вынесено в чистый `stage.js` (`resolveTouch`, `stageRegex`) с `node --test` на свободное/занятое/неизвестное/«уже там»/`sit`; формула «рядом» для любой комнаты вместо `at · 0.6`. Критика: `archive/critique/make-v0.3-luna.md` |
| v0.4 → v0.5 | Luna + Opus (независимо) | Luna 0 / 3 / 0, Opus 2 / 8 / 5 | 17 | 1 | Хозяин сцены — рантайм движка (`?stage=`), а не `duo.html` (зашит под круглую комнату, Сквидварда и Губку Боба); `buildWorld` и правки `duo.html` сняты; актёры из GLB с процедурным движением, путь BFS по `nav`, камера в границах комнаты и ниже потолка, браузерный тест «актёр дошёл до `target`»; места из `geometry.json` (`glbPos`/`glbYaw`, AABB), `size` вместо `fact`, `solid`/`on`/`mount`/`around`, вид по слову `id`; точка двери из `DoorJson`; `sim.run(plan=)`, `sim.seed_start` (не `seed_scene`), `profile=None`, `no_build` против перехода на Conch Street; `touch` для книги через ремарки; `book.json` Джейн Эйр гл. XIII, `I` → Джейн, `narrator_voice`; голоса — метки; `world` продолжает с `--resume`; исключение `.gitignore` для фикстуры, `runs/`; все `--cap-*` всегда; фазы М0–М6 одним планом, игроки Sonnet ×1 → Muse ×6 → Opus ×1. **Отклонено:** «урезать объём» (Luna #3, совет Opus) — решение хозяина делать всё; принята только часть «тесты фазы не зависят от будущих фаз» (заглушки в М0). Критики: `archive/critique/make-v0.4-luna.md`, `archive/critique/make-v0.4-opus.md` |
| v0.5 → v0.6 | Luna | 0 / 3 / 1 | 4 | 0 | `glbYaw` — радианы → градусы, тест GLB = плейсхолдер; фиксированные ожидания `expect_touch.json` (4 случая: свободное `sit`, занятое, ремарка, неизвестное) в юнитах, браузерном и сквозном тестах — числа из файла, не из `resolveTouch`; доли бюджета фиксированы, без перераспределения, стоп по сумме; формулировка `--cap-*`. Критика: `archive/critique/make-v0.5-luna.md` |
