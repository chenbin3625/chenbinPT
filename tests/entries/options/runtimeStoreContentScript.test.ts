/**
 * B-19 + D2-High-01：runtime store 的恢复语义。
 *
 * 背景：`useRuntimeStore` 会被 content-script 注册（content-script/app/App.vue、app/utils.ts），
 * 而内容脚本里的 `sessionStorage` 与宿主页面**同一个**：
 * 1. 页面脚本能读到扩展持久化的内容（例如 `search.searchKey`）；
 * 2. 页面能在内容脚本加载前预置 `__ptd_runtime_store` 注入任意 JSON（修复前只校验 `typeof parsed === "object"`）。
 * 因此只有当前文档属于扩展自身（地址前缀是 `chrome.runtime.getURL("")`）时才读写持久化。
 *
 * F1 修复（2026-10-23）：本文件旧版的两条「非法 JSON 不会进入 store」用例其实跑在
 * **content-script（纯内存）分支**上 —— `getSessionStorage()` 返回 null，`restoreState()`
 * 在读取任何字节之前就返回 `{}`，`sanitizeSearchData` 系列从没被执行过（测试通过但形状校验零覆盖）。
 * 现在把它们移到扩展页 URL 下，并补上 D2-High-01 的「in-flight 状态恢复收尾」断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { nextTick } from "vue";

// runtime.ts 只在 showSnakebar 里用到 antd 的 message
vi.mock("ant-design-vue", () => ({ message: { open: vi.fn() } }));

const RUNTIME_KEY = "__ptd_runtime_store";
const EXTENSION_URL = "chrome-extension://test/";
const HOST_PAGE_URL = "https://pt.example/torrents.php?page=1";

// 与 @ptd/site 的 EResultParseStatus 数值一致（避免为了两个字面量把站点包拉进单测）
const STATUS_WAITING = 1;
const STATUS_WORKING = 2;
const STATUS_PASS_PARSE = 5;

function stubChromeExtension() {
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `${EXTENSION_URL}${path}` } });
}

/** 把当前文档地址切到指定 URL（happy-dom 提供；决定 isHostPageStorage 的分支） */
function setLocation(url: string) {
  (window as any).happyDOM?.setURL(url);
}

/** 扩展页（options 页）：持久化生效 */
function stubExtensionPage() {
  stubChromeExtension();
  setLocation(`${EXTENSION_URL}options.html`);
}

/** 内容脚本：与宿主页面共享 sessionStorage，必须退化为纯内存 */
function stubHostPage() {
  stubChromeExtension();
  setLocation(HOST_PAGE_URL);
}

/** runtime.ts 在模块求值期就决定是否使用 sessionStorage，因此每次都要 resetModules 后重新 import */
async function loadRuntimeStore() {
  vi.resetModules();
  const runtimeModule = await import("@/options/stores/runtime.ts");
  const store = runtimeModule.useRuntimeStore(createPinia());
  runtimeModule.setupRuntimeStorePersistence(store);
  return { store, runtimeModule };
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
  setLocation("http://localhost:3000/");
});

describe("内容脚本：纯内存，且不信任宿主页面预置的内容", () => {
  it("预置内容不会被读取（内容脚本既不读也不写宿主页面的 sessionStorage）", async () => {
    stubHostPage();
    const seeded = JSON.stringify({ search: { searchKey: "page-seeded", searchResult: [{ id: 9 }] } });
    sessionStorage.setItem(RUNTIME_KEY, seeded);

    const { store } = await loadRuntimeStore();
    const setItemSpy = vi.spyOn(sessionStorage, "setItem");

    // 内存态是初始值，不是页面预置的数据
    expect(store.search.searchKey).toBe("");
    expect(store.search.searchResult).toEqual([]);

    store.search.searchKey = "secret keyword";
    store.search.searchResult.push({ id: 1 } as any);
    store.persistNow();
    await nextTick();
    vi.advanceTimersByTime(1000);

    expect(setItemSpy).not.toHaveBeenCalled();
    // 页面自己预置的内容保持原样
    expect(sessionStorage.getItem(RUNTIME_KEY)).toBe(seeded);
    // 内存态照常工作
    expect(store.search.searchKey).toBe("secret keyword");
  });

  it("内容脚本不产生「恢复中断」提示标记", async () => {
    stubHostPage();
    sessionStorage.setItem(
      RUNTIME_KEY,
      JSON.stringify({ search: { isSearching: true, searchKey: "k", searchResult: [], searchPlan: {} } }),
    );

    const { runtimeModule } = await loadRuntimeStore();
    expect(runtimeModule.getRuntimeRestoreInterruptions()).toEqual({
      search: false,
      mediaServerSearch: false,
      userInfo: false,
    });
  });
});

