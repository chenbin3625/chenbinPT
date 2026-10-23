/**
 * F1-08 回归：`sendTorrentToDownloader` 的下载参数预处理（2026-10-23 修复轮）。
 *
 * 审查结论（F1-options-shell-stores.md [Low]-F1-08）：
 * - 「空 savePath/label 删除」分支写在 `if (值)` 内部，永远不成立（死分支），空串被原样下发给下载器；
 * - `<...>` 动态替换直接改写调用方（对话框）的对象，用户取消后已替换内容仍残留在对话框状态里；
 * - `addTorrentOptions[key] as string` 直接 `.includes`，字段为 undefined 时会 TypeError。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createApp } from "vue";

const { sendMessageMock, getDefinedSiteMetadataMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async (_type: string, _payload?: any): Promise<any> => undefined),
  getDefinedSiteMetadataMock: vi.fn(),
}));

vi.mock("@/messages.ts", () => ({ sendMessage: sendMessageMock }));
vi.mock("@ptd/site", () => ({
  getHostFromUrl: (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  },
  getDefinedSiteMetadata: getDefinedSiteMetadataMock,
}));
vi.mock("ant-design-vue", () => ({
  message: { open: vi.fn() },
  Input: { name: "MockInput", props: ["value"], render: () => null },
}));

import { i18n } from "@/options/plugins/i18n.ts";
import { sendTorrentToDownloader } from "@/options/components/SentToDownloaderDialog/utils.ts";

function createStores() {
  const pinia = createPinia();
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
  return pinia;
}

function baseOptions(overrides: Record<string, any> = {}) {
  return {
    localDownload: true,
    addAtPaused: false,
    savePath: "",
    label: "",
    uploadSpeedLimit: 0,
    advanceAddTorrentOptions: {},
    ...overrides,
  } as any;
}

/** 取出本次 `downloadTorrent` 消息里的 addTorrentOptions */
function sentOptions(callIndex = 0) {
  const calls = sendMessageMock.mock.calls.filter(([type]) => type === "downloadTorrent");
  return calls[callIndex]?.[1]?.addTorrentOptions as Record<string, any>;
}

beforeEach(() => {
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(async () => ({ downloadStatus: "success" }));
  getDefinedSiteMetadataMock.mockReset();
  getDefinedSiteMetadataMock.mockImplementation(async (siteId: string) => ({
    id: siteId,
    name: `站点 ${siteId}`,
    urls: [`https://${siteId}.example/`],
    legacyUrls: [],
    isDead: false,
    category: [],
    searchEntry: { default: {} },
  }));
  createStores();
});

describe("F1-08：空 savePath/label 不再原样下发", () => {
  it("空串与 undefined 都从 addTorrentOptions 里删除（语义 = 用下载器默认值）", async () => {
    const options = baseOptions({ savePath: "", label: "" });
    await sendTorrentToDownloader([{ title: "t1" } as any], "d1", options, async () => "x", {});

    const payload = sentOptions();
    expect(payload).toBeDefined();
    expect(Object.hasOwn(payload, "savePath")).toBe(false);
    expect(Object.hasOwn(payload, "label")).toBe(false);
    // 其它字段照常带上
    expect(payload.localDownload).toBe(true);
    expect(payload.addAtPaused).toBe(false);

    // 调用方的对象不被改写
    expect(options.savePath).toBe("");
    expect(options.label).toBe("");
  });

  it("字段为 undefined 时不会抛 TypeError", async () => {
    const options = baseOptions({ savePath: undefined, label: undefined });
    await expect(
      sendTorrentToDownloader([{ title: "t1" } as any], "d1", options, async () => "x", {}),
    ).resolves.toBeUndefined();
    const payload = sentOptions();
    expect(Object.hasOwn(payload, "savePath")).toBe(false);
  });
});

describe("F1-08：占位符替换", () => {
  it("$torrent.site$ / $torrent.siteName$ / $torrent.title$ 被替换（含重复出现）", async () => {
    await sendTorrentToDownloader(
      [{ title: "Movie X", site: "ptsite" } as any],
      "d1",
      baseOptions({ savePath: "/dl/$torrent.site$/$torrent.siteName$", label: "$torrent.site$-$torrent.title$" }),
      async () => "x",
      {},
    );

    const payload = sentOptions();
    expect(payload.savePath).toBe("/dl/ptsite/站点 ptsite");
    expect(payload.label).toBe("ptsite-Movie X");
  });

  it("没有 site 时保留站点占位符不替换（与旧行为一致），其它占位符照常替换", async () => {
    await sendTorrentToDownloader(
      [{ title: "Only title" } as any],
      "d1",
      baseOptions({ savePath: "/dl/$torrent.site$/$torrent.title$" }),
      async () => "x",
      {},
    );
    // 旧行为：`$torrent.site$` 原样保留（仅替换 replaceMap 里存在的项）
    expect(sentOptions().savePath).toBe("/dl/$torrent.site$/Only title");
  });
});

