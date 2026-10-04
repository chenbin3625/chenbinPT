import { beforeEach, describe, expect, it, vi } from "vitest";

const { originalSendMessage, originalOnMessage } = vi.hoisted(() => ({
  originalSendMessage: vi.fn(),
  originalOnMessage: vi.fn(),
}));

vi.mock("@webext-core/messaging", () => ({
  defineExtensionMessaging: () => ({
    sendMessage: originalSendMessage,
    onMessage: originalOnMessage,
  }),
}));

vi.stubGlobal("__BROWSER__", "chrome");

async function loadSendMessage() {
  vi.resetModules();
  return (await import("@/messages.ts")).sendMessage;
}

describe("跨上下文消息：offscreen 就绪与断线恢复", () => {
  beforeEach(() => {
    originalSendMessage.mockReset();
    originalOnMessage.mockReset();
  });

  it("发送用户信息请求前必须先确保 offscreen 文档就绪", async () => {
    originalSendMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ site: "audiences", status: 0 });
    const sendMessage = await loadSendMessage();

    await sendMessage("getSiteUserInfoResult", "audiences");

    expect(originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "ensureOffscreenDocument",
      "getSiteUserInfoResult",
    ]);
  });

  it("消息端口关闭时必须重新确保 offscreen 就绪，并只重试原消息一次", async () => {
    originalSendMessage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("The message port closed before a response was received."))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ site: "audiences", status: 0 });
    const sendMessage = await loadSendMessage();

    await expect(sendMessage("getSiteUserInfoResult", "audiences")).resolves.toMatchObject({
      site: "audiences",
    });
    expect(originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "ensureOffscreenDocument",
      "getSiteUserInfoResult",
      "ensureOffscreenDocument",
      "getSiteUserInfoResult",
    ]);
  });

  it("确保 offscreen 就绪本身端口关闭时必须清空缓存并重试一次", async () => {
    originalSendMessage
      .mockRejectedValueOnce(new Error("The message port closed before a response was received."))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ site: "audiences", status: 0 });
    const sendMessage = await loadSendMessage();

    await expect(sendMessage("getSiteUserInfoResult", "audiences")).resolves.toMatchObject({
      site: "audiences",
    });
    expect(originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "ensureOffscreenDocument",
      "ensureOffscreenDocument",
      "getSiteUserInfoResult",
    ]);
  });

  it("后台自身处理的 storage 消息不应额外启动 offscreen", async () => {
    originalSendMessage.mockResolvedValueOnce({});
    const sendMessage = await loadSendMessage();

    await sendMessage("getExtStorage", "metadata");

    expect(originalSendMessage).toHaveBeenCalledTimes(1);
    expect(originalSendMessage).toHaveBeenCalledWith("getExtStorage", "metadata");
  });
});

