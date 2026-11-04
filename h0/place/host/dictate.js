// Dictation inside a built place: hold Space (or press the mic) and say what should open here.
// Voice -> /asr (Meta ASR) -> /wish -> the engine builds it; the bar shows the real progress of that build
// (progress.jsonl of the job); when the dist is ready it is sewn into the running world (__dreamer.attach).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
while (!window.__dreamer) await wait(100);
const D = window.__dreamer;
await D.ready;
const { THREE, scene, camera, renderer } = D.three;

// ---------- HUD ----------
const css = document.createElement("style");
css.textContent = `
#dz{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;
 font:15px "Helvetica Neue",system-ui,sans-serif;color:#fff;z-index:5;pointer-events:none}
#dz .mic{pointer-events:auto;display:flex;align-items:center;gap:10px;padding:10px 18px;border-radius:30px;background:rgba(20,20,22,.62);
 backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.18);cursor:pointer;user-select:none}
#dz .mic.on{background:rgba(190,30,40,.75)}
#dz .dot{width:12px;height:12px;border-radius:50%;background:#ff5a5f;box-shadow:0 0 0 0 rgba(255,90,95,.6)}
#dz .mic.on .dot{animation:pulse 1s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(255,255,255,.7)}100%{box-shadow:0 0 0 14px rgba(255,255,255,0)}}
#dz .wave{display:flex;gap:2px;align-items:center;height:22px}
#dz .wave i{display:block;width:3px;background:#fff;border-radius:2px;height:3px;transition:height .06s}
#dz .said{max-width:760px;text-align:center;font-size:20px;text-shadow:0 1px 8px #000;min-height:24px}
#dz .said small{display:block;font-size:12px;opacity:.7;margin-top:4px}
#bar{position:fixed;left:50%;top:18px;transform:translateX(-50%);width:440px;padding:10px 14px;border-radius:12px;background:rgba(20,20,22,.6);
 backdrop-filter:blur(8px);color:#fff;font:13px "Helvetica Neue",system-ui;display:none;z-index:5}
#bar .row{display:flex;justify-content:space-between;align-items:baseline}#bar b{font-size:26px;font-weight:300}
#bar .track{height:4px;background:rgba(255,255,255,.2);border-radius:2px;margin-top:8px}#bar .fill{height:4px;background:#ffd166;border-radius:2px;width:0}
`;
document.head.appendChild(css);
const dz = document.createElement("div");
dz.id = "dz";
dz.innerHTML = `<div class="said"></div><div class="mic"><span class="dot"></span><span class="lbl">Hold <b>Space</b> and say what should open here</span><span class="wave"></span></div>`;
document.body.appendChild(dz);
const bar = document.createElement("div");
bar.id = "bar";
bar.innerHTML = `<div class="row"><span class="ttl">Building</span><b class="pct">0%</b></div><div class="row"><span class="st"></span><span class="eta"></span></div><div class="track"><div class="fill"></div></div>`;
document.body.appendChild(bar);
const mic = dz.querySelector(".mic"), said = dz.querySelector(".said"), waveEl = dz.querySelector(".wave");
for (let i = 0; i < 18; i++) waveEl.appendChild(document.createElement("i"));
const sayText = (main, small = "") => { said.textContent = main; if (small) { const e = document.createElement("small"); e.textContent = small; said.appendChild(e); } };
const STAGE = { wish: "Reading the wish", shell_assets: "Painting the front, making the objects", shell_build: "Engine build", done: "Ready", failed: "Failed", queued: "Queued" };

