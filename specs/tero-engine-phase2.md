# Движок сцен, фаза 2: `dreamer build` (план для tero)

Ты пишешь сборку мира в пакете `engine/`. Команда `dreamer build SCENE.json --out dist/` собирает из описания места страницу three.js, по которой можно ходить: стены, полы, потолки, балки, проёмы, двери, предметы, наклейки, свет и камеры. Пока ассетов нет, движок подставляет цветные заглушки. Когда ассеты есть, он берёт текстуры Muse Image и предметы SAM3D.
**Источник правды — спека `specs/engine-scene.md` (v0.7)**: разделы «Соглашения», «Модель стены», «Проёмы», «Предметы», «Навигация», «Ассеты», «Компилятор», «Фазы v0» п. 2–3. Фаза 1 (`dreamer check`) готова и закоммичена; её код и тесты — основа, их поведение не меняется. Если спека и план расходятся, главнее спека. Неоднозначность → вопрос хозяину, не своё решение.

**Цель:**
1. `dreamer build specs/examples/demo-flat.scene.json --out <tmp> --assets none` даёт `index.html`. Он открывается в headless Chromium без ошибок консоли, ставит `window.__ready = true`, и по нему можно ходить с коллизией по `nav.json`.
2. С `--assets cache` та же сцена собирается с текстурами и GLB из кэша (в тестах кэш заполняют фейковые провайдеры).
3. Пересборка без новых ассетов занимает меньше 10 с.

**Приёмка хозяина после прогона (не tero):** комната Сквидварда из SCENE.json собирается с `--assets live`. Сравниваем её листом «реф | результат» рядом с двумя прошлыми работами (Claude и Muse без движка). SCENE.json комнаты лежит вне репо, и игроки его не видят.
**Архитектура:** `build` = `runCheck` (весь `check` фазы 1; есть ошибки → exit 1, сборки нет) → ассеты → `buildGeometry(ctx)` → `dist/geometry.json` + `dist/nav.json` + `dist/index.html` + `dist/runtime.js` (esbuild-бандл рантайма) + `dist/assets/*`. Вся геометрия считается **в Node** в `geometry.json`, страница только грузит её в `BufferGeometry`: тесты проверяют меши без браузера. Коллизия на странице — тот же код `src/nav/floor.ts`, собранный в бандл (чистые функции без `Ctx`, см. «Вывод и рантайм»).
**Стек:** TypeScript (ESM, `strict`), Node ≥ 22. К зависимостям фазы 1 добавляются ровно эти, с точными версиями: `three@0.185.0`, `esbuild@0.28.2`, `pngjs@7.0.0`, `playwright@1.64.1`. Других зависимостей нет.

**Правила для всех фаз:**
- Писать только в `engine/**`. `specs/` — только чтение. Не читать `~/.dreamer-bench`, `h0/**` и `app/**`: это скрытый бенч, его ассеты и параллельный прогон dream в соседнем worktree.
- Тесты: `cd engine && npm test` (= `vitest run`), офлайн, без сети и без денег. Весь набор ≤ 90 с; браузерные тесты — только в `test/browser/*.test.ts`, один общий браузер на файл (`beforeAll`). Сначала красный тест, потом код.
- Всё, что тест пишет, — только в `fs.mkdtemp(os.tmpdir())`. CLI в тестах: `node --import tsx bin/dreamer.ts ...`, `cwd` = `engine/`.
- Тесты фазы 1 и голден `test/golden/demo-flat.check.json` не меняются. Если тест фазы 1 стал красным, сломан код, а не тест.
- Код и комментарии на английском. Числа — полная точность внутри, `EPS = 1e-6`; сравнения в тестах — `toBeCloseTo(x, 6)`, если не сказано иное.
- Платные вызовы (Muse Image, SAM3D) — только через интерфейсы провайдеров (фаза «Ассеты»); в тестах — только фейки. Живой провайдер без `--max-dollars` не запускается.
- Ключ — только `process.env.META_MODEL_API_KEY`; не печатать, не писать в лог, `dist/` и кэш.
- `build` ничего не пишет рядом со сценой: отчёт `check` → `dist/check.json`, `top.svg` → `dist/top.svg`, `nav.json` → `dist/nav.json`. Тесты всегда передают `--cache <mkdtemp>`; при `--assets none` папка кэша не создаётся.
- Браузерные тесты: общий хелпер `test/browser/serve.ts` — `node:http` на порту 0, MIME `.html` text/html, `.js` text/javascript, `.json` application/json, `.png` image/png, `.glb` model/gltf-binary, гейт на путь (ответ держится до сигнала теста). Общий `launch()`: `chromium.launch({args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]})`, `deviceScaleFactor: 1`; `beforeAll` с таймаутом 30000. В `index.html` — `<link rel="icon" href="data:,">` (иначе 404 favicon даёт ошибку консоли). Нет WebGL-контекста → рантайм делает `console.error` и не ставит `__ready`.

**Намеренные отступления от спеки (тут план главнее):** полотно — бокс 0.04 м, открытое от `hinge_at`, закрытое по оси стены (не «грань + 0.02»); имена в `dist/` без префикса сцены (`top.svg`, `nav.json`, `check.json`); `top.png` нет.

**Порядок:** первые шесть фаз — сборка (до «Снимки с камер» включительно); дальше — долг и всё, что спека v0.7 обещает после `build`: свободные стены и `fixtures`, `top.png`, `check --built` с маршрутами и разницей отчётов, предметы по факту, лестница и второй уровень. До своей фазы `walls[]`, `fixtures`, `stairs` остаются `SCHEMA_FUTURE_FIELD`. Поведение, о котором раньше молчала спека (id, меши стен/`fixtures`/лестницы, маршруты, `diff`, `top.png`), теперь в ней — план его не переопределяет.

**Вне плана целиком:** v0.2 (`u-landing`, шахты, двухсветные комнаты, `holes`, `columns`, `collider: "hull"`, эскалатор), рендер ассета с 4 сторон. Коды фазы 1 не трогаются; новых кодов нет.

**Review Focus** (что спека подразумевает, а тесты фаз ниже иначе бы пропустили; тест на каждое — в фазе, что владеет кодом):
- сцена с ошибкой `check` → `build` не пишет `dist/` вовсе и выходит с кодом 1, печатая те же `errors` (`test_build_refuses_bad_scene`);
- стена видна с обеих сторон: у каждого интервала с двумя комнатами два лица с нормалями в свои комнаты, у интервала с одной — лицо наружу цвета `style.exterior` (`test_wall_faces_both_sides`);
- `?walk=1` в дверном проёме: капсула проходит дверь 0.9 м и не проходит сквозь стену и диван (`test_walk_collision`);
- предмет с ассетом, которого нет в кэше, при `--assets cache` → OBB-заглушка и предупреждение в `dist/build.json`, а не падение (`test_missing_asset_falls_back`);
- скриншот до загрузки: `__ready` ставится только после всех текстур и GLB (`test_ready_after_assets`);
- ключ API не утекает в `dist/`, кэш и вывод (`test_key_not_leaked`);
- GLB от SAM3D без материала или с умолчанием glTF (`metallicFactor` 1) не выходит чёрным (`test_normalize_default_material`).

