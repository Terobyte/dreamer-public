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

**Намеренные отступления от спеки (тут план главнее):** полотно — бокс 0.04 м, открытое от `hinge_at`, закрытое по оси стены (не «грань + 0.02»); имена в `dist/` без префикса сцены (`top.svg`, `nav.json`, `check.json`); `top.png` делает не `build`, а `dreamer shots` (он и так поднимает браузер; так `build` и `check` в браузер не ходят никогда); до фазы «Вид сверху в PNG» `top.png` нет; «до стены» у перил меряется до внутренней грани стены, а не до оси; перила по краю выреза не ставятся на стороне выхода с марша (спека их не исключает, но иначе они перегораживают выход).

**Порядок:** первые восемь фаз — сборка (до «Снимки с камер» включительно); дальше — долг и всё, что спека v0.7 обещает после `build`: свободные стены и `fixtures`, `top.png`, `check --built` с маршрутами и разницей отчётов, предметы по факту, лестница и второй уровень. До своей фазы `walls[]`, `fixtures`, `stairs` остаются `SCHEMA_FUTURE_FIELD`. Поведение, о котором раньше молчала спека (id, меши стен/`fixtures`/лестницы, маршруты, `diff`, `top.png`), теперь в ней — план его не переопределяет.

**Вне плана целиком:** v0.2 (`u-landing`, шахты, двухсветные комнаты, `holes`, `columns`, `collider: "hull"`, эскалатор), рендер ассета с 4 сторон, Д4 (полокружность без `center`). Коды фазы 1 не трогаются; новых кодов нет. Единственное исключение: в фазе «Маршруты» `ROUTE_BLOCKED.stage` меняется с `"nav"` на `"routes"`, и `"routes"` добавляется в тип `Stage`, но не в `STAGES` по умолчанию (голден не меняется). `NAV_ROOM_CUT` остаётся предупреждением.
**Перед стартом прогона:** ветка tero `night/gates` влита в `main` (иначе гейт `cd engine && npm test` снова пустой, Д7).

**Review Focus** (что спека подразумевает, а тесты фаз ниже иначе бы пропустили; тест на каждое — в фазе, что владеет кодом):
- сцена с ошибкой `check` → `build` не пишет `dist/` вовсе и выходит с кодом 1, печатая те же `errors` (`test_build_refuses_bad_scene`);
- стена видна с обеих сторон: у каждого интервала с двумя комнатами два лица с нормалями в свои комнаты, у интервала с одной — лицо наружу цвета `style.exterior` (`test_wall_faces_both_sides`);
- `?walk=1` в дверном проёме: капсула проходит дверь 0.9 м и не проходит сквозь стену и диван (`test_walk_collision`);
- предмет с ассетом, которого нет в кэше, при `--assets cache` → OBB-заглушка и предупреждение в `dist/build.json`, а не падение (`test_missing_asset_falls_back`);
- скриншот до загрузки: `__ready` ставится только после всех текстур и GLB (`test_ready_after_assets`);
- ключ API не утекает в `dist/`, кэш и вывод (`test_key_not_leaked`);
- GLB от SAM3D без материала или с умолчанием glTF (`metallicFactor` 1) не выходит чёрным (`test_normalize_default_material`).

**Review Focus фаз после сборки:**
- сцена с лестницей, но без второго уровня (`to.room` на том же уровне, Δy ≤ 0) → `STAIR_EXIT_OUTSIDE` этапа `stairs`, а не NaN и не падение (`test_stair_same_level_refused`);
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

Сделано, коммит `be02f32`. Код и тесты — `src/build/{geometry,walls,floors,beams,color}.ts, test/build-geometry.test.ts`; поведение и тесты этой фазы не меняются. Интерфейсы, на которые опираются следующие фазы:
- `interface Mesh {id: string; kind: "floor" | "ceiling" | "wall" | "band" | "reveal" | "beam" | "prop" | "decal" | "leaf" | "backdrop" | "cap"; material: string; positions: number[]; normals: number[]; uvs: number[]; indices: number[]; room?: string; side?: string; glb?: string; glbPos?: [number, number, number]; glbYaw?: number; scale?: number}` (поля `glb*`/`scale` заполняет фаза «Нормализация GLB») — `positions` тройками (x, y, z), `uvs` в метрах (делит на `repeat_m` страница), треугольники против часовой со стороны нормали.
- `interface Geometry {version: 0; meshes: Mesh[]; floors: {room: string; level: string; y: number; outline: V2[]}[]; materials: Record<string, {color: string; map?: string; repeat_m?: number; transparent?: boolean}>; lights: Light[]; cameras: Camera[]; spawn: {at: V2; y: number; yaw: number}; style: {ambient: number; exterior: string}}` — `floors[].outline` = `RoomGeo.outline`; `Light`/`Camera` — как в схеме, с умолчаниями после `validate`. Ключ `materials` = `Mesh.material`: id материала сцены (`color` → свой цвет, `tile` → `grayOf(id)` + `repeat_m`) и id ассета для `prop|decal|leaf|backdrop` (цвет `grayOf(asset)`, `transparent` у decal); `"$exterior"` → `style.exterior`; `map` (`assets/<key>.png|.alpha.png`) появляется в фазе «Нормализация GLB». Совпадение id материала и id ассета → exit 2 с сообщением.
- `buildGeometry(ctx: Ctx): Geometry` — `ctx` после полного `runCheck` без ошибок.
- `grayOf(materialId: string): string` в `color.ts` — FNV-1a 32 бит по UTF-8 id, `gg = 0x60 + (h mod 0x61)`, результат `#gggggg`.
- `meshBBox(m: Mesh): {min: [x, y, z]; max: [x, y, z]}` — для тестов и `build.json`.

