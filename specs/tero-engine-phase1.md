# Движок сцен, фаза 1: `dreamer check` (план для tero)

Ты пишешь пакет `engine/` в корне репо: `dreamer check SCENE.json` проверяет описание места и выдаёт отчёт с паспортом, `nav.json` и `top.svg`. Сборки (three.js) в этой фазе нет.
**Источник правды — спека `specs/engine-scene.md` (v0.6).** Читай её целиком до первой фазы; разделы указаны в каждой фазе. Если спека и план расходятся, главнее спека. Неоднозначность → вопрос хозяину, не своё решение.

**Цель:** `demo-flat.scene.json` проходит `check` с 0 ошибок и 0 предупреждений, а каждая «сломанная» сцена даёт ровно свой код с понятным `msg`.
**Архитектура:** этапы `check` идут по порядку спеки (schema → plan → openings → stairs → props → decals → cameras → nav). Каждый этап — функция `(ctx) → Issue[]`, которая дописывает свои данные в общий `Ctx` и паспорт. Есть ошибки на этапе — остальные `skipped`. Этап `stairs` в фазе 1 всегда `skipped`; этап фазы 1, ещё не написанный в текущей фазе плана, даёт `pass` без issues.
**Стек:** TypeScript (ESM, `strict`), Node ≥ 22, `ajv` 8, `clipper2-ts@2.0.1` (точная версия), `vitest`, `tsx`. Больше зависимостей нет: ни three, ни playwright.

**Правила для всех фаз:**
- Писать только в `engine/**`. `specs/` (включая `specs/examples/*.scene.json`) — только чтение.
- Тесты: `cd engine && npm test` (= `vitest run`). Офлайн, весь набор ≤ 30 с. Сначала красный тест, потом код.
- Пути в тестах: сцены — через `new URL(..., import.meta.url)`: из `test/*.test.ts` — `../../specs/examples/…`, из `test/helpers/` — `../../../specs/examples/…`; всё, что тест пишет, — только в `fs.mkdtemp(os.tmpdir())`. CLI в тестах запускается как `node --import tsx bin/dreamer.ts ...` с `cwd` = `engine/`.
- Код и комментарии на английском.
- Числа в отчёте округляются до 1e-3 **только при выводе** (`round3` в `report.ts`); внутри — полная точность, `EPS = 1e-6`, `SNAP_EPS = 0.10`. Сравнения вычисленных чисел в тестах — `toBeCloseTo(x, 6)` (до округления) или точное равенство после `round3` (отчёт).
- Углы: 0 = +Z, 90 = +X. Из вектора `(x, z)` угол = `deg(atan2(x, z))` mod 360; обратно `(sin θ, cos θ)`. Поворот локального `(lx, lz)` — формула из «Соглашений» спеки.
- clipper: `import {Clipper, JoinType, EndType} from "clipper2-ts"`; `Clipper.inflatePaths(paths, delta, joinType, endType, miterLimit)`, координаты в целых миллиметрах (×1000), площадь `Clipper.area`. Стена: `delta = thickness/2`, `EndType.Joined` для замкнутой цепочки, `EndType.Square` для открытой. ajv: `import Ajv2020 from "ajv/dist/2020.js"` (если TS NodeNext ругается на тип — `Ajv2020.default`).
- **Тесты фазы проверяют issues только своих этапов** (`issue.stage`). «0 ошибок на весь отчёт» утверждают только `demo-flat` и сломанные сцены. Многокомнатные тестовые сцены соединяй дверью.
- **Сломанные сцены** — JSON Patch (RFC 6902: только `add`/`replace`/`remove`) поверх `demo-flat`: `test/scenes/broken/<CODE>.patch.json` (ровно 1 error этого кода, 0 warnings) и `test/scenes/warn/<CODE>.patch.json` (0 errors, ровно 1 warning). Хелпер `test/helpers/scene.ts`: `demoFlat()` и `patched(ops)` (свой код на 30 строк, без зависимостей). Исключение — `broken/SCHEMA_PARSE.scene.json` (сырой текст). Патчи из чек-листов ниже переносятся дословно; их прогнал исполняемый оракул. Имя кода = имя файла без `.patch.json` / `.scene.json`. CLI на патч: тест применяет патч и пишет сцену в `mkdtemp`.
- `runCheck(raw, {until?: Stage})` — тесты этапов до `nav` передают `until`; полный `runCheck(demo-flat)` — один раз на файл в `beforeAll`.
- Голден `engine/test/golden/demo-flat.check.json` пишется только командой `UPDATE_GOLDEN=1 npm test`; без файла тест **падает**, а не создаёт его. Голден не заменяет явные проверки: числа из чек-листов обязаны стоять в тестах как `expect(...)`.
- Вне фазы 1 целиком: `STAIR_EXIT_OUTSIDE`, `STAIR_HEADROOM`, `ROUTE_BLOCKED` есть в `codes.ts`, но не выдаются; `routes` не проверяются, ссылки в `routes[].path` не валидируются (там бывают id лестниц); расположение `lights`, `cameras.look`, `style` — только схема.

**Review Focus** (что спека подразумевает и что чаще всего сломается у живого автора; тест на каждое — в фазе, что владеет кодом):
- автор скопировал jsonc-комментарий из спеки → `SCHEMA_PARSE` со строкой и столбцом, exit 1, а не падение (`test_cli_exit_codes`);
- комната, записанная по часовой стрелке → тот же паспорт, что и против (`test_winding_invariant`);
- комната-`circle` и проём на ней через шов `t = 0` (`test_circle_room`, `test_circle_window_seam`);
- две подряд одинаковые вершины → понятная ошибка, а не исключение (`test_degenerate_edge`);
- полка `mount: wall` на дуге не «заходит в стену» (`test_wall_mount_arc`); предмет вплотную к стене или соседу — не пересечение (`test_touching_not_hit`).

**Судье:** фаза принимается только по своему чек-листу и списку «Вне этой фазы»; поведение следующих фаз не требовать. Сверяй с разделами спеки, указанными в фазе. Патчи сломанных сцен должны совпадать с планом дословно. В последней фазе сверь числа голдена (`living#1.arc`, `front.hinge_at`, `chairs.0`, центр наклейки) с чек-листами, а `nav.layers[0].origin/w/h` — по `test_nav_probes`.

**Перед запуском (делает хозяин, не tero):** каркас `engine/` — `package.json` (`"type": "module"`, scripts `test`, `check`), `tsconfig.json`, `vitest.config.ts`, `test/smoke.test.ts` (один зелёный тест), установленные зависимости; команда тестов tero = `cd engine && npm test`. tero требует зелёный старт.

