import { FFmpeg } from "../vendor/ffmpeg/index.js";

// نسختين من المحرك: متعددة الأنوية (أسرع 2-4 مرات في الضغط) تحتاج crossOriginIsolated،
// والعادية تشتغل في كل مكان. "bytes" الحجم الحقيقي لملف wasm، لحساب نسبة التحميل
const vendorURL = (path) => new URL(`../vendor/${path}`, import.meta.url).href;
const ENGINES = {
  mt: {
    coreURL: vendorURL("core-mt/ffmpeg-core.js"),
    wasmURL: vendorURL("core-mt/ffmpeg-core.wasm"),
    workerURL: vendorURL("core-mt/ffmpeg-core.worker.js"),
    bytes: 32718323,
  },
  st: {
    coreURL: vendorURL("core/ffmpeg-core.js"),
    wasmURL: vendorURL("core/ffmpeg-core.wasm"),
    bytes: 32232419,
  },
};
const CAN_MT = self.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
const CORES = navigator.hardwareConcurrency || 2;
const MIN_LEN = 0.1;
// MEMFS داخل المتصفح ما يتحمل ملف ناتج أكبر من هذا تقريبًا
const MAX_OUTPUT_BYTES = 1.8 * 1024 ** 3;
const MAX_PARTS = 100;

// "short" = طول الضلع الأقصر بالبكسل، عشان الفيديو العمودي ما يصغر زيادة
const QUALITY = {
  original: null,
  high: { short: 1080, crf: 20 },
  medium: { short: 720, crf: 24 },
  low: { short: 480, crf: 28 },
};

const COPY_EXTS = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "3gp", "flv", "mpg", "mpeg", "wmv", "ogv"];
const MIME = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
  webm: "video/webm", avi: "video/x-msvideo", ts: "video/mp2t", "3gp": "video/3gpp",
  ogv: "video/ogg", wmv: "video/x-ms-wmv", flv: "video/x-flv", mpg: "video/mpeg", mpeg: "video/mpeg",
};

const $ = (id) => document.getElementById(id);
const els = {
  landing: $("landing"), editor: $("editor"), dropzone: $("dropzone"), fileInput: $("fileInput"),
  fileName: $("fileName"), fileMeta: $("fileMeta"), changeBtn: $("changeBtn"),
  video: $("video"), noPreview: $("noPreview"),
  timeline: $("timeline"), thumbs: $("thumbs"), sel: $("sel"), shadeL: $("shadeL"), shadeR: $("shadeR"),
  hStart: $("hStart"), hEnd: $("hEnd"), playhead: $("playhead"), tipStart: $("tipStart"), tipEnd: $("tipEnd"),
  startIn: $("startIn"), endIn: $("endIn"), setStartBtn: $("setStartBtn"), setEndBtn: $("setEndBtn"),
  selDur: $("selDur"), playSelBtn: $("playSelBtn"),
  engine: $("engine"), engineText: $("engineText"),
  tabTrim: $("tab-trim"), tabSplit: $("tab-split"), encodeHint: $("encodeHint"),
  splitValue: $("splitValue"), splitMinus: $("splitMinus"), splitPlus: $("splitPlus"),
  splitUnit: $("splitUnit"), splitInfo: $("splitInfo"),
  muteIn: $("muteIn"), exportBtn: $("exportBtn"), exportLabel: $("exportLabel"),
  progress: $("progress"), progressText: $("progressText"), progressPct: $("progressPct"),
  progressBar: $("progressBar"), cancelBtn: $("cancelBtn"), results: $("results"),
  installBtn: $("installBtn"), themeBtn: $("themeBtn"), dropOverlay: $("dropOverlay"), toast: $("toast"),
};

const state = {
  file: null, url: null, duration: 0, start: 0, end: 0,
  mode: "trim", quality: "original", splitBy: "count", splitValue: 2,
  busy: false, runId: 0, playingSel: false, resultUrls: [],
};

/* ============ أدوات ============ */

function fmt(t) {
  if (!Number.isFinite(t)) t = 0;
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function parseTimeInput(str) {
  const clean = String(str).trim().replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[٫,]/g, ".");
  if (!/^[\d:.]+$/.test(clean)) return NaN;
  return clean.split(":").reduce((acc, p) => acc * 60 + Number(p || 0), 0);
}