**Review Focus фаз после сборки:**
- сцена с лестницей, но без второго уровня (`to.room` на том же уровне) → `REF_UNKNOWN`/`STAIR_EXIT_OUTSIDE`, а не падение (`test_stair_same_level_refused`);
- маршрут через закрытую дверь говорит «закрытая дверь front», а не «стена» (`test_route_blocked_by_closed_door`);
- `walls[]` с `h: null` берёт максимум высот комнат уровня (`test_free_wall_default_height`);
- второй `check` с теми же ошибками → `diff` пустые списки, а не всё «появилось» (`test_report_diff_same`);
- капсула на рампе не проваливается сквозь перекрытие на выходе (`test_walk_stairs`).

**Приёмка хозяина после всего плана (не tero), спека «Приёмка v0»:**
1. Комната Сквидварда (H16) `build --assets live --max-dollars <по «го» владельца>` → лист с двух ref-кадров узнаваем (лист «реф | результат» рядом с прошлыми работами Claude и Muse).
2. demo (две комнаты + лестница) проходит все маршруты — это `test_route_upstairs`.
3. `muse-spark-1.3` по спеке и двум кадрам пишет SCENE.json, проходящий `check`, ≤ 3 итераций (цикл автора: `check` → правка по `msg` → `check`). Платно, только по «го».
4. Пересборка без новых ассетов < 10 с — `test_rebuild_under_10s` фазы 2.

**Перед запуском (делает хозяин, не tero):** `npm i -E three@0.185.0 esbuild@0.28.2 pngjs@7.0.0 playwright@1.64.1` в `engine/`, `npx playwright install chromium`, зелёный `npm test`. tero требует зелёный старт.

## Геометрия плана

Спека: «Модель стены» п. 4–5 (тело, высота, стороны, `exterior`), «Соглашения» (оси), «Компилятор» п. 3–4, «Проёмы» (вырез, проём на дуге), «Фазы v0» п. 2.
Файлы: `src/build/{geometry,walls,floors,beams,color}.ts`, `test/build-geometry.test.ts`.

Интерфейсы (их используют все следующие фазы):
- `interface Mesh {id: string; kind: "floor" | "ceiling" | "wall" | "band" | "reveal" | "beam" | "prop" | "decal" | "leaf" | "backdrop" | "cap"; material: string; positions: number[]; normals: number[]; uvs: number[]; indices: number[]; room?: string; side?: string; glb?: string; glbPos?: [number, number, number]; glbYaw?: number; scale?: number}` (поля `glb*`/`scale` заполняет фаза «Нормализация GLB») — `positions` тройками (x, y, z), `uvs` в метрах (делит на `repeat_m` страница), треугольники против часовой со стороны нормали.
- `interface Geometry {version: 0; meshes: Mesh[]; floors: {room: string; level: string; y: number; outline: V2[]}[]; materials: Record<string, {color: string; map?: string; repeat_m?: number; transparent?: boolean}>; lights: Light[]; cameras: Camera[]; spawn: {at: V2; y: number; yaw: number}; style: {ambient: number; exterior: string}}` — `floors[].outline` = `RoomGeo.outline`; `Light`/`Camera` — как в схеме, с умолчаниями после `validate`. Ключ `materials` = `Mesh.material`: id материала сцены (`color` → свой цвет, `tile` → `grayOf(id)` + `repeat_m`) и id ассета для `prop|decal|leaf|backdrop` (цвет `grayOf(asset)`, `transparent` у decal); `"$exterior"` → `style.exterior`; `map` (`assets/<key>.png|.alpha.png`) появляется в фазе «Нормализация GLB». Совпадение id материала и id ассета → exit 2 с сообщением.
- `buildGeometry(ctx: Ctx): Geometry` — `ctx` после полного `runCheck` без ошибок.
- `grayOf(materialId: string): string` в `color.ts` — FNV-1a 32 бит по UTF-8 id, `gg = 0x60 + (h mod 0x61)`, результат `#gggggg`.
- `meshBBox(m: Mesh): {min: [x, y, z]; max: [x, y, z]}` — для тестов и `build.json`.

Решения:
- Пол и потолок — полигон оси комнаты (`RoomGeo.outline`, дуги уже дискретизированы фазой 1) на `level.y` и `level.y + height`. Триангуляция — ear clipping своим кодом. Нормаль пола +Y, потолка −Y.
- Стены строятся из `LevelPlan.intervals` фазы 1, а не из рёбер комнат: общий интервал — одно тело, два лица. Лицо стороны лежит на внутренней грани (ось ∓ `thickness/2`) по **полной длине интервала**, без подрезки в углах. Высота лица равна потолку своей комнаты. Над низкой стороной лицо достраивается до максимума высот куском `kind: "wall"`, `side: "$exterior"`, `material: "$exterior"`. Сторона без комнаты — лицо `side: "$exterior"`, материал `"$exterior"` (цвет `style.exterior`). Верх тела и торцы — `kind: "cap"`, `material: "$exterior"`, `id` = `cap:<k>`.
- UV стены: u — расстояние вдоль оси интервала от `interval.from` (у дуги — длина по полилайну), v = y − `level.y`.
- Пояса `bands` делят лицо по высоте на отдельные меши `kind: "band"` снизу вверх, выше последнего `to` идёт `walls.material`. Материал ребра `room.edges[i]` заменяет `walls.material` только на интервалах этого ребра.
- Проём вырезается из обоих лиц прямоугольником `[m0, m1] × [sill, sill + height]` в координатах интервала. Откос (грани по толщине) — меши `kind: "reveal"`, материал `"$exterior"`. Проём на дуге: лицо между концами хорды проёма заменяется плоским куском по хорде **этого лица** — хорда оси, сдвинутая на `thickness/2` по нормали стороны (спека «Проём на дуге»).
- Балка — бокс `from → to`, ширина `w`, верх под потолком своей комнаты, низ = потолок − `h`.
- `id` меша: стены — `<sides[0].room>#<sides[0].edge>:<side>:<k>`, где `sides` — `LevelPlan.intervals[n].sides` в порядке фазы 1, `k` сквозной по ребру и стороне; `<room>:floor`, `<room>:ceiling`, `<room>:beam:<k>`; откос — `<opening>:reveal:<k>`; пояса и доливка `$exterior` — по правилу стен (тот же счётчик `k`). Все `id` в `geometry.json` уникальны.

