// 探针 v3：先用 UI 添加一个公开站点，然后在有数据的情况下全路由扫描按钮
// 用法: node .review-logs/btn-probe3.mjs [distDir]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "/tmp/ptd-freeze");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9401;
const profile = mkdtempSync(join(tmpdir(), "ptd-bt3-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(".review-logs/shots", { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  "--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch,Translate",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
const json = async (p, i) => (await fetch(`http://127.0.0.1:${PORT}${p}`, i)).json();
const report = { setup: [], routes: [], exceptions: [], consoleErrors: [], dead: [] };
try {
  await sleep(2500);
  const ver = await json("/json/version");
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
  let bid = 0; const bp = new Map();
  const bsend = (method, params = {}, sid) => new Promise((r) => { const i = ++bid; bp.set(i, r); bws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) })); });
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
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
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
  await sleep(1500);
  await ev(`(() => {
    window.__p = {
      btn() { return [...document.querySelectorAll('#ptd-main button, #ptd-main .ant-switch, #ptd-main .ant-pagination-item, #ptd-main .ant-tabs-tab')].filter(el => el.offsetParent !== null || el.getClientRects().length); },
      sig() { const c=(s)=>[...document.querySelectorAll(s)].filter(w=>getComputedStyle(w).display!=='none').length; const m=document.querySelector('#ptd-main'); return [c('.ant-modal-wrap'),c('.ant-drawer'),c('.ant-dropdown:not(.ant-dropdown-hidden), .ant-select-dropdown:not(.ant-select-dropdown-hidden)'),c('.ant-message-notice'),m?m.innerText.length:-1,m?m.querySelectorAll('*').length:-1].join('|'); },
      close() { for (const w of [...document.querySelectorAll('.ant-modal-wrap')]) { if (getComputedStyle(w).display==='none') continue; const b=w.querySelector('.ant-modal-close')||[...w.querySelectorAll('button')].find(x=>/取消|关闭|知道了/.test(x.innerText)); if(b) b.click(); } document.body.click(); },
      info(el) { const r=el.getBoundingClientRect(); const t=(el.innerText||el.title||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim().slice(0,40); const cx=Math.round(r.left+r.width/2), cy=Math.round(r.top+r.height/2); let covered=null; if(r.width>0&&r.height>0&&cx>0&&cy>0&&cx<innerWidth&&cy<innerHeight){const top=document.elementFromPoint(cx,cy); if(top&&!el.contains(top)&&top!==el) covered=top.tagName+'.'+(typeof top.className==='string'?top.className.split(' ').slice(0,2).join('.'):'');} return {text:t,disabled:!!el.disabled||el.getAttribute('aria-disabled')==='true',covered,rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]}; }
    }; return true; })()`);

  // ── 1. 添加一个公开站点（Nyaa）────────────────────────────────
  const addSite = async () => {
    await ev(`(location.hash="#/set-site", true)`); await sleep(2500);
    await ev(`([...document.querySelectorAll('#ptd-main button')].find(b=>/增加|添加/.test(b.innerText))?.click(), true)`);
    await sleep(1500);
    await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const s=w?.querySelector('.ant-select-selector'); s?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); s?.click(); return true; })()`);
    await sleep(800);
    await ev(`(() => { const inp=[...document.querySelectorAll('.ant-select input')].pop(); if(!inp) return false; inp.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp,'Nyaa'); inp.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    await sleep(1500);
    const optCount = await ev(`document.querySelectorAll('.ant-select-item-option').length`);
    const filtered = await ev(`[...document.querySelectorAll('.ant-select-item-option')].map(o=>o.innerText.split('\\n')[0]).slice(0,6)`);
    report.setup.push({ step: "键入 Nyaa 后的候选", optCount, filtered });
    await ev(`(() => { const o=[...document.querySelectorAll('.ant-select-item-option')].find(x=>/Nyaa/i.test(x.innerText))||document.querySelector('.ant-select-item-option'); o?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); o?.click(); return !!o; })()`);
    await sleep(1200);
    await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const b=[...w.querySelectorAll('button')].find(x=>/下一步/.test(x.innerText)); if(!b||b.disabled) return false; b.click(); return true; })()`);
    await sleep(2500);
    const editorButtons = await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); return w?[...w.querySelectorAll('button')].map(b=>({t:b.innerText.replace(/\\s+/g,' ').trim(),d:b.disabled})).filter(b=>b.t):null; })()`);
    report.setup.push({ step: "编辑步骤的按钮", editorButtons });
    await shot("p3-editor");
    const okClicked = await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); const b=[...w.querySelectorAll('button')].find(x=>/完成|确定|保存/.test(x.innerText.replace(/\\s+/g,''))); if(!b) return {found:false}; if(b.disabled) return {found:true,disabled:true}; b.click(); return {found:true,disabled:false}; })()`);
    await sleep(3000);
    const after = await ev(`({ modalOpen: [...document.querySelectorAll('.ant-modal-wrap')].some(x=>getComputedStyle(x).display!=='none'), rows: document.querySelectorAll('#ptd-main .ant-table-tbody tr').length })`);
    report.setup.push({ step: "点击完成", okClicked, after });
    await shot("p3-after-save");
  };
  await addSite();

  const sites = await ev(`(async () => Object.keys((await chrome.storage.local.get('metadata')).metadata?.sites || {}))()`);
  report.setup.push({ step: "storage.sites", sites });

  // ── 2. 全路由按钮扫描 ────────────────────────────────────────
  const ROUTES = [["#/", "Overview"], ["#/my-data", "MyData"], ["#/search-entity", "SearchEntity"], ["#/search-result-snapshot", "SearchResultSnapshot"], ["#/media-server-entity", "MediaServerEntity"], ["#/my-client", "MyClient"], ["#/download-history", "DownloadHistory"], ["#/keep-upload-task", "KeepUploadTask"], ["#/settings", "Settings"], ["#/set-site", "SetSite"], ["#/set-search-solution", "SetSearchSolution"], ["#/set-downloader", "SetDownloader"], ["#/set-media-server", "SetMediaServer"], ["#/set-backup", "SetBackup"]];
  for (const [hash, name] of ROUTES) {
    await ev(`(location.hash=${JSON.stringify(hash)}, true)`);
    await sleep(2600);
    await ev(`(window.__p.close(), true)`); await sleep(500);
    const res = await ev(`(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const out=[]; const els=window.__p.btn();
      for (let i=0;i<els.length;i++){
        const el=els[i]; const info=window.__p.info(el);
        if (info.disabled) { out.push({...info, act:'disabled'}); continue; }
        if (info.covered) { out.push({...info, act:'covered'}); continue; }
        if (info.rect[2]===0||info.rect[3]===0) { out.push({...info, act:'zero'}); continue; }
        const s0=window.__p.sig();
        try { el.click(); } catch(e){ out.push({...info, act:'threw', err:String(e).slice(0,150)}); continue; }
        await sleep(650);
        const s1=window.__p.sig();
        out.push({...info, act: s0===s1?'no-effect':'changed', s0, s1});
        if ([...document.querySelectorAll('.ant-modal-wrap')].some(w=>getComputedStyle(w).display!=='none')) { window.__p.close(); await sleep(500); }
        else { document.body.click(); await sleep(150); }
      }
      return out;
    })()`);
    report.routes.push({ name, hash, clicks: res });
    if (Array.isArray(res)) {
      for (const c of res) if (c.act === "no-effect" || c.act === "covered" || c.act === "threw") report.dead.push({ route: name, ...c });
    }
    await shot("p3-" + name);
  }
  writeFileSync(".review-logs/btn-probe3.json", JSON.stringify(report, null, 2));
  console.log("setup:", JSON.stringify(report.setup, null, 1));
  console.log("\n每路由统计:");
  for (const r of report.routes) {
    const c = Array.isArray(r.clicks) ? r.clicks : [];
    console.log(` ${r.name.padEnd(22)} 可见按钮=${c.length} no-effect=${c.filter(x=>x.act==='no-effect').length} covered=${c.filter(x=>x.act==='covered').length} changed=${c.filter(x=>x.act==='changed').length} disabled=${c.filter(x=>x.act==='disabled').length}`);
  }
  console.log("\n无反应/被遮挡的按钮:");
  for (const d of report.dead) console.log(` [${d.route}] ${d.act} "${d.text}" rect=${d.rect} ${d.covered ? "coveredBy " + d.covered : ""}`);
  console.log("\nexceptions:", report.exceptions.slice(0, 8));
  console.log("console errors:", report.consoleErrors.slice(0, 8));
  ws.close(); bws.close();
} catch (e) { console.log("ERR", e.stack); writeFileSync(".review-logs/btn-probe3.json", JSON.stringify(report, null, 2)); } finally { chrome.kill("SIGKILL"); }