## Схема, коды и отчёт

Спека: «Соглашения», «Формат SCENE.json» (пример и таблица полей), «Проверка» → «Отчёт», «Ошибка (Issue)», «Сообщения», каталог кодов, «Объём».
Файлы: `schema/engine-scene.schema.json`, `src/types.ts`, `src/ctx.ts`, `src/report/{codes,messages,report}.ts`, `src/schema/{parse,validate,refs}.ts`, `src/check.ts`, `bin/dreamer.ts`, `test/helpers/scene.ts`, `test/schema.test.ts`, `test/scenes/broken/` — `SCHEMA_PARSE.scene.json` и `{SCHEMA_UNKNOWN_FIELD,SCHEMA_FUTURE_FIELD,SCHEMA_TYPE,SCHEMA_REQUIRED,SCHEMA_EXCLUSIVE,ID_DUPLICATE,REF_UNKNOWN,REF_KIND,ROOM_REF_MISMATCH,POS_INVALID}.patch.json`.

Интерфейсы (их используют все следующие фазы):
- `type Code` — строковый union всех кодов каталога; `CODES: Record<Code, {stage: Stage, level: "error" | "warn"}>`; `type Stage = "schema"|"plan"|"openings"|"stairs"|"props"|"decals"|"cameras"|"nav"`.
- `interface Issue {code: Code; stage: Stage; path: string; msg: string; copy?: number; fix?: Record<string, unknown>}`; `msg(code, params)` в `messages.ts` — по шаблонам спеки.
- `interface Report {ok: boolean; stages: {stage: Stage; status: "pass"|"fail"|"skipped"}[]; passport: Passport; errors: Issue[]; warnings: Issue[]}` — `Passport` = `{edges, snaps, openings, props, decals}` как в спеке; в этой фазе все списки пустые.
- `Ctx = {scene: Scene; rooms?: RoomGeo[]; levels?: Map<string, LevelPlan>; openings?: OpeningGeo[]; graph?: Map<string, string[]>; props?: PropGeo[]; decals?: DecalGeo[]; nav?: NavJson; passport: Passport}` — типы полей определяют следующие фазы; имена полей фиксированы здесь.
- `parseScene(text: string): {raw: unknown | null; issues: Issue[]}` — `JSON.parse`; ошибка → `SCHEMA_PARSE`; строку и столбец считай сам из `position N` (текст сообщения V8 зависит от версии).
- `validate(raw: unknown): {scene: Scene | null; issues: Issue[]}` — после этапа `schema` `scene` содержит умолчания из таблицы полей.
- `runCheck(raw: unknown, opts?: {until?: Stage}): {report: Report; ctx: Ctx}`.
- CLI: `bin/dreamer.ts check <scene> [--report <path>]` — печатает отчёт в stdout, пишет его в `--report` (иначе `<scene>.check.json`), exit 0 (нет ошибок) / 1 (есть, включая `SCHEMA_PARSE`) / 2 (внутреннее падение, файл не читается).

Решения:
- Схема ajv (draft 2020-12, `allErrors: true`, `additionalProperties: false` везде). Пары исключения — `not: {required: [a, b]}` (не `oneOf`). Ошибки ветвей `anyOf`/`oneOf` (вершина, `mount`, `face`) не выводятся: на узел — одна запись `SCHEMA_TYPE` по его `instancePath`. Вершина `shape` — `prefixItems` `[number, number, {bulge}]`, `minItems` 2, `maxItems` 3. «Ровно одно из» (`shape`/`circle`, `tile`/`color`) — кодом: нет ни одного → одна запись `SCHEMA_REQUIRED` с `path` = объект + `/` + первый ключ пары; оба → `SCHEMA_EXCLUSIVE`.
- `FUTURE_FIELDS` — JSON-pointer шаблоны, не в схеме: `/walls`, `/fixtures`, `/stairs`, `/shafts`, `/holes`, `/columns`, `/behaviors`, `/takes`, `/rooms/*/spans`, `/props/*/collider`. Встретил → `SCHEMA_FUTURE_FIELD` с `path` = этот указатель; `SCHEMA_UNKNOWN_FIELD` на том же пути подавляется. `{когда}` и `{замена}` в `msg` — по таблице «Сообщения» спеки. `rooms[].walls` — обычное поле.
- Ошибки ajv → коды: `additionalProperties` → `SCHEMA_UNKNOWN_FIELD`; `required` → `SCHEMA_REQUIRED`; `not` пары → `SCHEMA_EXCLUSIVE`; все прочие (`type`, `minimum`, `maximum`, `exclusiveMinimum`, `enum`, `const`, `minItems`, `pattern`, …) → `SCHEMA_TYPE`. `path` = `instancePath`, а для `required`/`additionalProperties` — `instancePath + "/" + missingProperty|additionalProperty`. На один `path` — одна запись, приоритет EXCLUSIVE > FUTURE > REQUIRED > UNKNOWN_FIELD > TYPE.
- Проверки кодом в том же этапе (ajv их не выражает): `bulge` = 0 и `bands[].to` не строго возрастают или > `height` → `SCHEMA_TYPE`.
- Ссылки — только если ajv дал 0 ошибок: `ID_DUPLICATE` (id комнат, проёмов, предметов, камер, маршрутов — одно пространство имён), `REF_UNKNOWN` (материал, ассет, комната, уровень, `around.center`, `mount.top_of`, `face: "<id>"`, `on.edge` вне `0…n−1`, ключи `room.edges`, цикл `top_of`; `routes` — нет), `REF_KIND`, `ROOM_REF_MISMATCH`, `POS_INVALID`.
- `POS_INVALID` в этой фазе: `az` на ребре без `bulge` (не `circle`); `face: [x,z]` или `face: "<id>"` с явным `at` цели, совпадающие с `at` в пределах `EPS`. `az` вне углового диапазона дуги добавляется в фазе «Рёбра комнат» (тот же код, `stage: "schema"`, вызов из `refs.ts`). Совпадение с вычисленной целью (`around`/`top_of`) ловит `placeProps` — тоже `POS_INVALID`, не NaN.