describe("F1-08：`<...>` 动态替换", () => {
  it("用用户输入替换，且不改写调用方对象（取消/重开不回写旧值）", async () => {
    const options = baseOptions({ savePath: "/dl/<...>", label: "" });
    const prompt = vi.fn(async () => "  MyFolder  ");

    await sendTorrentToDownloader([{ title: "t" } as any], "d1", options, prompt, {});

    expect(prompt).toHaveBeenCalledWith("savePath");
    expect(sentOptions().savePath).toBe("/dl/MyFolder");
    // 调用方（对话框 ref）保持原样
    expect(options.savePath).toBe("/dl/<...>");
  });

  it("用户取消输入时 reject，且不发 downloadTorrent", async () => {
    const options = baseOptions({ label: "<...>" });
    const prompt = vi.fn(async () => null);

    await expect(sendTorrentToDownloader([{ title: "t" } as any], "d1", options, prompt, {})).rejects.toBe(
      i18n.t("SentToDownloaderDialog.dynamicReplaceCancelled", ["label"]),
    );
    expect(sendMessageMock.mock.calls.filter(([type]) => type === "downloadTorrent")).toHaveLength(0);
    expect(options.label).toBe("<...>");
  });
});

/* ------------------------------------------------------------------ *
 * Info8（B2 移交）：替换值进保存路径前做路径安全化
 * ------------------------------------------------------------------ */

describe("Info8：$search:keyword$ / $torrent.title$ 等替换值做路径安全化", () => {
  it("目录穿越、路径分隔符、NUL 控制字符与非法文件名字符都被清理", async () => {
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const runtimeStore = useRuntimeStore();
    runtimeStore.search.searchKey = "../../etc/passwd\\x\u0000y";

    await sendTorrentToDownloader(
      [{ title: "../../evil/Movie: 2024?" } as any],
      "d1",
      baseOptions({ savePath: "/dl/$search:keyword$/$torrent.title$", label: "$torrent.title$" }),
      async () => "x",
      {},
    );

    const { sanitizeDynamicReplaceValue } = await import("@/options/components/SentToDownloaderDialog/utils.ts");
    const payload = sentOptions();
    // 模板里的路径分隔符保留，替换值走同一套清理规则
    expect(payload.savePath).toBe(
      `/dl/${sanitizeDynamicReplaceValue("../../etc/passwd\\x\u0000y")}/${sanitizeDynamicReplaceValue("../../evil/Movie: 2024?")}`,
    );
    expect(payload.savePath).not.toContain("..");
    expect(payload.savePath).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(payload.label).not.toMatch(/[\\/:*?"<>|]/);
    expect(payload.label).not.toContain("..");
    // 仍然保留可读内容
    expect(payload.savePath).toContain("etc");
    expect(payload.label).toContain("evil");
  });

  it("正常标题（含中文/空格）保持可读，不被误清理", async () => {
    await sendTorrentToDownloader(
      [{ title: "电影 名称 2024" } as any],
      "d1",
      baseOptions({ savePath: "/dl/$torrent.title$", label: "$torrent.title$" }),
      async () => "x",
      {},
    );

    const payload = sentOptions();
    expect(payload.savePath).toBe("/dl/电影 名称 2024");
    expect(payload.label).toBe("电影 名称 2024");
  });

  it("sanitizeDynamicReplaceValue 的边界：空值 / 超长 / 连续点", async () => {
    const { sanitizeDynamicReplaceValue } = await import("@/options/components/SentToDownloaderDialog/utils.ts");
    expect(sanitizeDynamicReplaceValue(undefined)).toBe("");
    expect(sanitizeDynamicReplaceValue(null)).toBe("");
    expect(sanitizeDynamicReplaceValue("a..b...c")).toBe("a.b.c");
    expect(sanitizeDynamicReplaceValue("a\tb\nc")).toBe("a b c");
    expect(sanitizeDynamicReplaceValue("x".repeat(500))).toHaveLength(200);
  });
});
