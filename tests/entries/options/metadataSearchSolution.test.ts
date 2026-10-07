/**
 * metadata store：搜索方案展开 / 站点增删 / 写入合并
 * （B-8、B-13、V-6、V-7、V-8；代码审查报告已移出仓库树，可在提交 3b066d59 中查阅）。
 *
 * 依赖处理：
 * - `@ptd/site` 只暴露 metadata.ts 真正用到的两个运行时函数（`getHostFromUrl` 与
 *   `getDefinedSiteMetadata`），后者对「不在构建产物里的站点 id」抛 TypeError —— 与真实实现一致，
 *   这样才能证明 B-13 的守卫确实拦住了抛错路径；
 * - `@/messages.ts` 被 mock（siteIndex 同步、快照读写都会用到它）；
 * - `ant-design-vue` 的 message 只需占位（runtime store 的 showSnakebar 会调用）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createApp, h } from "vue";

const { sendMessageMock, getDefinedSiteMetadataMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async () => undefined),
  getDefinedSiteMetadataMock: vi.fn(),
}));

vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock }));
vi.mock("@ptd/site", () => ({
  getHostFromUrl: (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  },
  getDefinedSiteMetadata: getDefinedSiteMetadataMock,
}));
vi.mock("ant-design-vue", () => ({ message: { open: vi.fn() } }));

import { piniaWebExtPersistencePlugin } from "~/extends/pinia/webExtPersistence.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

/** 当前测试里"存在于构建产物中"的站点定义 */
let knownSites: Set<string>;

function defineSite(siteId: string) {
  knownSites.add(siteId);
}

function solutionOf(id: string, siteIds: string[]) {
  return {
    id,
    name: id,
    sort: 0,
    enabled: true,
    isDefault: false,
    createdAt: 0,
    solutions: siteIds.map((siteId) => ({ id: "default", siteId, searchEntries: { default: {} } })),
  };
}