- [x] `test_floor_bbox`: demo-flat → `hall:floor` bbox x [−2, 2], z [4, 12], y 0; `living:floor` bbox x [−4, 4], z [−5.6, 4] (вершина дуги в apex, 36 сегментов); `hall:ceiling` y = 3.0, `living:ceiling` y = 3.4
- [x] `test_wall_faces_both_sides`: меши `wall|band` с bbox в x [−2, 2], z ∈ 4 ± 0.07 имеют множество `side` = {`living`, `hall`, `$exterior`}; все нормали `living` = (0, 0, −1), `hall` и `$exterior` = (0, 0, 1); max y по `living` = 3.4, по `hall` = 3.0; `$exterior` y [3.0, 3.4]. Интервал x [2, 4] на z = 4: `side` = {`living`, `$exterior`}, `$exterior` y [0, 3.4]
- [x] `test_door_cut`: точка (0, 1.0) на плоскости z = 3.94 и на z = 4.06 не покрыта ни одним треугольником `wall|band`; точка (0, 2.5) покрыта треугольником `wall` с `side` `living` (z = 3.94) и `hall` (z = 4.06); точка (−1, 1.0) покрыта; есть меши `reveal`
- [x] `test_window_cut_on_arc`: у мешей `wall|band` с id-префиксом `living#1:` точка (0, 1.5) не покрыта ни на плоскости z = −5.484563, ни на z = −5.604563; точки (0, 0.5) и (0, 2.5) покрыты на обеих плоскостях; все вершины мешей `living#1:living:*` с |x| < 0.8 − 1e-6 лежат на z = −5.484563, у `living#1:$exterior:*` — на z = −5.604563 (допуск 1e-6)
- [x] `test_bands`: по объединению bbox: меши `band` `wood` на стороне `living` — y [0, 0.12], меши `wall` `olive` стороны `living` — y [0.12, 3.4]
- [x] `test_beam`: `living:beam:0` bbox x [−4, 4], z [−0.125, 0.125], y [3.1, 3.4]
- [x] `test_gray_hash`: `grayOf("olive")` = `#8e8e8e`, `grayOf("parquet")` = `#818181`
- [x] `test_winding_matches_normals`: для каждого меша demo-flat и каждого треугольника (a, b, c) `dot(cross(b − a, c − a), normal(a)) > 0`; у каждого меша `positions.length = normals.length`, `uvs.length / 2 = positions.length / 3`, индексы < числа вершин
- [x] `test_mesh_ids_unique`: все `id` мешей demo-flat различны
- [x] `test_materials_table`: `materials.olive` = `{color: "#8e8e8e", repeat_m: 2}`, `materials.wood.color` = `#7a5230`, есть ключи `p_sofa`, `d_door`, `$exterior`
- [x] `test_uv_metres`: меши `wall` `olive` ребра `living#0` (8 м, без проёмов) — u ∈ [0, 8], v ∈ [0.12, 3.4]; `band` того же ребра — v ∈ [0, 0.12]
- [x] реализовать

**Вне этой фазы:** предметы, наклейки, двери, вывод на диск.

## Предметы, наклейки, двери

Спека: «Предметы» (OBB, `mount`), «Проёмы» (полотно, петля, сектор, `outside`), «Модель стены» (плоские вещи на внутренней грани + 0.02), «Отчёт» (`passport.props`, `passport.decals`, `passport.openings`).
Файлы: `src/build/{props,decals,doors}.ts`, `test/build-things.test.ts`.

Интерфейсы:
- `propMeshes(ctx): Mesh[]` — по одному мешу `kind: "prop"` на предмет и на каждую копию `around`; `id` = id паспорта (`chairs.0`), `material` = `asset` предмета.
- `decalMeshes(ctx): Mesh[]` — плоскость `size.w × size.h` с центром `passport.decals[i].center`, нормалью `normal`; `id` = `decal.<i>`, `material` = `asset`.
- `doorMeshes(ctx): Mesh[]` — полотно `kind: "leaf"` (`id` = `<opening>:leaf`, `material` = `leaf.decal`) и задник `kind: "backdrop"` (`<opening>:outside`, `material` = `outside.backdrop`).

Решения:
- Заглушка предмета — бокс по `passport.props[k].obb` (4 угла) × `y`. Числа берутся из паспорта, своих расчётов размещения нет.
- Полотно — бокс толщиной 0.04 м, ширина `width`, высота `height`, низ на `sill`. Открытая дверь стоит перпендикулярно стене, от `hinge_at` (внутренняя грань + 0.02 не применяется: `hinge_at` уже на грани) в `swing`-комнату, и совпадает с концом сектора паспорта. Закрытая (`open: false`) — в проёме **по оси стены** (правило «грань + 0.02» — только для наклеек).
- Задник `outside` — плоскость `width + 0.4` × `height + 0.4` на 1.0 м за наружной гранью стены по нормали из комнаты, лицом в комнату.
- Наклейка — ровно `passport.decals[i].center` (внутренняя грань + 0.02). Наклейка и полотно рисуются с `polygonOffset`.

- [x] `test_prop_boxes_match_passport`: для каждого `passport.props[k]` есть меш `prop` с тем же `id`; его bbox по x/z = bbox `obb`, по y = `y` (±1e-6); `vase` y [0.75, 1.15], `lamp` y [2.8, 3.4]
- [x] `test_decal_plane`: `decal.0` — 4 вершины, центр (3.92, 1.7, −1.6), нормаль (−1, 0, 0), ширина 0.6, высота 0.7
- [x] `test_door_leaf_open`: `front:leaf` bbox x [0.43, 0.47], z [3.04, 3.94], y [0, 2.1]
- [x] `test_door_leaf_closed`: патч `[{"op":"replace","path":"/openings/0/leaf/open","value":false}]` → bbox полотна z [3.98, 4.02], x [−0.45, 0.45]
- [x] `test_window_backdrop`: `sea:outside` — плоскость 2.0 × 1.4, центр по y = 1.5, нормаль смотрит в `living` (z-компонента > 0)
- [x] реализовать

**Вне этой фазы:** вывод, рантайм, ассеты.

## Вывод и рантайм

Спека: «Компилятор» п. 5–6 (`nav.json`, `index.html`, флаги `?walk=1`, `?cam=<id>`, `?top=1`, `window.__ready`), «Навигация» (`floorAt`, капсула), «Соглашения» (углы `yaw`).
Файлы: `src/build/{write,page}.ts`, `src/runtime/{main,walk,cams}.ts`, `bin/dreamer.ts` (команда `build`), `test/build-cli.test.ts`, `test/browser/page.test.ts`.

