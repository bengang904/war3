/**
 * Load assets from ./w3.zip → IndexedDB → engine bridges
 * No OPFS. No folder picker.
 *
 * Place w3.zip next to index.html (site root).
 * Preferred contents: already-extracted WC3 tree (UI/, Maps/, Units/, ...)
 * Also OK: zip containing War3.mpq / War3x.mpq (will try stormlib extract)
 */
const DB_NAME = "warsmash-w3zip";
const DB_VERSION = 1;
const STORE = "files";
const ZIP_URL = "/w3.zip";
const META_KEY = "__meta_zip_etag";

function ensureProgressUI() {
  if (typeof document === "undefined") return null;
  let el = document.getElementById("w3zip-progress");
  if (el) return el;
  el = document.createElement("div");
  el.id = "w3zip-progress";
  el.innerHTML = '<div class="w3zip-card"><div class="w3zip-title">资源加载</div><div class="w3zip-status">初始化…</div><div class="w3zip-bar"><i></i></div><pre class="w3zip-log"></pre></div>';
  const style = document.createElement("style");
  style.textContent = `
#w3zip-progress{position:fixed;right:16px;bottom:16px;z-index:99999;max-width:min(420px,92vw);font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6edf3;pointer-events:none}
#w3zip-progress .w3zip-card{background:rgba(15,20,28,.92);border:1px solid #3d8bfd;border-radius:12px;padding:12px 14px;box-shadow:0 8px 32px rgba(0,0,0,.45);backdrop-filter:blur(8px)}
#w3zip-progress .w3zip-title{font-weight:600;font-size:13px;margin:0 0 6px;color:#9ec1ff}
#w3zip-progress .w3zip-status{color:#e6edf3;margin:0 0 8px;font-size:12px}
#w3zip-progress .w3zip-bar{height:4px;background:#243044;border-radius:2px;overflow:hidden;margin:0 0 8px}
#w3zip-progress .w3zip-bar>i{display:block;height:100%;width:0%;background:linear-gradient(90deg,#3d8bfd,#7aa2ff);transition:width .25s ease}
#w3zip-progress .w3zip-log{margin:0;max-height:140px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#8b9bb4;font-size:11px}
#w3zip-progress.done .w3zip-bar>i{width:100%;background:#3dd68c}
#w3zip-progress.done .w3zip-title{color:#3dd68c}
#w3zip-progress.err .w3zip-title{color:#ff7b72}
#w3zip-progress.hidden{opacity:0;transform:translateY(8px);transition:opacity .4s,transform .4s;pointer-events:none}
`;
  document.head.appendChild(style);
  document.body.appendChild(el);
  return el;
}

function progress(status, detail, ratio) {
  console.info("[w3zip]", status, detail || "");
  if (typeof document === "undefined") return;
  const el = ensureProgressUI();
  if (!el) return;
  const st = el.querySelector(".w3zip-status");
  const log = el.querySelector(".w3zip-log");
  const bar = el.querySelector(".w3zip-bar>i");
  if (st) st.textContent = status;
  if (typeof ratio === "number" && bar) bar.style.width = Math.max(0, Math.min(100, ratio * 100)) + "%";
  if (detail && log) {
    log.textContent += (log.textContent ? "\n" : "") + detail;
    log.scrollTop = log.scrollHeight;
  }
}

function progressDone(msg) {
  progress(msg || "完成（已从缓存就绪）", null, 1);
  const el = document.getElementById("w3zip-progress");
  if (el) {
    el.classList.add("done");
    setTimeout(() => el.classList.add("hidden"), 4000);
  }
}

function progressErr(msg) {
  progress(msg, null, 0);
  const el = document.getElementById("w3zip-progress");
  if (el) el.classList.add("err");
}

