/**
 * options-settings-b 的修复回归网（OPTIONSSETTINGS-2/3/6/7/9/10）。
 *
 * 每条用例都打在**真实渲染 / 真实副作用**上，旧实现下会红：
 * - 2：「最后备份时间」列渲染译文而不是键名字面量 notBackup；
 * - 3：本地导出 reject / 返回 false 时给出失败提示且不关弹窗；一项不勾选时确定按钮禁用；
 * - 6：恢复选项一个字段都不勾选时确定按钮禁用，不会再走到「恢复成功」；
 * - 7：英文界面下自动刷新文案里不再出现硬编码中文「后，」，后缀来自 i18n 键；
 * - 9：选中项被删除（含跨上下文）后导出不再产出空对象；
 * - 10：站点被删除后编辑弹窗的面板降级为禁用，而不是渲染期 TypeError。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";

// NativeBridgeWindow 之类的模块在求值期读 `chrome.runtime.id`；UserInfoWindow（经 background/utils/alarms.ts）
// 会拉进 `src/entries/storage.ts` → `@webext-core/storage`，它在模块求值期就要 chrome.storage.{local,session,sync,managed}。
// 用 vi.hoisted 保证这些桩在任何静态 import 之前就位。
vi.hoisted(() => {
  const makeArea = () => ({
    get: async () => ({}),
    set: async () => undefined,
    remove: async () => undefined,
    clear: async () => undefined,
  });
  (globalThis as any).chrome = {
    runtime: { id: "test-extension-id", getURL: (path: string) => `chrome-extension://ptdtest/${path}` },
    alarms: {
      get: async () => undefined,
      create: async () => undefined,
      clear: async () => true,
      onAlarm: { addListener() {}, removeListener() {} },
    },
    storage: {
      local: makeArea(),
      session: makeArea(),
      sync: makeArea(),
      managed: makeArea(),
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
});

/**
 * happy-dom 的 `input.click()` 不会触发 checkbox 的默认动作，antd 的受控 checkbox 因此收不到 change。
 * 这里手动翻转 checked 再派发 change（antd 的 handleChange 读 e.target.checked / group 的 toggleOption 用 value）。
 */
function toggleCheckbox(input: HTMLInputElement) {
  input.checked = !input.checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * 逐个翻转并等一次渲染：antd CheckboxGroup 的 mergedValue 由 props.value 经 watch 同步（非 immediate），
 * 同一 tick 内连续 toggle 都基于过期的 mergedValue 做 indexOf，结果是「取消勾选 A」实际作用到 B。
 */
async function toggleCheckboxes(inputs: HTMLInputElement[]) {
  for (const input of inputs) {
    toggleCheckbox(input);
    await nextTick();
  }
}

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

const saveAsMock = vi.hoisted(() => vi.fn());
vi.mock("file-saver", () => ({ saveAs: saveAsMock }));

/** 单测里不加载真实站点点定义（避免 import.meta.glob 与 341 个定义的开销），只覆盖 EditDialog 用到的字段 */
vi.mock("@ptd/site", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDefinedSiteMetadata: async (siteId: string) => ({
      id: siteId,
      name: siteId,
      urls: [`https://${siteId}.example/`],
      isDead: false,
      schema: "NexusPHP",
    }),
  };
});

const siteStub = async (name: string) => {
  const { defineComponent } = await import("vue");
  return {
    default: defineComponent({
      name,
      props: { siteId: { type: String, default: "" }, size: { type: Number, default: 0 } },
      setup: () => () => h("span", { class: "stub-site" }),
    }),
  };
};
vi.mock("@/options/components/SiteName.vue", () => siteStub("SiteNameStub"));
vi.mock("@/options/components/SiteFavicon/Index.vue", () => siteStub("SiteFaviconStub"));
vi.mock("@/options/views/Settings/SetSearchSolution/SiteCategoryPanel.vue", async () => {
  const { defineComponent } = await import("vue");
  return {
    default: defineComponent({ name: "SiteCategoryPanelStub", setup: () => () => h("div", { class: "stub-panel" }) }),
  };
});

import { i18nInstance } from "@/options/plugins/i18n.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

afterEach(() => {
  sendMessageMock.mockReset();
  saveAsMock.mockReset();
  i18nInstance.global.locale.value = "zh_CN";
});

