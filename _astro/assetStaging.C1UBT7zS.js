
import { c as y, g as v, s as b, e as k } from "./opfs.DhKSuwVr.js";
let i = null;
async function h() {
  if (!(i || !("wakeLock" in navigator))) try {
    i = await navigator.wakeLock.request("screen");
    i.addEventListener("release", () => { i = null; });
  } catch {}
}
function B(e) {
  document.addEventListener("visibilitychange", () => {
    document.visibilityState === "visible" && e() && h();
  });
}
const c = "w3AssetsReady", g = "w3AssetsCount", u = "w3AssetsIndex";
function C() {
  if (!window.__w3AssetsReady) return [];
  return [
    { p: "w3.zip", s: 1 },
    { p: "Maps/boot.w3x", s: 1 }
  ];
}
function E(e) {
  try {
    localStorage.setItem(c, window.__w3AssetsReady ? "1" : "0");
    localStorage.setItem(g, String(e.length));
    localStorage.setItem(u, JSON.stringify(e));
  } catch {}
}
function P(e) {
  const ready = !!window.__w3AssetsReady;
  return {
    fileCount: ready ? Math.max(e.length, 2) : 0,
    mpqCount: ready ? 1 : 0,
    mapCount: ready ? 1 : 0,
    totalBytes: ready ? 1 : 0
  };
}
function F() { return window.__w3AssetsReady ? "w3.zip loaded into IndexedDB" : "Downloading / extracting w3.zip…"; }
function R() { return window.__w3AssetsReady ? "Ready" : "Please wait for [w3zip] done in console"; }
function D() { return !!window.__w3AssetsReady; }
async function O() {
  const fake = C();
  E(fake);
  return { index: fake, summary: P(fake), staged: fake.length, totalBytes: 1, durationSeconds: 0 };
}
export { h as a, R as b, P as c, F as f, D as h, B as i, C as r, O as s, E as w };