// يعزل النص اللاتيني عشان ما ينقلب داخل الجمل العربية (مثل "MB 7.8")
const ltr = (s) => `⁦${s}⁩`;

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return ltr(`${(bytes / 1024).toFixed(0)} KB`);
  if (bytes < 1024 ** 3) return ltr(`${(bytes / 1024 / 1024).toFixed(1)} MB`);
  return ltr(`${(bytes / 1024 ** 3).toFixed(2)} GB`);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fileExt = (name) => (name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
const baseName = (name) => name.replace(/\.[^.]+$/, "") || "video";

let toastTimer;
function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("error", isError);
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), isError ? 6000 : 3000);
}

/* ============ محرك FFmpeg ============ */

let ffmpeg = null;
let engineKind = null;
let enginePromise = null;
let inputPath = null;
let inputFile = null;
let logHandler = null;
let lastLogAt = 0;
const recentLogs = [];
const HANG_MS = 30000;

// ffmpeg يطبع سطر تقدم كل نص ثانية تقريبًا. لو سكت 30 ثانية فهو معلّق، فنوقفه
async function execWatched(ff, args) {
  lastLogAt = performance.now();
  const timer = setInterval(() => {
    if (performance.now() - lastLogAt > HANG_MS) {
      clearInterval(timer);
      console.warn("ffmpeg stalled, terminating");
      resetEngine();
    }
  }, 2000);
  try {
    return await ff.exec(args);
  } finally {
    clearInterval(timer);
  }
}

function setEngine(status, ratio) {
  els.engine.dataset.state = status;
  els.engineText.textContent = {
    idle: "المحرك ينتظر",
    loading: `جاري تجهيز المحرك${ratio != null ? ` ${Math.round(ratio * 100)}%` : ""} (مرة وحدة فقط)`,
    ready: engineKind === "mt" ? `المحرك جاهز · وضع سريع (${CORES} أنوية)` : "المحرك جاهز",
    error: "تعذر تحميل المحرك. تأكد من الإنترنت وحاول مرة ثانية",
  }[status];
}

async function fetchWithProgress(url, total, onProgress) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(received / total, 0.99));
  }
  return URL.createObjectURL(new Blob(chunks, { type: "application/wasm" }));
}

async function loadKind(kind) {
  const cfg = ENGINES[kind];
  const wasmURL = await fetchWithProgress(cfg.wasmURL, cfg.bytes, (p) => {
    setEngine("loading", p);
    if (state.busy && !ffmpeg) setProgress(p, "جاري تجهيز المحرك");
  });
  const ff = new FFmpeg();
  ff.on("log", ({ message }) => {
    lastLogAt = performance.now();
    recentLogs.push(message);
    if (recentLogs.length > 30) recentLogs.shift();
    logHandler?.(message);
  });
  try {
    await ff.load({ coreURL: cfg.coreURL, wasmURL, workerURL: cfg.workerURL });
  } catch (err) {
    ff.terminate();
    throw err;
  } finally {
    URL.revokeObjectURL(wasmURL);
  }
  return ff;
}

function loadEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    setEngine("loading", 0);
    let ff;
    if (CAN_MT && engineKind !== "st") {
      try {
        ff = await loadKind("mt");
        engineKind = "mt";
      } catch (err) {
        // الجوالات اللي ذاكرتها قليلة ما تقدر تحجز ذاكرة النسخة السريعة
        console.warn("multi-thread engine failed, falling back", err);
      }
    }
    if (!ff) {
      ff = await loadKind("st");
      engineKind = "st";
    }
    ffmpeg = ff;
    setEngine("ready");
    return ff;
  })().catch((err) => {
    enginePromise = null;
    setEngine("error");
    throw err;
  });
  return enginePromise;
}

