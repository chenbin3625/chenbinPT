/**
 * W12_options_settings 审查修复回归测试（F0172 – F0195）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActivePinia, setActivePinia } from "pinia";
import { defineComponent, h, nextTick, provide, ref } from "vue";
import { EResultParseStatus } from "@ptd/site";
import { siteMetadataIndex } from "@ptd/site/metadataIndex";

const sendMessageMock = vi.hoisted(() => vi.fn());

vi.mock("@/messages.ts", () => ({
  sendMessage: sendMessageMock,
  onMessage: vi.fn(),
}));

import { mountOptionsView, prepareOptionsPinia } from "../helpers/optionsView.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { createSetBaseConfigDraft, provideSetBaseConfigDraft } from "@/options/views/Settings/SetBase/configDraft.ts";

function flushMicrotasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("W12_options_settings review fixes", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("F0188 & F0181: SetSearchSolution/utils.ts 可在无 active Pinia 时导入，且去重判定对称", async () => {
    setActivePinia(undefined as any);
    expect(getActivePinia()).toBeUndefined();

    const utils = await import("@/options/views/Settings/SetSearchSolution/utils.ts");
    const categorized = { id: "s-cat", siteId: "demo", selectedCategories: { cat: "movie" } } as any;
    const defaultSol = { id: "default", siteId: "demo", selectedCategories: {} } as any;
    const defaultSol2 = { id: "default", siteId: "demo" } as any;
    const customA = { id: "c1", siteId: "demo", name: "Alpha" } as any;
    const customB = { id: "c2", siteId: "demo", name: "Beta" } as any;

    expect(utils.isDuplicateSearchSolution(categorized, defaultSol)).toBe(false);
    expect(utils.isDuplicateSearchSolution(defaultSol, categorized)).toBe(false);
    expect(utils.isDuplicateSearchSolution(defaultSol, defaultSol2)).toBe(true);
    expect(utils.isDuplicateSearchSolution(categorized, { ...categorized, id: "other" })).toBe(true);
    expect(utils.isDuplicateSearchSolution(customA, customB)).toBe(false);
    expect(utils.isDuplicateSearchSolution(customA, { ...customA, id: "c3" })).toBe(true);
  });

  it("F0172: SetBackup/Editor.vue 清空数字或关闭最后一条规则时不重置草稿，且深拷贝 sample.rules", async () => {
    const pinia = prepareOptionsPinia();
    const { default: SetBackupEditor } = await import("@/options/views/Settings/SetBackup/Editor.vue");

    const originalRule = { horizon: 30, interval: 7 };
    const clientConfig = ref<any>({
      id: "b1",
      type: "WebDAV",
      name: "MyWebDAV",
      address: "https://dav.example/",
      config: { endpoint: "https://dav.example/", username: "u", password: "p" },
      backupFields: ["cookies", "config"],
      retention: {
        time: { enabled: true, maxAge: 30 },
        count: { enabled: false, maxCount: 25 },
        sample: { enabled: false, rules: [originalRule] },
      },
    });

    const Root = defineComponent({
      setup: () => () =>
        h(SetBackupEditor as any, {
          modelValue: clientConfig.value,
          "onUpdate:modelValue": (v: any) => (clientConfig.value = v),
        }),
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      await view.settle(80);

      // 展开「高级设置 / 保留策略」折叠面板
      const collapseHeader = view.$<HTMLElement>(".ant-collapse-header")!;
      expect(collapseHeader).toBeTruthy();
      collapseHeader.click();
      await view.settle(80);

      const retentionSwitches = view.$$<HTMLButtonElement>(".retention-group button.ant-switch");
      const retentionInputs = view.$$<HTMLInputElement>(".retention-field input.ant-input-number-input");
      expect(retentionSwitches.length).toBeGreaterThanOrEqual(2);
      expect(retentionInputs.length).toBeGreaterThanOrEqual(2);

      const timeSwitch = retentionSwitches[0];
      const maxAgeInput = retentionInputs[0];
      const countInput = retentionInputs[1];
      expect(timeSwitch.getAttribute("aria-checked")).toBe("true");
      expect(maxAgeInput.disabled).toBe(false);
      expect(countInput.value).toBe("25");

      // 清空 maxAge（antd emit null -> clientConfig.retention 变为 undefined）
      maxAgeInput.value = "";
      maxAgeInput.dispatchEvent(new Event("input", { bubbles: true }));
      maxAgeInput.dispatchEvent(new Event("change", { bubbles: true }));
      await view.settle(60);

      // time 开关不得被反向 watcher 关掉，输入框不得被禁用，count.maxCount 也不得重置回 10
      expect(timeSwitch.getAttribute("aria-checked")).toBe("true");
      expect(maxAgeInput.disabled).toBe(false);
      expect(countInput.value).toBe("25");

      // 再关闭唯一开启的 time 开关，仍应保留自定义的 count.maxCount = 25
      timeSwitch.click();
      await view.settle(60);
      expect(countInput.value).toBe("25");

      // sample.rules 经过深拷贝，原对象不被原地修改
      expect(originalRule).toEqual({ horizon: 30, interval: 7 });
    } finally {
      view.unmount();
    }
  });

  it("F0173: BackupWindow.vue 在异步水合后同步 encryptionKey，且随机生成后撤销恢复为水合密钥而非空串", async () => {
    const pinia = prepareOptionsPinia();
    const configStore = useConfigStore(pinia);
    const { default: BackupWindow } = await import("@/options/views/Settings/SetBase/BackupWindow.vue");

    const configDraft = ref<any>(createSetBaseConfigDraft(configStore.$state));
    configDraft.value.backup.encryptionKey = "";

    const Root = defineComponent({
      setup() {
        provideSetBaseConfigDraft(configDraft);
        return () => h(BackupWindow as any);
      },
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      await view.settle(40);
      // 模拟 configStore.$onReady() 完成后 SetBase/Index.vue 重建 configDraft
      const hydrated = createSetBaseConfigDraft(configStore.$state);
      hydrated.backup.encryptionKey = "saved-secret-key-123";
      configDraft.value = hydrated;
      await view.settle(40);

      const keyInput = view.$<HTMLInputElement>("input.ant-input")!;
      expect(keyInput.value).toBe("saved-secret-key-123");

      // 点击「随机生成」（KeyOutlined）然后点击「撤销」（ArrowLeftOutlined）
      const randomBtn = view.$(".anticon-key")!.closest("button") as HTMLButtonElement;
      expect(randomBtn).toBeTruthy();

      randomBtn.click();
      await view.settle(80);
      expect(configDraft.value.backup.encryptionKey).not.toBe("saved-secret-key-123");
      expect(configDraft.value.backup.encryptionKey.length).toBeGreaterThan(0);

      // disabled 变为 false 后 antd Tooltip 会重渲染按钮节点，重新查询当前按钮再点击
      const undoBtn = view.$(".anticon-arrow-left")!.closest("button") as HTMLButtonElement;
      expect(undoBtn).toBeTruthy();
      expect(undoBtn.disabled).toBe(false);
      undoBtn.click();
      await view.settle(80);
      expect(keyInput.value).toBe("saved-secret-key-123");
      expect(configDraft.value.backup.encryptionKey).toBe("saved-secret-key-123");
    } finally {
      view.unmount();
    }
  });

  it("F0174: SearchEntityWindow.vue beforeSave 规范化并夹紧清空或越界的并发/上限数值", async () => {
    const pinia = prepareOptionsPinia();
    const configStore = useConfigStore(pinia);
    const { default: SearchEntityWindow } = await import("@/options/views/Settings/SetBase/SearchEntityWindow.vue");

    const configDraft = ref<any>(createSetBaseConfigDraft(configStore.$state));
    configDraft.value.searchEntity.queueConcurrency = null;
    configDraft.value.searchEntifyControl.maxTagCountBeforeGroup = -5;
    configDraft.value.mediaServerEntity.queueConcurrency = 0;
    configDraft.value.mediaServerEntity.searchLimit = 9999;

    const childRef = ref<any>(null);
    const Root = defineComponent({
      setup() {
        provideSetBaseConfigDraft(configDraft);
        return () => h(SearchEntityWindow as any, { ref: childRef });
      },
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      await view.settle(40);
      expect(typeof childRef.value?.beforeSave).toBe("function");
      await childRef.value.beforeSave();

      expect(configDraft.value.searchEntity.queueConcurrency).toBe(8);
      expect(configDraft.value.searchEntifyControl.maxTagCountBeforeGroup).toBe(0);
      expect(configDraft.value.mediaServerEntity.queueConcurrency).toBe(1);
      expect(configDraft.value.mediaServerEntity.searchLimit).toBe(500);

      // mediaServerEntity.queueConcurrency = null 与 searchLimit = null 走默认值
      configDraft.value.mediaServerEntity.queueConcurrency = null;
      configDraft.value.mediaServerEntity.searchLimit = null;
      await childRef.value.beforeSave();
      expect(configDraft.value.mediaServerEntity.queueConcurrency).toBe(5);
      expect(configDraft.value.mediaServerEntity.searchLimit).toBe(50);
    } finally {
      view.unmount();
    }
  });

  it("F0175: RecommendationMenu.vue 关闭菜单后中止未开始的后台富化请求", async () => {
    const pinia = prepareOptionsPinia();

    const resolvers: Array<(v: any) => void> = [];
    // 提供 14 条电影条目（超过并发数 10），使前 10 条在途、后 4 条在队列中等待
    const items = Array.from({ length: 14 }, (_, i) => ({
      id: String(i + 1),
      title: `Movie ${i + 1}`,
      site: "douban",
      category: "movie",
    }));

    sendMessageMock.mockImplementation((type: string) => {
      if (type === "getSocialRecommendations") {
        return Promise.resolve({ items, hasFailedSources: false });
      }
      if (type === "getSocialRecommendationItem") {
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      }
      return Promise.resolve(undefined);
    });

    const { default: RecommendationMenu } = await import("@/options/views/Layout/RecommendationMenu.vue");
    const view = mountOptionsView(RecommendationMenu, { pinia, router: true });
    try {
      const triggerBtn = view.$<HTMLButtonElement>("button")!;
      triggerBtn.click();
      await view.settle(80);

      const callsBeforeClose = sendMessageMock.mock.calls.filter(
        ([type]) => type === "getSocialRecommendationItem",
      ).length;
      expect(callsBeforeClose).toBeGreaterThan(0);
      expect(callsBeforeClose).toBeLessThan(items.length);

      // 关闭菜单并释放已在途的请求，队列中剩余项不应再发起 getSocialRecommendationItem
      triggerBtn.click();
      await view.settle(40);
      for (const resolve of resolvers) {
        resolve({ summary: "done" });
      }
      await view.settle(80);

      const callsAfterClose = sendMessageMock.mock.calls.filter(
        ([type]) => type === "getSocialRecommendationItem",
      ).length;
      expect(callsAfterClose).toBe(callsBeforeClose);
    } finally {
      view.unmount();
    }
  });

  it("F0176: SetBackup/HistoryDialog.vue 刷新后自动清理已不存在的选中路径", async () => {
    const pinia = prepareOptionsPinia();
    const metadataStore = useMetadataStore(pinia);
    metadataStore.backupServers = {
      bs1: { id: "bs1", type: "WebDAV", name: "DAV" } as any,
    };

    let currentHistory = [
      { path: "a.zip", filename: "a.zip", size: 10, time: Date.now() },
      { path: "b.zip", filename: "b.zip", size: 20, time: Date.now() },
    ];
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getBackupHistory") return currentHistory;
      if (type === "deleteBackupHistory") return true;
      return undefined;
    });

    const { default: HistoryDialog } = await import("@/options/views/Settings/SetBackup/HistoryDialog.vue");
    const open = ref(false);
    const Root = defineComponent({
      setup: () => () =>
        h(HistoryDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean) => (open.value = v),
          backupServerId: "bs1",
        }),
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      open.value = true;
      await view.settle(120);

      // 勾选第一行 a.zip
      const rowCheckboxes = Array.from(document.querySelectorAll<HTMLInputElement>("tbody input.ant-checkbox-input"));
      expect(rowCheckboxes.length).toBe(2);
      rowCheckboxes[0].click();
      await view.settle(60);

      // 顶部批量删除 NavButton 处于启用状态
      const batchDeleteBtn = document.querySelector<HTMLButtonElement>(".ant-modal-body > button")!;
      expect(batchDeleteBtn).toBeTruthy();
      expect(batchDeleteBtn.disabled).toBe(false);

      // 重新打开（触发 loadBackupHistory 返回不含 a.zip 的新列表），a.zip 应被剔除，批量删除按钮恢复禁用
      currentHistory = [{ path: "b.zip", filename: "b.zip", size: 20, time: Date.now() }];
      open.value = false;
      await view.settle(60);
      open.value = true;
      await view.settle(120);

      const batchDeleteBtnAfter = document.querySelector<HTMLButtonElement>(".ant-modal-body > button")!;
      expect(batchDeleteBtnAfter.disabled).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("F0177: SocialInformationWindow.vue beforeSave 校验并规范化 cacheDay 与 timeout", async () => {
    const pinia = prepareOptionsPinia();
    const configStore = useConfigStore(pinia);
    const { default: SocialInformationWindow } =
      await import("@/options/views/Settings/SetBase/SocialInformationWindow.vue");

    const configDraft = ref<any>(createSetBaseConfigDraft(configStore.$state));
    configDraft.value.socialSiteInformation.cacheDay = null;
    configDraft.value.socialSiteInformation.timeout = 0;

    const childRef = ref<any>(null);
    const Root = defineComponent({
      setup() {
        provideSetBaseConfigDraft(configDraft);
        return () => h(SocialInformationWindow as any, { ref: childRef });
      },
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      await view.settle(40);
      expect(typeof childRef.value?.beforeSave).toBe("function");
      await childRef.value.beforeSave();

      expect(configDraft.value.socialSiteInformation.cacheDay).toBe(7);
      expect(configDraft.value.socialSiteInformation.timeout).toBe(1000);

      configDraft.value.socialSiteInformation.cacheDay = 1;
      configDraft.value.socialSiteInformation.timeout = null;
      await childRef.value.beforeSave();
      expect(configDraft.value.socialSiteInformation.cacheDay).toBe(3);
      expect(configDraft.value.socialSiteInformation.timeout).toBe(10000);
    } finally {
      view.unmount();
    }
  });

  it("F0178: CustomSolutionDialog.vue 从 default 创建自定义方案时移除 selectedCategories", async () => {
    const pinia = prepareOptionsPinia();
    const metadataStore = useMetadataStore(pinia);
    vi.spyOn(metadataStore as any, "getSiteMergedMetadata", "get").mockReturnValue(vi.fn().mockResolvedValue([]));

    const { default: CustomSolutionDialog } =
      await import("@/options/views/Settings/SetSearchSolution/CustomSolutionDialog.vue");

    const open = ref(false);
    const saved: any[] = [];
    const Root = defineComponent({
      setup: () => () =>
        h(CustomSolutionDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean) => (open.value = v),
          solution: {
            id: "default",
            siteId: "demo",
            selectedCategories: { cat: "401" },
            searchEntries: {},
          },
          saveGeneratedSolution: (sol: any) => saved.push(sol),
        }),
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      open.value = true;
      await view.settle(100);

      const nameInput = document.querySelector<HTMLInputElement>(".ant-modal-body input.ant-input")!;
      nameInput.value = "My Custom";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle(40);

      const okBtn = document.querySelector<HTMLButtonElement>(".ant-modal-footer button.ant-btn-primary")!;
      okBtn.click();
      await view.settle(60);

      expect(saved.length).toBe(1);
      expect(saved[0].name).toBe("My Custom");
      expect(saved[0].id).not.toBe("default");
      expect(saved[0].selectedCategories).toBeUndefined();
    } finally {
      view.unmount();
    }
  });

  it("F0179: SolutionLabel.vue 使用 siteId:id 复合 key 且关闭事件 preventDefault 不自行隐藏", async () => {
    const pinia = prepareOptionsPinia();
    const { default: SolutionLabel } = await import("@/options/views/Settings/SetSearchSolution/SolutionLabel.vue");

    const removed: any[] = [];
    const solutions = [
      { id: "default", siteId: "siteA", name: "DefaultA" },
      { id: "default", siteId: "siteB", name: "DefaultB" },
    ];

    const view = mountOptionsView(SolutionLabel, {
      pinia,
      props: {
        solutions,
        closable: true,
        "onRemove:solution": (sol: any) => removed.push(sol),
      },
    });
    try {
      await view.settle(40);
      const tags = view.$$<HTMLElement>(".ant-tag");
      expect(tags.length).toBe(2);

      const closeIcons = view.$$<HTMLElement>(".ant-tag-close-icon");
      expect(closeIcons.length).toBe(2);
      closeIcons[0].click();
      await view.settle(40);

      expect(removed.length).toBe(1);
      expect(removed[0].siteId).toBe("siteA");
      expect(tags[0].classList.contains("ant-tag-hidden")).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("F0180: SetDownloader/Index.vue 筛选复选框完整循环 none -> required -> exclude -> none", async () => {
    const pinia = prepareOptionsPinia();
    const metadataStore = useMetadataStore(pinia);
    metadataStore.downloaders = {
      dl1: { id: "dl1", type: "qbittorrent", name: "QB1", address: "http://127.0.0.1:8080", enabled: true } as any,
    };

    const { default: SetDownloaderIndex } = await import("@/options/views/Settings/SetDownloader/Index.vue");
    const view = mountOptionsView(SetDownloaderIndex, { pinia });
    try {
      await view.settle(60);
      const filterIcon = view.$<HTMLElement>(".anticon-filter")!;
      filterIcon.click();
      await view.settle(80);

      const checkboxInput = document.querySelector<HTMLInputElement>(".ant-popover-inner input.ant-checkbox-input")!;
      const checkboxWrapper = checkboxInput.closest(".ant-checkbox")!;
      expect(checkboxWrapper).toBeTruthy();

      // 1st click: required (checked)
      checkboxInput.click();
      await view.settle(40);
      expect(checkboxWrapper.classList.contains("ant-checkbox-checked")).toBe(true);
      expect(checkboxWrapper.classList.contains("ant-checkbox-indeterminate")).toBe(false);

      // 2nd click: exclude (indeterminate)
      checkboxInput.click();
      await view.settle(40);
      expect(checkboxWrapper.classList.contains("ant-checkbox-checked")).toBe(false);
      expect(checkboxWrapper.classList.contains("ant-checkbox-indeterminate")).toBe(true);

      // 3rd click: none
      checkboxInput.click();
      await view.settle(40);
      expect(checkboxWrapper.classList.contains("ant-checkbox-checked")).toBe(false);
      expect(checkboxWrapper.classList.contains("ant-checkbox-indeterminate")).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("F0182: SetSearchSolution/EditDialog.vue 按站点自定义名/站点名映射过滤已添加方案", async () => {
    const pinia = prepareOptionsPinia();
    const metadataStore = useMetadataStore(pinia);
    const realSiteId = Object.keys(siteMetadataIndex)[0];
    metadataStore.sites = {
      [realSiteId]: { merge: { name: "MyCustomAlias" }, url: "https://x.example/" } as any,
    };
    metadataStore.siteNameMap = { [realSiteId]: "OfficialSiteX" };
    metadataStore.solutions = {
      sol1: {
        id: "sol1",
        name: "Sol 1",
        sort: 1,
        enabled: true,
        isDefault: false,
        createdAt: Date.now(),
        solutions: [{ id: "default", siteId: realSiteId, searchEntries: {} }],
      },
    };

    const { default: EditDialog } = await import("@/options/views/Settings/SetSearchSolution/EditDialog.vue");
    const open = ref(false);
    const Root = defineComponent({
      setup: () => () =>
        h(EditDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean) => (open.value = v),
          solutionId: "sol1",
        }),
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      open.value = true;
      await view.settle(120);

      const filterInput = document.querySelector<HTMLInputElement>(".ant-modal-body .ant-input-affix-wrapper input")!;
      const rightCol = document.querySelector<HTMLElement>(".ant-modal-body .ant-col-md-8")!;
      expect(filterInput).toBeTruthy();
      expect(rightCol).toBeTruthy();

      // 初始未过滤应有 1 个已添加方案标签
      expect(rightCol.querySelectorAll(".ant-tag").length).toBe(1);

      // 按自定义站点名过滤（siteFilter 经过 refDebounced 500ms）
      filterInput.value = "mycustomalias";
      filterInput.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle(580);
      expect(rightCol.querySelectorAll(".ant-tag").length).toBe(1);

      // 输入不匹配的关键词，应过滤为 0 个标签
      filterInput.value = "no-match-anywhere";
      filterInput.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle(580);
      expect(rightCol.querySelectorAll(".ant-tag").length).toBe(0);
    } finally {
      view.unmount();
    }
  });

  it("F0183: DefaultDownloaderEditDialog.vue 保存失败时回滚 defaultDownloader 且不共享可变引用", async () => {
    const pinia = prepareOptionsPinia();
    const metadataStore = useMetadataStore(pinia);
    metadataStore.downloaders = {
      dl1: { id: "dl1", type: "qbittorrent", name: "QB1", enabled: true } as any,
    };
    metadataStore.defaultDownloader = { id: "dl1", folder: "/initial", tags: "t1" };
    (metadataStore as any).$save = vi.fn().mockRejectedValueOnce(new Error("storage failed"));

    const { default: DefaultDownloaderEditDialog } =
      await import("@/options/views/Settings/SetDownloader/DefaultDownloaderEditDialog.vue");
    const open = ref(false);
    const Root = defineComponent({
      setup: () => () =>
        h(DefaultDownloaderEditDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean) => (open.value = v),
        }),
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      open.value = true;
      await view.settle(100);

      // a-auto-complete 内部的输入框是 .ant-select-selection-search-input（第 0 个为下载器选择框，第 1 个为下载目录）
      const selectInputs = Array.from(
        document.querySelectorAll<HTMLInputElement>(".ant-modal-body input.ant-select-selection-search-input"),
      );
      expect(selectInputs.length).toBeGreaterThanOrEqual(2);
      const folderInput = selectInputs[1];
      folderInput.value = "/changed";
      folderInput.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle(40);

      const okBtn = document.querySelector<HTMLButtonElement>(".ant-modal-footer button.ant-btn-primary")!;
      okBtn.click();
      await view.settle(80);

      expect(metadataStore.defaultDownloader).toEqual({ id: "dl1", folder: "/initial", tags: "t1" });
    } finally {
      view.unmount();
    }
  });

  it("F0184 & F0186: SetMediaServer/Editor.vue 补全缺失 auth、按 authField.required 标记必填、无时区偏差格式化超时", async () => {
    const pinia = prepareOptionsPinia();
    const { default: MediaServerEditor } = await import("@/options/views/Settings/SetMediaServer/Editor.vue");

    const clientConfig = ref<any>({
      id: "ms1",
      type: "emby",
      name: "Emby",
      address: "http://127.0.0.1:8096",
      timeout: 90000,
      // 故意省略 auth 以触发 F0184 兜底初始化
    });

    const Root = defineComponent({
      setup: () => () =>
        h(MediaServerEditor as any, {
          modelValue: clientConfig.value,
          "onUpdate:modelValue": (v: any) => (clientConfig.value = v),
        }),
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      await view.settle(120);

      expect(clientConfig.value.auth).toBeDefined();
      expect(typeof clientConfig.value.auth).toBe("object");

      // emby 定义了 "apikey"（必填）与 { name: "userId", required: false }（可选）
      const labels = view.$$<HTMLLabelElement>(".ant-form-item-label > label");
      const apiKeyLabel = labels.find((l) => l.textContent?.includes("apikey"));
      const userIdLabel = labels.find((l) => l.textContent?.includes("userId"));
      expect(apiKeyLabel?.classList.contains("ant-form-item-required")).toBe(true);
      expect(userIdLabel?.classList.contains("ant-form-item-required")).toBe(false);

      // 90000ms -> 01:30
      expect(view.text()).toContain("01:30");
    } finally {
      view.unmount();
    }
  });

  it("F0185: SetDownloader/Editor.vue 超时显示与本地时区无关", async () => {
    const pinia = prepareOptionsPinia();
    const { default: DownloaderEditor } = await import("@/options/views/Settings/SetDownloader/Editor.vue");

    const clientConfig = ref<any>({
      id: "dl1",
      type: "qbittorrent",
      name: "QB",
      address: "http://127.0.0.1:8080",
      username: "",
      password: "",
      timeout: 65000,
    });

    const Root = defineComponent({
      setup: () => () =>
        h(DownloaderEditor as any, {
          modelValue: clientConfig.value,
          "onUpdate:modelValue": (v: any) => (clientConfig.value = v),
        }),
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      await view.settle(80);
      expect(view.text()).toContain("01:05");
    } finally {
      view.unmount();
    }
  });

  it("F0187: UserInfoWindow.vue lastUserInfoAutoFlushAt 为 0 时显示占位符而非 1970", async () => {
    const prevChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      alarms: { get: vi.fn().mockResolvedValue(undefined) },
    };

    const pinia = prepareOptionsPinia();
    const configStore = useConfigStore(pinia);
    const metadataStore = useMetadataStore(pinia);
    metadataStore.lastUserInfoAutoFlushAt = 0;

    const { default: UserInfoWindow } = await import("@/options/views/Settings/SetBase/UserInfoWindow.vue");
    const configDraft = ref<any>(createSetBaseConfigDraft(configStore.$state));

    const Root = defineComponent({
      setup() {
        provideSetBaseConfigDraft(configDraft);
        return () => h(UserInfoWindow as any);
      },
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      await view.settle(40);
      expect(view.text()).not.toContain("1970");
      expect(view.text()).toContain("-");
    } finally {
      view.unmount();
      (globalThis as any).chrome = prevChrome;
    }
  });

  it("F0189, F0190 & F0191: SetSite/Index.vue 固定操作列生效、三态筛选循环正常、已移除站点禁用编辑按钮", async () => {
    const pinia = prepareOptionsPinia();
    const configStore = useConfigStore(pinia);
    configStore.tableActionColumnFixed = true;
    configStore.tableActionColumnPosition = "start";

    const metadataStore = useMetadataStore(pinia);
    metadataStore.sites = {
      "nonexistent-removed-site": { sortIndex: 100, url: "https://gone.example/" } as any,
    };

    const { default: SetSiteIndex } = await import("@/options/views/Settings/SetSite/Index.vue");
    const view = mountOptionsView(SetSiteIndex, { pinia });
    try {
      await view.settle(100);

      // F0190: 操作列固定到左侧后，表头应包含 ant-table-cell-fix-left
      const fixedLeftHeaders = view.$$("thead th.ant-table-cell-fix-left");
      expect(fixedLeftHeaders.length).toBeGreaterThan(0);

      // F0191: 不在 siteMetadataIndex 中的已移除站点，其编辑按钮禁用
      const editIcon = view.$(".anticon-edit");
      const editButton = editIcon?.closest("button") as HTMLButtonElement | null;
      expect(editButton).toBeTruthy();
      expect(editButton!.disabled).toBe(true);

      // F0189: 布尔筛选三态循环 none -> required -> exclude -> none
      const filterIcon = view.$<HTMLElement>(".anticon-filter")!;
      filterIcon.click();
      await view.settle(80);

      const cbInput = document.querySelector<HTMLInputElement>(".ant-popover-inner input.ant-checkbox-input")!;
      const cbWrap = cbInput.closest(".ant-checkbox")!;

      cbInput.click();
      await view.settle(40);
      expect(cbWrap.classList.contains("ant-checkbox-checked")).toBe(true);

      cbInput.click();
      await view.settle(40);
      expect(cbWrap.classList.contains("ant-checkbox-checked")).toBe(false);
      expect(cbWrap.classList.contains("ant-checkbox-indeterminate")).toBe(true);

      cbInput.click();
      await view.settle(40);
      expect(cbWrap.classList.contains("ant-checkbox-checked")).toBe(false);
      expect(cbWrap.classList.contains("ant-checkbox-indeterminate")).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("F0191, F0192 & F0193: SetSite/Editor.vue 捕获缺失站点加载异常、切换回官方 URL 解除非法自定义 URL 阻塞、无时区偏差格式化时长", async () => {
    const pinia = prepareOptionsPinia();
    const metadataStore = useMetadataStore(pinia);
    const runtimeStore = useRuntimeStore(pinia);
    const snackbarSpy = vi.spyOn(runtimeStore, "showSnackbar");

    const getMetaMock = vi.fn().mockRejectedValueOnce(new Error("site removed"));
    const getConfigMock = vi.fn();
    vi.spyOn(metadataStore as any, "getSiteMetadata", "get").mockReturnValue(getMetaMock);
    vi.spyOn(metadataStore as any, "getSiteUserConfig", "get").mockReturnValue(getConfigMock);

    const { default: SetSiteEditor } = await import("@/options/views/Settings/SetSite/Editor.vue");
    const siteId = ref("removed-site");
    const userConfig = ref<any>({ sortIndex: 100, url: "", inputSetting: {} });
    const formValid = ref<boolean>(true);

    const Root = defineComponent({
      setup() {
        provide("storedSiteUserConfig", userConfig);
        return () =>
          h(SetSiteEditor as any, {
            modelValue: siteId.value,
            "onUpdate:modelValue": (v: string) => (siteId.value = v),
            "onUpdate:formValid": (v: boolean) => (formValid.value = v),
          });
      },
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      await view.settle(80);
      expect(formValid.value).toBe(false);
      expect(view.$(".ant-alert-error")).toBeTruthy();
      expect(snackbarSpy).toHaveBeenCalled();

      // F0192 & F0193: 切换到正常站点
      getMetaMock.mockResolvedValueOnce({
        id: "valid-site",
        name: "Valid Site",
        urls: ["https://official.example/"],
        type: "private",
      });
      getConfigMock.mockResolvedValueOnce({
        sortIndex: 100,
        url: "https://official.example/",
        timeout: 30000,
        downloadInterval: 65,
        inputSetting: {},
      });

      siteId.value = "valid-site";
      await view.settle(80);
      expect(formValid.value).toBe(true);
      expect(view.text()).toContain("00:30");
      expect(view.text()).toContain("01:05");

      // 输入非法自定义 URL -> 表单无效，且 URL 表单项显示错误 help
      const radioCustomInput = view.$<HTMLInputElement>(".ant-radio-group input.ant-input")!;
      expect(radioCustomInput).toBeTruthy();
      radioCustomInput.value = "not-a-valid-url";
      radioCustomInput.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle(60);
      expect(formValid.value).toBe(false);
      expect(
        view.$(".ant-radio-group")?.closest(".ant-form-item")?.querySelector(".ant-form-item-explain"),
      ).toBeTruthy();

      // 切回官方 URL 单选框 -> 即使自定义输入框保留旧文本，表单应立刻恢复有效
      const officialRadio = view.$<HTMLInputElement>(".ant-radio-group input.ant-radio-input")!;
      officialRadio.click();
      await view.settle(60);
      expect(userConfig.value.url).toBe("https://official.example/");
      expect(formValid.value).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("F0194: OneClickImportDialog.vue 导入进行中禁用 CheckSwitchButton 且使用队列快照", async () => {
    const pinia = prepareOptionsPinia();
    const metadataStore = useMetadataStore(pinia);
    vi.spyOn(metadataStore as any, "getSiteUserConfig", "get").mockReturnValue(
      vi.fn().mockResolvedValue({ sortIndex: 100 }),
    );
    vi.spyOn(metadataStore, "addSite").mockResolvedValue(undefined as any);
    vi.spyOn(metadataStore, "removeSite").mockResolvedValue(undefined as any);
    vi.spyOn(metadataStore, "buildSiteMapCache").mockResolvedValue(undefined as any);

    let resolveSearch!: (v: any) => void;
    sendMessageMock.mockImplementation((type: string) => {
      if (type === "getSiteSearchResult") {
        return new Promise((r) => {
          resolveSearch = r;
        });
      }
      return Promise.resolve(undefined);
    });

    const { default: OneClickImportDialog } = await import("@/options/views/Settings/SetSite/OneClickImportDialog.vue");
    const open = ref(false);
    const Root = defineComponent({
      setup: () => () =>
        h(OneClickImportDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean) => (open.value = v),
        }),
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      open.value = true;
      await view.settle(100);

      // 点击「全选 / 反选」按钮（CheckSwitchButton）
      const switchBtn = document.querySelector<HTMLButtonElement>(".ptd-section-heading button.ant-btn-text")!;
      expect(switchBtn).toBeTruthy();
      expect(switchBtn.disabled).toBe(false);
      switchBtn.click();
      await view.settle(60);

      // 点击导入按钮
      const okBtn = document.querySelector<HTMLButtonElement>(".ant-modal-footer button.ant-btn-primary")!;
      okBtn.click();
      await flushMicrotasks();
      await nextTick();
      await view.settle(40);

      // 导入进行中：CheckSwitchButton 必须被禁用
      expect(switchBtn.disabled).toBe(true);

      // 释放第一个请求并结束后续测试
      sendMessageMock.mockResolvedValue({ status: EResultParseStatus.success });
      resolveSearch?.({ status: EResultParseStatus.success });
      await view.settle(80);
    } finally {
      view.unmount();
    }
  });

  it("F0195: SortIndexMoveButton.vue 忽略 pointerleave / pointercancel 与非主键点击", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { default: SortIndexMoveButton } = await import("@/options/views/Settings/SetSite/SortIndexMoveButton.vue");

    const moves: string[] = [];
    const view = mountOptionsView(SortIndexMoveButton, {
      props: {
        direction: "up",
        title: "move up",
        onMove: (pos: string) => moves.push(pos),
      },
    });
    try {
      await nextTick();
      const button = view.$<HTMLButtonElement>("button")!;

      // 按下后移出（pointerleave）不应触发短按移动
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      vi.advanceTimersByTime(100);
      button.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, cancelable: true, button: 0 }));
      expect(moves).toEqual([]);

      // 按下后取消（pointercancel）不应触发短按移动
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      vi.advanceTimersByTime(100);
      button.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, cancelable: true, button: 0 }));
      expect(moves).toEqual([]);

      // 右键短按 & 长按不应触发移动
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 2 }));
      vi.advanceTimersByTime(700);
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 2 }));
      expect(moves).toEqual([]);

      // 左键正常短按触发 "up"
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      vi.advanceTimersByTime(100);
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
      expect(moves).toEqual(["up"]);
    } finally {
      view.unmount();
    }
  });
});