- [x] сделано (be02f32)

## Предметы, наклейки, двери

Сделано, коммит `64300d4`. Код и тесты — `src/build/{props,decals,doors}.ts, test/build-things.test.ts`; поведение и тесты этой фазы не меняются. Интерфейсы, на которые опираются следующие фазы:
- `propMeshes(ctx): Mesh[]` — по одному мешу `kind: "prop"` на предмет и на каждую копию `around`; `id` = id паспорта (`chairs.0`), `material` = `asset` предмета.
- `decalMeshes(ctx): Mesh[]` — плоскость `size.w × size.h` с центром `passport.decals[i].center`, нормалью `normal`; `id` = `decal.<i>`, `material` = `asset`.
- `doorMeshes(ctx): Mesh[]` — полотно `kind: "leaf"` (`id` = `<opening>:leaf`, `material` = `leaf.decal`) и задник `kind: "backdrop"` (`<opening>:outside`, `material` = `outside.backdrop`).

- [x] сделано (64300d4)

## Вывод и рантайм

Сделано, коммит `92b89df`. Код и тесты — `src/build/{write,page}.ts, src/runtime/*, bin/dreamer.ts, test/build-cli.test.ts, test/browser/page.test.ts`; поведение и тесты этой фазы не меняются. Интерфейсы, на которые опираются следующие фазы:
- CLI: `dreamer build <scene> --out <dir> [--assets none|cache|live] [--cache <dir>] [--max-dollars <n>]`. В этой фазе принимается только `--assets none`; `cache|live` → exit 2 `assets: not implemented` (снимается в фазе «Ассеты»). По умолчанию `--assets none`, `--cache` = `~/.cache/dreamer`. Exit 0 — собрано; 1 — `check` дал ошибки (отчёт в stdout, `dist/` не создаётся); 2 — внутреннее падение или ввод-вывод.
- `dist/`: `index.html`, `runtime.js` (esbuild, `format: "esm"`, `bundle: true`, `platform: "browser"`, `three` внутри бандла), `geometry.json`, `nav.json`, `check.json`, `top.svg`, `build.json` (`{ok, seconds, assets: {used, fallback, missing}, warnings}`: `used` — ассеты из кэша; `missing` — нужные, но не полученные (нет в кэше / ошибка / потолок); `fallback` — все ассеты, отрисованные заглушкой (`--assets none` → все 10; иначе = `missing`)), `assets/` (фаза «Ассеты»).
- В `src/nav/floor.ts` добавить чистые `floorAtRooms(floors: {y: number; outline: V2[]}[], x: number, z: number, yPrev: number): number | null` (старый `floorAt(ctx, …)` строит `floors` из `ctx.rooms` + `levelY` и вызывает её, поведение не меняется) и `navBit(layer: NavLayer, bytes: Uint8Array, x: number, z: number): boolean` (формула клетки фазы 1 `floor((x − x0)/0.04 + 1e-9)`, LSB-first). Рантайм импортирует из `src/` только `nav/floor.ts` и `geom/vec.ts`; base64 → `Uint8Array` через `atob`.
- Страница отдаёт тестам `window.__dreamer = {ready: Promise<void>; pos(): [x, y, z]; tryMove(dx: number, dz: number): [x, y, z]; teleport(x: number, z: number): [x, y, z]; camera(): {pos: [x, y, z]; dir: [x, y, z]; fov: number}; meshCount(): number; inspect(id: string): {type: "Mesh" | "Group"; hasMap: boolean; visible: boolean} | null}`. `teleport` ставит капсулу, y = `floorAt` + 1.6; непроходимая клетка → бросает.

- [x] сделано (92b89df)

## Ассеты: шаблоны, кэш, вырезка

Спека: «Ассеты» (шаблоны промтов, ключ кэша, нормализация), «Компилятор» п. 2. Правило проекта: картинки одним залпом, по отдельному GPU на предмет.
Две фазы на одну тему: эта — всё без генерации (шаблоны, ключи, кэш, режим `cache`, вырезка); следующая — залп, деньги и провайдеры. Интерфейсы и решения ниже общие для обеих.
Файлы этой фазы: `src/assets/{templates,cache,alpha}.ts`, `src/assets/providers/{types,fake}.ts`, `src/assets/run.ts`, `bin/dreamer.ts`, `src/build/write.ts` (флаг `--assets cache`, `runAssets` между `runCheck` и `buildGeometry`), `test/assets-cache.test.ts`. В этой фазе `--assets live` → exit 2 `assets: live not implemented`.

