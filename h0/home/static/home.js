// Dreamer Home: the shelf of ready scenes (Book / Freestyle), the scene frame, and Create.
// Talks only to Home's own API; never sends a path, only ids from /api/scenes.

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k);
  return e;
};
const debug = new URLSearchParams(location.search).has("debug");

const NOTES = {
  book: "The scene plays the way the book tells it. Press G any time to let it run free.",
  freestyle: "The book is only the start: the director and the characters improvise. Press Tab to whisper them an idea.",
  create: "Write what happens next. Muse Spark turns it into a chapter, and Dreamer stages it in one of our worlds.",
};
const ACT = {
  book: { label: "Read it", opening: "Opening the book…" },
  freestyle: { label: "Improvise", opening: "Waking the characters…" },
};
const STAGE_NAMES = {
  chapter: "Writing the chapter with Muse Spark",
  brief: "Reading the chapter",
  refs: "Gathering pictures",
  world: "Opening the world",
  cast: "Bringing in the cast",
  story: "Directing the scene",
  stage: "Placing the actors",
  shotplan: "Planning the camera",
};

let data = { scenes: [], worlds: [], mine: [] };
let tab = "book";
let chosenWorld = null;

// ---------- API ----------
async function api(path, body, type = "application/json") {
  const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": type }, body: type === "application/json" ? JSON.stringify(body) : body };
  const r = await fetch(path, opt);
  let j = {};
  try { j = await r.json(); } catch { j = { error: `HTTP ${r.status}` }; }
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { log: j.log || [], status: r.status });
  return j;
}

function toast(msg, log = []) {
  const t = $("#toast");
  t.replaceChildren(el("div", {}, msg), log.length ? el("pre", {}, log.join("\n")) : null);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 9000);
}

// ---------- shelf ----------
function card(s, mode, extra = []) {
  if (s.kind === "link") return linkCard(s, () => window.open(s.url, '_blank', 'noopener'));
  const act = s.kind === "place" ? { label: "Walk in", opening: "Opening the yard…" } : ACT[mode];
  const go = () => play(s.id, mode, act.opening);
  const cover = el("button", { class: "cover", type: "button", "aria-label": `${act.label}: ${s.title}`, onclick: go },
    s.cover_url ? el("img", { src: s.cover_url, alt: "", loading: "lazy" }) : el("div", { class: "plain" }, s.title),
    s.minutes ? el("span", { class: "len" }, `${s.minutes} min`) : null);
  return el("article", { class: "scene", "data-id": s.id, "data-mode": mode },
    cover,
    el("h3", {}, s.title),
    s.subtitle ? el("p", { class: "sub" }, s.subtitle) : null,
    s.blurb ? el("p", { class: "blurb" }, s.blurb) : null,
    el("div", { class: "acts" }, el("button", { class: "primary", type: "button", onclick: go }, act.label), extra));
}

// a live shared world on Modal: opens in its own tab, never through /api/play
function linkCard(s, go) {
  const cover = el("button", { class: "cover", type: "button", "aria-label": `Open the live world: ${s.title}`, onclick: go },
    s.cover_url ? el("img", { src: s.cover_url, alt: "", loading: "lazy" }) : el("div", { class: "plain" }, s.title),
    el("span", { class: "len live" }, "live · shared world"));
  return el("article", { class: "scene star", "data-id": s.id, "data-mode": "link" },
    cover,
    el("h3", {}, s.title),
    s.subtitle ? el("p", { class: "sub" }, s.subtitle) : null,
    s.blurb ? el("p", { class: "blurb" }, s.blurb) : null,
    el("div", { class: "acts" }, el("button", { class: "primary", type: "button", onclick: go }, "Open the live world")));
}

function renderShelf() {
  const shelf = $("#shelf");
  const list = data.scenes.filter((s) => (s.ready || debug) && (s.kind === "link" || s.modes.includes(tab)));
  shelf.replaceChildren(...list.map((s) => card(s, tab)));
  if (!list.length) shelf.append(el("p", { class: "empty" }, "No scenes here yet."));
}

function renderMine() {
  const box = $("#mine");
  const list = data.mine || [];
  box.replaceChildren(...list.map((m) => {
    const sub = { ...m, subtitle: worldTitle(m.world), blurb: m.prompt };
    return card(sub, m.modes.includes("book") ? "book" : "freestyle",
      m.modes.includes("book") && m.modes.includes("freestyle")
        ? [el("button", { class: "secondary", type: "button", onclick: () => play(m.id, "freestyle", ACT.freestyle.opening) }, ACT.freestyle.label)]
        : []);
  }));
  if (!list.length) box.append(el("p", { class: "empty" }, "Nothing yet. The scenes you write appear here, ready to read or improvise."));
}

