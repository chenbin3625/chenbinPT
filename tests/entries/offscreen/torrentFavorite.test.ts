/**
 * 种子收藏的 offscreen 处理方（移植自上游 122b8942，并按 fork 的发送方信任模型收紧）。
 *
 * - 基本语义：重复收藏视为更新（保留收藏时间），favCategories / comment 缺省保持原值、传空值清空；
 * - 写入串行：并发的 create / delete 不会互相覆盖；
 * - 安全收紧（偏离上游）：
 *   - 内容脚本 create 时每个 torrent.site 都必须与发送页面绑定，跨站被拒绝；
 *   - 内容脚本传入的种子只保留 ITorrent 声明过的字段；
 *   - getTorrentFavoriteStatus 只回 key / 分类 / 备注，不含 link / url；内容脚本查询别站种子被拒绝。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
  getSiteInstance: vi.fn(),
  storage: { value: undefined as Record<string, any> | undefined },
}));

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));
vi.mock("@/offscreen/utils/site.ts", () => ({ getSiteInstance: mocks.getSiteInstance }));

vi.stubGlobal("chrome", { runtime: { id: "test", getURL: (path: string) => `chrome-extension://test/${path}` } });

type Handler = (args: { data: any; sender?: any }) => Promise<any>;

const SITE_HOSTS: Record<string, string[]> = { a: ["a.example.com"], b: ["b.example.com"] };

async function loadModule() {
  vi.resetModules();
  mocks.onMessage.mockClear();
  mocks.storage.value = undefined;

  mocks.sendMessage.mockReset();
  mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
    if (name === "getExtStorage") return structuredClone(mocks.storage.value);
    if (name === "setExtStorage") {
      // 模拟真实存储的跨上下文往返（结构化克隆）与异步写入
      await Promise.resolve();
      mocks.storage.value = structuredClone(payload.value);
      return undefined;
    }
    return undefined;
  });

  mocks.getSiteInstance.mockReset();
  mocks.getSiteInstance.mockImplementation(async (siteId: string) => ({
    metadata: { id: siteId },
    isTrustedSiteUrl: (url: string) => (SITE_HOSTS[siteId] ?? []).includes(new URL(url).hostname),
  }));

  const mod = await import("@/offscreen/utils/torrentFavorite.ts");
  const handlers: Record<string, Handler> = {};
  for (const [name, handler] of mocks.onMessage.mock.calls) {
    handlers[name as string] = handler as Handler;
  }
  return { mod, handlers };
}

const contentScriptSender = (url: string) => ({ id: "test", url, tab: { url } });
const extensionSender = { id: "test", url: "chrome-extension://test/src/entries/options/index.html" };

function makeTorrent(overrides: Record<string, any> = {}) {
  return {
    site: "a",
    id: "1",
    title: "t",
    link: "https://a.example.com/download.php?id=1&passkey=secret",
    url: "https://a.example.com/details.php?id=1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("收藏的基本语义", () => {
  it("重复收藏视为更新：保留收藏时间，favCategories / comment 缺省保持原值，传空值清空", async () => {
    const { handlers } = await loadModule();
    const torrent = makeTorrent();

    await handlers.createTorrentFavorites!({
      data: { torrents: [torrent], favCategories: [" 电影 ", "电影", ""], comment: "第一次" },
      sender: extensionSender,
    });
    const first = mocks.storage.value!["a-1"];
    expect(first).toMatchObject({ key: "a-1", favCategories: ["电影"], comment: "第一次" });

    await handlers.createTorrentFavorites!({
      data: { torrents: [{ ...torrent, title: "t2" }] },
      sender: extensionSender,
    });
    const kept = mocks.storage.value!["a-1"];
    expect(kept).toMatchObject({ title: "t2", favCategories: ["电影"], comment: "第一次", createdAt: first.createdAt });

    await handlers.createTorrentFavorites!({
      data: { torrents: [torrent], favCategories: [], comment: "" },
      sender: extensionSender,
    });
    expect(mocks.storage.value!["a-1"]).toMatchObject({ favCategories: [], comment: "" });
  });

  it("getTorrentFavorites 按收藏时间倒序；deleteTorrentFavorites 删除指定项", async () => {
    const { handlers } = await loadModule();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    await handlers.createTorrentFavorites!({ data: { torrents: [makeTorrent({ id: "1" })] }, sender: extensionSender });
    vi.setSystemTime(2000);
    await handlers.createTorrentFavorites!({ data: { torrents: [makeTorrent({ id: "2" })] }, sender: extensionSender });
    vi.useRealTimers();

    expect((await handlers.getTorrentFavorites!({ data: undefined })).map((x: any) => x.key)).toEqual(["a-2", "a-1"]);

    await handlers.deleteTorrentFavorites!({ data: ["a-2"], sender: extensionSender });
    expect(Object.keys(mocks.storage.value!)).toEqual(["a-1"]);
  });

  it("并发的 create / delete 串行执行，不会互相覆盖", async () => {
    const { handlers } = await loadModule();
    await Promise.all([
      handlers.createTorrentFavorites!({ data: { torrents: [makeTorrent({ id: "1" })] }, sender: extensionSender }),
      handlers.createTorrentFavorites!({ data: { torrents: [makeTorrent({ id: "2" })] }, sender: extensionSender }),
      handlers.createTorrentFavorites!({ data: { torrents: [makeTorrent({ id: "3" })] }, sender: extensionSender }),
    ]);
    expect(Object.keys(mocks.storage.value!).sort()).toEqual(["a-1", "a-2", "a-3"]);
  });
});

describe("内容脚本的权限边界（偏离上游的安全收紧）", () => {
  it("内容脚本在本站页面收藏本站种子：允许，且只保留 ITorrent 声明过的字段", async () => {
    const { handlers } = await loadModule();
    const count = await handlers.createTorrentFavorites!({
      data: { torrents: [{ ...makeTorrent(), injected: "x", ext_imdb: "tt1" }], favCategories: ["a"] },
      sender: contentScriptSender("https://a.example.com/torrents.php"),
    });

    expect(count).toBe(1);
    const stored = mocks.storage.value!["a-1"];
    expect(stored.injected).toBeUndefined();
    expect(stored.ext_imdb).toBe("tt1");
    expect(stored.favCategories).toEqual(["a"]);
  });

  it("内容脚本跨站收藏（A 站页面写入 B 站种子）：整批拒绝，存储不变", async () => {
    const { handlers } = await loadModule();
    await expect(
      handlers.createTorrentFavorites!({
        data: { torrents: [makeTorrent(), makeTorrent({ site: "b", id: "9" })] },
        sender: contentScriptSender("https://a.example.com/torrents.php"),
      }),
    ).rejects.toThrow(/Permission denied/);
    expect(mocks.storage.value).toBeUndefined();
  });

  it("内容脚本未提供 torrent.site：拒绝", async () => {
    const { handlers } = await loadModule();
    await expect(
      handlers.createTorrentFavorites!({
        data: { torrents: [makeTorrent({ site: undefined })] },
        sender: contentScriptSender("https://a.example.com/"),
      }),
    ).rejects.toThrow(/must supply the torrent site/);
  });

  it("外部扩展作为 sender（id 不匹配）同样受站点绑定约束", async () => {
    const { handlers } = await loadModule();
    await expect(
      handlers.createTorrentFavorites!({
        data: { torrents: [makeTorrent()] },
        sender: { id: "other-extension", url: "https://a.example.com/" },
      }),
    ).rejects.toThrow(/Permission denied/);
  });

  it("getTorrentFavoriteStatus 只回 key / 分类 / 备注（不含 link / url），内容脚本查询别站种子被拒绝", async () => {
    const { handlers } = await loadModule();
    await handlers.createTorrentFavorites!({
      data: { torrents: [makeTorrent(), makeTorrent({ site: "b", id: "9" })], favCategories: ["x"], comment: "c" },
      sender: extensionSender,
    });

    const status = await handlers.getTorrentFavoriteStatus!({
      data: { torrents: [makeTorrent(), makeTorrent({ id: "404" })] },
      sender: contentScriptSender("https://a.example.com/torrents.php"),
    });
    expect(status).toEqual({ favorites: [{ key: "a-1", favCategories: ["x"], comment: "c" }], favCategories: ["x"] });
    expect(JSON.stringify(status)).not.toContain("passkey");

    await expect(
      handlers.getTorrentFavoriteStatus!({
        data: { torrents: [makeTorrent({ site: "b", id: "9" })] },
        sender: contentScriptSender("https://a.example.com/torrents.php"),
      }),
    ).rejects.toThrow(/Permission denied/);
  });
});
