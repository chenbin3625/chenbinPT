/**
 * 表格操作列位置与固定（移植自上游 58be52e883 / #1598）。
 *
 * 上游在 Vuetify 的 `DataTableHeader[]` 层做这件事；fork 改在 antd column 层
 * （`applyTableActionColumn`），因此这里断言的是：
 * - helper 语义：默认行尾 / start 行首 / fixed + start → left / fixed + end → right / 响应配置变化；
 * - 真实页面接线：表头顺序、antd 的固定列 class、无 scroll 表格在开启固定后补的 scroll.x；
 * - fork 特有的坑：`SetBase/configDraft.ts` 白名单（草稿里改值不写 store，保存后才写）。
 *
 * 页面用真实挂载（参照 tests/entries/options/myCollection.test.ts / keepUploadTaskTable.test.ts 的写法）。
 */
import Antd from "ant-design-vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { RouterView, createMemoryHistory, createRouter } from "vue-router";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

/** 空实现占位组件（隔离 MyData 的弹窗 / 等级浮层等重子组件） */
function stub(name: string) {
  return {
    default: defineComponent({ name, setup: () => () => h("div", { class: `stub-${name}` }) }),
  };
}
vi.mock("@/options/views/Overview/MyData/UserLevelRequirementsTd.vue", () => stub("UserLevelRequirementsTd"));
vi.mock("@/options/views/Overview/MyData/HistoryDataViewDialog.vue", () => stub("HistoryDataViewDialog"));
vi.mock("@/options/views/Overview/MyData/ExportUserInfoDialog.vue", () => stub("ExportUserInfoDialog"));
vi.mock("@/options/views/Overview/components/ColumnSelector.vue", () => stub("ColumnSelector"));

const sleep = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

type ConfigStore = Awaited<ReturnType<typeof useConfigStore>>;
let useConfigStore: typeof import("@/options/stores/config.ts").useConfigStore;

/** 取 i18n 里的操作列标题（避免测试里硬编码中文） */
let t: (key: string) => string;

