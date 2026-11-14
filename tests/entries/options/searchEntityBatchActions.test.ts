/**
 * 搜索页批量操作的并发与部分成功行为。
 *
 * - 批量复制链接不能因为单个链接失败就丢弃全部；
 * - 批量请求必须有并发上限（不能一次性打满消息通道）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async (_type: string, _payload?: any): Promise<any> => undefined),
}));

vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("@ptd/downloader", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDownloaderMetaData: async (type: string) => ({ type, name: type, feature: {}, advanceAddTorrentOptions: {} }),
    getDownloaderIcon: () => "",
  };
});

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { mapWithConcurrency } from "@/options/views/Overview/SearchEntity/utils/concurrency.ts";

describe("mapWithConcurrency", () => {
  it("限制并发上限、保留输入顺序，并像 allSettled 一样带出失败项", async () => {
    let running = 0;
    let maxRunning = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      if (value === 3) throw new Error("boom");
      return value * 2;
    });

    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: 2 });
    expect(results[4]).toEqual({ status: "fulfilled", value: 10 });
  });
});

describe("ActionTd 批量复制下载链接", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    sendMessageMock.mockImplementation(async () => undefined);
  });

  it("部分链接失败时仍复制成功部分，并提示失败数与首个原因", async () => {
    sendMessageMock.mockImplementation(async (type: string, payload: any) => {
      if (type === "getTorrentDownloadLink") {
        if (payload.id === "2") throw new Error("site unavailable");
        return `https://example.com/download/${payload.id}`;
      }
      return undefined;
    });

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const pinia = prepareOptionsPinia();
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnackbar").mockImplementation(() => {});

    const { default: ActionTd } = await import("@/options/views/Overview/SearchEntity/ActionTd.vue");
    const view = mountOptionsView(ActionTd, {
      pinia,
      props: {
        torrentItems: [
          { site: "x", id: "1", title: "a" },
          { site: "x", id: "2", title: "b" },
          { site: "x", id: "3", title: "c" },
        ],
      },
    });

    try {
      await view.settle();
      const { i18nInstance } = await import("@/options/plugins/i18n.ts");
      const copyBtn = view.$<HTMLButtonElement>(
        `button[title="${i18nInstance.global.t("SearchEntity.ActionTd.copyLink")}"]`,
      );
      expect(copyBtn, "应渲染出复制链接按钮").not.toBeNull();
      copyBtn!.click();
      await view.settle(80);

      expect(writeText).toHaveBeenCalledWith("https://example.com/download/1\nhttps://example.com/download/3");

      const [message, options] = snackbar.mock.calls.at(-1)!;
      expect(message).toContain(i18nInstance.global.t("SearchEntity.ActionTd.copyLinkSuccess"));
      expect(message).toContain(i18nInstance.global.t("SearchEntity.ActionTd.copyLinkFailed"));
      expect(message).toContain("(2/3)");
      expect(message).toContain("site unavailable");
      expect(options).toMatchObject({ color: "warning" });
    } finally {
      view.unmount();
      snackbar.mockRestore();
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
  });

  it("全部链接失败时不写剪贴板，只提示 copyLinkFailed", async () => {
    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "getTorrentDownloadLink") throw new Error("all failed");
      return undefined;
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const pinia = prepareOptionsPinia();
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnackbar").mockImplementation(() => {});

    const { default: ActionTd } = await import("@/options/views/Overview/SearchEntity/ActionTd.vue");
    const view = mountOptionsView(ActionTd, {
      pinia,
      props: { torrentItems: [{ site: "x", id: "1", title: "a" }] },
    });

    try {
      await view.settle();
      const { i18nInstance } = await import("@/options/plugins/i18n.ts");
      view.$<HTMLButtonElement>(`button[title="${i18nInstance.global.t("SearchEntity.ActionTd.copyLink")}"]`)!.click();
      await view.settle(80);

      expect(writeText).not.toHaveBeenCalled();
      expect(snackbar).toHaveBeenCalledWith(i18nInstance.global.t("SearchEntity.ActionTd.copyLinkFailed"), {
        color: "error",
      });
    } finally {
      view.unmount();
      snackbar.mockRestore();
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
  });
});