Интерфейсы:
- CLI: `dreamer build <scene> --out <dir> [--assets none|cache|live] [--cache <dir>] [--max-dollars <n>]`. В этой фазе принимается только `--assets none`; `cache|live` → exit 2 `assets: not implemented` (снимается в фазе «Ассеты»). По умолчанию `--assets none`, `--cache` = `~/.cache/dreamer`. Exit 0 — собрано; 1 — `check` дал ошибки (отчёт в stdout, `dist/` не создаётся); 2 — внутреннее падение или ввод-вывод.
- `dist/`: `index.html`, `runtime.js` (esbuild, `format: "esm"`, `bundle: true`, `platform: "browser"`, `three` внутри бандла), `geometry.json`, `nav.json`, `check.json`, `top.svg`, `build.json` (`{ok, seconds, assets: {used, fallback, missing}, warnings}`: `used` — ассеты из кэша; `missing` — нужные, но не полученные (нет в кэше / ошибка / потолок); `fallback` — все ассеты, отрисованные заглушкой (`--assets none` → все 10; иначе = `missing`)), `assets/` (фаза «Ассеты»).
- В `src/nav/floor.ts` добавить чистые `floorAtRooms(floors: {y: number; outline: V2[]}[], x: number, z: number, yPrev: number): number | null` (старый `floorAt(ctx, …)` строит `floors` из `ctx.rooms` + `levelY` и вызывает её, поведение не меняется) и `navBit(layer: NavLayer, bytes: Uint8Array, x: number, z: number): boolean` (формула клетки фазы 1 `floor((x − x0)/0.04 + 1e-9)`, LSB-first). Рантайм импортирует из `src/` только `nav/floor.ts` и `geom/vec.ts`; base64 → `Uint8Array` через `atob`.
- Страница отдаёт тестам `window.__dreamer = {ready: Promise<void>; pos(): [x, y, z]; tryMove(dx: number, dz: number): [x, y, z]; teleport(x: number, z: number): [x, y, z]; camera(): {pos: [x, y, z]; dir: [x, y, z]; fov: number}; meshCount(): number; inspect(id: string): {type: "Mesh" | "Group"; hasMap: boolean; visible: boolean} | null}`. `teleport` ставит капсулу, y = `floorAt` + 1.6; непроходимая клетка → бросает.

Решения:
- `index.html` — статичная страница: `<script type="module" src="runtime.js">`, данные — `fetch("geometry.json")` и `fetch("nav.json")`. Тесты отдают `dist/` своим маленьким HTTP-сервером на `node:http`, порт 0.
- Страница берёт цвет, `map` и `repeat_m` только из `geometry.materials`. Материалы без ассета (`--assets none` или нет файла): `color` — свой цвет; `tile` — `grayOf(id)`; заглушка-наклейка — плоскость цвета `grayOf(asset)` с подписью id на `CanvasTexture`; предмет — бокс цвета `grayOf(asset)`; `"$exterior"` — `style.exterior`.
- Свет: `hemi` → `HemisphereLight(color, #404040, 1.0 × power)`; `point` → `PointLight(color, 15 × power)`; плюс `AmbientLight(#ffffff, 0.4 × style.ambient)`. `toneMapping` нет.
- `?walk=1`: глаза 1.6 м над `floorAt`, WASD + мышь (pointer lock по клику), скорость 1.4 м/с. Ход проверяется по битам `nav.json` (клетка центра капсулы): непроходимая клетка → шаг по оси x и z отдельно (скольжение вдоль стены). Высота — `floorAt` из `src/nav/floor.ts`; `null` → шаг отменяется.
- Без флагов камера стоит в `spawn` (глаза 1.6 м, `yaw` по таблице углов) и ходит, как с `?walk=1`.
- `?cam=<id>`: камера `pos`/`look`/`fov` из `cameras`, управления нет. Неизвестный id → сообщение на странице и `console.error`.
- `?top=1`: ортокамера сверху на весь AABB уровня `spawn`, потолки и балки скрыты.
- `__ready = true` — после загрузки `geometry.json`, `nav.json`, всех текстур и GLB и первого кадра (`requestAnimationFrame` после `render`).

- [x] `test_build_cli_writes_dist`: CLI на demo-flat → exit 0, есть `index.html`, `runtime.js`, `geometry.json`, `nav.json`, `check.json`, `top.svg`, `build.json`; `geometry.json` проходит `JSON.parse`, `build.json.ok` = true, `build.json.assets.fallback.length` = 10
- [x] `test_build_refuses_bad_scene`: патч `broken/PROP_HITS_WALL` → exit 1, `dist/` не существует, stdout содержит `PROP_HITS_WALL`
- [x] `test_build_no_side_effects`: после сборки demo-flat листинг `specs/examples/` тот же, что до
- [x] `test_runtime_bundle_clean`: в `dist/runtime.js` нет строк `clipper2` и `Buffer.from`
- [x] `test_floor_at_rooms`: по `geometry.floors` в точках (−1, 10), (0, 4), (0, 0.5), (−3.45, 1.5), (10, 10) при `yPrev` 0 — те же значения, что `floorAt(ctx, …)` (0, 0, 0, 0, null)
- [x] `test_rebuild_under_10s`: вторая сборка demo-flat `--assets none` → `build.json.seconds` < 10
- [x] `test_page_ready` (browser): `index.html` → `__ready` = true за ≤ 15 с, ноль `console.error`/`pageerror`, `meshCount()` = числу мешей в `geometry.json`
- [x] `test_cam_param` (browser): `?cam=door` → `camera().pos` ≈ (0, 1.6, 4.6), `dir` ≈ нормированное (0, −0.4, −6.6), `fov` = 70 (до 1e-6); `?cam=nope` → ровно одна `console.error`, страница не падает
- [x] `test_walk_collision` (browser): `teleport(0, 10)`, 200 × `tryMove(0, −0.05)` → z < 3.9 (прошёл `front`); `teleport(0.3, 10)`, то же → z ≥ 4.25 (проход капсулы x ∈ (−0.2, 0.2)); `teleport(−1, 10)`, то же → z ≥ 4.25; `teleport(−2.5, 1.5)`, 40 × `tryMove(−0.05, 0)` → x ≥ −2.79 (край OBB дивана −3.0 + капсула 0.25 − клетка 0.04)
- [x] `test_walk_height` (browser): `teleport(0, 2)` и `teleport(0, 8)` → `pos()[1]` = 1.6
- [x] реализовать

**Вне этой фазы:** ассеты (все материалы пока заглушки).

## Ассеты: шаблоны, кэш, провайдеры

Спека: «Ассеты» (шаблоны промтов, ключ кэша, нормализация), «Компилятор» п. 2. Правило проекта: картинки одним залпом, по отдельному GPU на предмет.
Файлы: `src/assets/{templates,cache,batch,cost}.ts`, `src/assets/providers/{types,fake,muse-image,sam3d}.ts`, `bin/dreamer.ts`, `src/build/write.ts` (флаги `--assets cache|live`, `--max-dollars`, `runAssets` между `runCheck` и `buildGeometry`), `test/assets.test.ts`.

