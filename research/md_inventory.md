# Инвентаризация markdown-файлов meta (Dreamer)

Дата: 2026-11-01. Режим: только чтение. Единственный созданный файл: этот отчёт.

## 0. Что проверено и оговорки

- Найдено **179** `.md` по команде из задания. Разбивка: `app/` 81 (IWSDK, встроенные инструкции и дубли), `h0/dream/books/` 23 (исходный текст книг), `specs/critique/` 17, кэши pytest 5, `.tero/` 1, остальные **52** разобраны по одному файлу (раздел 1).
- Группы из `app/`, книг, критиков и кэшей описаны строками групп (раздел 2), а не по одному файлу.
- Не читались: `~/.dreamer-bench/**`, `h0/out/**`, `dist/`, `node_modules`, `.git`.
- Оговорка: при сборке списка один раз открыт `.pytest_cache/README.md` (первые 8 строк). Это кэш, по правилам его не читают. Содержимое не использовано.
- `anymove/runs/squidward/ENGINE_NOTES.md` прочитан (шапка и diff с копией в meta). Индекс памяти `MEMORY.md` прочитан; соответствие «память → md» в разделе 3.
- Даты: `git log -1 --date=short` по трекаемым файлам. Для не трекаемых (`research/video`, `.tero`) дата — mtime.
- Статусы багов в `bugs.md` определены по тексту строки «Статус: fixed» скриптом, без проверки кода. Подсчёт грубый: часть пунктов, где fixed стоит на следующей строке, может быть ошибочно помечена как открытая. Перед опорой на список открытых B-n проверить вручную.
- «DONE» означает, что работа по файлу принята (чекбоксы `[x]`, итог в PROGRESS или DEVLOG). Качество результата не оценивалось.

Легенда статусов: **ACTIVE** (ещё управляет работой), **DONE** (работа закрыта), **STALE** (устарел или заменён; сказано чем), **DUPLICATE** (дубль чего), **UNKNOWN** (не определено по содержимому).

---

## 1. Файлы с планами, статусами, уроками и спеками (52 файла + 2 внешних)