async function createMetadataStore() {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  // Pinia v4：pinia 未安装到 app 之前 use() 只是放进 toBeInstalled，
  // 只有 app.use(pinia) 之后插件才会在 store 创建时执行（$save/$onReady 才有定义）
  createApp({ render: () => h("div") }).use(pinia);
  setActivePinia(pinia);

  const store = useMetadataStore(pinia);
  await store.$onReady();
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
  knownSites = new Set();
  sendMessageMock.mockClear();
  getDefinedSiteMetadataMock.mockReset();
  getDefinedSiteMetadataMock.mockImplementation(async (siteId: string) => {
    if (!knownSites.has(siteId)) {
      // 与 packages/site 的真实行为一致：不在构建产物里的站点 id 会抛错
      throw new TypeError(`siteMetadata ${siteId} not found in build, skip creating siteInstance`);
    }
    return {
      id: siteId,
      name: `站点 ${siteId}`,
      urls: [`https://${siteId}.example/`],
      isDead: false,
      searchEntry: { default: {} },
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("单条配置保存", () => {
  it("新增站点写盘失败时 addSite 拒绝，不让对话框误判保存完成", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");
    store.$save = vi.fn().mockRejectedValue(new Error("quota exceeded"));

    await expect(store.addSite("siteA", { url: "https://siteA.example/" } as any)).rejects.toThrow("quota exceeded");
  });

  it("H-8：站点映射重建抛错时，新增/删除站点仍已落盘（不再「内存改了、磁盘没改」）", async () => {
    const store = await createMetadataStore();
    const save = vi.fn().mockResolvedValue(undefined);
    store.$save = save;
    store.buildSiteMapCache = vi.fn().mockRejectedValue(new Error("site definition failed to load"));

    await expect(store.addSite("siteA", { url: "https://siteA.example/" } as any)).rejects.toThrow(
      "site definition failed to load",
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.sites.siteA).toBeDefined();

    save.mockClear();
    await expect(store.removeSite("siteA")).rejects.toThrow("site definition failed to load");
    expect(store.sites.siteA).toBeUndefined();
    // 删除走合并写入：窗口结束后必须写盘（旧实现被重建错误短路，永远不写）
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("新增下载器写盘失败时 addDownloader 拒绝", async () => {
    const store = await createMetadataStore();
    store.$save = vi.fn().mockRejectedValue(new Error("quota exceeded"));

    await expect(store.addDownloader({ id: "clientA", enabled: true } as any)).rejects.toThrow("quota exceeded");
  });
});

describe("M-6：清空用户配置后 siteIndex 同步清空", () => {
  it("$reset + $save + syncSiteIndex 之后，storage 里的 siteIndex 不再残留已删站点", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");
    await store.addSite("siteA", { url: "https://siteA.example/" } as any);
    await vi.advanceTimersByTimeAsync(600);

    sendMessageMock.mockClear();
    store.$reset();
    await store.$save();
    await store.syncSiteIndex();

    const siteIndexWrites = (sendMessageMock.mock.calls as unknown as Array<[string, any]>).filter(
      ([type, payload]) => type === "setExtStorage" && payload?.key === "siteIndex",
    );
    expect(siteIndexWrites.at(-1)?.[1].value).toEqual({ siteHostMap: {}, siteNameMap: {} });
  });
});

describe("B-8 getSearchSolution 不得改写 state", () => {
  it("站点 isOffline 时展开方案：返回的浅拷贝丢弃该站点，state.solutions 保持原样", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");
    defineSite("siteB");
    await store.addSite("siteA", { isOffline: true } as any, { reBuildMap: false });
    await store.addSite("siteB", {}, { reBuildMap: false });
    await store.addSearchSolution(solutionOf("sol1", ["siteA", "siteB"]) as any);

    const before = JSON.stringify(store.solutions);

    const expanded = await store.getSearchSolution("sol1");

    // 展开结果里 isOffline 的站点被跳过（与修复前一致）
    expect(expanded?.solutions.map((s) => s.siteId)).toEqual(["siteB"]);
    // 但持久化 state 必须一字不改（修复前这里会被截断成只剩 siteB）
    expect(JSON.stringify(store.solutions)).toEqual(before);
    expect(store.solutions.sol1.solutions.map((s) => s.siteId)).toEqual(["siteA", "siteB"]);
    // 返回的是浅拷贝：调用方改它不会污染 state
    expect(expanded).not.toBe(store.solutions.sol1);
    expect(expanded!.solutions[0]).not.toBe(store.solutions.sol1.solutions[1]);
  });

  it("站点定义 isDead 时同样只影响返回值，不改 state", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");
    defineSite("siteB");
    getDefinedSiteMetadataMock.mockImplementation(async (siteId: string) => ({
      id: siteId,
      name: `站点 ${siteId}`,
      urls: [`https://${siteId}.example/`],
      isDead: siteId === "siteA",
      searchEntry: { default: {} },
    }));

    await store.addSite("siteA", {}, { reBuildMap: false });
    await store.addSite("siteB", {}, { reBuildMap: false });
    await store.addSearchSolution(solutionOf("sol2", ["siteA", "siteB"]) as any);

    const before = JSON.stringify(store.solutions);
    const expanded = await store.getSearchSolution("sol2");

    expect(expanded?.solutions.map((s) => s.siteId)).toEqual(["siteB"]);
    expect(JSON.stringify(store.solutions)).toEqual(before);
  });
});

describe("R4-10 已保存分类方案按当前站点定义展开", () => {
  it("带 selectedCategories 的旧方案使用新的分类参数，手写方案保持原 requestConfig", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");
    await store.addSite("siteA", {}, { reBuildMap: false });
    getDefinedSiteMetadataMock.mockResolvedValue({
      id: "siteA",
      name: "站点 siteA",
      urls: ["https://siteA.example/"],
      isDead: false,
      category: [{ key: "category", name: "分类", options: [{ name: "电影", value: 401 }] }],
      searchEntry: { default: {} },
    });
    store.solutions = {
      old: {
        id: "old",
        name: "Old",
        sort: 0,
        enabled: true,
        isDefault: false,
        createdAt: 0,
        solutions: [
          {
            id: "saved",
            siteId: "siteA",
            selectedCategories: { category: 401 },
            searchEntries: { saved: { requestConfig: { params: { cat_torrents401: 1 } } } },
          },
          {
            id: "custom",
            siteId: "siteA",
            searchEntries: { custom: { requestConfig: { params: { hand_written: 1 } } } },
          },
        ],
      },
    } as any;

    const expanded = await store.getSearchSolution("old");
    expect(expanded?.solutions[0]?.searchEntries.saved).toEqual({
      requestConfig: { params: { category: 401 } },
    });
    expect(expanded?.solutions[1]?.searchEntries.custom).toEqual({
      requestConfig: { params: { hand_written: 1 } },
    });
    expect(store.solutions.old.solutions[0]?.searchEntries.saved).toEqual({
      requestConfig: { params: { cat_torrents401: 1 } },
    });
  });
});

describe("B-13 方案/站点缺失时的守卫", () => {
  it("方案不存在时返回 undefined 而不是抛 TypeError", async () => {
    const store = await createMetadataStore();

    await expect(store.getSearchSolution("not-exist")).resolves.toBeUndefined();
  });

  it("站点不在 state.sites（已删除）时返回 undefined，且不会去加载站点定义", async () => {
    const store = await createMetadataStore();

    await expect(store.getSiteDefaultSearchSolution("ghost")).resolves.toBeUndefined();
    expect(getDefinedSiteMetadataMock).not.toHaveBeenCalledWith("ghost");
  });

  it("方案里引用了已删除的站点：展开不抛错并丢弃该条（导入/深链场景）", async () => {
    const store = await createMetadataStore();
    defineSite("siteB");
    await store.addSite("siteB", {}, { reBuildMap: false });
    await store.addSearchSolution(solutionOf("sol-ghost", ["ghost", "siteB"]) as any);

    const before = JSON.stringify(store.solutions);
    const expanded = await store.getSearchSolution("sol-ghost");

    expect(expanded?.solutions.map((s) => s.siteId)).toEqual(["siteB"]);
    expect(JSON.stringify(store.solutions)).toEqual(before);
  });

  it("删除站点后运行该方案不抛错，并级联清理方案引用与 lastUserInfo", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");
    defineSite("siteB");
    await store.addSite("siteA", {}, { reBuildMap: false });
    await store.addSite("siteB", {}, { reBuildMap: false });
    await store.addSearchSolution(solutionOf("sol3", ["siteA", "siteB"]) as any);
    store.lastUserInfo["siteA"] = { id: "siteA" } as any;

    await store.removeSite("siteA", { reBuildMap: false });

    expect(store.solutions.sol3.solutions.map((s) => s.siteId)).toEqual(["siteB"]);
    expect(store.lastUserInfo["siteA"]).toBeUndefined();

    const expanded = await store.getSearchSolution("sol3");
    expect(expanded?.solutions.map((s) => s.siteId)).toEqual(["siteB"]);
  });
});

