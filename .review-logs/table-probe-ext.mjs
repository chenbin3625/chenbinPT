// 表格排版走查（真实扩展上下文）：
// 1) 载入 dist-chrome；2) 往 chrome.storage / sessionStorage / IndexedDB 写入 mock 数据；
// 3) 逐个路由截图 + 导出每张表格的「与上方组件间隙 / 列宽 / 行高 / 截断情况」。
// 用法: node .review-logs/table-probe-ext.mjs [distDir] [outDir]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const DIST = resolve(process.argv[2] ?? "dist-chrome");
const OUT = resolve(process.argv[3] ?? ".review-logs/table-shots");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9455;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "ptd-tbl-"));

const LONG = "一个非常非常长的标题用于验证单元格最大宽度与悬停展示全文的效果";
const NOW = Date.now();

const metadata = {
  sites: {
    nyaa: {
      id: "nyaa",
      sortIndex: 1,
      url: "https://nyaa.si/",
      isOffline: false,
      allowSearch: true,
      allowQueryUserInfo: true,
      allowContentScript: true,
      groups: ["综合", "影视", "动漫", "音乐", "软件", "学习", "纪录片", "体育"],
      merge: { name: "Nyaa — 一个特别长的自定义站点名称用于验证列宽截断与悬停" },
    },
    zmpt: {
      id: "zmpt",
      sortIndex: 2,
      url: "https://zmpt.cc/",
      isOffline: false,
      allowSearch: true,
      allowQueryUserInfo: true,
      allowContentScript: false,
      groups: ["综合", "影视"],
    },
    ourbits: {
      id: "ourbits",
      sortIndex: 3,
      url: "https://ourbits.club/torrents.php?special=verylongquerystring&page=1",
      isOffline: false,
      allowSearch: true,
      allowQueryUserInfo: false,
      allowContentScript: true,
      groups: ["综合", "影视", "高清", "原盘", "纪录片", "音乐", "学习", "软件", "游戏", "动漫"],
      merge: { name: "我堡 OurBits — 用户自定义的超长名称" },
    },
    hhanclub: { id: "hhanclub", sortIndex: 4, url: "https://hhanclub.net/", isOffline: true, allowSearch: false },
    u2: { id: "u2", sortIndex: 5, url: "https://u2.dmhy.org/", isOffline: false, allowSearch: true },
    audiences: { id: "audiences", sortIndex: 6, url: "https://audiences.me/", isOffline: false, allowSearch: true },
    keepfrds: { id: "keepfrds", sortIndex: 7, url: "https://pt.keepfrds.com/", isOffline: false, allowSearch: true },
    pttime: { id: "pttime", sortIndex: 8, url: "https://www.pttime.org/", isOffline: false, allowSearch: true },
  },
  solutions: {
    s1: {
      id: "s1",
      name: "默认搜索方案（含全部已添加站点的一个很长很长的方案名）",
      sort: 3,
      enabled: true,
      isDefault: true,
      createdAt: NOW,
      solutions: [
        { id: "default", siteId: "nyaa", searchEntries: {} },
        { id: "default", siteId: "zmpt", searchEntries: {} },
        { id: "default", siteId: "ourbits", searchEntries: {} },
        { id: "default", siteId: "hhanclub", searchEntries: {} },
        { id: "default", siteId: "u2", searchEntries: {} },
        { id: "default", siteId: "audiences", searchEntries: {} },
        { id: "default", siteId: "keepfrds", searchEntries: {} },
        { id: "default", siteId: "pttime", searchEntries: {} },
      ],
    },
    s2: {
      id: "s2",
      name: "只看影视",
      sort: 2,
      enabled: true,
      isDefault: false,
      createdAt: NOW - 86400000,
      solutions: [
        { id: "default", siteId: "ourbits", searchEntries: {} },
        { id: "default", siteId: "hhanclub", searchEntries: {} },
      ],
    },
    s3: { id: "s3", name: "停用方案", sort: 1, enabled: false, isDefault: false, createdAt: NOW, solutions: [] },
  },
  snapshots: {
    snap1: { id: "snap1", name: `默认搜索方案 ${LONG} (2026-10-04 09:00:00)`, createdAt: NOW, recordCount: 212 },
    snap2: { id: "snap2", name: "只看影视 沙丘 (2026-10-03 12:00:00)", createdAt: NOW - 86400000, recordCount: 12 },
  },
  downloaders: {
    d1: {
      id: "d1",
      type: "qbittorrent",
      name: "家里的 qBittorrent（一个很长的下载器名字）",
      address: "http://192.168.1.100:8080/qbittorrent/api/v2/torrents/info?filter=all",
      username: "admin",
      password: "adminadmin",
      enabled: true,
      sortIndex: 1,
    },
    d2: { id: "d2", type: "transmission", name: "Transmission", address: "http://127.0.0.1:9091/transmission/rpc", enabled: true, sortIndex: 2 },
    d3: { id: "d3", type: "deluge", name: "Deluge", address: "http://127.0.0.1:8112/json", enabled: false, sortIndex: 3 },
    d4: { id: "d4", type: "aria2", name: "Aria2", address: "http://127.0.0.1:6800/jsonrpc", enabled: true, sortIndex: 4 },
  },
  mediaServers: {
    m1: { id: "m1", type: "plex", name: "家里的 Plex 服务器", address: "http://192.168.1.100:32400/web/index.html#!/settings", auth: { token: "xxx" }, enabled: true },
    m2: { id: "m2", type: "fnos", name: "飞牛影视", address: "http://192.168.1.101:5666/", auth: {}, enabled: false },
  },
  backupServers: {
    b1: {
      id: "b1",
      type: "webdav",
      name: "坚果云 WebDAV（很长的备份服务器名称）",
      enabled: true,
      backupFields: ["cookies", "config", "metadata", "userInfo", "searchResultSnapshot", "keepUploadTask", "downloadHistory"],
      backupInterval: 24,
      retention: { enabled: true, count: 5, days: 30, keepLast: 3 },
      lastBackupAt: NOW,
      config: { url: "https://dav.jianguoyun.com/dav/PT-Plugin-Plus/backup", username: "user@example.com", password: "x" },
    },
    b2: { id: "b2", type: "s3", name: "S3", enabled: false, backupFields: ["config"], config: {} },
  },
  defaultSolutionId: "s1",
  defaultDownloader: {},
  lastUserInfo: {},
  siteHostMap: {},
  siteNameMap: {},
};

