# Dreamer dream Б2: сервер и LLM

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
- **Параллельные прогоны.** Зоны записи — только зоны фазы ниже. Чужие файлы не трогать: Б1 чинит `h0/dream/sim.py`, `director.py`, `fsm.py`, `voice.py`, `h0/squid_live/duo.html`; Б3/Б4 — `engine/**`. В `tools/gate_skip.txt` удалять только строки своих файлов; в `bugs.md` менять только записи своих багов.

---

## Б2. dream: сервер и LLM (B30 B52 B53)

Файлы тестов: `h0/dream/test_bugs_server.py`, `test_bugs_llm_bench.py`. Зоны: `h0/dream/server.py`, `llm.py`, `bench_f1.py`, `bank.py`, `bugs.md`, `tools/gate_skip.txt`.

- [ ] B30: отвергнутый POST дочитывает или закрывает соединение — тело не становится следующим запросом
- [ ] B52: после капа Spark Open не уходит в платный Spark 1.3 мимо капа
- [ ] B53: один `TimeoutExpired` не теряет пачку; мёртвый прогон не считается по потолку
- [ ] два файла зелёные и убраны из `tools/gate_skip.txt`
