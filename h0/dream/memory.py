"""Director memory: 5 layers, budgets, sync trim, raw episodes, facts (spec section 7).
usage: cd h0/dream && python3 -m unittest -q
"""

import json
import math
import os
import re
import threading
from functools import wraps

if __package__:
    from .diagnostics import report
else:
    from diagnostics import report


def synchronized(method):
    """Protect in-memory state, never a provider call."""
    @wraps(method)
    def guarded(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return guarded

HARD_CAP = 5800
LAYER_BUDGET = 3200
LAYER_BUDGETS = {"core": 600, "working": 1000, "episodes": 900,
                 "facts": 600, "decisions": 400, "tail": 700}
FACT_BUDGET = 600
EVENT_KEEP = 100  # active event queue; older events go to episodes_raw/ first
DECISION_KEEP = 8  # recent decisions in memory; full log in decisions.jsonl
MERGE_INSTRUCTION = (
    "Merge these episodes into one fixed-format summary. Reply with exactly "
    "these four lines:\n"
    "WHAT HAPPENED: <what happened>\n"
    "HERO WANTED: <what the hero wanted>\n"
    "HERO REACTION: <how the hero reacted>\n"
    "BRIDGE AND WHY: <which bridge object led on, and why>")


class BudgetError(Exception):
    """Raised when even the minimal prompt cannot fit HARD_CAP.

    Caller maps it to director_fail("budget") (spec section 7);
    core is never trimmed.
    """


def tokens(text):
    if not isinstance(text, str):
        text = str(text)
    return math.ceil(len(text) / 3.5)


def _one_line(text, width=80):
    s = " ".join(str(text).split())
    return s[:width] + "..." if len(s) > width else s


def _first_line(text):
    lines = [l for l in str(text).splitlines() if l.strip()]
    return lines[0] if lines else str(text)


def _ev_text(ev):
    if isinstance(ev, str):
        return ev
    if isinstance(ev, dict):
        parts = [str(ev.get(k, "")) for k in ("source", "type", "value", "outcome")]
        s = " ".join(p for p in parts if p)
        if s:
            return s
    return json.dumps(ev, ensure_ascii=False)


def _cap(text, budget):
    if tokens(text) <= budget:
        return text
    return text[:max(0, int(budget * 3.5) - 16)]


def _llm_module():
    """Resolve in the current namespace, without masking import errors."""
    if __package__:
        from . import llm as _m
    else:
        import llm as _m
    return _m


class Memory:
    def __init__(self, root, transport=None, llm_transport=None,
                 fake_transport=None, event_sink=None):
        self.root = root
        self.event_sink = event_sink
        self._lock = threading.RLock()
        self._merge_lock = threading.Lock()
        self._merge_thread = None
        self._facts_revision = 0
        self._order_path = os.path.join(root, "episode_order.json")
        self._raw_order = []
        self.transport = transport or llm_transport or fake_transport
        self.raw_dir = os.path.join(root, "episodes_raw")
        os.makedirs(self.raw_dir, exist_ok=True)
        self.facts_path = os.path.join(root, "facts.jsonl")
        self.decisions_path = os.path.join(root, "decisions.jsonl")
        self.core = {"desire": "", "anxiety": "", "scene": "",
                     "objects": [], "bridge": None}
        self.lines, self.events, self.decisions = [], [], []
        self.episodes, self.facts = [], []
        self._fact_seq = 0
        self._scene_epoch = 0
        self._sel_cache = None
        self._sel_thread = None
        self._sel_thread_epoch = None
        self._sel_done_epoch = None
        self._decisions_dropped = 0
        self._events_archived = 0
        self._archive_seq = 0
        self._merge_groups = None
        self._merge_summaries = {}
        self._archived_count = 0
        if os.path.exists(self._order_path):
            with open(self._order_path, encoding="utf-8") as stream:
                self._raw_order = json.load(stream)
        self._discover_raws()
        if os.path.exists(self.facts_path):
            with open(self.facts_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    rec["scene_epoch"] = -1
                    self.facts.append(rec)
            nums = [int(str(f.get("id", "f0"))[1:]) for f in self.facts
                    if str(f.get("id", "")).startswith("f")
                    and str(f.get("id", ""))[1:].isdigit()]
            self._fact_seq = max([0] + nums)

    # --- core / scene / inputs -------------------------------------------
    @synchronized
    def set_core(self, desire="", anxiety="", scene="", objects=(), bridge=None):
        self.core = {"desire": desire, "anxiety": anxiety, "scene": scene,
                     "objects": list(objects), "bridge": bridge}

    @synchronized
    def set_scene(self, scene, objects):
        self.core["scene"] = scene
        self.core["objects"] = list(objects)
        self.core["bridge"] = None
        self._scene_epoch += 1
        self._sel_cache = None

    @synchronized
    def set_bridge(self, bridge):
        self.core["bridge"] = bridge

    @synchronized
    def add_line(self, who, text):
        self.lines.append({"who": who, "text": text})

    @synchronized
    def add_event(self, ev):
        """Queue an event; on overflow the oldest half goes to episodes_raw/."""
        self.events.append(_ev_text(ev))
        if len(self.events) > EVENT_KEEP:
            n_drop = len(self.events) - EVENT_KEEP // 2
            self.save_episode_raw(self._next_archive_id("events_archive"),
                                  "\n".join(self.events[:n_drop]))
            self._events_archived += n_drop
            del self.events[:n_drop]

    @synchronized
    def record_decision(self, d=None, **kw):
        if d is None:
            d = kw
        elif kw:
            d = dict(d, **kw)
        d = dict(d)
        with open(self.decisions_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(d, ensure_ascii=False, default=str) + "\n")
        self.decisions.append(d)
        if len(self.decisions) > DECISION_KEEP:
            self._decisions_dropped += len(self.decisions) - DECISION_KEEP
            del self.decisions[:-DECISION_KEEP]

    # --- episodes ---------------------------------------------------------
    @synchronized
    def save_episode_raw(self, eid, text):
        if (not isinstance(eid, str) or not eid or eid in (".", "..")
                or "/" in eid or "\\" in eid or "\x00" in eid
                or ".." in eid):
            raise ValueError("unsafe episode id: %r" % (eid,))
        path = os.path.abspath(os.path.join(self.raw_dir, eid + ".txt"))
        if not path.startswith(os.path.abspath(self.raw_dir) + os.sep):
            raise ValueError("unsafe episode id: %r" % (eid,))
        with open(path, "w",
                  encoding="utf-8") as f:
            f.write(text)
        if eid in self._raw_order:
            # Replacing an original invalidates summaries derived from it.
            self._merge_groups = None
            self._merge_summaries = {}
        if eid not in self._raw_order:
            self._raw_order.append(eid)
            self._save_order()
        if self._merge_groups is not None:
            known = {x for g in self._merge_groups for x in g}
            if eid not in known:
                self._merge_groups.append([eid])

    @synchronized
    def _archive_working(self, lines):
        """Save lines leaving the working layer into episodes_raw/ first.

        Only the raw file is written here; it becomes a prompt episode
        only after a background merge_from_raw() -- never as a raw dump.
        """
        lines = [l for l in lines if not l.get("_archived")]
        if not lines:
            return
        for l in lines:
            l["_archived"] = True
        text = "\n".join("%s: %s" % (l.get("who", ""), l.get("text", ""))
                         for l in lines)
        self.save_episode_raw(self._next_archive_id("working_archive"), text)

    @synchronized
    def _next_archive_id(self, prefix):
        """Unique raw episode id; never reuses a file already on disk."""
        while True:
            self._archive_seq += 1
            eid = "%s_%03d" % (prefix, self._archive_seq)
            if not os.path.exists(os.path.join(self.raw_dir, eid + ".txt")):
                return eid

    def _save_order(self):
        # Metadata stays outside episodes_raw/: that directory contains only text.
        temporary = self._order_path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as stream:
            json.dump(self._raw_order, stream)
        os.replace(temporary, self._order_path)

    def _discover_raws(self):
        files = [f for f in os.listdir(self.raw_dir) if f.endswith(".txt")]
        # Migrate archives without a manifest using file timestamps. Numeric suffix
        # breaks timestamp ties across archive types; subsequent writes are explicit.
        def legacy_order(name):
            match = re.search(r"_(\d+)\.txt$", name)
            return (os.stat(os.path.join(self.raw_dir, name)).st_mtime_ns,
                    int(match[1]) if match else 0, name)
        discovered = [f[:-4] for f in sorted(files, key=legacy_order)]
        present = set(discovered)
        ordered = [eid for eid in self._raw_order if eid in present]
        ordered += [eid for eid in discovered if eid not in ordered]
        if ordered != self._raw_order:
            self._raw_order = ordered
            self._save_order()
        nums = [int(m[1]) for eid in ordered
                if (m := re.search(r"_(\d+)$", eid))]
        self._archive_seq = max([self._archive_seq] + nums)

    @synchronized
    def _read_raws(self):
        self._discover_raws()
        raws = []
        for eid in self._raw_order:
            with open(os.path.join(self.raw_dir, eid + ".txt"),
                      encoding="utf-8") as stream:
                raws.append({"id": eid, "text": stream.read()})
        return raws

    def _episodes_from_groups(self, raws):
        by_id = {r["id"]: r["text"] for r in raws}
        out = []
        for group in self._merge_groups:
            if len(group) == 1:
                out.append({"id": group[0], "text": by_id.get(group[0], ""),
                            "raw_ids": list(group)})
            else:
                out.append({"id": "+".join(group),
                            "text": self._merge_summaries.get(tuple(group), ""),
                            "raw_ids": list(group)})
        return out

    def _compress(self, instruction, text, transport=None):
        # An injected transport is a dependency, not a flag disabling real mode.
        return _llm_module().call(
            "compress", instruction, [{"role": "user", "content": text}],
            max_tokens=300, _transport=transport or self.transport,
            event_sink=self.event_sink).text

    def merge_from_raw(self, transport=None, background=False):
        """Serialize merges, snapshot under the state lock, call outside it.

        New inputs remain available while the model works. A result is published
        only if its source files still match; raw files are never deleted.
        """
        if background:
            with self._lock:
                if self._merge_thread is not None and self._merge_thread.is_alive():
                    return self._merge_thread
                self._merge_thread = threading.Thread(
                    target=self.merge_from_raw, kwargs={"transport": transport},
                    daemon=True)
                self._merge_thread.start()
                return self._merge_thread
        with self._merge_lock:
            with self._lock:
                raws = self._read_raws()
                known = [eid for g in (self._merge_groups or []) for eid in g]
                if self._merge_groups is None or set(known) != {r["id"] for r in raws}:
                    self._merge_groups = [[r["id"]] for r in raws]
                    self._merge_summaries = {}
                self.episodes = self._episodes_from_groups(raws)
                if len(self._merge_groups) < 2:
                    return self.episodes
                group = self._merge_groups[0] + self._merge_groups[1]
                source = {r["id"]: r["text"] for r in raws if r["id"] in group}
                raw_text = "\n---\n".join(source[eid] for eid in group)
            try:
                summary = self._compress(MERGE_INSTRUCTION, raw_text, transport)
                if not summary or not summary.strip():
                    raise ValueError("empty episode summary")
            except Exception as error:
                report("memory", "memory_merge_fail", error, self.event_sink)
                with self._lock:
                    return self.episodes
            with self._lock:
                current = self._read_raws()
                by_id = {r["id"]: r["text"] for r in current}
                if any(by_id.get(eid) != text for eid, text in source.items()):
                    self._merge_groups = [[r["id"]] for r in current]
                    self._merge_summaries = {}
                    self.episodes = self._episodes_from_groups(current)
                    report("memory", "memory_merge_stale", "raw episode changed",
                           self.event_sink)
                    return self.episodes
                if self._merge_groups is None:
                    self._merge_groups = [[r["id"]] for r in current]
                    self.episodes = self._episodes_from_groups(current)
                    return self.episodes
                self._merge_summaries[tuple(group)] = summary
                self._merge_groups = [group] + self._merge_groups[2:]
                self.episodes = self._episodes_from_groups(current)
                return self.episodes

    def merge_background(self, transport=None):
        return self.merge_from_raw(transport=transport, background=True)

    def wait(self, timeout=None):
        """Join owned workers before the run's storage is released."""
        for worker in (self._merge_thread, self._sel_thread):
            if worker is not None:
                worker.join(timeout)

    # --- facts --------------------------------------------------------------
    def _norm_fact(self, src):
        if isinstance(src, str):
            return {"title": " ".join(src.split()[:6]) or "untitled", "text": src}
        if not isinstance(src, dict):
            src = {"text": str(src)}
        return {"title": src.get("title") or "untitled", "text": src.get("text", "")}

    def _new_fact(self, src, supersedes_id=None):
        self._fact_seq += 1
        norm = self._norm_fact(src)
        return {"id": "f%d" % self._fact_seq, "title": norm["title"],
                "text": norm["text"], "supersedes_id": supersedes_id,
                "scene_epoch": self._scene_epoch}

    @synchronized
    def apply_facts(self, updates):
        self._facts_revision += 1
        added = []
        for u in updates or []:
            op = u.get("op")
            if op == "ADD":
                rec = self._new_fact(u.get("fact", ""))
                self.facts.append(rec)
                added.append(rec)
            elif op == "DELETE":
                self.facts = [f for f in self.facts if f.get("id") != u.get("id")]
            elif op == "UPDATE":
                drop = {u.get("id"), u.get("supersedes_id")} - {None}
                self.facts = [f for f in self.facts if f.get("id") not in drop]
                rec = self._new_fact(u.get("fact", ""),
                                     supersedes_id=u.get("supersedes_id") or u.get("id"))
                self.facts.append(rec)
                added.append(rec)
        with open(self.facts_path, "w", encoding="utf-8") as f:
            for fact in self.facts:
                f.write(json.dumps(fact, ensure_ascii=False) + "\n")
        if self._sel_cache and self._sel_cache[0] == self._scene_epoch:
            # keep this scene's pick: drop removed facts, add new ones
            live = {id(x) for x in self.facts}
            kept = [x for x in self._sel_cache[1] if id(x) in live]
            self._sel_cache = (self._scene_epoch, kept + added)
        else:
            self._sel_cache = None
            self._sel_done_epoch = None

    def _fact_layer_text(self, facts):
        """The serialized FACTS layer exactly as it goes into the prompt."""
        parts = []
        for f in facts:
            tag = "NEW THIS SCENE " if f.get("scene_epoch") == self._scene_epoch else ""
            parts.append("%s%s: %s" % (tag, f.get("title", ""), f.get("text", "")))
        return "FACTS\n" + "\n".join(parts) if parts else "FACTS none yet"

    def _facts_cost(self, facts):
        return tokens(self._fact_layer_text(facts))

    def _split_facts(self, epoch):
        fresh = [x for x in self.facts if x.get("scene_epoch") == epoch]
        older = [x for x in self.facts if x.get("scene_epoch") != epoch]
        return fresh, older

    def _fit_facts(self, fresh, ordered_older):
        """Fresh facts always; older ones while the serialized layer fits.
        If fresh alone overflow, build_prompt raises BudgetError."""
        picked = list(fresh)
        for fc in ordered_older:
            if self._facts_cost(picked + [fc]) <= FACT_BUDGET:
                picked.append(fc)
        return picked

    def _default_facts(self):
        """No-LLM fallback: fresh facts + older facts in insertion order."""
        fresh, older = self._split_facts(self._scene_epoch)
        return self._fit_facts(fresh, older)

    @synchronized
    def _facts_for_prompt(self):
        """Cached selection only -- build_prompt never calls an LLM.
        Facts added in this scene are always re-included on top of the
        cached picks; if both no longer fit, build_prompt raises."""
        cache = self._sel_cache
        if cache and cache[0] == self._scene_epoch:
            fresh, _ = self._split_facts(self._scene_epoch)
            live = {id(x) for x in self.facts}
            older = [x for x in cache[1] if id(x) in live
                     and x.get("scene_epoch") != self._scene_epoch]
            return fresh + older
        picked = self._default_facts()
        self._sel_cache = (self._scene_epoch, list(picked))
        return picked

    def _select_facts(self):
        """Publish a selection only for the scene and fact revision requested."""
        with self._lock:
            epoch, revision = self._scene_epoch, self._facts_revision
            if self._sel_done_epoch == epoch:
                return self._facts_for_prompt()
            fresh, older = self._split_facts(epoch)
            fits = self._facts_cost(self.facts) <= FACT_BUDGET
            picked = list(self.facts) if fits else self._default_facts()
        failed = False
        if not fits and older:
            try:
                titles = "\n".join("%s: %s" % (x.get("id"), x.get("title", ""))
                                   for x in older)
                reply = self._compress(
                    "Pick the most important fact titles. Reply with their ids/titles only.",
                    titles)
                if not reply or not reply.strip():
                    raise ValueError("empty fact selection")
                ids = set(re.findall(r"\bf\d+\b", reply))
                chosen = [x for x in older if x.get("id") in ids
                          or (x.get("title") and re.search(
                              r"(?<!\w)%s(?!\w)" % re.escape(x["title"]), reply))]
                picked = self._fit_facts(fresh, chosen)
            except Exception as error:
                failed = True
                report("memory", "memory_selection_fail", error, self.event_sink)
        with self._lock:
            if self._scene_epoch != epoch or self._facts_revision != revision:
                return self._facts_for_prompt()
            self._sel_cache = (epoch, list(picked))
            # Failed calls remain retryable; a temporary outage cannot cache an
            # empty selection for the entire scene.
            if not failed:
                self._sel_done_epoch = epoch
            return picked

    def select_facts_background(self):
        """One selection per scene; scene changes queue behind the old worker."""
        with self._lock:
            epoch = self._scene_epoch
            prev = self._sel_thread
            if prev is not None and prev.is_alive() and self._sel_thread_epoch == epoch:
                return prev

            def run():
                if prev is not None:
                    prev.join()
                self._select_facts()

            worker = threading.Thread(target=run, daemon=True)
            self._sel_thread = worker
            self._sel_thread_epoch = epoch
            worker.start()
            return worker

    # --- prompt building ----------------------------------------------------
    def _state_line(self, state):
        parts = ["scene=%s" % self.core.get("scene", "")]
        for k, v in (state or {}).items():
            if k == "events":
                continue
            parts.append("%s=%s" % (k, str(v).lower() if isinstance(v, bool) else v))
        return "[STATE " + " ".join(parts) + "]"

    def _working_text(self):
        """Most recent lines fitting the working budget. Older lines (and
        an oversize line, whole) go to episodes_raw/ first; older lines
        then leave the active list so it stays bounded."""
        budget = LAYER_BUDGETS["working"]
        header = "WORKING"
        formatted = ["%s: %s" % (l["who"], l["text"]) for l in self.lines]
        shown, used, cut = [], tokens(header) + 1, None
        for i in range(len(formatted) - 1, -1, -1):
            cost = tokens(formatted[i]) + 1
            if used + cost <= budget:
                shown.append(formatted[i])
                used += cost
            elif not shown:
                cut = i  # one oversize line: shown truncated, archived whole
                shown.append(formatted[i])
                break
            else:
                break
        shown.reverse()
        n_hidden = len(self.lines) - len(shown)
        if not n_hidden and cut is None:
            return header + ("\n" + "\n".join(shown) if shown else "")
        self._archive_working(self.lines[:n_hidden] +
                              ([self.lines[cut]] if cut is not None else []))
        self._archived_count += n_hidden
        del self.lines[:n_hidden]
        n_note = self._archived_count or len(self.lines)
        note = "WORKING [%d earlier lines archived to episodes_raw]" % n_note
        room = max(0, int((budget - tokens(note) - 1) * 3.5))
        body = "\n".join(shown)[:room]
        return note + ("\n" + body if body else "")

    def _sections(self, state, dec_extra, ep_mode, ev_list,
                  fact_list, tail_mode="full"):
        core = self.core
        hops = self.decisions[-2:] if self.decisions else []
        core_text = ("CORE desire: %s | anxiety: %s | scene: %s | objects: %s"
                     " | bridge: %s" % (core["desire"], core["anxiety"],
                                         core["scene"], ", ".join(core["objects"]),
                                         core["bridge"]))
        if hops:
            core_text += " | last: " + "; ".join(
                "%s->%s" % (h.get("bridge"), h.get("destination")) for h in hops)
        work_text = self._working_text()
        if ep_mode == "oldest_firstline" and self.episodes:
            ep_body = ["%s: %s" % (self.episodes[0].get("id"),
                                   _first_line(self.episodes[0].get("text", "")))]
            ep_body += ["%s: %s" % (e.get("id"), e.get("text"))
                        for e in self.episodes[1:]]
        else:
            ep_body = ["%s: %s" % (e.get("id"), e.get("text")) for e in self.episodes]
        ep_text = "EPISODES\n" + "\n".join(ep_body)
        fact_text = self._fact_layer_text(fact_list)
        if self.decisions:
            cur = self.decisions[-1]
            dec_text = "DECISIONS current: %s->%s (%s)" % (
                cur.get("bridge"), cur.get("destination"), cur.get("why"))
            past = self.decisions[:-1]
            n_old = self._decisions_dropped
            if dec_extra == "counter":
                if past or n_old:
                    dec_text += " | plus %d earlier transitions" % (len(past) + n_old)
            else:
                show = past[-dec_extra:] if isinstance(dec_extra, int) else past
                for p in show:
                    dec_text += " | %s->%s" % (p.get("bridge"), p.get("destination"))
                if len(past) - len(show) + n_old > 0:
                    dec_text += " | plus %d earlier transitions" % (
                        len(past) - len(show) + n_old)
        else:
            dec_text = "DECISIONS none yet"
        state_line = self._state_line(state)
        if tail_mode == "summary":
            latest = _one_line(ev_list[-1], 80) if ev_list else ""
            tail_text = ("%s\nTAIL summary: %d events, latest: %s"
                         % (state_line, len(ev_list), latest))
        else:
            tail_text = state_line + "\nTAIL\n" + "\n".join(ev_list)
        return {"core": core_text, "working": work_text, "episodes": ep_text,
                "facts": fact_text, "decisions": dec_text, "tail": tail_text}

    def _finalize(self, secs):
        # No silent truncation here: layers are already within budget
        # (working by construction, facts by selection) or build_prompt
        # has raised BudgetError. Core is never trimmed.
        order = ("core", "working", "episodes", "facts", "decisions", "tail")
        text = "\n\n".join(secs[k] for k in order)
        sizes = {k: tokens(v) for k, v in secs.items()}
        sizes["state"] = sizes["tail"]
        sizes["total"] = tokens(text)
        return text, sizes

    @synchronized
    def build_prompt(self, state=None):
        """Synchronous prompt build; never calls an LLM. Returns (text, sizes).

        budget_trim order (spec section 7), and only these steps:
        tail -> one-line summary, old decisions -> counter, oldest
        episode -> its first line. Core is never trimmed. If the prompt
        still exceeds a layer budget or HARD_CAP after those steps,
        BudgetError is raised (caller maps it to director_fail("budget"))
        instead of silently dropping facts, episodes, events or lines.
        Working lines beyond their layer budget leave to episodes_raw/
        as part of normal layer forgetting, before any trim step.
        Fact selection via Spark runs only in select_facts_background(),
        cached once per scene; here only the cached/default set is used.
        """
        state = state or {}
        extra = [_ev_text(e) for e in state.get("events", [])]
        ev_all = list(self.events) + extra
        facts = self._facts_for_prompt()
        dec_extra, ep_mode, tail_mode = 4, "full", "full"
        for stage in range(4):
            secs = self._sections(state, dec_extra, ep_mode,
                                  ev_all, facts, tail_mode)
            if tokens(secs["core"]) > LAYER_BUDGETS["core"]:
                raise BudgetError(
                    'director_fail("budget"): core exceeds %d tokens '
                    'and is never trimmed' % LAYER_BUDGETS["core"])
            total = tokens("\n\n".join(secs.values()))
            # Facts count as serialized; if this scene's fresh facts alone
            # overflow FACT_BUDGET, no trim step helps and BudgetError follows.
            over_layer = any(tokens(v) > LAYER_BUDGETS[k]
                             for k, v in secs.items())
            layer_sum = sum(tokens(secs[k]) for k in
                            ("core", "working", "episodes", "facts", "decisions"))
            if total <= HARD_CAP and not over_layer and layer_sum <= LAYER_BUDGET:
                return self._finalize(secs)
            if stage == 0:
                tail_mode = "summary"          # 1. tail -> one line
            elif stage == 1:
                dec_extra = "counter"          # 2. old decisions -> counter
            elif stage == 2:
                ep_mode = "oldest_firstline"   # 3. oldest ep -> first line
        raise BudgetError(
            'director_fail("budget"): prompt exceeds %d tokens after '
            'the prescribed trim steps' % HARD_CAP)