const userInfo = {
  nyaa: {
    "2026-10-04 09:00:00": {
      id: "123456789",
      name: "一个非常长的用户名用于测试截断",
      levelName: "Power User+",
      uploaded: 12345678901234,
      downloaded: 2345678901,
      ratio: 5.26,
      trueRatio: 5.26,
      uploads: 128,
      seeding: 1024,
      seedingSize: 9876543210987,
      bonus: 123456789,
      bonusPerHour: 1234.56,
      invites: 8,
      joinTime: NOW - 86400000 * 900,
      lastAccessAt: NOW,
      updateAt: NOW,
      messageCount: 3,
    },
  },
};

const searchResult = Array.from({ length: 6 }, (_, i) => ({
  uniqueId: `nyaa-${i}`,
  site: "nyaa",
  id: String(1000000 + i),
  solutionId: "default",
  solutionKey: "nyaa-default",
  title: `${LONG} 第 ${i + 1} 个种子 2160p HDR10 DDP 7.1 x265-FLUX`,
  subTitle: "中文字幕 / 简繁英 / 特效字幕",
  url: `https://nyaa.si/view/${1000000 + i}`,
  link: `https://nyaa.si/download/${1000000 + i}.torrent`,
  size: 1073741824 * (i + 1) * 3,
  seeders: 100 + i,
  leechers: 3 + i,
  completed: 1000 + i,
  comments: i,
  time: NOW - i * 3600000,
  status: i % 2,
  tags: [
    { name: "中字" },
    { name: "官方" },
    { name: "HDR" },
    { name: "免费" },
  ],
}));

const downloadHistory = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1,
  siteId: i % 2 === 0 ? "nyaa" : "ourbits",
  torrentId: String(1000000 + i),
  downloaderId: i % 2 === 0 ? "d1" : "d2",
  downloadAt: NOW - i * 3600000,
  downloadStatus: i % 5,
  title: `${LONG} 第 ${i + 1} 个下载记录 2160p HDR`,
  subTitle: "中文字幕 / 简繁英",
  url: `https://nyaa.si/view/${1000000 + i}`,
  link: `https://nyaa.si/download/${1000000 + i}.torrent`,
  torrent: {
    site: i % 2 === 0 ? "nyaa" : "ourbits",
    id: String(1000000 + i),
    title: `${LONG} 第 ${i + 1} 个下载记录`,
    url: `https://nyaa.si/view/${1000000 + i}`,
    link: `https://nyaa.si/download/${1000000 + i}.torrent`,
    size: 1073741824 * 8,
    time: NOW,
  },
  addTorrentOptions: {},
}));

const keepUploadTask = {
  t1: {
    id: "t1",
    createdAt: NOW,
    siteId: "nyaa",
    downloadOptions: { downloaderId: "d1", folder: "/downloads/PT", tags: ["PT", "自动"] },
    status: 1,
    items: [
      { torrentId: "1", title: `${LONG} 辅种任务条目`, size: 1073741824, state: 1, downloaderId: "d1" },
      { torrentId: "2", title: "短标题", size: 1073741824, state: 1, downloaderId: "d1" },
    ],
  },
};

