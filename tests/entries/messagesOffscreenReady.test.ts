import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

  it("内容脚本可先确保 offscreen 就绪，否则其社交页面预筛无法发送", async () => {
    const { onMessage } = await import("@/messages.ts");
    const handler = vi.fn(async () => undefined);
    onMessage("ensureOffscreenDocument", handler);
    const wrapped = originalOnMessage.mock.calls.at(-1)![1];

    await expect(
      wrapped({
        data: undefined,
        sender: { id: "extension-id", url: "https://movie.douban.com/top250", tab: { id: 1 } },
      }),
    ).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
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

    // 正向用例：允许内容脚本保存悬浮球位置（P1-2）
    write.mockResolvedValueOnce(true);
    await expect(
      wrappedWrite({
        data: { key: "config", path: "contentScript.position", value: { x: 10, y: 20 } },
        sender,
      }),
    ).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
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

/**
 * 三个消息名单直接取模块运行时值（2026-10-24：不再解析 `messages.ts` 源码文本）。
 *
 * 源码文本断言的问题（REVIEW-FINDINGS 测试有效性项 / TEST-6 派生）：
 * - 名单里加一行注释、换一种集合写法（`new Set([...])` → 别的形式）都会让解析假红；
 * - 反过来，如果「名单内容」与「运行时实际判定」漂移，源码断言也发现不了。
 * 现在名单在 `messages.ts` 里 `export`，这里直接断言真实对象；`parseProtocolMessageNames()`
 * 仍读源码是因为 ProtocolMap 是纯类型、运行时不存在，只能从文本取消息名（用于拼写校验）。
 */
async function loadAllowlistSets(): Promise<{
  offscreenTypes: string[];
  extensionOnlyTypes: string[];
  contentScriptAllowedTypes: string[];
}> {
  const mod = await import("@/messages.ts");
  return {
    offscreenTypes: [...mod.offscreenMessageTypes] as string[],
    extensionOnlyTypes: [...mod.extensionPageOnlyMessages] as string[],
    contentScriptAllowedTypes: [...mod.contentScriptAllowedMessages] as string[],
  };
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

  it("两个名单都只引用真实消息，且运行时名单与 ProtocolMap 一致", async () => {
    const protocolNames = parseProtocolMessageNames();
    const { offscreenTypes, extensionOnlyTypes } = await loadAllowlistSets();

    expect(extensionOnlyTypes.length).toBeGreaterThan(0);
    for (const type of [...offscreenTypes, ...extensionOnlyTypes]) {
      expect(protocolNames, `${type} 不是 ProtocolMap 里的消息（拼写错误或已删除）`).toContain(type);
    }
    // 两个名单都不该有重复项
    expect(new Set(offscreenTypes).size).toBe(offscreenTypes.length);
    expect(new Set(extensionOnlyTypes).size).toBe(extensionOnlyTypes.length);
  });

  it("ProtocolMap 的每条消息都有 onMessage handler，且没有未声明的 handler（上游 f9780a2f）", () => {
    // 回归背景：setDownloadHistoryStatus 曾经只有协议声明和调用方、没有 handler，调用必然抛「无 handler」
    // 又被调用点的 .catch() 吞掉；showNotification 则是声明了却既无 handler 也无调用方的死协议项。
    const protocolNames = parseProtocolMessageNames();
    const handlerNames = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|vue)$/.test(entry.name)) {
          for (const match of readFileSync(full, "utf8").matchAll(/onMessage\(\s*["'`]([\w$]+)["'`]/g)) {
            handlerNames.add(match[1]!);
          }
        }
      }
    };
    walk(resolve(process.cwd(), "src"));

    expect(
      protocolNames.filter((name) => !handlerNames.has(name)),
      "声明了但没有 handler 的消息",
    ).toEqual([]);
    expect(
      [...handlerNames].filter((name) => !protocolNames.includes(name)),
      "有 handler 但 ProtocolMap 未声明的消息",
    ).toEqual([]);
  });

  it("会读写扩展存储 / Cookie / 备份 / DNR / 原生桥接的消息都必须登记（豁免表逐条给理由）", async () => {
    const protocolNames = parseProtocolMessageNames();
    const { extensionOnlyTypes } = await loadAllowlistSets();

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
    const { extensionOnlyTypes } = await loadAllowlistSets();

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
    const { extensionOnlyTypes } = await loadAllowlistSets();

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

  it("内容脚本读取站点配置时不得拿到 inputSetting / runtimeSettings 及其他未白名单字段（A1）", async () => {
    const { onMessage } = await import("@/messages.ts");
    const handler = vi.fn(async (): Promise<any> => ({
      id: "mteam",
      url: "https://pt.example.com/",
      allowSearch: true,
      sortIndex: 10,
      merge: { name: "M-Team" },
      // 两份凭据都必须被投影掉：inputSetting 是用户填的，runtimeSettings 是站点实例缓存的
      inputSetting: { token: "secret", passkey: "secret-passkey" },
      runtimeSettings: {
        authKey: { authkey: "authkey-secret", passkey: "passkey-secret" },
        authToken: "auth-token-secret",
      },
      // 未列入白名单的字段默认不下发（fail-closed，防止未来新增字段又把凭据带出去）
      someFutureSecret: "secret",
    }));
    onMessage("getSiteUserConfig", handler);
    const wrapped = originalOnMessage.mock.calls.at(-1)![1];

    await expect(
      wrapped({
        data: { siteId: "mteam" },
        sender: contentScriptSender,
      }),
    ).resolves.toEqual({
      id: "mteam",
      url: "https://pt.example.com/",
      allowSearch: true,
      sortIndex: 10,
      merge: { name: "M-Team" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("N2：扩展自身上下文（sender.url 缺失且无 tab，如 MV3 service worker）视为可信扩展页：不投影、可调用受信消息", async () => {
    const { onMessage } = await import("@/messages.ts");
    const fullConfig = {
      url: "https://pt.example.com/",
      allowSearch: true,
      inputSetting: { token: "secret" },
      runtimeSettings: { authKey: { passkey: "secret" } },
    };
    const handler = vi.fn(async (): Promise<any> => fullConfig);
    onMessage("getSiteUserConfig", handler);
    const wrapped = originalOnMessage.mock.calls.at(-1)![1];

    // 背景 service worker 等扩展自身上下文：url 缺失但也没有 tab（内容脚本一定带 tab），
    // 必须按扩展页放行 —— 否则后台 → offscreen 的受信消息在 Chrome < M140 会被静默拒绝。
    await expect(
      wrapped({
        data: { siteId: "mteam" },
        sender: { id: "extension-id" },
      }),
    ).resolves.toEqual(fullConfig);
    expect(handler).toHaveBeenCalledTimes(1);

    // 扩展自身上下文可以调用「在扩展页白名单、但不在内容脚本白名单」的消息（如原生桥）
    originalOnMessage.mockClear();
    const allowedHandler = vi.fn(async () => "qb-version");
    onMessage("getDownloaderVersion", allowedHandler);
    const wrappedAllowed = originalOnMessage.mock.calls.at(-1)![1];
    await expect(wrappedAllowed({ data: "qb", sender: { id: "extension-id" } })).resolves.toBe("qb-version");
    expect(allowedHandler).toHaveBeenCalledTimes(1);
  });

  it("N2：sender.url 缺失但带 tab 的发送方仍按不可信处理（内容脚本/iframe 场景 fail-closed）", async () => {
    const { onMessage } = await import("@/messages.ts");
    const handler = vi.fn(async (): Promise<any> => ({
      url: "https://pt.example.com/",
      allowSearch: true,
      inputSetting: { token: "secret" },
      runtimeSettings: { authKey: { passkey: "secret" } },
    }));
    onMessage("getSiteUserConfig", handler);
    const wrapped = originalOnMessage.mock.calls.at(-1)![1];

    // 带 tab = 一定来自页面（内容脚本），url 缺失不能成为「可信扩展页」的理由
    await expect(
      wrapped({
        data: { siteId: "mteam" },
        sender: { id: "extension-id", tab: { id: 1 } },
      }),
    ).resolves.toEqual({ url: "https://pt.example.com/", allowSearch: true });
    expect(handler).toHaveBeenCalledTimes(1);

    // 同类发送方也不能调用「非 extensionPageOnly、但不在内容脚本白名单」的消息
    originalOnMessage.mockClear();
    const deniedHandler = vi.fn(async () => "should-not-run");
    onMessage("getDownloaderVersion", deniedHandler);
    const wrappedDenied = originalOnMessage.mock.calls.at(-1)![1];
    expect(() => wrappedDenied({ data: "qb", sender: { id: "extension-id", tab: { id: 1 } } })).toThrow(/permission/i);
    expect(deniedHandler).not.toHaveBeenCalled();
  });

  it("N2：其它扩展的发送方（sender.id 不匹配）一律不可信，即使 sender.url 指向站点页", async () => {
    const { onMessage } = await import("@/messages.ts");
    const handler = vi.fn(async (): Promise<any> => ({
      url: "https://pt.example.com/",
      inputSetting: { token: "secret" },
    }));
    onMessage("getSiteUserConfig", handler);
    const wrapped = originalOnMessage.mock.calls.at(-1)![1];

    const foreignSender = { id: "other-extension", url: "https://pt.example.com/details.php", tab: { id: 1 } };
    await expect(wrapped({ data: { siteId: "mteam" }, sender: foreignSender })).resolves.toEqual({
      url: "https://pt.example.com/",
    });

    originalOnMessage.mockClear();
    const deniedHandler = vi.fn(async () => "should-not-run");
    onMessage("getDownloaderVersion", deniedHandler);
    const wrappedDenied = originalOnMessage.mock.calls.at(-1)![1];
    expect(() => wrappedDenied({ data: "qb", sender: foreignSender })).toThrow(/permission/i);
    expect(deniedHandler).not.toHaveBeenCalled();
  });

  it("A2 纵深防御：内容脚本伪造 allowSiteLessLink=true 时，消息层强制置 false（主修在 offscreen/B1）", async () => {
    const { onMessage } = await import("@/messages.ts");
    const handler = vi.fn(async () => ({ downloadId: 1, downloadStatus: "completed" as const }));
    onMessage("downloadTorrent", handler);
    const wrapped = originalOnMessage.mock.calls.at(-1)![1];

    await wrapped({
      data: { torrent: { link: "https://evil.example/x.torrent" }, allowSiteLessLink: true, downloaderId: "local" },
      sender: contentScriptSender,
    });
    expect((handler.mock.calls[0] as any[])[0].data).toMatchObject({ allowSiteLessLink: false });

    // 扩展页发送方（右键菜单/options）仍可携带该开关，行为不变
    originalOnMessage.mockClear();
    const extHandler = vi.fn(async () => ({ downloadId: 2, downloadStatus: "completed" as const }));
    onMessage("downloadTorrent", extHandler);
    const wrappedExt = originalOnMessage.mock.calls.at(-1)![1];
    await wrappedExt({
      data: { torrent: { link: "https://pt.example.com/x.torrent" }, allowSiteLessLink: true, downloaderId: "local" },
      sender: { id: "extension-id", url: "chrome-extension://extension-id/offscreen.html" },
    });
    expect((extHandler.mock.calls[0] as any[])[0].data).toMatchObject({ allowSiteLessLink: true });
  });
});

/* -------------------------------------------------------------------------- */
/*   TEST-6：contentScriptAllowedMessages 的「默认拒绝」守卫（原为零覆盖）        */
/* -------------------------------------------------------------------------- */

/**
 * 内容脚本白名单里允许出现的「管理类」消息及逐条理由。
 *
 * 其余命中 `CONTENT_SCRIPT_ADMIN_PATTERNS` 的消息都不允许进内容脚本白名单；
 * 新加一条危险消息时，若既没被模式命中、也没在豁免表里，只有「已知危险名单」用例能发现——
 * 因此这里用「模式 + 豁免理由」而不是手抄完整清单。
 */
const CONTENT_SCRIPT_ALLOWLIST_EXEMPTIONS: Record<string, string> = {
  getExtStoragePath: "走 isContentScriptStoragePathAllowed 的路径白名单，内容脚本不能整份读取",
  patchExtStoragePath: "只允许写 config.contentScript.position（拖拽图标位置）",
};

const CONTENT_SCRIPT_ADMIN_PATTERNS = [
  /ExtStorage/,
  /Cookie/i,
  /Backup/,
  /DNR/,
  /^nativeBridge/,
  /Logger/,
  /^(?:add|remove|clear)ContextMenu/,
];

describe("内容脚本白名单完备性（TEST-6）", () => {
  it("白名单只引用真实消息，且无重复项", async () => {
    const protocolNames = parseProtocolMessageNames();
    const { contentScriptAllowedTypes: allowed } = await loadAllowlistSets();

    expect(allowed.length).toBeGreaterThan(0);
    for (const type of allowed) {
      expect(protocolNames, `${type} 不是 ProtocolMap 里的消息（拼写错误或已删除）`).toContain(type);
    }
    expect(new Set(allowed).size).toBe(allowed.length);
  });

  it("管理类/副作用消息不得进入内容脚本白名单（豁免表逐条给理由）", async () => {
    const { contentScriptAllowedTypes: allowed } = await loadAllowlistSets();

    const offenders = allowed.filter(
      (type) =>
        CONTENT_SCRIPT_ADMIN_PATTERNS.some((pattern) => pattern.test(type)) &&
        !(type in CONTENT_SCRIPT_ALLOWLIST_EXEMPTIONS),
    );
    expect(
      offenders,
      "新增的管理类消息被放进了内容脚本白名单；若确实无害，请加进 CONTENT_SCRIPT_ALLOWLIST_EXEMPTIONS 并写明理由",
    ).toEqual([]);

    // 豁免表不能腐烂
    for (const [type, reason] of Object.entries(CONTENT_SCRIPT_ALLOWLIST_EXEMPTIONS)) {
      expect(allowed, `${type} 已不在内容脚本白名单里，豁免过期`).toContain(type);
      expect(reason.length, `${type} 的豁免必须写明理由`).toBeGreaterThan(0);
    }
  });

  it("凭据读取与破坏性消息明确不在内容脚本白名单里", async () => {
    const { contentScriptAllowedTypes: allowed } = await loadAllowlistSets();

    for (const type of [
      "getDownloaderConfig",
      "getDownloadHistory",
      "getLogger",
      "clearLogger",
      "setExtStorage",
      "getExtStorage",
      "nativeBridgeSetEnabled",
      "exportBackupData",
      "restoreBackupData",
      "deleteDownloadHistoryById",
      "clearDownloadHistory",
      "removeSiteUserInfo",
      "clearKeepUploadTasks",
    ]) {
      expect(allowed, `${type} 不应开放给内容脚本`).not.toContain(type);
    }
  });
});