beforeEach(async () => {
  document.body.innerHTML = "";
  sendMessageMock.mockReset();
  ({ useConfigStore } = await import("@/options/stores/config.ts"));
  const { i18nInstance } = await import("@/options/plugins/i18n.ts");
  t = i18nInstance.global.t as (key: string) => string;
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** 把 helper 需要的 config store 挂到新 pinia 上（$save 是持久化插件注入的，测试里给个替身） */
async function freshConfig(configure?: (configStore: ConfigStore) => void) {
  const pinia = prepareOptionsPinia();
  const configStore = useConfigStore(pinia);
  (configStore as any).$save = vi.fn(async () => undefined);
  configure?.(configStore);
  return { pinia, configStore };
}

/** 表头文字序列（去掉 antd 排序图标等噪声：直接取 textContent trim） */
const headerTexts = (root: ParentNode) =>
  Array.from(root.querySelectorAll(".ant-table-thead th")).map((th) => th.textContent?.trim() ?? "");

describe("applyTableActionColumn（antd column 层 helper）", () => {
  async function loadHelper() {
    const mod = await import("@/options/views/Overview/utils/antdTable.ts");
    return mod;
  }

  const baseColumns = (): Record<string, any>[] => [
    { title: "site", key: "site" },
    { title: "size", key: "size" },
    { title: t("common.action"), key: "action" },
  ];

  it("默认（行尾 / 不固定）：操作列仍在最后且不带 fixed", async () => {
    await freshConfig();
    const { applyTableActionColumn } = await loadHelper();
    const columns = applyTableActionColumn(baseColumns());

    expect(columns.map((column) => column.key)).toEqual(["site", "size", "action"]);
    expect(columns[columns.length - 1].fixed).toBeUndefined();
  });

  it("position=start：操作列移到行首；改回 end 复原", async () => {
    const { configStore } = await freshConfig();
    const { applyTableActionColumn } = await loadHelper();

    configStore.tableActionColumnPosition = "start";
    expect(applyTableActionColumn(baseColumns()).map((column) => column.key)).toEqual(["action", "site", "size"]);

    configStore.tableActionColumnPosition = "end";
    expect(applyTableActionColumn(baseColumns()).map((column) => column.key)).toEqual(["site", "size", "action"]);
  });

  it("fixed 打开：start → fixed:'left'，end → fixed:'right'", async () => {
    const { configStore } = await freshConfig();
    const { applyTableActionColumn } = await loadHelper();

    configStore.tableActionColumnFixed = true;
    configStore.tableActionColumnPosition = "start";
    expect(applyTableActionColumn(baseColumns())[0]).toMatchObject({ key: "action", fixed: "left" });

    configStore.tableActionColumnPosition = "end";
    const columns = applyTableActionColumn(baseColumns());
    expect(columns[columns.length - 1]).toMatchObject({ key: "action", fixed: "right" });
  });

  it("在 computed 中调用时，配置变更会驱动列重新排序（响应式）", async () => {
    const { configStore } = await freshConfig();
    const { applyTableActionColumn } = await loadHelper();
    const { computed } = await import("vue");

    const columns = computed(() => applyTableActionColumn(baseColumns()));
    expect(columns.value[columns.value.length - 1].key).toBe("action");

    configStore.tableActionColumnPosition = "start";
    configStore.tableActionColumnFixed = true;
    expect(columns.value[0]).toMatchObject({ key: "action", fixed: "left" });
  });

  it("没有操作列的表格原样返回（不报错、不重排）", async () => {
    await freshConfig();
    const { applyTableActionColumn } = await loadHelper();
    const columns = [{ title: "site", key: "site" }];
    expect(applyTableActionColumn(columns)).toBe(columns);
  });
});

describe("列表页接线：MyData", () => {
  async function mountMyData(configure?: (configStore: ConfigStore) => void) {
    const { pinia, configStore } = await freshConfig(configure);
    const { default: MyData } = await import("@/options/views/Overview/MyData/Index.vue");
    const view = mountOptionsView(MyData, { pinia, router: true });
    await view.settle(120);
    return { view, configStore };
  }

  it("默认：操作列在行尾、不固定；固定列过滤逻辑不被破坏", async () => {
    const { view } = await mountMyData((configStore) => {
      // 只显示用户名列：操作列（props.disabled）必须常显，且仍在行尾
      configStore.tableBehavior.MyData.columns = ["name"];
    });

    const headers = headerTexts(view.host);
    expect(headers.filter((text) => text === t("MyData.table.userData"))).toHaveLength(0);
    expect(headers[headers.length - 1], "默认操作列应在行尾").toBe(t("common.action"));
    expect(view.$(".ant-table-has-fix-left"), "默认不应固定任何列").toBeNull();
    expect(view.$(".ant-table-has-fix-right")).toBeNull();
    view.unmount();
  });

  it("position=start + fixed：操作列在行首（选择列/固定列之后）并固定到左侧", async () => {
    const { view } = await mountMyData((configStore) => {
      configStore.tableBehavior.MyData.columns = ["name"];
      configStore.tableActionColumnPosition = "start";
      configStore.tableActionColumnFixed = true;
    });

    const headers = headerTexts(view.host);
    const actionIndex = headers.indexOf(t("common.action"));
    // 行首是选择列（表头为空），操作列排在它之后成为第一个有标题的列
    expect(actionIndex, "操作列应紧跟在选择列之后").toBeGreaterThanOrEqual(1);
    expect(headers.slice(actionIndex + 1), "操作列之后不应再有列头文字是「操作」").not.toContain(t("common.action"));

    expect(view.$(".ant-table-has-fix-left"), "antd 固定列必须实际生效").not.toBeNull();
    // MyData 在测试里没有用户数据行，固定效果用表头单元格断言：
    // 选择列 + 操作列都应带 fix-left class（固定列必须连续）
    const fixedHeaderCells = view.$$<HTMLElement>(".ant-table-thead th.ant-table-cell-fix-left");
    expect(fixedHeaderCells.length, "表头的选择列与操作列都应固定").toBeGreaterThanOrEqual(2);
    view.unmount();
  });
});

describe("列表页接线：KeepUploadTask（含展开列）", () => {
  function makeTask(id: string, time: number) {
    return {
      id,
      time,
      title: `task-${id}`,
      size: 1024,
      downloadOptions: { downloaderId: "d1", clientName: "QB", savePath: "/downloads" },
      items: [{ site: "s1", title: `${id}-0`, link: "https://example.com/1", url: "https://example.com/2", size: 1 }],
    };
  }

  async function mountKeepUpload(configure?: (configStore: ConfigStore) => void) {
    const { pinia, configStore } = await freshConfig(configure);
    sendMessageMock.mockImplementation(async (type: string) =>
      type === "getKeepUploadTasks" ? [makeTask("a", 1)] : undefined,
    );
    const { default: KeepUploadTask } = await import("@/options/views/Overview/KeepUploadTask/Index.vue");
    const view = mountOptionsView(KeepUploadTask, { pinia });
    await view.settle(120);
    return { view, configStore };
  }

  it("默认：操作列在行尾、无固定列", async () => {
    const { view } = await mountKeepUpload();
    const headers = headerTexts(view.host);
    expect(headers[headers.length - 1]).toBe(t("common.action"));
    expect(view.$(".ant-table-has-fix-right")).toBeNull();
    view.unmount();
  });

  it("position=start + fixed：展开列与选择列一起固定在左侧（固定列连续）", async () => {
    const { view } = await mountKeepUpload((configStore) => {
      configStore.tableActionColumnPosition = "start";
      configStore.tableActionColumnFixed = true;
    });

    const headerCells = view.$$<HTMLElement>(".ant-table-thead th");
    const actionIndex = headerTexts(view.host).indexOf(t("common.action"));
    expect(actionIndex).toBeGreaterThanOrEqual(2);
    // 行首两列（展开列 + 选择列）都必须固定，否则横向滚动时操作列会盖住它们
    expect(headerCells[0].classList.contains("ant-table-cell-fix-left"), "展开列应固定").toBe(true);
    expect(headerCells[1].classList.contains("ant-table-cell-fix-left"), "选择列应固定").toBe(true);
    expect(headerCells[actionIndex].classList.contains("ant-table-cell-fix-left")).toBe(true);
    view.unmount();
  });
});

describe("列表页接线：SetBackup/HistoryDialog（静态数组改 computed + 动态 scroll）", () => {
  async function mountHistoryDialog(configure?: (configStore: ConfigStore) => void) {
    const { pinia, configStore } = await freshConfig(configure);
    sendMessageMock.mockImplementation(async (type: string) => (type === "getBackupHistory" ? [] : undefined));
    const { default: HistoryDialog } = await import("@/options/views/Settings/SetBackup/HistoryDialog.vue");
    const view = mountOptionsView(HistoryDialog, {
      pinia,
      props: { modelValue: true, backupServerId: "backup-1" },
      router: true,
    } as any);
    await view.settle(150);
    return { view, configStore };
  }

  it("默认：操作列在行尾；没有 scroll 时不出现横向滚动容器", async () => {
    const { view } = await mountHistoryDialog();
    // a-modal 会 teleport 到 body，表头在 document 里
    const headers = headerTexts(document);
    expect(headers[headers.length - 1]).toBe(t("common.action"));
    expect(document.querySelector(".ant-table-scroll-horizontal"), "默认态不应切到横向滚动布局").toBeNull();
    view.unmount();
  });

  it("开启固定后：动态补 scroll.x、操作列固定到右侧；配置变化驱动列重排（computed 生效）", async () => {
    const { view, configStore } = await mountHistoryDialog((configStore) => {
      configStore.tableActionColumnFixed = true;
    });
    await sleep(60);

    expect(document.querySelector(".ant-table-scroll-horizontal"), "fixed 必须补 scroll.x 才生效").not.toBeNull();
    expect(document.querySelector(".ant-table-has-fix-right"), "操作列应固定到右侧").not.toBeNull();

    // 把操作列改到行首：computed 必须响应（上游 #1598 里本表是静态数组，改造漏了就不会更新）
    configStore.tableActionColumnPosition = "start";
    await nextTick();
    await sleep(60);
    expect(headerTexts(document).indexOf(t("common.action"))).toBe(1);
    expect(document.querySelector(".ant-table-has-fix-left")).not.toBeNull();
    view.unmount();
  });
});

describe("SetBase「数据表格」分区：草稿白名单（fork 特有）", () => {
  async function mountSetBaseUi(configure?: (configStore: ConfigStore) => void) {
    const pinia = prepareOptionsPinia();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const { setBaseChildren } = await import("@/options/plugins/router.ts");
    const { default: SetBaseIndex } = await import("@/options/views/Settings/SetBase/Index.vue");

    const configStore = useConfigStore(pinia);
    configure?.(configStore);
    const metadataStore = useMetadataStore(pinia);
    (metadataStore as any).$save = vi.fn(async () => undefined);
    useRuntimeStore(pinia);
    const configSave = vi.fn(async () => undefined);
    (configStore as any).$save = configSave;

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: SetBaseIndex as any, children: setBaseChildren as any }],
    });
    await router.push({ name: "SetBaseUi" });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(RouterView) });
    app.use(pinia);
    app.use(i18nInstance);
    app.use(Antd as any);
    app.use(router);
    app.mount(host);
    await sleep(180);

    return { app, host, configStore, configSave, t: i18nInstance.global.t as (key: string) => string };
  }

  const rowByLabel = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(".ptd-settings-row")).find((node) =>
      node.textContent?.includes(label),
    );

  it("「数据表格」分区存在，改操作列位置 / 固定只改草稿；保存后才写回 store", async () => {
    const harness = await mountSetBaseUi();
    try {
      const { configStore } = harness;

      expect(harness.host.textContent, "应有「数据表格」分区标题").toContain(harness.t("SetBase.ui.dataTable"));
      const positionRow = rowByLabel(harness.t("SetBase.ui.tableActionColumnPosition"));
      expect(positionRow, "应有「操作列位置」配置行").toBeTruthy();
      const fixedRow = rowByLabel(harness.t("SetBase.ui.tableActionColumnFixed"));
      expect(fixedRow, "应有「固定操作列」配置行").toBeTruthy();

      // 1) 操作列位置：草稿里改成 start，store 不变
      // antd 的 a-select 在 mousedown 时展开下拉（click 不触发）
      positionRow!
        .querySelector<HTMLElement>(".ant-select-selector")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await sleep(120);
      const startOption = Array.from(document.querySelectorAll<HTMLElement>(".ant-select-item-option")).find((node) =>
        node.textContent?.includes(harness.t("SetBase.ui.tableActionColumnPositionStart")),
      );
      expect(startOption, "下拉里应有「行首」选项").toBeTruthy();
      startOption!.click();
      await sleep(80);
      expect(configStore.tableActionColumnPosition, "草稿编辑不应实时写回 store").toBe("end");

      // 2) 固定操作列开关：同样只改草稿
      fixedRow!.querySelector<HTMLElement>(".ant-switch")!.click();
      await sleep(80);
      expect(configStore.tableActionColumnFixed, "草稿编辑不应实时写回 store").toBe(false);

      // 3) 点保存：两个叶子都写回 store
      document.querySelector<HTMLButtonElement>(".set-base-save")!.click();
      await sleep(200);
      expect(configStore.tableActionColumnPosition, "保存后应写回操作列位置").toBe("start");
      expect(configStore.tableActionColumnFixed, "保存后应写回固定开关").toBe(true);
    } finally {
      harness.app.unmount();
      harness.host.remove();
    }
  });
});