Интерфейсы:
- `interface ImageProvider {generate(prompt: string, size: "1024x1024" | "2048x1024" | "1024x2048"): Promise<Buffer>}` (PNG).
- `interface ObjectProvider {mesh(png: Buffer, name: string): Promise<Buffer>}` (GLB).
- `promptFor(kind: "tile" | "decal" | "object", prompt: string): string` — шаблоны движка + промт автора.
- `cacheKey(kind, prompt, aspect?): string` — sha256 hex от `promptFor(...)` (+ `"|" + aspect` для tile/decal); `size` предмета и `front_deg` в ключ не входят. Ключ строится по `ctx.scene` после `validate` (там `aspect` уже с умолчанием `"1:1"`).
- `sizeFor(aspect: string): "1024x1024" | "2048x1024" | "1024x2048"` — `"1:1"` → квадрат; ширина / высота ≥ 1.5 → `2048x1024`; ≤ 1/1.5 → `1024x2048`; иначе квадрат.
- `runAssets(scene, {mode, cacheDir, image, object, maxDollars}): Promise<AssetReport>` — берёт все ассеты, на которые ссылается сцена (материалы `tile`, `asset` предметов и наклеек, `leaf.decal`, `outside.backdrop`); неиспользуемые записи `assets` не генерируются и не попадают ни в одно поле отчёта — `AssetReport = {used: string[]; fallback: string[]; missing: string[]; cents: number}`.
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

- [x] `test_prompt_templates`: `promptFor("object", "a vase")` начинается с шаблона object и кончается `". a vase"`; то же для tile/decal
- [x] `test_size_for`: `"1:1"` → `1024x1024`, `"2:1"` → `2048x1024`, `"1:2"` → `1024x2048`, `"4:3"` → `1024x1024`
- [x] `test_cache_key_stable`: одинаковые входы → один ключ; ключ tile меняется при смене `aspect`; патч `/props/0/size/h` ключ предмета не меняет
- [x] `test_cache_mode_no_calls`: тест сам кладёт фейковые PNG/GLB по `cacheKey` всех 10 ассетов demo-flat; `runAssets` `cache` с фейками-счётчиками → 0 вызовов, `used` = все 10
- [x] `test_missing_asset_falls_back`: тот же кэш без `p_sofa`, CLI `--assets cache` → `missing` = `["p_sofa"]`, exit 0, предупреждение с `p_sofa` в `build.json.warnings`
- [x] `test_decal_alpha`: фейковый decal 16×16, рамка 4 px белая (255), внутри (200, 50, 50) → альфа: (0, 0) = 0, (4, 8) = 128, (8, 8) = 255
- [x] `test_live_not_yet`: CLI `--assets live --max-dollars 1` → exit 2, stderr `assets: live not implemented`
- [x] реализовать

## Ассеты: залп, деньги, провайдеры

Продолжение фазы «Ассеты: шаблоны, кэш, вырезка» — её интерфейсы и решения в силе. Снимает `assets: live not implemented` (тест `test_live_not_yet` этой фазы удаляется — единственная правка своего теста в плане, кроме `test_demo_full_future`).
Файлы: `src/assets/{batch,cost}.ts`, `src/assets/providers/{muse-image,sam3d}.ts`, `src/assets/run.ts`, `bin/dreamer.ts` (`--assets live`, `--max-dollars`), `test/assets-live.test.ts`.

- [x] `test_cache_key`: заполненный кэш → `runAssets` `live` (`maxDollars` 1) → 0 вызовов, `used` = 10
- [x] `test_live_fills_cache` (фейки): demo-flat `live` с `maxDollars` 1 → `ImageProvider` 10 вызовов (2 tile + 3 decal + 5 картинок предметов), `ObjectProvider` 5; все ключи в кэше; `ledger.jsonl` — 15 строк; `report.cents` = 85
- [x] `test_cap_exact`: `maxDollars` 0.85 → разрешено (сравнение в центах, без ошибки плавающей точки)
- [x] `test_refuse_over_cap`: `runAssets` live, `maxDollars` 0.10 → бросает `CapError`, в сообщении `85`, 0 вызовов фейков; CLI `build --assets live` без `--max-dollars` → exit 2 (провайдеры не создаются)
- [x] `test_stop_mid_batch`: фейк `ObjectProvider` бросает на первой попытке `p_sofa`, `maxDollars` 0.85 → попыток 10 картинок + 6 предметов = 100 ¢ > 85; `ObjectProvider` вызван ровно 5 раз, `missing` — ровно один id, сумма `cents` в ledger ≤ 85
- [x] `test_one_failure_isolated`: фейк бросает на `p_vase` → остальные 9 в кэше, `missing` = `["p_vase"]`
- [x] `test_image_concurrency_cap`: demo-flat + 20 новых tile-ассетов `t_k` с разными промтами, 20 материалов `m_k` (`tile: t_k`), у `living.walls.bands` 20 полос по 0.1 м заменяют существующую (0.12 wood) (`to` = 0.1·(k+1), материал `m_k`); `maxDollars` 2 (цена 105 ¢); фейк держит каждый вызов 20 мс и считает одновременные → максимум одновременных ровно 16
- [x] `test_key_not_leaked`: локальный `node:http` отвечает 500 с телом, в котором эхо заголовка `Authorization`; `runAssets` live с `muse-image.ts` на этот `baseUrl`, фейковым `ObjectProvider` (не `sam3d`) и `META_MODEL_API_KEY=sk-test-LEAK` → `sk-test-LEAK` нет в `warnings`, `build.json`, кэше, ledger и stdout/stderr
- [x] реализовать

**Вне этих двух фаз:** нормализация GLB и подключение ассетов к странице.

## Нормализация GLB