const seedScript = `(async () => {
  const metadata = ${JSON.stringify(metadata)};
  const userInfo = ${JSON.stringify(userInfo)};
  const keepUploadTask = ${JSON.stringify(keepUploadTask)};
  const downloadHistory = ${JSON.stringify(downloadHistory)};
  const runtime = ${JSON.stringify({
    search: {
      isSearching: false,
      startAt: NOW,
      endAt: NOW,
      searchKey: "沙丘",
      searchPlanKey: "default",
      searchPlan: {},
      searchResult,
    },
    userInfo: { flushPlan: {} },
    mediaServerSearch: { isSearching: false, searchKey: "", searchStatus: {}, searchResult: [] },
  })};
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    metadata,
    userInfo,
    keepUploadTask,
    config: { contentScript: { enabled: true, allowExceptionSites: true } },
  });
  try { sessionStorage.setItem("__ptd_runtime_store", JSON.stringify(runtime)); } catch (e) {}
  await new Promise((res) => {
    const req = indexedDB.open("ptd", 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("download_history")) db.createObjectStore("download_history", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("favicon")) db.createObjectStore("favicon");
      if (!db.objectStoreNames.contains("social_information")) db.createObjectStore("social_information");
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("download_history", "readwrite");
      const store = tx.objectStore("download_history");
      downloadHistory.forEach((r) => store.put(r));
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    };
    req.onerror = () => res(false);
  });
  return true;
})()`;

const measure = `(() => {
  const cellInfo = (td) => {
    const r = td.getBoundingClientRect();
    const child = td.firstElementChild;
    const info = { text: (td.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 26), w: Math.round(r.width) };
    if (child) {
      const cs = getComputedStyle(child);
      info.maxW = cs.maxWidth;
      info.clip = child.scrollWidth > child.clientWidth + 1;
    }
    return info;
  };
  const out = [];
  document.querySelectorAll(".ant-table-wrapper").forEach((w, i) => {
    const r = w.getBoundingClientRect();
    const prev = w.previousElementSibling;
    const parent = w.parentElement;
    const cardHead = parent && parent.classList.contains("ant-card-body") ? parent.parentElement.querySelector(".ant-card-head") : null;
    out.push({
      i,
      top: Math.round(r.top),
      gap: prev ? Math.round(r.top - prev.getBoundingClientRect().bottom) : null,
      prevTag: prev ? prev.tagName.toLowerCase() + "." + String(prev.className || "").split(" ").filter(Boolean).slice(0, 2).join(".") : null,
      headGap: cardHead ? Math.round(r.top - cardHead.getBoundingClientRect().bottom) : null,
      cols: [...w.querySelectorAll(".ant-table-thead th")].map((th) => ({ t: (th.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 12), w: Math.round(th.getBoundingClientRect().width) })),
      rows: [...w.querySelectorAll(".ant-table-tbody tr")].slice(0, 1).map((tr) => ({ h: Math.round(tr.getBoundingClientRect().height), cells: [...tr.querySelectorAll("td")].map(cellInfo) })),
      empty: !!w.querySelector(".ant-table-placeholder"),
      paginationMargin: (() => {
        const p = w.querySelector(".ant-table-pagination");
        return p ? getComputedStyle(p).margin : null;
      })(),
      cellPadding: (() => {
        const td = w.querySelector(".ant-table-tbody > tr > td");
        return td ? getComputedStyle(td).padding : null;
      })(),
    });
  });
  return JSON.stringify(out, null, 1);
})()`;

const ROUTES = [
  ["#/set-site", "SetSite"],
  ["#/set-search-solution", "SetSearchSolution"],
  ["#/set-downloader", "SetDownloader"],
  ["#/set-media-server", "SetMediaServer"],
  ["#/set-backup", "SetBackup"],
  ["#/my-data", "MyData"],
  ["#/search-entity", "SearchEntity"],
  ["#/download-history", "DownloadHistory"],
  ["#/keep-upload-task", "KeepUploadTask"],
  ["#/search-result-snapshot", "SearchResultSnapshot"],
  ["#/my-client", "MyClient"],
];

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
const report = { tables: {}, exceptions: [], consoleErrors: [] };