Интерфейсы:
- `interface ImageProvider {generate(prompt: string, size: "1024x1024" | "2048x1024" | "1024x2048"): Promise<Buffer>}` (PNG).
- `interface ObjectProvider {mesh(png: Buffer, name: string): Promise<Buffer>}` (GLB).
- `promptFor(kind: "tile" | "decal" | "object", prompt: string): string` — шаблоны движка + промт автора.
- `cacheKey(kind, prompt, aspect?): string` — sha256 hex от `promptFor(...)` (+ `"|" + aspect` для tile/decal); `size` предмета и `front_deg` в ключ не входят. Ключ строится по `ctx.scene` после `validate` (там `aspect` уже с умолчанием `"1:1"`).
- `sizeFor(aspect: string): "1024x1024" | "2048x1024" | "1024x2048"` — `"1:1"` → квадрат; ширина / высота ≥ 1.5 → `2048x1024`; ≤ 1/1.5 → `1024x2048`; иначе квадрат.
- `runAssets(scene, {mode, cacheDir, image, object, maxDollars}): Promise<AssetReport>` — `AssetReport = {used: string[]; fallback: string[]; missing: string[]; cents: number}`.
- Кэш: `<cacheDir>/<key>.png` (tile/decal: исходник; decal после вырезки — `<key>.alpha.png`), `<cacheDir>/<key>.src.png` + `<key>.glb` (object), `<cacheDir>/ledger.jsonl` (одна строка на попытку: `{t, kind, key, cents}`).

Решения:
- Шаблоны — строки спеки дословно: object `"single object, front view facing the camera, whole object, plain white background, no shadow"`; tile `"seamless tileable texture, orthographic front view, flat even lighting, no shadows, no perspective, the pattern repeats with no visible edges"`; decal `"orthographic front view, flat even lighting, centred, filling the frame, plain flat white background"`. Склейка: `шаблон + ". " + prompt`.
- Режимы: `none` — ничего не читает и не пишет; `cache` — только читает кэш, отсутствующее идёт в `missing`, а меш становится заглушкой; `live` — генерирует отсутствующее, остальное берёт из кэша.
- Залп: все tile/decal и картинки object — одним `Promise.all` с потолком 16 одновременных вызовов. Каждый object уходит в `ObjectProvider` сразу, как готова его картинка, без потолка. Ошибка одного ассета не роняет остальные: он идёт в `missing`, сообщение — в `build.json.warnings`.
- Деньги — в целых центах (`cost.ts`): картинка 1 ¢, предмет 15 ¢ (SAM3D с холодным стартом Modal; хозяин уточнит замером). До первого вызова считается оценка по отсутствующим ассетам. Оценка > потолка → отказ без единого вызова, exit 2 и сообщение с оценкой. `live` без `--max-dollars` → exit 2. Повтор живёт в `batch.ts`, не в провайдерах: ошибка попытки → один повтор (`muse-image.ts` бросает `RetryableError` только при 5xx/400; любая ошибка `ObjectProvider` повторяется). Каждая попытка — «вызов»: перед ней синхронно резервируется цена; потрачено + цена > потолка → без вызова, ассет в `missing`. Строка ledger пишется на каждую попытку, и на неудачную тоже.
- Вырезка белого у decal: `pngjs`, заливка от 4 углов (4-связность) по пикселям с `min(r, g, b) ≥ 235` → альфа 0; непрозрачные пиксели, 4-соседние с залитым, → альфа 128; остальные 255.
- `muse-image.ts`: `POST https://api.meta.ai/v1/images/generations`, `{"model": "muse-image-1.0", "prompt", "n": 1, "size"}`, ответ `data[0].b64_json` или `data[0].url`; таймаут 120 с; 5xx и 400 → `RetryableError` (у Muse Image бывают случайные 400 на валидный промт), повтор делает `batch.ts`. Принимает `baseUrl` (по умолчанию `https://api.meta.ai`).
- `sam3d.ts`: пишет `<tmp>/<key>.png`, запускает `modal run <repoRoot>/h0/sam3d_modal.py --out <tmp> --pngs <tmp>/<key>.png` с `repoRoot = resolve(engineDir, "..")` и `cwd = repoRoot`. Ждёт exit 0 (таймаут 600 с → kill), затем читает `<tmp>/<key>.glb`. Нет файла → ошибка `SAM3D returned no GLB for <id>`, ассет идёт в `missing`. Код `h0/` не меняется.
- В тестах живые провайдеры не создаются: `fake.ts` даёт PNG 4×4 одного цвета (белые углы для decal) и минимальный валидный GLB: один треугольник (1, 2, −0.5), (3, 2, 0.5), (2, 4, 0), `POSITION.min/max` = [1, 2, −0.5] / [3, 4, 0.5], материал `metallicFactor: 1`.

- [ ] `test_prompt_templates`: `promptFor("object", "a vase")` начинается с шаблона object и кончается `". a vase"`; то же для tile/decal
- [ ] `test_cache_key`: патч `/props/0/size/h` → `runAssets` в режиме `live` (`maxDollars` 1) на заполненном кэше → 0 вызовов, `used` = 10; ключ tile меняется при смене `aspect`; одинаковые входы → один ключ
- [ ] `test_size_for`: `"1:1"` → `1024x1024`, `"2:1"` → `2048x1024`, `"1:2"` → `1024x2048`, `"4:3"` → `1024x1024`
- [ ] `test_live_fills_cache` (фейки): demo-flat `live` с `maxDollars` 1 → `ImageProvider` 10 вызовов (2 tile + 3 decal + 5 картинок предметов), `ObjectProvider` 5; все ключи в кэше; `ledger.jsonl` — 15 строк; `report.cents` = 85
- [ ] `test_cap_exact`: `maxDollars` 0.85 → разрешено (сравнение в центах, без ошибки плавающей точки)
- [ ] `test_cache_mode_no_calls`: второй прогон `cache` → 0 вызовов фейков, `used` = все 10 ассетов
- [ ] `test_missing_asset_falls_back`: кэш без `p_sofa`, CLI `--assets cache` → `missing` = `["p_sofa"]`, exit 0, предупреждение с `p_sofa` в `build.json.warnings`
- [ ] `test_refuse_over_cap`: `runAssets` live, `maxDollars` 0.10 → бросает `CapError`, в сообщении `85`, 0 вызовов фейков; CLI `build --assets live` без `--max-dollars` → exit 2 (провайдеры не создаются)
- [ ] `test_stop_mid_batch`: фейк `ObjectProvider` бросает на первой попытке `p_sofa`, `maxDollars` 0.85 → попыток 10 картинок + 6 предметов = 100 ¢ > 85; `ObjectProvider` вызван ровно 5 раз, `missing` — ровно один id, сумма `cents` в ledger ≤ 85
- [ ] `test_one_failure_isolated`: фейк бросает на `p_vase` → остальные 9 в кэше, `missing` = `["p_vase"]`
- [ ] `test_image_concurrency_cap`: сцена с 20 tile, фейк считает одновременные вызовы → максимум 16
- [ ] `test_decal_alpha`: фейковый decal 16×16, рамка 4 px белая (255), внутри (200, 50, 50) → альфа: (0, 0) = 0, (4, 8) = 128, (8, 8) = 255
- [ ] `test_key_not_leaked`: локальный `node:http` отвечает 500 с телом, в котором эхо заголовка `Authorization`; `runAssets` live с `muse-image.ts` на этот `baseUrl` и `META_MODEL_API_KEY=sk-test-LEAK` → `sk-test-LEAK` нет в `warnings`, `build.json`, кэше, ledger и stdout/stderr
- [ ] реализовать

