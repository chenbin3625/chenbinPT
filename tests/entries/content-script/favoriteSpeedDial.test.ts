/**
 * 内容脚本的种子收藏入口（移植自上游 122b8942）。
 *
 * - 列表页 SpeedDial「收藏种子」：解析当前页面的种子后打开收藏对话框；
 * - 高级列表勾选后「收藏种子」：先关闭高级列表，再打开收藏对话框（避免对话框嵌套）；
 * - 对话框在内容脚本里只调用 getTorrentFavoriteStatus（内容脚本无权读取整份收藏表）。
 */
import { describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, provide, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";

vi.stubGlobal("__BROWSER__", "chrome");

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));

const { default: SiteListPage } = await import("@/content-script/app/pages/SiteListPage.vue");
const { siteInstance } = await import("@/content-script/app/utils.ts");
const { i18nInstance } = await import("@/options/plugins/i18n.ts");
const { antdInstance } = await import("@/options/plugins/antd.ts");
const { useConfigStore } = await import("@/options/stores/config.ts");
const { useMetadataStore } = await import("@/options/stores/metadata.ts");

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

const parsedTorrents = [
  { id: "1", title: "Torrent 1", site: "pt", link: "https://pt.example.com/download.php?id=1", size: 1 },
  { id: "2", title: "Torrent 2", site: "pt", link: "https://pt.example.com/download.php?id=2", size: 2 },
];

async function mountListPage() {
  const pinia = newPinia();
  useConfigStore(pinia).contentScript.doubleConfirmAction = false;
  useMetadataStore(pinia);

  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async (type: string) => {
    if (type === "getTorrentFavoriteStatus") return { favorites: [], favCategories: [] };
    return undefined;
  });

  siteInstance.value = {
    metadata: { id: "pt", urls: ["https://pt.example.com/"] },
    transformListPage: async () => ({ torrents: structuredClone(parsedTorrents), keywords: "" }),
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
  app.mount(host);
  await settle();
  /** SiteListPage 的 setupState（弹窗关闭有离场动画，DOM 上会短暂残留，断言开关状态更可靠） */
  const pageState = () => (app as any)._instance.subTree.component.setupState;

  const cleanup = () => {
    app.unmount();
    host.remove();
    document.body.innerHTML = "";
    siteInstance.value = undefined;
  };
  return { host, cleanup, pageState };
}

const favoriteTitle = () => i18nInstance.global.t("contentScript.favoriteTorrents");

describe("内容脚本的收藏入口", () => {
  it("列表页 SpeedDial「收藏种子」解析当前页种子后打开收藏对话框，只查询这些种子的收藏状态", async () => {
    const { host, cleanup } = await mountListPage();
    try {
      const favoriteButton = Array.from(host.querySelectorAll<HTMLElement>(".ant-float-btn")).find((button) =>
        button.outerHTML.includes("anticon-star"),
      );
      expect(favoriteButton, "应有收藏按钮").toBeDefined();
      favoriteButton!.click();
      await settle();

      expect(document.querySelector(".ant-modal-title")?.textContent).toContain(
        i18nInstance.global.t("MyCollection.dialog.title", [2]),
      );
      const types = sendMessageMock.mock.calls.map(([type]) => type);
      expect(types).toContain("getTorrentFavoriteStatus");
      expect(types, "内容脚本不能读取整份收藏表").not.toContain("getTorrentFavorites");
    } finally {
      cleanup();
    }
  });

  it("高级列表勾选后「收藏种子」：先关闭高级列表，再打开收藏对话框", async () => {
    const { host, cleanup, pageState } = await mountListPage();
    try {
      const advanceButton = Array.from(host.querySelectorAll<HTMLElement>(".ant-float-btn")).find((button) =>
        button.outerHTML.includes("anticon-check-square"),
      )!;
      advanceButton.click();
      await settle();

      const advanceTitle = i18nInstance.global.t("contentScript.AdvanceListModuleDialog.title", [2]);
      expect(document.querySelector(".ant-modal-title")?.textContent).toContain(advanceTitle);

      // 勾选第一行
      document.querySelector<HTMLInputElement>(".ant-modal .ant-table-tbody input[type='checkbox']")!.click();
      await settle();

      const favoriteInFooter = Array.from(document.querySelectorAll<HTMLElement>(".ant-modal-footer .ant-btn")).find(
        (button) => button.getAttribute("title") === favoriteTitle(),
      )!;
      expect(favoriteInFooter, "高级列表底部应有收藏按钮").toBeDefined();
      favoriteInFooter.click();
      await settle();

      expect(pageState().showAdvanceListModuleDialog, "高级列表应已关闭").toBe(false);
      expect(pageState().showFavoriteDialog).toBe(true);
      // 只收藏勾选的那一行（表格行序由排序决定，这里不关心是哪一行）
      expect(pageState().favoriteTorrents).toHaveLength(1);
      expect(["1", "2"]).toContain(pageState().favoriteTorrents[0].id);
      expect(
        Array.from(document.querySelectorAll(".ant-modal-title")).some((title) =>
          title.textContent?.includes(i18nInstance.global.t("MyCollection.dialog.title", [1])),
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });
});