// WORKERFS يقرأ الملف مباشرة بدون نسخه للذاكرة، فيدعم الفيديوهات الكبيرة
async function prepareInput(ff) {
  if (inputFile === state.file && inputPath) return inputPath;
  await releaseInput(ff);
  try {
    await ff.createDir("/in").catch(() => {});
    await ff.mount("WORKERFS", { files: [state.file] }, "/in");
    inputPath = `/in/${state.file.name}`;
  } catch {
    inputPath = `/input.${fileExt(state.file.name) || "mp4"}`;
    await ff.writeFile(inputPath, new Uint8Array(await state.file.arrayBuffer()));
  }
  inputFile = state.file;
  return inputPath;
}

async function releaseInput(ff) {
  if (!ff || !inputPath) return;
  if (inputPath.startsWith("/in/")) await ff.unmount("/in").catch(() => {});
  else await ff.deleteFile(inputPath).catch(() => {});
  inputPath = null;
  inputFile = null;
}

function resetEngine() {
  ffmpeg?.terminate();
  ffmpeg = null;
  enginePromise = null;
  inputPath = null;
  inputFile = null;
  setEngine("idle");
}

const LOG_TIME = /time=\s*(-?\d+):(\d+):(\d+(?:\.\d+)?)/;
const LOG_DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const hms = (m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);

async function probeDuration() {
  const ff = await loadEngine();
  const input = await prepareInput(ff);
  let dur = 0;
  logHandler = (msg) => {
    const m = msg.match(LOG_DURATION);
    if (m) dur = hms(m);
  };
  await ff.exec(["-hide_banner", "-i", input]);
  logHandler = null;
  return dur;
}

/* ============ تحميل الفيديو ============ */

async function openFile(file) {
  if (!file || state.busy) return;
  if (!file.type.startsWith("video/") && !COPY_EXTS.includes(fileExt(file.name))) {
    toast("هذا الملف مو فيديو. اختر ملف فيديو.", true);
    return;
  }
  if (state.url) URL.revokeObjectURL(state.url);
  clearResults();
  await releaseInput(ffmpeg);

  state.file = file;
  state.url = URL.createObjectURL(file);
  state.duration = state.start = state.end = 0;

  els.fileName.textContent = file.name;
  els.fileMeta.textContent = fmtSize(file.size);
  els.noPreview.hidden = true;
  els.thumbs.replaceChildren();
  els.landing.hidden = true;
  els.editor.hidden = false;
  els.video.src = state.url;
  renderRange();
  window.scrollTo({ top: 0 });

  loadEngine().catch(() => {}); // نجهز المحرك في الخلفية من الحين
}

function setDuration(d) {
  state.duration = d;
  state.start = 0;
  state.end = d;
  els.fileMeta.textContent = `${ltr(fmt(d))} · ${fmtSize(state.file.size)}`;
  renderRange();
}

els.video.addEventListener("loadedmetadata", async () => {
  const d = els.video.duration;
  if (Number.isFinite(d) && d > 0) {
    setDuration(d);
    buildThumbs(state.file);
  } else {
    await fallbackDuration();
  }
});

els.video.addEventListener("error", () => {
  if (!state.file || state.duration) return;
  els.noPreview.hidden = false;
  fallbackDuration();
});

async function fallbackDuration() {
  const file = state.file;
  els.fileMeta.textContent = `جاري قراءة الفيديو… · ${fmtSize(file.size)}`;
  try {
    const d = await probeDuration();
    if (state.file !== file) return;
    if (d > 0) setDuration(d);
    else toast("ما قدرنا نقرأ مدة الفيديو. يمكن الملف خربان.", true);
  } catch {
    toast("ما قدرنا نقرأ الفيديو. تأكد من الإنترنت وحاول مرة ثانية.", true);
  }
}

