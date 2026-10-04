// 核心流程验证：添加公开站点 Nyaa → 顶栏搜索 → 搜索页是否真的发起搜索并拿到结果
// 用法: node .review-logs/flow-probe.mjs [distDir]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "/tmp/ptd-freeze");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9411;
const profile = mkdtempSync(join(tmpdir(), "ptd-fl-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(".review-logs/shots", { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  "--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch,Translate",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
const json = async (p, i) => (await fetch(`http://127.0.0.1:${PORT}${p}`, i)).json();
const out = { steps: [], consoleErrors: [], exceptions: [] };
try {
  await sleep(2500);
  const ver = await json("/json/version");
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
  let bid = 0; const bp = new Map();
  const bsend = (m, p = {}) => new Promise((r) => { const i = ++bid; bp.set(i, r); bws.send(JSON.stringify({ id: i, method: m, params: p })); });
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
    if (m.method === "Runtime.exceptionThrown") out.exceptions.push((m.params.exceptionDetails.exception?.description ?? "").slice(0, 400));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") out.consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description).join(" ").slice(0, 400));
  };
  const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description ?? "").slice(0, 300) };
    return r.result?.result?.value;
  };
  const shot = async (n) => { try { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`.review-logs/shots/${n}.png`, Buffer.from(s.result.data, "base64")); } catch {} };
  const step = async (n, fn) => { const v = await fn(); out.steps.push({ n, v }); console.log("STEP", n, "=>", JSON.stringify(v).slice(0, 500)); };
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: base });
  for (let i = 0; i < 80; i++) { if ((await ev(`document.querySelector("#ptd-main") !== null`)) === true) break; await sleep(400); }
  await sleep(3000);
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); if(w){ (w.querySelector('.ant-modal-close')||[...w.querySelectorAll('button')].find(b=>/开始使用/.test(b.innerText)))?.click(); } return true; })()`);
  await sleep(1200);

  // 添加 Nyaa
  await ev(`(location.hash="#/set-site", true)`); await sleep(2500);
  await ev(`([...document.querySelectorAll('#ptd-main button')].find(b=>/增加|添加/.test(b.innerText))?.click(), true)`); await sleep(1500);
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const s=w?.querySelector('.ant-select-selector'); if(!s) return false; s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); s.click(); const inp=[...document.querySelectorAll('.ant-select input')].pop(); if(inp){ inp.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp,'Nyaa'); inp.dispatchEvent(new Event('input',{bubbles:true})); } return true; })()`);
  await sleep(1500);
  await ev(`(() => { const o=[...document.querySelectorAll('.ant-select-item-option')].find(x=>/Nyaa/i.test(x.innerText)); o?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); o?.click(); return !!o; })()`);
  await sleep(1000);
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const b=[...w.querySelectorAll('button')].find(x=>/下一步/.test(x.innerText)); if(!b||b.disabled) return false; b.click(); return true; })()`); await sleep(2500);
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const b=[...w.querySelectorAll('button')].find(x=>/完成|确定|保存/.test(x.innerText.replace(/\\s+/g,''))); if(!b||b.disabled) return false; b.click(); return true; })()`); await sleep(3000);
  await step("站点已添加", async () => await ev(`(async () => { const m=(await chrome.storage.local.get('metadata')).metadata; return { sites: Object.keys(m.sites||{}), allowSearch: Object.values(m.sites||{}).map(s=>s.allowSearch), solutions: Object.keys(m.solutions||{}) }; })()`));
  await ev(`(location.hash="#/", true)`); await sleep(2000);

  // 顶栏搜索
  await step("打开搜索方案菜单", async () => await ev(`(() => { const b=document.querySelector('#ptd-topbar .ptd-search-plan-btn'); if(!b) return {found:false}; b.click(); return {found:true}; })()`));
  await sleep(900);
  await step("菜单项", async () => await ev(`(() => { const items=[...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-menu-item, .ant-dropdown:not(.ant-dropdown-hidden) li')].map(i=>i.innerText.replace(/\\s+/g,' ').trim().slice(0,30)); return items.slice(0,10); })()`));
  await shot("f1-plan-menu");
  await ev(`document.body.click()`); await sleep(400);

  await step("顶栏输入关键词", async () => await ev(`(() => { const inp=document.querySelector('#ptd-topbar input'); if(!inp) return {found:false}; inp.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp,'linux'); inp.dispatchEvent(new Event('input',{bubbles:true})); return {found:true, v:inp.value}; })()`));
  await sleep(400);
  await step("点击搜索按钮", async () => await ev(`(() => { const btns=[...document.querySelectorAll('#ptd-topbar button')]; const b=btns.find(x=>x.title && /搜索/.test(x.title)) || btns[btns.length-1]; b.click(); return {clicked:true, title:b.title, disabled:b.disabled}; })()`));
  await sleep(2500);
  await step("跳转结果", async () => await ev(`({hash:location.hash, main:(document.querySelector('#ptd-main')?.innerText||'').slice(0,150)})`));
  await sleep(10000);
  await shot("f2-searching");
  await step("搜索中状态", async () => await ev(`({ rows: document.querySelectorAll('#ptd-main .ant-table-tbody tr').length, text:(document.querySelector('#ptd-main')?.innerText||'').slice(0,300) })`));
  await sleep(20000);
  await shot("f3-search-done");
  await step("搜索结果", async () => await ev(`({ rows: document.querySelectorAll('#ptd-main .ant-table-tbody tr').length, text:(document.querySelector('#ptd-main')?.innerText||'').slice(0,300) })`));
  await step("runtime.search 状态", async () => await ev(`(async () => { const s=await chrome.storage.session.get(null); return JSON.stringify(s).slice(0,600); })()`));

  console.log("exceptions:", out.exceptions.slice(0, 6));
  console.log("consoleErrors:", out.consoleErrors.filter((c) => !/Failed to fetch|net::/.test(c)).slice(0, 10));
  writeFileSync(".review-logs/flow-report.json", JSON.stringify(out, null, 2));
  ws.close(); bws.close();
} catch (e) { console.log("ERR", e.stack); writeFileSync(".review-logs/flow-report.json", JSON.stringify(out, null, 2)); } finally { chrome.kill("SIGKILL"); }