| путь | что это | последнее изменение | статус | рекомендация |
|---|---|---|---|---|
| `PROGRESS.md` | Статус проекта и карта трекинга. Раздел «Следующий шаг» взят от 10-28, карта датирована 10-27 | 2026-11-01 | ACTIVE, частично STALE (C1, C2, C3, C16) | keep, SPINE. Переписать «Следующий шаг», «Открытые хвосты», «Карта» |
| `LESSONS.md` | Реестр уроков, долгов, парковок и отказов со статусами: L1–L69, P1–P2 | 2026-11-01 | ACTIVE | keep, SPINE. Единственный реестр статусов |
| `specs/2026-11-01-engine-worlds.md` | Текущая спека «ночи 2»: фазы Н1–Н15, Н7а/Н7б. Чекбоксов 0 из 38 | 2026-11-01 | ACTIVE | keep, SPINE (текущая спека) |
| `specs/make-debt.md` | Долг make (М0–М6), камера книги А3a/А3b, сквозная приёмка Кошакана | 2026-11-01 | ACTIVE | keep, SPINE (детали долга). Добавить раздел «Миры, ночь 2», который ждёт спека (C8) |
| `research/engine_notes.md` | Живая копия уроков движка EN 1–38 (из anymove), дописывается | 2026-11-01 | ACTIVE | keep (подробности уроков). Разделы «Следующие шаги» (стр. 143–149, 10-29) устарели |
| `research/llm_friction.md` | Журнал трений LLM TR1–TR38 с инструментом, который снял бы трение | 2026-10-31 | ACTIVE | keep. LESSONS ссылается на TR-номера |
| `DEVLOG.md` | История для презентации, главы 0–9, фазы, Twelve Oaks, правки диалога | 2026-10-29 | ACTIVE (только дописывать) | keep. Это история, не статус |
| `AGENTS.md` | Три правила «как строить миры» (смотри, раздели, параллельно) | 2026-10-28 | ACTIVE | keep. Правила, не план. `CLAUDE.md` импортирует его |
| `CLAUDE.md` | Одна строка: `@AGENTS.md` | 2026-10-28 | ACTIVE | keep |
| `RESEARCH.md` | Справка хакатона, таймлайн, гипотезы H0–H21 с замерами, «План по дням (v2)», 5 открытых вопросов | 2026-10-28 | STALE в части плана по дням и вопросов; остальное ACTIVE как справка | split: вопросы и дедлайны → PROGRESS; план по дням → archive; замеры H → keep |
| `bugs.md` | Баги песочницы B1–B10 и «Охота 2026-10-31» B11–B62 со статусами | 2026-11-01 | ACTIVE частично: открыты B55–B59, B61 (по тексту). Остальные помечены fixed. Заголовок стр. 151 «Статус у всех `reported`» противоречит (C7) | merge открытое в LESSONS / make-debt. Fixed → archive/bugs-fixed.md |
| `engine/docs/critic.md` | Правило для критика: давать картинки, не JSON-отчёт | 2026-10-30 | ACTIVE (док для кода) | keep |
| `engine/docs/street.md` | Как описать улицу и двор: двор = комната с `open: true` | 2026-11-01 | ACTIVE (док для архитектора) | keep |
| `specs/engine-scene.md` | Контракт SCENE.json, v0.7. Фазы 1–2 сделаны (`tero-engine-phase1/2`) | 2026-10-30 | ACTIVE (контракт) | keep. Два открытых вопроса (стр. 378–380) |
| `specs/2026-10-31-dreamer-make.md` | Спека make v0.6: контракт make и make.book, журнал критики | 2026-10-31 | ACTIVE. Внутри 10 чекбоксов `[ ]` (стр. 201–218) при закрытых М0–М6 (C11) | keep. Закрыть или перенести `[ ]` в make-debt |
| `specs/2026-10-28-dream-story-design.md` | Дизайн «живой книги» v1.0, §8 вопросы к пользователю, §13 долг Д1–Д11 | 2026-10-29 | STALE: шапка стр. 3 «черновик, код не пишем до ок» не обновлена; §8 стр. 295+ открыт в двух пунктах | merge с будущим книжным дизайном; §8 закрыть; §13 перенести в LESSONS |
| `specs/2026-11-01-engine-anim-camera.md` | Спека ночи 11-01, фазы А1–А4. Чекбоксов 12 из 12 | 2026-11-01 | DONE. Долги уже в make-debt | archive после закрытия ночи (C12) |
| `specs/tero-pipe2.md` | План конвейера pipe2 Spark→движок. 48 `[x]`, 22 `[ ]` (стр. 203–256) | 2026-10-29 | STALE/PAUSED: `h0/pipe2/CHECKPOINT.md` пишет «Paused at the owner's request» | решить: возобновить или archive. Открытые тесты → make-debt |
| `h0/pipe2/CHECKPOINT.md` | Пауза pipe2 от 10-29, база 848de61. Ночь 10-30 велит туда писать долг | 2026-10-29 | STALE (пауза). Всё ещё указан как место долга (`tero-night-2026-10-30.md:11`) | keep до решения по pipe2, потом archive |
| `h0/pipe2/checkpoint-judge-prompt.md` | Промпт «строгого ревьюера» с 6 чекбоксами (стр. 91–96) | 2026-10-29 | DUPLICATE: стр. 91–96 = `specs/tero-pipe2.md` стр. 203–208, строка в строку | archive после решения по pipe2 |
| `specs/tero-night-2026-10-30.md` | План ночи 10-30: блоки К, А, Б (движок-бюджет), В, Г, Д, Е. 71 `[x]`, 0 `[ ]` | 2026-11-01 | DONE | archive. Буква «Б» здесь значит другое (C6) |
| `specs/dialogue-fixes-2026-10-30.md` | Правки диалога, сделаны Claude без tero. 16 `[x]` | 2026-10-29 | DONE. Битая ссылка на `specs/parked-2026-10-30.md` (стр. 70) | archive. Исправить ссылку или вынести парковки в LESSONS |
| `specs/make-one-prompt.md` | План make M0–M6 (DONE) и блок Б1–Б4 (19 `[ ]`, стр. 98–135). Стр. 3 говорит «только порядок фаз и чекбоксы» | 2026-11-01 | PARTLY STALE: М-фазы DONE; Б дублирует dream-b1, dream-b2, make-engine-bugs | М-фазы → archive. Открытое из Б → bugs.md / make-debt |
| `specs/dream-b1.md` | Б1 dream: очередь реплик, консультации, голос. 0 из 6 `[x]` | 2026-10-31 | DUPLICATE (`make-one-prompt` Б1). STALE: bugs.md помечает B43–B51 как fixed | merge в bugs.md, потом archive |
| `specs/dream-b2.md` | Б2 dream: сервер и LLM. 0 из 4 `[x]` | 2026-10-31 | DUPLICATE. STALE: B30, B52, B53 fixed в bugs.md (C7) | то же |
| `specs/make-engine-bugs.md` | Б3+Б4 engine: проёмы, открытые комнаты, бюджет, камеры. 4 `[x]`, 5 `[ ]` | 2026-10-31 | DUPLICATE. STALE: B11–B22 fixed в bugs.md | то же |
| `specs/tero-engine-phase2-debt.md` | Долг фаз 1–16 движка, пункты Д1–Д18 | 2026-10-29 | ACTIVE-долг, но не записан ни в LESSONS, ни в make-debt | merge в make-debt (раздел «Движок») и LESSONS |
| `specs/tero-engine-phase1.md` | План движка, фаза 1 (`dreamer check`). 64 `[x]` | 2026-10-28 | DONE | archive |
| `specs/tero-engine-phase2.md` | План движка, фазы 2–5 (`dreamer build`). 82 `[x]` | 2026-10-29 | DONE | archive |
| `specs/tero-dream-sandbox.md` | План песочницы сна для tero. 40 `[x]` | 2026-10-28 | DONE. DUPLICATE `specs/2026-10-27-dream-sandbox-plan.md` | archive, оставить один |
| `specs/2026-10-27-dream-sandbox-plan.md` | План песочницы, шаги 1–5 | 2026-10-27 | DONE. DUPLICATE `specs/tero-dream-sandbox.md` | archive |
| `specs/2026-10-27-dream-sandbox.md` | Спека песочницы v3.6 (2D-каркас сна) | 2026-10-28 | DONE (фазы 1–3 закрыты, DEVLOG глава 9) | archive |
| `specs/2026-10-28-dream-phase1-plan.md` | План dream, фаза 1. 101 `[x]` | 2026-10-29 | DONE | archive |
| `h0/world/twelve_oaks/brief.md` | Бриф сцены Twelve Oaks (GWTW) | 2026-10-29 | STALE: сцена провалена (POSTMORTEM), книга заменена Jane Eyre. В коде не ссылается | archive |
| `h0/world/twelve_oaks/POSTMORTEM.md` | Разбор провала Twelve Oaks 3D: что разочаровало движок | 2026-10-29 | DONE (урок) | archive. Проверить, что уроки есть в LESSONS или EN |
| `research/ab/twelve-oaks-2026-10-29/README.md` | Вердикт A/B: ручная романтическая сцена победила Wonder | 2026-10-29 | DONE. Ссылка на `battle.txt` не проверена | archive |
| `research/pitch-and-artifact-2026-10-30.md` | Нарратив питча и идея «артефакт», заметки хозяина | 2026-10-29 | UNKNOWN (нужен для сабмита 4 ноября) | keep. Свести в одну submission-заметку |
| `research/anim_engine_notes.md` | Ранняя копия `research/engine_notes.md` (первые ~305 строк, без Кошакана 11-01) | 2026-11-01 | DUPLICATE (`research/engine_notes.md`), STALE | delete-candidate после подтверждения |
| `research/video/AS92HYsEBqo_notes.md` | Конспект видео про анимацию монстров (мокап не покрывает не-людей) | 2026-10-26 (mtime) | DONE (справка). Не трекается, в .gitignore | keep. Решить: track или перенести |
| `research/video/x-WSSlHNcJQ_notes.md` | Конспект про UniMate (анимация любого скелета по тексту). Не трекается | 2026-10-27 (mtime) | ACTIVE-справка (L38 «парк», UniMate) | keep. Track или перенести |
| `h0/prompts/chatgpt_objects.md` | Батч промптов картинок H0, стиль SpongeBob | 2026-10-27 | STALE: H0-тест. Правило PROGRESS: защищённые персонажи только в тестах | archive |
| `h0/prompts/world_bible.md` | Промпт «библии мира» H0 | 2026-10-27 | STALE: в коде не используется, заменён brief и make | archive |
| `h0/dream/craft/scene_writing.md` | Промпт писателя первой сцены сна. Имя упоминается в `h0/dream/author.py` | 2026-10-29 | ACTIVE (промпт) | keep в h0 |
| `h0/dream/craft/scene_writing_r2.md` | Вариант r2 того же промпта | 2026-10-29 | UNKNOWN / DUPLICATE (версия r2) | проверить, какой файл грузит `author.py`. Второй → archive |
| `h0/make/testdata/expect_task.md` | Фикстура задачи для `test_world` | 2026-10-31 | ACTIVE (тестовый вход) | keep |
| `h0/pipe2/prompts/architect_fix.md`, `seam_fix.md`, `critic_assets.md`, `critic_layout.md` | Промпты pipe2. Имена найдены в коде `h0/pipe2/*.py` | 2026-10-29 / 11-01 | ACTIVE | keep в h0/pipe2 |
| `h0/pipe2/prompts/architect.md`, `builder.md`, `fix.md` | Промпты pipe2. По имени в коде не найдены, вероятно грузятся из папки | 2026-10-29 / 11-01 | UNKNOWN | keep. Проверить загрузку |
| `h0/dream/books/gwtw/SOURCE.md` | Источник главы VI «Унесённые ветром» | 2026-10-29 | STALE: книга заменена Jane Eyre (память `demo-book-jane-eyre`), в PROGRESS:150 записи о замене нет (C15) | archive вместе с книгой после решения |
| `h0/dream/books/jane-eyre/SOURCE.md` | Источник демо-книги (public domain) | 2026-10-31 | ACTIVE | keep |
| `h0/dream/books/koshakan/SOURCE.md` | Источник книги Кошакан. Строка 1: «Private: not for the public submission without her approval» | 2026-11-01 | CONFLICT с памятью `koshakan-permitted` (C14) | обновить строку 1 после решения |
| `h0/dream/books/ohenry/SOURCE.md`, `h0/dream/books/sherlock/SOURCE.md` | Источники текстов для picks | 2026-10-30 / 10-31 | UNKNOWN (picks не используются в демо) | keep |
| `anymove/runs/squidward/ENGINE_NOTES.md` (внешний) | Заморожен. Баннер стр. 1: «Переехало… Здесь больше не дописывать». Тело совпадает с `research/engine_notes.md` | 2026-11-01 (mtime) | DUPLICATE (`research/engine_notes.md`). Память `anymove-engine-notes` ещё велит писать сюда (C5) | keep как указатель. Память исправить |

