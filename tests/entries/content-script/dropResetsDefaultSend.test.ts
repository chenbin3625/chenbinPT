/**
 * M-20：拖拽投放必须走「选择下载器」界面。
 *
 * 先点过「推送到默认下载器」后 remoteDownloadDialogData.isDefaultSend 仍为 true；旧的 onDrop 只赋值
 * torrents / show，于是拖到悬浮球上的链接不经确认就直接发往默认下载器。
 * 这里挂载真实 App.vue（只替换下载弹窗与页面按钮组），在 isDefaultSend=true 的状态下触发一次 drop。
 */
import { describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import Antd from "ant-design-vue";
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

const dialogProps = vi.hoisted(() => ({ last: {} as Record<string, unknown> }));
vi.mock("@/options/components/SentToDownloaderDialog/Index.vue", async () => {
  const { defineComponent } = await import("vue");
  return {
    default: defineComponent({
      props: { modelValue: Boolean, torrentItems: Array, isDefaultSend: Boolean },
      setup(props) {
        return () => {
          dialogProps.last = { ...props };
          return null;
        };
      },
    }),
  };
});
vi.mock("@/content-script/app/pages/SiteListPage.vue", () => ({ default: { render: () => null } }));
vi.mock("@/content-script/app/pages/SiteDetailPage.vue", () => ({ default: { render: () => null } }));
vi.mock("@/content-script/app/pages/SocialSitePage.vue", () => ({ default: { render: () => null } }));

const { default: App } = await import("@/content-script/app/App.vue");
const { CUSTOM_DRAG_MIME } = await import("@/content-script/app/utils.ts");
const { i18nInstance } = await import("@/options/plugins/i18n.ts");
const { useMetadataStore } = await import("@/options/stores/metadata.ts");

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

describe("内容脚本拖拽投放（M-20）", () => {
  it("先「推送到默认下载器」再拖拽：弹窗以 isDefaultSend=false 打开（需要用户选择）", async () => {
    const pinia = createPinia();
    pinia.use(({ store }) => {
      (store as any).$onReady = async () => {};
    });
    setActivePinia(pinia);
    useMetadataStore(pinia).siteHostMap = { "pt.example": "pt" } as any;

    let dialogData: any;
    const Probe = defineComponent({
      setup() {
        return () => h(App);
      },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(Probe)
      .use(pinia)
      .use(i18nInstance)
      .use(Antd as any);
    app.provide("ptd_data", { siteId: "pt" });
    app.mixin({
      mounted(this: any) {
        dialogData ??= this.$?.provides?.remoteDownloadDialogData;
      },
    });
    app.mount(host);
    try {
      await settle();
      expect(dialogData, "App 应 provide remoteDownloadDialogData").toBeDefined();

      // 模拟此前在页面上点过「推送到默认下载器」
      dialogData.isDefaultSend = true;

      const target = host.querySelector(".ptd-content-script-draggable")!;
      const dataTransfer = {
        types: [CUSTOM_DRAG_MIME],
        getData: (type: string) =>
          type === CUSTOM_DRAG_MIME
            ? JSON.stringify([{ site: "pt", link: "https://pt.example/download.php?id=1", title: "t", id: "1" }])
            : "",
      };
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
      target.dispatchEvent(drop);
      await settle();

      expect(dialogProps.last.modelValue).toBe(true);
      expect(dialogProps.last.isDefaultSend).toBe(false);
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
