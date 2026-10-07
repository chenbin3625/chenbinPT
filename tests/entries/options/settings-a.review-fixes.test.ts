/**
 * options-settings-a（SetSite 四个对话框）审查修复的行为回归测试。
 *
 * OPTIONSSETTINGS-1：编辑对话框必须深拷贝站点配置，否则「取消」不回滚、还会被后续 $save 落盘
 * OPTIONSSETTINGS-4：一键导入时 sendMessage 抛错要回滚已临时写入 store 的站点
 * OPTIONSSETTINGS-5：「上一步 → 下一步」不重挂 Editor，已填写的凭据不能丢
 * OPTIONSSETTINGS-8：必填提示走 i18n（键存在时不再渲染英文硬编码 "Item is required"）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, provide, ref } from "vue";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

/** metadata store 的可控替身：sites 就地增删，方便断言「临时写入是否回滚」 */
const meta = vi.hoisted(() => {
  const state: { sites: Record<string, any> } = { sites: {} };
  return {
    get sites() {
      return state.sites;
    },
    reset() {
      for (const key of Object.keys(state.sites)) delete state.sites[key];
    },
    addSite: vi.fn(async (siteId: string, siteConfig: any) => {
      delete siteConfig.valid;
      state.sites[siteId] = siteConfig;
    }),
    removeSite: vi.fn(async (siteId: string) => {
      delete state.sites[siteId];
    }),
    getSiteMetadata: vi.fn(),
    getSiteUserConfig: vi.fn(),
    buildSiteMapCache: vi.fn(async () => {}),
  };
});

const sendMessageMock = vi.hoisted(() => vi.fn());
const canAddSites = vi.hoisted(() => ({ value: {} as Record<string, any> }));

vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => meta }));
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("@/options/views/Settings/SetSite/utils.ts", () => ({
  getCanAddedSiteMetadata: vi.fn(async () => canAddSites.value),
}));

const SITE_A_METADATA = {
  id: "site-a",
  name: "Site A",
  urls: ["https://a.example/"],
  type: "private",
  userInputSettingMeta: [{ name: "passkey", label: "Passkey", required: true }],
};

beforeEach(() => {
  meta.reset();
  meta.addSite.mockClear();
  meta.removeSite.mockClear();
  meta.getSiteMetadata.mockReset();
  meta.getSiteUserConfig.mockReset();
  sendMessageMock.mockReset();
  canAddSites.value = {};
});

describe("OPTIONSSETTINGS-1：SetSite 编辑对话框深拷贝隔离", () => {
  it("关掉再打开同一站点后编辑，不会改写 metadata store（点取消可回滚）", async () => {
    const pinia = prepareOptionsPinia();

    const stored = {
      url: "https://a.example/",
      sortIndex: 100,
      merge: { name: "original" },
      inputSetting: { passkey: "old" },
    };
    meta.sites["site-a"] = stored;
    meta.getSiteMetadata.mockResolvedValue(SITE_A_METADATA);
    meta.getSiteUserConfig.mockImplementation(async (siteId: string) => meta.sites[siteId] ?? { inputSetting: {} });

    const open = ref(false);
    const { default: EditDialog } = await import("@/options/views/Settings/SetSite/EditDialog.vue");
    const Root = defineComponent({
      setup: () => () =>
        h(EditDialog as any, {
          modelValue: open.value,
          "onUpdate:modelValue": (v: boolean) => (open.value = v),
          siteId: "site-a",
        }),
    });

    // a-modal 的内容通过 Portal 渲染到 body，断言必须查 document
    const passkeyInput = () =>
      Array.from(document.querySelectorAll<HTMLInputElement>("input.ant-input")).find(
        (input) => input.type === "password",
      );

    const view = mountOptionsView(Root, { pinia });
    try {
      // 第一次打开：dialogEnter 拷贝 + Editor onMounted 初始化
      open.value = true;
      await view.settle(150);
      const callsAfterFirstOpen = meta.getSiteMetadata.mock.calls.length;

      // 关闭再打开（antd a-modal 默认不销毁内容，Editor 不会再走一次 initSiteData）
      open.value = false;
      await view.settle(150);
      open.value = true;
      await view.settle(150);

      // 前提：第二次打开没有重挂 Editor，否则本用例测不到「浅拷贝」这条路径
      expect(meta.getSiteMetadata.mock.calls.length, "第二次打开不应重新初始化 Editor").toBe(callsAfterFirstOpen);

      // 在凭据输入框里输入（未保存的半途输入）
      expect(passkeyInput(), "应能找到 passkey 掩码输入框").toBeDefined();
      passkeyInput()!.value = "half-typed";
      passkeyInput()!.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle();

      // 未保存的输入绝不能写进 store（否则点「取消」不回滚，且下一次 $save 会落盘）
      expect(meta.sites["site-a"].inputSetting.passkey, "store 里的 passkey 不应被未保存的输入改写").toBe("old");
      expect(meta.sites["site-a"].merge.name).toBe("original");
    } finally {
      view.unmount();
    }
  });
});

