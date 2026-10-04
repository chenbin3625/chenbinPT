// 探针 v4：用 MutationObserver 判定点击是否产生任何效果（比 DOM 快照灵敏得多）
// 先通过 UI 添加 Nyaa(公开) + 织梦(私有)，再全路由扫描按钮
// 用法: node .review-logs/btn-probe4.mjs [distDir]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "/tmp/ptd-fixed");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9431;
const profile = mkdtempSync(join(tmpdir(), "ptd-bt4-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(".review-logs/shots", { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  "--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch,Translate",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
const json = async (p, i) => (await fetch(`http://127.0.0.1:${PORT}${p}`, i)).json();
const report = { setup: [], routes: [], exceptions: [], consoleErrors: [] };
const DANGER = /删除|移除|清空|重置|覆盖|格式化|注销|退出|停止|取消任务|一键导入|重新下载/i;
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
    if (m.method === "Runtime.exceptionThrown") report.exceptions.push((m.params.exceptionDetails.exception?.description ?? "").slice(0, 400));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") report.consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description).join(" ").slice(0, 300));
  };
  const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description ?? "").slice(0, 300) };
    return r.result?.result?.value;
  };
  const shot = async (n) => { try { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`.review-logs/shots/${n}.png`, Buffer.from(s.result.data, "base64")); } catch {} };
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: base });
  for (let i = 0; i < 80; i++) { if ((await ev(`document.querySelector("#ptd-main") !== null`)) === true) break; await sleep(400); }
  await sleep(3000);
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); if(w){ (w.querySelector('.ant-modal-close')||[...w.querySelectorAll('button')].find(b=>/开始使用/.test(b.innerText)))?.click(); } return true; })()`);
  await sleep(1200);

  await ev(`(() => {
    window.__q = {
      visible(el) {
        if (el.closest('[style*="display: none"]')) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        // 祖先里有隐藏的
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const pcs = getComputedStyle(p);
          if (pcs.display === 'none' || pcs.visibility === 'hidden') return false;
        }
        return el.getClientRects().length > 0;
      },
      list() { return [...document.querySelectorAll('#ptd-main button, #ptd-main .ant-switch, #ptd-main .ant-pagination-item, #ptd-main .ant-tabs-tab, #ptd-main .ant-checkbox-wrapper')].filter((el) => window.__q.visible(el)); },
      info(el) { const r = el.getBoundingClientRect(); const t = (el.innerText || el.title || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2); let covered = null;
        if (r.width > 0 && r.height > 0 && cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight) { const top = document.elementFromPoint(cx, cy); if (top && !el.contains(top) && top !== el) covered = top.tagName + '.' + (typeof top.className === 'string' ? top.className.split(' ').slice(0, 2).join('.') : ''); }
        return { text: t, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', covered, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }; },
      close() { let n = 0; for (const w of [...document.querySelectorAll('.ant-modal-wrap')]) { if (getComputedStyle(w).display === 'none') continue; const b = w.querySelector('.ant-modal-close') || [...w.querySelectorAll('button')].find((x) => /取消|关闭|知道了/.test(x.innerText)); if (b) { b.click(); n++; } } document.body.click(); return n; }
    }; return true; })()`);

  // 添加站点（公开 Nyaa + 私有 织梦）
  const addSite = async (query) => {
    await ev(`(location.hash="#/set-site", true)`); await sleep(2400);
    await ev(`([...document.querySelectorAll('#ptd-main button')].find(b=>/增加|添加/.test(b.innerText))?.click(), true)`); await sleep(1400);
    await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const s=w?.querySelector('.ant-select-selector'); if(!s) return false; s.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); s.click(); const inp=[...document.querySelectorAll('.ant-select input')].pop(); if(inp){ inp.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp, ${JSON.stringify(query)}); inp.dispatchEvent(new Event('input',{bubbles:true})); } return true; })()`);
    await sleep(1500);
    await ev(`(() => { const o=document.querySelector('.ant-select-item-option'); o?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); o?.click(); return !!o; })()`); await sleep(1000);
    await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const b=[...w.querySelectorAll('button')].find(x=>/下一步/.test(x.innerText)); if(!b||b.disabled) return false; b.click(); return true; })()`); await sleep(2200);
    await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const b=[...w.querySelectorAll('button')].find(x=>/完成|确定|保存/.test(x.innerText.replace(/\\s+/g,''))); if(!b||b.disabled) return false; b.click(); return true; })()`); await sleep(2500);
    return await ev(`(async () => Object.keys((await chrome.storage.local.get('metadata')).metadata?.sites || {}))()`);
  };
  report.setup.push({ afterNyaa: await addSite("Nyaa") });
  report.setup.push({ afterZmpt: await addSite("织梦") });

  const ROUTES = [["#/", "Overview"], ["#/my-data", "MyData"], ["#/search-entity", "SearchEntity"], ["#/search-result-snapshot", "SearchResultSnapshot"], ["#/media-server-entity", "MediaServerEntity"], ["#/my-client", "MyClient"], ["#/download-history", "DownloadHistory"], ["#/keep-upload-task", "KeepUploadTask"], ["#/settings", "Settings"], ["#/set-site", "SetSite"], ["#/set-search-solution", "SetSearchSolution"], ["#/set-downloader", "SetDownloader"], ["#/set-media-server", "SetMediaServer"], ["#/set-backup", "SetBackup"]];
  for (const [hash, name] of ROUTES) {
    await ev(`(location.hash=${JSON.stringify(hash)}, true)`); await sleep(2600);
    await ev(`(window.__q.close(), true)`); await sleep(600);
    const res = await ev(`(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const out=[]; const els=window.__q.list();
      for (let i=0;i<els.length;i++){
        const el=els[i]; const info=window.__q.info(el);
        if (info.disabled) { out.push({...info, act:'disabled'}); continue; }
        if (info.covered) { out.push({...info, act:'covered'}); continue; }
        let count=0; const obs=new MutationObserver((recs)=>{count+=recs.length;});
        obs.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
        try { el.click(); } catch(e){ obs.disconnect(); out.push({...info, act:'threw' }); continue; }
        await sleep(1200);
        obs.disconnect();
        out.push({...info, act: count>0?'changed':'no-effect', mutations:count});
        document.body.click(); await sleep(250);
        if ([...document.querySelectorAll('.ant-modal-wrap')].some(w=>getComputedStyle(w).display!=='none')) { window.__q.close(); await sleep(500); }
      }
      return out;
    })()`);
    report.routes.push({ name, hash, clicks: res });
    await shot("p4-" + name);
  }
  writeFileSync(".review-logs/btn-probe4.json", JSON.stringify(report, null, 2));
  console.log("setup:", JSON.stringify(report.setup));
  console.log("\n=== 每路由 ===");
  for (const r of report.routes) {
    const c = Array.isArray(r.clicks) ? r.clicks : [];
    console.log(` ${r.name.padEnd(22)} 可见=${String(c.length).padStart(2)} 无反应=${c.filter((x) => x.act === 'no-effect').length} 有反应=${c.filter((x) => x.act === 'changed').length} 禁用=${c.filter((x) => x.act === 'disabled').length} 遮挡=${c.filter((x) => x.act === 'covered').length}`);
  }
  console.log("\n=== 无反应按钮（排除危险操作）===");
  for (const r of report.routes) for (const c of Array.isArray(r.clicks) ? r.clicks : []) {
    if (c.act !== "no-effect") continue;
    if (DANGER.test(c.text)) { console.log(` [${r.name}] (跳过危险操作) "${c.text}"`); continue; }
    console.log(` [${r.name}] "${c.text}" rect=${JSON.stringify(c.rect)}`);
  }
  console.log("\n=== 被遮挡 ===");
  for (const r of report.routes) for (const c of Array.isArray(r.clicks) ? r.clicks : []) if (c.act === "covered") console.log(` [${r.name}] "${c.text}" by ${c.covered}`);
  console.log("\nexceptions:", report.exceptions.slice(0, 6));
  console.log("consoleErrors:", report.consoleErrors.slice(0, 6));
  ws.close(); bws.close();
} catch (e) { console.log("ERR", e.stack); writeFileSync(".review-logs/btn-probe4.json", JSON.stringify(report, null, 2)); } finally { chrome.kill("SIGKILL"); }