Спека: «Ассеты» (нормализация: metalness 0, низ на y = 0, центр следа в 0, `front_deg`, равномерный масштаб), «Предметы» (масштаб по `h`), «Соглашения» (перед = +Z).
Две фазы: эта — только `src/assets/glb.ts` в Node (без браузера); следующая «Ассеты на странице» — `dist/assets`, поля `glb*` и страница. Интерфейсы и решения ниже общие.
Файлы этой фазы: `src/assets/glb.ts`, `test/glb.test.ts`.

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

- [x] `test_glb_roundtrip`: `writeGlb(readGlb(x))` для фейкового GLB даёт тот же JSON и BIN
- [x] `test_normalize_bottom_centre`: фейковый GLB с bbox x [1, 3], y [2, 4], z [−0.5, 0.5] (w 2, d 1, h 2) → после нормализации bbox x [−1, 1], y [0, 2], z [−0.5, 0.5]; `metallicFactor` = 0
- [x] `test_normalize_front`: тот же GLB с `frontDeg` 90 → `size` = {w: 1, d: 2, h: 2}; вершина с максимальным x исходника после нормализации имеет максимальный z
- [x] `test_normalize_default_material`: фейк с материалом без `pbrMetallicRoughness` и примитивом без `material` → у всех материалов результата `metallicFactor` 0, у каждого примитива есть `material`
- [x] `test_bbox_node_trs`: фейковый GLB под корнем с `translation` [5, 0, 0], `rotation` [0.7071068, 0, 0, 0.7071068] → bbox до нормализации x [6, 8], y [−0.5, 0.5], z [2, 4]; `size` = {w: 2, d: 2, h: 1}; после — x [−1, 1], y [0, 1], z [−1, 1] (допуск 1e-6)
- [x] реализовать

## Ассеты на странице

Продолжение «Нормализации GLB» — её интерфейсы и решения в силе.
Файлы: `src/build/materials.ts`, `src/build/write.ts`, `src/runtime/assets.ts`, `test/build-assets.test.ts`, `test/browser/assets.test.ts`.

- [x] `test_scale_from_size`: у `vase` (`h` 0.4) при `glbSize.h` = 2 → `scale` = 0.2; `glbPos[1]` у `lamp` = 2.8, у `vase` = 0.75
- [x] `test_missing_glb_stub`: кэш без `p_sofa` → у меша `sofa` нет `glb`, у `chairs.0` есть
- [x] `test_rebuild_cache_under_10s`: вторая сборка `--assets cache` на заполненном фейками кэше → `build.json.seconds` < 10
- [x] `test_ready_after_assets` (browser): сервер держит ответ `.glb` гейтом; через 1 с `__ready` = false; после отпускания гейта `__ready` = true за ≤ 5 с
- [x] `test_textured_page` (browser): с ассетами из кэша — ноль ошибок консоли, `inspect("living:floor").hasMap` = true, `inspect("sofa").type` = `"Group"`
- [x] реализовать

**Вне этой фазы:** рендер с 4 сторон, `check --built`, лист.

## Снимки с камер

Спека: «Проверка» → «Лист» (скриншоты всех `cameras` рядом с `ref` → `sheet.png`), «Компилятор» (`?cam=<id>`, `__ready`). Это минимум для сравнения с референсом, полный `check --built` — фаза 4.
Файлы: `src/build/shots.ts`, `src/build/write.ts`, `bin/dreamer.ts` (команда `shots`), `test/browser/shots.test.ts`.