describe("扩展页：恢复前做形状校验（sanitize 真正被执行）", () => {
  it("字段类型不对的 JSON 不会进入 store", async () => {
    stubExtensionPage();
    sessionStorage.setItem(
      RUNTIME_KEY,
      JSON.stringify({
        search: { isSearching: "yes", startAt: "0", searchKey: 42, searchResult: "not-an-array", searchPlan: [] },
        userInfo: { flushPlan: { site1: "yes", site2: true } },
        mediaServerSearch: "junk",
      }),
    );

    const { store } = await loadRuntimeStore();

    // search 关键字段（searchKey/searchResult）类型不对 → 整体回落初始值
    expect(store.search.searchKey).toBe("");
    expect(store.search.searchResult).toEqual([]);
    expect(store.search.isSearching).toBe(false);
    expect(store.search.startAt).toBe(0);
    expect(store.search.searchPlan).toEqual({});
    // flushPlan 只保留 boolean 项，且一律收尾为 false（见 D2-High-01 用例）
    expect(store.userInfo.flushPlan).toEqual({ site2: false });
    // mediaServerSearch 是字符串 → 回落初始值
    expect(store.mediaServerSearch.searchKey).toBe("");
  });

  it("顶层的非对象 JSON（字符串/数组）也不会进入 store", async () => {
    stubExtensionPage();
    sessionStorage.setItem(RUNTIME_KEY, JSON.stringify(["junk"]));

    const { store } = await loadRuntimeStore();

    expect(store.search.searchKey).toBe("");
    expect(store.mediaServerSearch.searchResult).toEqual([]);
  });

  it("searchPlan 里的原型链键被丢弃（copySafeRecord）", async () => {
    stubExtensionPage();
    sessionStorage.setItem(
      RUNTIME_KEY,
      '{"search":{"searchKey":"k","searchResult":[],"searchPlan":{"__proto__":{"status":1},"ok":{"status":3}}}}',
    );

    const { store } = await loadRuntimeStore();
    expect(Object.hasOwn(store.search.searchPlan, "ok")).toBe(true);
    expect(Object.hasOwn(store.search.searchPlan, "__proto__")).toBe(false);
  });
});

