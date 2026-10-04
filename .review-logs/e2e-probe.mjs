// 端到端走查：添加公开站点 → 搜索，逐步截图 + 记录 DOM 状态
// 用法: node .review-logs/e2e-probe.mjs [distDir]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist-chrome");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOT = ".review-logs/e2e";
const PORT = 9391;
const profile = mkdtempSync(join(tmpdir(), "ptd-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOT, { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  "--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch,Translate",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
const json = async (p, i) => (await fetch(`http://127.0.0.1:${PORT}${p}`, i)).json();
const report = { steps: [], console: [], exceptions: [] };
try {
  await sleep(2500);
  const ver = await json("/json/version");
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
  let bid = 0; const bp = new Map();
  const bsend = (method, params = {}, sessionId) => new Promise((r) => { const i = ++bid; bp.set(i, r); bws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  bws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && bp.has(m.id)) { bp.get(m.id)(m); bp.delete(m.id); } };
  const loaded = await bsend("Extensions.loadUnpacked", { path: DIST });
  const extId = loaded.result.id;
  await sleep(1500);
  const base = `chrome-extension://${extId}/src/entries/options/index.html`;
  const target = await json(`/json/new?${encodeURIComponent(base)}`, { method: "PUT" });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      const t = (m.params.args ?? []).map((a) => a.value ?? a.description).join(" ");
      report.console.push(m.params.type + ": " + t.slice(0, 400));
    }
    if (m.method === "Runtime.exceptionThrown") report.exceptions.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 500));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description ?? "").slice(0, 400) };
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    try { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOT, name + ".png"), Buffer.from(s.result.data, "base64")); } catch (e) { /* ignore */ }
  };
  const step = async (name, fn) => {
    const v = await fn();
    report.steps.push({ name, result: v });
    console.log("STEP", name, "=>", JSON.stringify(v).slice(0, 400));
  };
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: base });
  for (let i = 0; i < 80; i++) { if ((await ev(`document.querySelector("#ptd-main") !== null`)) === true) break; await sleep(400); }
  await sleep(3000);
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); if(w){ (w.querySelector('.ant-modal-close')||[...w.querySelectorAll('button')].find(b=>/开始使用|确定/.test(b.innerText)))?.click(); } return true; })()`);
  await sleep(1500);
  await shot("01-home");

  await step("route:set-site", async () => { await ev(`(location.hash="#/set-site", true)`); await sleep(2500); return await ev(`({hash:location.hash, main:(document.querySelector('#ptd-main')?.innerText||'').slice(0,120)})`); });
  await shot("02-set-site");

  await step("click 添加站点", async () => await ev(`(() => {
    const b=[...document.querySelectorAll('#ptd-main button')].find(x=>/增加|添加站点|新增站点/i.test(x.innerText));
    if(!b) return {found:false, buttons:[...document.querySelectorAll('#ptd-main button')].map(x=>x.innerText)};
    b.click(); return {found:true, text:b.innerText.trim()};
  })()`));
  await sleep(1500);
  await shot("03-add-dialog");
  await step("dialog state", async () => await ev(`(() => {
    const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none');
    if(!w) return {modal:false};
    return { modal:true, title:w.querySelector('.ant-modal-title')?.innerText, selects:w.querySelectorAll('.ant-select').length, options:w.querySelectorAll('.ant-select-item-option').length, buttons:[...w.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean).slice(0,10), text:(w.innerText||'').slice(0,200) };
  })()`));

  await step("open select", async () => await ev(`(() => {
    const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none');
    const sel=w?.querySelector('.ant-select-selector'); if(!sel) return {found:false};
    sel.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); sel.click(); return {found:true};
  })()`));
  await sleep(1000);
  await step("type nyaa", async () => await ev(`(() => {
    const inp=[...document.querySelectorAll('.ant-select input')].pop();
    if(!inp) return {found:false};
    inp.focus();
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(inp,'nyaa');
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    return {found:true, value:inp.value, options:[...document.querySelectorAll('.ant-select-item-option')].map(o=>o.innerText.slice(0,40)).slice(0,5)};
  })()`));
  await sleep(1200);
  await shot("04-select-filtered");
  await step("pick first option", async () => await ev(`(() => {
    const o=document.querySelector('.ant-select-item-option');
    if(!o) return {found:false, options:document.querySelectorAll('.ant-select-item-option').length};
    o.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); o.click(); return {found:true, text:o.innerText.slice(0,40)};
  })()`));
  await sleep(1200);
  await shot("05-selected");
  await step("select value", async () => await ev(`(() => {
    const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none');
    return { text:(w?.innerText||'').slice(0,300), nextDisabled:[...w.querySelectorAll('button')].filter(b=>/下一?步/.test(b.innerText)).map(b=>b.disabled) };
  })()`));

  await step("click 下一步", async () => await ev(`(() => {
    const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none');
    const b=[...w.querySelectorAll('button')].find(x=>/下一?步/.test(x.innerText));
    if(!b) return {found:false, buttons:[...w.querySelectorAll('button')].map(x=>x.innerText.trim()).filter(Boolean)};
    if(b.disabled) return {found:true, disabled:true};
    b.click(); return {found:true};
  })()`));
  await sleep(2500);
  await shot("06-editor");
  await step("editor state", async () => await ev(`(() => {
    const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none');
    if(!w) return {modal:false};
    const btns=[...w.querySelectorAll('button')].map(b=>({t:b.innerText.trim(),d:b.disabled})).filter(b=>b.t);
    return { text:(w.innerText||'').slice(0,300), inputs:w.querySelectorAll('input,textarea').length, buttons:btns.slice(0,12), invalid:w.querySelectorAll('.ant-form-item-has-error').length };
  })()`));

  await step("click 保存/确定", async () => await ev(`(() => {
    const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none');
    const b=[...w.querySelectorAll('button')].find(x=>/^(确定|保存|OK)$/.test(x.innerText.trim()));
    if(!b) return {found:false};
    if(b.disabled) return {found:true, disabled:true};
    b.click(); return {found:true};
  })()`));
  await sleep(3000);
  await shot("07-after-save");
  await step("site table", async () => await ev(`(() => ({ modalOpen: [...document.querySelectorAll('.ant-modal-wrap')].some(x=>getComputedStyle(x).display!=='none'), rows: document.querySelectorAll('#ptd-main .ant-table-tbody tr').length, text:(document.querySelector('#ptd-main')?.innerText||'').slice(0,200) }))()`));

  await step("route:search-entity", async () => { await ev(`(location.hash="#/search-entity", true)`); await sleep(3000); return await ev(`({hash:location.hash, text:(document.querySelector('#ptd-main')?.innerText||'').slice(0,200)})`); });
  await shot("08-search-entity");
  await step("type keyword", async () => await ev(`(() => {
    const inp=document.querySelector('#ptd-main input');
    if(!inp) return {found:false};
    inp.focus();
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(inp,'test'); inp.dispatchEvent(new Event('input',{bubbles:true}));
    return {found:true, value:inp.value};
  })()`));
  await sleep(600);
  await step("click 开始", async () => await ev(`(() => {
    const b=[...document.querySelectorAll('#ptd-main button')].find(x=>/开始/.test(x.innerText));
    if(!b) return {found:false, buttons:[...document.querySelectorAll('#ptd-main button')].map(x=>x.innerText.trim())};
    if(b.offsetWidth===0) return {found:true, hidden:true};
    b.click(); return {found:true};
  })()`));
  await sleep(12000);
  await shot("09-after-search");
  await step("search state", async () => await ev(`({
    rows: document.querySelectorAll('#ptd-main .ant-table-tbody tr').length,
    text: (document.querySelector('#ptd-main')?.innerText||'').slice(0,400),
    flushPlan: JSON.stringify((window.__pinia_state||{}).x||null)
  })`));
  await sleep(8000);
  await shot("10-search-final");
  await step("search state final", async () => await ev(`({ rows: document.querySelectorAll('#ptd-main .ant-table-tbody tr').length, text: (document.querySelector('#ptd-main')?.innerText||'').slice(0,300) })`));

  const store = await ev(`(async () => { const all = await chrome.storage.local.get(null); return { sites: Object.keys(all.metadata?.sites||{}), lastUserInfo: Object.keys(all.metadata?.lastUserInfo||{}), snapshots: Object.keys(all.searchResultSnapshot||{}) }; })()`);
  report.storage = store;
  writeFileSync(".review-logs/e2e-report.json", JSON.stringify(report, null, 2));
  console.log("storage:", JSON.stringify(store));
  console.log("exceptions:", report.exceptions.slice(0, 10));
  console.log("console errors:", report.console.filter((c) => c.startsWith("error")).slice(0, 15));
  ws.close(); bws.close();
} catch (e) {
  console.log("ERR", e.stack);
  writeFileSync(".review-logs/e2e-report.json", JSON.stringify(report, null, 2));
} finally { chrome.kill("SIGKILL"); }
