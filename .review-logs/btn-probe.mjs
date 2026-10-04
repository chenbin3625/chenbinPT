// 按钮失效探针：真实 Chrome 加载 dist 扩展，逐路由检查按钮是否被遮挡 / 点击是否有任何效果。
// 用法: node .review-logs/btn-probe.mjs [distDir] [routeHashFilter]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist-chrome");
const ONLY = process.argv[3] ?? "";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9351;
const profile = mkdtempSync(join(tmpdir(), "ptd-bt-"));
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
    `--load-extension=${DIST}`,
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const report = { console: [], exceptions: [], routes: [], failedClicks: [], coveredButtons: [], fatal: null };

async function json(path, init) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
async function waitFor(fn, timeoutMs = 30000, label = "") {
  const t0 = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting ${label}: ${err?.message ?? err}`);
      await sleep(250);
    }
  }
}

try {
  await waitFor(async () => (await json("/json/version")).Browser, 30000, "devtools");

  // 用 CDP Extensions.loadUnpacked 加载扩展（Chrome 137+ 已忽略命令行 --load-extension）
  const browserWs = new WebSocket((await json("/json/version")).webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    browserWs.onopen = res;
    browserWs.onerror = rej;
  });
  let bid = 0;
  const bpending = new Map();
  browserWs.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && bpending.has(m.id)) {
      const { resolve: r } = bpending.get(m.id);
      bpending.delete(m.id);
      r(m);
    }
  };
  const bsend = (method, params = {}) =>
    new Promise((r) => {
      const i = ++bid;
      bpending.set(i, { resolve: r });
      browserWs.send(JSON.stringify({ id: i, method, params }));
    });
  const loaded = await bsend("Extensions.loadUnpacked", { path: DIST });
  if (!loaded?.result?.id) throw new Error("Extensions.loadUnpacked failed: " + JSON.stringify(loaded).slice(0, 300));
  const extId = loaded.result.id;
  report.extensionId = extId;
  browserWs.close();
  await sleep(1500);
  const base = `chrome-extension://${extId}/src/entries/options/index.html`;

  const target = await waitFor(async () => json(`/json/new?${encodeURIComponent(base)}`, { method: "PUT" }), 20000, "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: r, reject: j } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? j(new Error(JSON.stringify(msg.error))) : r(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(" ");
      report.console.push({ level: msg.params.type, text: text.slice(0, 600) });
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      report.exceptions.push({ text: d.text, desc: (d.exception?.description ?? "").slice(0, 900) });
    } else if (msg.method === "Log.entryAdded") {
      report.console.push({ level: `log:${msg.params.entry.level}`, text: `[${msg.params.entry.source}] ${msg.params.entry.text}`.slice(0, 600) });
    }
  };
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const i = ++id;
      pending.set(i, { resolve: r, reject: j });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) return { __err: JSON.stringify(res.exceptionDetails).slice(0, 600) };
    return res.result.value;
  };

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: base });
  try {
    await waitFor(
      async () => {
        const ok = await evaluate(`!!document.querySelector("#ptd-navigation, #ptd-topbar, #ptd-main")`);
        if (ok !== true) throw new Error("app not mounted: " + JSON.stringify(ok).slice(0, 200));
        return true;
      },
      40000,
      "app mount",
    );
  } catch (err) {
    report.mountFailure = {
      error: String(err?.message ?? err),
      url: await evaluate(`location.href`),
      title: await evaluate(`document.title`),
      body: String(await evaluate(`document.body ? document.body.innerText.slice(0,600) : "(no body)"`)),
      appKids: await evaluate(`document.querySelector("#app") ? document.querySelector("#app").childElementCount : -1`),
    };
    throw err;
  }
  await sleep(2500);
  report.boot = await evaluate(`({ title: document.title, href: location.href, nav: document.querySelectorAll("#ptd-navigation .ant-menu-item").length })`);

  // 页面内注入工具：按钮遮挡检测 + 点击观测
  await evaluate(`(() => {
    window.__probe = {
      sig() {
        const modal = [...document.querySelectorAll('.ant-modal-wrap')].filter(w => getComputedStyle(w).display !== 'none').length;
        const drawer = [...document.querySelectorAll('.ant-drawer')].filter(w => getComputedStyle(w).display !== 'none').length;
        const dd = [...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden), .ant-select-dropdown:not(.ant-select-dropdown-hidden)')].filter(w => getComputedStyle(w).display !== 'none').length;
        const toast = document.querySelectorAll('.ant-message-notice, .ant-notification-notice').length;
        const main = document.querySelector('#ptd-main');
        return [modal, drawer, dd, toast, main ? main.innerText.length : -1, document.querySelectorAll('#ptd-main *').length, document.documentElement.outerHTML.length].join('|');
      },
      info(el) {
        const t = (el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\\s+/g,' ').trim().slice(0,40);
        const r = el.getBoundingClientRect();
        const cx = Math.round(r.left + r.width/2), cy = Math.round(r.top + r.height/2);
        let hit = null, covered = null;
        if (r.width > 0 && r.height > 0 && cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight) {
          const top = document.elementFromPoint(cx, cy);
          hit = top ? (top.tagName + '.' + (top.className && typeof top.className === 'string' ? top.className.split(' ').slice(0,2).join('.') : '')) : null;
          if (top && !el.contains(top) && top !== el) covered = hit;
        }
        return { text: t, cls: (el.className||'').toString().slice(0,60), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', covered, rect: [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)] };
      },
      buttons(scope) {
        const root = scope ? document.querySelector(scope) : document;
        return [...root.querySelectorAll('button, .ant-btn, [role="menuitem"], .ant-switch, .ant-pagination-item')];
      }
    };
    return true;
  })()`);

  const ROUTES = [
    ["#/", "Overview"],
    ["#/my-data", "MyData"],
    ["#/search-entity", "SearchEntity"],
    ["#/media-server-entity", "MediaServerEntity"],
    ["#/my-client", "MyClient"],
    ["#/download-history", "DownloadHistory"],
    ["#/keep-upload-task", "KeepUploadTask"],
    ["#/settings", "Settings"],
    ["#/set-base", "SetBase"],
    ["#/set-site", "SetSite"],
    ["#/set-search-solution", "SetSearchSolution"],
    ["#/set-downloader", "SetDownloader"],
    ["#/set-media-server", "SetMediaServer"],
    ["#/set-backup", "SetBackup"],
    ["#/search-result-snapshot", "SearchResultSnapshot"],
  ].filter(([h, n]) => !ONLY || h.includes(ONLY) || n.toLowerCase().includes(ONLY.toLowerCase()));

  for (const [hash, name] of ROUTES) {
    await evaluate(`(async () => { location.hash = ${JSON.stringify(hash)}; return true; })()`);
    await sleep(2200);
    const beforeConsole = report.console.length;
    const beforeEx = report.exceptions.length;

    const meta = await evaluate(`(() => {
      const main = document.querySelector('#ptd-main');
      return { hash: location.hash, textLen: (main?.innerText ?? '').length, buttons: window.__probe.buttons('#ptd-main').length, topbarButtons: window.__probe.buttons('#ptd-topbar').length };
    })()`);

    // 遮挡检测：一次拿到所有按钮的几何+命中信息
    const coverScan = await evaluate(`(() => {
      const out = [];
      for (const el of window.__probe.buttons('#ptd-main')) {
        const i = window.__probe.info(el);
        out.push(i);
      }
      return out;
    })()`);
    if (Array.isArray(coverScan)) {
      for (const b of coverScan) {
        if (b.covered) report.coveredButtons.push({ route: name, ...b });
      }
    }

    // 逐个点击：只点"安全"的前若干个（避免触发真实下载/删除），记录异常与状态变化
    const clickResult = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const els = window.__probe.buttons('#ptd-main').slice(0, 12);
      const out = [];
      for (const el of els) {
        const info = window.__probe.info(el);
        if (info.disabled || info.covered || info.rect[2] === 0) { out.push({ ...info, action: 'skipped' }); continue; }
        const s0 = window.__probe.sig();
        const e0 = window.__errCount || 0;
        try { el.click(); } catch (e) { out.push({ ...info, action: 'click-threw', err: String(e).slice(0,200) }); continue; }
        await sleep(700);
        const s1 = window.__probe.sig();
        out.push({ ...info, action: s0 === s1 ? 'no-effect' : 'changed' });
        // 关掉可能弹出的弹层，避免影响后续点击
        const wrap = document.querySelector('.ant-modal-wrap');
        if (wrap && getComputedStyle(wrap).display !== 'none') {
          document.querySelector('.ant-modal-close')?.click();
          await sleep(400);
        }
        const openDd = document.activeElement;
        if (openDd && openDd.blur) openDd.blur();
        document.body.click();
        await sleep(200);
      }
      return out;
    })()`);

    report.routes.push({ name, hash, meta, clicks: clickResult, newConsole: report.console.slice(beforeConsole), newExceptions: report.exceptions.slice(beforeEx) });
    if (Array.isArray(clickResult)) {
      for (const c of clickResult) {
        if (c.action === "no-effect" || c.action === "click-threw") report.failedClicks.push({ route: name, ...c });
      }
    }
  }
  ws.close();
} catch (err) {
  report.fatal = String(err?.stack ?? err);
} finally {
  chrome.kill("SIGKILL");
}

writeFileSync(".review-logs/btn-probe.json", JSON.stringify(report, null, 2));
console.log(`fatal: ${report.fatal ?? "none"}`);
console.log(`console entries: ${report.console.length}, exceptions: ${report.exceptions.length}`);
console.log(`covered buttons: ${report.coveredButtons.length}`);
console.log(`no-effect clicks: ${report.failedClicks.length}`);
console.log("=== exceptions ===");
for (const e of report.exceptions.slice(0, 10)) console.log(" -", e.text, "|", (e.desc || "").split("\n")[0]);
console.log("=== console (warn/error) ===");
for (const c of report.console.filter((c) => c.level.includes("error") || c.level.includes("warn")).slice(0, 20)) console.log(" -", c.level, c.text.slice(0, 200));
console.log("=== per-route summary ===");
for (const r of report.routes) {
  const ne = (r.clicks ?? []).filter((c) => c.action === "no-effect").length;
  console.log(` ${r.name}: buttons=${r.meta?.buttons} covered=${(r.clicks ?? []).filter((c) => c.covered).length} noEffect=${ne} exc=${r.newExceptions.length} console=${r.newConsole.length}`);
}