- [ ] `test_demo_flat_schema_pass`: `demo-flat` → этап `schema` = `pass`, 0 issues
- [ ] `test_demo_full_future`: `specs/examples/demo.scene.json` → ровно одна ошибка: `SCHEMA_FUTURE_FIELD`, `path` `/stairs`
- [ ] `test_broken_schema_codes` — у каждого файла `errors` = ровно `[свой код]` с этим `path`:
  - `SCHEMA_UNKNOWN_FIELD`: `[{"op":"add","path":"/rooms/0/colour","value":"#ff0000"}]` → path `/rooms/0/colour`
  - `SCHEMA_FUTURE_FIELD`: `[{"op":"add","path":"/props/0/collider","value":"hull"}]` → path `/props/0/collider`
  - `SCHEMA_TYPE`: `[{"op":"replace","path":"/rooms/0/shape/1/2/bulge","value":1.5}]` → path `/rooms/0/shape/1/2/bulge`
  - `SCHEMA_REQUIRED`: `[{"op":"remove","path":"/rooms/1/height"}]` → path `/rooms/1/height`
  - `SCHEMA_EXCLUSIVE`: `[{"op":"add","path":"/rooms/0/circle","value":{"c":[0,0],"r":5}}]` → path `/rooms/0`
  - `ID_DUPLICATE`: `[{"op":"replace","path":"/openings/0/id","value":"hall"}]`
  - `REF_UNKNOWN`: `[{"op":"replace","path":"/rooms/0/floor","value":"nope"}]`
  - `REF_KIND`: `[{"op":"replace","path":"/decals/0/asset","value":"p_chair"}]`
  - `ROOM_REF_MISMATCH`: `[{"op":"replace","path":"/decals/0/room","value":"hall"}]`
  - `POS_INVALID`: `[{"op":"replace","path":"/decals/0/on","value":{"room":"living","edge":2,"az":90}}]`
  - `SCHEMA_PARSE`: `broken/SCHEMA_PARSE.scene.json` = текст demo-flat с добавленной строкой `// comment` после `{` → path `""`, msg содержит `строка 2`
- [ ] `test_exclusive_pairs`: проём с `at` и `on`; предмет с `face` и `yaw`; материал с `tile` и `color`; `on` с `t` и `m`; `around` вместе с `at` → по одной записи `SCHEMA_EXCLUSIVE` на объект; материал без `tile` и `color` → ровно одна запись `SCHEMA_REQUIRED`, path `/materials/<id>/tile`; `bulge` 1.5 → ровно одна запись (нет лишней на `/rooms/0/shape/1`)
- [ ] `test_schema_code_checks`: `bulge` 0 → `SCHEMA_TYPE`; `bands` `[{"to":1.0},{"to":0.5}]` → `SCHEMA_TYPE`; `room.edges` с ключом `"9"` → `REF_UNKNOWN`; предмет `face` [0, 0] при `at` [0, 0] → `POS_INVALID`
- [ ] `test_defaults_applied`: минимальная сцена (одна комната 4×4, окно `on` с `outside`, наклейка, свет `point`, камера, все без необязательных полей, без `props`) → после `validate` `walls.thickness` = 0.12, окно `height`/`sill` = 1.2/0.9, `decal.y` = 1.6, `light.power` = 1.0, `camera.fov` = 60, `spawn.yaw` = 0, `props` = []
- [ ] `test_stop_after_failed_stage`: `broken/SCHEMA_TYPE` → `stages` = schema `fail`, остальные 7 `skipped`
- [ ] `test_cli_exit_codes`: CLI на demo-flat → exit 0 и файл по `--report`; на `broken/SCHEMA_TYPE` → exit 1; на `broken/SCHEMA_PARSE` → exit 1 и отчёт с `SCHEMA_PARSE`; на несуществующем файле → exit 2
- [ ] реализовать

**Вне этой фазы:** геометрия, паспорт, все коды кроме этапа `schema`.

## Рёбра комнат

Спека: «Модель стены» (ось, дуга, `circle`), «Соглашения» (ребро от `shape[i]`), «Отчёт» (`passport.edges` без `sides`), линтер: `ROOMS_OVERLAP`, `ROOM_SELF_INTERSECT`.
Файлы: `src/geom/{vec,poly,arc}.ts`, `src/plan/{rooms,lint}.ts`, `test/rooms.test.ts`, `test/scenes/broken/{ROOMS_OVERLAP,ROOM_SELF_INTERSECT}.patch.json`.

Интерфейсы:
- `type V2 = [number, number]` (x, z).
- `arcFromBulge(p0: V2, p1: V2, b: number, inward: V2): {c: V2; r: number; apex: V2}` — `a = |p1−p0|/2`, `s = |b|·a`, `R = (a² + s²)/(2s)`, `n` = нормаль хорды наружу от комнаты при `b > 0` и внутрь при `b < 0`; `apex = mid + n·s`, `c = mid + n·(s − R)`.
- `discretizeArc(arc, p0, p1, maxSeg = 0.25): V2[]` — равные сегменты ≤ 0.25 м, концы точно `p0`, `p1`.
- Внутренняя нормаль ребра: полигон по хордам, знаковая площадь `A = ½Σ(xᵢzᵢ₊₁ − xᵢ₊₁zᵢ)`; ребро с направлением `d`: `A > 0` → внутрь `(−d.z, d.x)`, иначе `(d.z, −d.x)`. `circle` → ребро 0, внутрь = к центру. У дуги нормаль в точке — радиальная к центру (или от него при `b < 0`).
- `compileRooms(scene): {rooms: RoomGeo[]; issues: Issue[]}`; `RoomGeo = {id, level, height, edges: AuthorEdge[], outline: V2[], closed: boolean}` — `outline` = ось с дугами, в авторском порядке; `AuthorEdge = {room, i, from: V2, to: V2, arc: {c: V2, r: number} | null, len, normalIn: V2}` (`len` дуги — длина дуги; у `circle` `from` = `to` = точка az 0; `normalIn` дуги — в её середине).
- Паспорт ребра: `id` = `"<room>#<i>"`.

Решения:
- Порядок в `compileRooms`: сначала нулевые рёбра (`|p1 − p0| < EPS`) → `ROOM_SELF_INTERSECT` (path `/rooms/<r>/shape/<i>`), дуги строятся только для комнат без такой ошибки.
- `ROOMS_OVERLAP`: clipper-пересечение `outline` двух комнат уровня > 0.01 м²; комнаты с `ROOM_SELF_INTERSECT` не участвуют. `ROOM_SELF_INTERSECT`: несмежные сегменты `outline` пересекаются; одна запись на комнату.

