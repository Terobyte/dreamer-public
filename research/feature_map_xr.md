
## §2 модули

| Модуль | Что делает |
|---|---|
| `engine/src/runtime/world.ts` | `buildWorld(data, opts)` → `EngineWorld`: root, walker, doors, objects, spawn, shell, loads; без рендерера/камеры/DOM. Экспорт `materialOf`, `meshOf`, `withBase`, `TONE`, `EXPOSURE` |
| `app/src/engine-host.ts` | `hostEngineWorld(world, base)` + `pickWorld()` → `buildWorld` в IWSDK World: rootEntity, shell `LocomotionEnvironment` с parent, `setPlayerPosition` + yaw, nav guard без аллокаций, отчёт `window.__dreamerXr` |
| `app/tools/xr-check.mjs` | `iwsdk browser run` на `frame`: ставит `dreamer.world`, ждёт `__dreamerXr`, проверяет `oneThree`, GLB, спавн ±5 см, коды 1-4 |
| `app/tools/xr-check-runner.mjs` | `npm run xr:check` оркестратор: `dev up` → `xr enter` → `browser run` → `xr status` (`sessionActive`) → `xr exit` всегда (finally) |
| `app/vite.config.ts` + `app/tsconfig.json` | alias `three` → `app/node_modules/three` (F2) — одна three в бандле, `instanceof` не ломается |

## §3 нужно X — используй Y

| Нужно | Используй |
|---|---|
| собрать мир `dist` без рендерера (хост IWSDK или десктоп) | `buildWorld` в `runtime/world.ts` |
| материал/меш из `geometry.json` | `materialOf` / `meshOf` из `runtime/world.ts` (не копировать) |
| небо, земля, солнце улицы | `addOutdoor(def, groundMaterial)` в `outdoor.ts` → `{ objects, background }`, в сцену не пишет |
| выбрать мир `?world=` → `localStorage` → `VITE_DREAMER_WORLD` | `pickWorld()` в `app/src/engine-host.ts` |
| проверить мир в IWSDK без железа | `app/tools/xr-check.mjs` под `iwsdk browser run` + `app/tools/xr-check-runner.mjs` (`npm run xr:check`) — `oneThree`, GLB, спавн, `sessionActive` |

| Модуль | Что делает |
|---|---|
| `engine/src/nav/fence.ts` | `buildFence(nav, insetM)` → `Float32Array` треугольников (9 float): забор по границе проходимо/непроходимо каждого слоя `nav.json` со сдвигом на `insetM`; двери проходимы, рампы — только центральная полоса (`rampWalkable`) |

| Нужно | Используй |
|---|---|
| отдать нав локомотору IWSDK как геометрию (без отката стражем) | `buildFence(nav, 0.5)` из `nav/fence.ts` → невидимый меш с `LocomotionEnvironment` (`engine-host.ts`) |