describe("D2-High-01：恢复时收尾 in-flight 状态（僵尸搜索/刷新）", () => {
  it("isSearching 与 waiting/working 计划在恢复时被改写为已取消，flushPlan 一律置 false", async () => {
    stubExtensionPage();
    sessionStorage.setItem(
      RUNTIME_KEY,
      JSON.stringify({
        search: {
          isSearching: true,
          searchKey: "dune",
          searchPlanKey: "default",
          startAt: 111,
          searchResult: [{ id: 1, title: "t1" }],
          searchPlan: {
            "mteam-home": { siteId: "mteam", status: STATUS_WAITING, startAt: 222 },
            "mteam-movie": { siteId: "mteam", status: STATUS_WORKING, startAt: 333 },
            "ok-site": { siteId: "ok", status: 3, startAt: 444, endAt: 555 },
          },
        },
        userInfo: { flushPlan: { mteam: true, other: false } },
        mediaServerSearch: { isSearching: true, searchKey: "", searchResult: [], searchStatus: {} },
      }),
    );

    const { store, runtimeModule } = await loadRuntimeStore();

    // 顶栏搜索按钮依赖它：恢复后必须可再次发起搜索
    expect(store.search.isSearching).toBe(false);
    // 恢复出来的结果仍然保留（刷新后结果还在，这是 runtime 持久化的目的）
    expect(store.search.searchResult).toHaveLength(1);
    // waiting/working 计划收尾为 passParse + i18n.userCancel，并补 endAt
    for (const key of ["mteam-home", "mteam-movie"]) {
      const plan = (store.search.searchPlan as Record<string, any>)[key];
      expect(plan.status).toBe(STATUS_PASS_PARSE);
      expect(plan.statusMsg).toBe("i18n.userCancel");
      expect(typeof plan.endAt).toBe("number");
      expect(plan.endAt).toBeGreaterThan(0);
    }
    // 已是终态的计划不受影响
    expect((store.search.searchPlan as Record<string, any>)["ok-site"].status).toBe(3);
    expect((store.search.searchPlan as Record<string, any>)["ok-site"].endAt).toBe(555);
    // 用户信息刷新的 in-flight 标记同样收尾（MyData 顶部「取消刷新」不再僵尸）
    expect(store.userInfo.flushPlan).toEqual({ mteam: false, other: false });
    // 媒体服务器搜索同理
    expect(store.mediaServerSearch.isSearching).toBe(false);

    // 供 UI 判断要不要提示「上次搜索已被中断」
    expect(runtimeModule.getRuntimeRestoreInterruptions()).toEqual({
      search: true,
      mediaServerSearch: true,
      userInfo: true,
    });
  });

  it("没有 in-flight 状态时不标记中断", async () => {
    stubExtensionPage();
    sessionStorage.setItem(
      RUNTIME_KEY,
      JSON.stringify({
        search: {
          isSearching: false,
          searchKey: "k",
          searchPlanKey: "default",
          searchPlan: { done: { status: 3 } },
          searchResult: [],
        },
        userInfo: { flushPlan: { site1: false } },
        mediaServerSearch: { isSearching: false, searchKey: "", searchResult: [], searchStatus: {} },
      }),
    );

    const { store, runtimeModule } = await loadRuntimeStore();
    expect((store.search.searchPlan as Record<string, any>).done.status).toBe(3);
    expect(runtimeModule.getRuntimeRestoreInterruptions()).toEqual({
      search: false,
      mediaServerSearch: false,
      userInfo: false,
    });
  });
});

describe("reconcileRuntimeInFlightState：UI 侧可再调一次的收尾 API（F3 协作）", () => {
  it("把运行期残留的 isSearching / flushPlan 收尾，且幂等", async () => {
    stubExtensionPage();
    const { store, runtimeModule } = await loadRuntimeStore();

    // 模拟「恢复之后」出现的僵尸态（例如其它上下文写回 / 队列被意外清空）
    store.search.isSearching = true;
    (store.search.searchPlan as Record<string, any>)["orphan"] = { siteId: "x", status: STATUS_WAITING } as any;
    store.mediaServerSearch.isSearching = true;
    store.userInfo.flushPlan["mteam"] = true;

    const result = runtimeModule.reconcileRuntimeInFlightState(store);
    expect(result).toEqual({ search: true, mediaServerSearch: true, userInfo: true });
    expect(store.search.isSearching).toBe(false);
    expect((store.search.searchPlan as Record<string, any>)["orphan"].status).toBe(STATUS_PASS_PARSE);
    expect((store.search.searchPlan as Record<string, any>)["orphan"].statusMsg).toBe("i18n.userCancel");
    expect(store.mediaServerSearch.isSearching).toBe(false);
    expect(store.userInfo.flushPlan["mteam"]).toBe(false);

    // 幂等：再调一次不应再报告改写
    expect(runtimeModule.reconcileRuntimeInFlightState(store)).toEqual({
      search: false,
      mediaServerSearch: false,
      userInfo: false,
    });
  });
});

describe("扩展页面：节流持久化行为不变", () => {
  it("扩展页面仍然能恢复并节流写入", async () => {
    stubExtensionPage();
    sessionStorage.setItem(
      RUNTIME_KEY,
      JSON.stringify({
        search: {
          isSearching: false,
          startAt: 1,
          searchKey: "keyword",
          searchPlanKey: "default",
          searchPlan: {},
          searchResult: [{ id: 1 }],
        },
        userInfo: { flushPlan: {} },
      }),
    );

    const { store } = await loadRuntimeStore();
    expect(store.search.searchKey).toBe("keyword");
    expect(store.search.searchResult).toHaveLength(1);

    const setItemSpy = vi.spyOn(sessionStorage, "setItem");
    store.search.searchKey = "changed";
    await nextTick();
    expect(setItemSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(RUNTIME_KEY) as string).search.searchKey).toBe("changed");
  });
});
