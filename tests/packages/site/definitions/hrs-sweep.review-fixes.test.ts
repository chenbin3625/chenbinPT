/**
 * hrs-sweep 修复回归：DEFS2-2 收尾（恒真 `selector: "*"` 的 H&R 标签）。
 *
 * 统一判据（第四波裁决）：H&R 标签「有 / 无」不按选择器形状判，而按**站点是否全站 H&R** 判。
 * 名单取上游 fb79a2a7「feat: add default H&R tags with red color for global sites」(PR #336) 明确列出的
 * 全站 H&R 站点：asiancinema / beyondhd / blutopia / broadcasthenet / huno / torrentleech ——
 * 这些站点的规则要求所有下载都必须做种，恒真标签正是「所有结果行都带 H&R」的刻意表达
 * （与 torrenting.ts 的既有约定一致）；第三波 hrs-sweep 误删了其中 3 站，本波已恢复。
 * 名单外的站点（aither / cinematik / lst / luminarr / oldtoonsworld / onlyencodes / opencd 等）不得出现 H&R 伪标签。
 *
 * 只做选择器 / 行解析层面的行为断言，不发网络请求：
 * - 名单外站点：tags 里没有 `selector: "*"`、也没有 H&R，普通结果行经真实的
 *   `parseTorrentRowForTags` 不再被打上 H&R；
 * - 全站 H&R 站点：tags 里必须有恒真 H&R，普通行也应得到 H&R（刻意的全站语义）；
 * - broadcasthenet 的 DEFS1-2 不被回退：展开后的 Gazelle 共享 tags 仍能解析出 Free，
 *   imdb/series 页也不再给每行硬写 H&R。
 */
import { describe, expect, it, vi } from "vitest";

// 站点定义会连带引入 @ptd/site 的运行时依赖（messages.ts 用到 __BROWSER__ 与 chrome API），
// 这里给出最小桩（与 definitionFixes.test.ts 一致），避免为纯配置断言去跑整个扩展环境。
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

type TTagConfig = { name: string; selector?: string };

/** 上游 fb79a2a7 / PR #336 明示的全站 H&R 站点名单（6 站）：全站 H&R 义务 → H&R 标签刻意覆盖所有行 */
// DOM 行的站：在 search.selectors.tags 里用恒真 selector:"*" 表达「每行都有 H&R」
const domGlobalHrSites = ["asiancinema", "blutopia", "broadcasthenet"];
// JSON 行的站（接口返回普通对象）：类内对每行无条件补 H&R——"*" 对对象行不生效（get(row, "*") 恒为 undefined）
const jsonGlobalHrSites = ["beyondhd", "torrentleech", "huno"];
const globalHrSites = new Set<string>([...domGlobalHrSites, ...jsonGlobalHrSites]);

const sweptSites: Array<[string, () => Promise<any>]> = [
  ["aither", () => import("@ptd/site/definitions/aither.ts")],
  ["asiancinema", () => import("@ptd/site/definitions/asiancinema.ts")],
  ["blutopia", () => import("@ptd/site/definitions/blutopia.ts")],
  ["broadcasthenet", () => import("@ptd/site/definitions/broadcasthenet.ts")],
  ["cinematik", () => import("@ptd/site/definitions/cinematik.ts")],
];

/** 名单内走 JSON 行（普通对象）的站点：断言其类方法对每一行无条件补 H&R */
const jsonRowGlobalHrSites: Array<[string, () => Promise<any>]> = [
  ["beyondhd", () => import("@ptd/site/definitions/beyondhd.ts")],
  ["torrentleech", () => import("@ptd/site/definitions/torrentleech.ts")],
  ["huno", () => import("@ptd/site/definitions/huno.ts")],
];

const getTags = (siteMetadata: any): TTagConfig[] => siteMetadata.search!.selectors.tags as TTagConfig[];

/** 用站点自己的类（没有 default class 时回落引擎类，与 site/index.ts 的实例化顺序一致）解析一行 */
const rowTags = async (mod: any, siteMetadata: any, html: string) => {
  const { default: Unit3D } = await import("@ptd/site/schemas/Unit3D.ts");
  const SiteClass = mod.default ?? Unit3D;
  const site: any = new SiteClass(siteMetadata);
  const row = document.createElement("tr");
  row.innerHTML = html;
  document.body.appendChild(row);
  try {
    const torrent = site.parseTorrentRowForTags({}, row, {
      searchEntry: { selectors: siteMetadata.search!.selectors },
      requestConfig: { url: "https://example.com/" },
    });
    return (torrent.tags ?? []).map((tag: { name: string }) => tag.name);
  } finally {
    document.body.innerHTML = "";
  }
};

