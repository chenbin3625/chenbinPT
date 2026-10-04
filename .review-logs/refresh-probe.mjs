// A/B 验证「刷新数据」失败时的用户反馈：添加一个无法登录的私有站点 → 点刷新数据 → 看是否出现失败提示
// 用法: node .review-logs/refresh-probe.mjs <distDir> [站点id]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2]);
const SITE_QUERY = process.argv[3] ?? "zmpt";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9421;
const profile = mkdtempSync(join(tmpdir(), "ptd-rf-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  "--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch,Translate",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
const json = async (p, i) => (await fetch(`http://127.0.0.1:${PORT}${p}`, i)).json();
const out = { dist: DIST, steps: [] };
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
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description ?? "").slice(0, 300) };
    return r.result?.result?.value;
  };
  const step = async (n, fn) => { const v = await fn(); out.steps.push({ n, v }); console.log("STEP", n, "=>", JSON.stringify(v).slice(0, 400)); };
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: base });
  for (let i = 0; i < 80; i++) { if ((await ev(`document.querySelector("#ptd-main") !== null`)) === true) break; await sleep(400); }
  await sleep(3000);
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); if(w){ (w.querySelector('.ant-modal-close')||[...w.querySelectorAll('button')].find(b=>/开始使用/.test(b.innerText)))?.click(); } return true; })()`);
  await sleep(1200);

  // 添加一个私有站点（无 cookie，必然刷新失败）
  await ev(`(location.hash="#/set-site", true)`); await sleep(2500);
  await ev(`([...document.querySelectorAll('#ptd-main button')].find(b=>/增加|添加/.test(b.innerText))?.click(), true)`); await sleep(1500);
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const s=w?.querySelector('.ant-select-selector'); if(!s) return false; s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); s.click(); const inp=[...document.querySelectorAll('.ant-select input')].pop(); if(inp){ inp.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp, ${JSON.stringify(SITE_QUERY)}); inp.dispatchEvent(new Event('input',{bubbles:true})); } return true; })()`);
  await sleep(1600);
  await step("候选站点（前3）", async () => await ev(`[...document.querySelectorAll('.ant-select-item-option')].map(o=>o.innerText.split('\\n')[0]).slice(0,3)`));
  await ev(`(() => { const o=document.querySelector('.ant-select-item-option'); o?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); o?.click(); return !!o; })()`);
  await sleep(1000);
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const b=[...w.querySelectorAll('button')].find(x=>/下一步/.test(x.innerText)); if(!b||b.disabled) return false; b.click(); return true; })()`);
  await sleep(2500);
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const b=[...w.querySelectorAll('button')].find(x=>/完成|确定|保存/.test(x.innerText.replace(/\\s+/g,''))); if(!b||b.disabled) return false; b.click(); return true; })()`);
  await sleep(3000);
  await step("站点已保存", async () => await ev(`(async () => { const m=(await chrome.storage.local.get('metadata')).metadata; return Object.keys(m.sites||{}); })()`));

  // 进入「我的数据」→ 点刷新数据
  await ev(`(location.hash="#/my-data", true)`);
  await sleep(3500);
  await step("页面行数", async () => await ev(`({ rows: document.querySelectorAll('#ptd-main .ant-table-tbody tr').length, text: (document.querySelector('#ptd-main')?.innerText||'').slice(0,150) })`));
  await step("点击刷新数据", async () => await ev(`(() => { const b=[...document.querySelectorAll('#ptd-main button')].find(x=>/刷新数据/.test(x.innerText)); if(!b) return {found:false, buttons:[...document.querySelectorAll('#ptd-main button')].map(x=>x.innerText.trim())}; if(b.disabled) return {found:true, disabled:true}; b.click(); return {found:true}; })()`));
  // 采样 20 秒内的 toast（antd message）
  await step("20 秒内的提示消息", async () => await ev(`(async () => {
    const seen = new Set();
    for (let i=0;i<40;i++){
      for (const el of document.querySelectorAll('.ant-message-notice')) {
        const t=(el.innerText||'').replace(/\\s+/g,' ').trim();
        if (t) seen.add(t);
      }
      await new Promise(r=>setTimeout(r,500));
    }
    return [...seen];
  })()`));
  await step("最终状态", async () => await ev(`({ text: (document.querySelector('#ptd-main')?.innerText||'').slice(0,200), toasts: document.querySelectorAll('.ant-message-notice').length })`));
  writeFileSync(`.review-logs/refresh-${DIST.includes("fixed") ? "fixed" : "old"}.json`, JSON.stringify(out, null, 2));
  ws.close(); bws.close();
} catch (e) { console.log("ERR", e.stack); writeFileSync(".review-logs/refresh-err.json", JSON.stringify(out, null, 2)); } finally { chrome.kill("SIGKILL"); }