**Вне этой фазы:** нормализация GLB и подключение ассетов к странице.

## Нормализация GLB и ассеты на странице

Спека: «Ассеты» (нормализация: metalness 0, низ на y = 0, центр следа в 0, `front_deg`, равномерный масштаб), «Предметы» (масштаб по `h`), «Соглашения» (перед = +Z).
Файлы: `src/assets/glb.ts`, `src/build/materials.ts`, `src/build/write.ts`, `src/runtime/assets.ts`, `test/glb.test.ts`, `test/browser/assets.test.ts`.

Интерфейсы:
- `readGlb(buf: Buffer): {json: GltfJson; bin: Buffer | null}` / `writeGlb(json, bin): Buffer` — свой разбор контейнера GLB 2.0 (заголовок, чанки JSON и BIN), без зависимостей.
- `normalizeGlb(buf: Buffer, frontDeg: number): {glb: Buffer; size: {w: number; d: number; h: number}}` — `size` — габарит после поворота, до масштаба.
- В `geometry.json` у меша `prop` при найденном ассете: `glb: "assets/<key>.glb"`, `glbPos: [x, y, z]` = (центр OBB x, `passport.props[k].y[0]`, центр OBB z), `glbYaw` = yaw паспорта, `scale` = `prop.size.h / glbSize.h`, где `glbSize` — габарит из `normalizeGlb`.

Решения:
- Bbox — обход узлов сцены `json.scene ?? 0` рекурсивно; матрица узла = `matrix` или T·R·S из `translation`/`rotation`/`scale`; 8 углов `min`/`max` каждого акцессора `POSITION` через мировую матрицу. Бинарные данные вершин не переписываются.
- Нормализация — новый корневой узел над корнями сцены с `matrix`: сначала поворот вокруг Y на `−frontDeg` (перед ассета смотрел на угол `frontDeg` по таблице углов → теперь на +Z), затем сдвиг так, что низ на y = 0, а центр следа в (0, 0). Каждому материалу создать `pbrMetallicRoughness`, если его нет, и поставить `metallicFactor: 0`; примитиву без `material` назначить новый материал `{pbrMetallicRoughness: {metallicFactor: 0}}` (умолчание glTF — металл 1, GLB выходит чёрным). Масштаб в GLB не пишется, его применяет страница: правка `size` не трогает кэш.
- На странице предмет из GLB ставится в `glbPos`, поворачивается на `glbYaw` и масштабируется равномерно на `scale`. Коллизия и навигация остаются по OBB из `size`, как в спеке.
- Тайлы: `RepeatWrapping`, `repeat` = 1 / `repeat_m` на uv в метрах, `colorSpace = SRGBColorSpace`. Наклейки и полотна — `transparent: true`, `alphaTest: 0.5`.
- `dist/assets/` при каждой сборке: `<key>.glb` = `normalizeGlb(cache/<key>.glb, asset.front_deg).glb`; tile → копия `<key>.png`; decal → `<key>.alpha.png` (нет в кэше — вырезка при сборке, без денег). Страница никогда не читает кэш напрямую.

- [ ] `test_glb_roundtrip`: `writeGlb(readGlb(x))` для фейкового GLB даёт тот же JSON и BIN
- [ ] `test_normalize_bottom_centre`: фейковый GLB с bbox x [1, 3], y [2, 4], z [−0.5, 0.5] (w 2, d 1, h 2) → после нормализации bbox x [−1, 1], y [0, 2], z [−0.5, 0.5]; `metallicFactor` = 0
- [ ] `test_normalize_front`: тот же GLB с `frontDeg` 90 → `size` = {w: 1, d: 2, h: 2}; вершина с максимальным x исходника после нормализации имеет максимальный z
- [ ] `test_normalize_default_material`: фейк с материалом без `pbrMetallicRoughness` и примитивом без `material` → у всех материалов результата `metallicFactor` 0, у каждого примитива есть `material`
- [ ] `test_bbox_node_trs`: фейковый GLB под корнем с `translation` [5, 0, 0], `rotation` [0.7071068, 0, 0, 0.7071068] → bbox до нормализации x [6, 8], y [−0.5, 0.5], z [2, 4]; `size` = {w: 2, d: 2, h: 1}; после — x [−1, 1], y [0, 1], z [−1, 1] (допуск 1e-6)
- [ ] `test_scale_from_size`: у `vase` (`h` 0.4) при `glbSize.h` = 2 → `scale` = 0.2; `glbPos[1]` у `lamp` = 2.8, у `vase` = 0.75
- [ ] `test_missing_glb_stub`: кэш без `p_sofa` → у меша `sofa` нет `glb`, у `chairs.0` есть
- [ ] `test_rebuild_cache_under_10s`: вторая сборка `--assets cache` на заполненном фейками кэше → `build.json.seconds` < 10
- [ ] `test_ready_after_assets` (browser): сервер держит ответ `.glb` гейтом; через 1 с `__ready` = false; после отпускания гейта `__ready` = true за ≤ 5 с
- [ ] `test_textured_page` (browser): с ассетами из кэша — ноль ошибок консоли, `inspect("living:floor").hasMap` = true, `inspect("sofa").type` = `"Group"`
- [ ] реализовать

**Вне этой фазы:** рендер с 4 сторон, `check --built`, лист.

## Снимки с камер

Спека: «Проверка» → «Лист» (скриншоты всех `cameras` рядом с `ref` → `sheet.png`), «Компилятор» (`?cam=<id>`, `__ready`). Это минимум для сравнения с референсом, полный `check --built` — фаза 4.
Файлы: `src/build/shots.ts`, `src/build/write.ts`, `bin/dreamer.ts` (команда `shots`), `test/browser/shots.test.ts`.