describe("跨上下文消息：只读消息才允许自动重试（B-9）", () => {
  beforeEach(() => {
    originalSendMessage.mockReset();
    originalOnMessage.mockReset();
  });

  it("白名单里的只读消息必须先确保 offscreen 就绪（子集关系：全部属于 offscreen 消息）", async () => {
    const { retryableOffscreenMessageTypes } = await import("@/messages.ts");

    for (const type of retryableOffscreenMessageTypes) {
      originalSendMessage.mockReset();
      originalSendMessage.mockResolvedValue(undefined);
      // 每个 type 都要重新加载模块：offscreenReadyPromise 是模块级缓存，跨调用复用
      const sendMessage = await loadSendMessage();

      await sendMessage(type, undefined as any);

      expect(originalSendMessage.mock.calls[0]?.[0], `${type} 不是 offscreen 消息`).toBe("ensureOffscreenDocument");
      expect(
        originalSendMessage.mock.calls.map(([callType]) => callType),
        `${type} 应只走 ensureOffscreenDocument → 原消息`,
      ).toEqual(["ensureOffscreenDocument", type]);
    }
  });

  it("写类消息明确不在白名单里（它们重复执行会产生用户可见副作用）", async () => {
    const { retryableOffscreenMessageTypes } = await import("@/messages.ts");

    for (const type of [
      "downloadTorrent",
      "createKeepUploadTask",
      "updateKeepUploadTask",
      "deleteKeepUploadTask",
      "restoreBackupData",
      "exportBackupData",
      "deleteBackupHistory",
      "deleteClientTorrent",
      "setClientTorrentSpeedLimit",
      "setClientTorrentLabel",
      "setClientTorrentFilePriority",
      "addClientTorrentTracker",
      "removeClientTorrentTracker",
      "saveSearchResultSnapshotData",
      "removeSearchResultSnapshotData",
      "setSiteLastUserInfo",
      "removeSiteUserInfo",
      "setDownloadHistoryStatus",
      "deleteDownloadHistoryById",
      "clearDownloadHistory",
      "logger",
    ] as const) {
      expect(retryableOffscreenMessageTypes.has(type), `${type} 不应自动重试`).toBe(false);
    }
  });

  it("读类消息在连接错误后仍然重试一次（原有行为保持）", async () => {
    originalSendMessage
      .mockResolvedValueOnce(undefined) // ensureOffscreenDocument
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockResolvedValueOnce(undefined) // 重建 offscreen
      .mockResolvedValueOnce([{ name: "a" }]);
    const sendMessage = await loadSendMessage();

    await expect(sendMessage("getClientTorrents", "qbit")).resolves.toEqual([{ name: "a" }]);
    expect(originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "ensureOffscreenDocument",
      "getClientTorrents",
      "ensureOffscreenDocument",
      "getClientTorrents",
    ]);
  });

  it("写类消息（downloadTorrent）在连接错误后**不**重试：宁可失败也不重复下载", async () => {
    const connectionError = new Error("The message port closed before a response was received.");
    originalSendMessage
      .mockResolvedValueOnce(undefined) // ensureOffscreenDocument
      .mockRejectedValueOnce(connectionError);
    const sendMessage = await loadSendMessage();

    await expect(sendMessage("downloadTorrent", { downloadId: "d1" } as any)).rejects.toBe(connectionError);
    // 关键：没有第二次 downloadTorrent（否则会产生第二次下载 + 第二条历史），也没有多余的 ensureOffscreenDocument
    expect(originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "ensureOffscreenDocument",
      "downloadTorrent",
    ]);
  });

  it("写类消息在「确保 offscreen 就绪」失败时仍会重建一次（该动作幂等，不属于业务重试）", async () => {
    originalSendMessage
      .mockRejectedValueOnce(new Error("The message port closed before a response was received.")) // ensure 失败
      .mockResolvedValueOnce(undefined) // 重建成功
      .mockResolvedValueOnce({ downloadId: "d1", status: 0 }); // 原消息成功
    const sendMessage = await loadSendMessage();

    await expect(sendMessage("downloadTorrent", { downloadId: "d1" } as any)).resolves.toMatchObject({
      downloadId: "d1",
    });
    expect(originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "ensureOffscreenDocument",
      "ensureOffscreenDocument",
      "downloadTorrent",
    ]);
  });

  it("handler 内部抛出的、文本命中 `no response` 的错误不会被当成连接错误重试", async () => {
    // @webext-core/messaging 在「没有回包」时抛 Error("No response")，站点/下载器也可能返回同形文案；
    // 旧判据含宽泛的 /no response/i，会把这种业务失败误判成连接故障并整段重发（对写类消息就是重复执行）。
    const handlerError = new Error("no response from downloader");
    originalSendMessage
      .mockResolvedValueOnce(undefined) // ensureOffscreenDocument
      .mockRejectedValueOnce(handlerError);
    const sendMessage = await loadSendMessage();

    await expect(sendMessage("getSiteSearchResult", { siteId: "mteam" } as any)).rejects.toBe(handlerError);
    expect(originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "ensureOffscreenDocument",
      "getSiteSearchResult",
    ]);
  });

  it("`The message port closed...` 之外的业务错误（读类消息）同样不重试", async () => {
    const handlerError = new Error("站点返回 403");
    originalSendMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(handlerError);
    const sendMessage = await loadSendMessage();

    await expect(sendMessage("getSiteUserInfoResult", "audiences")).rejects.toBe(handlerError);
    expect(originalSendMessage.mock.calls).toHaveLength(2);
  });
});
