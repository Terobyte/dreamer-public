"""Контракт фазы 2-3 (свод, код не меняется): итог в DEVLOG и PROGRESS.md.

Свод обязан содержать таблицу шагов 2.1-3.3, решения хозяина, что ждёт
денег/спеки, строку про ручную проверку - и три зафиксированных зелёных
прогона полного набора (ловим тайминговые флаки).
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read()


class Phase23SummaryTest(unittest.TestCase):
    def _check(self, text, where):
        for step in ("2.1", "2.2", "2.3", "3.1", "3.2", "3.3"):
            self.assertIn(step, text, "%s: нет шага %s" % (where, step))
        for kw in ("шёпот", "messages[].to", "compact_every",
                   "3.1c", "3.4", "Фаза 4",
                   "ручная проверка панели и кнопок в браузере"):
            self.assertIn(kw, text, "%s: нет %r" % (where, kw))

    def test_devlog_summary(self):
        self._check(_read("DEVLOG.md"), "DEVLOG")

    def test_progress_summary(self):
        self._check(_read("PROGRESS.md"), "PROGRESS")

    def _runs(self, text, where):
        pairs = re.findall(r"прогон ([123]) — (\d+) OK", text)
        nums = [p[0] for p in pairs]
        self.assertEqual(sorted(set(nums)), ["1", "2", "3"],
                          "%s: нет трёх зафиксированных зелёных "
                          "прогонов (есть %s)" % (where, sorted(set(nums))))
        self.assertEqual(len(nums), len(set(nums)),
                          "%s: прогон записан не ровно один раз" % where)
        counts = {p[1] for p in pairs}
        self.assertEqual(len(counts), 1,
                          "%s: прогоны разного размера набора (%s)" % (where, sorted(counts)))
        return counts.pop()

    def test_three_green_runs_recorded(self):
        dev_count = self._runs(_read("DEVLOG.md"), "DEVLOG")
        progress_count = self._runs(_read("PROGRESS.md"), "PROGRESS")
        self.assertEqual(dev_count, progress_count,
                          "DEVLOG (%s) и PROGRESS.md (%s) расходятся по числу тестов"
                          % (dev_count, progress_count))
