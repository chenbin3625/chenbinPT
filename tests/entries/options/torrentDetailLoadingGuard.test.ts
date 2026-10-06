import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";

vi.hoisted(() => {
  (globalThis as any).__BROWSER__ = "chrome";
});

import { createTorrentLoadGuard, finishTorrentLoad } from "@/options/views/Overview/MyClient/utils.ts";
import { i18nInstance } from "@/options/plugins/i18n.ts";

describe("TorrentDetailDialog loading guard", () => {
  it("迟到的旧请求不能关闭新种子的 loading 状态", () => {
    const open = ref(true);
    const currentTorrent = ref<any>({ clientId: "client-a", id: "torrent-a" });
    const guard = createTorrentLoadGuard(
      () => open.value,
      () => currentTorrent.value,
    );
    const oldRequestKey = guard.begin();
    let loading = true;

    currentTorrent.value = { clientId: "client-b", id: "torrent-b" };
    finishTorrentLoad(guard, oldRequestKey, () => {
      loading = false;
    });

    expect(loading).toBe(true);
  });
});

/**
 * L-8：上面只测了 helper —— 把 SFC 里的 finishTorrentLoad(...) 换回「直接 loading=false」它照样通过。
 * 这里挂载真实 TorrentDetailDialog：A 的文件请求在途时切到 B，A 的迟到响应不能关掉 B 的 loading。
 */
describe("TorrentDetailDialog（挂载）：迟到响应不关闭新种子的 loading", () => {
  it("A 的文件列表晚于切换到 B 返回时，B 的文件 tab 仍在 loading", async () => {
    const { mountOptionsView } = await import("../../helpers/optionsView.ts");
    const { defineComponent, h, nextTick, reactive } = await import("vue");
    const messages = await import("@/messages.ts");

    const pendingFiles = new Map<string, (files: unknown[]) => void>();
    vi.spyOn(messages, "sendMessage").mockImplementation((async (type: string, data: any) => {
      if (type === "getDownloaderMetaData") return { feature: { FileList: { allowed: true } } };
      if (type === "getClientTorrentTrackersDetail") return [];
      if (type === "getClientTorrentFiles") {
        return await new Promise((resolve) => pendingFiles.set(data.torrent.id, resolve as any));
      }
      return undefined;
    }) as any);

    const { default: Dialog } = await import("@/options/views/Overview/MyClient/TorrentDetailDialog.vue");
    const makeTorrent = (id: string) =>
      ({
        clientId: "c",
        id,
        name: id,
        infoHash: id,
        progress: 50,
        ratio: 1,
        totalSize: 1,
        selectedSize: 1,
        uploadSpeed: 0,
        downloadSpeed: 0,
        state: "seeding",
      }) as any;
    const state = reactive({ open: false, torrent: makeTorrent("A") });
    const view = mountOptionsView(
      defineComponent({
        setup: () => () =>
          h(Dialog as any, {
            modelValue: state.open,
            "onUpdate:modelValue": (v: boolean) => (state.open = v),
            torrent: state.torrent,
          }),
      }),
    );
    const settle = async () => {
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
      await nextTick();
    };
    const filesTab = () =>
      Array.from(document.querySelectorAll<HTMLElement>(".ant-tabs-tab")).find((tab) =>
        tab.textContent?.includes(i18nT("MyClient.detail.fileTitle")),
      );
    const filesSpinner = () => document.querySelector(".ant-tabs-tabpane-active .ant-spin");

    try {
      state.open = true;
      await settle();
      filesTab()!.querySelector<HTMLElement>(".ant-tabs-tab-btn")!.click();
      await settle();
      expect(pendingFiles.has("A")).toBe(true);

      // 切到种子 B 并加载它的文件
      state.torrent = makeTorrent("B");
      await settle();
      filesTab()!.querySelector<HTMLElement>(".ant-tabs-tab-btn")!.click();
      await settle();

      // A 的响应迟到
      pendingFiles.get("A")!([{ path: "a.mkv", size: 1, progress: 100, priority: "normal" }]);
      await settle();
      expect(filesSpinner(), "B 的文件请求仍在途，loading 不应被 A 的迟到响应关闭").not.toBeNull();
    } finally {
      view.unmount();
    }
  });
});

function i18nT(key: string): string {
  return i18nInstance.global.t(key);
}