Интерфейсы:
- CLI: `dreamer shots <dist> [--size 1280x720] [--ready-timeout <s>]` (по умолчанию 20 с) → `<dist>/shots/<camera id>.png` и `<dist>/sheet.png`; exit 0 / 2. `shots` сам поднимает `node:http` на порту 0 над `<dist>` (`fetch` не работает с file://).
- Камеры и ref берутся из `geometry.json` `cameras[]`: `build` копирует `cameras[i].ref` (путь относительно файла сцены) в `dist/refs/<i>-<basename>` и пишет в `ref` этот путь.
- `sheet.png` — по строке на камеру: слева ref, справа снимок. Строка без ref — только снимок и подпись `нет ref`. Лист собирается HTML-страницей `<dist>/sheet.html` и снимается тем же playwright (без библиотек картинок). Нет файла `ref` → предупреждение в `build.json.warnings`, у камеры `ref` = null.

- [ ] `test_shots_per_camera` (browser): demo-flat → `shots/door.png` 1280×720 (ширина и высота PNG по заголовку), `sheet.png` существует
- [ ] `test_shots_wait_ready` (browser): в копии `dist/` `runtime.js` заменён заглушкой без `__ready`, `--ready-timeout 2` → exit 2, stderr содержит `door`, за ≤ 5 с
- [ ] `test_sheet_with_ref` (timeout 60000): сцена с камерой, у которой есть `ref` (PNG 8×8 в tmp), → `dist/refs/0-<имя>` существует, `sheet.html` содержит `src="refs/0-<имя>"`; без ref — содержит `нет ref`
- [ ] реализовать

**Вне этой фазы:** маршруты, `check --built`, разница с прошлым отчётом.

## Долг фазы 2

Спека: «Модель стены» (дуги, `circle`, проём на дуге). Долг: Д2, Д3, Д5 из `specs/tero-engine-phase2-debt.md`. Д6 закрыт решением: `build.json.assets.fallback` — ассеты, отрисованные заглушкой (строка «все 10» выше — пример demo-flat), код не меняется.
Файлы: `src/build/walls.ts`, `src/schema/validate.ts`, `test/debt2.test.ts`.

- [ ] `test_arc_negative_sweep_opening`: комната `living` demo-flat, у вершины 1 `bulge` −0.4 (дуга внутрь); окно `sea` на ней → у мешей `wall|band` с префиксом `living#1:` точка оси при `m` проёма на высоте 1.5 не покрыта, на высоте 0.5 — покрыта
- [ ] `test_circle_reveal_normals_across_seam`: круглая комната r = 4 с проёмом через `t = 0` (как в `test_circle_opening_across_seam_keeps_chord_wall_and_cap`) → у мешей `kind: "reveal"` подоконник смотрит вверх (n.y > 0.99), перемычка — вниз (n.y < −0.99), оба косяка — внутрь проёма (скалярное произведение нормали с направлением на центр проёма > 0)
- [ ] `test_id_charset`: патч `/props/0/id` = `cap:0` → `SCHEMA_TYPE` с `path` `/props/0/id`; id demo-flat и demo проходят
- [ ] реализовать

## Свободные стены и fixtures

Спека: «Формат SCENE.json» (`walls`, `fixtures`, таблица умолчаний), «Модель стены» п. 4 (`Butt` у свободного конца), «Линтер».
Файлы: `src/schema/validate.ts`, `src/plan/merge.ts`, `src/plan/body.ts`, `src/build/walls.ts`, `src/build/fixtures.ts`, `src/props/lint.ts`, `src/nav/grid.ts`, `test/walls-fixtures.test.ts`.

- `walls[]` участвуют в слиянии плана уровня как интервалы без своей комнаты; `h` по умолчанию — максимум `height` комнат уровня.
- `fixtures`: задняя грань по `from → to`, перед — в сторону `room` (по нормали внутрь комнаты); умолчания `depth`/`h` из таблицы спеки; `cabinet-wall` — низ на 1.45 м.

- [ ] `test_free_wall_mesh`: demo-flat + `walls: [{"level":"L0","from":[-1,-1],"to":[1,-1],"material":<любой материал стен demo>}]` → `check` ok; есть меши с префиксом `walls#0:`; их общий bbox x [−1, 1] (±1e-6, `Butt`), z [−1.06, −0.94], y [0, 3.4]
- [ ] `test_free_wall_default_height`: тот же патч → bbox по y верх = 3.4 (максимум `living` 3.4 и `hall` 3.0)
- [ ] `test_free_wall_blocks`: тот же патч → `isWalkable(nav, 0, -1)` = false; предмет `table` с `at` [0, −1] → `PROP_HITS_WALL`, в `msg` есть `walls#0`
- [ ] `test_fixture_counter`: `fixtures: [{"kind":"counter","room":"living","from":[-3.94,-2],"to":[-3.94,2],"material":<m>}]` → меш `fixture.0` bbox x [−3.94, −3.34], z [−2, 2], y [0, 0.9]; меш `fixture.0:top` — 4 вершины на y = 0.9
- [ ] `test_fixture_cabinet_wall`: `kind` `cabinet-wall` с тем же `from/to` → bbox y [1.45, 2.15], x [−3.94, −3.59]
- [ ] `test_fixture_hits_prop`: предмет с OBB внутри counter → `PROP_HITS_PROP`, в `msg` `fixture.0`
- [ ] `test_future_fields_gone`: `walls` и `fixtures` больше не дают `SCHEMA_FUTURE_FIELD`; `stairs` пока даёт (до фазы «Лестница»)
- [ ] реализовать

## Вид сверху в PNG

Спека: «Проверка» → `top.png` подписывает id комнат, номера рёбер, id предметов и проёмов; «Лист» (`top.png` рядом с листом).
Файлы: `src/build/shots.ts`, `src/build/write.ts`, `test/browser/top.test.ts`.

- [ ] `test_top_png` (browser): `build` demo-flat → `dist/top.png` есть; ширина и высота PNG = `width`/`height` корня `dist/top.svg` (округление вниз до целого), не все пиксели одного цвета
- [ ] `test_check_no_browser`: `check` demo-flat не создаёт `top.png` и укладывается в 3 с
- [ ] реализовать

## Маршруты и разница отчётов

Спека: «Проверка» (этапы, `routes` только с `--built`, «Маршруты», «С фазы 4 отчёт печатает разницу»), «Навигация».
Файлы: `src/routes/{waypoints,astar,stage}.ts`, `src/check.ts`, `src/report/report.ts`, `bin/dreamer.ts`, `test/routes.test.ts`.

Интерфейсы:
- CLI: `dreamer check <scene> [--report <path>] [--built <dist>]`. С `--built` после `nav` идёт этап `routes` (в `stages` — `{stage: "routes", ...}` последним; без `--built` этапа в списке нет — голден не меняется). Нет `<dist>/nav.json` → exit 2, `built: nav.json not found`.
- `findRoute(nav: NavJson, from: V2, to: V2, level: string): {ok: true, path: V2[]} | {ok: false, stuck: V2}`.

- [ ] `test_route_in_passes`: `build` demo-flat в tmp, затем `check --built` → `ok: true`, этап `routes` = `pass`, ошибок `ROUTE_BLOCKED` нет
- [ ] `test_route_blocked_by_closed_door`: патч `/openings/0/leaf/open` = false, `build`, `check --built` → ровно одна `ROUTE_BLOCKED`, `path` `/routes/0/path/2`, `msg` содержит `закрытая дверь front`; точка застревания по z ∈ [4.0, 4.6]
- [ ] `test_route_blocked_by_wall`: маршрут `{id:"x", path:["spawn", {"room":"living","at":[3.5,3.5]}]}` при закрытой двери → `msg` содержит `x:` и координаты
- [ ] `test_find_route_unit`: сетка 10×10 из битов с глухой стеной по i = 5 → `ok: false`, `stuck` по x в клетке i = 4; с дыркой в стене → `ok: true`, путь начинается в `from` и кончается в `to` (с точностью до клетки)
- [ ] `test_report_diff_new_and_fixed`: первый `check` сцены с `PROP_HITS_WALL` в `--report <tmp>/r.json`, затем исправленной → второй отчёт: `diff.fixed` = одна запись `PROP_HITS_WALL`, `diff.new` = []; stdout содержит `исправлено: PROP_HITS_WALL /props/`
- [ ] `test_report_diff_same`: два одинаковых `check` подряд → `diff` = `{fixed: [], new: []}`
- [ ] `test_report_no_diff_first_time`: первый `check` → в отчёте нет поля `diff`
- [ ] реализовать

## Предметы по факту

Спека: «Проверка» («до build предметы проверяются по size, после — по факту, и check предлагает исправленный size»; предупреждение «факт и size расходятся > 20%»; «Лист: нет чёрных/пустых текстур, все GLB загрузились»).
Файлы: `src/build/write.ts` (поле `props` в `build.json`), `src/props/fact.ts`, `src/check.ts`, `test/props-fact.test.ts`.

Интерфейсы:
- `build.json.props: {[propId]: {fact: {w, d, h} | null}}` — габарит нормализованного GLB в системе предмета (до поворота); `null` у заглушки.
- `check --built`: у предмета с `fact` OBB строится по `fact`, а не `size`; если `|fact.x − size.x| / size.x > 0.2` по любой оси → предупреждение `PROP_SIZE_ODD` с `fix: {"size": fact}` (округление 1e-3).
- `build.json.warnings` получает `ASSET_BLANK <id>` для текстуры, у которой > 98% пикселей одного цвета, и `ASSET_GLB_BROKEN <id>` для GLB, который не разобрался.

- [ ] `test_fact_size_warns`: фейковый провайдер отдаёт GLB-куб 1×1×1, предмет `size` {w:2, d:0.9, h:0.85} → после нормализации по `h` факт {0.85, 0.85, 0.85}; `check --built` → `PROP_SIZE_ODD` с `fix.size` = факт
- [ ] `test_fact_close_no_warning`: GLB с пропорциями `size` (±10%) → предупреждения нет
- [ ] `test_fact_null_for_placeholder`: `--assets none` → `fact` = null у всех предметов, `check --built` проверяет по `size`
- [ ] `test_blank_texture_warned`: фейк отдаёт однотонный PNG для tile → `ASSET_BLANK` в `warnings`
- [ ] реализовать

## Лестница и второй уровень

Спека: «Лестницы», «Навигация» (рампы, `links`), «Модель стены» (перекрытие между уровнями), «Проверка» (этап `stairs`, паспорт лестницы), «Фазы v0» п. 5.
Файлы: `src/schema/validate.ts`, `src/stairs/{place,stage}.ts`, `src/openings/graph.ts`, `src/build/{stairs,slab}.ts`, `src/build/floors.ts`, `src/nav/{grid,floor}.ts`, `src/runtime/walk.ts`, `test/stairs.test.ts`, `test/browser/stairs.test.ts`.

Числа demo (`specs/examples/demo.scene.json`, лестница `up`: `from` hall (1.4, 11.6), `dir` 180, `to` loft, width 0.9, rise 0.17, going 0.28): Δy = 3.6, N = round(3.6 / 0.17) = 21, r = 3.6 / 21 = 0.171429, марш (N−1)·going = 5.6, выход (1.4, 6.0). Перекрытие под `loft`: slab = 3.6 − 0 − 3.0 = 0.6, низ на 3.0. Линия носков y(s) = r + s·r/going (r/going = 0.612245); просвет < 2.0 при s > 1.353333, то есть вырез x [0.95, 1.85] × z [6.0, 10.246667].

- `stairs` больше не `SCHEMA_FUTURE_FIELD`; этап `stairs` = `pass` / `fail` (не `skipped`), если в сцене есть лестницы, иначе `skipped` (голден demo-flat не меняется).
- Комнаты уровней, отличных от `spawn`, входят в граф и `nav`, если до них есть лестница.
- Паспорт: `stairs: [{"id", "n", "rise", "len", "exit": [x, z], "cut": [[x,z], ...] | null}]` после `decals`.

- Единственная правка теста фазы 1 во всём плане: `test_demo_full_future` (`test/schema.test.ts`) удаляется — спека v0.7 принимает `stairs`, его место занимает `test_demo_check_ok`.

- [ ] `test_demo_check_ok`: `check` demo → `ok: true`, этап `stairs` = `pass`, в паспорте `up`: n = 21, rise 0.171, len 5.6, exit [1.4, 6], cut — прямоугольник x [0.95, 1.85], z [6, 10.247] (округление отчёта 1e-3)
- [ ] `test_stair_exit_outside`: патч `/stairs/0/from/at` = [1.4, 9.0] → `STAIR_EXIT_OUTSIDE`, `msg` содержит `up`, `(1.4, 3.4)` и `loft`
- [ ] `test_stair_headroom`: патч `/rooms/2/shape` = [[-2,4],[2,4],[2,8],[-2,8]] → `STAIR_HEADROOM`, `msg` содержит интервал s [1.353, 3.6] и просвет 0.624
- [ ] `test_stair_same_level_refused`: `to.room` = `living` → ошибка этапа `stairs`, `check` не падает (exit 1)
- [ ] `test_stair_meshes`: `build` demo → 20 мешей `up:step:<k>`; у `up:step:20` bbox z [6.0, 6.28], y [0, 3.428571]; меш `loft:slab` y [3.0, 3.6], точка (1.4, 8.0) не покрыта ни `loft:slab`, ни `loft:floor`, ни `hall:ceiling`, точка (−1, 8.0) покрыта всеми тремя
- [ ] `test_stair_rail_sides`: у `up` есть `up:rail:left` (сторона x = 0.95, до стены hall > 0.15 м) и нет `up:rail:right` (до стены x = 1.94 — 0.09 м)
- [ ] `test_nav_ramp_and_link`: `nav.json` demo: `ramps` = [{stair: "up", y0: 0, y1: 3.6, axis: {from: [1.4, 11.6], dir: 180, len: 5.6}, poly — прямоугольник x [0.95, 1.85] × z [6.0, 11.6]}], `links` = [{from: "L0", to: "L1", via: "up"}], слой `L1` есть
- [ ] `test_floor_at_ramp`: `floorAtRooms` + рампа: (1.4, 11.6 − 2.8) при `yPrev` 1.5 → 0.171429 + 2.8·0.612245 = 1.885715 (±1e-5)
- [ ] `test_route_upstairs`: `build` demo, `check --built` → маршруты `in` и `upstairs` проходят
- [ ] `test_walk_stairs` (browser): `teleport(1.4, 11.9)`, 150 × `tryMove(0, −0.05)` → z < 6.0, `pos()[1]` = 3.6 + 1.6 (±0.01)
- [ ] реализовать

**Вне этой фазы:** v0.2.
