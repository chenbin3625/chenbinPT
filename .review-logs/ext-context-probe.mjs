// 扩展上下文探针：验证 pinia 持久化插件在真实扩展里仍然生效 + 按钮交互是否回归
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist-chrome");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT_DIR = ".review-logs/ext-probe";
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT_DIR, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "ptd-extprobe-"));
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

const report = { steps: [], console: [], exceptions: [] };

try {
  await sleep(2500);
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    bws.onopen = res;
    bws.onerror = rej;
  });
  let bid = 0;
  const bp = new Map();
  const bsend = (method, params = {}) =>
    new Promise((r) => {
      const i = ++bid;
      bp.set(i, r);
      bws.send(JSON.stringify({ id: i, method, params }));
    });
  bws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && bp.has(m.id)) {
      bp.get(m.id)(m);
      bp.delete(m.id);
    }
  };

  const loaded = await bsend("Extensions.loadUnpacked", { path: DIST });
  if (loaded.error) throw new Error("loadUnpacked failed: " + JSON.stringify(loaded.error));
  const extId = loaded.result.id;
  report.extId = extId;
  console.log("extensionId:", extId);
  await sleep(2000);

  const base = `chrome-extension://${extId}/src/entries/options/index.html`;
  const target = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(base)}`, { method: "PUT" })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
      return;
    }
    if (m.method === "Runtime.consoleAPICalled") {
      const t = (m.params.args ?? []).map((a) => a.value ?? a.description).join(" ");
      report.console.push(m.params.type + ": " + t.slice(0, 400));
    }
    if (m.method === "Runtime.exceptionThrown") {
      report.exceptions.push(
        (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 600),
      );
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pend.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description ?? "").slice(0, 400) };
    return r.result?.result?.value;
  };
  const step = async (name, fn) => {
    const v = await fn();
    report.steps.push({ name, result: v });
    console.log("STEP", name, "=>", JSON.stringify(v).slice(0, 500));
    return v;
  };
  const clickText = (scope, re) => `(() => {
    const root = ${scope};
    const b = [...root.querySelectorAll("button, a, .ant-btn")].find((x) => ${re}.test((x.innerText || "").trim()));
    if (!b) return { found: false, candidates: [...root.querySelectorAll("button")].map((x) => (x.innerText || "").trim()).filter(Boolean).slice(0, 15) };
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    b.click();
    return { found: true, text: (b.innerText || "").trim(), disabled: !!b.disabled, hitTestOk: top === b || b.contains(top) || (top && top.closest("button") === b) };
  })()`;

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: base });

  let mounted = false;
  for (let i = 0; i < 100; i++) {
    if ((await ev(`document.querySelector("#ptd-main") !== null || document.querySelector("#app")?.children.length > 0`)) === true) {
      mounted = true;
      break;
    }
    await sleep(300);
  }
  await sleep(2500);
  report.mounted = mounted;

  await step("mount", async () =>
    ev(`(() => {
      const root = document.querySelector("#app");
      return {
        mounted: !!document.querySelector("#ptd-main"),
        appChildren: root ? root.children.length : 0,
        textLen: root ? (root.innerText || "").length : 0,
        buttonCount: document.querySelectorAll("button").length,
        permissions: JSON.stringify(chrome.runtime.getManifest().permissions),
        onChangedAvailable: !!(chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener),
      };
    })()`),
  );

  // 关掉「开始使用」之类的引导弹窗
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); if(w){ (w.querySelector('.ant-modal-close')||[...w.querySelectorAll('button')].find(b=>/开始使用|确定|知道了/.test(b.innerText)))?.click(); } return true; })()`);
  await sleep(1200);

  // 1) 侧边导航（antd Menu）按钮是否可用：真实点击 menu item，看路由是否变化
  await step("导航栏平面 DOM", async () =>
    ev(`(() => {
      const sider = document.querySelector(".ant-layout-sider");
      const menu = document.querySelector(".ant-menu");
      return {
        hasSider: !!sider,
        hasMenu: !!menu,
        menuItemCount: document.querySelectorAll(".ant-menu-item").length,
        menuItems: [...document.querySelectorAll(".ant-menu-item")].map((x) => (x.innerText || "").trim()).slice(0, 20),
      };
    })()`),
  );

  await step("点击导航菜单项（MyData）", async () =>
    ev(`(() => {
      const item = [...document.querySelectorAll(".ant-menu-item")].find((x) => /我的数据|MyData|数据/i.test(x.innerText || ""));
      if (!item) return { found: false, items: [...document.querySelectorAll(".ant-menu-item")].map((x) => (x.innerText || "").trim()) };
      const r = item.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      item.click();
      return { found: true, text: (item.innerText || "").trim(), hitTestOk: !!(top && (top === item || item.contains(top))) };
    })()`),
  );
  await sleep(2500);
  await step("导航点击后路由", async () => ev(`({ hash: location.hash, main: (document.querySelector('#ptd-main')?.innerText || '').slice(0, 80) })`));

  await step("Topbar 搜索按钮", async () =>
    ev(`(() => {
      const tb = document.querySelector(".ant-layout-header") || document;
      const btns = [...tb.querySelectorAll("button")];
      const search = btns.find((b) => /搜索|search/i.test(b.innerText || "") || b.querySelector(".anticon-search"));
      if (!search) return { found: false, buttons: btns.map((b) => (b.innerText || "").trim()) };
      const r = search.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { found: true, disabled: !!search.disabled, hitTestOk: !!(top && (top === search || search.contains(top))) };
    })()`),
  );

  // 2) 设置-站点页：点「增加」应弹出对话框
  await step("跳转 set-site", async () => {
    await ev(`(location.hash = "#/set-site", true)`);
    await sleep(2500);
    return ev(`({ hash: location.hash, main: (document.querySelector('#ptd-main')?.innerText || '').slice(0, 120) })`);
  });

  await step("点击「增加」按钮", async () => ev(clickText(`document.querySelector('#ptd-main')`, `/增加|添加站点|新增/i`)));
  await sleep(1500);
  await step("对话框是否打开", async () =>
    ev(`(() => {
      const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none');
      return { modalOpen: !!w, title: w ? (w.querySelector('.ant-modal-title')?.innerText || '').trim() : null };
    })()`),
  );

  // 3) 关闭对话框
  await step("关闭对话框", async () =>
    ev(`(() => {
      const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none');
      if (!w) return { found: false };
      const b = [...w.querySelectorAll('button')].find((x) => /取消/.test(x.innerText));
      if (!b) return { found: false, buttons: [...w.querySelectorAll('button')].map((x) => x.innerText.trim()) };
      b.click();
      return { found: true };
    })()`),
  );
  await sleep(1000);

  // 4) 持久化写入：通过 store.$save 落盘，再读回
  await step("持久化写入 + 读回", async () =>
    ev(`(async () => {
      const before = await chrome.storage.local.get(["config"]);
      const beforeKeys = before.config ? Object.keys(before.config).slice(0, 8) : null;
      return { hasConfigInStorage: !!before.config, beforeKeys };
    })()`),
  );

  await step("修改 config 并显式 $save 落盘", async () =>
    ev(`(async () => {
      const piniaEl = document.querySelector("#app");
      const app = piniaEl && piniaEl.__vue_app__;
      const pinia = app && app.config.globalProperties.$pinia;
      if (!pinia) return { found: false, reason: "no pinia instance" };
      const config = pinia.state.value.config;
      if (!config) return { found: false, reason: "no config store" };
      const prev = config.ignoreWrongPixelRatio;
      // 用 store 实例上的 $save()（插件注入），走真实写入路径
      const store = pinia._s.get("config");
      if (!store || typeof store.$save !== "function") return { found: false, reason: "no $save on config store" };
      store.ignoreWrongPixelRatio = !prev;
      await store.$save();
      const stored = await chrome.storage.local.get(["config"]);
      const persisted = stored.config ? stored.config.ignoreWrongPixelRatio : undefined;
      store.ignoreWrongPixelRatio = prev;
      await store.$save();
      const back = (await chrome.storage.local.get(["config"])).config?.ignoreWrongPixelRatio;
      return { found: true, prev, persisted, writeReachedStorage: persisted === !prev, restoredTo: back };
    })()`),
  );

  // 5) 探针：onChanged 监听是否注册（依赖插件在扩展内确实注册了监听）
  await step("外部写入能否同步到页面 store", async () =>
    ev(`(async () => {
      const piniaEl = document.querySelector("#app");
      const app = piniaEl && piniaEl.__vue_app__;
      const pinia = app && app.config.globalProperties.$pinia;
      const config = pinia.state.value.config;
      const key = "ignoreWrongPixelRatio";
      const original = config[key];
      // 从「另一个上下文」写入：直接 chrome.storage.local.set，会触发本页 onChanged
      await chrome.storage.local.set({ config: { ...JSON.parse(JSON.stringify(config)), [key]: !original } });
      await new Promise((r) => setTimeout(r, 800));
      const synced = config[key] === !original;
      await chrome.storage.local.set({ config: { ...JSON.parse(JSON.stringify(config)), [key]: original } });
      await new Promise((r) => setTimeout(r, 500));
      return { synced, original, nowValue: config[key] };
    })()`),
  );

  report.mountedFinal = await ev(`!!document.querySelector("#ptd-main")`);
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  console.log("exceptions:", report.exceptions.slice(0, 5));
  console.log("console errors:", report.console.filter((c) => c.startsWith("error")).slice(0, 10));
  ws.close();
  bws.close();
} catch (e) {
  console.log("ERR", e.stack);
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
} finally {
  chrome.kill("SIGKILL");
}