Ссылки на несуществующие файлы: `specs/parked-2026-10-30.md` (`dialogue-fixes-2026-10-30.md:70`, `tero-night-2026-10-30.md:323`); `LOG.md` (`research/engine_notes.md:3`); `specs/2026-11-02-plan` (план 2026-11-02, `PROGRESS.md:199`).

---

## 2. Группы файлов (не по одному)

| группа | что это | последнее изменение | статус | рекомендация |
|---|---|---|---|---|
| `app/**` (81) | IWSDK, встроенные инструкции. `app/README.md` — шаблон «IWSDK App». `app/.agents/skills` и `app/.claude/skills` — идентичные копии (diff пуст). `app/.claude/rules` и `app/.github/instructions` — копии правил, `ecs-api` отличается | 2026-10-27 | ACTIVE для app; дубли DUPLICATE | keep, не править руками, вне spine. `app/README.md` STALE (шаблон) |
| `h0/dream/books/**/excerpts` (12) и `picks` (6) | Тексты книг для фикстур | 2026-10-30 / 10-31 | DATA, не документы | keep. У части файлов сломана кодировка (`вАЩ`, `вАЬ`: excerpts 03, 07, 10, 12; `picks/1b`). Проверить |
| `specs/critique/*` (17) | Критики спек: `compare.md`, `make-v0.1…0.5` (Luna, Opus), `muse-contributor-w1…w3`, `muse-seq-1…6`, `opus.md` | 2026-10-27 / 10-31 | DONE (журналы) | archive в `archive/critique/` |
| `.pytest_cache/README.md` и четыре похожих в `h0/`, `h0/dream/`, `h0/live/`, `h0/squid_live/` (5) | Автогенерация pytest, в .gitignore | — | кэш | delete-candidate (пересоздаются) |
| `.tero/runs/20261027-…-tero-dream-sandbox/debt.md` (1) | Долг песочницы F4, F5, F15, погашен вручную 10-27 | 2026-10-27 (mtime) | DONE, не трекается | delete-candidate или слить в LESSONS (уже закрыто) |

