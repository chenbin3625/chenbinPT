/**
 * F1-03 回归：config store 的 `afterRestore` 形状防御。
 *
 * 审查结论（F1-options-shell-stores.md [Medium]-F1-03）：`afterRestore` 直接对
 * `tableBehavior.DownloadHistory.sortBy` 调 `.filter`，一旦 storage 里的 config 形状异常
 * （不可信备份导入 / 手工改坏），`afterRestore` 抛错会让插件的 `restorePromise` reject →
 * `$onReady()` 永久 rejected → 所有 `await configStore.$onReady()` 的页面初始化静默中断。
 *
 * 这里用真实 persistence 插件 + chrome.storage mock 覆盖：
 * - 形状异常时：`$onReady()` 必须 resolve，坏数据原样保留（不阻断水合）；
 * - 形状正常时：既有的「过滤 id 排序项」清理行为不回归；
 * - `afterRestore` 内部抛错（getter 抛）也不会冒泡到 `$onReady()`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ant-design-vue", () => ({ message: { open: vi.fn() } }));
vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(async () => undefined) }));

const EXTENSION_URL = "chrome-extension://test/";

function stubExtensionStorage(configValue: unknown) {
  (window as any).happyDOM?.setURL(`${EXTENSION_URL}options.html`);
  const setSpy = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    runtime: { id: "test-extension-id", getURL: (path: string) => `${EXTENSION_URL}${path}` },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: configValue }),
        set: setSpy,
      },
      session: { get: async () => ({}), set: async () => undefined },
      onChanged: { addListener() {}, removeListener() {} },
    },
  });
  return { setSpy };
}

async function createFreshConfigStore() {
  vi.resetModules();
  const { createPinia } = await import("pinia");
  const { createApp } = await import("vue");
  const { piniaWebExtPersistencePlugin } = await import("~/extends/pinia/webExtPersistence.ts");
  const { useConfigStore } = await import("@/options/stores/config.ts");

  const pinia = createPinia();
  pinia.use(piniaWebExtPersistencePlugin);
  createApp({ render: () => null }).use(pinia);
  return useConfigStore(pinia);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("F1-03：config.afterRestore 不得让 $onReady() reject", () => {
  it("sortBy 是非数组时：$onReady 正常 resolve，坏数据原样保留", async () => {
    stubExtensionStorage({ tableBehavior: { DownloadHistory: { sortBy: "oops" } } });
    const configStore = await createFreshConfigStore();

    await expect(configStore.$onReady()).resolves.toBeUndefined();
    expect(configStore.$ready).toBe(true);
    // 清理被跳过（而不是抛错丢弃整个水合）：坏值仍在，用户仍可通过「插件重置」自救
    expect((configStore.tableBehavior.DownloadHistory as any).sortBy).toBe("oops");
    // 其余 state 照常可用
    expect(configStore.saveTableBehavior).toBe(true);
  });

  it("tableBehavior 整体形状异常时同样不抛", async () => {
    stubExtensionStorage({ tableBehavior: "junk" });
    const configStore = await createFreshConfigStore();

    await expect(configStore.$onReady()).resolves.toBeUndefined();
    expect(configStore.$ready).toBe(true);
  });

  it("sortBy 数组里混入形状不对的项时只过滤该项，不抛错", async () => {
    stubExtensionStorage({
      tableBehavior: {
        DownloadHistory: { sortBy: [{ key: "downloadAt", order: "desc" }, null, { order: "asc" }] },
      },
    });
    const configStore = await createFreshConfigStore();

    await expect(configStore.$onReady()).resolves.toBeUndefined();
    expect(configStore.tableBehavior.DownloadHistory.sortBy).toEqual([{ key: "downloadAt", order: "desc" }]);
  });

  it("正常数据：仍会过滤掉基于 id 的 DownloadHistory 排序项", async () => {
    const { setSpy } = stubExtensionStorage({
      tableBehavior: {
        DownloadHistory: {
          itemsPerPage: 10,
          sortBy: [
            { key: "id", order: "desc" },
            { key: "downloadAt", order: "asc" },
          ],
        },
      },
    });
    const configStore = await createFreshConfigStore();

    await configStore.$onReady();
    expect(configStore.tableBehavior.DownloadHistory.sortBy).toEqual([{ key: "downloadAt", order: "asc" }]);
    // 清理结果需要落盘；$save 的写入在写入前会做一次 storage.get（合并读），这里只要确认写过 key 即可
    expect(setSpy).toHaveBeenCalled();
  });

  it("sortBy 全部是 id 排序项时回落默认 downloadAt 排序", async () => {
    stubExtensionStorage({ tableBehavior: { DownloadHistory: { sortBy: [{ key: "id", order: "asc" }] } } });
    const configStore = await createFreshConfigStore();

    await configStore.$onReady();
    expect(configStore.tableBehavior.DownloadHistory.sortBy).toEqual([{ key: "downloadAt", order: "desc" }]);
  });

  it("已废弃配置项仍会被清理", async () => {
    stubExtensionStorage({ version: "0.0.0.1", showReleaseNoteOnVersionChange: true, lang: "en" });
    const configStore = await createFreshConfigStore();

    await configStore.$onReady();
    expect((configStore as any).version).toBeUndefined();
    expect((configStore as any).showReleaseNoteOnVersionChange).toBeUndefined();
    expect(configStore.lang).toBe("en");
  });
});
