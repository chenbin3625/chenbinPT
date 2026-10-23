/**
 * CS-1 / CS-2 回归（B2 修复轮）：
 *
 * - CS-1：没有声明 `metadata.list` 的站点，`search`/`searchEntry` 的 url 是**路径**而不是正则。
 *   旧实现 `new RegExp("/", "i").test(location.href)` 会命中任何页面，且 list 优先于 detail，
 *   于是 `learnflakes` 这类站点（search url `/`、detail 有 urlPattern）的详情页永远被判成列表页。
 * - CS-2：URL 订阅不应在悬浮菜单收起时求值（否则同一页面的 pageType 取决于是否发生过 pushState，
 *   并且每次 SPA 跳转都白建一次站点实例）。
 * - Info 4/7：过期请求不得覆盖新站点实例；`getIDFromURL` 对「参数存在但为空」要继续尝试下一个参数。
 *
 * 这里直接调用纯函数 `detectPageType`（覆盖各种 metadata 形态），再用真实的订阅/求值链路验证
 * 实例复用与菜单状态门控。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/content-script/app/pages/SocialSitePage.vue", () => ({ default: { name: "SocialSitePage" } }));
vi.mock("@/content-script/app/pages/SiteListPage.vue", () => ({ default: { name: "SiteListPage" } }));
vi.mock("@/content-script/app/pages/SiteDetailPage.vue", () => ({ default: { name: "SiteDetailPage" } }));

const mocks = vi.hoisted(() => ({ getSite: vi.fn(), siteUserConfig: {} as Record<string, unknown> }));
vi.mock("@ptd/site", () => ({ getSite: mocks.getSite }));
vi.mock("@/options/stores/metadata.ts", () => ({
  useMetadataStore: () => ({
    siteHostMap: {},
    // L4：用可变对象模拟「options 侧修改站点配置」，用于验证复用实例会失效重建
    getSiteUserConfig: async () => mocks.siteUserConfig,
  }),
}));

(globalThis as any).__BROWSER__ = "chrome";

const {
  detectPageType,
  getIDFromURL,
  installPageTypeUrlWatcher,
  isTrustedTorrentLink,
  pageType,
  siteInstance,
  updatePageType,
} = await import("@/content-script/app/utils.ts");

const SITE_ID = "testsite";

async function flushAsync() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function makeMetadata(partial: Record<string, any>) {
  return { id: SITE_ID, urls: ["https://pt.example.com/"], ...partial } as any;
}

describe("CS-1 · 页面类型推断（detectPageType）", () => {
  it("回归样本：真实站点定义（learnflakes/anirena 无 list 声明）", async () => {
    const { siteMetadata: learnflakesMetadata } = await import("@ptd/site/definitions/learnflakes.ts");
    const { siteMetadata: anirenaMetadata } = await import("@ptd/site/definitions/anirena.ts");

    // 这两个定义是 10-09 审查里 CS-1 的具体样本：都没有 metadata.list
    expect(learnflakesMetadata.list).toBeUndefined();
    expect(anirenaMetadata.list).toBeUndefined();

    // learnflakes：search url 是 "/"，detail 只有 urlPattern —— 详情页必须优先判为 detail
    expect(
      detectPageType(learnflakesMetadata as any, "https://learnflakes.net/?p=torrents&pid=10&action=details&tid=42"),
    ).toBe("detail");
    expect(
      detectPageType(
        learnflakesMetadata as any,
        "https://learnflakes.net/?p=torrents&pid=10&search_type=name&keywords=x",
      ),
    ).toBe("list");

    // anirena：search url 也是 "/"，无 detail 声明 —— 根路径（含查询）判 list，其它页面不再被判 list
    expect(detectPageType(anirenaMetadata as any, "https://anirena.com/?q=naruto")).toBe("list");
    expect(detectPageType(anirenaMetadata as any, "https://anirena.com/torrent/123")).toBe("unknown");
  });

  it("无 list 声明时 detail 优先于推断 list：learnflakes 详情页不再被判成列表页", () => {
    const metadata = makeMetadata({
      search: { requestConfig: { url: "/" }, keywordPath: "params.keywords" },
      detail: { urlPattern: ["/\\?p=torrents&pid=10&action=details&tid="] },
    });

    expect(detectPageType(metadata, "https://learnflakes.net/?p=torrents&pid=10&action=details&tid=42")).toBe("detail");
    // 列表页（同一个 pathname `"/"`，只靠 detail 模式区分）仍然判为 list
    expect(detectPageType(metadata, "https://learnflakes.net/?p=torrents&pid=10&search_type=name&keywords=x")).toBe(
      "list",
    );
    expect(detectPageType(metadata, "https://learnflakes.net/")).toBe("list");
  });

  it("搜索 URL 是路径而不是正则：`/` 不再匹配任意页面（anirena 形态）", () => {
    const metadata = makeMetadata({ search: { requestConfig: { url: "/" } } });

    expect(detectPageType(metadata, "https://anirena.com/?q=naruto")).toBe("list");
    expect(detectPageType(metadata, "https://anirena.com/")).toBe("list");
    // 旧实现对 `"/"` 会命中所有页面；修复后详情/其它页面不再被误判为列表页
    expect(detectPageType(metadata, "https://anirena.com/torrent/123")).toBe("unknown");
  });

  it("`/torrents.php` 这类带元字符的路径按字面量比较：只命中真正的列表页", () => {
    const metadata = makeMetadata({ search: { requestConfig: { url: "/torrents.php" } } });

    expect(detectPageType(metadata, "https://pt.example.com/torrents.php?search=a.b")).toBe("list");
    expect(detectPageType(metadata, "https://pt.example.com/torrentsXphp?search=a")).toBe("unknown");
    expect(detectPageType(metadata, "https://pt.example.com/userdetails.php?id=1")).toBe("unknown");
  });

  it("显式 list 声明仍按 urlPattern 判定（list 优先），excludeUrlPattern 生效", () => {
    const metadata = makeMetadata({
      list: [{ urlPattern: ["/torrents"] }, { urlPattern: ["/browse"], excludeUrlPattern: ["/browse/detail"] }],
      detail: { urlPattern: ["/browse/detail"] },
    });

    expect(detectPageType(metadata, "https://pt.example.com/torrents?page=2")).toBe("list");
    expect(detectPageType(metadata, "https://pt.example.com/browse")).toBe("list");
    expect(detectPageType(metadata, "https://pt.example.com/browse/detail/1")).toBe("detail");
    expect(detectPageType(metadata, "https://pt.example.com/other")).toBe("unknown");
  });

  it("L7：无 list 声明的目录型路径（/browse）第 2 页仍判为列表页", () => {
    const metadata = makeMetadata({ search: { requestConfig: { url: "/browse" } } });

    expect(detectPageType(metadata, "https://pt.example.com/browse")).toBe("list");
    // 分页形态为路径段：第 2 页起不得再判成 unknown（旧实现只对「以 / 结尾」的模式的子路径生效）
    expect(detectPageType(metadata, "https://pt.example.com/browse/2")).toBe("list");
    expect(detectPageType(metadata, "https://pt.example.com/browse/page-3")).toBe("list");
    // 非前缀路径不得误判
    expect(detectPageType(metadata, "https://pt.example.com/torrent/2")).toBe("unknown");

    const rootMetadata = makeMetadata({ search: { requestConfig: { url: "/" } } });
    // 根路径仍只匹配首页，不做目录前缀推断
    expect(detectPageType(rootMetadata, "https://pt.example.com/")).toBe("list");
    expect(detectPageType(rootMetadata, "https://pt.example.com/torrent/2")).toBe("unknown");
  });

  it("声明了 list 但没有 urlPattern 的站点不做推断（audiobookbay 语义不变）", () => {
    const metadata = makeMetadata({
      list: [{ excludeUrlPattern: ["/abss/"] }],
      search: { requestConfig: { url: "/" } },
      detail: { urlPattern: ["/abss/"] },
    });

    expect(detectPageType(metadata, "https://pt.example.com/")).toBe("unknown");
    expect(detectPageType(metadata, "https://pt.example.com/abss/123")).toBe("detail");
  });

  it("K：RegExp 模式缺少 i 时补上（兼容旧实现强制 i 的语义），其它 flags 保留", () => {
    // 旧实现 new RegExp(regexp, "i") 始终大小写不敏感；K 修复后仍保持该兼容性，
    // 但不再抹掉 m/s/u 等其它 flags。
    expect(
      detectPageType(makeMetadata({ detail: { urlPattern: [/\/Torrent\/\d+/] } }), "https://pt.example.com/Torrent/12"),
    ).toBe("detail");
    expect(
      detectPageType(makeMetadata({ detail: { urlPattern: [/\/Torrent\/\d+/] } }), "https://pt.example.com/torrent/12"),
    ).toBe("detail");

    // 站点/用户配置里的非法正则不能让整块面板失效
    const invalid = makeMetadata({ list: [{ urlPattern: ["("] }], detail: { urlPattern: ["("] } });
    expect(() => detectPageType(invalid, "https://pt.example.com/anything")).not.toThrow();
    expect(detectPageType(invalid, "https://pt.example.com/anything")).toBe("unknown");
  });

  it("跨 host 的 API 地址与模板占位路径不参与页面路径推断", () => {
    const api = makeMetadata({ search: { requestConfig: { url: "https://api.other.tld/api/torrents" } } });
    expect(detectPageType(api, "https://pt.example.com/api/torrents")).toBe("unknown");

    const template = makeMetadata({ search: { requestConfig: { url: "/user/$id$" } } });
    expect(detectPageType(template, "https://pt.example.com/user/42")).toBe("unknown");
  });
});

describe("CS-2 · URL 订阅按悬浮菜单状态求值 + 站点实例复用", () => {
  const FAKE_SITE = {
    metadata: makeMetadata({
      list: [{ urlPattern: ["/torrents"] }],
      detail: { urlPattern: ["/torrent/\\d+"] },
    }),
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.getSite.mockReset();
    mocks.getSite.mockImplementation(async () => FAKE_SITE);
    mocks.siteUserConfig = {};
    siteInstance.value = undefined;
    pageType.value = "unknown";
  });

  it("重新求值时复用站点实例（不再重复动态 import / 读站点配置）", async () => {
    history.replaceState({}, "", "/torrents");
    await updatePageType({ siteId: SITE_ID });
    expect(pageType.value).toBe("list");

    history.pushState({}, "", "/torrent/42");
    await updatePageType({ siteId: SITE_ID });
    expect(pageType.value).toBe("detail");

    expect(mocks.getSite).toHaveBeenCalledTimes(1);
  });

  it("菜单收起时 URL 变化不求值；展开后再变化才求值（CS-2）", async () => {
    history.replaceState({}, "", "/torrents");
    let isActive = false;
    const stop = installPageTypeUrlWatcher({ siteId: SITE_ID }, { isActive: () => isActive });
    try {
      history.pushState({}, "", "/torrent/42");
      await flushAsync();
      expect(mocks.getSite, "菜单收起时不应创建站点实例").toHaveBeenCalledTimes(0);
      expect(pageType.value).toBe("unknown");

      // 用户展开菜单 → App.vue 用当前 URL 求值；此后 URL 再变化时订阅也应继续求值
      isActive = true;
      await updatePageType({ siteId: SITE_ID });
      expect(pageType.value).toBe("detail");

      history.pushState({}, "", "/torrents");
      await flushAsync();
      expect(pageType.value).toBe("list");
      expect(mocks.getSite).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it("L4：同一站点在 options 侧修改配置后，复用实例失效并按新配置重建", async () => {
    mocks.siteUserConfig = { url: "https://pt.example.com/" };
    history.replaceState({}, "", "/torrents");
    await updatePageType({ siteId: SITE_ID });
    expect(pageType.value).toBe("list");
    expect(mocks.getSite).toHaveBeenCalledTimes(1);

    // 配置未变化：继续复用，不再重建
    await updatePageType({ siteId: SITE_ID });
    expect(mocks.getSite).toHaveBeenCalledTimes(1);

    // options 侧改了站点配置（URL / merge / 搜索入口）：必须重建，避免一直用旧配置
    mocks.siteUserConfig = { url: "https://new.example.com/", merge: { name: "新名字" } };
    await updatePageType({ siteId: SITE_ID });
    expect(mocks.getSite).toHaveBeenCalledTimes(2);
    expect(mocks.getSite.mock.calls.at(-1)?.[1]).toEqual({
      url: "https://new.example.com/",
      merge: { name: "新名字" },
    });
  });

  it("站点实例创建失败时 updatePageType 明确 reject（由调用方提示），pageType 保持 unknown", async () => {
    mocks.getSite.mockRejectedValue(new Error("definition not found"));
    history.replaceState({}, "", "/torrents");

    await expect(updatePageType({ siteId: "missing" })).rejects.toThrow();
    expect(pageType.value).toBe("unknown");
    expect(siteInstance.value).toBeUndefined();
  });
});

describe("Info 7 · getIDFromURL", () => {
  it("前一个 id 参数为空时继续尝试后续参数", () => {
    expect(getIDFromURL(URL.parse("https://pt.example.com/dl?id=&tid=5"))).toBe("5");
  });

  it("回落到 pathname 中的数字；解析不到时返回空串", () => {
    expect(getIDFromURL(URL.parse("https://pt.example.com/torrent/42/"))).toBe("42");
    expect(getIDFromURL(URL.parse("https://pt.example.com/browse"))).toBe("");
    expect(getIDFromURL(null)).toBe("");
  });
});

describe("B2-6 · 相对/畸形链接按站点基址解析后再校验 host", () => {
  const trusted = ["pt.example.com"];
  const base = "https://pt.example.com/";

  it("正常相对链接按站点基址解析后放行", () => {
    expect(isTrustedTorrentLink("download.php?id=1", trusted, base)).toBe(true);
    expect(isTrustedTorrentLink("/dl/1", trusted, base)).toBe(true);
  });

  it("没有站点基址时无法判断相对链接的落点，保守拒绝", () => {
    expect(isTrustedTorrentLink("download.php?id=1", trusted)).toBe(false);
  });

  it("URL.parse 解析失败的畸形串不得绕过 host 校验（会解析到异站）", () => {
    for (const link of ["///evil.tld/x", "/\\evil.tld/x", "\\\\evil.tld/x"]) {
      expect(isTrustedTorrentLink(link, trusted, base), link).toBe(false);
    }
  });
});
