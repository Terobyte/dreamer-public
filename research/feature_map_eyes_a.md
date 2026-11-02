# feature_map, полоса A «Глаза» (переносит хозяин коммитом слияния)

## §2 модули

| модуль | что делает |
|---|---|
| `engine/src/build/surfaces.ts` | `surfacesOf(glb)` — горизонтальные поверхности модели (растр сверху, сетка 5 см, ярусы, `open`); `worldSurfaces(local, mesh)` — перенос в мир (scale, scaleY, glbYaw, glbPos); `groupHeights` — слои одной ячейки |
| `engine/src/assets/glb.ts` `sceneTriangles` | обход треугольников активной сцены GLB в системе модели (полные матрицы узлов); `sparse`/нестандартные аксессоры → `Error("glb: unsupported accessor")` |

## §3 нужно X — используй Y

| нужно | используй |
|---|---|
| поверхности предмета (верх матраса, доски полки) | `build.json.surfaces[<id меша>]` (пишет `writeDist`), в коде — `surfacesOf` + `worldSurfaces` |
| треугольники GLB в системе модели | `sceneTriangles(json, bin)` из `assets/glb.ts` |
| пустая поверхность у предмета | предупреждение `SURFACES_EMPTY <id>` в `build.json.warnings` |

Г3 (добавлено в §2/§3 этой полосы):

| модуль | что делает |
|---|---|
| `engine/src/build/surfaces.ts` `remount` | ставит `top_of`/`tier_of` проп на реальную поверхность опоры (матрас, ярус полки), двигает `glbPos`/`positions`, пишет `REMOUNT`/`TIER_MISSING` |
| `h0/make/stage.py` `build_places` | `top`, `lie.at`, `tiers` из `build.json.surfaces` (от уровня), `PLACE_NO_SURFACES` |

| нужно | используй |
|---|---|
| проп на ярус полки | `mount: {tier_of: id, tier: n}` (0 — нижний) |