// صور مصغرة على الشريط الزمني
async function buildThumbs(file) {
  const width = els.timeline.clientWidth || 600;
  const count = clamp(Math.round(width / 70), 4, 14);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = state.url;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const seek = (t) => new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    v.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
    v.currentTime = t;
  });
  try {
    await new Promise((resolve, reject) => {
      v.addEventListener("loadeddata", resolve, { once: true });
      v.addEventListener("error", reject, { once: true });
    });
    const ratio = v.videoWidth / v.videoHeight || 16 / 9;
    canvas.height = 90;
    canvas.width = Math.round(90 * ratio);
    for (let i = 0; i < count; i++) {
      if (state.file !== file) return;
      await seek(((i + 0.5) / count) * state.duration);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const img = new Image();
      img.alt = "";
      img.src = canvas.toDataURL("image/jpeg", 0.6);
      els.thumbs.append(img);
    }
  } catch {
    // بعض الصيغ ما تنعرض في المتصفح، نكمل بدون صور
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

/* ============ الشريط الزمني ============ */

function renderRange() {
  const d = state.duration || 1;
  const l = (state.start / d) * 100;
  const r = (state.end / d) * 100;
  els.sel.style.left = `${l}%`;
  els.sel.style.width = `${r - l}%`;
  els.shadeL.style.width = `${l}%`;
  els.shadeR.style.width = `${100 - r}%`;
  els.hStart.style.left = `${l}%`;
  els.hEnd.style.left = `${r}%`;
  els.tipStart.textContent = fmt(state.start);
  els.tipEnd.textContent = fmt(state.end);
  for (const [h, v] of [[els.hStart, state.start], [els.hEnd, state.end]]) {
    h.setAttribute("aria-valuemin", "0");
    h.setAttribute("aria-valuemax", String(Math.round(d)));
    h.setAttribute("aria-valuenow", v.toFixed(1));
    h.setAttribute("aria-valuetext", fmt(v));
  }
  if (document.activeElement !== els.startIn) els.startIn.value = fmt(state.start);
  if (document.activeElement !== els.endIn) els.endIn.value = fmt(state.end);
  els.selDur.textContent = fmt(state.end - state.start);
  renderSplitInfo();
}

function setEdge(which, t) {
  if (!state.duration) return;
  if (which === "start") state.start = clamp(t, 0, state.end - MIN_LEN);
  else state.end = clamp(t, state.start + MIN_LEN, state.duration);
  renderRange();
}

function timeAt(clientX) {
  const rect = els.timeline.getBoundingClientRect();
  return clamp((clientX - rect.left) / rect.width, 0, 1) * state.duration;
}

function seekTo(t) {
  if (els.video.readyState === 0) return;
  els.video.currentTime = t;
}

function bindHandle(handle, which) {
  handle.addEventListener("pointerdown", (e) => {
    if (!state.duration) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("drag");
    els.video.pause();
    const move = (ev) => {
      setEdge(which, timeAt(ev.clientX));
      seekTo(which === "start" ? state.start : state.end);
    };
    const up = () => {
      handle.classList.remove("drag");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 1 : 0.1;
    const cur = which === "start" ? state.start : state.end;
    const map = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step };
    if (e.key in map) {
      e.preventDefault();
      setEdge(which, cur + map[e.key]);
      seekTo(which === "start" ? state.start : state.end);
    } else if (e.key === "Home") {
      e.preventDefault();
      setEdge(which, 0);
    } else if (e.key === "End") {
      e.preventDefault();
      setEdge(which, state.duration);
    }
  });
}
bindHandle(els.hStart, "start");
bindHandle(els.hEnd, "end");

els.timeline.addEventListener("pointerdown", (e) => {
  if (!state.duration) return;
  seekTo(timeAt(e.clientX));
});

function renderPlayhead() {
  const d = state.duration || 1;
  els.playhead.style.left = `${clamp(els.video.currentTime / d, 0, 1) * 100}%`;
}

els.video.addEventListener("timeupdate", () => {
  renderPlayhead();
  if (state.playingSel && els.video.currentTime >= state.end) {
    els.video.pause();
    state.playingSel = false;
  }
});
els.video.addEventListener("seeked", renderPlayhead);
els.video.addEventListener("pause", () => { state.playingSel = false; });

function commitTimeInput(input, which) {
  const t = parseTimeInput(input.value);
  if (Number.isFinite(t)) setEdge(which, t);
  else renderRange();
  input.value = fmt(which === "start" ? state.start : state.end);
}
for (const [input, which] of [[els.startIn, "start"], [els.endIn, "end"]]) {
  input.addEventListener("change", () => commitTimeInput(input, which));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  input.addEventListener("blur", () => commitTimeInput(input, which));
}

els.setStartBtn.addEventListener("click", () => setEdge("start", els.video.currentTime));
els.setEndBtn.addEventListener("click", () => setEdge("end", els.video.currentTime));
els.playSelBtn.addEventListener("click", async () => {
  if (!state.duration || els.video.readyState === 0) return;
  els.video.currentTime = state.start;
  try {
    await els.video.play();
    state.playingSel = true;
  } catch {}
});

document.addEventListener("keydown", (e) => {
  if (els.editor.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest("input, textarea, select")) return;
  const key = e.key.toLowerCase();
  if (key === "i") setEdge("start", els.video.currentTime);
  else if (key === "o") setEdge("end", els.video.currentTime);
});

/* ============ الخيارات ============ */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    if (state.busy) return;
    state.mode = tab.dataset.mode;
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    els.tabTrim.hidden = state.mode !== "trim";
    els.tabSplit.hidden = state.mode !== "split";
    els.exportLabel.textContent = state.mode === "split" ? "قسّم الفيديو" : "صدّر الفيديو";
    renderSplitInfo();
  });
});

