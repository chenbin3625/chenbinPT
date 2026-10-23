import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

const makeDoc = (html: string) => {
  const doc = document.implementation.createHTMLDocument("tracker");
  doc.title = "tracker";
  doc.body.innerHTML = html;
  return doc;
};

afterEach(() => vi.restoreAllMocks());

describe("fappaizuri 用户信息软错误页", () => {
  it("HTTP 200 且有标题但零字段时失败，正常资料仍成功", async () => {
    const { default: Fappaizuri, siteMetadata } = await import("@ptd/site/definitions/fappaizuri.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");
    const site = new Fappaizuri(siteMetadata);
    const request = vi
      .spyOn(site, "request")
      .mockResolvedValue({ data: makeDoc("<p>Temporarily unavailable</p>") } as any);

    const failed = await site.getUserInfoResult({});
    expect(failed.status).toBe(EResultParseStatus.parseError);
    expect(failed.uploaded).toBeUndefined();

    request.mockResolvedValue({
      data: makeDoc("<table><tr><td class='prof-lbl'>Username:</td><td>Alice</td></tr></table>"),
    } as any);
    const valid = await site.getUserInfoResult({});
    expect(valid.status).toBe(EResultParseStatus.success);
    expect(valid.name).toBe("Alice");
  });
});

describe("broadcasthenet IMDB 搜索", () => {
  it("离线、禁用站点搜索及禁用入口均跳过，不发请求", async () => {
    const { default: BroadcastTheNet, siteMetadata } = await import("@ptd/site/definitions/broadcasthenet.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");
    for (const [config, entry, statusMsg] of [
      [{ isOffline: true }, {}, "i18n.siteNotEnabled"],
      [{ allowSearch: false }, {}, "i18n.siteNotEnabled"],
      [{}, { enabled: false }, "i18n.searchEntityNotEnabled"],
    ] as const) {
      const site = new BroadcastTheNet(siteMetadata, config);
      const request = vi.spyOn(site, "request");
      const result = await site.getSearchResult("imdb|tt1234567", entry);
      expect(result.status).toBe(EResultParseStatus.passParse);
      expect(result.statusMsg).toBe(statusMsg);
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("具名入口和 IMDB 高级搜索的禁用规则与父类一致", async () => {
    const { default: BroadcastTheNet, siteMetadata } = await import("@ptd/site/definitions/broadcasthenet.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");
    const site = new BroadcastTheNet({
      ...siteMetadata,
      searchEntry: {
        disabled: { enabled: false },
        imdbDisabled: { advanceKeywordParams: { imdb: { enabled: false } } },
      },
    });
    const request = vi.spyOn(site, "request");

    const disabled = await site.getSearchResult("imdb|tt1234567", { id: "disabled" });
    expect(disabled).toMatchObject({
      status: EResultParseStatus.passParse,
      statusMsg: "i18n.searchEntityNotEnabled",
    });
    const imdbDisabled = await site.getSearchResult("imdb|tt1234567", { id: "imdbDisabled" });
    expect(imdbDisabled).toMatchObject({
      status: EResultParseStatus.passParse,
      statusMsg: "i18n.noAdvanceParams",
    });
    expect(request).not.toHaveBeenCalled();

    request.mockResolvedValue({
      data: makeDoc(""),
      request: { responseURL: "https://broadcasthe.net/torrents.php?imdb=tt1234567" },
    } as any);
    const enabled = await site.getSearchResult("imdb|tt1234567", { id: "disabled", enabled: true });
    expect(enabled.status).toBe(EResultParseStatus.noResults);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("未重定向才是无结果；请求异常和系列页解析异常不冒充无结果", async () => {
    const { default: BroadcastTheNet, siteMetadata } = await import("@ptd/site/definitions/broadcasthenet.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");
    const site = new BroadcastTheNet(siteMetadata);
    const request = vi.spyOn(site, "request").mockResolvedValue({
      data: makeDoc(""),
      request: { responseURL: "https://broadcasthe.net/torrents.php?imdb=tt1234567" },
    } as any);
    expect((await site.getSearchResult("imdb|tt1234567")).status).toBe(EResultParseStatus.noResults);

    request.mockRejectedValue(new Error("service unavailable"));
    const failed = await site.getSearchResult("imdb|tt1234567");
    expect(failed.status).not.toBe(EResultParseStatus.noResults);
    expect(failed.statusMsg).toContain("service unavailable");

    request.mockResolvedValue({
      data: makeDoc("<h2>Series</h2>"),
      request: { responseURL: "https://broadcasthe.net/series.php?id=42" },
    } as any);
    vi.spyOn(site as any, "parseSeriesPageTorrents").mockImplementation(() => {
      throw new Error("bad series page");
    });
    expect((await site.getSearchResult("imdb|tt1234567")).status).toBe(EResultParseStatus.parseError);
  });
});

describe("pussytorrents 用户列表初始化", () => {
  it("资料页取得 numericId 后，两个统计 POST 各自先执行同 userID 的 GET", async () => {
    const { default: PussyTorrents, siteMetadata } = await import("@ptd/site/definitions/pussytorrents.ts");
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");
    const site = new PussyTorrents(siteMetadata);
    const calls: Array<{ method: string; url: string; userID?: number }> = [];
    vi.spyOn(BittorrentSite.prototype, "request").mockImplementation(async (config) => {
      calls.push({
        method: config.method?.toUpperCase() ?? "GET",
        url: config.url!,
        userID: (config.method?.toUpperCase() === "POST" ? config.data : config.params)?.userID,
      });
      if (config.url === "/") {
        return {
          data: makeDoc("<div id='memberBar'><div class='span8'><a href='/profile/alice'>alice</a></div></div>"),
        } as any;
      }
      if (config.url?.startsWith("/profile/")) {
        return {
          data: makeDoc(
            "<div id='profile'><button><i class='icon-arrow-up'></i>1 GB</button>" +
              "<button><i class='icon-arrow-down'></i>2 GB</button></div>" +
              "<a href='#snatchlist' data-ajax='/user/account/snatchlist' data-userid='123'>list</a>",
          ),
        } as any;
      }
      if (config.method?.toUpperCase() === "POST") {
        return { data: config.url?.endsWith("snatchlist") ? { aaData: [] } : { iTotalRecords: 7 } } as any;
      }
      return { data: makeDoc("<p>initialized</p>") } as any;
    });

    const result = await site.getUserInfoResult({});
    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.uploads).toBe(7);
    expect(calls.slice(-4)).toEqual([
      { method: "GET", url: "/user/account/snatchlist", userID: 123 },
      { method: "POST", url: "/user/account/snatchlist", userID: 123 },
      { method: "GET", url: "/user/account/uploadedtorrents", userID: 123 },
      { method: "POST", url: "/user/account/uploadedtorrents", userID: 123 },
    ]);
  });

  it("初始化 GET 失败只记 warn，仍继续发送统计 POST（可选握手，不阻断原请求）", async () => {
    const { default: PussyTorrents, siteMetadata } = await import("@ptd/site/definitions/pussytorrents.ts");
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    const site = new PussyTorrents(siteMetadata);
    const request = vi
      .spyOn(BittorrentSite.prototype, "request")
      .mockRejectedValueOnce(new Error("init failed"))
      .mockResolvedValueOnce({ data: { iTotalRecords: 7 } } as any);

    const result = await site.request({
      url: "/user/account/snatchlist",
      method: "POST",
      data: { userID: 123 },
    });

    expect((result as any).data.iTotalRecords).toBe(7);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toMatchObject({
      url: "/user/account/snatchlist",
      responseType: "document",
      params: { userID: 123 },
    });
    expect(request.mock.calls[1][0]).toMatchObject({
      url: "/user/account/snatchlist",
      method: "POST",
      data: { userID: 123 },
    });
  });
});

describe("zhixing 用户列表分页（L-34 / L-35：可选统计失败只 warn，不改 status）", () => {
  /**
   * 2026-10-23 跨范围变更：`src/packages/site/definitions/zhixing.ts` 由定义修复者改成
   * 「分页上限 50 + 连续两页首行相同即停 + 缺表/解析失败抛错」，并把做种/发布列表失败降级为
   * **只 warn、不改 status**（L-35，与 NexusPHP/Gazelle 对可选步骤的处理同构）。
   * 本文件原先断言「失败即 parseError」，属于被替换掉的旧语义，这里同步改成新语义：
   * status 保持 success，但**不写任何部分统计**（seeding / seedingSize / uploads 均为 undefined）。
   */
  // fixture 约定：tbody 里**只有数据行**（每页 ≥2 行）。原因见下 ——
  // 新的 L-34 实现用 `tbody > tr` 的数量判断「空表」（`<= 1` 即结束）并比较
  // `tbody > tr` 的第一行做去重，这两条都默认 tbody 里没有表头行；
  // 若真实页面 tbody 首行是表头，分页会在第二页被去重条件提前终止（已在 fix report 里报给 DEF 组确认）。
  const torrentTable = (rows: string[]) =>
    `<table class='torrenttable'><tbody>${rows.map((row) => `<tr><td>${row}</td></tr>`).join("")}</tbody></table>`;

  it("第二页解析失败时不写部分统计，只记 warn", async () => {
    const { default: Zhixing, siteMetadata } = await import("@ptd/site/definitions/zhixing.ts");
    const { default: PrivateSite } = await import("@ptd/site/schemas/AbstractPrivateSite.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");
    const { logMessage } = await import("@ptd/site/utils/adapter.ts");

    vi.spyOn(PrivateSite.prototype, "getUserInfoResult").mockResolvedValue({
      id: "12",
      site: "zhixing",
      status: EResultParseStatus.success,
      updateAt: Date.now(),
    } as any);

    const site = new Zhixing(siteMetadata);
    vi.spyOn(site, "request")
      // 两页的首行不同，否则 L-34 的「连续两页相同即停」会先终止，测不到解析失败分支
      .mockResolvedValueOnce({ data: torrentTable(["torrent-1a", "torrent-1b"]) } as any)
      .mockResolvedValueOnce({ data: torrentTable(["torrent-2a", "torrent-2b"]) } as any);
    vi.spyOn(site, "transformSearchPage")
      .mockResolvedValueOnce([{ size: 1024 }] as any)
      .mockRejectedValueOnce(new Error("page 2 parse failed"));

    const result = await site.getUserInfoResult({});

    // L-35：可选步骤失败不把整条记录标成失败
    expect(result.status).toBe(EResultParseStatus.success);
    // 但绝不写入部分统计（做种页成功、发布页未跑，任何一项都不能落库）
    expect(result.seeding).toBeUndefined();
    expect(result.seedingSize).toBeUndefined();
    expect(result.uploads).toBeUndefined();
    expect(vi.mocked(logMessage)).toHaveBeenCalledWith(
      expect.stringContaining("parseUserInfoForUserTorrent"),
      expect.objectContaining({ site: "zhixing" }),
      "warn",
    );
  });

  it("做种分页完成但上传页失败时也不写做种统计", async () => {
    const { default: Zhixing, siteMetadata } = await import("@ptd/site/definitions/zhixing.ts");
    const { default: PrivateSite } = await import("@ptd/site/schemas/AbstractPrivateSite.ts");
    const { EResultParseStatus } = await import("@ptd/site/types.ts");
    const { logMessage } = await import("@ptd/site/utils/adapter.ts");

    vi.spyOn(PrivateSite.prototype, "getUserInfoResult").mockResolvedValue({
      id: "12",
      site: "zhixing",
      status: EResultParseStatus.success,
      updateAt: Date.now(),
    } as any);

    const site = new Zhixing(siteMetadata);
    vi.spyOn(site, "request")
      .mockResolvedValueOnce({ data: torrentTable(["torrent-1a", "torrent-1b"]) } as any) // 做种第 1 页
      .mockResolvedValueOnce({ data: torrentTable(["torrent-2a", "torrent-2b"]) } as any) // 做种第 2 页
      .mockResolvedValueOnce({ data: torrentTable([]) } as any) // 做种第 3 页：空表 → 结束
      .mockResolvedValueOnce({ data: "<p>error page</p>" } as any); // 发布列表：缺表 → 抛错
    vi.spyOn(site, "transformSearchPage").mockResolvedValue([{ size: 1024 }] as any);

    const result = await site.getUserInfoResult({});

    expect(result.status).toBe(EResultParseStatus.success);
    expect(result.seeding).toBeUndefined();
    expect(result.seedingSize).toBeUndefined();
    expect(result.uploads).toBeUndefined();
    expect(vi.mocked(logMessage)).toHaveBeenCalledWith(
      expect.stringContaining("parseUserInfoForUserTorrent"),
      expect.objectContaining({ site: "zhixing" }),
      "warn",
    );
  });

  it("真正空表结束分页并保留已解析统计", async () => {
    const { default: Zhixing, siteMetadata } = await import("@ptd/site/definitions/zhixing.ts");
    const site = new Zhixing(siteMetadata);
    const request = vi
      .spyOn(site, "request")
      .mockResolvedValueOnce({ data: torrentTable(["torrent-1a", "torrent-1b"]) } as any);
    request.mockResolvedValue({ data: torrentTable([]) } as any);
    vi.spyOn(site, "transformSearchPage").mockResolvedValue([{ size: 1024 }] as any);

    const stats = await (site as any).parseUserInfoForUserTorrent("seeding", "12");
    expect(stats).toEqual({ count: 1, size: 1024 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("站点对越界页码回落最后一页时不会无限分页（L-34）", async () => {
    const { default: Zhixing, siteMetadata } = await import("@ptd/site/definitions/zhixing.ts");
    const site = new Zhixing(siteMetadata);
    // 任何页码都返回同一页内容：旧实现会一直循环，新实现按「连续两页首行相同」停止
    const request = vi
      .spyOn(site, "request")
      .mockResolvedValue({ data: torrentTable(["torrent-1a", "torrent-1b"]) } as any);
    vi.spyOn(site, "transformSearchPage").mockResolvedValue([{ size: 1024 }] as any);

    const stats = await (site as any).parseUserInfoForUserTorrent("seeding", "12");
    expect(stats).toEqual({ count: 1, size: 1024 });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("搜索词编码及进度类型", () => {
  it("hdtorrents 编码空格、&、括号，仍将句点转空格", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdtorrents.ts");
    const config = { url: "/torrents.php", params: { keywords: "A.B & (C)" } };
    const result = siteMetadata.search!.requestConfigTransformer!({
      keywords: "A.B & (C)",
      requestConfig: config,
      searchEntry: siteMetadata.search!,
    });
    expect(result.url).toContain("search=A%20B%20%26%20%28C%29");
    expect(result.params?.keywords).toBeUndefined();
  });

  it("pussytorrents 编码特殊字符，保留原有前缀处理", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/pussytorrents.ts");
    const config = { url: "/torrents/browse", params: { keywords: "-A & 中" } };
    const result = siteMetadata.search!.requestConfigTransformer!({
      keywords: "-A & 中",
      requestConfig: config,
      searchEntry: siteMetadata.search!,
    });
    expect(result.url).toBe("/torrents/browse?query=A%20%26%20%E4%B8%AD");
    expect(result.params?.keywords).toBeUndefined();
  });

  it("aidoruonline 未知进度返回 null，已完成返回数值 100", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/aidoruonline.ts");
    const progress = (siteMetadata.search!.selectors!.progress as any).elementProcess;
    expect(progress(null)).toBeNull();
    expect(
      progress(makeDoc("<table><tr><td class='ttable_seeding'><font color='#ff0000'>1</font></td></tr></table>")),
    ).toBeNull();
    expect(
      progress(makeDoc("<table><tr><td class='ttable_seeding'><font color='green'>1</font></td></tr></table>")),
    ).toBe(100);
  });
});