describe("V-6 simplePatch 目标存在性守卫", () => {
  it("目标不存在时不落盘并提示用户", async () => {
    const store = await createMetadataStore();
    const snackbarSpy = vi.spyOn(useRuntimeStore(), "showSnakebar");
    const saveSpy = vi.spyOn(store, "$save").mockResolvedValue(undefined);

    await store.simplePatch("downloaders", "ghost", "enabled", true);

    expect(saveSpy).not.toHaveBeenCalled();
    expect(snackbarSpy).toHaveBeenCalledTimes(1);

    // 去抖窗口过后也不应有写入（修复前这里会整状态写一次盘）
    await vi.advanceTimersByTimeAsync(600);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("目标存在时正常写入，且只在去抖窗口结束后落盘一次", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");
    await store.addSite("siteA", {}, { reBuildMap: false });
    await vi.advanceTimersByTimeAsync(600); // 先结算 addSite 自己的那次写入

    const saveSpy = vi.spyOn(store, "$save").mockResolvedValue(undefined);

    await store.simplePatch("sites", "siteA", "isOffline", true);

    expect(store.sites.siteA.isOffline).toBe(true);
    expect(saveSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});

describe("V-7 站点映射重建合并", () => {
  it("并发删除 20 个站点只重建 2 轮（修复前是 20 轮）", async () => {
    const store = await createMetadataStore();
    const siteIds = Array.from({ length: 20 }, (_, i) => `site${i}`);
    siteIds.forEach((siteId) => defineSite(siteId));

    for (const siteId of siteIds) {
      await store.addSite(siteId, { url: `https://${siteId}.example/` } as any, { reBuildMap: false });
    }
    await store.buildSiteMapCache();
    await vi.advanceTimersByTimeAsync(600);

    const nameMapSpy = vi.spyOn(store, "buildSiteNameMap");
    const hostMapSpy = vi.spyOn(store, "buildSiteHostMap");
    const saveSpy = vi.spyOn(store, "$save").mockResolvedValue(undefined);
    saveSpy.mockClear();

    // 与 components/DeleteDialog.vue 的 Promise.allSettled 并发调用方式一致
    await Promise.all(siteIds.map((siteId) => store.removeSite(siteId)));

    expect(nameMapSpy).toHaveBeenCalledTimes(2);
    expect(hostMapSpy).toHaveBeenCalledTimes(2);
    expect(store.siteNameMap).toEqual({});
    expect(store.siteHostMap).toEqual({});

    // 20 次删除的写入也被合并成一次
    await vi.advanceTimersByTimeAsync(600);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("重建期间又有新增站点时会补跑一轮，保证调用返回时映射已覆盖自己的变更", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");
    await store.addSite("siteA", { url: "https://siteA.example/" } as any, { reBuildMap: false });

    const addPromise = store.addSite("siteB", { url: "https://siteB.example/" } as any, { reBuildMap: false });
    defineSite("siteB");
    await addPromise;

    await Promise.all([store.buildSiteMapCache(), store.buildSiteMapCache()]);

    expect(store.siteHostMap).toEqual({ "sitea.example": "siteA", "siteb.example": "siteB" });
  });
});

describe("V-8 写入去抖合并", () => {
  it("窗口内多次开关只在窗口结束时写一次，pagehide 时立即写", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");
    await store.addSite("siteA", { url: "https://siteA.example/" } as any, { reBuildMap: false });
    await vi.advanceTimersByTimeAsync(600); // 结算 addSite 的写入

    const saveSpy = vi.spyOn(store, "$save").mockResolvedValue(undefined);

    await Promise.all([0, 1, 2, 3, 4].map((i) => store.simplePatch("sites", "siteA", "sortIndex", i as any)));

    await vi.advanceTimersByTimeAsync(499);
    expect(saveSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);

    // 新的一次改动：不必等窗口，pagehide 会立即落盘（避免关页时丢掉最近的开关）
    await store.simplePatch("sites", "siteA", "isOffline", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(saveSpy).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(saveSpy).toHaveBeenLastCalledWith(undefined, { skipMerge: true });
  });
});
