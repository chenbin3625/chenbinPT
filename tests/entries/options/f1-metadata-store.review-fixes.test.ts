/**
 * F1 修复回归：metadata / config store（2026-10-23 修复轮）。
 *
 * 覆盖审查报告 F1-options-shell-stores.md 的：
 * - [High]-F1-01（原 D1-High-14 残余）：导入搜索方案的 `searchEntries[*].requestConfig`
 *   不得把搜索请求导向外部地址（无 selectedCategories / 多余 entry key / selectedCategories:{} 三种缺口）；
 * - D1-Medium-05：add* 系列不得与调用方共享引用、不得修改入参；
 * - D1-Medium-06：removeSite 的级联清理（下载器 excludedSites / config selectedSites / flushPlan / 默认方案回退）；
 * - D1-Low-10：getSorted* 不得原地改写另一个 getter 的缓存数组；
 * - D1-Low-11：getSearchSolutionName("all") 走 i18n；
 * - Info-I9：simplePatch 拒绝原型链路径段。
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
import { i18n } from "@/options/plugins/i18n.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

/** 当前测试里「存在于构建产物中」的站点定义 */
let knownSites: Set<string>;

function defineSite(siteId: string, extra: Record<string, any> = {}) {
  knownSites.add(siteId);
  return siteId;
}

async function createMetadataStore() {
  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  createApp({ render: () => h("div") }).use(pinia);
  setActivePinia(pinia);

  const store = useMetadataStore(pinia);
  await store.$onReady();
  return store;
}

/** 构造一条「导出/导入」形态的搜索方案 */
function solutionWith(id: string, items: any[]) {
  return { id, name: id, sort: 0, enabled: false, isDefault: false, createdAt: 0, solutions: items };
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
      legacyUrls: [],
      isDead: false,
      category: [
        { key: "#url", name: "搜索入口", options: [{ name: "种子", value: "/torrents.php" }] },
        { key: "cat", name: "分类", options: [{ name: "电影", value: 401 }] },
      ],
      searchEntry: { default: {} },
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * F1-01：搜索方案的请求地址安全化
 * ------------------------------------------------------------------ */

describe("F1-01：导入方案的 requestConfig 不得导向外部地址", () => {
  it("写入时（addSearchSolution）剥离外站 url / headers，保留 params 与站点相对路径", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");

    const solution = solutionWith("s-write", [
      {
        id: "item1",
        siteId: "siteA",
        searchEntries: {
          item1: {
            requestConfig: {
              url: "https://attacker.example/collect",
              headers: { "x-api-key": "leak" },
              params: { cat: 401 },
            },
          },
        },
      },
    ]);

    await store.addSearchSolution(solution as any);

    const entry = store.solutions["s-write"].solutions[0]!.searchEntries.item1;
    expect(entry.requestConfig).toEqual({ params: { cat: 401 } });
    // 调用方对象保持原样（同时也证明入库的是深拷贝）
    expect((solution.solutions[0] as any).searchEntries.item1.requestConfig.url).toBe(
      "https://attacker.example/collect",
    );
    expect(store.solutions["s-write"]).not.toBe(solution);
  });

  it("站点定义声明过的镜像 host（如 nyaa 的 baseURL 分类）仍然保留", async () => {
    const store = await createMetadataStore();
    defineSite("mirrorSite");
    getDefinedSiteMetadataMock.mockResolvedValueOnce({
      id: "mirrorSite",
      name: "镜像站",
      urls: ["https://mirror.example/", "https://mirror2.example/"],
      legacyUrls: [],
      isDead: false,
      category: [],
      searchEntry: { default: {} },
    });

    await store.addSearchSolution(
      solutionWith("s-mirror", [
        {
          id: "item1",
          siteId: "mirrorSite",
          searchEntries: {
            item1: {
              requestConfig: {
                baseURL: "https://mirror2.example/",
                params: { free: 1 },
              },
            },
          },
        },
      ]) as any,
    );

    expect(store.solutions["s-mirror"].solutions[0]!.searchEntries.item1.requestConfig).toEqual({
      baseURL: "https://mirror2.example/",
      params: { free: 1 },
    });
  });

  it("读取时（getSearchSolution）覆盖已落盘的坏数据：无 selectedCategories 的外站 url 被剥离", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");

    // 直接放进 state：模拟旧版本/备份写进 storage 的坏数据
    store.solutions["s-legacy"] = solutionWith("s-legacy", [
      {
        id: "item1",
        siteId: "siteA",
        searchEntries: {
          item1: { requestConfig: { url: "https://attacker.example/collect", params: { cat: 401 } } },
          // ② 多余 entry key 同样要安全化
          extra: { requestConfig: { url: "https://attacker2.example/x", params: { a: 1 } } },
        },
      },
    ]) as any;

    const expanded = await store.getSearchSolution("s-legacy");
    const item = expanded!.solutions[0]!;

    expect(item.searchEntries.item1.requestConfig).toEqual({ params: { cat: 401 } });
    expect(item.searchEntries.extra.requestConfig).toEqual({ params: { a: 1 } });
    // 原始 state 不被读取路径改写（B-8 语义保持）
    expect((store.solutions["s-legacy"].solutions[0]!.searchEntries.item1.requestConfig as any).url).toBe(
      "https://attacker.example/collect",
    );
  });

  it("读取时：selectedCategories 为 {} 时自身 entry 以重建为准，导入的 requestConfig 被丢弃", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");

    store.solutions["s-empty-cat"] = solutionWith("s-empty-cat", [
      {
        id: "item1",
        siteId: "siteA",
        selectedCategories: {},
        searchEntries: {
          item1: { requestConfig: { url: "https://attacker.example/collect", params: { evil: 1 } } },
        },
      },
    ]) as any;

    const expanded = await store.getSearchSolution("s-empty-cat");
    // 重建结果为空 → 自身 entry 的 requestConfig 被整体丢弃（不再残留导入的 url/params）
    expect(expanded!.solutions[0]!.searchEntries.item1.requestConfig).toBeUndefined();
  });

  it("读取时：selectedCategories 的取值必须在站点定义的 options 内（挡住 #url 越权值）", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");

    store.solutions["s-url-cat"] = solutionWith("s-url-cat", [
      {
        id: "item1",
        siteId: "siteA",
        selectedCategories: { "#url": "https://attacker.example/search", cat: 401 },
        searchEntries: {
          item1: { requestConfig: { url: "https://attacker.example/search" } },
        },
      },
    ]) as any;

    const expanded = await store.getSearchSolution("s-url-cat");
    const item = expanded!.solutions[0]!;

    // 越权的 #url 值被丢弃，只剩站点定义里存在的 cat
    expect(item.selectedCategories).toEqual({ cat: 401 });
    expect(item.searchEntries.item1.requestConfig).toEqual({ params: { cat: 401 } });
  });
});

