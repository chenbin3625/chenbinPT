// 运行时：验证 options → service worker → offscreen 的消息链路是否通
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist-chrome");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9371;
const profile = mkdtempSync(join(tmpdir(), "ptd-msg-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch,Translate",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"],
  { stdio: "ignore" },
);
const json = async (p, i) => (await fetch(`http://127.0.0.1:${PORT}${p}`, i)).json();
const out = { msgs: [], swLogs: [], targets: [] };

try {
  await sleep(2500);
  const ver = await json("/json/version");
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
  let bid = 0; const bp = new Map();
  bws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && bp.has(m.id)) { bp.get(m.id)(m); bp.delete(m.id); return; }
    // 子会话（SW / offscreen）的日志
    if (m.method === "Runtime.consoleAPICalled") out.swLogs.push(`[${m.sessionId?.slice(0, 6)}] ${m.params.type}: ` + (m.params.args ?? []).map((a) => a.value ?? a.description).join(" ").slice(0, 260));
    if (m.method === "Runtime.exceptionThrown") out.swLogs.push(`[${m.sessionId?.slice(0, 6)}] EXC: ` + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 400));
    if (m.method === "Target.attachedToTarget") {
      const sid = m.params.sessionId;
      bsend("Runtime.enable", {}, sid);
      bsend("Log.enable", {}, sid).catch?.(() => {});
    }
  };
  const bsend = (method, params = {}, sessionId) => new Promise((r) => { const i = ++bid; bp.set(i, r); bws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  await bsend("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const loaded = await bsend("Extensions.loadUnpacked", { path: DIST });
  const extId = loaded.result.id;
  out.extId = extId;
  await sleep(1500);

  // SW 可能被唤醒：先打开 options 页面
  const base = `chrome-extension://${extId}/src/entries/options/index.html`;
  const target = await json(`/json/new?${encodeURIComponent(base)}`, { method: "PUT" });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 400) ?? JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
    return r.result?.result?.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: base });
  for (let i = 0; i < 60; i++) { if ((await ev(`location.href.startsWith("chrome-extension://")`)) === true) break; await sleep(400); }
  await sleep(4000);
  out.pageHref = await ev(`location.href`);
  out.mounted = await ev(`!!document.querySelector("#ptd-main")`);

  const call = async (type, data) => ev(`(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ id: Math.floor(Math.random()*1e4), type: ${JSON.stringify(type)}, data: ${JSON.stringify(data)}, timestamp: Date.now() });
      return { ok: true, res: res === undefined ? "(undefined)" : JSON.stringify(res).slice(0, 6000) };
    } catch (e) { return { ok: false, err: (e && e.stack) ? e.stack : String(e) }; }
  })()`);

  out.msgs.push({ type: "ping", ...(await call("ping", undefined)) });
  out.msgs.push({ type: "getExtStorage(config)", ...(await call("getExtStorage", "config")) });
  out.msgs.push({ type: "getExtStorage(metadata)", ...(await call("getExtStorage", "metadata")) });
  out.msgs.push({ type: "getSiteUserInfoResult(fakesite)", ...(await call("getSiteUserInfoResult", "fakesite")) });
  out.msgs.push({ type: "unknownMessage", ...(await call("thisMessageDoesNotExist", 1)) });

  await sleep(1500);

  // 列出所有 target，找 SW / offscreen
  const list = await json("/json/list");
  out.targets = list.map((t) => `${t.type} :: ${t.url}`);
  // 通过 CDP 直接看 storage 与 SW 是否活着
  out.storageKeys = await ev(`(async () => Object.keys(await chrome.storage.local.get(null)))()`);
  writeFileSync(".review-logs/msg-probe.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1));
  ws.close(); bws.close();
} catch (e) {
  console.log("ERR", e.stack);
} finally {
  chrome.kill("SIGKILL");
}