const backupServerRow = {
  id: "dav",
  name: "my dav",
  type: "WebDAV",
  enabled: true,
  backupFields: ["config"],
  config: {},
};

// ── OPTIONSSETTINGS-2 ─────────────────────────────────────────────────────

describe("OPTIONSSETTINGS-2：从未备份的服务器显示译文", () => {
  it("「最后备份时间」列渲染 SetBackup.table.notBackup，而不是字面量 notBackup", async () => {
    const pinia = prepareOptionsPinia();
    const metadataStore = useMetadataStore(pinia);
    (metadataStore as any).$ready = true;
    metadataStore.backupServers = { dav: backupServerRow } as any;

    const { default: SetBackup } = await import("@/options/views/Settings/SetBackup/Index.vue");
    const view = mountOptionsView(SetBackup, { pinia, router: true });
    try {
      await view.settle(150);

      const cell = view.$(".ptd-date-time");
      expect(cell, "应渲染「最后备份时间」列").not.toBeNull();
      expect(cell!.textContent).toBe(i18nInstance.global.t("SetBackup.table.notBackup"));
      expect(cell!.textContent).not.toContain("notBackup");
    } finally {
      view.unmount();
    }
  });
});

// ── OPTIONSSETTINGS-3 ─────────────────────────────────────────────────────