/* ------------------------------------------------------------------ *
 * D1-Medium-05：add* 不共享引用、不修改入参
 * ------------------------------------------------------------------ */

describe("D1-Medium-05：add* 系列与调用方对象解耦", () => {
  it("addSite 深拷贝入库，且不再修改入参（valid 只在入库副本上剔除）", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");

    const siteConfig: any = { url: "https://sitea.example/", valid: true, groups: ["g1"] };
    await store.addSite("siteA", siteConfig, { reBuildMap: false });

    expect(siteConfig.valid).toBe(true);
    expect(store.sites.siteA).not.toBe(siteConfig);
    expect((store.sites.siteA as any).valid).toBeUndefined();

    // 之后改入参对象不再影响 store
    siteConfig.url = "https://changed.example/";
    siteConfig.groups.push("g2");
    expect(store.sites.siteA.url).toBe("https://sitea.example/");
    expect(store.sites.siteA.groups).toEqual(["g1"]);
  });

  it("addDownloader / addMediaServer / addBackupServer 均为深拷贝", async () => {
    const store = await createMetadataStore();

    const downloader: any = { id: "d1", enabled: true, valid: true, name: "QB" };
    await store.addDownloader(downloader);
    expect(downloader.valid).toBe(true);
    expect(store.downloaders.d1).not.toBe(downloader);
    expect((store.downloaders.d1 as any).valid).toBeUndefined();
    downloader.name = "changed";
    expect(store.downloaders.d1.name).toBe("QB");

    const mediaServer: any = { id: "m1", enabled: true };
    await store.addMediaServer(mediaServer);
    expect(store.mediaServers.m1).not.toBe(mediaServer);

    const backupServer: any = { id: "b1", enabled: true };
    await store.addBackupServer(backupServer);
    expect(store.backupServers.b1).not.toBe(backupServer);
  });
});

/* ------------------------------------------------------------------ *
 * D1-Low-10 / D1-Low-11
 * ------------------------------------------------------------------ */