---

## 3. Индекс памяти → md-файлы

Файл индекса: `/Users/terobyte/.claude/projects/-Users-terobyte-Desktop-Projects-Active-meta/memory/MEMORY.md`. Записей 52.

| запись памяти | указывает на | состояние |
|---|---|---|
| `progress-tracking` | PROGRESS.md | ок, но карта PROGRESS устарела (C2) |
| `lessons-ledger-rule` | LESSONS.md | ок |
| `llm-friction-log` | research/llm_friction.md | ок |
| `meta-hackathon` | RESEARCH.md («план в RESEARCH») | STALE: план по дням в RESEARCH устарел. Дедлайны держать в PROGRESS |
| `anymove-engine-notes` | anymove/…/ENGINE_NOTES.md («дописывать сюда») | CONFLICT: заморожен, писать в research/engine_notes.md (C5) |
| `rest-pose-not-tpose`, `engine-idle-life-layer` | «ENGINE_NOTES 34», engine_notes §34–38 | ок, указать новый путь |
| `koshakan-permitted` | h0/dream/books/koshakan/SOURCE.md | CONFLICT (C14) |
| `sam3d-watchdog-fix` | LESSONS L55 | CONFLICT по состоянию сторожа (C4) |
| `gate-speedup-plan` | LESSONS L67 | ок. Цифры разные (C17) |
| `demo-book-jane-eyre` | h0/dream/books/jane-eyre/SOURCE.md | ок. PROGRESS:150 про GWTW (C15) |
| `parked-book-modes-voice`, `parked-director-history-summary`, `parked-pipe2-speedup`, `parked-pose-clips-omni`, `streaming-city-idea`, `npc-affordance-bank`, `book-world-one-place` | LESSONS L25, L28, L57, L30, P1, L3, L23 | ок: парковки записаны |
| `film-contact-sheet-check` | LESSONS L15, L68 | ок |
| `book-freestyle-state`, `dream-loop-diagnosis` | LESSONS L25–L27, L66 | в памяти «suite rerun owed», в LESSONS такого пункта нет. Добавить |
| `tero-muse-contributor` | specs/2026-11-01-engine-worlds.md | ок |
| `engine-code-space-ai-texture`, `world-lifehacks`, `engine-day0-motion`, `engine-motion-question`, `muse-prompts-own-models`, `engine-phase1-run`, `anymove-repo`, `always-high-effort`, `codex-headless-imagegen`, `demo-subjects-not-squidward`, `squid-duo-page`, `dreamer-decisions-oct28`, `pipe2-contributor`, `meta-asr-endpoint`, `world-bench` | решения и инструкции, в md meta не разложены | память — единственное место для части из них. Оставить |
| `tero-cli-roles`, `tero-status-check`, `tero-stop-snapshot`, `tero-jev-key`, `baseten-muse-spark-open`, `modal-acc2-primary`, `codex-exec-cwd`, `omni-video-howto`, `user-job-loss-stakes`, `guarded-characters-no-names`, `always-high-effort` | инструменты и правила процесса, не md meta | не трогать в рамках этой инвентаризации |

---

## 4. Spine: единый источник правды

Принцип: **новая находка → LESSONS с ID и статусом в тот же день. PROGRESS ссылается на ID и не копирует текст.**