describe("OPTIONSSETTINGS-5：添加站点「上一步 → 下一步」保留 Editor 实例", () => {
  it("已填写的凭据在步骤回退后仍保留，且 Editor 只初始化一次", async () => {
    const pinia = prepareOptionsPinia();
    meta.getSiteMetadata.mockResolvedValue(SITE_A_METADATA);
    meta.getSiteUserConfig.mockResolvedValue({
      url: "https://a.example/",
      sortIndex: 100,
      inputSetting: { passkey: "" },
    });
    canAddSites.value = {
      "site-a": { id: "site-a", name: "Site A", type: "private", urls: ["https://a.example/"] },
    };

    const { default: AddDialog } = await import("@/options/views/Settings/SetSite/AddDialog.vue");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    const t = (key: string) => i18nInstance.global.t(key);

    const view = mountOptionsView(AddDialog, { props: { modelValue: true }, pinia });
    try {
      await view.settle(120);

      // 选择站点（a-select 交互成本高，直接写 setup 状态，等价于用户选中了该项）
      const instance = (view.app as any)._instance;
      instance.setupState.selectedSiteId = "site-a";
      await view.settle(120);

      const footerButton = (text: string) =>
        Array.from(document.querySelectorAll<HTMLButtonElement>(".ant-modal-footer button")).find(
          (button) => button.textContent?.trim() === text,
        );

      footerButton(t("common.dialog.next"))!.click();
      await view.settle(120);

      const passkeyInput = () =>
        Array.from(document.querySelectorAll<HTMLInputElement>("input.ant-input")).find(
          (input) => input.type === "password",
        );
      expect(passkeyInput(), "第二步应显示站点配置编辑器").toBeDefined();
      passkeyInput()!.value = "my-passkey";
      passkeyInput()!.dispatchEvent(new Event("input", { bubbles: true }));
      await view.settle();

      // 回到第一步再前进：Editor 不能被卸载重建，否则 initSiteData 会用默认值覆盖刚填的凭据
      footerButton(t("common.dialog.prev"))!.click();
      await view.settle(60);
      footerButton(t("common.dialog.next"))!.click();
      await view.settle(120);

      expect(passkeyInput(), "返回后仍应是同一个 Editor").toBeDefined();
      expect(passkeyInput()!.value, "「上一步 → 下一步」后已填凭据不应被默认值覆盖").toBe("my-passkey");
      expect(meta.getSiteMetadata.mock.calls.length, "Editor 只应初始化一次").toBe(1);
    } finally {
      view.unmount();
    }
  });
});