describe("getter 语义修复", () => {
  it("getSortedAddedSites / getSortedEnabledDownloaders 不再原地改写另一个 getter 的数组", async () => {
    const store = await createMetadataStore();
    store.sites = { low: { sortIndex: 1 }, high: { sortIndex: 9 } } as any;
    store.downloaders = {
      dLow: { id: "dLow", enabled: true, sortIndex: 1 },
      dHigh: { id: "dHigh", enabled: true, sortIndex: 9 },
    } as any;

    const sitesBefore = store.getAddedSites.map((site) => site.id);
    const downloadersBefore = store.getEnabledDownloaders.map((downloader) => downloader.id);

    expect(store.getSortedAddedSites.map((site) => site.id)).toEqual(["high", "low"]);
    expect(store.getSortedEnabledDownloaders.map((downloader) => downloader.id)).toEqual(["dHigh", "dLow"]);

    expect(store.getAddedSites.map((site) => site.id)).toEqual(sitesBefore);
    expect(store.getEnabledDownloaders.map((downloader) => downloader.id)).toEqual(downloadersBefore);
  });

  it('getSearchSolutionName("all") 走 i18n，而不是硬编码「全站」', async () => {
    const store = await createMetadataStore();
    expect(store.getSearchSolutionName("all")).toBe(i18n.t("layout.header.searchPlan.all"));
    expect(store.getSearchSolutionName("all")).not.toBe("全站");
  });
});

/* ------------------------------------------------------------------ *
 * D1-Medium-06：removeSite 的级联清理
 * ------------------------------------------------------------------ */

describe("D1-Medium-06：removeSite 级联清理引用", () => {
  it("清理下载器排除列表 / 统计与时间线的已选站点 / flushPlan，并在方案清空时回退默认方案", async () => {
    const store = await createMetadataStore();
    const configStore = useConfigStore();
    const runtimeStore = useRuntimeStore();
    defineSite("siteA");
    defineSite("siteB");

    await store.addSite("siteA", { url: "https://sitea.example/" } as any, { reBuildMap: false });
    await store.addSite("siteB", { url: "https://siteb.example/" } as any, { reBuildMap: false });

    store.downloaders.d1 = { id: "d1", enabled: true, excludedSites: ["siteA", "siteB"] } as any;
    store.solutions.sol = solutionWith("sol", [
      { id: "i1", siteId: "siteA", searchEntries: { i1: {} } },
      { id: "i2", siteId: "siteB", searchEntries: { i2: {} } },
    ]) as any;
    store.defaultSolutionId = "sol";
    store.lastUserInfo.siteA = { name: "u" } as any;
    configStore.userDataTimelineControl.selectedSites = ["siteA", "siteB"];
    configStore.userStatisticControl.selectedSites = ["siteA"];
    runtimeStore.userInfo.flushPlan = { siteA: true, siteB: false };

    await store.removeSite("siteA", { reBuildMap: false });

    expect(store.downloaders.d1.excludedSites).toEqual(["siteB"]);
    expect(configStore.userDataTimelineControl.selectedSites).toEqual(["siteB"]);
    expect(configStore.userStatisticControl.selectedSites).toEqual([]);
    expect(runtimeStore.userInfo.flushPlan).toEqual({ siteB: false });
    expect(store.lastUserInfo.siteA).toBeUndefined();
    expect(store.solutions.sol.solutions.map((item) => item.siteId)).toEqual(["siteB"]);
    // 还有站点，默认方案保持不变
    expect(store.defaultSolutionId).toBe("sol");

    // 删掉最后一个站点：方案清空 → 默认方案回退到 "default"
    await store.removeSite("siteB", { reBuildMap: false });
    expect(store.solutions.sol.solutions).toEqual([]);
    expect(store.defaultSolutionId).toBe("default");
  });
});

/* ------------------------------------------------------------------ *
 * Info-I9：simplePatch 拒绝原型链路径
 * ------------------------------------------------------------------ */

describe("Info-I9：simplePatch 拒绝原型链段", () => {
  it("含 __proto__ 的路径被静默拒绝，不产生全局原型污染", async () => {
    const store = await createMetadataStore();
    store.sites.siteA = { url: "https://sitea.example/" } as any;

    await store.simplePatch("sites", "siteA", "__proto__.polluted", true as any);
    await store.simplePatch("sites", "siteA", "constructor.prototype.polluted", true as any);

    expect(({} as any).polluted).toBeUndefined();
    expect(Object.hasOwn(store.sites.siteA as any, "polluted")).toBe(false);
  });
});
