// 按钮失效探针 v2：先关掉首次运行弹窗，再逐路由点击按钮，记录异常 / 无效果 / 报错。
// 用法: node .review-logs/btn-probe2.mjs [distDir] [routeFilter]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist-chrome");
const ONLY = process.argv[3] ?? "";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9363;
const profile = mkdtempSync(join(tmpdir(), "ptd-bt2-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(
  CHROME,
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-extension-debugging",
    "--disable-features=DisableLoadExtensionCommandLineSwitch,Translate",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1440,900", "about:blank",
  ],
  { stdio: "ignore" },
);
const json = async (p, i) => (await fetch(`http://127.0.0.1:${PORT}${p}`, i)).json();

const report = { console: [], exceptions: [], routes: [], suspicious: [], fatal: null };
try {
  await sleep(2500);
  const ver = await json("/json/version");
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
  let bid = 0; const bp = new Map();
  bws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && bp.has(m.id)) { bp.get(m.id)(m); bp.delete(m.id); } };
  const bsend = (method, params = {}) => new Promise((r) => { const i = ++bid; bp.set(i, r); bws.send(JSON.stringify({ id: i, method, params })); });
  const loaded = await bsend("Extensions.loadUnpacked", { path: DIST });
  if (!loaded?.result?.id) throw new Error("loadUnpacked failed " + JSON.stringify(loaded).slice(0, 200));
  const extId = loaded.result.id;
  report.extensionId = extId;
  bws.close();
  await sleep(1200);

  const base = `chrome-extension://${extId}/src/entries/options/index.html`;
  const target = await json(`/json/new?${encodeURIComponent(base)}`, { method: "PUT" });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(" ");
      report.console.push({ level: m.params.type, text: text.slice(0, 700) });
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      report.exceptions.push({ text: d.text, desc: (d.exception?.description ?? "").slice(0, 900) });
    } else if (m.method === "Log.entryAdded") {
      report.console.push({ level: `log:${m.params.entry.level}`, text: `[${m.params.entry.source}] ${m.params.entry.text}`.slice(0, 700) });
    }
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.result?.exceptionDetails) return { __err: JSON.stringify(res.result.exceptionDetails).slice(0, 700) };
    return res.result?.result?.value;
  };
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Page.navigate", { url: base });
  for (let i = 0; i < 80; i++) { if ((await ev(`!!document.querySelector("#ptd-main")`)) === true) break; await sleep(500); }
  await sleep(3000);

  const INJECT = `(() => {
    window.__probe = {      sig() {
        const cnt = (s) => [...document.querySelectorAll(s)].filter(w => getComputedStyle(w).display !== 'none').length;
        const main = document.querySelector('#ptd-main');
        return [cnt('.ant-modal-wrap'), cnt('.ant-drawer'), cnt('.ant-dropdown:not(.ant-dropdown-hidden), .ant-select-dropdown:not(.ant-select-dropdown-hidden)'), cnt('.ant-message-notice'), main ? main.innerText.length : -1, main ? main.querySelectorAll('*').length : -1, document.documentElement.outerHTML.length].join('|');
      },
      closeAll() {
        let n = 0;
        for (const w of [...document.querySelectorAll('.ant-modal-wrap')]) {
          if (getComputedStyle(w).display === 'none') continue;
          const btn = w.querySelector('.ant-modal-close') || [...w.querySelectorAll('button')].find(b => /开始使用|确定|知道了|关闭|OK/i.test(b.innerText));
          if (btn) { btn.click(); n++; }
        }
      },
      list(scope) {
        const root = scope ? document.querySelector(scope) : document;
        return [...root.querySelectorAll('button, .ant-btn, [role="menuitem"], .ant-switch, .ant-pagination-item, .ant-tabs-tab')];
      },
      info(el) {
        const t = (el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\\s+/g, ' ').trim().slice(0, 45);
        const r = el.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        let covered = null;
        if (r.width > 0 && r.height > 0 && cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight) {
          const top = document.elementFromPoint(cx, cy);
          if (top && !el.contains(top) && top !== el) covered = top.tagName + '.' + (typeof top.className === 'string' ? top.className.split(' ').slice(0, 2).join('.') : '');
        }
        return { text: t, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', covered, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
      }
    };
    return true;
  })()`;
  await ev(INJECT);

  // 关掉首次运行 / 更新日志弹窗
  await ev(`(window.__probe.closeAll(), true)`);
  await sleep(800);
  await ev(`(window.__probe.closeAll(), true)`);
  await sleep(1200);
  report.afterWelcome = await ev(`({ modals: [...document.querySelectorAll('.ant-modal-wrap')].filter(w=>getComputedStyle(w).display!=='none').length })`);

  const ROUTES = [
    ["#/", "Overview"], ["#/my-data", "MyData"], ["#/search-entity", "SearchEntity"],
    ["#/media-server-entity", "MediaServerEntity"], ["#/my-client", "MyClient"], ["#/download-history", "DownloadHistory"],
    ["#/keep-upload-task", "KeepUploadTask"], ["#/settings", "Settings"], ["#/set-base", "SetBase"],
    ["#/set-site", "SetSite"], ["#/set-search-solution", "SetSearchSolution"], ["#/set-downloader", "SetDownloader"],
    ["#/set-media-server", "SetMediaServer"], ["#/set-backup", "SetBackup"], ["#/search-result-snapshot", "SearchResultSnapshot"],
    ["#/user-data-timeline", "UserDataTimeline"], ["#/user-data-statistic", "UserDataStatistic"],
  ].filter(([h, n]) => !ONLY || h.includes(ONLY) || n.toLowerCase().includes(ONLY.toLowerCase()));

  const DANGER = /删除|移除|清空|重置|覆盖|格式化|退出|注销|停止|取消任务/i;

  for (const [hash, name] of ROUTES) {
    await ev(`(location.hash = ${JSON.stringify(hash)}, true)`);
    await sleep(2600);
    await ev(INJECT);
    await ev(`(window.__probe.closeAll(), true)`);
    await sleep(600);
    const c0 = report.console.length, e0 = report.exceptions.length;
    const meta = await ev(`(() => {
      const main = document.querySelector('#ptd-main');
      return { hash: location.hash, textLen: (main?.innerText ?? '').length, buttons: window.__probe.list('#ptd-main').length, topbar: window.__probe.list('#ptd-topbar').length, nav: window.__probe.list('#ptd-navigation').length };
    })()`);

    const clicks = await ev(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = [];
      const els = window.__probe.list('#ptd-main');
      for (let i = 0; i < els.length && out.length < 25; i++) {
        const el = els[i];
        const info = window.__probe.info(el);
        if (info.disabled) { out.push({ i, ...info, action: 'disabled' }); continue; }
        if (info.covered) { out.push({ i, ...info, action: 'covered' }); continue; }
        if (info.rect[2] === 0 || info.rect[3] === 0) { out.push({ i, ...info, action: 'invisible' }); continue; }
        const s0 = window.__probe.sig();
        try { el.click(); } catch (e) { out.push({ i, ...info, action: 'threw', err: String(e).slice(0, 200) }); continue; }
        await sleep(600);
        const s1 = window.__probe.sig();
        const openModal = [...document.querySelectorAll('.ant-modal-wrap')].some(w => getComputedStyle(w).display !== 'none');
        const openDd = [...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden), .ant-select-dropdown:not(.ant-select-dropdown-hidden)')].some(w => getComputedStyle(w).display !== 'none');
        out.push({ i, ...info, action: s0 === s1 ? 'no-effect' : 'changed', modalOpened: openModal && !s0.endsWith('|' + document.documentElement.outerHTML.length), ddOpened: openDd, sig0: s0, sig1: s1 });
        if (openModal) { window.__probe.closeAll(); await sleep(500); }
        if (openDd) { document.body.click(); await sleep(250); }
      }
      return out;
    })()`);

    report.routes.push({ name, hash, meta, clicks, newConsole: report.console.slice(c0), newExceptions: report.exceptions.slice(e0) });
    if (Array.isArray(clicks)) {
      for (const c of clicks) {
        if (c.action === 'no-effect' || c.action === 'threw' || c.action === 'covered') {
          if (c.text && DANGER.test(c.text)) continue;
          report.suspicious.push({ route: name, ...c });
        }
      }
    }
  }
  ws.close();
} catch (err) {
  report.fatal = String(err?.stack ?? err);
} finally {
  chrome.kill("SIGKILL");
}
writeFileSync(".review-logs/btn-probe2.json", JSON.stringify(report, null, 2));
console.log("fatal:", report.fatal ?? "none");
console.log("exceptions:", report.exceptions.length, "console:", report.console.length);
console.log("suspicious (no-effect/covered/threw):", report.suspicious.length);
console.log("=== per route ===");
for (const r of report.routes) {
  const cl = Array.isArray(r.clicks) ? r.clicks : [];
  const ne = cl.filter((c) => c.action === 'no-effect').length;
  console.log(` ${r.name}: btns=${r.meta?.buttons} noEffect=${ne} covered=${cl.filter((c) => c.action === 'covered').length} changed=${cl.filter((c) => c.action === 'changed').length} exc=${r.newExceptions.length} newConsole=${r.newConsole.length} textLen=${r.meta?.textLen}`);
}
console.log("=== no-effect samples ===");
for (const s of report.suspicious.filter((s) => s.action === 'no-effect').slice(0, 40)) console.log(` [${s.route}] "${s.text}" rect=${s.rect} sig0=${s.sig0} sig1=${s.sig1}`);
console.log("=== exceptions ===");
for (const e of report.exceptions.slice(0, 25)) console.log(" EXC", e.text, "|", (e.desc || "").split("\n").slice(0, 2).join(" / "));
console.log("=== console error/warn ===");
for (const c of report.console.filter((c) => /error|warn/.test(c.level)).slice(0, 30)) console.log(" ", c.level, c.text.slice(0, 220));
