# Карта кода, полоса A (камера): строки для переноса в `feature_map.md`

Общий `feature_map.md` полоса не трогает (конфликт слияния). Хозяин переносит строки коммитом слияния.

## §2 модули

| Файл | Что делает | Публичное | Тесты |
|---|---|---|---|
| `stage/moves.ts` | приёмы камеры: атом (`MOVES`) → законные `from`/`end` по голове, лицу, стенам, стороне 180°; схемы (`SCHEMES`) по списку битов; записи (`RECORDS`) без исполнения | `MOVES`, `SCHEMES`, `RECORDS`, `resolveMove`, `planScheme`, `ndcOf`, `isMoved` | `stage-moves.test.ts` |
| `stage/styles.ts` | стили режиссёра (К2): веса приёмов, ритм, высота, fov, тряска — строка данных для `pickMove` | `STYLES`, `pickMove` | `stage-styles.test.ts` (К2) |

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