document.querySelectorAll('input[name="quality"]').forEach((r) => {
  r.addEventListener("change", () => {
    state.quality = r.value;
    els.encodeHint.hidden = state.quality === "original";
  });
});

document.querySelectorAll('input[name="splitBy"]').forEach((r) => {
  r.addEventListener("change", () => {
    state.splitBy = r.value;
    if (state.splitBy === "time") {
      state.splitValue = clamp(Math.round((state.end - state.start) / 2) || 10, 1, 600);
    } else {
      state.splitValue = 2;
    }
    els.splitValue.value = state.splitValue;
    renderSplitInfo();
  });
});

function setSplitValue(v) {
  const max = state.splitBy === "count" ? MAX_PARTS : 3600;
  const min = state.splitBy === "count" ? 2 : 1;
  state.splitValue = clamp(Math.round(Number(v) || min), min, max);
  els.splitValue.value = state.splitValue;
  renderSplitInfo();
}
els.splitValue.addEventListener("change", () => setSplitValue(els.splitValue.value));
els.splitMinus.addEventListener("click", () => setSplitValue(state.splitValue - 1));
els.splitPlus.addEventListener("click", () => setSplitValue(state.splitValue + 1));

function splitRanges() {
  const { start, end } = state;
  const len = end - start;
  const step = state.splitBy === "count" ? len / state.splitValue : state.splitValue;
  const ranges = [];
  for (let s = start; s < end - 0.05 && ranges.length < MAX_PARTS; s += step) {
    ranges.push([s, Math.min(end, s + step)]);
  }
  return ranges;
}

function renderSplitInfo() {
  els.splitUnit.textContent = state.splitBy === "count" ? "أجزاء" : "ثانية";
  if (!state.duration) {
    els.splitInfo.textContent = "";
    return;
  }
  const ranges = splitRanges();
  const each = ranges.length ? ranges[0][1] - ranges[0][0] : 0;
  els.splitInfo.textContent = `عدد الأجزاء: ${ranges.length}، مدة كل جزء تقريبًا ${ltr(fmt(each))}. التقسيم بالجودة الأصلية.`;
}

/* ============ التصدير ============ */

function buildArgs(input, start, dur, enc, mute, out) {
  const args = ["-hide_banner", ...(enc ? decoderThreads() : []), "-ss", start.toFixed(3), "-i", input, "-t", dur.toFixed(3)];
  if (!enc) {
    args.push("-map", "0:v?", "-map", "0:a?", "-c", "copy", "-avoid_negative_ts", "make_zero");
  } else {
    const s = enc.short;
    args.push(
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", `scale='if(gt(iw,ih),-2,min(${s},iw))':'if(gt(iw,ih),min(${s},ih),-2)'`,
      // المقاطع الطويلة (أكثر من 5 دقائق) نستخدم لها preset أسرع
      "-c:v", "libx264", "-preset", dur > 300 ? "superfast" : "veryfast", "-crf", String(enc.crf), "-pix_fmt", "yuv420p",
      ...encoderThreads(),
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    );
  }
  if (mute) args.push("-an");
  args.push(out);
  return args;
}

