/**
 * options-shell-a 修复回归（第三轮审查）。
 *
 * 覆盖的问题：
 * - OPTIONSSHELL-1：DeleteDialog 不再用 Promise.allSettled 吞掉删除失败；
 * - OPTIONSSHELL-2：单个站点定义缺失不再让整张 siteHostMap/siteNameMap 停在旧值，siteIndex 仍同步且提示一次；
 * - OPTIONSSHELL-4：addSite({ reBuildMap:false }) 返回前必须已把站点配置交给持久化层（一键导入的 URL 探测）；
 * - OPTIONSSHELL-5：editSearchSnapshotDataName 对已删除快照的存在性守卫（对齐 simplePatch 的 V-6）；
 * - OPTIONSSHELL-7：saveSearchSnapshotData 先落外部数据、成功后才登记内存元数据，失败要提示而不是留幽灵快照。
 *
 * 依赖处理与 metadataSearchSolution.test.ts 保持一致：`@ptd/site` 只暴露 metadata.ts 真正用到的两个
 * 运行时函数（`getDefinedSiteMetadata` 对不在构建产物里的站点 id 抛 TypeError —— 这正是
 * OPTIONSSHELL-2 的触发条件），`@/messages.ts` 被 mock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createApp, defineComponent, h, ref } from "vue";

const { sendMessageMock, getDefinedSiteMetadataMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async (_type: string, _payload?: any): Promise<void> => undefined),
  getDefinedSiteMetadataMock: vi.fn(),
}));

vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
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

import { piniaWebExtPersistencePlugin } from "~/extends/pinia/webExtPersistence.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { mountOptionsView } from "../../helpers/optionsView.ts";

const { default: DeleteDialog } = await import("@/options/components/DeleteDialog.vue");

/** 当前测试里"存在于构建产物中"的站点定义 */
let knownSites: Set<string>;

function defineSite(siteId: string) {
  knownSites.add(siteId);
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

function siteIndexWrites() {
  return (sendMessageMock.mock.calls as unknown as Array<[string, any]>).filter(
    ([type, payload]) => type === "setExtStorage" && payload?.key === "siteIndex",
  );
}

function modalOkButton() {
  // DeleteDialog 用 ok-type="danger"，antd 渲染成 ant-btn-dangerous（不带 ant-btn-primary）
  return document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-dangerous")!;
}

describe("OPTIONSSHELL-1：DeleteDialog 不再吞掉删除失败", () => {
  it("部分删除失败时给出一次提示并带上失败 id，弹窗照常关闭", async () => {
    const open = ref(true);
    const succeeded: string[] = [];
    const confirmDelete = vi.fn(async (toDeleteId: string) => {
      if (toDeleteId === "b") {
        throw new Error("站点定义加载失败");
      }
      succeeded.push(toDeleteId);
    });

    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(DeleteDialog as any, {
            modelValue: open.value,
            "onUpdate:modelValue": (v: boolean) => (open.value = v),
            toDeleteIds: ["a", "b", "c"],
            confirmDelete,
          }),
      }),
    );
    const snackbarSpy = vi.spyOn(useRuntimeStore(), "showSnakebar");

    try {
      await view.settle();
      modalOkButton().click();
      await view.settle();

      // 单个失败不影响其它项（allSettled 语义保留）
      expect(confirmDelete).toHaveBeenCalledTimes(3);
      expect(succeeded.sort()).toEqual(["a", "c"]);
      // 失败必须可见，且能定位到具体 id（修复前这里零提示）
      expect(snackbarSpy).toHaveBeenCalledTimes(1);
      expect(snackbarSpy.mock.calls[0][0]).toContain("b");
      expect(snackbarSpy.mock.calls[0][1]).toMatchObject({ color: "error" });
      expect(open.value).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("全部成功时不提示", async () => {
    const open = ref(true);
    const confirmDelete = vi.fn(async () => undefined);

    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(DeleteDialog as any, {
            modelValue: open.value,
            "onUpdate:modelValue": (v: boolean) => (open.value = v),
            toDeleteIds: ["a", "b"],
            confirmDelete,
          }),
      }),
    );
    const snackbarSpy = vi.spyOn(useRuntimeStore(), "showSnakebar");

    try {
      await view.settle();
      modalOkButton().click();
      await view.settle();

      expect(confirmDelete).toHaveBeenCalledTimes(2);
      expect(snackbarSpy).not.toHaveBeenCalled();
      expect(open.value).toBe(false);
    } finally {
      view.unmount();
    }
  });
});