try {
  await sleep(2500);
  const ver = await json("/json/version");
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    bws.onopen = res;
    bws.onerror = rej;
  });
  let bid = 0;
  const bp = new Map();
  const bsend = (m, p = {}) =>
    new Promise((r) => {
      const i = ++bid;
      bp.set(i, r);
      bws.send(JSON.stringify({ id: i, method: m, params: p }));
    });
  bws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && bp.has(m.id)) {
      bp.get(m.id)(m);
      bp.delete(m.id);
    }
  };
  const loaded = await bsend("Extensions.loadUnpacked", { path: DIST });
  const extId = loaded.result.id;
  await sleep(1500);
  const base = `chrome-extension://${extId}/src/entries/options/index.html`;
  const target = await json(`/json/new?${encodeURIComponent(base)}`, { method: "PUT" });
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
    if (m.method === "Runtime.exceptionThrown") report.exceptions.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") report.consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description).join(" ").slice(0, 200));
  };
  const send = (m, p = {}) =>
    new Promise((r) => {
      const i = ++id;
      pend.set(i, r);
      ws.send(JSON.stringify({ id: i, method: m, params: p }));
    });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description ?? "").slice(0, 300) };
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, name + ".png"), Buffer.from(s.result.data, "base64"));
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: base });
  for (let i = 0; i < 80; i++) {
    if ((await ev(`document.querySelector("#ptd-main") !== null`)) === true) break;
    await sleep(400);
  }
  await sleep(3000);
  // 关掉首次使用的弹窗
  await ev(`(() => { const w=[...document.querySelectorAll('.ant-modal-wrap')].find(x=>getComputedStyle(x).display!=='none'); if(w){ (w.querySelector('.ant-modal-close')||[...w.querySelectorAll('button')].find(b=>/开始使用/.test(b.innerText)))?.click(); } return true; })()`);
  await sleep(800);
  const seeded = await ev(seedScript);
  console.log("seeded:", JSON.stringify(seeded));
  await send("Page.navigate", { url: base });
  await sleep(4000);
  for (const [hash, name] of ROUTES) {
    await ev(`(location.hash=${JSON.stringify(hash)}, true)`);
    await sleep(2600);
    const res = await ev(measure);
    report.tables[name] = res;
    await shot(name);
    console.log("route", name, "=>", typeof res === "string" ? res.replace(/\s+/g, " ").slice(0, 600) : JSON.stringify(res));
  }

  // 弹层里的表格（我的数据 → 查看历史数据）：验证紧凑单元格与「首元素不留上边距」
  await ev(`(location.hash='#/my-data', true)`);
  await sleep(2600);
  const openedHistory = await ev(
    `(() => { const b=[...document.querySelectorAll('#ptd-main tbody button')].find(x=>/查看历史数据/.test(x.getAttribute('title')||'')); if(!b) return false; b.click(); return true; })()`,
  );
  await sleep(2600);
  const dialogRes = await ev(measure);
  report.tables["MyData-HistoryDialog"] = dialogRes;
  await shot("MyData-HistoryDialog");
  console.log("dialog opened:", openedHistory, "=>", typeof dialogRes === "string" ? dialogRes.replace(/\s+/g, " ").slice(0, 400) : JSON.stringify(dialogRes));

  // 我的数据快捷筛选（「最近更新出错」）：验证脚本化的状态枚举常量仍能正确写入筛选条件
  await ev(`(location.hash='#/', true)`);
  await sleep(1200);
  await ev(`(location.hash='#/my-data', true)`);
  await sleep(2600);
  const quickFilter = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 快捷筛选在搜索框前缀的漏斗图标里
    const filterIcon = document.querySelector('#ptd-main .ant-input-prefix .anticon-filter');
    if (!filterIcon) return { step: 'no-filter-icon' };
    filterIcon.click();
    await sleep(900);
    const item = [...document.querySelectorAll('.ant-popover .ant-list-item')].find((el) => /更新状态异常|最近更新出错/.test(el.innerText));
    if (!item) return { step: 'no-item', popoverItems: [...document.querySelectorAll('.ant-popover .ant-list-item')].map((x) => x.innerText.slice(0, 12)) };
    item.click();
    await sleep(1200);
    return {
      step: 'clicked',
      tableRows: document.querySelectorAll('#ptd-main .ant-table-tbody tr').length,
      tableText: (document.querySelector('#ptd-main .ant-table-tbody')?.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
      filterChip: document.querySelector('#ptd-main .ant-typography')?.innerText?.slice(0, 60) ?? null,
    };
  })()`);
  report.quickFilter = quickFilter;
  await shot("MyData-QuickFilter");
  console.log("quickFilter:", JSON.stringify(quickFilter));

  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log("exceptions:", report.exceptions.slice(0, 5));
  console.log("consoleErrors:", report.consoleErrors.slice(0, 5));
  ws.close();
  bws.close();
} catch (e) {
  console.log("ERR", e.stack);
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
} finally {
  chrome.kill("SIGKILL");
}