// المحرك السريع عنده 32 خيط بس. لو طلبنا أكثر (مثلًا 8 للترميز مع خيوط فك الترميز
// والفلاتر) يعلق للأبد، فنحدد العدد. جربناها: 4 خيوط أسرع 2.3 مرة من المحرك العادي
const decoderThreads = () => (engineKind === "mt" ? ["-threads", "2"] : []);
const encoderThreads = () => (engineKind === "mt" ? ["-filter_threads", "1", "-threads", String(Math.min(CORES, 4))] : []);

// تقسيم بالجودة الأصلية في مرور واحد على الملف بدل مرة لكل جزء
function buildSegmentArgs(input, ranges, mute, pattern) {
  const s0 = ranges[0][0];
  const len = ranges[ranges.length - 1][1] - s0;
  const times = ranges.slice(1).map(([s]) => (s - s0).toFixed(3)).join(",");
  const args = [
    "-hide_banner", "-ss", s0.toFixed(3), "-i", input, "-t", len.toFixed(3),
    "-map", "0:v?", "-map", "0:a?", "-c", "copy",
  ];
  if (mute) args.push("-an");
  args.push(
    "-f", "segment", "-segment_times", times, "-reset_timestamps", "1",
    "-avoid_negative_ts", "make_zero", pattern,
  );
  return args;
}

function setProgress(ratio, text) {
  const pct = Math.round(clamp(ratio, 0, 1) * 100);
  els.progressBar.style.width = `${pct}%`;
  els.progressPct.textContent = `${pct}%`;
  if (text) els.progressText.textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  els.exportBtn.disabled = busy;
  els.changeBtn.disabled = busy;
  els.progress.hidden = !busy;
  if (busy) setProgress(0, "جاري التجهيز");
}

