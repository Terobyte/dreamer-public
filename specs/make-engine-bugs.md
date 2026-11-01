# Dreamer make Б3+Б4: engine

Вынесено из `specs/make-one-prompt.md` (хозяин 2026-10-31): блок Б идёт тремя параллельными прогонами tero — Б1 (`../meta-dream-b1`, ветка `tero/dream-b1`), Б2 (`../meta-dream-b2`, ветка `tero/dream-b2`) и Б3+Б4 в основном дереве `meta` (ветка `tero/make-engine-bugs`). Каждый прогон в своём worktree и своей ветке; хозяин сливает их после SHIP. Спека-основание та же: `specs/2026-10-31-dreamer-make.md` v0.6; описание багов — `bugs.md`, раздел «Охота 2026-10-31».

**Игроки и раунды:** Sonnet ×1 → Muse contributor ×5 → Opus ×1 (`--player-schedule claude:claude-sonnet-5-5×1,muse:muse-spark-1.3-contributor×5,claude:claude-opus-5-5×1`), 7 раундов. Судья codex gpt-6-luna, тестера нет, эскалация claude:sonnet.

**Фьюз:** нет SHIP за 7 раундов — хозяин доделывает фазу в дереве или записывает долг в `specs/make-debt.md`.

**Общие правила.**
- Сегодня (10-31) ни одного живого вызова: Spark, Muse Image, Modal, MuAPI, Fish, Commons/Fandom/Openverse/Tavily — даже бесплатного. В тестах сеть запрещена (`urllib.request.urlopen` → `AssertionError`, как в `h0/dream/test_freestyle.py`). Ключи не читать и не печатать.
- Сначала красный тест, потом код. Без новых зависимостей (stdlib в Python; в `engine/` — только то, что уже в `package.json`).
- Не читать `~/.dreamer-bench/**`, `h0/out/**`, `cache/`, чужие `dist/` (кроме фикстуры `h0/make/testdata/**/dist/`).
- **Номера строк в спеке устарели** для `h0/dream/sim.py`: хозяин 10-31 дописал «книга → фристайл» (`go_freestyle`, `_book_story`, `_free_pieces*`, `_free_events`, `_free_scene_dict`, `_free_exit`, аргумент `run(..., freestyle=False)`, события SSE `mode`/`story`/`schedule`). Искать функции по имени (`run`, `_load_book_plan`, `_seed_first_scene`, `main`, `go_freestyle`), не по номеру. Это поведение не ломать: `test_freestyle.py` и все `test_bugs_*` зелёные.
- `h0/squid_live/duo.py`, `duo.html`, `server.py` не менять; `duo.html` — образец для режима сцены (камера, субтитры, кнопка «Фристайл» и бегущая строка `story`).
- Гейт фазы — `sh tools/gate.sh` (его гоняет tero): `h0/dream` unittest, `h0/make` unittest (discover), `engine` `npx vitest run`, кроме файлов из `tools/gate_skip.txt` (открытые репро багов). Всё зелёное. `tools/gate.sh` не менять; `tools/gate_skip.txt` меняет только блок Б.

**Блок Б — баги охоты 2026-10-31 (Б1–Б4 тремя параллельными прогонами).** Описание каждого бага — `bugs.md`, раздел «Охота 2026-10-31». Красные репро-тесты уже в репо и **не входят в гейт**, пока их файл стоит в `tools/gate_skip.txt`. Правила блока:
- репро-тест — это контракт: его утверждения не ослаблять; если тест доказуемо неверен, поправить его и записать почему в `bugs.md` у этого бага;
- когда все тесты файла зелёные, удалить его строку из `tools/gate_skip.txt` (так тест попадает в гейт и дальше охраняет починку);
- у починенного бага в `bugs.md` статус `fixed` и одна строка «как»;
- `h0/squid_live/duo.html` можно трогать только для B60 (мизансцена из полей бита вместо регэкспа по прозе), остальное в `duo.*` не менять.
- **Параллельные прогоны.** Зоны записи — только зоны фазы ниже. Чужие файлы не трогать: Б1/Б2 чинят `h0/dream/**` и `h0/squid_live/duo.html` в своих worktree. В `tools/gate_skip.txt` удалять только строки своих файлов; в `bugs.md` менять только записи своих багов.

---

## Б3. engine: проёмы, открытые комнаты, ходьба (B11–B16 B38)

Файлы тестов: `engine/test/bugs-openings.test.ts`, `bugs-openroom.test.ts`, `bugs-walk.test.ts`. Зоны: `engine/src/openings/**`, `engine/src/stairs/**`, `engine/src/decals/**`, `engine/src/runtime/walk.ts`, `bugs.md`, `tools/gate_skip.txt`.

- [x] P2 (B11 B12 B13): псевдокомната `"walls"` сортируется последней, как в `merge.roomOrder`; `at`-проём на свободной стене не пропадает, индексы `geos`/`openings` не расходятся, `sRange` не падает
- [x] P1 (B14 B15): открытость комнаты читается из `open`, а не из `height == 0`
- [x] B16: стрейф D вправо; B38: клавиши сбрасываются на `blur`
- [x] три файла зелёные и убраны из `tools/gate_skip.txt`; golden-тесты движка зелёные

## Б4. engine: бюджет, check --built, камеры (B19 B20 B21 B22 B35 B37)

Файлы тестов: `engine/test/bugs-budget.test.ts`, `bugs-built.test.ts`, `bugs-camera.test.ts`. Зоны: `engine/src/build/**`, `engine/src/assets/**`, `engine/src/cameras/**`, `engine/src/budget*`, `engine/bin/dreamer.ts`, `bugs.md`, `tools/gate_skip.txt`.

- [x] B20: нечитаемый или отсутствующий GLB — ошибка бюджета, не 0 треугольников
- [ ] B21: лимит point-light на сцену и на комнату, уровень error
- [ ] B19: `check --built` берёт камеры из сцены и не принимает устаревшие снимки; B37: имена снимков уникальны без учёта регистра
- [ ] B22: камера над низкой стеной не считается внутри стены (учёт высоты); B35: второй `writeDist` с тем же ctx сохраняет `cam.ref`
- [ ] три файла зелёные и убраны из `tools/gate_skip.txt`; `tools/gate_skip.txt` пуст (кроме комментария)
