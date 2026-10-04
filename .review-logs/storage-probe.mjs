// 验证 storage 路径消息链路：getExtStoragePath / patchExtStoragePath / 跨上下文一致性
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist-chrome");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9381;
const profile = mkdtempSync(join(tmpdir(), "ptd-sp-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  "--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch,Translate",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
const json = async (p, i) => (await fetch(`http://127.0.0.1:${PORT}${p}`, i)).json();
const out = { steps: [], swLogs: [] };
try {
  await sleep(2500);
  const ver = await json("/json/version");
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
  let bid = 0; const bp = new Map();
  const bsend = (method, params = {}, sessionId) => new Promise((r) => { const i = ++bid; bp.set(i, r); bws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  bws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && bp.has(m.id)) { bp.get(m.id)(m); bp.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") out.swLogs.push("EXC: " + (m.params.exceptionDetails.exception?.description ?? "").slice(0, 300));
  };
  await bsend("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const loaded = await bsend("Extensions.loadUnpacked", { path: DIST });
  const extId = loaded.result.id;
  await sleep(1500);
  const base = `chrome-extension://${extId}/src/entries/options/index.html`;
  const target = await json(`/json/new?${encodeURIComponent(base)}`, { method: "PUT" });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 500) };
    return r.result?.result?.value;
  };
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: base });
  for (let i = 0; i < 60; i++) { if ((await ev(`document.querySelector("#ptd-main") !== null`)) === true) break; await sleep(400); }
  await sleep(3500);

  const call = (type, data) => ev(`(async () => {
    try { const res = await chrome.runtime.sendMessage({ id: Math.floor(Math.random()*1e4), type: ${JSON.stringify(type)}, data: ${JSON.stringify(data)}, timestamp: Date.now() });
      return { res: res === undefined ? "(undefined)" : (res && res.err ? "ERR " + JSON.stringify(res.err).slice(0,200) : JSON.stringify(res.res).slice(0,400)) };
    } catch (e) { return { throw: String(e && e.message || e) }; }
  })()`);

  out.steps.push(["getExtStoragePath config.userInfo.queueConcurrency", await call("getExtStoragePath", { key: "config", path: "userInfo.queueConcurrency" })]);
  out.steps.push(["getExtStoragePath metadata.lastUserInfo.X default {}", await call("getExtStoragePath", { key: "metadata", path: ["lastUserInfo", "X"], defaultValue: {} })]);
  out.steps.push(["patch set metadata.lastUserInfo.T", await call("patchExtStoragePath", { key: "metadata", path: ["lastUserInfo", "T"], value: { hello: 1 } })]);
  out.steps.push(["read back metadata.lastUserInfo.T", await call("getExtStoragePath", { key: "metadata", path: ["lastUserInfo", "T"] })]);
  out.steps.push(["whole metadata.lastUserInfo", await call("getExtStoragePath", { key: "metadata", path: "lastUserInfo" })]);
  out.steps.push(["patch set userInfo.T.2026-01-01", await call("patchExtStoragePath", { key: "userInfo", path: ["T", "2026-01-01"], value: { a: 2 } })]);
  out.steps.push(["read userInfo.T", await call("getExtStoragePath", { key: "userInfo", path: ["T"] })]);
  out.steps.push(["patch remove metadata.lastUserInfo.T", await call("patchExtStoragePath", { key: "metadata", path: ["lastUserInfo", "T"], remove: true })]);
  out.steps.push(["read back after remove", await call("getExtStoragePath", { key: "metadata", path: ["lastUserInfo", "T"] })]);
  out.steps.push(["direct storage keys", await ev(`(async () => { const all = await chrome.storage.local.get(null); return Object.keys(all).map(k => k + ":" + typeof all[k]); })()`)]);
  out.steps.push(["storage metadata.lastUserInfo direct", await ev(`(async () => { const all = await chrome.storage.local.get(null); return JSON.stringify(all.metadata && all.metadata.lastUserInfo); })()`)]);
  out.steps.push(["storage userInfo direct", await ev(`(async () => { const all = await chrome.storage.local.get(null); return JSON.stringify(all.userInfo); })()`)]);
  out.steps.push(["getSiteList", await call("getSiteList", undefined)]);

  writeFileSync(".review-logs/storage-probe.json", JSON.stringify(out, null, 2));
  for (const [k, v] of out.steps) console.log(k, "=>", JSON.stringify(v));
  console.log("SW logs:", out.swLogs.slice(0, 10));
  ws.close(); bws.close();
} catch (e) { console.log("ERR", e.stack); } finally { chrome.kill("SIGKILL"); }