async function runExport(retry = false) {
  if (state.busy || !state.file || !state.duration) return;
  const split = state.mode === "split";
  const ranges = split ? splitRanges() : [[state.start, state.end]];
  const enc = split ? null : QUALITY[state.quality];
  const srcExt = fileExt(state.file.name);
  const ext = enc ? "mp4" : (COPY_EXTS.includes(srcExt) ? srcExt : "mp4");
  const mute = els.muteIn.checked;
  const base = baseName(state.file.name);
  const type = MIME[ext] || "video/mp4";
  const partName = (i) => `${base}-part${String(i + 1).padStart(2, "0")}.${ext}`;

  // تقدير حجم الناتج بالجودة الأصلية، لأن ذاكرة المتصفح لها حد
  const bytesFor = (sec) => state.file.size * (sec / state.duration);
  const totalLen = ranges[ranges.length - 1][1] - ranges[0][0];
  const biggestPart = Math.max(...ranges.map(([s, e]) => e - s));
  if (!enc && bytesFor(biggestPart) > MAX_OUTPUT_BYTES) {
    toast(split
      ? "الجزء الواحد أكبر من 1.8GB. زِد عدد الأجزاء."
      : "المقطع أكبر من 1.8GB وما يتحمله المتصفح. استخدم التقسيم أو اختر جودة أقل.", true);
    return;
  }
  // كل الأجزاء تنحفظ في الذاكرة مع بعض في المرور الواحد، فنستخدمه بس إذا الحجم معقول
  const onePass = split && ranges.length > 1 && bytesFor(totalLen) < MAX_OUTPUT_BYTES * 0.66;

  clearResults();
  setBusy(true);
  const runId = ++state.runId;
  els.video.pause();
  const started = performance.now();

  try {
    const ff = await loadEngine();
    const input = await prepareInput(ff);
    if (runId !== state.runId) return; // انلغت العملية أثناء تجهيز المحرك
    const outputs = [];

    if (onePass) {
      const label = `جاري تقسيم الفيديو إلى ${ranges.length} أجزاء`;
      setProgress(0, label);
      logHandler = (msg) => {
        const m = msg.match(LOG_TIME);
        if (m) setProgress(clamp(hms(m) / totalLen, 0, 1), label);
      };
      const code = await execWatched(ff, buildSegmentArgs(input, ranges, mute, `/seg_%03d.${ext}`));
      logHandler = null;
      if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
      const files = (await ff.listDir("/"))
        .map((f) => f.name)
        .filter((n) => n.startsWith("seg_"))
        .sort();
      if (!files.length) throw new Error("no segments");
      // القص بدون ترميز يصير عند الإطارات الرئيسية، فممكن يطلع عدد أجزاء مختلف شوي
      const exact = files.length === ranges.length;
      for (let i = 0; i < files.length; i++) {
        const data = await ff.readFile(`/${files[i]}`);
        await ff.deleteFile(`/${files[i]}`).catch(() => {});
        if (!data.length) continue;
        const duration = exact ? ranges[i][1] - ranges[i][0] : null;
        outputs.push({ blob: new Blob([data], { type }), name: partName(i), duration });
      }
    } else {
      for (let i = 0; i < ranges.length; i++) {
        if (runId !== state.runId) return;
        const [s, e] = ranges[i];
        const d = e - s;
        const label = ranges.length > 1 ? `جاري إنتاج الجزء ${i + 1} من ${ranges.length}` : enc ? "جاري ضغط الفيديو" : "جاري قص الفيديو";
        setProgress(i / ranges.length, label);
        logHandler = (msg) => {
          const m = msg.match(LOG_TIME);
          if (m) setProgress((i + clamp(hms(m) / d, 0, 1)) / ranges.length, label);
        };
        const out = `/out_${i + 1}.${ext}`;
        const code = await execWatched(ff, buildArgs(input, s, d, enc, mute, out));
        logHandler = null;
        if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
        const data = await ff.readFile(out);
        await ff.deleteFile(out).catch(() => {});
        if (!data.length) throw new Error("empty output");
        const name = ranges.length > 1 ? partName(i) : `${base}-tuvex.${ext}`;
        outputs.push({ blob: new Blob([data], { type }), name, duration: d });
      }
    }
    state.lastExportMs = performance.now() - started;
    setProgress(1, "تم");
    showResults(outputs);
  } catch (err) {
    if (runId !== state.runId) return;
    console.error(err, recentLogs.join("\n"));
    if (engineKind === "mt" && !retry) {
      // المحرك السريع فشل (ذاكرة الجهاز ما كفت أو علّق)، نعيد العملية بالمحرك العادي
      resetEngine();
      engineKind = "st";
      setBusy(false);
      return runExport(true);
    }
    const hint = enc ? "" : " جرّب تختار جودة ثانية غير الأصلية.";
    toast(`صار خطأ أثناء المعالجة.${hint}`, true);
  } finally {
    if (runId === state.runId) {
      logHandler = null;
      setBusy(false);
    }
  }
}

els.exportBtn.addEventListener("click", () => runExport());
els.cancelBtn.addEventListener("click", () => {
  if (!state.busy) return;
  state.runId++;
  logHandler = null;
  // إذا المحرك لسا يتحمل نخليه يكمل، وإلا نوقف ffmpeg ونشغل نسخة جديدة
  if (ffmpeg) {
    resetEngine();
    loadEngine().catch(() => {});
  }
  setBusy(false);
  toast("تم الإلغاء");
});

/* ============ النتائج ============ */

