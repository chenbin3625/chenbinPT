/**
 * 第三轮审查修复的行为回归：
 * - CONTENTSCRIPT-2：从「高级列表」推送下载时要先关掉自身，否则选择下载器弹窗会被盖住；
 * - CONTENTSCRIPT-3：SiteListPage 的三个 parseListPage() 调用失败时都要给出 UI 反馈；
 * - CONTENTSCRIPT-4：SpeedDialBtn 在 circle 形态下不提供 description 插槽（antd 会告警）。
 */
import { describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, provide, reactive, ref } from "vue";
import { ConfigProvider } from "ant-design-vue";
import { StyleProvider } from "ant-design-vue/es/_util/cssinjs";
import { HomeOutlined } from "@ant-design/icons-vue";
import { createPinia, setActivePinia } from "pinia";

vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("chrome", {
  runtime: {
    id: "test",
    getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage: () => Promise.resolve(undefined),
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
  },
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
});

const { default: AdvanceListModuleDialog } =
  await import("@/content-script/app/components/AdvanceListModuleDialog.vue");
const { default: SiteListPage } = await import("@/content-script/app/pages/SiteListPage.vue");
const { default: SpeedDialBtn } = await import("@/content-script/app/components/SpeedDialBtn.vue");
const { siteInstance } = await import("@/content-script/app/utils.ts");
const { i18nInstance } = await import("@/options/plugins/i18n.ts");
const { antdInstance } = await import("@/options/plugins/antd.ts");
const { useConfigStore } = await import("@/options/stores/config.ts");
const { useMetadataStore } = await import("@/options/stores/metadata.ts");
const { useRuntimeStore } = await import("@/options/stores/runtime.ts");

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

function newPinia() {
  const pinia = createPinia();
  pinia.use(({ store }) => {
    (store as any).$onReady = async () => {};
  });
  setActivePinia(pinia);
  return pinia;
}

function findButton(root: ParentNode, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>(".ant-btn")).find(
    (btn) => btn.getAttribute("title")?.includes(text) || btn.textContent?.includes(text),
  );
}

describe("CONTENTSCRIPT-2 · 高级列表推送下载", () => {
  it("点「推送到...」时先关闭高级列表弹窗，再打开选择下载器弹窗", async () => {
    const pinia = newPinia();
    useMetadataStore(pinia);

    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const mount = document.createElement("div");
    const popup = document.createElement("div");
    shadow.append(mount, popup);
    document.body.append(host);

    const items = [
      { id: "torrent-1", title: "Torrent 1", site: "test", link: "https://example.com/1" },
      { id: "torrent-2", title: "Torrent 2", site: "test", link: "https://example.com/2" },
    ];
    const shown = ref(false);
    const dialogData = reactive({ show: false, torrents: [] as unknown[], isDefaultSend: false });
    const Root = defineComponent({
      setup() {
        provide("remoteDownloadDialogData", dialogData);
        return () =>
          h(
            StyleProvider,
            { container: shadow },
            {
              default: () =>
                h(
                  ConfigProvider,
                  { getPopupContainer: () => popup },
                  {
                    default: () =>
                      h(AdvanceListModuleDialog, {
                        modelValue: shown.value,
                        "onUpdate:modelValue": (value: boolean | undefined) => (shown.value = value ?? false),
                        torrentItems: items,
                      }),
                  },
                ),
            },
          );
      },
    });
    const app = createApp(Root).use(pinia).use(i18nInstance).use(antdInstance);
    try {
      app.mount(mount);
      await nextTick();
      shown.value = true;
      await settle();

      const pushButton = findButton(popup, "推送到...");
      expect(pushButton, "弹窗内应有「推送到...」按钮").toBeDefined();
      pushButton!.click();
      await settle();

      expect(dialogData.show).toBe(true);
      expect(dialogData.torrents).toHaveLength(2);
      expect(dialogData.isDefaultSend).toBe(false);
      // 修复前这里仍是 true：本弹窗保持打开，新弹窗被它整层遮住
      expect(shown.value).toBe(false);
    } finally {
      app.unmount();
      host.remove();
    }
  });
});

describe("CONTENTSCRIPT-3 · SiteListPage 解析失败反馈", () => {
  it("parseListPage 抛错时推送/高级列表/快捷搜索都会提示 operationFailed", async () => {
    const pinia = newPinia();
    const configStore = useConfigStore(pinia);
    configStore.contentScript.doubleConfirmAction = false;
    const metadataStore = useMetadataStore(pinia);
    metadataStore.downloaders = { d1: { id: "d1", name: "d1", enabled: true } } as any;

    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar").mockImplementation(() => undefined);

    // 让引擎解析稳定失败：parseListPage 会 await transformListPage
    siteInstance.value = {
      transformListPage: () => Promise.reject(new Error("boom")),
    } as any;

    const host = document.createElement("div");
    document.body.append(host);
    const Root = defineComponent({
      setup() {
        provide("ptd_data", { siteId: "pt" });
        provide("remoteDownloadDialogData", reactive({ show: false, torrents: [], isDefaultSend: false }));
        return () => h(SiteListPage);
      },
    });
    const app = createApp(Root).use(pinia).use(i18nInstance).use(antdInstance);
    try {
      app.mount(host);
      await settle();

      const buttons = Array.from(host.querySelectorAll<HTMLElement>(".ant-float-btn"));
      expect(buttons.length).toBeGreaterThanOrEqual(3);
      for (const button of buttons) button.click();
      await settle();

      const operationFailed = i18nInstance.global.t("contentScript.operationFailed");
      const failedCalls = snackbar.mock.calls.filter(([text]) => text === operationFailed);
      // 「推送至下载器」「高级列表」「快捷搜索」三条路径都必须有反馈（修复前 0 条，且留下 unhandled rejection）
      expect(failedCalls.length).toBeGreaterThanOrEqual(3);
      expect(failedCalls.every(([, options]) => options?.color === "error")).toBe(true);
    } finally {
      app.unmount();
      host.remove();
      snackbar.mockRestore();
      siteInstance.value = undefined;
    }
  });
});

describe("CONTENTSCRIPT-4 · SpeedDialBtn 的 description 插槽", () => {
  it("circle 形态不提供 description（无 FloatButton 告警），square 形态才渲染短标签", async () => {
    const pinia = newPinia();
    const configStore = useConfigStore(pinia);
    configStore.contentScript.stackedButtons = false;

    const consoleErrors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map((arg) => String(arg)).join(" "));
    });

    const host = document.createElement("div");
    document.body.append(host);
    const Root = defineComponent({
      setup() {
        return () => h(SpeedDialBtn, { icon: HomeOutlined, title: "打开PTD", label: "打开面板" });
      },
    });
    const app = createApp(Root).use(pinia).use(i18nInstance).use(antdInstance);
    try {
      app.mount(host);
      await settle();

      expect(host.querySelector(".ant-float-btn-description")).toBeNull();
      expect(consoleErrors.join("\n")).not.toMatch(/FloatButton/);

      configStore.contentScript.stackedButtons = true;
      await settle();

      expect(host.querySelector(".ant-float-btn-description")?.textContent).toContain("打开面板");
      expect(consoleErrors.join("\n")).not.toMatch(/FloatButton/);
    } finally {
      app.unmount();
      host.remove();
      errorSpy.mockRestore();
    }
  });
});
