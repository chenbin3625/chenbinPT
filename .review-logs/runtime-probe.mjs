// 迁移后运行时验收探针：用真实 Chrome 加载 dist 扩展，驱动 options 页面路由与交互，
// 收集 console 错误/警告、Vue 警告、异常与渲染结果。
// 用法: node .review-logs/runtime-probe.mjs <distDir> <options|content> [outPng]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist-chrome");
const MODE = process.argv[3] ?? "options";
const OUT_PNG = process.argv[4] ?? "";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9337;
const profile = mkdtempSync(join(tmpdir(), "ptd-rt-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

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

async function json(path, init) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const report = { mode: MODE, dist: DIST, extensionId: null, console: [], exceptions: [], routes: [], interactions: [], fatal: null };

try {
  await waitFor(async () => (await json("/json/version")).Browser, 30000, "chrome devtools");

  const extId = await waitFor(
    async () => {
      const targets = await json("/json/list");
      const sw = targets.find((t) => t.url.startsWith("chrome-extension://") && t.type === "service_worker");
      if (!sw) throw new Error("no service_worker target yet");
      return new URL(sw.url).host;
    },
    30000,
    "extension service worker",
  );
  report.extensionId = extId;
  const base = `chrome-extension://${extId}/src/entries/options/index.html`;

  const target = await waitFor(async () => json(`/json/new?${encodeURIComponent(base)}`, { method: "PUT" }), 20000, "page target");
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
      const text = (msg.params.args ?? [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type))
        .join(" ");
      report.console.push({ level: msg.params.type, text: text.slice(0, 800) });
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      report.exceptions.push({ text: d.text, desc: (d.exception?.description ?? "").slice(0, 1200), url: d.url, line: d.lineNumber });
    } else if (msg.method === "Log.entryAdded") {
      report.console.push({ level: `log:${msg.params.entry.level}`, text: `[${msg.params.entry.source}] ${msg.params.entry.text}`.slice(0, 800) });
    }
  };
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const msgId = ++id;
      pending.set(msgId, { resolve: r, reject: j });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const evaluate = async (expression, awaitPromise = true) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 500));
    return res.result.value;
  };

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  // 启用监听后再导航，确保能抓到入口脚本早期的报错
  await send("Page.navigate", { url: base });

  // 等应用挂载
  try {
    await waitFor(
      async () => {
        const ok = await evaluate(`!!document.querySelector("#ptd-navigation, #ptd-topbar, #ptd-main")`);
        if (!ok) throw new Error("app not mounted");
        return ok;
      },
      40000,
      "app mount",
    );
  } catch (err) {
    report.mountFailure = {
      error: String(err?.message ?? err),
      url: await evaluate(`location.href`),
      html: (await evaluate(`document.documentElement.outerHTML`)).slice(0, 3000),
      bodyText: (await evaluate(`document.body?.innerText ?? ""`)).slice(0, 500),
    };
    throw err;
  }
  await sleep(2500);

  report.boot = await evaluate(`(() => {
    const html = document.documentElement;
    const vars = ["--ptd-bg","--ptd-text","--ptd-surface","--ptd-border","--ptd-text-secondary","--ptd-text-tertiary","--ptd-text-quaternary","--ptd-border-secondary","--ptd-primary","--ptd-error","--ptd-warning","--ptd-success","--ptd-fill","--ptd-hover"];
    const defined = {}, missing = [];
    for (const v of vars) { const val = getComputedStyle(html).getPropertyValue(v).trim(); if (val) defined[v] = val; else missing.push(v); }
    // 全站 style.css 里实际用到的 --ptd-* 变量（从已加载样式表读取）
    const used = new Set();
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      const walk = (list) => { for (const r of list) { if (r.cssRules) walk(r.cssRules); if (r.style) { for (const p of r.style) if (p.startsWith("--")) used.add(p); } if (r.cssText) for (const m of r.cssText.matchAll(/var\\((--ptd-[a-z-]+)/g)) used.add(m[1]); } };
      walk(rules);
    }
    const varDump = {};
    for (const v of used) varDump[v] = getComputedStyle(html).getPropertyValue(v).trim() || "(未定义)";
    return {
      title: document.title,
      hash: location.hash,
      topbar: !!document.querySelector("#ptd-topbar"),
      navItems: document.querySelectorAll("#ptd-navigation .ant-menu-item").length,
      mainChildren: document.querySelector("#ptd-main")?.childElementCount ?? -1,
      defined, missing,
      usedVars: varDump,
      undefinedVars: Object.entries(varDump).filter(([, v]) => v === "(未定义)").map(([k]) => k),
    };
  })()`);

  const ROUTES = [
    ["#/", "Overview"],
    ["#/my-data", "MyData"],
    ["#/search-entity", "SearchEntity"],
    ["#/search-result-snapshot", "SearchResultSnapshot"],
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
    ["#/user-data-timeline", "UserDataTimeline"],
    ["#/user-data-statistic", "UserDataStatistic"],
    ["#/link-push", "ContextMenuLinkPush"],
  ];

  for (const [hash, name] of ROUTES) {
    const before = report.console.length;
    const beforeEx = report.exceptions.length;
    await evaluate(`(async () => { location.hash = ${JSON.stringify(hash)}; return true; })()`);
    await sleep(2200);
    const info = await evaluate(`(() => {
      const main = document.querySelector("#ptd-main");
      const text = (main?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 200);
      return {
        hash: location.hash,
        mainChildren: main?.childElementCount ?? -1,
        text,
        textLen: (main?.innerText ?? "").length,
        cards: document.querySelectorAll("#ptd-main .ant-card").length,
        tables: document.querySelectorAll("#ptd-main .ant-table").length,
        buttons: document.querySelectorAll("#ptd-main button").length,
        switches: document.querySelectorAll("#ptd-main .ant-switch").length,
        skeleton: document.querySelectorAll("#ptd-main .ant-skeleton").length,
        empty: document.querySelectorAll("#ptd-main .ant-empty").length,
        spin: document.querySelectorAll("#ptd-main .ant-spin").length,
        visibleModal: document.querySelectorAll(".ant-modal-wrap:not([style*='display: none']) .ant-modal").length,
      };
    })()`);
    report.routes.push({ name, ...info, newConsole: report.console.slice(before), newExceptions: report.exceptions.slice(beforeEx) });
  }

  if (MODE === "options") {
    // 交互 1：打开「添加下载器」对话框（设置页），确认弹层可开、可关
    await evaluate(`(async () => { location.hash = "#/set-downloader"; return true; })()`);
    await sleep(2000);
    const modalProbe = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const btns = [...document.querySelectorAll("#ptd-main button")];
      const add = btns.find((b) => /添加|新增|Add/i.test(b.innerText)) || btns[0];
      if (!add) return { stage: "no-button", buttons: btns.map((b) => b.innerText).slice(0, 20) };
      add.click();
      await sleep(1200);
      const wrap = document.querySelector(".ant-modal-wrap");
      const modal = document.querySelector(".ant-modal");
      const title = document.querySelector(".ant-modal-title")?.innerText ?? "";
      const bodyInputs = document.querySelectorAll(".ant-modal input, .ant-modal textarea").length;
      const closeBtn = document.querySelector(".ant-modal-close");
      const opened = !!wrap && getComputedStyle(wrap).display !== "none";
      closeBtn?.click();
      await sleep(900);
      const closed = !document.querySelector(".ant-modal-wrap") || getComputedStyle(document.querySelector(".ant-modal-wrap")).display === "none";
      return { stage: "done", buttonText: add.innerText.trim(), title, bodyInputs, opened, closed };
    })()`);
    report.interactions.push({ name: "SetDownloader.addDialog", ...modalProbe });

    // 交互 2：设置页开关 —— 点击一个 a-switch，核对 chrome.storage.local 是否真的落盘（检测 v-model 是否断链）
    await evaluate(`(async () => { location.hash = "#/set-base"; return true; })()`);
    await sleep(2500);
    const switchProbe = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const before = await chrome.storage.local.get(null);
      const sw = document.querySelector("#ptd-main .ant-switch");
      if (!sw) return { stage: "no-switch" };
      const aria0 = sw.getAttribute("aria-checked");
      sw.click();
      await sleep(1500);
      const after = await chrome.storage.local.get(null);
      const changed = Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      const sw2 = document.querySelector("#ptd-main .ant-switch");
      return { stage: "done", aria0, aria1: sw2?.getAttribute("aria-checked"), changedKeys: changed.slice(0, 8) };
    })()`);
    report.interactions.push({ name: "SetBase.switchPersist", ...switchProbe });

    // 交互 3：搜索框输入（Topbar 搜索表单）
    const searchProbe = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const input = document.querySelector("#ptd-topbar input");
      if (!input) return { stage: "no-input" };
      input.focus();
      input.value = "test";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(400);
      return { stage: "done", value: input.value };
    })()`);
    report.interactions.push({ name: "Topbar.searchInput", ...searchProbe });
  }

  if (OUT_PNG) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    mkdirSync(join(OUT_PNG, ".."), { recursive: true });
    writeFileSync(OUT_PNG, Buffer.from(shot.data, "base64"));
  }
  ws.close();
} catch (err) {
  report.fatal = String(err?.stack ?? err);
} finally {
  chrome.kill("SIGKILL");
}

console.log(JSON.stringify(report, null, 2));