let dbPromise = null;
let readyPromise = null;
let MpqArchiveClass = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
function idbGet(key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  }));
}
function idbPut(key, value) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}
function idbKeys() {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys();
    r.onsuccess = () => resolve((r.result || []).filter((k) => k !== META_KEY));
    r.onerror = () => reject(r.error);
  }));
}
function idbClear() {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readwrite").objectStore(STORE).clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}

function normalizePath(path) {
  let p = String(path || "").replace(/\\/g, "/");
  p = p.replace(/^\/+/, "");
  p = p.replace(/^extracted\//i, "");
  p = p.replace(/^w3\//i, "");
  // zip may nest under a root folder
  p = p.replace(/^[^/]+\/(?=UI\/|Maps\/|Units\/|Scripts\/|ReplaceableTextures\/|Sound\/|TerrainArt\/|war3|War3)/i, "");
  return p;
}

async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return window.JSZip;
}

async function loadStormlib() {
  if (MpqArchiveClass) return MpqArchiveClass;
  try {
    const mod = await import("https://esm.sh/stormlib-js@0.1.1/browser");
    MpqArchiveClass = mod.MpqArchive;
    console.info("[w3zip] stormlib-js loaded");
    return MpqArchiveClass;
  } catch (e) {
    console.warn("[w3zip] stormlib-js unavailable", e);
    return null;
  }
}

function extractFromArchive(archive, relPath) {
  for (const p of [relPath, relPath.replace(/\//g, "\\")]) {
    try {
      const data = archive.extractFile(p);
      if (!data) continue;
      if (data instanceof Uint8Array) return data;
      if (data.buffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return new Uint8Array(data);
    } catch {}
  }
  return null;
}

function shouldExtractFromMpq(norm) {
  const p = norm.replace(/\\/g, "/");
  if (/\.(w3x|w3m)$/i.test(p) && (/^maps\//i.test(p) || !p.includes("/"))) return true;
  if (/^ui\//i.test(p)) return true;
  if (/^scripts\//i.test(p)) return true;
  if (/^units\/.*\.(slk|txt)$/i.test(p)) return true;
  if (/^replaceabletextures\//i.test(p)) return true;
  if (/^sound\/interface\//i.test(p)) return true;
  return false;
}

async function ingestMpqBuffer(name, buf, Cls) {
  if (!Cls) return 0;
  let n = 0;
  try {
    const archive = Cls.openFromBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    let list = [];
    try { if (typeof archive.getFileList === "function") list = archive.getFileList() || []; } catch {}
    const lf = extractFromArchive(archive, "(listfile)");
    if (lf) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(lf);
      for (const line of text.split(/\r?\n/)) {
        const p = line.trim().replace(/\\/g, "/");
        if (p) list.push(p);
      }
    }
    const uniq = [...new Set(list.map((x) => String(x).replace(/\\/g, "/")))];
    console.info("[w3zip] MPQ", name, "entries ~", uniq.length);
    for (const rel of uniq) {
      if (!shouldExtractFromMpq(rel)) continue;
      const data = extractFromArchive(archive, rel);
      if (data && data.byteLength > 0) {
        await idbPut(normalizePath(rel), data);
        n++;
        if (n % 500 === 0) console.info("[w3zip] MPQ", name, "extracted", n, "…");
      }
    }
    console.info("[w3zip] MPQ", name, "stored", n, "files");
  } catch (e) {
    console.warn("[w3zip] MPQ ingest failed", name, e);
  }
  return n;
}

async function seedFromZip() {
  ensureProgressUI();
  const existing = await idbKeys();
  if (existing.length > 50) {
    const maps = existing.filter((k) => /\.(w3x|w3m)$/i.test(k));
    progress(
      "使用 IndexedDB 缓存（跳过解压）",
      "缓存文件 " + existing.length + " 个，地图 " + maps.length + " 个",
      1
    );
    progressDone("已从缓存加载 · " + existing.length + " 文件");
    return existing.length;
  }

  progress("正在下载 w3.zip…", ZIP_URL, 0.05);
  const res = await fetch(ZIP_URL);
  if (!res.ok) {
    progressErr("下载失败 HTTP " + res.status + " — 请把 w3.zip 放在网站根目录");
    return 0;
  }
  // Prefer streaming progress when Content-Length is present
  const totalLen = Number(res.headers.get("Content-Length") || 0);
  let ab;
  if (totalLen > 0 && res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const mb = (received / 1048576).toFixed(1);
      const tmb = (totalLen / 1048576).toFixed(1);
      progress("下载中 " + mb + " / " + tmb + " MB", null, 0.05 + 0.35 * (received / totalLen));
    }
    let offset = 0;
    const u8 = new Uint8Array(received);
    for (const c of chunks) { u8.set(c, offset); offset += c.byteLength; }
    ab = u8.buffer;
  } else {
    ab = await res.arrayBuffer();
  }
  const mb = (ab.byteLength / 1048576).toFixed(1);
  progress("下载完成 " + mb + " MB，开始解压…", null, 0.42);

  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(ab);
  const Cls = await loadStormlib();

  let loose = 0;
  let fromMpq = 0;
  const names = Object.keys(zip.files);
  progress("解压索引 " + names.length + " 个条目", null, 0.48);
  console.info("[w3zip] zip entries:", names.length);

  for (const name of names) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    const norm = normalizePath(name);
    if (!norm || norm.endsWith("/")) continue;

    const u8 = await entry.async("uint8array");
    if (/\.mpq$/i.test(norm)) {
      progress("解析 MPQ " + norm + " (" + (u8.byteLength / 1048576).toFixed(1) + " MB)", null, 0.55);
      console.info("[w3zip] found MPQ in zip:", norm, (u8.byteLength / 1048576).toFixed(1), "MB");
      fromMpq += await ingestMpqBuffer(norm, u8, Cls);
      // also store the mpq itself (optional)
      await idbPut(norm, u8);
      loose++;
    } else {
      await idbPut(norm, u8);
      loose++;
      if (loose % 1000 === 0) console.info("[w3zip] loose files stored", loose, "…");
    }
  }

  const keys = await idbKeys();
  const maps = keys.filter((k) => /\.(w3x|w3m)$/i.test(k));
  console.info("[w3zip] done. total:", keys.length, "loose+mpq:", loose, "fromMpqExtract:", fromMpq, "maps:", maps.length);
  if (maps.length) console.info("[w3zip] sample maps:", maps.slice(0, 8).join(", "));
  else console.warn("[w3zip] no maps found — add Maps/*.w3x into the zip or include War3x.mpq");
  progress(
    "解压完成",
    "共 " + keys.length + " 文件 · 从 MPQ 提取 " + fromMpq + " · 地图 " + maps.length,
    1
  );
  progressDone("首次解压完成并已缓存 · 下次将直接读取");
  return keys.length;
}

function ensureReady() {
  if (!readyPromise) {
    readyPromise = seedFromZip()
      .then((n) => {
        window.__w3AssetsReady = n > 0;
        window.__w3AssetsCount = n;
        console.info("[w3zip] ready flag set, files=", n);
        if (n > 0) progress("引擎资源就绪", "files=" + n, 1);
        // notify EnginePage if it is waiting
        window.dispatchEvent(new CustomEvent("w3zip-ready", { detail: { files: n } }));
        return n;
      })
      .catch((e) => {
        console.error("[w3zip] seed failed", e);
        window.__w3AssetsReady = false;
        return 0;
      });
  }
  return readyPromise;
}

async function readWithFallback(path) {
  const key = normalizePath(path);
  const data = await idbGet(key);
  if (data) return data;
  // try alternate casings / prefixes
  const keys = await idbKeys();
  const hit = keys.find((k) => k.toLowerCase() === key.toLowerCase() || k.toLowerCase().endsWith("/" + key.toLowerCase()));
  if (hit) return idbGet(hit);
  console.warn("[w3zip] missing:", key);
  return null;
}

function dummyHandle() {
  return {
    getDirectoryHandle: async () => dummyHandle(),
    getFileHandle: async () => ({
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      getFile: async () => new Blob(),
    }),
    removeEntry: async () => {},
    entries: async function* () {},
  };
}
async function y() { return dummyHandle(); }
async function p() { return dummyHandle(); }
async function h() { await idbClear(); readyPromise = null; }
async function g() { return dummyHandle(); }
async function l() { return dummyHandle(); }
async function D() { return []; }
async function m() { return 0; }
async function P() {}
function f(t) { return String(t || "").replace(/[\\/]/g, "_"); }
function R(t, r) {
  if (r === "directory") {
    const o = (t.webkitRelativePath || t.name).split("/").filter(Boolean);
    return (o.length > 1 ? o.slice(1) : o).join("/");
  }
  return f(t.name);
}

let installed = false;
function M() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.__w3AssetsReady = false;
  window.w3MainListExtractedAsync = async () => {
    await ensureReady();
    const keys = await idbKeys();
    console.info("[w3zip] list →", keys.length);
    return keys.join("\n");
  };
  window.w3MainReadExtractedAsync = async (path) => {
    await ensureReady();
    const data = await readWithFallback(path);
    if (!data) return null;
    return new Int8Array(data.buffer, data.byteOffset, data.byteLength);
  };
  window.w3ReadFileAsync = window.w3MainReadExtractedAsync;
  window.w3ListFilesAsync = window.w3MainListExtractedAsync;
  window.w3ClearIdb = async () => {
    await idbClear();
    readyPromise = null;
    console.info("[w3zip] IndexedDB cleared");
  };
  window.w3Reseed = async () => {
    await idbClear();
    readyPromise = null;
    return ensureReady();
  };
  ensureReady();
  console.info("%c[Warsmash] loading from ./w3.zip → IndexedDB", "color:#6cf;font-weight:bold");
}

export { m as a, l as b, h as c, p as e, y as g, M as i, D as l, P as r, R as s };
if (typeof window !== "undefined") M();