describe("DEFS2-2 收尾：H&R 标签按「是否全站 H&R」判定有/无", () => {
  it.each(sweptSites)("%s 的 tags 与全站 H&R 名单一致", async (name, load) => {
    const { siteMetadata } = await load();
    const tags = getTags(siteMetadata);

    expect(Array.isArray(tags)).toBe(true);
    if (globalHrSites.has(name)) {
      // 全站 H&R：恒真选择器是刻意的「所有结果行都带 H&R」表达（与 torrenting.ts 同一约定）
      expect(tags.some((tag) => tag.name === "H&R" && tag.selector === "*")).toBe(true);
    } else {
      // 名单外站点：任何标签都不允许用通配选择器（对任意行恒真），也不允许 H&R 伪标签
      expect(tags.every((tag) => tag.selector !== "*")).toBe(true);
      expect(tags.some((tag) => tag.name === "H&R")).toBe(false);
    }
  });

  it.each(sweptSites)("%s 的普通结果行按名单得到 H&R / 空数组", async (name, load) => {
    const mod = await load();
    const tags = getTags(mod.siteMetadata);

    // 全站 H&R 站点下 "*" 有意命中每一行；名单外站点旧实现会得到 ["H&R"]，新实现应为空数组
    expect(await rowTags(mod, mod.siteMetadata, "<td><a href='/details'>x</a></td>")).toEqual(
      globalHrSites.has(name) ? ["H&R"] : [],
    );
    expect(tags.some((tag) => tag.name === "H&R")).toBe(globalHrSites.has(name));
  });

  it("#336 全站 H&R 名单（DOM 3 + JSON 3）不重不漏，且 alpharatio 不在名单内", () => {
    expect([...globalHrSites].sort()).toEqual(
      ["asiancinema", "beyondhd", "blutopia", "broadcasthenet", "huno", "torrentleech"].sort(),
    );
    expect(new Set([...domGlobalHrSites, ...jsonGlobalHrSites]).size).toBe(globalHrSites.size);
    // alpharatio 有逐行 H&R 但不在 #336 名单内 → 按 DEFS2-2 删除（见下方用例）
    expect(globalHrSites.has("alpharatio")).toBe(false);
  });
});

describe("DEFS1-2 不回退：broadcasthenet 仍能解析 Gazelle 共享的 Free 标签", () => {
  it("带 Freeleech! 的行得到 Free，并按全站 H&R 身份附带 H&R", async () => {
    const mod = await import("@ptd/site/definitions/broadcasthenet.ts");
    const tags = getTags(mod.siteMetadata);

    expect(tags.some((tag) => tag.name === "Free" && tag.selector!.includes("Freeleech!"))).toBe(true);
    // broadcasthenet 在 fb79a2a7 的全站 H&R 名单内（见文件头判据），恒真 H&R 属刻意设计
    expect(tags.some((tag) => tag.name === "H&R" && tag.selector === "*")).toBe(true);

    // happy-dom 下 matchesSelector 只对已挂到文档上的元素生效
    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    const row = document.createElement("tr");
    row.innerHTML = "<td><strong>Freeleech!</strong></td>";
    tbody.appendChild(row);
    table.appendChild(tbody);
    document.body.appendChild(table);

    try {
      const site: any = new mod.default(mod.siteMetadata);
      const torrent = site.parseTorrentRowForTags({}, row, {
        searchEntry: { selectors: mod.siteMetadata.search!.selectors },
        requestConfig: { url: "https://broadcasthe.net/" },
      });
      expect((torrent.tags ?? []).map((tag: { name: string }) => tag.name)).toEqual(["Free", "H&R"]);
    } finally {
      document.body.innerHTML = "";
    }
  });

  it("imdb/series 页解析出的种子不再给每行硬写 H&R", async () => {
    const mod = await import("@ptd/site/definitions/broadcasthenet.ts");
    const doc = new DOMParser().parseFromString(
      `<html><body><table class="torrent_table">
        <tr class="colhead_dark"><td><strong>Season 1</strong></td></tr>
        <tr class="group_torrent">
          <td><a href="/torrents.php?id=1&torrentid=11">Episode 1</a></td>
          <td><a href="/torrents.php?action=download&id=11&torrent_pass=x">DL</a></td>
          <td>1.5 GB</td><td>10</td><td>2</td><td>0</td>
        </tr>
      </table></body></html>`,
      "text/html",
    );

    const site: any = new mod.default(mod.siteMetadata);
    const torrents = site.parseSeriesPageTorrents(doc, "https://broadcasthe.net/series.php?id=1");

    expect(torrents).toHaveLength(1);
    expect((torrents[0].tags ?? []).some((tag: { name: string }) => tag.name === "H&R")).toBe(false);
  });
});