- [ ] `test_demo_flat_edges`: `living#1` — `arc.c` = [0, 0.2], `arc.r` = 5.8, `len` = 8.828 (round3); `living#3` — `from` [4,4], `to` [−4,4], `normal_in` = [0, −1]
- [ ] `test_two_arcs_geometry`: A `[[3,0,{"bulge":1}],[-3,0],[-3,-4],[3,-4]]`, B `[[-3,0,{"bulge":-1}],[3,0],[3,6],[-3,6]]`, дверь `on {"room":"A","edge":0,"t":0.5}` width 0.9 → обе дуги c [0,0] r 3, apex (0, 3); `ROOMS_OVERLAP` нет
- [ ] `test_broken_plan_codes`: `ROOMS_OVERLAP`: `[{"op":"replace","path":"/rooms/1/shape","value":[[-2,3],[2,3],[2,12],[-2,12]]}]`; `ROOM_SELF_INTERSECT`: `[{"op":"replace","path":"/rooms/1/shape","value":[[-2,4],[2,12],[2,4],[-2,12]]}]` → ровно свой код
- [ ] `test_circle_room`: `circle` c [0,0] r 3 → одно ребро `room#0`, `arc.r` = 3, `len` = 18.85 (round3), `from` = [0, 3]
- [ ] `test_pos_invalid_arc`: `[{"op":"replace","path":"/decals/0/on","value":{"room":"living","edge":1,"az":90}}]` → этап `schema`: `POS_INVALID` (дуга `living#1` занимает az [136.4°, 223.6°]); то же с `az` 160 → этап `schema` без issues
- [ ] `test_degenerate_edge`: `[[0,0],[4,0],[4,0],[4,4],[0,4]]` → `ROOM_SELF_INTERSECT` с path `/rooms/0/shape/1`, не исключение; то же, если у повторной вершины есть `bulge`
- [ ] `test_winding_invariant`: квадрат x[0,4] z[0,4] по и против часовой → у ребра на z = 0 одинаковый `normal_in` [0, 1]; рёбра пронумерованы по авторскому порядку
- [ ] реализовать

**Вне этой фазы:** слияние рёбер, тело стены, `sides`, проёмы.

## Слияние плана и тело стен

Спека: «Модель стены» п. 1–5, «Отчёт» (`passport.edges[].sides`, `snaps`, `fix`), предупреждение `EDGES_DRIFT`.
Файлы: `src/plan/{merge,body,drift}.ts`, `test/merge.test.ts`, `test/scenes/warn/EDGES_DRIFT.patch.json`.

Интерфейсы:
- `mergeLevel(rooms: RoomGeo[], level: string): LevelPlan`; `LevelPlan = {intervals: Interval[]; snaps: {from: V2; to: V2}[]; body: Path64[]}`; `Interval = {from: V2, to: V2, arc: {c, r} | null, sides: {room: string, edge: number, m: [number, number]}[], thickness: number}` — `m` по авторскому ребру стороны от его `shape[i]`; 0, 1 или 2 стороны.
- `wallBody(intervals): Path64[]` — по спеке (цепочки, рвутся в вершине степени ≠ 2; Miter limit 2; `Joined` для замкнутых, `Square` для открытых; union). `Path64` — тип clipper2-ts.
- Паспорт `edges[e].sides` — **другие** комнаты на интервалах ребра `e`, `m` в координатах ребра `e`, соседние интервалы с одной комнатой слиты.

Решения:
- Слияние вершин — по порядку: каждая вершина притягивается к первой ранее встреченной в радиусе `SNAP_EPS`; сдвиг > `EPS` → запись в `snaps`.
- Коллинеарная группа: опорная прямая — первое ребро группы; концы всех рёбер проецируются на неё, режутся на интервалы, у каждого интервала — стороны, чьи рёбра его покрывают.
- `EDGES_DRIFT` (warn): параллельные (< 2°) прямые рёбра разных комнат на расстоянии `[SNAP_EPS, 0.5)` с перекрытием проекций > 0. Двигается ребро более поздней в `rooms` комнаты; `path` `/rooms/<r>/shape`, `fix: {"<k>": [x,z], "<(k+1)%n>": [x,z]}`; у вершины с `bulge` третий элемент сохраняется.