describe("OPTIONSSETTINGS-3：本地导出失败不再静默", () => {
  const mountLocalExport = async () => {
    const pinia = prepareOptionsPinia();
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar");

    const { default: Dialog } = await import("@/options/views/Settings/SetBackup/LocalExportConfirmDialog.vue");
    const open = ref(false);
    const Host = defineComponent({
      name: "LocalExportHost",
      setup: () => () =>
        h(Dialog as any, { modelValue: open.value, "onUpdate:modelValue": (v: boolean) => (open.value = v) }),
    });
    const view = mountOptionsView(Host, { pinia, router: true });
    // 弹窗由父组件从 false → true 打开（wrapper 的 watch 只在变化时初始化勾选项），与真实使用一致
    open.value = true;
    await nextTick();
    await view.settle(120);
    return { view, open, snackbar };
  };

  it("导出 reject 时提示失败、弹窗保持打开且退出 loading", async () => {
    sendMessageMock.mockRejectedValue(new Error("download rejected"));
    const { view, open, snackbar } = await mountLocalExport();
    try {
      const ok = document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!;
      expect(ok, "应渲染确定按钮").not.toBeNull();
      ok.click();
      await view.settle(120);

      expect(snackbar).toHaveBeenCalledWith(i18nInstance.global.t("SetBackup.snackbar.failure"), { color: "error" });
      expect(open.value, "失败时不能关闭弹窗（否则用户以为导出成功）").toBe(true);
      expect(ok.disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("导出返回 false（而非抛错）时同样提示失败", async () => {
    sendMessageMock.mockResolvedValue(false);
    const { view, open, snackbar } = await mountLocalExport();
    try {
      document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!.click();
      await view.settle(120);

      expect(snackbar).toHaveBeenCalledWith(i18nInstance.global.t("SetBackup.snackbar.failure"), { color: "error" });
      expect(open.value).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("一个备份项都不勾选时确定按钮禁用，不会导出只有 manifest 的空 zip", async () => {
    sendMessageMock.mockResolvedValue(true);
    const { view } = await mountLocalExport();
    try {
      const checks = Array.from(document.querySelectorAll<HTMLInputElement>(".ant-modal .ant-checkbox-group input"));
      expect(checks.length, "应有多项备份内容可勾选").toBeGreaterThan(0);
      await toggleCheckboxes(checks);
      await view.settle(120);

      const ok = document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!;
      expect(ok.disabled, "全不勾选时应禁用确定").toBe(true);
    } finally {
      view.unmount();
    }
  });
});

// ── OPTIONSSETTINGS-6 ─────────────────────────────────────────────────────

describe("OPTIONSSETTINGS-6：恢复时零字段不再提示「恢复成功」", () => {
  const remoteBackup = {
    manifest: { version: "chenbinPT (v1.0.0.0)", files: { config: 1, cookies: 1 } },
    config: {},
    cookies: {},
  };

  it("取消勾选全部恢复字段后确定按钮被禁用，且不会发出 restoreBackupData", async () => {
    const pinia = prepareOptionsPinia();
    sendMessageMock.mockImplementation(async (type: string) => (type === "getRemoteBackupData" ? remoteBackup : true));

    const { default: RestoreDialog } = await import("@/options/views/Settings/SetBackup/RestoreDialog.vue");
    const open = ref(false);
    const Host = defineComponent({
      name: "RestoreHost",
      setup: () => () =>
        h(RestoreDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean) => (open.value = v),
          restoreMetadata: { type: "remote", server: "s1", path: "/backup.zip" },
        }),
    });
    const view = mountOptionsView(Host, { pinia, router: true });
    try {
      open.value = true;
      await nextTick();
      await view.settle(150);

      const fields = Array.from(
        document.querySelectorAll<HTMLInputElement>(".ant-modal .ant-checkbox-group input[type=checkbox]"),
      );
      // BackupFields 会全部渲染，但只有备份里存在的字段可选/默认勾选
      expect(fields.length, "应渲染出恢复字段复选框").toBeGreaterThan(0);
      const checked = fields.filter((input) => input.checked);
      expect(checked.length, "解析出备份后只勾选备份里存在的字段").toBe(2);

      const ok = () => document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!;
      expect(ok().disabled, "默认全部勾选时确定可用").toBe(false);

      await toggleCheckboxes(checked);
      await view.settle(120);

      expect(ok().disabled, "零字段时应禁用确定（否则 offscreen 会无条件 report.success）").toBe(true);
      ok().click();
      await view.settle(60);
      expect(sendMessageMock.mock.calls.some(([type]) => type === "restoreBackupData")).toBe(false);

      // 重新勾选一项后恢复可用，确认不是永久禁用
      toggleCheckbox(checked[0]);
      await view.settle(120);
      expect(ok().disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });
});

// ── OPTIONSSETTINGS-7 ─────────────────────────────────────────────────────

describe("OPTIONSSETTINGS-7：自动刷新文案不再硬编码中文", () => {
  const AFTER_TIME_SUFFIX_KEY = "SetBase.userInfo.afterTimeSuffix";

  it("英文界面下没有任何中文字符，后缀来自 i18n 键而不是硬编码「后，」", async () => {
    const pinia = prepareOptionsPinia();
    const configStore = useConfigStore(pinia);
    configStore.userInfo.autoReflush.enabled = true;

    const { default: UserInfoWindow } = await import("@/options/views/Settings/SetBase/UserInfoWindow.vue");
    const view = mountOptionsView(UserInfoWindow, { pinia, router: true });
    try {
      i18nInstance.global.locale.value = "en";
      await view.settle(120);

      const note = view.$(".ptd-setting-note");
      expect(note, "应渲染自动刷新说明").not.toBeNull();
      const text = note!.textContent ?? "";

      expect(text, "英文界面不得出现中文硬编码").not.toMatch(/[\u4e00-\u9fff]/);
      // 键已入语言包时期望译文；尚未入包时 vue-i18n 原样返回键名——两种形态都说明后缀走了 i18n
      const expected = i18nInstance.global.te(AFTER_TIME_SUFFIX_KEY, "en")
        ? i18nInstance.global.t(AFTER_TIME_SUFFIX_KEY, {}, { locale: "en" })
        : AFTER_TIME_SUFFIX_KEY;
      expect(text).toContain(expected);
    } finally {
      view.unmount();
    }
  });
});

// ── OPTIONSSETTINGS-9 ─────────────────────────────────────────────────────

describe("OPTIONSSETTINGS-9：导出不再混入空对象", () => {
  const solution = {
    id: "s1",
    name: "Solution One",
    sort: 1,
    enabled: true,
    isDefault: false,
    createdAt: 1,
    solutions: [{ id: "default", siteId: "mteam", searchEntries: {}, selectedCategories: { categories: [] } }],
  };

  const mountSolutions = async () => {
    const pinia = prepareOptionsPinia();
    // SolutionLabel → SolutionDetail 会读站点元数据；给站点一份空 merge 配置，避免无关的 unhandled rejection
    sendMessageMock.mockImplementation(async (type: string) => (type === "getSiteUserConfig" ? { merge: {} } : true));

    const metadataStore = useMetadataStore(pinia);
    (metadataStore as any).$ready = true;
    metadataStore.solutions = { s1: JSON.parse(JSON.stringify(solution)) } as any;
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar");

    const { default: SetSearchSolution } = await import("@/options/views/Settings/SetSearchSolution/Index.vue");
    const view = mountOptionsView(SetSearchSolution, { pinia, router: true });
    await view.settle(150);
    return { view, metadataStore, snackbar };
  };

  const rowCheckbox = (view: ReturnType<typeof mountOptionsView>, name: string) => {
    const row = view.$$(".ant-table-tbody tr").find((tr) => (tr.textContent ?? "").includes(name));
    expect(row, `应能定位到方案行 ${name}`).toBeDefined();
    return row!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  };

  const toolbarExportButton = (view: ReturnType<typeof mountOptionsView>) =>
    view.$<HTMLButtonElement>(`.page-toolbar button[title="${i18nInstance.global.t("common.export")}"]`)!;

  it("选中项在 store 中消失（跨上下文删除）后再导出：不写文件、提示无可导出方案", async () => {
    const { view, metadataStore, snackbar } = await mountSolutions();
    try {
      rowCheckbox(view, "Solution One").click();
      await view.settle(80);
      expect(toolbarExportButton(view).disabled, "选中后导出按钮应可用").toBe(false);

      // 模拟另一个上下文删除该方案：store 里消失，但 tableSelected 仍留着 id
      delete metadataStore.solutions.s1;
      await nextTick();

      toolbarExportButton(view).click();
      await view.settle(80);

      expect(saveAsMock, "不能导出含空对象的文件").not.toHaveBeenCalled();
      expect(snackbar).toHaveBeenCalledWith(i18nInstance.global.t("SetSearchSolution.import.noSolutions"), {
        color: "error",
      });
    } finally {
      view.unmount();
    }
  });

  it("经删除对话框删除后，选中态被清理（导出按钮回到禁用）", async () => {
    const { view, metadataStore } = await mountSolutions();
    try {
      rowCheckbox(view, "Solution One").click();
      await view.settle(80);

      const row = view.$$(".ant-table-tbody tr").find((tr) => (tr.textContent ?? "").includes("Solution One"))!;
      row.querySelector<HTMLButtonElement>(".table-action .ant-btn-dangerous")!.click();
      await view.settle(120);

      // 删除确认弹窗（DeleteDialog）的确定按钮：ok-type="danger" 渲染为 ant-btn-dangerous
      document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-dangerous")!.click();
      await view.settle(150);

      expect(metadataStore.solutions.s1, "方案应已从 store 删除").toBeUndefined();
      expect(toolbarExportButton(view).disabled, "已删除的选中项应从选中态清理").toBe(true);
    } finally {
      view.unmount();
    }
  });
});

// ── OPTIONSSETTINGS-10 ────────────────────────────────────────────────────

describe("OPTIONSSETTINGS-10：站点被删除后编辑弹窗降级为禁用", () => {
  it("另一上下文删掉站点后，面板仍渲染且变为禁用，而不是渲染期 TypeError", async () => {
    const pinia = prepareOptionsPinia();
    const metadataStore = useMetadataStore(pinia);
    (metadataStore as any).$ready = true;
    metadataStore.sites = {
      siteA: {
        url: "https://siteA.example/",
        allowSearch: true,
        merge: { name: "Site A", urls: ["https://siteA.example/"] },
      },
    } as any;
    metadataStore.solutions = {} as any;

    const { default: EditDialog } = await import("@/options/views/Settings/SetSearchSolution/EditDialog.vue");
    const open = ref(false);
    const Host = defineComponent({
      name: "SolutionEditHost",
      setup: () => () =>
        h(EditDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean) => (open.value = v),
          solutionId: "s1",
        }),
    });
    const view = mountOptionsView(Host, { pinia, router: true });
    try {
      open.value = true;
      await nextTick();
      await view.settle(150);

      const panel = () => document.querySelector<HTMLElement>(".ant-modal .ant-collapse-item");
      expect(panel(), "应渲染站点面板").not.toBeNull();
      expect(panel()!.classList.contains("ant-collapse-item-disabled"), "站点在线时面板可用").toBe(false);

      // 模拟跨上下文删除：store 里消失，但 addedSiteInfo 快照仍指向它
      delete metadataStore.sites.siteA;
      await nextTick();
      await view.settle(120);

      expect(panel(), "站点消失不应让整个弹窗渲染中断").not.toBeNull();
      expect(panel()!.classList.contains("ant-collapse-item-disabled"), "找不到站点时面板应禁用").toBe(true);
    } finally {
      view.unmount();
    }
  });
});