| файл | что держит | чего не держит |
|---|---|---|
| `PROGRESS.md` | Текущее состояние. Дедлайны (4 ноября 21:00 ET; 18 ноября). Что запущено. «Следующий шаг» из 3–5 пунктов со ссылками на ID | уроки, долги, история, длинные таблицы |
| `LESSONS.md` | Каждый урок, долг, парковка, отказ: ID (L, P), статус, источник | детали (они в research/, specs/) |
| `specs/2026-11-01-engine-worlds.md` (и следующие ночные спеки) | Фазы текущей работы с чекбоксами | история и статусы уроков |
| `specs/make-debt.md` | Детали долга. Каждый пункт имеет L-ID | статусы (статус живёт в LESSONS) |
| `bugs.md` | Только открытые баги, ID B-n | закрытые (переезжают в archive) |
| `research/engine_notes.md` | Подробности уроков движка, EN n | статусы |
| `research/llm_friction.md` | Трения LLM, TR n → будущие инструменты | статусы |
| `RESEARCH.md` | Факты хакатона, гипотезы H-n с цифрами | план по дням, открытые вопросы (перенести в PROGRESS) |
| `DEVLOG.md` | История для презентации, пишется по факту | статус |
| `AGENTS.md` | Правила «как строить миры» | планы |

Связи: `PROGRESS` → `LESSONS` (ID) → спека фазы / `make-debt` / `engine_notes` (источник). Артефакты запусков tero остаются в `.tero/` и `refs/tero/…`, в документы не копируются.

---

## 5. Конфликты

Цитаты даны по файлу и строке, где это важно.