- [ ] `test_demo_flat_sides`: `living#3.sides` равно `[{room: "hall", m: [2, 6]}]`; `hall#0.sides` = `[{room: "living", m: [0, 4]}]`; ровно 3 интервала на z = 4: x [−4,−2] {living}, [−2,2] {living, hall}, [2,4] {living}
- [ ] `test_t_junction`: A x[0,6] z[0,4]; B x[0,3] z[4,8]; C x[3,6] z[4,8] → верх A делится на [0,3] {A,B} и [3,6] {A,C}; общая стена B|C — один интервал с двумя сторонами
- [ ] `test_partial_overlap`: A x[0,6] z[0,4]; B x[2,4] z[4,8] → [0,2] {A}, [2,4] {A,B}, [4,6] {A}
- [ ] `test_two_arcs_shared`: A `[[3,0,{"bulge":1}],[-3,0],[-3,-4],[3,-4]]`, B `[[-3,0,{"bulge":-1}],[3,0],[3,6],[-3,6]]` → одна дуга-интервал c [0,0] r 3 с двумя сторонами
- [ ] `test_snap`: A x[0,4] z[0,4], B `[[4+δ,0],[8,0],[8,4],[4+δ,4]]`. δ = 0.06 → вершины слились, 2 записи в `snaps`, общий интервал с двумя сторонами. δ = 0.3 → этап `plan`: 0 ошибок, 1 `EDGES_DRIFT` с path `/rooms/1/shape`, `fix` = `{"3": [4,4], "0": [4,0]}`
- [ ] `test_drift_warn_file`: `warn/EDGES_DRIFT`: `[{"op":"replace","path":"/rooms/1/shape","value":[[-2,4],[0.6,4],[1,4.3],[2,4.3],[2,12],[-2,12]]}]` → 0 ошибок, ровно `EDGES_DRIFT` (living#3 и hall#2, 0.3 м), `fix` = `{"2": [1,4], "3": [2,4]}`; сцена с применённым `fix` → 0/0
- [ ] `test_wall_body_mitre`: квадрат 4×4, t 0.12 → тело = кольцо из 2 контуров, внешний 4.12×4.12, внутренний 3.88×3.88 (площади 16.9744 и 15.0544 м², ±1e-3)
- [ ] `test_wall_body_open_t`: T-стык из `test_t_junction` → у тела ровно 1 внешний контур; точки (3, 4), (3, 6), (0, 4) внутри тела, (3.1, 4.1) — нет
- [ ] реализовать

**Вне этой фазы:** вырезы проёмов в теле, предметы.

## Проёмы и граф

Спека: «Проёмы» целиком, «Модель стены» (проём на дуге, `circle`, ширина по хорде), «Проверка» (производные коды внутри этапа), линтер (проёмы, граф), «Отчёт» (`passport.openings`), «Сообщения».
Файлы: `src/openings/{resolve,swing,graph}.ts`, `test/openings.test.ts`, `test/scenes/broken/{OPENING_*,ROOM_UNREACHABLE}.patch.json`.

Интерфейсы:
- `resolveOpenings(ctx): OpeningGeo[]`; `OpeningGeo = {id, kind, interval: Interval, edge: string /* "living#3" */, m: number, mRange: [number, number], center: V2 /* точка оси */, axis: V2 /* вдоль ребра */, rooms: string[] /* 1 или 2 */, sill, height, width, swing: string | null, hingeAt: V2 | null, hinge: "left"|"right"|null, corridor: V2[] /* 4 точки */, sector: V2[] | null /* 17 точек */}`.
- `roomGraph(ctx): Map<string, string[]>` — рёбра через все проёмы без ошибок, включая закрытые двери.
- После этапа `LevelPlan.body` = тело минус вырезы: прямой проём — прямоугольник `width × (thickness + 2·EPS)`; на дуге — по спеке (полилайн между концами хорды заменён хордой, затем вырез по хорде).

Решения:
- `at`: ближайший интервал уровня, расстояние до оси < `SNAP_EPS`; иначе `OPENING_NO_WALL` с расстоянием и адресом ближайшего, `fix` = проекция. `on`: ребро и `t`/`m`/`az` напрямую; на `circle` `m` по модулю длины.
- `mRange` = `m ± width/2` (прямое), `m ± R·asin(width/2 / R)` (дуга). `OPENING_OFF_EDGE`: `mRange` выходит за интервал (кроме замкнутого `circle`). `OPENING_OVERLAP`: на одном интервале `mRange` пересекаются (запись — у более позднего). `OPENING_TOO_HIGH`: `sill + height` > потолка любой стороны. `OPENING_NO_OUTSIDE`: одна сторона и нет `outside`. `ROOM_UNREACHABLE`: BFS от комнаты `spawn` по комнатам уровня `spawn`, только если других ошибок этапа нет.
- `swing`, петля и сектор — формулы спеки, только у `door` с `leaf` (сектор — при `open: true`). Сектор = 17 точек: петля + 16 точек дуги радиусом `width` от направления на второй косяк до `normalIn` `swing`-комнаты.

- [ ] `test_demo_flat_front`: паспорт `front` — `edge` "living#3", `m` 4.0, `rooms` ["living", "hall"], `swing` "living", `hinge` "left" (дверь по центру ребра = ничья → left), `hinge_at` [0.45, 3.94]
- [ ] `test_hinge_not_tie`: `[{"op":"replace","path":"/openings/0/at","value":[1.5,4]}]` → `hinge` "left", `hinge_at` [1.95, 3.94] (косяк к углу (4,4))
- [ ] `test_demo_flat_window_arc`: `sea` на `living#1`, `center` (0, −5.6), `rooms` ["living"], `swing`/`hinge` null, без ошибок
- [ ] `test_corridor_height`: коридор окна sill 1.0, height 1.0 → по высоте [1.0, 2.0]
- [ ] `test_body_after_cut`: площадь тела demo-flat после вырезов меньше; вклад `front` — ровно 0.9 × 0.12 = 0.108 ± 1e-3
- [ ] `test_circle_window_seam`: `circle` c [0,0] r 3, окно `on` `t` 0, width 1.0, с `outside` → без ошибок, `center` (0, 3)
- [ ] `test_door_at_corner`: `broken/OPENING_OFF_EDGE`: `[{"op":"add","path":"/openings/-","value":{"id":"w2","kind":"window","at":[3.8,4],"width":0.9,"outside":{"backdrop":"d_sea"}}}]` → ровно `OPENING_OFF_EDGE`, не перенос на `living#2`
- [ ] `test_broken_opening_codes` — ровно свой код:
  - `OPENING_NO_WALL`: `[{"op":"add","path":"/openings/-","value":{"id":"w2","kind":"window","at":[4.5,0],"width":0.9,"outside":{"backdrop":"d_sea"}}}]`; `fix` = `{"at": [4, 0]}`
  - `OPENING_OVERLAP`: `[{"op":"add","path":"/openings/-","value":{"id":"w2","kind":"window","on":{"room":"living","edge":1,"t":0.55},"width":1.6,"outside":{"backdrop":"d_sea"}}}]`
  - `OPENING_TOO_HIGH`: `[{"op":"replace","path":"/openings/0/height","value":3.2}]`
  - `OPENING_NO_OUTSIDE`: `[{"op":"remove","path":"/openings/1/outside"}]`
  - `ROOM_UNREACHABLE`: `[{"op":"add","path":"/rooms/-","value":{"id":"closet","level":"L0","height":3.0,"shape":[[4,0],[6,0],[6,4],[4,4]],"floor":"parquet","ceiling":"white","walls":{"material":"white","bands":[{"to":0.12,"material":"wood"}]}}}]`
- [ ] `test_closed_door_in_graph`: `[{"op":"replace","path":"/openings/0/leaf/open","value":false}]` → у этапа `openings` нет `ROOM_UNREACHABLE`
- [ ] реализовать

**Вне этой фазы:** предметы в проёмах, навигация.

## Расстановка предметов

Спека: «Предметы» целиком, таблица `cat`, «Модель стены» (настенные вещи, дуга), `passport.props`.
Файлы: `src/geom/obb.ts`, `src/props/{place,cats}.ts`, `test/place.test.ts`.

Интерфейсы:
- `OBB = {c: V2; half: [number, number] /* w/2, d/2 */; yaw: number}`; `obbCorners(o): V2[]` — обход с `A = ½Σ(xᵢzᵢ₊₁ − xᵢ₊₁zᵢ) > 0`, от локального (−w/2, −d/2); `obbIntersects(a, b): boolean` (SAT, пересечение строго > `EPS`); `obbPolyIntersects(o, paths): boolean` (clipper-площадь > 1e-6 м²).
- `placeProps(ctx): PropGeo[]`; `PropGeo = {id /* "chairs.0" для копий */, src: number, copy?: number, room, obb: OBB, y: [number, number], wall: string | null, solid, size}`.
- `CATS: Record<string, {w, d, h, hMax?: number}>` — значения спеки; `chair.hMax = 1.6`.

Решения:
- `yaw` по `face`: `"room"` → нормаль ближайшего ребра своей комнаты в ближайшей точке (расстояние от `at` до внутренней грани); `"<id>"`/`[x,z]` → угол вектора `at → цель`. `around`: `θₖ = start + k·360/n`, позиция `center + r·(sin θₖ, cos θₖ)`, `yaw = θₖ + 180`.
- `mount`: `floor` → y [0, h]; `ceiling` → верх = `room.height`, а если OBB-след пересекает след балки — `room.height − beam.h`; `wall` → ближайшее (по оси) ребро своей комнаты или `on`; прямое: центр = точка на оси + `normalIn·(t/2 + 0.02 + d/2)`; дуга: нормаль радиальная в точке `m`, задняя грань — хорда длиной `w`, концы на внутренней грани + 0.02, центр = середина хорды + нормаль·`d/2`; `yaw` = угол нормали, y [`prop.y`, `prop.y + h`]; `{top_of}` → низ = верх опоры, `at` по умолчанию = центр опоры.
- Нет `face`/`yaw` у `floor`/`top_of` вне `around`, или для `mount: wall` нет ребра своей комнаты ближе 1.0 м → предмет не попадает в `PropGeo`, исключения нет (код выдаёт фаза линтера). Опоры нет в `PropGeo` → её `top_of`-предметы тоже пропускаются.

- [ ] `test_demo_flat_chairs`: `chairs.0..3` центры (0, 0.9), (0.9, 0), (0, −0.9), (−0.9, 0), `yaw` 180, 270, 0, 90
- [ ] `test_demo_flat_sofa_lamp_vase`: диван `yaw` 90, OBB по x [−3.9, −3.0], по z [0.5, 2.5]; лампа y [2.8, 3.4] (не под балкой); ваза y [0.75, 1.15]
- [ ] `test_four_yaws`: предмет w 2.0 d 0.5 с `face` на точку +Z/+X/−Z/−X → `yaw` 0/90/180/270, AABB 2.0×0.5 при 0/180 и 0.5×2.0 при 90/270
- [ ] `test_ceiling_under_beam`: `[{"op":"replace","path":"/props/4/at","value":[0,0]}]` (лампа под балкой z = 0, h 0.3) → y [2.5, 3.1]
- [ ] `test_wall_mount`: шкаф w 0.8 d 0.4 h 0.8 `mount: wall` `at` [−3.5, 1] в `living` → центр x = −4 + 0.06 + 0.02 + 0.2 = −3.72, `yaw` 90, `wall` "living#0", y [1.0, 1.8]
- [ ] `test_passport_props`: у `chairs.0` в паспорте `obb` — 4 угла, обход с `A > 0`, `aabb` [[−0.25, 0.65], [0.25, 1.15]]
- [ ] реализовать

**Вне этой фазы:** линтер предметов, нормализация GLB, фактический размер после сборки.

## Линтер предметов

Спека: линтер (предметы), предупреждения (`PROP_SIZE_ODD`, `FACE_ROOM_FAR`), «Ошибка (Issue)» (`fix`, `copy`), «Сообщения».
Файлы: `src/props/lint.ts`, `test/props-lint.test.ts`, `test/scenes/broken/PROP_*.patch.json`, `test/scenes/warn/{PROP_SIZE_ODD,FACE_ROOM_FAR}.patch.json`.

Решения:
- Только для `solid`: `PROP_HITS_WALL`, `PROP_HITS_PROP`, `PROP_IN_DOORWAY`, `PROP_IN_SWING`. Для всех: `PROP_OUTSIDE_ROOM`, `PROP_ON_TOO_SMALL`, `PROP_CEILING_LOW`, `PROP_ABOVE_CEILING`, `PROP_WALL_NOT_FOUND`, `PROP_NO_FACING`, предупреждения.
- `PROP_OUTSIDE_ROOM` — центр OBB вне `outline` своей комнаты (`fix` `{room}`, если он в другой); `PROP_HITS_WALL` — OBB ∩ тело стены или след балки при пересечении по y; глубина = заход OBB за внутреннюю грань по нормали; `fix` = `{at}`, сдвиг по нормали на глубину + 0.01; `PROP_HITS_PROP` — OBB ∩ OBB и интервалы y пересекаются строго (опора и то, что на ней, не сравниваются), запись — у более позднего; `PROP_IN_DOORWAY` — OBB ∩ коридор и y ∩ [sill, sill + height]; `PROP_IN_SWING` — OBB ∩ сектор; `PROP_ON_TOO_SMALL` — след не внутри следа опоры; `PROP_CEILING_LOW` — `ceiling` и низ < 2.0; `PROP_ABOVE_CEILING` — верх > потолка комнаты (или низа балки над следом) + `EPS`; `PROP_WALL_NOT_FOUND` — нет ребра своей комнаты ближе 1.0 м (до оси); `PROP_NO_FACING` — нет `face`/`yaw` у `floor`/`top_of` вне `around`. Предупреждения: `PROP_SIZE_ODD` (любая сторона вне ×0.5…×1.6 от `cat`, для `hMax` — h до `hMax`), `FACE_ROOM_FAR`.
- Предмет с `PROP_NO_FACING` или `PROP_WALL_NOT_FOUND` не размещается и дальше не проверяется (один дефект — одна запись). Ошибка копии `around`: `path` `/props/<i>`, `copy` = k, без `fix`.

- [ ] `test_demo_flat_props_clean`: этап `props` demo-flat — 0 issues (стулья в 0.10 от стола, диван в 0.04 от стены)
- [ ] `test_touching_not_hit`: `[{"op":"replace","path":"/props/2/at","value":[-3.49,1.5]}]` (задняя грань дивана x = −3.94 = внутренняя грань) и стул вплотную к столу (`around.r` 0.8) → ни `PROP_HITS_WALL`, ни `PROP_HITS_PROP`
- [ ] `test_wall_mount_arc`: `[{"op":"add","path":"/props/-","value":{"id":"shelf","asset":"p_table","room":"living","on":{"room":"living","edge":1,"t":0.3},"y":1.2,"size":{"w":1.0,"d":0.3,"h":0.5},"mount":"wall"}}]` → этап `props`: 0 issues, `wall` "living#1"
- [ ] `test_broken_prop_codes` — ровно свой код:
  - `PROP_HITS_WALL`: `[{"op":"replace","path":"/props/2/at","value":[-3.67,1.5]}]` → `fix` `{"at": [-3.48, 1.5]}`, msg содержит `living#0` и `0.18`
  - `PROP_HITS_PROP`: `[{"op":"add","path":"/props/-","value":{"id":"pouf","asset":"p_table","room":"living","at":[-3.0,1.5],"size":{"w":0.5,"d":0.5,"h":0.4},"yaw":0}}]`
  - `PROP_IN_DOORWAY`: `[{"op":"add","path":"/props/-","value":{"id":"cab","asset":"p_table","room":"hall","at":[0,4.4],"size":{"w":1.0,"d":0.4,"h":1.8},"yaw":180}}]`
  - `PROP_IN_SWING`: `[{"op":"add","path":"/props/-","value":{"id":"box","asset":"p_table","room":"living","at":[0,3.12],"size":{"w":0.3,"d":0.1,"h":0.5},"yaw":0}}]`
  - `PROP_OUTSIDE_ROOM`: `[{"op":"add","path":"/props/-","value":{"id":"crate","asset":"p_table","room":"living","at":[0,-7],"size":{"w":0.5,"d":0.5,"h":0.5},"yaw":0}}]`
  - `PROP_NO_FACING`: `[{"op":"remove","path":"/props/2/face"}]` → `fix` `{"face": "room"}`
  - `PROP_ON_TOO_SMALL`: `[{"op":"add","path":"/props/-","value":{"id":"tray","asset":"p_vase","room":"living","size":{"w":1.3,"d":0.3,"h":0.05},"mount":{"top_of":"table"},"yaw":0,"solid":false}}]`
  - `PROP_CEILING_LOW`: `[{"op":"add","path":"/props/-","value":{"id":"chand","asset":"p_lamp","room":"hall","at":[0,8],"size":{"w":0.5,"d":0.5,"h":1.2},"mount":"ceiling","solid":false}}]`
  - `PROP_ABOVE_CEILING`: `[{"op":"add","path":"/props/-","value":{"id":"wardrobe","asset":"p_table","room":"hall","at":[1.5,8],"size":{"w":1.0,"d":0.5,"h":3.2},"yaw":270}}]` → msg содержит `3.2` и `3`
  - `PROP_WALL_NOT_FOUND`: `[{"op":"add","path":"/props/-","value":{"id":"shelf","asset":"p_table","room":"living","at":[0,-1],"size":{"w":1.0,"d":0.3,"h":0.5},"mount":"wall"}}]`
- [ ] `test_prop_warnings`: `warn/PROP_SIZE_ODD`: `[{"op":"add","path":"/props/-","value":{"id":"stool","asset":"p_chair","cat":"chair","room":"living","at":[2.5,-2],"size":{"w":0.5,"d":0.5,"h":2.0},"yaw":0}}]`; тот же стул h 1.55 → нет, h 1.65 → есть; `warn/FACE_ROOM_FAR`: `[{"op":"replace","path":"/props/2/at","value":[-2,1.5]}]` → 0 ошибок, ровно своё предупреждение
- [ ] `test_around_copy_path`: `[{"op":"replace","path":"/props/1/around","value":{"center":"table","n":1,"r":3.8,"start":270}}]` → одна копия в (−3.8, 0): `PROP_HITS_WALL` с `path` "/props/1", `copy` 0 (поле есть), без `fix`
- [ ] реализовать

**Вне этой фазы:** фактический размер после сборки.

## Наклейки, камеры, top.svg

Спека: линтер (наклейка, камера), «Модель стены» (плоские вещи на внутренней грани + 0.02, дуга), «Отчёт» (`passport.decals`), абзац про `top.svg` и имена файлов, «Сообщения».
Файлы: `src/decals/place.ts`, `src/cameras/check.ts`, `src/report/topsvg.ts`, `test/decals.test.ts`, `test/topsvg.test.ts`, `test/scenes/broken/{DECAL_OFF_WALL,DECAL_ON_OPENING,DECAL_OVERLAP,CAMERA_OUTSIDE}.patch.json`, `test/scenes/warn/DECAL_HIDDEN.patch.json`.

Интерфейсы:
- `placeDecals(ctx): DecalGeo[]`; `DecalGeo = {i, edge: string, m: number, mRange: [number, number], center: [number, number, number], normal: V2, w, h}`.
- `topSvg(ctx): string` — масштаб 40 px/м, X вправо, Z вниз, `viewBox` = AABB полов ± 0.5 м; слои: полы комнат, тело стены, коридоры и секторы, OBB предметов, наклейки отрезками, камеры; у каждого элемента `data-id` (id комнаты, проёма, предмета, `decal.<i>`, камеры); подписи `<text>`: id комнат, `room#i` на середине каждого авторского ребра, id проёмов и предметов. Без случайности и времени: одинаковый вход → байт в байт одинаковый вывод.
- CLI пишет `<dir(report)>/<name>.top.svg`, `<name>` = имя сцены без `.scene.json`.

Решения:
- `mRange` наклейки = `m ± w/2` (прямое), `m ± R·asin(w/2 / R_f)` (дуга, `R_f` — радиус внутренней грани). `DECAL_OFF_WALL`: `y ± h/2` вне `[0, room.height]` (`fix` `{y}` в пределах) или `mRange` вне интервала; `at` не нашёл стену своей комнаты в `SNAP_EPS`. `DECAL_ON_OPENING`: пересечение `mRange` и y с проёмом на том же интервале. `DECAL_OVERLAP`: две наклейки на одной стороне интервала пересекаются (запись у более поздней). `DECAL_HIDDEN` (warn): ближайшая точка твёрдого OBB < 0.15 м от внутренней грани, перекрывает наклейку по `m` и по y.
- `CAMERA_OUTSIDE`: `pos` не внутри `outline` ни одной комнаты, или `y` вне `[level.y, level.y + height]`, или внутри тела стены, балки (след × её y) или твёрдого OBB по плану **и** по y.

- [ ] `test_demo_flat_decal`: наклейка 0 → `edge` "living#2", `center` [3.92, 1.7, −1.6], `normal` [−1, 0]
- [ ] `test_broken_decal_camera_codes` — ровно свой код:
  - `DECAL_OFF_WALL`: `[{"op":"replace","path":"/decals/0/y","value":3.3}]` → `fix` `{"y": 3.05}`
  - `DECAL_ON_OPENING`: `[{"op":"add","path":"/decals/-","value":{"asset":"d_portrait","room":"living","on":{"room":"living","edge":1,"t":0.5},"y":1.5,"size":{"w":0.6,"h":0.6}}}]`
  - `DECAL_OVERLAP`: `[{"op":"add","path":"/decals/-","value":{"asset":"d_portrait","room":"living","on":{"room":"living","edge":2,"t":0.32},"y":1.7,"size":{"w":0.6,"h":0.7}}}]`
  - `CAMERA_OUTSIDE`: `[{"op":"replace","path":"/cameras/0/pos","value":[0,0.5,0]}]` (в столе)
  - камера `pos` [0, 1.6, 20] → тоже `CAMERA_OUTSIDE`; [0, 3.2, 0] (в балке) → тоже; [0, 1.6, 0] над столом → нет
- [ ] `test_decal_hidden`: `warn/DECAL_HIDDEN`: `[{"op":"add","path":"/props/-","value":{"id":"cab","asset":"p_table","room":"living","at":[3.7,-1.6],"size":{"w":1.0,"d":0.4,"h":2.0},"yaw":270}}]` → 0 ошибок, ровно `DECAL_HIDDEN`
- [ ] `test_top_svg`: SVG demo-flat — тексты `living`, `hall`, `living#1`, `front`, `sea`, `chairs.0`; по одному `polygon[data-id]` на каждый предмет (в demo-flat — 8); у `polygon[data-id="sofa"]` точки = углы OBB × 40 в координатах `viewBox` (±0.5 px); два прогона дают одинаковую строку
- [ ] `test_cli_writes_svg`: CLI с `--report <tmp>/x.json` пишет `<tmp>/demo-flat.top.svg`
- [ ] реализовать

**Вне этой фазы:** `top.png`, лист с ref-кадрами, маршруты.

## Навигация и итог demo-flat

Спека: «Навигация» целиком (формат `nav.json`, препятствия, эрозия, сетка, порядок битов), коды `NAV_SPAWN_BLOCKED`, `NAV_ROOM_CUT`, фаза 1 в «Фазы v0», «Сообщения».
Файлы: `src/nav/{grid,floor}.ts`, `test/nav.test.ts`, `test/demo.test.ts`, `test/msg.test.ts`, `test/golden/demo-flat.check.json`, `test/scenes/broken/NAV_SPAWN_BLOCKED.patch.json`, `test/scenes/warn/NAV_ROOM_CUT.patch.json`.

Интерфейсы:
- `buildNav(ctx): NavJson` — ровно формат спеки, только уровень `spawn`, `ramps` и `links` пустые; CLI пишет `<dir(report)>/<name>.nav.json`.
- `isWalkable(nav: NavJson, x: number, z: number, level = "L0"): boolean` — клетка `floor((x − x0)/0.04 + 1e-9)`.
- `floorAt(ctx: Ctx, x: number, z: number, yPrev: number): number | null` — в фазе 1 пол = `level.y` внутри `outline` любой комнаты уровня.

Решения:
- Препятствия = тело стены после вырезов, но вырез считается только у открытых проёмов с `sill ≤ step_max` и `sill + height ≥ 1.8` (остальные заделаны обратно) ∪ OBB твёрдых предметов, чей y пересекает `[step_max, 1.8]` ∪ следы балок с низом < 1.8 ∪ закрытые двери. Объединить clipper, раздуть на r = 0.25 (`JoinType.Round`, `EndType.Polygon`); клетка проходима, если её центр внутри `outline` комнаты и не в раздутых препятствиях.
- `NAV_SPAWN_BLOCKED`: клетка `spawn.at` непроходима; тогда заливка не строится и `NAV_ROOM_CUT` не выдаётся. `NAV_ROOM_CUT` (warn): заливка (4-связная) от `spawn` не доходит ни до одной клетки комнаты.

- [ ] `test_nav_probes`: demo-flat — `spawn` (−1, 10) проходима, центр двери (0, 4) проходим, (0, 4.3) проходима, (0, 0) под столом нет, ось стены (−4, 0) нет; дверной проход по x — (−0.15, 4) да, (−0.3, 4) нет (проход 0.9 − 2·0.25 = 0.4); сетка `origin` [−4.04, −5.64], `w` 202, `h` 442
- [ ] `test_nav_format`: `cell` 0.04, `|origin/0.04 − round(origin/0.04)| < 1e-9`, длина `bits` после base64 = ceil(w·h/8) байт; бит клетки (i, j) = номер `j·w + i`, LSB-first (проверка: `isWalkable` через биты = прямой расчёт для 100 случайных клеток с фиксированным seed)
- [ ] `test_floor_at`: `floorAt(ctx, 0, 0.5, 0)` = 0, `floorAt(ctx, 10, 10, 0)` = null
- [ ] `test_nav_codes`: `broken/NAV_SPAWN_BLOCKED`: `[{"op":"replace","path":"/spawn","value":{"room":"living","at":[-3.45,1.5]}}]` (в диване) → ровно этот код, без `NAV_ROOM_CUT`; спавн на ковре `[{"op":"add","path":"/props/-","value":{"id":"rug","asset":"p_table","room":"hall","at":[-1,10],"size":{"w":2.0,"d":1.4,"h":0.01},"yaw":0,"solid":false}}]` → 0/0; `warn/NAV_ROOM_CUT`: `[{"op":"replace","path":"/openings/0/width","value":0.45}]` → 0 ошибок, ровно `NAV_ROOM_CUT`
- [ ] `test_demo_flat_full`: `runCheck(demo-flat)` → `ok: true`, 0 errors, 0 warnings, все этапы `pass` кроме `stairs` = `skipped`; отчёт совпадает с `test/golden/demo-flat.check.json`
- [ ] `test_broken_one_code_each`: множество имён в `test/scenes/broken/` = множеству кодов уровня `error` фазы 1 (все из `CODES`, кроме `STAIR_*`, `ROUTE_BLOCKED`); у каждого файла ровно 1 error — свой код, 0 warnings. То же для `test/scenes/warn/` и кодов уровня `warn`: 0 errors, ровно 1 warning
- [ ] `test_msg_numbers`: для каждого файла `broken/` и `warn/` `msg` не пуст, не содержит `{`, `undefined`, `NaN`; содержит id объекта, адрес `room#i`, `decal.<i>` или `path` (кроме `SCHEMA_PARSE`); если в шаблоне спеки есть числовой плейсхолдер (`{d}`, `{S}`, `{v}`, `{h}`, `{y0}`, `{L}`, `{x}`, `{m0}`), msg содержит цифру
- [ ] реализовать

**Вне этой фазы:** второй уровень, рампы, `floorAt` на лестнице, маршруты капсулы.