describe("metadata store 修复（OPTIONSSHELL-2/4/5/7）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    knownSites = new Set();
    sendMessageMock.mockReset();
    sendMessageMock.mockImplementation(async () => undefined);
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

  it("OPTIONSSHELL-4：addSite({ reBuildMap:false }) 返回前已把站点配置交给持久化层", async () => {
    const store = await createMetadataStore();
    const persistedSites: Array<Record<string, any>> = [];
    store.$save = vi.fn(async () => {
      persistedSites.push(JSON.parse(JSON.stringify(store.sites)));
    });

    // 一键导入的私有站点探测：addSite 之后立刻 sendMessage("getSiteSearchResult")，
    // offscreen 侧读的是 chrome.storage 里的 metadata.sites
    await store.addSite("multi", { url: "https://mirror2.example/" } as any, { reBuildMap: false });

    expect(store.$save).toHaveBeenCalledTimes(1);
    expect(persistedSites).toHaveLength(1);
    expect(persistedSites[0].multi.url).toBe("https://mirror2.example/");
  });

  it("OPTIONSSHELL-2：一个站点定义缺失不再让整张映射停在旧值，siteIndex 仍同步并提示一次", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");
    store.sites.siteA = { url: "https://sitea.example/" } as any;
    // 用户配置仍在、但站点定义已从构建产物移除的「毒」站点
    store.sites.ghost = { url: "https://ghost.example/" } as any;
    const snackbarSpy = vi.spyOn(useRuntimeStore(), "showSnakebar");

    await store.buildSiteMapCache();

    // 其余站点照常进表（修复前整个赋值被跳过，两张表停在旧值）
    expect(store.siteNameMap).toEqual({ siteA: "站点 siteA" });
    expect(store.siteHostMap["sitea.example"]).toBe("siteA");
    // 用户配置里的 url 仍然可用（这段映射不依赖站点定义）
    expect(store.siteHostMap["ghost.example"]).toBe("ghost");

    // siteIndex 必须同步（修复前循环抛错后完全不执行）
    expect(siteIndexWrites().at(-1)?.[1].value.siteNameMap).toEqual({ siteA: "站点 siteA" });

    // 坏站点不可静默消失：提示一次
    expect(snackbarSpy).toHaveBeenCalledTimes(1);
    expect(snackbarSpy.mock.calls[0][0]).toContain("ghost");
  });

  it("OPTIONSSHELL-2：同一坏站点反复重建只提示一次", async () => {
    const store = await createMetadataStore();
    defineSite("siteA");
    store.sites.siteA = { url: "https://sitea.example/" } as any;
    store.sites.ghost = { url: "https://ghost.example/" } as any;
    const snackbarSpy = vi.spyOn(useRuntimeStore(), "showSnakebar");

    await store.buildSiteNameMap();
    await store.buildSiteNameMap();
    await store.buildSiteHostMap();

    expect(snackbarSpy).toHaveBeenCalledTimes(1);
  });

  it("OPTIONSSHELL-5：快照已被别处删除时改名不抛错、不落盘、给出提示", async () => {
    const store = await createMetadataStore();
    const snackbarSpy = vi.spyOn(useRuntimeStore(), "showSnakebar");
    const saveSpy = vi.spyOn(store, "$save").mockResolvedValue(undefined);

    await expect(store.editSearchSnapshotDataName("ghost-snapshot", "新名字")).resolves.toBeUndefined();

    expect(snackbarSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("OPTIONSSHELL-5：快照存在时正常改名并在去抖窗口后落盘", async () => {
    const store = await createMetadataStore();
    store.snapshots["snap1"] = { id: "snap1", name: "旧名字", createdAt: 0, recordCount: 0 } as any;
    const saveSpy = vi.spyOn(store, "$save").mockResolvedValue(undefined);

    await store.editSearchSnapshotDataName("snap1", "新名字");

    expect(store.snapshots.snap1.name).toBe("新名字");
    await vi.advanceTimersByTimeAsync(600);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("OPTIONSSHELL-7：外部快照写入失败时不登记内存元数据并提示失败", async () => {
    const store = await createMetadataStore();
    const runtime = useRuntimeStore();
    const snackbarSpy = vi.spyOn(runtime, "showSnakebar");
    runtime.search.isSearching = false;
    runtime.search.searchResult = [{ title: "t" }] as any;
    sendMessageMock.mockRejectedValueOnce(new Error("quota exceeded"));

    await expect(store.saveSearchSnapshotData("失败快照")).resolves.toBeUndefined();

    // 不留「幽灵快照」：内存里没有任何记录，之后任意 $save 也不会把它落盘
    expect(store.snapshots).toEqual({});
    expect(snackbarSpy).toHaveBeenCalledTimes(1);
    expect(snackbarSpy.mock.calls[0][1]).toMatchObject({ color: "error" });
  });

  it("OPTIONSSHELL-7：元数据登记发生在外部写入成功之后", async () => {
    const store = await createMetadataStore();
    const runtime = useRuntimeStore();
    runtime.search.isSearching = false;
    runtime.search.searchResult = [{ title: "t1" }, { title: "t2" }] as any;

    let snapshotsWhenSend = -1;
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "saveSearchResultSnapshotData") {
        snapshotsWhenSend = Object.keys(store.snapshots).length;
      }
      return undefined;
    });

    await store.saveSearchSnapshotData("首条");

    expect(snapshotsWhenSend).toBe(0); // 写外部数据时内存里还没有元数据（修复前是 1）
    const saved = Object.values(store.snapshots);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "首条", recordCount: 2 });
  });
});