const worldTitle = (id) => (data.worlds.find((w) => w.id === id) || {}).title || "";

function renderWorlds() {
  const box = $("#worlds");
  if (!chosenWorld && data.worlds.length) chosenWorld = data.worlds[0].id;
  box.replaceChildren(...data.worlds.map((w) => el("button", {
    class: "world", type: "button", "aria-pressed": String(w.id === chosenWorld), "data-world": w.id,
    onclick: () => { chosenWorld = w.id; renderWorlds(); updateBuild(); },
  }, w.cover_url ? el("img", { src: w.cover_url, alt: "" }) : null, el("b", {}, w.title), el("span", {}, w.who.join(" and ")))));
  const yard = data.scenes.find((s) => s.kind === "place" && s.ready);
  const hint = $("#yard-hint");
  hint.replaceChildren();
  if (yard) {
    hint.append("Or grow a real place by voice: ",
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); play(yard.id, "freestyle", "Opening the yard…"); } }, `walk into ${yard.title}`),
      " and say what should open there.");
  }
  // create switched off in scenes.json: no world picker, no form; the yard and Your scenes stay
  $("#worlds").hidden = $("#write-col").hidden = !data.create;
  $("#world-col h2").textContent = data.create ? "Pick a world" : "Writing new chapters is switched off here";
}

function setTab(t) {
  tab = ["book", "freestyle", "create"].includes(t) ? t : "book";
  for (const a of document.querySelectorAll(".tabs a")) a.setAttribute("aria-selected", String(a.dataset.tab === tab));
  $("#mode-note").replaceChildren(...noteParts(tab));
  $("#shelf").hidden = tab === "create";
  $("#create").hidden = tab !== "create";
  if (tab === "create") { renderWorlds(); renderMine(); } else renderShelf();
}
function noteParts(t) {
  // the key names in the note as <kbd>, the rest as text
  const parts = NOTES[t].split(/\b(G|Tab)\b(?= )/);
  return parts.map((p, i) => (i % 2 ? el("kbd", {}, p) : p));
}

async function load() {
  data = await api("/api/scenes");
  setTab(location.hash.slice(1) || "book");
  if (data.building) watchBuild(data.building);
}

// ---------- inside a scene ----------
let watch = null;
async function play(id, mode, opening) {
  $("#opening-text").textContent = opening || "Opening…";
  $("#opening").hidden = false;
  try {
    const r = await api("/api/play", { id, mode });
    $("#frame").src = r.url;
    $("#newtab").href = r.url;
    $("#dead").hidden = true;
    $("#stage").hidden = false;
    $("#home").hidden = true;
    clearInterval(watch);
    watch = setInterval(checkScene, 3000);
  } catch (e) {
    toast(`Could not open the scene: ${e.message}`, e.log);
  } finally {
    $("#opening").hidden = true;
  }
}
async function checkScene() {
  try {
    const s = await api("/api/session");
    if (!s.alive) {
      clearInterval(watch);
      $("#dead-log").textContent = (s.log || []).join("\n");
      $("#dead").hidden = false;
    }
  } catch { /* Home itself is gone; leave the frame as it is */ }
}
async function backHome() {
  clearInterval(watch);
  $("#frame").src = "about:blank";
  $("#stage").hidden = true;
  $("#home").hidden = false;
  try { await api("/api/stop", {}); } catch { /* nothing to stop */ }
  load();
}

// ---------- create ----------
const idea = $("#idea");
function updateBuild() {
  const n = idea.value.trim().length;
  $("#count").textContent = `${idea.value.length} / 600`;
  $("#build").disabled = n < 8 || !chosenWorld || building;
  $("#build-hint").textContent = building ? "" : n < 8 ? "Write a sentence or two first." : "";
}
idea.addEventListener("input", updateBuild);

