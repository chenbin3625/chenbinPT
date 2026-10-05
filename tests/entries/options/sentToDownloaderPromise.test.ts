import { describe, expect, it, vi } from "vitest";

const sendMessageMock = vi.hoisted(() => vi.fn());
const runtimeStore = vi.hoisted(() => ({ search: { searchKey: "", searchPlanKey: "" }, showSnakebar: vi.fn() }));
const metadataStore = vi.hoisted(() => ({
  getSearchSolutionName: vi.fn(() => "default"),
  getSiteName: vi.fn(),
}));

vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock, onMessage: vi.fn() }));
vi.mock("@/options/stores/runtime.ts", () => ({ useRuntimeStore: () => runtimeStore }));
vi.mock("@/options/stores/metadata.ts", () => ({ useMetadataStore: () => metadataStore }));

describe("推送到下载器：预处理失败必须 settle", () => {
  it("站点名称解析失败时，sendTorrentToDownloader 会 reject 而不是永久 pending", async () => {
    metadataStore.getSiteName.mockRejectedValueOnce(new Error("site metadata unavailable"));

    const { sendTorrentToDownloader } = await import("@/options/components/SentToDownloaderDialog/utils.ts");

    const operation = sendTorrentToDownloader(
      [{ site: "missing-site", title: "example" } as any],
      "downloader-1" as any,
      { savePath: "$torrent.siteName$", label: "" } as any,
      vi.fn(),
    );

    const settled = Promise.race([
      operation,
      new Promise((_, reject) => setTimeout(() => reject(new Error("operation timed out")), 100)),
    ]);

    await expect(settled).rejects.toThrow("site metadata unavailable");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