Интерфейсы:
- CLI: `dreamer shots <dist> [--size 1280x720] [--ready-timeout <s>]` (по умолчанию 20 с) → `<dist>/shots/<camera id>.png` и `<dist>/sheet.png`; exit 0 / 2. `shots` сам поднимает `node:http` на порту 0 над `<dist>` (`fetch` не работает с file://).
- Камеры и ref берутся из `geometry.json` `cameras[]`: `build` копирует `cameras[i].ref` (путь относительно файла сцены) в `dist/refs/<i>-<basename>` и пишет в `ref` этот путь.
- `sheet.png` — по строке на камеру: слева ref, справа снимок. Строка без ref — только снимок и подпись `нет ref`. Лист собирается HTML-страницей `<dist>/sheet.html` и снимается тем же playwright (без библиотек картинок). Нет файла `ref` → предупреждение в `build.json.warnings`, у камеры `ref` = null.

- [x] `test_shots_per_camera` (browser): demo-flat → `shots/door.png` 1280×720 (ширина и высота PNG по заголовку), `sheet.png` существует
- [x] `test_shots_wait_ready` (browser): в копии `dist/` `runtime.js` заменён заглушкой без `__ready`, `--ready-timeout 2` → exit 2, stderr содержит `door`, за ≤ 5 с
- [x] `test_sheet_with_ref` (timeout 60000): сцена с камерой, у которой есть `ref` (PNG 8×8 в tmp), → `dist/refs/0-<имя>` существует, `sheet.html` содержит `src="refs/0-<имя>"`; без ref — содержит `нет ref`
- [x] реализовать

**Вне этой фазы:** маршруты, `check --built`, разница с прошлым отчётом.

## Долг фазы 2

Спека: «Модель стены» (дуги, `circle`, проём на дуге). Долг: Д2 (кроме проёма у границы wrap — остаётся долгом), Д3, Д5 из `specs/tero-engine-phase2-debt.md`. Д6 закрыт решением: `build.json.assets.fallback` — ассеты, отрисованные заглушкой (строка «все 10» выше — пример demo-flat), код не меняется.
Файлы: `src/build/walls.ts`, `src/schema/validate.ts`, `test/debt2.test.ts`.

- [x] `test_arc_negative_sweep_opening`: комната `living` demo-flat, у вершины 1 `bulge` −0.4 (дуга внутрь); окно `sea` на ней → у мешей `wall|band` с префиксом `living#1:` точка оси при `m` проёма на высоте 1.5 не покрыта, на высоте 0.5 — покрыта
- [x] `test_circle_reveal_normals_across_seam`: круглая комната r = 4 с проёмом через `t = 0` (как в `test_circle_opening_across_seam_keeps_chord_wall_and_cap`) → у мешей `kind: "reveal"` подоконник смотрит вверх (n.y > 0.99), перемычка — вниз (n.y < −0.99), оба косяка — внутрь проёма (скалярное произведение нормали с направлением на центр проёма > 0)
- [x] `test_id_charset`: патч `/props/4/id` (`lamp`, на него никто не ссылается) = `cap:0` → ошибки ровно `[SCHEMA_TYPE]` с `path` `/props/4/id`; id demo-flat и demo проходят
- [x] реализовать

## Свободные стены и fixtures

Спека: «Формат SCENE.json» (`walls`, `fixtures`, таблица умолчаний), «Модель стены» п. 4 (`Butt` у свободного конца), «Линтер».
Файлы: `src/schema/validate.ts`, `src/plan/merge.ts`, `src/plan/body.ts`, `src/build/walls.ts`, `src/build/fixtures.ts`, `src/build/geometry.ts` (сборка мешей; `Mesh.kind` += `"fixture"`), `src/props/lint.ts`, `src/nav/grid.ts`, `test/walls-fixtures.test.ts`.

- `walls[]` участвуют в слиянии плана уровня как интервалы без своей комнаты; `h` по умолчанию — максимум `height` комнат уровня.
- `fixtures`: задняя грань по `from → to`, перед — в сторону `room` (по нормали внутрь комнаты); умолчания `depth`/`h` из таблицы спеки; `cabinet-wall` — низ на 1.45 м.

- [x] `test_free_wall_mesh`: demo-flat + `walls: [{"level":"L0","from":[-1,8],"to":[1,8],"material":"olive"}]` (стена в `hall`, предметов рядом нет) → `check` ok; есть меши с префиксом `walls#0:`; их общий bbox x [−1, 1] (±1e-6, `Butt`), z [7.94, 8.06], y [0, 3.4]
- [x] `test_free_wall_default_height`: тот же патч → bbox по y верх = 3.4 — максимум уровня (`living` 3.4), а не своей комнаты (`hall` 3.0)
- [x] `test_free_wall_blocks`: тот же патч → `isWalkable(nav, 0, 8)` = false; плюс новый предмет `{"id":"box","asset":"p_table","room":"hall","at":[0,8],"size":{"w":0.5,"d":0.5,"h":0.5},"yaw":0}` → `PROP_HITS_WALL`, в `msg` есть `walls#0`
- [x] `test_fixture_counter`: `fixtures: [{"kind":"counter","room":"living","from":[-3.94,-3],"to":[-3.94,-1],"material":"wood"}]` (мимо дивана z [0.5, 2.5]) → `check` ok; меш `fixture.0` bbox x [−3.94, −3.34], z [−3, −1], y [0, 0.9]; меш `fixture.0:top` — 4 вершины на y = 0.9
- [x] `test_fixture_cabinet_wall`: `kind` `cabinet-wall` с тем же `from/to` → bbox y [1.45, 2.15], x [−3.94, −3.59], z [−3, −1]
- [x] `test_fixture_hits_prop`: counter + предмет `{"id":"crate","asset":"p_vase","room":"living","at":[-3.64,-2],"size":{"w":0.3,"d":0.3,"h":0.3},"yaw":0}` → ошибки ровно `[PROP_HITS_PROP]`, в `msg` `fixture.0` (без counter этот же патч проходит `check` чисто)
- [x] `test_future_fields_gone`: `walls` и `fixtures` больше не дают `SCHEMA_FUTURE_FIELD` (про `stairs` тест молчит — его снимает фаза «Лестница: check и паспорт»)
- [x] реализовать

## Вид сверху в PNG

Спека: «Проверка» → `top.png` подписывает id комнат, номера рёбер, id предметов и проёмов; «Лист» (`top.png` рядом с листом).
`top.png` снимает `dreamer shots` (см. «Намеренные отступления»): тот же браузер, `top.svg` → `<dist>/top.png`. `build` и `check` браузер не поднимают.
Файлы: `src/build/shots.ts`, `test/browser/top.test.ts`.

- [x] `test_top_png` (browser): `build` + `shots` demo-flat → `dist/top.png` есть; ширина и высота PNG = `width`/`height` корня `dist/top.svg` (округление вниз до целого), не все пиксели одного цвета
- [x] `test_check_no_browser`: `check` и `build --assets none` demo-flat не создают `top.png`; `check` укладывается в 3 с
- [x] реализовать

## Маршруты и разница отчётов

Спека: «Проверка» (этапы, `routes` только с `--built`, «Маршруты», «С фазы 4 отчёт печатает разницу»), «Навигация».
Файлы: `src/routes/{waypoints,astar,stage}.ts`, `src/check.ts`, `src/report/{report,codes,messages}.ts` (шаблон `ROUTE_BLOCKED` — по таблице сообщений спеки), `src/types.ts` (тип `Stage`), `bin/dreamer.ts`, `test/routes.test.ts`.

- `ROUTE_BLOCKED.stage` = `"routes"` (см. исключение в шапке). Точка маршрута (`spawn`, проём, `{room, at}`) — клетка, ближайшая к цели в радиусе 0.3 м (спека; у предмета — 0.6 м от OBB, как в спеке); нет проходимой клетки в радиусе → цель недостижима, `ROUTE_BLOCKED` с `path` этой точки. Если на пути от последней достигнутой клетки к цели лежит проём с `leaf.open = false`, `msg` называет `закрытая дверь <id>`; иначе — ближайшее твёрдое по спеке (`room#i`, `walls#i`, id предмета, `fixture.<i>`), при равенстве расстояний — первое по (комната, i); и координаты точки застревания.

Интерфейсы:
- CLI: `dreamer check <scene> [--report <path>] [--built <dist>]`. Все CLI-тесты `check` в плане передают `--report <mkdtemp>/r.json` (иначе отчёт и `nav.json`/`top.svg` пишутся рядом со сценой в `specs/examples`); тесты разницы переиспользуют тот же путь. С `--built` после `nav` идёт этап `routes` (в `stages` — `{stage: "routes", ...}` последним; без `--built` этапа в списке нет — голден не меняется). Нет `<dist>/nav.json` → exit 2, `built: nav.json not found`.
- `findRoute(nav: NavJson, from: V2, to: V2, level: string): {ok: true, path: V2[]} | {ok: false, stuck: V2}`.

- [x] `test_route_in_passes`: `build` demo-flat в tmp, затем `check --built` → `ok: true`, этап `routes` = `pass`, ошибок `ROUTE_BLOCKED` нет
- [x] `test_route_blocked_by_closed_door`: патч `/openings/0/leaf/open` = false, `build`, `check --built` → ровно одна `ROUTE_BLOCKED`, `path` `/routes/0/path/1` (центр `front` (0, 4) при закрытой двери в 0.34 м от ближайшей проходимой клетки), `msg` содержит `закрытая дверь front`; точка застревания по z ∈ [4.3, 4.6]
- [x] `test_route_blocked_by_wall`: маршрут `{id:"x", path:["spawn", {"room":"living","at":[3.5,3.5]}]}` при закрытой двери → `msg` содержит `x:` и `(1.66, 4.34)`, не содержит `закрытая дверь`
- [x] `test_find_route_unit`: сетка 10×10 из битов (`origin` [0, 0], клетка 0.04, `from` клетка (1, 5), `to` клетка (8, 5)) с глухой стеной по i = 5 → `ok: false`, `stuck` по x в клетке i = 4; с дыркой в стене → `ok: true`, путь начинается в `from` и кончается в `to` (с точностью до клетки)
- [x] `test_report_diff_new_and_fixed`: первый `check` сцены `test/scenes/broken/PROP_HITS_WALL.patch.json` в `--report <tmp>/r.json`, затем исправленной → второй отчёт: `diff.fixed` = одна запись `PROP_HITS_WALL`, `diff.new` = []; stdout содержит `исправлено: PROP_HITS_WALL /props/`
- [x] `test_report_diff_same`: два одинаковых `check` подряд → `diff` = `{fixed: [], new: []}`
- [x] `test_report_no_diff_first_time`: первый `check` → в отчёте нет поля `diff`
- [x] реализовать

## Предметы по факту

Спека: «Проверка» («до build предметы проверяются по size, после — по факту, и check предлагает исправленный size»; предупреждение «факт и size расходятся > 20%»; «Лист: нет чёрных/пустых текстур, все GLB загрузились»).
Файлы: `src/build/write.ts` (поле `props` в `build.json`), `src/props/fact.ts`, `src/props/lint.ts`, `src/report/messages.ts` (вариант `PROP_SIZE_ODD` по факту: «`{id}`: факт {w}×{d}×{h} расходится с size > 20%»), `src/check.ts`, `test/props-fact.test.ts`.

Интерфейсы:
- `build.json.props: {[propId]: {fact: {w, d, h} | null}}` — `fact = glbSize · scale` (габарит из `normalizeGlb`, умноженный на `scale` меша) в системе предмета, до поворота; `null` у заглушки.
- Проверка правдоподобия по `cat` (`lint.ts`) всегда идёт по авторскому `size`; `fact` влияет только на OBB и на сравнение fact/size.
- `check --built`: у предмета с `fact` OBB строится по `fact`, а не `size`; если `|fact.x − size.x| / size.x > 0.2` по любой оси → предупреждение `PROP_SIZE_ODD` с `fix: {"size": fact}` (округление 1e-3).
- `build.json.warnings` получает строки `ASSET_BLANK <id>` для текстуры, у которой > 98% пикселей одного цвета, и `ASSET_GLB_BROKEN <id>` для GLB, который не разобрался. Это строки `build.json`, не коды `CODES` (иначе ломается `test_broken_one_code_each`).

- [ ] `test_fact_size_warns`: фейковый провайдер отдаёт GLB-куб 1×1×1 только для `p_sofa` (остальные — обычный фейк), `sofa` `size` {w:2, d:0.9, h:0.85} → после нормализации по `h` факт {0.85, 0.85, 0.85}; `check --built` → у `sofa` ровно одна запись `PROP_SIZE_ODD` с `fix.size` = факт. Во всех тестах этой фазы фейк отдаёт остальным предметам GLB-бокс, равный их `size` (иначе стулья из куба 1×1×1 наезжают друг на друга и дают `PROP_HITS_PROP`)
- [ ] `test_fact_close_no_warning`: GLB-бокс 2.0×0.9×0.85 для `p_sofa` → после масштаба факт = `size`, `PROP_SIZE_ODD` у `sofa` нет
- [ ] `test_fact_null_for_placeholder`: `--assets none` → `fact` = null у всех предметов, `check --built` проверяет по `size`
- [ ] `test_blank_texture_warned`: фейк отдаёт однотонный PNG для `t_wall` и шахматку из двух цветов для `t_floor` → в `warnings` есть `ASSET_BLANK t_wall`, нет `ASSET_BLANK t_floor`
- [ ] `test_glb_broken_warned`: фейк отдаёт для `p_sofa` 12 случайных байт → в `warnings` есть `ASSET_GLB_BROKEN p_sofa`, у `sofa` `fact` = null, `build` exit 0
- [ ] реализовать

## Лестница: check и паспорт

Спека: «Лестницы», «Навигация» (рампы, `links`), «Модель стены» (перекрытие между уровнями), «Проверка» (этап `stairs`, паспорт лестницы), «Фазы v0» п. 5. Три фазы: эта — схема, этап `stairs`, паспорт; затем «меши и вырез»; затем «навигация, маршрут, ходьба». Числа и решения ниже общие для всех трёх.
Файлы этой фазы: `src/schema/validate.ts`, `src/stairs/{place,stage}.ts`, `src/openings/{graph,stage}.ts` (фильтр уровня `spawn` у `ROOM_UNREACHABLE` — в `stage.ts`), `src/report/messages.ts` (шаблоны `STAIR_EXIT_OUTSIDE`, `STAIR_HEADROOM` — по таблице сообщений спеки), `src/check.ts`, `test/stairs-check.test.ts`, `test/schema.test.ts` (только удаление `test_demo_full_future`).

Числа demo (`specs/examples/demo.scene.json`, лестница `up`: `from` hall (1.4, 11.6), `dir` 180, `to` loft, width 0.9, rise 0.17, going 0.28): Δy = 3.6, N = round(3.6 / 0.17) = 21, r = 3.6 / 21 = 0.171429, марш (N−1)·going = 5.6, выход (1.4, 6.0). Перекрытие под `loft`: slab = 3.6 − 0 − 3.0 = 0.6, низ на 3.0. Линия носков y(s) = r + s·r/going (r/going = 0.612245); просвет < 2.0 при s > 1.353333, то есть вырез x [0.95, 1.85] × z [6.0, 10.246667].

- `stairs` больше не `SCHEMA_FUTURE_FIELD`; этап `stairs` = `pass` / `fail` (не `skipped`), если в сцене есть лестницы, иначе `skipped` (голден demo-flat не меняется).
- Δy ≤ 0 (выход на том же уровне или ниже) → `STAIR_EXIT_OUTSIDE` до любого деления на N; `msg` содержит id лестницы и `to.room`, координаты выхода в шаблоне = `from.at`.
- Комнаты уровней, отличных от `spawn`, входят в граф (`ROOM_UNREACHABLE`), если до них есть лестница. В `nav` они попадают только в фазе «Лестница: навигация».
- Паспорт: `stairs: [{"id", "n", "rise", "len", "exit": [x, z], "cut": [[x,z], ...] | null}]` после `decals` — ключ есть только если в сцене есть лестницы (у demo-flat его нет, голден не меняется).
- Единственная правка теста фазы 1 во всём плане: `test_demo_full_future` (`test/schema.test.ts`) удаляется — спека v0.7 принимает `stairs`, его место занимает `test_demo_check_ok`.

- [ ] `test_demo_check_ok`: `check` demo → `ok: true`, этап `stairs` = `pass`, в паспорте `up`: n = 21, rise 0.171, len 5.6, exit [1.4, 6], cut — прямоугольник x [0.95, 1.85], z [6, 10.247] (округление отчёта 1e-3)
- [ ] `test_stair_exit_outside`: патч `/stairs/0/from/at` = [1.4, 9.0] → `STAIR_EXIT_OUTSIDE`, `msg` содержит `up`, `(1.4, 3.4)` и `loft`
- [ ] `test_stair_headroom`: патч `/rooms/2/shape` = [[-2,4],[2,4],[2,8],[-2,8]] → `STAIR_HEADROOM`, `msg` содержит `1.353` и просвет `0.624`
- [ ] `test_stair_same_level_refused`: `to.room` = `living` → `STAIR_EXIT_OUTSIDE` этапа `stairs`, `msg` содержит `up` и `living`, в отчёте нет `NaN`, exit 1
- [ ] `test_future_stairs_gone`: `stairs` в demo больше не даёт `SCHEMA_FUTURE_FIELD`
- [ ] реализовать

## Лестница: меши и вырез

Продолжение «Лестница: check и паспорт» — её числа и решения в силе.
Файлы: `src/build/{stairs,slab}.ts`, `src/build/floors.ts`, `src/build/geometry.ts` (сборка ступеней, перил, перекрытия и вырезов; `Mesh.kind` += `"step" | "rail" | "slab"`), `test/stairs-build.test.ts`.

- Пол/потолок с вырезом: `earClip` дыр не умеет — дыра соединяется с внешним контуром мостом (две совпадающие кромки от самой правой вершины дыры к видимой вершине контура), получившийся простой полигон идёт в `earClip`.
- Перила (`up:rail:left|right`) — с той стороны марша, где до внутренней грани стены > 0.15 м. Перила по краю выреза (`up:rail:cut:<k>`, по ребру выреза k) — на всех рёбрах выреза, кроме стороны выхода (z = 6.0 у demo).

- [ ] `test_stair_meshes`: `build` demo → 20 мешей `up:step:<k>`; у `up:step:20` bbox z [6.0, 6.28], y [0, 3.428571]; меш `loft:slab` y [3.0, 3.6], точка (1.4, 8.0) не покрыта ни `loft:slab`, ни `loft:floor`, ни `hall:ceiling`, точка (−1, 8.0) покрыта всеми тремя
- [ ] `test_stair_rail_sides`: у `up` есть `up:rail:left` (сторона x = 0.95, до внутренней грани стены hall > 0.15 м) и нет `up:rail:right` (до внутренней грани x = 1.94 — 0.09 м)
- [ ] `test_cut_rails_skip_exit`: есть `up:rail:cut:<k>` по краям выреза x = 0.95, x = 1.85 и z = 10.246667; ни один меш перил не пересекает отрезок z = 6.0, x [1.0, 1.8] на высоте 3.6–4.6
- [ ] `test_floor_with_hole_area`: площадь треугольников `loft:floor` = площадь комнаты loft − 0.9 · 4.246667 (±1e-4)
- [ ] реализовать

## Лестница: навигация, маршрут, ходьба

Продолжение двух фаз «Лестница» — их числа и решения в силе.
Файлы: `src/nav/{grid,floor}.ts`, `src/routes/{astar,stage}.ts`, `src/runtime/{walk,main}.ts`, `test/stairs-nav.test.ts`, `test/browser/stairs.test.ts`.

Интерфейсы:
- `floorAtRooms(floors, x, z, yPrev, ramps?: NavRamp[]): number | null` — на рампе высота линейна по проекции на `axis` (спека): y = y0 + (y1 − y0) · s / len, s — проекция от `axis.from` вдоль `dir`.
- `findRouteLevels(nav: NavJson, from: {level: string; at: V2}, to: {level: string; at: V2}): {ok: true; path: {level: string; at: V2}[]} | {ok: false; stuck: {level: string; at: V2}}` — A* по слоям, переход между слоями только по `links` через `poly` рампы; `findRoute` фазы «Маршруты» остаётся одноуровневой и вызывается ею.
- Край слоя L1 у выреза со стороны выхода не эродируется: клетки рампы у выхода считаются полом L1.
- Комнаты других уровней входят в `nav` слоями; `nav.layers` — по возрастанию `y`, слой уровня `spawn` первым. `main.ts` стартует со слоя уровня `spawn.room` и передаёт `more = {layers: остальные слои, ramps: nav.ramps}`.
- В слое уровня `from` твёрдое от лестницы — ступени `k` с верхом `k·r > step_max` (у demo k ≥ 2, z ≤ 11.32) и перила; ступень 1 не твёрдая, весь `poly` целиком твёрдым не считается. Внутри `poly` биты слоя не читаются (правило рампы).
- Заливка `navStage` переходит по `links`: если достигнута клетка слоя `from` в 0.3 м от `from.at`, заливка продолжается в слое `to` с клетки выхода (иначе loft даёт `NAV_ROOM_CUT`).
- Внутри `poly` рампы высота — только рампа, полы уровней под ней игнорируются. Проходимость на рампе: точка в `poly`, эродированном на r по боковым сторонам; вне рампы — биты слоя, чей `y` ближе к `fy`.
- `makeWalker(layer, bits, floors, start, more?: {layers: {layer: NavLayer; bits: Uint8Array}[]; ramps: NavRamp[]})` — старые вызовы (`main.ts`, `build-cli.test.ts`) не меняются; `main.ts` передаёт `more` из `nav.json`.

- [ ] `test_nav_ramp_and_link`: `nav.json` demo: `ramps` = [{stair: "up", y0: 0, y1: 3.6, axis: {from: [1.4, 11.6], dir: 180, len: 5.6}, poly — прямоугольник x [0.95, 1.85] × z [6.0, 11.6]}], `links` = [{from: "L0", to: "L1", via: "up"}], слой `L1` есть
- [ ] `test_floor_at_ramp`: `floorAtRooms` + рампа: (1.4, 8.8) при `yPrev` 1.7 → 1.8 (±1e-6); окно `[yPrev − 0.5, yPrev + STEP_MAX]` действует и на рампе
- [ ] `test_l1_exit_walkable`: `navBit` слоя L1 в (1.4, 5.9) = true (выход с рампы не съеден эрозией); `navBit` слоя L0 в (1.4, 11.6) и (1.4, 11.65) = true
- [ ] `test_route_upstairs`: `build` demo, `check --built` → маршруты `in` и `upstairs` проходят; `check` demo даёт `warnings` = [] (нет `NAV_ROOM_CUT` у loft)
- [ ] `test_walk_stairs` (browser): `teleport(1.4, 11.65)`, 150 × `tryMove(0, −0.05)` → z < 6.0, `pos()[1]` = 3.6 + 1.6 (±0.01)
- [ ] реализовать

**Вне этой фазы:** v0.2.
