/**
 * A（REVIEW-FINDINGS P1-7）：Aria2「不能同时删除数据」守卫的大小写归一。
 *
 * 实体 type 是 `"Aria2"`，旧实现集合写小写 `"aria2"` → `removeDataSupported` 恒 true，
 * 删除弹窗的「同时删除数据」可勾选，勾选后 Aria2.removeTorrent 按契约返回 false，整批必然失败。
 *
 * N17/L2：禁用原因必须可见（不再静默变灰），文案用 `MyClient.dialog.removeDataUnsupported`。
 *
 * 真实挂载 MyClient 页面 + 真实 DeleteDialog，只替换后台消息与无关子对话框。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));
vi.mock("@ptd/downloader", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDownloaderMetaData: async (type: string) => ({ type, name: type, feature: {}, advanceAddTorrentOptions: {} }),
    getDownloaderIcon: () => "",
  };
});

vi.mock("@/options/views/Overview/MyClient/PushToDownloaderDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "PushToDownloaderDialogStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/TorrentStateTd.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "TorrentStateTdStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/ClientStatusDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "ClientStatusDialogStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/TorrentDetailDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "TorrentDetailDialogStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/SpeedLimitDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "SpeedLimitDialogStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/LabelDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "LabelDialogStub", setup: () => () => h("div") }) };
});
vi.mock("@/options/views/Overview/MyClient/RecheckConfirmDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "RecheckConfirmDialogStub", setup: () => () => h("div") }) };
});

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

const TORRENT = {
  clientId: "d1",
  id: "hash-1",
  infoHash: "hash-1",
  name: "aria2 torrent",
  progress: 100,
  totalSize: 1024,
  savePath: "/downloads",
  label: "",
  state: "paused",
  uploadSpeed: 0,
  downloadSpeed: 0,
};

let pinia: ReturnType<typeof prepareOptionsPinia>;
let MyClientView: any;
let utils: typeof import("@/options/views/Overview/MyClient/utils.ts");

async function mountMyClient(downloaderType: string) {
  pinia = prepareOptionsPinia();
  const { useMetadataStore } = await import("@/options/stores/metadata.ts");
  const { useConfigStore } = await import("@/options/stores/config.ts");
  const { i18nInstance } = await import("@/options/plugins/i18n.ts");

  const meta = useMetadataStore(pinia);
  meta.downloaders["d1"] = {
    id: "d1",
    type: downloaderType,
    name: downloaderType,
    address: "http://aria2.local/jsonrpc",
    enabled: true,
  } as any;
  const config = useConfigStore(pinia);
  config.download.initDownloaderTorrentOnEnter = false;

  utils = await import("@/options/views/Overview/MyClient/utils.ts");
  ({ default: MyClientView } = await import("@/options/views/Overview/MyClient/Index.vue"));
  // 模块级状态在用例间共享：显式复位并注入种子
  utils.autoRefreshRunning.value = false;
  utils.torrents.value = { d1: [{ ...TORRENT }] as any };
  utils.selectedDownloaderIds.value = ["d1"];

  const view = mountOptionsView(MyClientView, { pinia, router: true });
  await view.settle(120);
  return { view, t: i18nInstance.global.t, meta };
}

/** 勾选第一行（打开删除弹窗的前置），再点批量「移除」 */
async function openDeleteDialog(view: ReturnType<typeof mountOptionsView>, t: (key: string) => string) {
  const rowCheckbox = view.$<HTMLInputElement>(".ant-table-tbody input[type=checkbox]");
  expect(rowCheckbox, "应渲染出种子行").not.toBeNull();
  rowCheckbox!.click();
  await view.settle(60);

  const removeButton = Array.from(view.$$<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.includes(t("common.remove")) && !button.closest(".ant-table"),
  );
  expect(removeButton, "应渲染出批量「移除」按钮").toBeTruthy();
  removeButton!.click();
  await view.settle(120);
}

describe("A + N17：Aria2 不支持「同时删除数据」的守卫与可见原因", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sendMessageMock.mockReset().mockImplementation(async (type: string) => {
      if (type === "getClientTorrents") return JSON.parse(JSON.stringify([TORRENT]));
      return undefined;
    });
  });

  it("Aria2（大写实体 type）打开删除弹窗时复选框禁用，并显示禁用原因", async () => {
    const { view, t } = await mountMyClient("Aria2");
    try {
      await openDeleteDialog(view, t);

      const checkboxWrapper = document.querySelector<HTMLElement>(".ant-modal .ant-checkbox-wrapper");
      expect(checkboxWrapper, "删除弹窗应渲染出复选框").not.toBeNull();
      const checkbox = checkboxWrapper!.querySelector<HTMLInputElement>("input")!;
      expect(checkbox.disabled, "Aria2 的「同时删除数据」必须禁用（旧实现因大小写不匹配从未禁用）").toBe(true);
      expect(document.body.textContent).toContain(t("MyClient.dialog.removeDataUnsupported"));
    } finally {
      view.unmount();
    }
  });

  it("qBittorrent 等支持删除数据的客户端：复选框可用且不显示禁用原因", async () => {
    const { view, t } = await mountMyClient("qBittorrent");
    try {
      await openDeleteDialog(view, t);

      const checkbox = document
        .querySelector<HTMLElement>(".ant-modal .ant-checkbox-wrapper")!
        .querySelector<HTMLInputElement>("input")!;
      expect(checkbox.disabled).toBe(false);
      expect(document.body.textContent).not.toContain(t("MyClient.dialog.removeDataUnsupported"));
    } finally {
      view.unmount();
    }
  });
});
