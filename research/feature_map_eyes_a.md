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