let building = null;
$("#build").addEventListener("click", async () => {
  try {
    const r = await api("/api/create", { world: chosenWorld, prompt: idea.value });
    watchBuild(r.run_id);
  } catch (e) {
    msg(e.message, true);
  }
});
function msg(t, err = false) {
  const m = $("#build-msg");
  m.textContent = t;
  m.classList.toggle("err", err);
}
function watchBuild(runId) {
  building = runId;
  updateBuild();
  $("#stages").hidden = false;
  const tick = async () => {
    let st;
    try { st = await api(`/api/create/${runId}`); } catch (e) { msg(e.message, true); building = null; updateBuild(); return; }
    renderStages(st);
    if (st.status === "running") {
      msg(`Building “${st.title || st.prompt}”… ${fmt(st.seconds)}`);
      setTimeout(tick, 2000);
      return;
    }
    building = null;
    updateBuild();
    if (st.status === "ok") {
      msg(`Ready in ${fmt(st.seconds)}: “${st.title}”. It is in Your scenes below.`);
      data = await api("/api/scenes");
      renderMine();
    } else {
      msg(`The build stopped: ${st.error || "unknown reason"}`, true);
    }
  };
  tick();
}
const fmt = (s) => (s == null ? "" : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);
function renderStages(st) {
  const ICON = { ok: "✓", running: "●", failed: "✕", waiting: "·" };
  $("#stages").replaceChildren(...st.stages.map((s) => el("li", { class: s.status, "data-stage": s.name },
    el("span", { class: "ic" }, ICON[s.status] || "·"),
    el("span", {}, STAGE_NAMES[s.name] || s.name, s.error ? el("small", {}, ` — ${s.error}`) : null),
    el("span", { class: "t" }, s.seconds != null ? fmt(s.seconds) : ""))));
}

// ---------- voice: hold to talk -> 16 kHz mono s16 WAV -> Meta ASR (same encoder as place/host/dictate.js) ----------
let rec = null;
let held = false;          // the button is down; a release during the permission prompt cancels the start
const mic = $("#mic");
async function startRec() {
  if (rec || held) return;
  held = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    held = false;
    $("#mic-note").textContent = "The microphone is blocked. Allow it for this page, or type instead.";
    return;
  }
  if (!held) { stream.getTracks().forEach((t) => t.stop()); return; }
  const ac = new AudioContext();
  const src = ac.createMediaStreamSource(stream);
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(ac.destination);
  rec = { stream, ac, proc, chunks, t0: performance.now() };
  mic.setAttribute("aria-pressed", "true");
  mic.querySelector(".mic-label").textContent = "Listening…";
}
function wavOf(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0), all = new Float32Array(n);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const k = rate / 16000, m = Math.floor(n / k), pcm = new Int16Array(m);
  for (let i = 0; i < m; i++) {
    let s = 0; const a = Math.floor(i * k), b = Math.min(n, Math.floor((i + 1) * k));
    for (let j = a; j < b; j++) s += all[j];
    s /= Math.max(1, b - a); pcm[i] = Math.max(-1, Math.min(1, s)) * 32767;
  }
  const buf = new ArrayBuffer(44 + m * 2), v = new DataView(buf), w = (p, s) => [...s].forEach((c, i) => v.setUint8(p + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + m * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, m * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}
async function stopRec() {
  held = false;
  if (!rec) return;
  const r = rec; rec = null;
  r.proc.disconnect(); r.stream.getTracks().forEach((t) => t.stop());
  const wav = wavOf(r.chunks, r.ac.sampleRate); r.ac.close();
  mic.setAttribute("aria-pressed", "false");
  mic.querySelector(".mic-label").textContent = "Hold to talk";
  if (performance.now() - r.t0 < 500) return;
  $("#mic-note").textContent = "Listening with Meta ASR…";
  try {
    const res = await api("/api/asr", wav, "audio/wav");
    if (!res.text) { $("#mic-note").textContent = "Didn't catch that. Try again, or type."; return; }
    idea.value = (idea.value.trim() + " " + res.text).trim().slice(0, 600);
    $("#mic-note").textContent = `Heard by Meta ASR in ${res.s} s.`;
    updateBuild();
  } catch (e) {
    $("#mic-note").textContent = `Voice failed (${e.message}). Type instead.`;
  }
}
mic.addEventListener("pointerdown", (e) => { e.preventDefault(); startRec(); });
mic.addEventListener("pointerup", stopRec);
mic.addEventListener("pointerleave", stopRec);
mic.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); startRec(); } });
mic.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") stopRec(); });

// ---------- wiring ----------
addEventListener("hashchange", () => setTab(location.hash.slice(1)));
$("#back").addEventListener("click", backHome);
$("#dead-back").addEventListener("click", backHome);
window.__home = { play, backHome, startRec, stopRec };   // e2e hooks
load().catch((e) => toast(`Home did not load: ${e.message}`));