describe("torrenting 的全站 H&R 是有意设计（PLAN §2 保持不动）", () => {
  it('仍保留带站点规则注释的 H&R selector:"*"', async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/torrenting.ts");
    const tags = getTags(siteMetadata);

    // 站点 rules 规定下载后需做种 72 小时，即全站 H&R，这个 "*" 是刻意的
    expect(tags.some((tag) => tag.name === "H&R" && tag.selector === "*")).toBe(true);
  });
});

describe("DEFS2-2 收尾：名单内 JSON 行站点（beyondhd / torrentleech / huno）每行都带 H&R", () => {
  it.each(jsonRowGlobalHrSites)("%s 的普通 JSON 行被无条件贴上 H&R", async (_name, load) => {
    const mod = await load();
    const site: any = new mod.default(mod.siteMetadata);

    // 传普通对象行（非 Element）：这三站搜索均走 JSON 接口，行不是 DOM 节点，
    // 引擎对对象行走 get(row, selector)，故恒真 H&R 只能在类方法里无条件 push/addTag
    const torrent = site.parseTorrentRowForTags(
      {},
      {},
      {
        searchEntry: { selectors: mod.siteMetadata.search!.selectors },
        requestConfig: { url: "https://example.com/" },
      },
    );
    const names = (torrent.tags ?? []).map((tag: { name: string }) => tag.name);

    expect(names).toContain("H&R");
    // 这三站在配置层不再声明 tags（或声明的 tags 里没有 "*"）：对对象行恒不生效的选择器属死配置
    expect((getTags(mod.siteMetadata) ?? []).every((tag) => tag.selector !== "*")).toBe(true);
  });

  it("huno 的 H&R 同时带上真实判定的 Free（互不覆盖）", async () => {
    const mod = await import("@ptd/site/definitions/huno.ts");
    const site: any = new mod.default(mod.siteMetadata);

    const torrent = site.parseTorrentRowForTags(
      {},
      { name: "Some.Movie.2024.1080p", free: true },
      {
        searchEntry: { selectors: mod.siteMetadata.search!.selectors },
        requestConfig: { url: "https://hawke.uno/" },
      },
    );
    const names = (torrent.tags ?? []).map((tag: { name: string }) => tag.name);

    expect(names).toContain("Free");
    expect(names).toContain("H&R");
  });
});

describe("DEFS2-2 名单外：alpharatio 不再无条件贴 H&R", () => {
  it("Gazelle browse 行解析结果不含 H&R（接口无该字段）", async () => {
    const mod = await import("@ptd/site/definitions/alpharatio.ts");
    const site: any = new mod.default(mod.siteMetadata);
    // 避开网络：browse 转换内部会取 authkey/passkey
    vi.spyOn(site, "getAuthKey").mockResolvedValue({ authkey: "auth", passkey: "pass" });

    const torrent = await site.transformUnGroupTorrent({
      groupId: 1,
      groupName: "Some.Release.2024",
      tags: [],
      groupTime: "2024-03-01 00:00:00",
      torrentId: 11,
      fileCount: 1,
      size: 1024,
      snatches: 0,
      seeders: 3,
      leechers: 1,
      isFreeleech: true,
      isNeutralLeech: false,
      isPersonalFreeleech: false,
      canUseToken: true,
      hasSnatched: false,
      category: "Movie",
    });
    const names = (torrent.tags ?? []).map((tag: { name: string }) => tag.name);

    // 旧实现会给每一行 push H&R；torrentBrowseResult 无 H&R 字段，故按 DEFS2-2 删除
    expect(names).not.toContain("H&R");
    expect(names).toEqual(["Free"]);
  });
});
