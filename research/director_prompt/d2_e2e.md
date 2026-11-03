# D2: сквозная проверка панели оператора (отчёт)

Кадр 1280×720 в репо не кладём (контракт D2): здесь только отчёт.

## Что проверено тестами (фейки, без сети)

- `h0/dream/test_ideas_queue.py`: очередь `pending → consulting → held/firing → done/failed/dropped`; `retry_at` 10 с; не больше 5 `hold`, потом `expired`; `now:true`; гонки удаления (`consulting` → `fire` и `done` → `drop`); одна `fire` за консалт; `not_delivered` за 3 с; `unclear` → `op:"reject"`; безопасность → `dropped, safety`; журнал с разным `source` у двух виджетов; чистка `draft` (ревизия, срок 8 с → `clean_failed`); роль `idea` = contributor/minimal; тик книжного режима тоже ведёт очередь (`make.play` играет тестовый мир как книгу).
- `h0/dream/test_ideas_server.py`: ветки `POST /event kind draft|idea|idea_drop|effect_ack` отвечают сразу и не идут в общий путь `post_event`; `GET /ideas`.
- `engine/test/operator-panel.test.ts`: мост отдаёт `idea`/`director_ack` в обработчики; модель панели (снимок `GET /ideas`, затем события); отправка = `draft` → `idea` с `source` виджета; `clean_failed` оставляет текст; ответ чистки со старой ревизией отбрасывается.

## Живая страница `make.play` (на этой машине не прогнана)

На машине нет собранного прогона `runs/<id>/` со `stage/stage.json` и `world/run/dist`
(тестовый мир Кошакана здесь не собран), поэтому страницу запустить не на чем.
Порядок проверки, когда прогон есть:

```sh
cd h0 && python3 -m make.play ../runs/<koshakan-run> --fake
# открыть выведенный URL + &operator=1, окно 1280×720
```

1. Ввести «поговорите о сестре» в нижнюю строку, Enter: строка появляется в очереди справа (`pending` → `done`), в ленте `director_ack`.
2. Ввести вторую команду и удалить её кнопкой «×» до исполнения: статус `dropped`.
3. Tab: поле игрока, та же команда уходит с `source: headset` (журнал `log.jsonl`, `type:"idea", op:"add"`).
4. Снимок окна: зеркало (мир), строка промпта, очередь с кнопкой удаления, лента ответов.

Статус: **не прогнано**, кадра нет.
