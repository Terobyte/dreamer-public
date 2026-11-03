# Карта кода, полоса A (камера): строки для переноса в `feature_map.md`

Общий `feature_map.md` полоса не трогает (конфликт слияния). Хозяин переносит строки коммитом слияния.

## §2 модули

| Файл | Что делает | Публичное | Тесты |
|---|---|---|---|
| `stage/moves.ts` | приёмы камеры: атом (`MOVES`) → законные `from`/`end` по голове, лицу, стенам, стороне 180°; схемы (`SCHEMES`) по списку битов; записи (`RECORDS`) без исполнения | `MOVES`, `SCHEMES`, `RECORDS`, `resolveMove`, `planScheme`, `ndcOf`, `isMoved` | `stage-moves.test.ts` |
| `stage/styles.ts` | стили режиссёра (К2): веса приёмов, ритм, высота, fov, тряска — строка данных для `pickMove` | `STYLES`, `pickMove` | `stage-styles.test.ts` (К2) |
| `bin/moves.ts` | CLI `--catalog`: каталог приёмов, схем, записей, стилей и весов для Spark (чтение из таблиц рантайма, без копий) | `node --import tsx bin/moves.ts --catalog` | `stage-moves-catalog.test.ts` |
| `stage/index.ts` (К3м) | чтение `moves.json` и стиль | `parseMoves`, `pickStyle`, `StageCtx.moves` | `stage-director-forced.test.ts`, `stage-k2-fixes.test.ts` |

## §3 нужно X — используй Y

| Нужно | Используй |
|---|---|
| где точка мировых координат в кадре (x, y в ±1, глубина) без THREE | `stage/moves.ts ndcOf` |
| превратить имя приёма в точки `from`/`end` (законные, с лицом) | `stage/moves.ts resolveMove` |
| разложить схему (`over_the_shoulder`, `oner`…) на биты | `stage/moves.ts planScheme` |
| есть ли «движение» между двумя точками плана (≥0,1 м, ≥2° fov, ≥5° взгляда) | `stage/moves.ts isMoved` |

## Исправление общей карты

Строка 442 в §5 (`feature_map.md`), заменить целиком на:

| `legalCameraPoint` | `stage/camera.ts:130` — единая функция: зажимает точку камеры в контур, сторону 180° и высоту; при отсутствии законной точки возвращает `law.fallback` без проверки (`camera.ts:139–159`) |

## К2 (частично: styles.ts)

| §2 модуль | что делает |
|---|---|
| `engine/src/runtime/stage/styles.ts` | `STYLES` (8 стилей данными), `validateStyles`, `pickMove(style, tags, rng, opts)` — единственный выбор приёма; `isMoving`, `staticOf` |

| §3 нужно X | используй Y |
|---|---|
| выбрать приём по стилю и тегам | `styles.ts:pickMove` |
| направление лица актёра (`faceYaw ?? yaw`, `lying` — нет) | `stage/director.ts:faceDir` |

## К3м v2: выбор Spark в рантайме

| нужно | используй |
|---|---|
| каталог приёмов и весов для Spark | `engine/bin/moves.ts --catalog` (из `MOVES`/`SCHEMES`/`RECORDS`/`STYLES`) |
| разобрать `shotplan/moves.json` | `parseMoves(raw)` в `stage/index.ts` (`{style, beats, warnings}`) |
| стиль режиссёра | `pickStyle(moves.style, cameraStyle)`: moves → `?camera_style=` → `storybook` |
| принудить приём на бит | `DEvent.forced {move, subject}` (схема → атом, запись → `MOVE_RECORD_ONLY`, нет законной точки → `FORCED_FALLBACK B<i> <id>`) |
| не резать план на смене бита | `DEvent.hold`; смена комнаты режет всегда, `HOLD_IGNORED B<i>` |
