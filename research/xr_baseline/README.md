# эталон X1 (десктоп до buildWorld)

Снят хозяином на базовом коммите ветки `458aa9a`, до правок `main.ts`, в отдельном worktree.

Мир: спальня Кошакана, `runs/20261101-225137/world/run/scene.json`, ассеты из `cache` того же прогона.

    node --import tsx bin/dreamer.ts build <scene> --out dist --assets cache --cache <run>/cache   # 0
    node --import tsx bin/dreamer.ts check <scene> --report check.json --built dist                # 1
    node --import tsx bin/dreamer.ts shots dist                                                     # 0

- `check.json`: отчёт проверки. Код 1 на базе: сцена уже не проходит этап `props` (кровать в стене 0.23 м, полка 0.018 м, растение и домик не помещаются на полку). Это свойство сцены, а не регрессия; после X1 отчёт должен совпасть.
- `shots.sha256`: хэши кадров `bedroom_ref1.png`, `bedroom_ref2.png`. Сами кадры не коммитятся.

После X1 повторить те же три команды на ветке полосы и сравнить: хэши кадров (или попиксельно с допуском тестов `shots`) и `check.json`.
