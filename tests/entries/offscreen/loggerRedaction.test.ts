/**
 * logger 脱敏测试（见 L-7）。
 *
 * 缺陷：下载链路会把完整下载 URL 写进日志缓冲，而部分站点的下载链接形如
 * `/api/torrent/download1?token=…`（如 yemapt）—— token 明文因此长期驻留在 sessionStorage 里。
 *
 * 修复：写入缓冲前对 `msg` 与 `data` 中的 URL 做 query 脱敏（保留 path 与 query 键名，值替换为 `***`）。
 * 语义与 `node -e` 的一次性对比一致（见修复报告）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("chrome", {
  storage: {
    local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), onChanged: { addListener: () => {} } },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  runtime: {
    id: "test",
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
});

async function loadLoggerModule() {
  vi.resetModules();
  sessionStorage.clear();
  return await import("@/offscreen/utils/logger.ts");
}

describe("logger 脱敏（L-7）", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useRealTimers();
  });

  it("绝对 URL 的 query 值被替换为 ***（保留 path 与键名）", async () => {
    const { logger, getLoggerItems } = await loadLoggerModule();

    logger({
      msg: `Download torrent file with extension method: https://yemapt.org/api/torrent/download1?token=8f3c1d9e&passkey=deadbeef`,
    });

    const [item] = getLoggerItems();
    expect(item!.msg).toBe(
      "Download torrent file with extension method: https://yemapt.org/api/torrent/download1?token=***&passkey=***",
    );
    expect(item!.msg).not.toContain("8f3c1d9e");
    expect(item!.msg).not.toContain("deadbeef");
  });

  it("站内相对路径形式的下载链接同样被脱敏（yemapt 的实际形态）", async () => {
    const { logger, getLoggerItems } = await loadLoggerModule();

    logger({ msg: `Download torrent file with web method: /api/torrent/download1?token=8f3c1d9e` });

    expect(getLoggerItems()[0]!.msg).toBe("Download torrent file with web method: /api/torrent/download1?token=***");
  });

  it("data 载荷里的字符串同样被脱敏，且不改动其它字段", async () => {
    const { logger, getLoggerItems } = await loadLoggerModule();

    logger({
      msg: "downloadTorrentToDownloader",
      data: {
        site: "yemapt",
        nested: { link: "https://yemapt.org/dl?passkey=abcdef&id=12", id: 12 },
        items: ["https://a.example/x?token=t1"],
      },
    });

    expect(getLoggerItems()[0]!.data).toEqual({
      site: "yemapt",
      nested: { link: "https://yemapt.org/dl?passkey=***&id=***", id: 12 },
      items: ["https://a.example/x?token=***"],
    });
  });

  it("路径里的 passkey 段同样被脱敏（Rartracker：/api/v1/torrents/download/{id}/{passkey}）", async () => {
    const { logger, getLoggerItems } = await loadLoggerModule();

    logger({
      msg: "Download torrent file with web method: https://r.example/api/v1/torrents/download/123/0a1b2c3d4e5f60718293a4b5c6d7e8f9",
    });

    const msg = getLoggerItems()[0]!.msg;
    expect(msg).toBe("Download torrent file with web method: https://r.example/api/v1/torrents/download/123/***");
    expect(msg).not.toContain("0a1b2c3d4e5f60718293a4b5c6d7e8f9");
  });

  it("普通路径段（数字 id、单词、带扩展名的文件名）不被误伤", async () => {
    const { logger, getLoggerItems } = await loadLoggerModule();

    logger({ msg: "https://nyaa.example/download/1234567.torrent and /torrents/download/98765432101234567890" });

    expect(getLoggerItems()[0]!.msg).toBe(
      "https://nyaa.example/download/1234567.torrent and /torrents/download/98765432101234567890",
    );
  });

  it("无 query 的 URL 与普通文本保持原样", async () => {
    const { logger, getLoggerItems } = await loadLoggerModule();

    logger({ msg: "plain text without any url" });
    logger({ msg: "path only: https://pt.site/download.php" });

    expect(getLoggerItems()[0]!.msg).toBe("plain text without any url");
    expect(getLoggerItems()[1]!.msg).toBe("path only: https://pt.site/download.php");
  });

  it("落盘到 sessionStorage 的内容也已经是脱敏后的（不会绕过脱敏）", async () => {
    vi.useFakeTimers();
    try {
      const { logger } = await loadLoggerModule();

      logger({ msg: "url: https://pt.site/dl?passkey=secret" });
      vi.advanceTimersByTime(500);

      const saved = sessionStorage.getItem("logger") as string;
      expect(saved).toContain("passkey=***");
      expect(saved).not.toContain("secret");
    } finally {
      vi.useRealTimers();
    }
  });
});
