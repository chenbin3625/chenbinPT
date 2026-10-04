// 定位遮挡全页的 .ant-modal-wrap 来自哪个组件、为什么可见
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist-chrome");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9361;
const profile = mkdtempSync(join(tmpdir(), "ptd-md-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-extension-debugging",
    "--disable-features=DisableLoadExtensionCommandLineSwitch,Translate",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const json = async (p, i) => (await fetch(`http://127.0.0.1:${PORT}${p}`, i)).json();

try {
  await sleep(2500);
  const ver = await json("/json/version");
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
  let bid = 0; const bp = new Map();
  bws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && bp.has(m.id)) { bp.get(m.id)(m); bp.delete(m.id); } };
  const bsend = (method, params = {}) => new Promise((r) => { const i = ++bid; bp.set(i, r); bws.send(JSON.stringify({ id: i, method, params })); });
  const loaded = await bsend("Extensions.loadUnpacked", { path: DIST });
  const extId = loaded.result.id;
  bws.close();
  await sleep(1200);

  const base = `chrome-extension://${extId}/src/entries/options/index.html`;
  const target = await json(`/json/new?${encodeURIComponent(base)}`, { method: "PUT" });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Runtime.consoleAPICalled") logs.push("console:" + m.params.type + " " + (m.params.args ?? []).map((a) => a.value ?? a.description).join(" ").slice(0, 300));
    if (m.method === "Runtime.exceptionThrown") logs.push("EXC " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 500));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return res.result?.result?.value ?? res.result?.exceptionDetails ?? null;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: base });
  for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector("#ptd-main")`)) break; await sleep(500); }
  await sleep(3000);

  const dump = await ev(`(() => {
    const out = [];
    for (const w of document.querySelectorAll('.ant-modal-wrap, .ant-drawer, .ant-image-preview-wrap, .ant-modal-mask')) {
      const cs = getComputedStyle(w);
      const r = w.getBoundingClientRect();
      const modal = w.querySelector('.ant-modal');
      // 找拥有它的 Vue 组件
      let comp = null;
      let node = w;
      while (node && !comp) { comp = node.__vueParentComponent?.type?.__name || node.__vueParentComponent?.type?.name || null; node = node.parentElement; }
      out.push({
        cls: w.className, display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        pointerEvents: cs.pointerEvents, zIndex: cs.zIndex, position: cs.position,
        rect: [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],
        hasModal: !!modal,
        title: w.querySelector('.ant-modal-title')?.innerText ?? null,
        bodyText: (w.querySelector('.ant-modal-body')?.innerText ?? '').slice(0, 120),
        text: (w.innerText ?? '').replace(/\\s+/g,' ').slice(0, 120),
        comp,
        outer: w.outerHTML.slice(0, 300),
      });
    }
    return { wraps: out, bodyOverflow: getComputedStyle(document.body).overflow, docClasses: document.documentElement.className };
  })()`);
  console.log(JSON.stringify(dump, null, 1));
  console.log("=== logs ===");
  for (const l of logs.slice(0, 25)) console.log(l);
  writeFileSync(".review-logs/modal-diag.json", JSON.stringify({ dump, logs }, null, 2));
  ws.close();
} catch (e) {
  console.log("ERR", e.stack);
} finally {
  chrome.kill("SIGKILL");
}