describe("OPTIONSSETTINGS-4：一键导入失败回滚临时写入的站点", () => {
  it("getSiteSearchResult 抛错时，界面标记失败且临时 addSite 的站点被移除", async () => {
    const pinia = prepareOptionsPinia();
    canAddSites.value = {
      "site-a": { id: "site-a", name: "Site A", type: "private", urls: ["https://a.example/"] },
    };
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getSiteUserConfig") {
        return { url: "https://a.example/", sortIndex: 100, inputSetting: {} };
      }
      if (type === "getSiteSearchResult") {
        throw new Error("offscreen not ready");
      }
      return undefined;
    });

    const { default: OneClickImportDialog } = await import("@/options/views/Settings/SetSite/OneClickImportDialog.vue");
    const { i18nInstance } = await import("@/options/plugins/i18n.ts");

    // watch(showDialog) 没有 immediate：用「先关后开」的方式触发 dialogEnter（真实使用路径）
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
      await view.settle(150);

      const checkbox = document.querySelector<HTMLInputElement>(".ant-list-item input[type='checkbox']");
      expect(checkbox, "站点卡片应有可勾选的复选框").not.toBeNull();
      checkbox!.click();
      await view.settle(60);

      document.querySelector<HTMLButtonElement>(".ant-modal-footer .ant-btn-primary")!.click();
      await view.settle(200);

      // 标红为「添加失败」的站点不能留在 store 里（否则刷新后它其实已被添加）
      expect(meta.sites["site-a"], "导入失败后站点必须被回滚移除").toBeUndefined();
      expect(meta.removeSite).toHaveBeenCalledWith("site-a", { reBuildMap: false });

      const instance = (view.app as any)._instance.subTree.component;
      expect(instance.setupState.importStatus.failed, "该站点应被标记为失败").toContain("site-a");
      expect(
        document.querySelectorAll(`[title='${i18nInstance.global.t("SetSite.oneClickImportDialog.status.failed")}']`)
          .length,
        "界面上应显示失败状态",
      ).toBeGreaterThan(0);
    } finally {
      view.unmount();
    }
  });
});

describe("OPTIONSSETTINGS-8：站点编辑器必填提示走 i18n", () => {
  it("i18n 键存在时渲染译文，而不是硬编码英文", async () => {
    const pinia = prepareOptionsPinia();
    meta.getSiteMetadata.mockResolvedValue({
      ...SITE_A_METADATA,
      userInputSettingMeta: [{ name: "passkey", label: "Passkey", required: true }],
    });
    meta.getSiteUserConfig.mockResolvedValue({
      url: "https://a.example/",
      sortIndex: 100,
      inputSetting: { passkey: "" },
    });

    const { i18nInstance } = await import("@/options/plugins/i18n.ts");
    // 不用 mergeLocaleMessage 自己注入译文：那样「语言包里键缺失」或「组件用了另一份文案」
    // 都会被伪造的注入掩盖，用例变成自证。这里直接读真实语言包 zh_CN.json 的期望值
    // （键的存在性另由 tests/i18n/localeCompile.test.ts 把关），组件回退硬编码英文即红。
    const { default: zhCN } = await import("~/locales/zh_CN.json");
    const expectedRequired = (zhCN as any).SetSite?.editor?.inputRequired as string | undefined;
    expect(expectedRequired, "zh_CN.json 应提供 SetSite.editor.inputRequired").toBeTruthy();
    expect(i18nInstance.global.t("SetSite.editor.inputRequired"), "默认 zh_CN 下 i18n 应解析到真实语言包里的译文").toBe(
      expectedRequired,
    );

    const { default: Editor } = await import("@/options/views/Settings/SetSite/Editor.vue");
    const siteId = ref("site-a");
    const draft = ref<any>({ url: "", sortIndex: 100, inputSetting: { passkey: "" } });
    const Root = defineComponent({
      setup() {
        provide("storedSiteUserConfig", draft);
        return () => h(Editor as any, { modelValue: siteId.value });
      },
    });

    const view = mountOptionsView(Root, { pinia });
    try {
      await view.settle(120);

      const helpText = view.$$(".ant-form-item-explain").map((el) => el.textContent?.trim() ?? "");
      expect(helpText, "必填字段应显示真实语言包里的译文").toContain(expectedRequired);
      expect(view.text(), "不应再渲染硬编码英文").not.toContain("Item is required");
      // 键缺失时也不能把键名本身显示给用户（组件内保留了英文回退）
      expect(view.text()).not.toContain("SetSite.editor.inputRequired");
    } finally {
      view.unmount();
    }
  });
});