// ---------- recording: 16 kHz mono s16 WAV ----------
let rec = null;
async function startRec() {
  if (rec) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ac = new AudioContext();
  const src = ac.createMediaStreamSource(stream);
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const an = ac.createAnalyser(); an.fftSize = 64;
  const chunks = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(an); src.connect(proc); proc.connect(ac.destination);
  rec = { stream, ac, proc, chunks, an, t0: performance.now() };
  mic.classList.add("on"); mic.querySelector(".lbl").textContent = "Listening…"; said.textContent = "";
  const bins = new Uint8Array(an.frequencyBinCount);
  const draw = () => { if (!rec) { [...waveEl.children].forEach((b) => (b.style.height = "3px")); return; }
    an.getByteFrequencyData(bins); [...waveEl.children].forEach((b, i) => (b.style.height = 3 + (bins[i + 1] / 255) * 19 + "px")); requestAnimationFrame(draw); };
  draw();
}
function wavOf(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0), all = new Float32Array(n);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const k = rate / 16000, m = Math.floor(n / k), pcm = new Int16Array(m);
  for (let i = 0; i < m; i++) { let s = 0, a = Math.floor(i * k), b = Math.min(n, Math.floor((i + 1) * k)); for (let j = a; j < b; j++) s += all[j]; s /= Math.max(1, b - a); pcm[i] = Math.max(-1, Math.min(1, s)) * 32767; }
  const buf = new ArrayBuffer(44 + m * 2), v = new DataView(buf), w = (p, s) => [...s].forEach((c, i) => v.setUint8(p + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + m * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, m * 2, true);
  new Int16Array(buf, 44).set(pcm); return new Blob([buf], { type: "audio/wav" });
}
async function stopRec() {
  if (!rec) return;
  const r = rec; rec = null;
  r.proc.disconnect(); r.stream.getTracks().forEach((t) => t.stop());
  const wav = wavOf(r.chunks, r.ac.sampleRate); r.ac.close();
  mic.classList.remove("on"); mic.querySelector(".lbl").innerHTML = "Hold <b>Space</b> and say what should open here";
  if (performance.now() - r.t0 < 500) return;
  sayText("…", "Meta ASR");
  const res = await fetch("/asr", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav }).then((x) => x.json());
  if (!res.text) { sayText("Didn't catch that", res.error ?? ""); return; }
  sayText(`“${res.text}”`, `Meta ASR · ${res.s}s`);
  wish(res.text);
}
addEventListener("keydown", (e) => { if (e.code === "Space" && !e.repeat && document.activeElement?.tagName !== "INPUT") { e.preventDefault(); startRec(); } });
addEventListener("keyup", (e) => { if (e.code === "Space") { e.preventDefault(); stopRec(); } });
mic.addEventListener("click", () => (rec ? stopRec() : startRec()));
window.__wish = (t) => wish(t);   // typed wish for tests: __wish("a small bakery")

// ---------- the site: footprint, ghost frame, a plate with the real percent ----------
const lineM = (op) => new THREE.LineBasicMaterial({ color: 0xfff6e0, transparent: true, opacity: op, depthWrite: false, fog: false });
function site(box) {
  const g = new THREE.Group();
  const { x0, x1, z0, z1, y0, h } = box, W = x1 - x0, Dp = z1 - z0;
  const fp = [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]].map(([x, z]) => new THREE.Vector3(x, y0 + 0.03, z));
  const foot = new THREE.Line(new THREE.BufferGeometry().setFromPoints(fp), lineM(0.95)); g.add(foot);
  const bx = new THREE.BoxGeometry(W, h, Dp); bx.translate((x0 + x1) / 2, y0 + h / 2, (z0 + z1) / 2);
  const ghost = new THREE.LineSegments(new THREE.EdgesGeometry(bx), lineM(0.0)); g.add(ghost);
  const fill = new THREE.Mesh(bx, new THREE.MeshBasicMaterial({ color: 0xfff1cf, transparent: true, opacity: 0.0, depthWrite: false, fog: false }));
  g.add(fill);
  const cv = document.createElement("canvas"); cv.width = 1024; cv.height = 300;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.94), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false }));
  plate.renderOrder = 999; plate.position.set((x0 + x1) / 2, y0 + h + 1.0, (z0 + z1) / 2); g.add(plate);
  const motes = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xfffaf0, size: 0.05, transparent: true, opacity: 0.85, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
  const MP = new Float32Array(240 * 3); motes.geometry.setAttribute("position", new THREE.BufferAttribute(MP, 3)); g.add(motes);
  scene.add(g);
  const draw = (pct, stage, eta, label) => {
    const c = cv.getContext("2d"); c.clearRect(0, 0, 1024, 300);
    c.fillStyle = "rgba(18,18,20,.72)"; c.beginPath(); c.roundRect(0, 0, 1024, 300, 34); c.fill();
    c.fillStyle = "rgba(255,255,255,.65)"; c.font = "600 40px Helvetica Neue, system-ui"; c.fillText(("BUILDING · " + (label || "")).toUpperCase().slice(0, 40), 44, 70);
    c.fillStyle = "#fff"; c.font = "300 64px Helvetica Neue, system-ui"; c.fillText(STAGE[stage] ?? stage ?? "", 44, 160);
    c.textAlign = "right"; c.font = "200 110px Helvetica Neue, system-ui"; c.fillText(Math.floor(pct) + "%", 990, 175); c.textAlign = "left";
    c.fillStyle = "rgba(255,255,255,.55)"; c.font = "400 34px Helvetica Neue, system-ui"; c.fillText(eta > 0 ? `about ${eta} s left` : "", 44, 225);
    c.fillStyle = "rgba(255,255,255,.2)"; c.fillRect(44, 252, 936, 8); c.fillStyle = "#ffd166"; c.fillRect(44, 250, 936 * pct / 100, 12);
    tex.needsUpdate = true;
  };
  let p = 0, life = 0;
  const tick = (dt) => {
    life += dt;
    plate.lookAt(camera.position);
    ghost.material.opacity = Math.min(0.75, life * 0.6);
    fill.material.opacity = 0.05 + 0.04 * Math.sin(life * 3);
    for (let i = 0; i < 240; i++) {
      let y = MP[i * 3 + 1] + dt * (0.4 + (i % 7) * 0.08);
      if (y > y0 + h * (0.25 + p / 100) || MP[i * 3 + 1] === 0) {
        const side = i % 4, t = Math.random();
        MP[i * 3] = side < 2 ? x0 + t * W : side === 2 ? x0 : x1; MP[i * 3 + 2] = side === 0 ? z0 : side === 1 ? z1 : z0 + t * Dp; y = y0 + Math.random() * 0.3;
      }
      MP[i * 3 + 1] = y;
    }
    motes.geometry.attributes.position.needsUpdate = true;
  };
  return { g, draw, tick, set: (v) => (p = v), remove: () => scene.remove(g) };
}