function clearResults() {
  state.resultUrls.forEach((u) => URL.revokeObjectURL(u));
  state.resultUrls = [];
  els.results.replaceChildren();
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12m0 0-5-5m5 5 5-5M4 20h16"/></svg>';
const ICON_SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

function download(url, name) {
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

function canShare(file) {
  try {
    return !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

function actionButton(html, label, onclick, cls = "btn btn-soft") {
  const b = el("button", { class: cls, type: "button", "aria-label": label, title: label, onclick });
  b.innerHTML = html;
  return b;
}

function showResults(outputs) {
  const total = outputs.reduce((n, o) => n + o.blob.size, 0);
  const head = el("div", { class: "result-head" });
  const secs = (state.lastExportMs || 0) / 1000;
  const took = secs < 1 ? "خلال أقل من ثانية" : `خلال ${secs < 10 ? secs.toFixed(1) : Math.round(secs)} ثانية`;
  head.innerHTML = `<span class="ok"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>جاهز ${took}</span>`;

  if (outputs.length === 1) {
    const o = outputs[0];
    const url = URL.createObjectURL(o.blob);
    state.resultUrls.push(url);
    const saved = state.file.size - o.blob.size;
    const meta = el("span", {}, `${fmtSize(o.blob.size)}`);
    if (saved > state.file.size * 0.05) {
      meta.append(" · ", el("span", { class: "saving" }, `أصغر بـ ${Math.round((saved / state.file.size) * 100)}%`));
    }
    head.append(meta);
    const video = el("video", { class: "result-video", src: url, controls: "", playsinline: "", preload: "metadata" });
    const dl = el("button", { class: "btn btn-primary btn-lg", type: "button", onclick: () => download(url, o.name) });
    dl.innerHTML = `${ICON_DOWNLOAD}<span>حمّل الفيديو</span>`;
    els.results.append(head, video, dl);
    const file = new File([o.blob], o.name, { type: o.blob.type });
    if (canShare(file)) {
      const share = el("button", { class: "btn btn-ghost", type: "button", onclick: () => navigator.share({ files: [file] }).catch(() => {}) });
      share.innerHTML = `${ICON_SHARE}<span>مشاركة أو حفظ في الصور</span>`;
      els.results.append(share);
    }
    return;
  }

  head.append(el("span", {}, `${outputs.length} أجزاء · ${fmtSize(total)}`));
  els.results.append(head);
  const urls = [];
  for (const o of outputs) {
    const url = URL.createObjectURL(o.blob);
    urls.push([url, o.name]);
    state.resultUrls.push(url);
    const file = new File([o.blob], o.name, { type: o.blob.type });
    const actions = el("div", { class: "result-actions" });
    if (canShare(file)) actions.append(actionButton(ICON_SHARE, `مشاركة ${o.name}`, () => navigator.share({ files: [file] }).catch(() => {}), "btn btn-ghost"));
    actions.append(actionButton(ICON_DOWNLOAD, `تحميل ${o.name}`, () => download(url, o.name)));
    els.results.append(el("div", { class: "result-item" },
      el("div", { class: "meta" }, el("strong", {}, o.name), el("span", {}, o.duration ? `${ltr(fmt(o.duration))} · ${fmtSize(o.blob.size)}` : fmtSize(o.blob.size))),
      actions,
    ));
  }
  const all = el("button", {
    class: "btn btn-primary btn-lg", type: "button",
    onclick: async () => {
      for (const [url, name] of urls) {
        download(url, name);
        await new Promise((r) => setTimeout(r, 400));
      }
    },
  });
  all.innerHTML = `${ICON_DOWNLOAD}<span>حمّل كل الأجزاء</span>`;
  els.results.append(all);
}

/* ============ اختيار الملف والسحب ============ */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});
els.changeBtn.addEventListener("click", () => els.fileInput.click());

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || state.busy) return;
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropOverlay.hidden = true;
});
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  openFile(e.dataTransfer.files[0]);
});

window.addEventListener("beforeunload", (e) => {
  if (state.busy) e.preventDefault();
});

/* ============ الوضع الليلي ============ */

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const currentTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light");

function applyThemeColor() {
  const color = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", color));
}

els.themeBtn.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
  applyThemeColor();
});
if (document.documentElement.dataset.theme) applyThemeColor();

/* ============ PWA ============ */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// نجهز المحرك في الخلفية من أول ما تفتح الصفحة، عشان يكون جاهز لما يختار المستخدم الفيديو.
// ما نسويها لمن مفعّل توفير البيانات
window.addEventListener("load", () => {
  if (navigator.connection?.saveData) return;
  const go = () => loadEngine().catch(() => {});
  setTimeout(() => ("requestIdleCallback" in window ? requestIdleCallback(go, { timeout: 4000 }) : go()), 2500);
});

let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  els.installBtn.hidden = false;
});
els.installBtn.addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  els.installBtn.hidden = true;
});
window.addEventListener("appinstalled", () => { els.installBtn.hidden = true; });

renderRange();
