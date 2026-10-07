/**
 * defs-3 包 5 条审查问题的行为回归（不发网络请求）。
 *
 * 断言对象是**真实站点定义 + 真实引擎/生成器**（不是「源码里存在某字符串」）：
 * - DEFS3-1 用真实的 `generateSiteSearchSolution` 断言生成的请求参数；
 * - DEFS3-2 用真实的 NexusPHP 引擎跑一次合成的 U2 搜索结果页；
 * - DEFS3-3 用真实的 `runQueryFilters`（含 parseTime → parseValidTimeStringInZone 改道）在
 *   TZ=Asia/Shanghai 与 TZ=UTC 下各跑一次；
 * - DEFS3-4 用真实的 `parseUserInfoForUploads` + 被 mock 的统一日志出口；
 * - DEFS3-5 用真实的 `parseTorrentRowForTags` 断言合成行不再被标成 H&R。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 站点模块会连带引入平台适配层（messages.ts 用到 __BROWSER__ 与 chrome API），
// 因此必须在 import 之前把全局桩准备好 —— vi.hoisted 的回调先于所有 import 执行。
vi.hoisted(() => {
  (globalThis as any).__BROWSER__ ??= "chrome";
  (globalThis as any).chrome ??= {
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    runtime: {
      id: "test",
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
      sendMessage: () => Promise.resolve(undefined),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    cookies: { get: () => Promise.resolve(null), set: () => Promise.resolve(), getAll: () => Promise.resolve([]) },
    downloads: { download: () => Promise.resolve(1) },
    tabs: { create: () => Promise.resolve(), query: () => Promise.resolve([]) },
  };
});

const mocks = vi.hoisted(() => ({
  category: undefined as unknown,
  logMessage: vi.fn(),
}));

// generateSiteSearchSolution 从 store 取站点分类；这里只喂 category，其余原样返回默认值。
vi.mock("@/options/stores/metadata.ts", () => ({
  useMetadataStore: () => ({
    getSiteMergedMetadata: async (_siteId: string, field: string, defaultValue: unknown) =>
      field === "category" ? mocks.category : defaultValue,
  }),
}));

// 统一日志出口换成 spy，既避免真实 sendMessage，也让 DEFS3-4 的断言可控。
vi.mock("@ptd/site/utils/adapter.ts", () => ({
  axios: { request: vi.fn() },
  isCloudflareBlocked: vi.fn(() => false),
  retrieve: vi.fn(async () => null),
  retrieveStore: vi.fn(async () => null),
  cookie: vi.fn(async () => null),
  sleep: vi.fn(async (_ms?: number) => {}),
  store: vi.fn(async () => {}),
  logMessage: mocks.logMessage,
}));

import { siteMetadata as torrentingMetadata } from "@ptd/site/definitions/torrenting.ts";
import { siteMetadata as u2Metadata } from "@ptd/site/definitions/u2.ts";
import { siteMetadata as tokyotoshoMetadata } from "@ptd/site/definitions/tokyotosho.ts";
import { siteMetadata as torrentleechMetadata } from "@ptd/site/definitions/torrentleech.ts";
import { siteMetadata as seedpoolMetadata } from "@ptd/site/definitions/seedpool.ts";
import { siteMetadata as uploadcxMetadata } from "@ptd/site/definitions/uploadcx.ts";
import { siteMetadata as tjuptMetadata } from "@ptd/site/definitions/tjupt.ts";
import { EResultParseStatus } from "@ptd/site/types.ts";
import { selectElements } from "@ptd/site/utils/selector.ts";

import {
  generateSiteSearchSolution,
  radioDefault,
  type TSelectCategory,
} from "@/options/views/Settings/SetSearchSolution/utils.ts";

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

// ---------------------------------------------------------------------------
// DEFS3-1：torrenting 的「仅免费种子」必须发出 free=on
// ---------------------------------------------------------------------------
describe("DEFS3-1：torrenting「仅免费种子」发出的参数（回归：原先发 on=1）", () => {
  beforeEach(() => {
    mocks.category = torrentingMetadata.category;
  });

  async function paramsForFree(value: unknown): Promise<Record<string, unknown>> {
    const selectCategory = { cat: radioDefault, free: value } as unknown as TSelectCategory;
    const solution = await generateSiteSearchSolution("torrenting", selectCategory);
    // searchEntries 是 Record<生成的id, entriesConfig>，取第一个值即可
    const entry = Object.values(solution.searchEntries ?? {})[0] as
      { requestConfig?: { params?: Record<string, unknown> } } | undefined;
    return entry?.requestConfig?.params ?? {};
  }

  it("勾选「免费」→ params.free === 'on'，且不再出现站点不认识的 on", async () => {
    const params = await paramsForFree(["on"]);
    expect(params).toEqual({ free: "on" });
    // 回归探针：旧实现（cross.mode=append + key:""）会生成 `on=1`
    expect(params).not.toHaveProperty("on");
  });

  it("未勾选时不生成任何参数（保持站点默认）", async () => {
    expect(await paramsForFree(radioDefault)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// DEFS3-2：u2 的 leechers 解析
// ---------------------------------------------------------------------------
describe("DEFS3-2：u2 leechers 有选择器且经真实引擎可解析", () => {
  const leechersQuery = u2Metadata.search!.selectors!.leechers as any;

  it("声明了选择器（原实现只有 elementProcess，取值完全依赖 NexusPHP 表头推断）", () => {
    const selectors = ([] as string[]).concat(leechersQuery.selector ?? []).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(0);
  });

  it("空单元格不抛 TypeError（原先的 firstChild! 非空断言会抛）", () => {
    const doc = makeDoc('<table><tr><td class="rowfollow"></td></tr></table>');
    const cell = doc.querySelector("td.rowfollow")!;
    expect(() => leechersQuery.elementProcess(cell)).not.toThrow();
    expect(leechersQuery.elementProcess(cell)).toBeUndefined();
  });

  it("真实引擎 getFieldData 按定义的选择器从 U2 行里取到 12（旧形状只能取到空串）", async () => {
    const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
    const doc = makeDoc(`
      <table class="torrents">
        <tbody>
        <tr>
          <td class="rowfollow">Movie</td>
          <td class="rowfollow">
            <table class="torrentname"><tr><td>
              <a class="tooltip" href="details.php?id=1&amp;hit=1">Some Anime</a>
              <a href="download.php?id=1"><img alt="download" src="pic/trans.gif"></a>
            </td></tr></table>
          </td>
          <td class="rowfollow">3</td>
          <td class="rowfollow">2024-01-01 00:00:00</td>
          <td class="rowfollow">1 GB</td>
          <td class="rowfollow">10</td>
          <td class="rowfollow"><b><a href="details.php?id=1#leechers">12</a></b></td>
          <td class="rowfollow">5</td>
        </tr>
        </tbody>
      </table>
    `);
    const row = doc.querySelector("tr")!;
    const site = new NexusPHP({ ...(u2Metadata as any) }, {});

    expect((site as any).getFieldData(row, leechersQuery, "leechers")).toBe(12);

    // 回归探针：旧的「只有 elementProcess、没有 selector」形状在引擎里会落到 `text ?? ""`，
    // elementProcess 永不执行 —— 这正是 DEFS3-2 的根因。
    expect((site as any).getFieldData(row, { elementProcess: leechersQuery.elementProcess }, "leechers")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// DEFS3-3：tokyotosho 的时间解析不得随宿主机时区漂移
// ---------------------------------------------------------------------------
describe("DEFS3-3：tokyotosho 的 `Date: ... UTC` 解析", () => {
  it("在 Asia/Shanghai 与 UTC 下都得到 10:41Z（原实现上海下会偏 +8h）", async () => {
    const { default: BittorrentSite } = await import("@ptd/site/schemas/AbstractBittorrentSite.ts");
    // index.ts 给非 NexusPHP 站点的默认 timezoneOffset 就是 "+0000"
    const site = new BittorrentSite({ ...(tokyotoshoMetadata as any), timezoneOffset: "+0000" }, {});
    const filters = (tokyotoshoMetadata.search!.selectors!.time as any).filters;
    const cellText = "Date: 2024-03-10 10:41 UTC|Comment: hello";

    const expected = Date.UTC(2024, 2, 10, 10, 41);
    const previousTZ = process.env.TZ;
    let shanghai: unknown;
    let utc: unknown;
    try {
      process.env.TZ = "Asia/Shanghai";
      shanghai = (site as any).runQueryFilters(cellText, filters);
      process.env.TZ = "UTC";
      utc = (site as any).runQueryFilters(cellText, filters);
    } finally {
      process.env.TZ = previousTZ;
    }

    expect(shanghai).toBe(expected);
    expect(utc).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// DEFS3-4：torrentleech 上传列表抓取失败必须留痕
// ---------------------------------------------------------------------------
describe("DEFS3-4：torrentleech parseUserInfoForUploads 的失败不再静默", () => {
  beforeEach(() => {
    mocks.logMessage.mockReset();
  });

  async function runUploads(requestImpl: () => Promise<unknown>) {
    const { default: TorrentLeech } = await import("@ptd/site/definitions/torrentleech.ts");
    const site = new TorrentLeech({ ...(torrentleechMetadata as any) }, {});
    (site as any).request = vi.fn(requestImpl);
    const info = await (site as any).parseUserInfoForUploads({
      id: "1",
      status: EResultParseStatus.success,
    });
    return info;
  }

  it("请求抛错时记 warn 日志（site 标识 + 异常信息），且不把 uploads 伪造成 0", async () => {
    const info = await runUploads(() => Promise.reject(new Error("boom")));

    expect(info.uploads).toBeUndefined();
    expect(mocks.logMessage).toHaveBeenCalledTimes(1);
    const [msg, data, level] = mocks.logMessage.mock.calls[0];
    expect(String(msg)).toContain("parseUserInfoForUploads");
    expect(data.site).toBe("torrentleech");
    expect(data.error.message).toBe("boom");
    expect(level).toBe("warn");
  });

  it("接口 200 但响应没有 aaData（字段改名/返回登录页）时同样记 warn", async () => {
    const info = await runUploads(() => Promise.resolve({ data: { status: "success" } }));

    expect(info.uploads).toBeUndefined();
    expect(mocks.logMessage).toHaveBeenCalledTimes(1);
    const [msg, , level] = mocks.logMessage.mock.calls[0];
    expect(String(msg)).toContain("no aaData");
    expect(level).toBe("warn");
  });

  it("响应正常时取到 uploads 且不产生告警", async () => {
    const info = await runUploads(() =>
      Promise.resolve({ data: { iTotalRecords: 7, aaData: [["Movies", "name", "1 GB", "2", "3", "4"]] } }),
    );

    expect(info.uploads).toBe(7);
    expect(info.uploadsList).toHaveLength(1);
    expect(mocks.logMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DEFS3-5：seedpool / uploadcx / tjupt 不再用恒真的 "*" 伪造全站 H&R
// ---------------------------------------------------------------------------
describe("DEFS3-5：H&R 标签不再恒真", () => {
  for (const [name, metadata] of [
    ["seedpool", seedpoolMetadata],
    ["uploadcx", uploadcxMetadata],
    ["tjupt", tjuptMetadata],
  ] as const) {
    it(`${name}：tags 里没有任何 selector "*" 的恒真标签`, () => {
      const tags = (metadata.search!.selectors!.tags ?? []) as Array<{ name: string; selector?: string }>;
      expect(tags.length).toBeGreaterThan(0);
      expect(tags.some((tag) => tag.selector === "*")).toBe(false);
    });
  }

  for (const [name, metadata] of [
    ["seedpool", seedpoolMetadata],
    ["uploadcx", uploadcxMetadata],
  ] as const) {
    it(`${name}：合成结果行经真实 parseTorrentRowForTags 不再被打上 H&R（而 "*" 本会命中任何行）`, async () => {
      const tags = (metadata.search!.selectors!.tags ?? []) as Array<{ name: string; selector?: string }>;
      // Unit3D 搜索结果列表页没有 H&R 字段，也没有真实的 H&R 选择器可用 → 只能整条移除
      expect(tags.some((tag) => tag.name === "H&R")).toBe(false);

      const { default: Unit3D } = await import("@ptd/site/schemas/Unit3D.ts");
      const site = new Unit3D({ ...(metadata as any) }, {});
      const doc = makeDoc('<table><tbody><tr class="torrent-row"><td class="x">plain cell</td></tr></tbody></table>');
      const row = doc.querySelector("tr")!;

      // 这正是旧配置恒为真的原因：任何非空行都能被 "*" 选中
      expect(selectElements("*", row).length).toBeGreaterThan(0);

      const torrent = (site as any).parseTorrentRowForTags({}, row, {
        searchEntry: { selectors: metadata.search!.selectors },
      } as any);
      expect((torrent.tags ?? []).some((tag: { name: string }) => tag.name === "H&R")).toBe(false);
    });
  }

  it("tjupt：H&R 改用 NexusPHP 的真实徽标 img.hitandrun（只在该徽标出现时才命中）", async () => {
    const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");
    const site = new NexusPHP({ ...(tjuptMetadata as any) }, {});
    const selectors = tjuptMetadata.search!.selectors!;
    const tags = selectors.tags as Array<{ name: string; selector?: string }>;
    expect(tags.find((tag) => tag.name === "H&R")?.selector).toBe("img.hitandrun");

    const tagNamesFor = (rowHtml: string) => {
      const doc = makeDoc(`<table><tbody><tr>${rowHtml}</tr></tbody></table>`);
      const row = doc.querySelector("tr")!;
      const torrent = (site as any).parseTorrentRowForTags({}, row, {
        searchEntry: { selectors },
      } as any);
      return (torrent.tags ?? []).map((tag: { name: string }) => tag.name);
    };

    // 普通行（旧实现会无条件得到 H&R）
    expect(tagNamesFor('<td><span class="tag tag-exclusive">禁转</span></td>')).toEqual(["禁转"]);
    // 带 NexusPHP H&R 徽标的行才得到 H&R
    expect(tagNamesFor('<td><img class="hitandrun" src="pic/trans.gif" alt="H&amp;R"></td>')).toEqual(["H&R"]);
  });
});