// reveal: the attached part is printed upward behind a cut plane
function reveal(objs, box) {
  renderer.localClippingEnabled = true;
  const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), box.y0);
  const mats = [];
  for (const o of objs) o.traverse((m) => { if (m.material) for (const mt of [].concat(m.material)) { mt.clippingPlanes = [plane]; mats.push(mt); } });
  let t = 0;
  return (dt) => { t += dt; plane.constant = box.y0 + (box.h + 1.5) * Math.min(1, t / 2.2); if (t > 2.3) { mats.forEach((m) => (m.clippingPlanes = null)); return true; } return false; };
}

// ---------- a wish: start the build, follow its real progress, attach ----------
let ticks = [];
D.onFrame((dt) => { ticks = ticks.filter((f) => !f(dt)); });
async function wish(text) {
  const { id, error } = await fetch("/wish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }).then((x) => x.json());
  if (!id) { sayText("Could not start", String(error)); return; }
  bar.style.display = "block";
  let s = null, last = null;
  for (;;) {
    const j = await fetch("/part/" + id).then((x) => x.json());
    const pr = j.progress ?? {};
    last = pr;
    if (j.box && !s) { s = site(j.box); ticks.push((dt) => { s.tick(dt); return false; }); }
    const pct = pr.pct ?? 0;
    bar.querySelector(".ttl").textContent = "Building · " + (pr.label ?? text);
    bar.querySelector(".pct").textContent = Math.floor(pct) + "%";
    bar.querySelector(".st").textContent = STAGE[pr.stage] ?? pr.stage ?? "";
    bar.querySelector(".eta").textContent = pr.eta_s > 0 ? `≈ ${pr.eta_s} s left` : "";
    bar.querySelector(".fill").style.width = pct + "%";
    if (s) { s.set(pct); s.draw(pct, pr.stage, pr.eta_s, pr.label); }
    if (j.failed) { bar.querySelector(".st").textContent = "Failed: " + (pr.note ?? ""); return; }
    if (j.ready) {
      const before = new Set(D.three.scene.children.flatMap((c) => c.children));
      await D.attach(`/parts/${id}/dist`);
      const fresh = D.three.scene.children.flatMap((c) => c.children).filter((c) => !before.has(c));
      const box = j.box;
      if (s) s.remove();
      const step = reveal(fresh, box);
      ticks.push(step);
      bar.querySelector(".st").textContent = `Ready in ${Math.round(pr.t)} s: walk in`;
      setTimeout(() => (bar.style.display = "none"), 6000);
      return;
    }
    await wait(400);
  }
}
