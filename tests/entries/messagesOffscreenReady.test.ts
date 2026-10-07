import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

describe("敏感消息的发送方限制", () => {
  beforeEach(() => {
    originalOnMessage.mockReset();
    vi.stubGlobal("chrome", {
      runtime: {
        id: "extension-id",
        getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      },
    });
  });

  it("普通网页标签的内容脚本不能调用 Cookie 写入接口", async () => {
    const { onMessage } = await import("@/messages.ts");
    const handler = vi.fn();
    onMessage("setCookie", handler);
    const wrapped = originalOnMessage.mock.calls.at(-1)![1];

    expect(() =>
      wrapped({
        data: { name: "session", value: "secret" },
        sender: { id: "extension-id", url: "https://pt.example.com/details.php", tab: { id: 1 } },
      }),
    ).toThrow(/sender|permission/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it("扩展页面与内容脚本的普通下载消息仍可达", async () => {
    const { onMessage } = await import("@/messages.ts");
    const cookieHandler = vi.fn(async () => [] as chrome.cookies.Cookie[]);
    onMessage("getAllCookies", cookieHandler);
    const wrappedCookie = originalOnMessage.mock.calls.at(-1)![1];

    await expect(
      wrappedCookie({
        data: { domain: "pt.example.com" },
        sender: { id: "extension-id", url: "chrome-extension://extension-id/offscreen.html" },
      }),
    ).resolves.toEqual([]);

    const downloadHandler = vi.fn(async () => ({ downloadId: 1, downloadStatus: "completed" as const }));
    onMessage("downloadTorrent", downloadHandler);
    const wrappedDownload = originalOnMessage.mock.calls.at(-1)![1];
    await expect(
      wrappedDownload({
        data: { torrent: { link: "https://pt.example.com/download" } },
        sender: { id: "extension-id", url: "https://pt.example.com/details.php", tab: { id: 1 } },
      }),
    ).resolves.toEqual({ downloadId: 1, downloadStatus: "completed" });
  });

  it("内容脚本不能安装影响普通网页请求的 DNR 规则", async () => {
    const { onMessage } = await import("@/messages.ts");
    const handler = vi.fn();
    onMessage("updateDNRSessionRules", handler);
    const wrapped = originalOnMessage.mock.calls.at(-1)![1];

    expect(() =>
      wrapped({
        data: { rule: { id: 1 }, extOnly: false },
        sender: { id: "extension-id", url: "https://pt.example.com/details.php", tab: { id: 1 } },
      }),
    ).toThrow(/permission/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it("内容脚本只能读取引导所需的 storage 路径，不能整份读取或任意写入", async () => {
    const { onMessage } = await import("@/messages.ts");
    const sender = { id: "extension-id", url: "https://pt.example.com/details.php", tab: { id: 1 } };
    const read = vi.fn(async () => ({}));
    onMessage("getExtStoragePath", read);
    const wrappedRead = originalOnMessage.mock.calls.at(-1)![1];

    await expect(wrappedRead({ data: { key: "config", path: "contentScript" }, sender })).resolves.toEqual({});
    await expect(wrappedRead({ data: { key: "siteIndex", path: "siteHostMap" }, sender })).resolves.toEqual({});
    await expect(
      wrappedRead({ data: { key: "metadata", path: ["sites", "pt", "allowContentScript"] }, sender }),
    ).resolves.toEqual({});
    expect(() => wrappedRead({ data: { key: "config", path: [] }, sender })).toThrow(/permission/i);
    expect(() => wrappedRead({ data: { key: "metadata", path: ["sites", "pt", "inputSetting"] }, sender })).toThrow(
      /permission/i,
    );
    expect(read).toHaveBeenCalledTimes(3);

    const write = vi.fn();
    onMessage("patchExtStoragePath", write);
    const wrappedWrite = originalOnMessage.mock.calls.at(-1)![1];
    expect(() =>
      wrappedWrite({ data: { key: "metadata", path: ["backupServers", "evil"], value: {} }, sender }),
    ).toThrow(/permission/i);
    expect(write).not.toHaveBeenCalled();
  });

  it("内容脚本不能切换原生桥接开关", async () => {
    const { onMessage } = await import("@/messages.ts");
    const handler = vi.fn();
    onMessage("nativeBridgeSetEnabled", handler);
    const wrapped = originalOnMessage.mock.calls.at(-1)![1];

    expect(() =>
      wrapped({
        data: true,
        sender: { id: "extension-id", url: "https://pt.example.com/details.php", tab: { id: 1 } },
      }),
    ).toThrow(/permission/i);
    expect(handler).not.toHaveBeenCalled();
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

  it("写类消息发生 offscreen 连接错误后必须清掉就绪缓存，下一次写入重新确认文档", async () => {
    const connectionError = new Error("The message port closed before a response was received.");
    originalSendMessage
      .mockResolvedValueOnce(undefined) // ensure for first write
      .mockRejectedValueOnce(connectionError) // first write loses offscreen
      .mockResolvedValueOnce(undefined) // ensure for second write
      .mockResolvedValueOnce({ downloadId: "d2", status: 0 }); // second write
    const sendMessage = await loadSendMessage();

    await expect(sendMessage("downloadTorrent", { downloadId: "d1" } as any)).rejects.toBe(connectionError);
    await expect(sendMessage("downloadTorrent", { downloadId: "d2" } as any)).resolves.toMatchObject({
      downloadId: "d2",
    });

    expect(originalSendMessage.mock.calls.map(([type]) => type)).toEqual([
      "ensureOffscreenDocument",
      "downloadTorrent",
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

/* -------------------------------------------------------------------------- */
/*        TESTS-2：extensionPageOnlyMessages 名单的完备性守卫（原为零覆盖）        */
/* -------------------------------------------------------------------------- */

const messagesSource = readFileSync(resolve(process.cwd(), "src/entries/messages.ts"), "utf8");

/** 解析 `const <name> = new Set<...>([ ... ])` 里的字符串字面量集合 */
function parseSetLiteral(name: string): string[] {
  const declStart = messagesSource.indexOf(`const ${name} = new Set`);
  expect(declStart, `messages.ts 里应存在 ${name}`).toBeGreaterThan(-1);

  const bodyStart = messagesSource.indexOf("([", declStart);
  const bodyEnd = messagesSource.indexOf("]);", bodyStart);
  expect(bodyStart).toBeGreaterThan(-1);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  const body = messagesSource.slice(bodyStart + 2, bodyEnd);

  const values = [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  // 自证：解析结果必须与块内字符串字面量数量一致（解析器不能吞条目/把注释当条目）
  const rawQuoteCount = (body.match(/"/g) ?? []).length;
  expect(values.length * 2, `${name} 的解析结果与源码字符串数量不一致`).toBe(rawQuoteCount);
  expect(values.length, `${name} 不应为空`).toBeGreaterThan(0);
  return values;
}

/** 解析 `interface ProtocolMap { ... }` 的全部消息名（运行时拿不到：它是纯类型） */
function parseProtocolMessageNames(): string[] {
  const match = messagesSource.match(/interface ProtocolMap \{([\s\S]*?)\n\}/);
  expect(match, "messages.ts 里应有 interface ProtocolMap").toBeTruthy();
  const names = [...match![1]!.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/gm)].map((m) => m[1]!);
  expect(names.length, "ProtocolMap 消息名解析不应为空").toBeGreaterThan(50);
  return names;
}

/**
 * 管理类消息的命名模式：读写扩展存储 / Cookie / 备份 / DNR / 原生桥接。
 *
 * 为什么用「模式 + 豁免表」而不是手抄一份 29 项清单：手抄清单在新增消息时同样会漏
 * （正是 TESTS-2 要拦的那类回归）；模式规则下新加一个 `deleteBackupServer` /
 * `patchExtStoragePathBulk` 只要不登记就会让本用例变红，迫使维护者显式决策。
 */
const ADMIN_MESSAGE_PATTERNS = [/ExtStorage/, /Cookie/i, /Backup/, /DNR/, /^nativeBridge/];

/** 必须留在 extensionPageOnlyMessages 之外的消息（逐条给出理由） */
const ADMIN_PATTERN_EXEMPTIONS: Record<string, string> = {
  getExtStoragePath: "由包装器里的 isContentScriptStoragePathAllowed 做路径白名单，内容脚本可用但不能整份读取",
  getBackupHistory: "只读：列出远端备份文件名，不上传、不改配置",
  // checkAndExtendCookies 已于 src/entries/messages.ts:341 登记进 extensionPageOnlyMessages，
  // 原「已知缺口」豁免已删除：留在这里会让「有人把它从名单里删掉」的回归永远保持绿色（TESTS-2）。
};

describe("敏感消息的发送方限制：extensionPageOnlyMessages 完备性（TESTS-2）", () => {
  const contentScriptSender = {
    id: "extension-id",
    url: "https://pt.example.com/details.php",
    tab: { id: 1 },
  };

  beforeEach(() => {
    originalOnMessage.mockReset();
    vi.stubGlobal("chrome", {
      runtime: {
        id: "extension-id",
        getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      },
    });
  });

  it("两个名单都只引用真实消息，且解析结果与源码字符串数量一致（自证）", () => {
    const protocolNames = parseProtocolMessageNames();
    const offscreenTypes = parseSetLiteral("offscreenMessageTypes");
    const extensionOnlyTypes = parseSetLiteral("extensionPageOnlyMessages");

    expect(extensionOnlyTypes.length).toBeGreaterThan(0);
    for (const type of [...offscreenTypes, ...extensionOnlyTypes]) {
      expect(protocolNames, `${type} 不是 ProtocolMap 里的消息（拼写错误或已删除）`).toContain(type);
    }
    // 两个名单都不该有重复项
    expect(new Set(offscreenTypes).size).toBe(offscreenTypes.length);
    expect(new Set(extensionOnlyTypes).size).toBe(extensionOnlyTypes.length);
  });

  it("会读写扩展存储 / Cookie / 备份 / DNR / 原生桥接的消息都必须登记（豁免表逐条给理由）", () => {
    const protocolNames = parseProtocolMessageNames();
    const extensionOnlyTypes = parseSetLiteral("extensionPageOnlyMessages");

    const offenders = protocolNames.filter(
      (type) =>
        ADMIN_MESSAGE_PATTERNS.some((pattern) => pattern.test(type)) &&
        !extensionOnlyTypes.includes(type) &&
        !(type in ADMIN_PATTERN_EXEMPTIONS),
    );
    expect(
      offenders,
      "新增的管理类消息未登记进 extensionPageOnlyMessages（内容脚本发送方可直接调用）；" +
        "若确实只读/无害，请加进 ADMIN_PATTERN_EXEMPTIONS 并写明理由",
    ).toEqual([]);

    // 豁免表不能腐烂：每条豁免仍必须是真实消息名，且仍匹配管理类模式
    for (const [type, reason] of Object.entries(ADMIN_PATTERN_EXEMPTIONS)) {
      expect(protocolNames, `${type} 已不是消息名，豁免过期`).toContain(type);
      expect(
        ADMIN_MESSAGE_PATTERNS.some((pattern) => pattern.test(type)),
        `${type} 已不匹配管理类模式，豁免过期`,
      ).toBe(true);
      expect(reason.length, `${type} 的豁免必须写明理由`).toBeGreaterThan(0);
    }

    // getExtStoragePath 单独走路径白名单：它绝不能被登记进整份拒绝名单
    expect(extensionOnlyTypes, "getExtStoragePath 由路径白名单单独校验，不应登记").not.toContain("getExtStoragePath");
  });

  it("名单里的每一条都真的会拒绝内容脚本发送方（静态名单与运行时判定一致）", async () => {
    const { onMessage } = await import("@/messages.ts");
    const extensionOnlyTypes = parseSetLiteral("extensionPageOnlyMessages");

    for (const type of extensionOnlyTypes) {
      originalOnMessage.mockClear();
      const handler = vi.fn();
      onMessage(type as any, handler);
      const wrapped = originalOnMessage.mock.calls.at(-1)![1];

      expect(() => wrapped({ data: undefined, sender: contentScriptSender }), `${type} 未拒绝内容脚本`).toThrow(
        /permission/i,
      );
      expect(handler, `${type} 的 handler 不应被调用`).not.toHaveBeenCalled();

      // 扩展页发送方仍应放行（名单只针对内容脚本）
      wrapped({
        data: undefined,
        sender: { id: "extension-id", url: "chrome-extension://extension-id/offscreen.html" },
      });
      expect(handler, `${type} 应允许扩展页发送方`).toHaveBeenCalledTimes(1);
    }
  });

  it("内容脚本必需的搜索 / 下载类消息没有被误登记", async () => {
    const { onMessage } = await import("@/messages.ts");
    const extensionOnlyTypes = parseSetLiteral("extensionPageOnlyMessages");

    for (const type of [
      "getSiteUserConfig",
      "getTorrentDownloadLink",
      "downloadTorrent",
      "matchSocialPage",
      "openOptionsPage",
    ] as const) {
      expect(extensionOnlyTypes, `${type} 是内容脚本必需能力，不应登记`).not.toContain(type);

      originalOnMessage.mockClear();
      const handler = vi.fn(async () => "ok");
      onMessage(type as any, handler);
      const wrapped = originalOnMessage.mock.calls.at(-1)![1];
      await expect(wrapped({ data: undefined, sender: contentScriptSender })).resolves.toBe("ok");
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  it("内容脚本只能调用显式白名单消息，管理和高权限消息必须拒绝", async () => {
    const { onMessage } = await import("@/messages.ts");
    const deniedTypes = ["deleteClientTorrent", "downloadFile", "clearLogger"] as const;

    for (const type of deniedTypes) {
      originalOnMessage.mockClear();
      const handler = vi.fn(async () => ({ inputSetting: { token: "secret" } }));
      onMessage(type as any, handler);
      const wrapped = originalOnMessage.mock.calls.at(-1)![1];

      expect(() => wrapped({ data: undefined, sender: contentScriptSender }), `${type} 未拒绝内容脚本`).toThrow(
        /permission/i,
      );
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("内容脚本读取站点配置时不得拿到 inputSetting 凭据", async () => {
    const { onMessage } = await import("@/messages.ts");
    const handler = vi.fn(async (): Promise<any> => ({
      url: "https://pt.example.com/",
      inputSetting: { token: "secret", passkey: "secret-passkey" },
      allowSearch: true,
    }));
    onMessage("getSiteUserConfig", handler);
    const wrapped = originalOnMessage.mock.calls.at(-1)![1];

    await expect(
      wrapped({
        data: { siteId: "mteam" },
        sender: contentScriptSender,
      }),
    ).resolves.toEqual({
      url: "https://pt.example.com/",
      allowSearch: true,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