| № | конфликт | детали |
|---|---|---|
| C1 | **Два «следующих шага».** | `PROGRESS.md:56–60`: «## Следующий шаг (очередь, по приоритету)» → «1. **Песочница сна без 3D (H18 + H19 + H20 + H21 вместе)**», далее лестница намёков, H16 интерьер, L1 вода. Это план от 10-27/28. H18–H21 сделаны (`DEVLOG.md` главы 8–9). Ни один пункт PROGRESS:57–60 не записан в LESSONS. Актуальный план — `specs/2026-11-01-engine-worlds.md` и LESSONS. |
| C2 | **Путь к прогонам tero неверный.** | `PROGRESS.md:17`: «`~/.claude/tero/runs/2026-10-27-*.md`». Реальные прогоны: `meta/.tero/runs/` (каталоги с 10-27 по 11-01; в .gitignore). Указанная папка — от старого навыка tero. |
| C3 | **Дата и «открыл сессию».** | `PROGRESS.md:20`: «_Обновлено: 2026-10-27_», хотя файл менялся 11-01. `PROGRESS.md:4`: «продолжил с «Следующий шаг»» — пункт, который отстал на несколько дней. |
| C4 | **Сторож SAM3D: четыре версии состояния.** | (а) `research/engine_notes.md:303`: «Сторож SAM3D в meta … работает всегда: `schedule=modal.Period(minutes=2)`». (б) `PROGRESS.md:216`: «SAM3D на acc2 остановлен 11-01». (в) LESSONS, L55: «App остановлен руками 11-01, перед сборкой мира нужен `modal deploy`». (г) `specs/2026-11-01-engine-worlds.md:5`: «Сторож Modal … в эту ночь не делается». Память `sam3d-watchdog-fix`: «cron every 2 min keeps … alive». Нужна одна строка состояния в PROGRESS. |
| C5 | **Куда писать уроки движка.** | Память `anymove-engine-notes`: «log every problem/trick to anymove/runs/squidward/ENGINE_NOTES.md». Сам файл, `ENGINE_NOTES.md:1`: «Переехало (2026-11-01)… Здесь больше не дописывать». `PROGRESS.md:15`: `research/engine_notes.md`. Ещё: `research/engine_notes.md:3` ссылается на `LOG.md`, которого нет. |
| C6 | **Буква «Б» означает три разные вещи.** | `specs/tero-night-2026-10-30.md:134`: «## Блок Б. 3D-движок: бюджет». `specs/make-one-prompt.md:98–127`: «## Б1…Б4» (баги охоты 10-31). `specs/dream-b1.md:1`: «Dreamer dream Б1» (то же, что make-one-prompt Б1). `make-one-prompt.md:3` говорит «Этот файл — только порядок фаз и чекбоксы», но содержит Б-блоки. |
| C7 | **Статусы багов расходятся с чекбоксами планов.** | `bugs.md:151`: «Статус у всех `reported`», а ниже (`bugs.md:161–226`) большинство «Статус: fixed». Примеры: `make-one-prompt.md:106` «- [ ] B60 …» против `bugs.md:224` «Статус: fixed — `line` книжного бита несёт…»; `dream-b2.md:32` «- [ ] B53» против `bugs.md:208` «fixed»; `dream-b1.md:30–31` «B43», «B46 + B47» против `bugs.md:202–204` «fixed»; `make-engine-bugs.md:39–42` «B20/B21/B22» против `bugs.md:169–173` «fixed». |
| C8 | **Раздел, который обещан, но не создан.** | `specs/2026-11-01-engine-worlds.md:9`: «хозяин пишет остаток в `specs/make-debt.md` (раздел «Миры, ночь 2»)». Раздела в make-debt нет (есть «М0–М6», «Анимация и камера», «Камера книги»). Для `engine-anim-camera.md:9` раздел «Анимация и камера» есть. |
| C9 | **Битая ссылка на парковки.** | `specs/dialogue-fixes-2026-10-30.md:70` и `specs/tero-night-2026-10-30.md:323`: «`specs/parked-2026-10-30.md`». Файла нет. Парковки «подслушивающий герой и анимация» в LESSONS не записаны. |
| C10 | **Долг в пяти местах.** | `specs/make-debt.md`; `specs/tero-engine-phase2-debt.md` (Д1–Д18); `h0/pipe2/CHECKPOINT.md`; `bugs.md` (открытые B55–B61); `specs/2026-10-28-dream-story-design.md:338` («## 13. Долг», Д1–Д11). `specs/tero-night-2026-10-30.md:11`: «записать долг в `h0/pipe2/CHECKPOINT.md` (или `specs/tero-engine-phase2-debt.md`)». LESSONS (правило 1) требует, чтобы долг имел статус в LESSONS. Ни один долг-файл не ссылается на L-ID. |
| C11 | **Статус make: спека и план не совпадают.** | `specs/2026-10-31-dreamer-make.md:201–218`: десять `[ ]` (например, стр. 201: «make.json, input_hash по формуле…»). `PROGRESS.md:186`: «### Dreamer make: итог М0–М6 (Oct 31, ночь)». Все М-фазы в `make-one-prompt.md:28–89` отмечены `[x]`. |
| C12 | **Две спеки на одну дату.** | `specs/2026-11-01-engine-anim-camera.md:1`: «(ночь 2026-11-01)». `specs/2026-11-01-engine-worlds.md:1`: «(ночь 2)». У обеих свои порядки фаз, свои ветки (`tero/2026-11-01-engine-anim-camera`, `tero/2026-11-01-engine-worlds`) и правила игроков. Порядок выполнения в PROGRESS не записан. |
| C13 | **Дубли планов.** | `specs/2026-10-27-dream-sandbox-plan.md` и `specs/tero-dream-sandbox.md` — оба «план для tero» одной песочницы. `h0/pipe2/checkpoint-judge-prompt.md:91–96` = `specs/tero-pipe2.md:203–208`. `research/anim_engine_notes.md` = начало `research/engine_notes.md`. |
| C14 | **Кошакан: разрешение.** | `h0/dream/books/koshakan/SOURCE.md:1`: «Private: not for the public submission without her approval». Память `koshakan-permitted`: «user says Koshakan has permission for the public submission; SOURCE.md is stale». |
| C15 | **Какая книга демо.** | `PROGRESS.md:150`: «Книга — «Унесённые ветром», глава VI (решение хозяина 10-30)». Память `demo-book-jane-eyre`: «replacing GWTW». В репо записи о замене нет, `h0/dream/books/gwtw/` всё ещё на месте. |
| C16 | **Trellis и план 2026-11-02.** | `specs/2026-11-01-engine-worlds.md:3`: «Trellis … не возвращать и не упоминать». `PROGRESS.md:199`: «Остаётся от Trellis … см. план 2026-11-02». Такого плана нет. |
| C17 | **Цифры гейта.** | `PROGRESS.md:169`: «Гейт с 13 мин до 40 с». Память `gate-speedup-plan`: «gate ~1 min in main 65c5313». Мелочь, но цифра разная. |
| C18 | **Имена веток pipe2.** | `h0/pipe2/CHECKPOINT.md:4`: база «`tero/tero-pipe2`». `specs/tero-night-2026-10-30.md`: «ветка одна — `codex/finish-pipe2`». `specs/make-one-prompt.md`: ветка `make/one-prompt`. Три имени для одной линии. |

Подробнее о C7 и C10 см. раздел 6, там же то, что открыто.

---

## 6. Открытая работа вне LESSONS и спек

Колонка «в LESSONS?» — есть ли пункт с ID. «Нет» означает, что работа есть только в md-файле.

| файл:строка | пункт | в LESSONS? |
|---|---|---|
| `RESEARCH.md:107` | `[ ]` Пришло ли письмо об отборе (Gmail не авторизован, проверить вручную) | Нет. Срочно: сабмит 4 ноября |
| `RESEARCH.md:108` | `[ ]` Опубликованы ли Official Rules: призы, длина видео, нужен ли репо, можно ли старый код | Нет. Срочно |
| `RESEARCH.md:109` | `[ ]` Ссылка на Discord и расписание воркшопов | Нет |
| `RESEARCH.md:110` | `[ ]` Платформа сабмита: Devpost или форма CV | Нет. Срочно |
| `RESEARCH.md:111` | `[ ]` Активированы ли $150 кредитов в дашборде Model API | Нет |
| `PROGRESS.md:57–60` | «Следующий шаг» 1–4: песочница H18–21 (сделано), лестница намёков в rt.py, H16 интерьер, L1 вода | Нет. Устарело (C1) |
| `PROGRESS.md:65` | Security: `h0/live/rt.py` без проверки Origin, `h0/live/server.py` без защиты от CSRF/DNS-rebinding. Закрыт только `dream/server.py` (B30) | Нет |
| `PROGRESS.md:66–70` | Шаблонные файлы в `app/src` (robot.ts, panel.ts, scene-assets/, public/ui/*.uikitml); тёмные точки сплатов; «старые предложения». `toneMapping none` уже сменён на Neutral (см. строку ae45a21 в «Кошакан: фильм движком») | Нет. Частично устарело |
| `research/engine_notes.md:143–149` | «Следующие шаги» 2 (второй гуманоид, авто-риг, ретаргет, «15 с на персонажа») и 5 (словарь жестов для демо). Пункт 3 = L38, пункт 4 = L37 | Частично: 2 и 5 — нет |
| `bugs.md:40–44` | «Что сделать до фазы 4»: Memory к Sim, настоящий transport, tихие `except` | Нет. Устарело (фаза 4 песочницы закрыта) |
| `bugs.md:167–177` (B19–B22, B36) | B19–B22 помечены fixed. Для B36 строка статуса не найдена скриптом, проверить вручную | Нет. Проверить |
| `bugs.md:220–226` | B55–B59 (anymove mocap, L/R суставы, цвет конечностей, число конечностей), B61 (что движется в выходе архитектора) | Частично: L31–L36. B55, B59, B61 — нет |
| `specs/make-debt.md:4–25` | М0 гонки `_publish` и `.lock` (F3, F8, F13, F21, F28); М1 `cap_usd=inf`; М3 фикстура двух миров и бренд «Studio Ghibli» в TASK.md; М5 `npx tsc --noEmit` красный; М6 `_gltf_doc_ok` не полный валидатор | Нет |
| `specs/make-debt.md:28–29` | Сквозная приёмка Кошакана (фикстура `testdata/koshakan`, журнал вне `h0/out`); формат реплик `Mama: текст` для `dream/book.py` | Нет |
| `specs/make-debt.md:31–46` | Камера книги А3a/А3b: `director.ts:157, 159, 189, 270, 281, 298`; противоречия правил 1 и 5 | Частично: L16–L18 |
| `specs/tero-engine-phase2-debt.md:1–57` | Д1–Д18: края тестов поворота, геометрия лестниц, перила, `DREAMER_TIMING_FILE` | Нет |
| `specs/2026-10-28-dream-story-design.md:295–300` | §8: вопрос 1 (граница режима 2) и вопрос 3 (тяжёлые темы в сценах) открыты | Нет |
| `specs/2026-10-28-dream-story-design.md:338–351` | §13: Д1–Д9 не закрыты явно, Д10–Д11 закрыты | Нет |
| `specs/engine-scene.md:378–380` | Открытые вопросы: нужен ли третий `fixture` или общий «ящик»; `snap_eps = 0.10` склеит ли ниши | Нет |
| `specs/tero-pipe2.md:203–256` | 22 `[ ]`: параллельность строителей, degrade, heartbeat GPU, Modal autoscaler. Конвейер на паузе (C6, CHECKPOINT) | Нет (в LESSONS только скорость, L57) |
| `specs/make-one-prompt.md:102–135` | 19 `[ ]` блока Б1–Б4 (дубли bugs и dream-b1/b2/make-engine-bugs) | Нет |
| `specs/2026-10-31-dreamer-make.md:201–218` | 10 `[ ]` при закрытых М0–М6 (C11) | Нет |
| `specs/2026-10-31-dreamer-make.md:237–240` | «Открыто (решает хозяин)»: Торнфилд для демо; потолок денег на живой прогон 11-01; slug MuAPI для пути B каста | Нет |
| `PROGRESS.md:186–190` | Не сделано: каст путь B (картинка → muapi_3d), живые прогоны brief, refs, world, check | Нет |
| `research/pitch-and-artifact-2026-10-30.md` | Нарратив питча и идея «артефакт»: нужен в сабмите | Нет |
| Память `book-freestyle-state` | «suite rerun owed»; фристайл ни разу не прогнан вживую дальше улицы | Нет (в LESSONS L25 и L26 — частично) |
| `specs/dialogue-fixes-2026-10-30.md:70` | «подслушивающий герой и анимация» (ссылка на несуществующий файл) | Нет (C9) |

---

## 7. Предлагаемый порядок

### 7.1. Что архивировать (в `archive/`, ничего не удалять)

| что | куда |
|---|---|
| Закрытые планы и спеки: `2026-10-27-dream-sandbox-plan.md`, `tero-dream-sandbox.md` (оставить один), `2026-10-27-dream-sandbox.md`, `2026-10-28-dream-phase1-plan.md`, `tero-engine-phase1.md`, `tero-engine-phase2.md`, `tero-night-2026-10-30.md`, `dialogue-fixes-2026-10-30.md`, `2026-11-01-engine-anim-camera.md` (после закрытия ночи) | `archive/specs-done/` |
| `specs/critique/*` (17 файлов) | `archive/critique/` |
| `specs/make-one-prompt.md` (после переноса открытого Б в bugs / make-debt), `dream-b1.md`, `dream-b2.md`, `make-engine-bugs.md` | `archive/specs-done/` |
| `h0/world/twelve_oaks/brief.md`, `POSTMORTEM.md`, `h0/prompts/world_bible.md`, `h0/prompts/chatgpt_objects.md`, `h0/pipe2/checkpoint-judge-prompt.md` | `archive/h0/` |
| `h0/pipe2/CHECKPOINT.md` (после решения по pipe2) | `archive/h0/` |
| `research/ab/twelve-oaks-2026-10-29/README.md` | `archive/research/` |
| Закрытые пункты `bugs.md` (fixed) | `archive/bugs-fixed.md` |
| История статусов из PROGRESS (разделы «Сделано и проверено» с H0–H17, «Фаза 1 — итог», «Фазы 2–3 — итог») | `archive/PROGRESS-history.md` |
| `specs/2026-10-28-dream-story-design.md` после ответов на §8 | `archive/specs-done/` (или слить с книжным дизайном) |
| `h0/dream/books/gwtw/` после решения по C15 | `archive/books/` |

### 7.2. Что слить

| что | во что |
|---|---|
| `specs/dream-b1.md`, `dream-b2.md`, `make-engine-bugs.md`, блок Б из `make-one-prompt.md` | открытое — в `bugs.md` (ID B-n) и раздел «Баги охоты 10-31» в `make-debt.md` |
| `specs/tero-engine-phase2-debt.md` | раздел «Движок, фазы 1–16» в `make-debt.md`; каждый пункт получает L-ID в LESSONS |
| `specs/2026-10-28-dream-story-design.md` §13 | LESSONS (Д1–Д11 получают L-ID или закрываются) |
| `RESEARCH.md`: «Открытые вопросы» и «План по дням» | открытые вопросы — в PROGRESS, раздел «Дедлайны и сабмит»; план по дням — в archive |
| `h0/dream/craft/scene_writing_r2.md` и `scene_writing.md` | одна версия (после проверки, какую грузит `author.py`) |
| `research/anim_engine_notes.md` | удалить после подтверждения (delete-candidate) |
| `.tero/…/debt.md`, `.pytest_cache/README.md` ×5 | удалить после подтверждения (delete-candidate) |

### 7.3. Порядок работ (по шагам, короткими)

1. Закрыть C1, C3, C4 и C16 в PROGRESS: один «Следующий шаг» из 3–5 пунктов, одна строка про сторож SAM3D, актуальная карта трекинга.
2. Вынести пять пунктов из `RESEARCH.md:107–111` в PROGRESS (сабмит 4 ноября важнее всего, это 5 строк).
3. Присвоить L-ID всем открытым пунктам из раздела 6 со статусом «Нет». Открытое из `make-debt`, `phase2-debt`, `bugs.md` и `dream-story-design` §13 переехать в LESSONS.
4. Исправить битые ссылки: `parked-2026-10-30.md`, `LOG.md`, «план 2026-11-02».
5. Решить по `pipe2` (возобновить или заархивировать), по Кошакану (C14) и по GWTW (C15). Эти три решения хозяина, без них архив неполный.
6. Перенести архив (`git mv` в `archive/`) отдельным коммитом. Удаление кэшей и `anim_engine_notes.md` — только после подтверждения.
7. Обновить память: `anymove-engine-notes` (писать в `research/engine_notes.md`), `koshakan-permitted`, `demo-book-jane-eyre`, `sam3d-watchdog-fix`.

### 7.4. Итоговая структура

```
meta/
  AGENTS.md  CLAUDE.md          правила
  PROGRESS.md                   статус, дедлайны, следующий шаг      SPINE
  LESSONS.md                    реестр L/P со статусами              SPINE
  DEVLOG.md                     история для презентации
  RESEARCH.md                   факты хакатона, гипотезы H-n
  bugs.md                       только открытые баги B-n
  specs/
    2026-11-01-engine-worlds.md текущая спека                          SPINE
    make-debt.md                детали долга (с L-ID)                SPINE
    engine-scene.md             контракт SCENE.json
    2026-10-31-dreamer-make.md  контракт make / make.book
    (book design, pipe2 — по решению хозяина)
  research/
    engine_notes.md             уроки движка EN n
    llm_friction.md             трения LLM TR n
    pitch-and-artifact.md       submission
    video/                      конспекты (track)
  engine/docs/  h0/prompts, h0/pipe2/prompts, h0/dream/craft   код-входы, не трогать
  app/                          IWSDK, не трогать
  archive/                      всё закрытое, ничего не удалять
```

---

## Итог

- 179 md: 52 разобраны по одному, остальные — группами (app 81, книги 23, критики 17, кэши 5, .tero 1).
- Spine: `PROGRESS.md` (статус), `LESSONS.md` (реестр), `specs/2026-11-01-engine-worlds.md` (текущая спека), `specs/make-debt.md` (детали долга), `research/engine_notes.md` и `llm_friction.md` (детали уроков и трений).
- Главные конфликты: C1 (PROGRESS «следующий шаг» устарел), C4 (четыре версии сторожа SAM3D), C7 (статусы багов против чекбоксов), C10 (долг в пяти местах), C14–C15 (Кошакан и GWTW).
- Срочное из открытой работы: пять пунктов RESEARCH.md:107–111 (сабмит 4 ноября), в LESSONS их нет.
- Предложено: архив в `archive/`, слить дубли Б-спек и долги в make-debt и LESSONS, удалить кэши и `anim_engine_notes.md` только после подтверждения.
