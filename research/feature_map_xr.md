
## §2 модули

| Модуль | Что делает |
|---|---|
| `engine/src/runtime/world.ts` | `buildWorld(data, opts)` → `EngineWorld`: root, walker, doors, objects, spawn, shell, loads; без рендерера/камеры/DOM. Экспорт `materialOf`, `meshOf`, `withBase`, `TONE`, `EXPOSURE` |

## §3 нужно X — используй Y

| Нужно | Используй |
|---|---|
| собрать мир `dist` без рендерера (хост IWSDK или десктоп) | `buildWorld` в `runtime/world.ts` |
| материал/меш из `geometry.json` | `materialOf` / `meshOf` из `runtime/world.ts` (не копировать) |
| небо, земля, солнце улицы | `addOutdoor(def, groundMaterial)` в `outdoor.ts` → `{ objects, background }`, в сцену не пишет |
