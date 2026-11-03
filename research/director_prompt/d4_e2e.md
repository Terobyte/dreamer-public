# D4: «стройка» следующей сцены в режиме кэша и сквозной срез (отчёт)

Тестовый мир — спальня/ванная Кошакана: реестр `Sim.SCENE_WORLDS["koshakan"]`, запись
`koshakan_shop` = дверь `door` → `bathroom` (ванная играет «магазин»), алиасы «внутри магазина»,
«в магазин», три фразы `stall_bank`. Запись двора `kozb7_yard_shop` лежит в
`Sim.SCENE_WORLDS["kozb7_yard"]` и ждёт D0; приёмка от неё не зависит.

## Что проверено тестами (фейковая LLM, фейковые часы, сеть запрещена)

  - `h0/dream/test_d4_idle_after_shop.py` — `IdleAfterShopTest`: кэш-стройка с
    `next_scene: None` (комната уже в `dist`) после `walk_through` возвращает FSM в `idle`
    (а не застревает в `transition`), `Sim.place == destination`; отвлечение при занятом
    `_steer[None]` комбинируется с прежней темой; движок шлёт `effect_ack` только за
    реально повешенную табличку (неизвестная дверь — без подтверждения).
- `h0/dream/test_scene_build.py`
  - `FSMCacheModeTest`: `live` при `no_build` по-прежнему `invalid`, события `live` без изменений;
    `cache` → `build` + `door {state:"locked"}` в `start_build`, `ready` + `door open` ровно на `build` с;
    `walk_through` только из `ready` (`via: "npc_walk"`).
  - `SceneBuildSimTest`: идея `scene` → дверь `locked` + `placard {door, text, id}`; `effect_ack` → `done`;
    до `ready` дверь не открывается; после `door open` — `placard {clear}`, `goto` героя на
    `bathroom`, `transition via npc_walk`, `Sim.place == "bathroom"` за 30 с;
    отвлечение `stall_seconds()` = остаток по `build_pct` (45 → 30 через 15 с; 90 при `cache_build_s=90`);
    навсегда зависший директор: промежуток тишины ≤ 15 с, звучит `stall_bank`, консалт брошен
    (`consult_abandoned`) через 20 с (настенные таймеры 15/20 с не масштабируются
    скоростью симуляции); `abort` → табличка снята, дверь `locked`,
    `director_ack` «не вышло, повтори идею», герой говорит за 20 с, идея `done`, повтор того же `id` —
    no-op, новый `id` запускает стройку заново.
  - `SliceEndToEndTest.test_sister_then_shop`: «поговорите о сестре» → тема в `notes` адресата;
    «внутри магазина, начни строить сейчас» → `door locked` раньше `door open`, между ними есть реплики,
    тишина ≤ 15 с, герой в `bathroom`, идея `done`. Ручных шагов нет (кроме `effect_ack`,
    который на странице шлёт обработчик таблички).
  - `PlumbingTest`: `make.play --director-prompt --cache-build-s N --scene-world` →
    `play(build_mode="cache", fsm_params={"build": N})` → `sim.run` → `Sim` → `BuildFSM`.
- `engine/test/placard.test.ts`: поза таблички из `DoorDef` (середина проёма, высота), установка/снятие.
- `engine/test/bridge-d4.test.ts`: не-книжный `transition` молча (`io.info`, без `warn`);
  `placard` и `{clear:true}` доходят до обработчика.

## Живая страница `make.play` (на этой машине не прогнана)

Собранного прогона тестового мира Кошакана (`runs/<id>/stage/stage.json` + `world/run/dist`)
в этом worktree нет, поэтому страницу запустить не на чем. Порядок, когда прогон есть:

```sh
cd h0 && python3 -m make.play ../runs/<koshakan-run> --fake --director-prompt --cache-build-s 45
# открыть выведенный URL + &operator=1, окно 1280×720
```

1. «поговорите о сестре», Enter: в очереди `done`, адресат в течение 6 реплик говорит о сестре.
2. «внутри магазина, начни строить сейчас», Enter: дверь заперта, на ней табличка «загрузка»,
   герой и NPC разговаривают; через 45 с табличка снята, дверь открыта, герой идёт в ванную.

Статус: **живая страница не прогнана**, кадров нет; сквозной путь проверен тестом
`SliceEndToEndTest` на уровне sim и тестами моста/таблички на уровне движка.
