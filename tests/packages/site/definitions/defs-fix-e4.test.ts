/**
 * E4（definitions 第四批 56 个）修复的行为回归（不发网络请求）。
 *
 * 断言对象是**真实站点定义 + 真实引擎/生成器**（不是「源码里存在某个字符串」）：
 * - M1/L10 用定义里真实的 `requestConfig.params` 与 `advanceKeywordParams` 变换器断言父层 params 未被整体替换；
 * - M2 用真实的 `parseTorrentRowForTags`（JSON 行分支）断言不再有恒真 H&R 标签；
 * - M3/L4 用真实的 Milkie/MTEam 类断言 token 不进入 `torrent.link`、只进下载请求配置，且 `??=` 不覆盖调用方配置；
 * - L1 用真实的 `buildSearchSolutionFromCategories` 断言多选分类生成 `cat<id>=1`；
 * - L5 直接跑定义里的 category filters；L6/L7 跑真实的 `utils/level` 判级函数；
 * - L12 用真实的 top10 list 选择器的 `elementProcess` 断言坏 overlay 只丢标题、不抛异常。
 */
import { describe, expect, it, vi } from "vitest";

// 站点模块会连带引入平台适配层（用到 __BROWSER__ 与 chrome API），
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

// 统一请求出口换成可观测的桩：既避免真实网络，又能断言最终发给 axios 的配置。
const adapterMock = vi.hoisted(() => ({
  requests: [] as any[],
  logMessage: vi.fn(),
}));

vi.mock("@ptd/site/utils/adapter.ts", () => ({
  axios: {
    request: vi.fn(async (config: any) => {
      adapterMock.requests.push(config);
      return { data: {}, status: 200, statusText: "OK", headers: {}, config };
    }),
    getUri: (config: any) => `${config?.baseURL ?? ""}${config?.url ?? ""}`,
  },
  isCloudflareBlocked: vi.fn(() => false),
  retrieve: vi.fn(async () => null),
  retrieveStore: vi.fn(async () => null),
  cookie: vi.fn(async () => null),
  sleep: vi.fn(async (_ms?: number) => {}),
  store: vi.fn(async () => {}),
  logMessage: adapterMock.logMessage,
}));

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

// ---------------------------------------------------------------------------
// M1：kufirc 的 search.requestConfig.params 必须增量合并父层（Luminance 的 action=advanced）
// ---------------------------------------------------------------------------
describe("M1：kufirc 高级搜索参数（回归：params 整体替换丢掉 action=advanced）", () => {
  it("search.requestConfig.params 同时包含 action=advanced 与 perPage=100", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/kufirc.ts");
    expect(siteMetadata.search!.requestConfig!.params).toMatchObject({ action: "advanced", perPage: 100 });
  });

  it("Terms 关键词改写为 searchtext 后仍保留 action=advanced（旧实现只剩 title/perPage）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/kufirc.ts");
    const transformer = (siteMetadata.search!.advanceKeywordParams!.terms as any).requestConfigTransformer;

    const output = transformer({
      keywords: "legal porn",
      requestConfig: {
        url: "/torrents.php",
        params: { action: "advanced", perPage: 100, title: "legal porn" },
      },
    });

    expect(output.params).toMatchObject({ action: "advanced", perPage: 100, searchtext: "legal porn" });
    expect(output.params).not.toHaveProperty("title");
  });
});

// ---------------------------------------------------------------------------
// M2：myanonamouse 不再给每一行都打 H&R 标签（selector: "id" 恒真）
// ---------------------------------------------------------------------------
describe("M2：myanonamouse 行级 H&R 标签（回归：selector:'id' 对任何 JSON 行恒真）", () => {
  async function makeProbe() {
    const { siteMetadata, default: MamSite } = await import("@ptd/site/definitions/myanonamouse.ts");
    class Probe extends MamSite {
      tagsOf(row: object) {
        const searchConfig = {
          searchEntry: { selectors: siteMetadata.search!.selectors },
          requestConfig: {},
        } as any;
        return (this as any).parseTorrentRowForTags({}, row, searchConfig) as { tags?: Array<{ name: string }> };
      }
    }
    return { probe: new Probe(siteMetadata), siteMetadata };
  }

  it("只有 id 的行不再被标成 H&R（旧实现 100% 命中）", async () => {
    const { probe } = await makeProbe();
    expect(probe.tagsOf({ id: 123 }).tags).toEqual([]);
  });

  it("free 行只保留真实的 Free 标签", async () => {
    const { probe } = await makeProbe();
    expect(probe.tagsOf({ id: 123, free: true }).tags).toEqual([{ name: "Free", color: "blue" }]);
  });

  it("定义里没有任何 selector 是恒真的 '*' 或 'id'", async () => {
    const { siteMetadata } = await makeProbe();
    const tagSelectors = (siteMetadata.search!.selectors!.tags as any[]).map((tag) => tag.selector);
    expect(tagSelectors).not.toContain("*");
    expect(tagSelectors).not.toContain("id");
  });
});

// ---------------------------------------------------------------------------
// M3：milkie 的 API token 不再拼进 torrent.link，只出现在实际下载请求配置里
// ---------------------------------------------------------------------------
describe("M3：milkie 下载链接不含 token（回归：link 里拼 key=… 会随缓存/历史/导出扩散）", () => {
  const TOKEN = "milkie-test-token";

  async function makeSite() {
    const { siteMetadata, default: Milkie } = await import("@ptd/site/definitions/milkie.ts");
    class Probe extends Milkie {
      linkFor(torrent: any) {
        return (this as any).parseTorrentRowForLink(torrent);
      }
    }
    return { site: new Probe(siteMetadata, { url: "https://milkie.cc/", inputSetting: { token: TOKEN } } as any) };
  }

  it("torrent.link 是不带凭据的 API 路径", async () => {
    const { site } = await makeSite();
    const { link } = site.linkFor({ id: 42 });
    expect(link).toBe("/api/v1/torrents/42/torrent");
    expect(link).not.toContain(TOKEN);
    expect(link).not.toContain("key=");
  });

  it("token 只在 getTorrentDownloadRequestConfig 的 params 里", async () => {
    const { site } = await makeSite();
    const { link } = site.linkFor({ id: 42 });
    const config = await site.getTorrentDownloadRequestConfig({ id: 42, link } as any);
    expect(config.params).toMatchObject({ key: TOKEN });
    expect(String(config.url)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// L3：milkie 不再给所有账号硬编码 Early bird 等级；L4：responseType 只填默认值
// ---------------------------------------------------------------------------
describe("L3/L4：milkie 用户等级与 responseType", () => {
  async function makeSite() {
    const { siteMetadata, default: Milkie } = await import("@ptd/site/definitions/milkie.ts");
    return {
      site: new Milkie(siteMetadata, {
        url: "https://milkie.cc/",
        inputSetting: { token: "milkie-test-token" },
      } as any),
      siteMetadata,
    };
  }

  it("userInfo 不再声明常量 levelName（常量既不参与命中统计也与真实等级无关）", async () => {
    const { siteMetadata } = await makeSite();
    const authStep = siteMetadata.userInfo!.process!.find((step: any) => step.selectors?.name)!;
    expect(authStep.selectors!.levelName).toBeUndefined();
  });

  it("request() 不覆盖调用方显式声明的 responseType，并注入 x-milkie-auth", async () => {
    const { site } = await makeSite();
    adapterMock.requests.length = 0;
    await site.request({ url: "/api/v1/torrents", responseType: "document" }, false);
    const sent = adapterMock.requests.at(-1)!;
    expect(sent.responseType).toBe("document");
    expect(sent.headers["x-milkie-auth"]).toBe("milkie-test-token");
  });

  it("调用方没声明时仍回落 json（保持原有默认行为）", async () => {
    const { site } = await makeSite();
    adapterMock.requests.length = 0;
    await site.request({ url: "/api/v1/torrents" }, false);
    expect(adapterMock.requests.at(-1)!.responseType).toBe("json");
  });
});

// ---------------------------------------------------------------------------
// L4 同型：mteam 的 request() 也不覆盖调用方显式声明的 method/responseType
// ---------------------------------------------------------------------------
describe("L4：mteam request() 的 method/responseType 默认值", () => {
  it("显式声明 GET + document 时保持原样", async () => {
    const { siteMetadata, default: MTeam } = await import("@ptd/site/definitions/mteam.ts");
    const site = new MTeam(siteMetadata, { url: "https://kp.m-team.cc/" } as any);
    adapterMock.requests.length = 0;
    await site.request({ url: "/api/member/profile", method: "GET", responseType: "document" }, false);
    const sent = adapterMock.requests.at(-1)!;
    expect(sent.method).toBe("GET");
    expect(sent.responseType).toBe("document");
  });

  it("未声明时仍回落 POST + json", async () => {
    const { siteMetadata, default: MTeam } = await import("@ptd/site/definitions/mteam.ts");
    const site = new MTeam(siteMetadata, { url: "https://kp.m-team.cc/" } as any);
    adapterMock.requests.length = 0;
    await site.request({ url: "/api/member/profile" }, false);
    const sent = adapterMock.requests.at(-1)!;
    expect(sent.method).toBe("POST");
    expect(sent.responseType).toBe("json");
  });
});

// ---------------------------------------------------------------------------
// L1：march / novahd / muxuege 的多值分类组补上 cross（append）
// ---------------------------------------------------------------------------
describe("L1：NexusPHP 多值分类组缺 cross（回归：只能单选且发出 cat=401）", () => {
  /** buildSearchSolutionFromCategories 返回的是「搜索入口配置」，参数在 entry.requestConfig.params */
  async function paramsFor(category: any[], selected: Record<string, unknown>) {
    const { buildSearchSolutionFromCategories } = await import("@/options/utils/searchSolutionConfig.ts");
    const { requestConfig: entry } = buildSearchSolutionFromCategories(category as any, selected as any);
    return (entry.requestConfig?.params ?? {}) as Record<string, unknown>;
  }

  it("march 的 cat 多选生成 cat401=1 & cat402=1", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/march.ts");
    expect(await paramsFor(siteMetadata.category!, { cat: [401, 402] })).toEqual({ cat401: 1, cat402: 1 });
  });

  it("novahd 的 cat 多选生成 cat<id>=1", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/novahd.ts");
    expect(await paramsFor(siteMetadata.category!, { cat: [401, 410] })).toEqual({ cat401: 1, cat410: 1 });
  });

  it("muxuege 的 team 多选生成 team<id>=1", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/muxuege.ts");
    expect(await paramsFor(siteMetadata.category!, { team: [1, 2] })).toEqual({ team1: 1, team2: 1 });
  });

  it("三个分组都声明了 cross.mode = append（与同文件其它分组一致）", async () => {
    const [march, novahd, muxuege] = await Promise.all([
      import("@ptd/site/definitions/march.ts"),
      import("@ptd/site/definitions/novahd.ts"),
      import("@ptd/site/definitions/muxuege.ts"),
    ]);
    const group = (meta: any, key: string) => meta.siteMetadata.category.find((c: any) => c.key === key);
    expect(group(march, "cat").cross).toEqual({ mode: "append" });
    expect(group(novahd, "cat").cross).toEqual({ mode: "append" });
    expect(group(muxuege, "team").cross).toEqual({ mode: "append" });
  });
});

// ---------------------------------------------------------------------------
// L2：latteam 不再声明 +0800（拉美/西语站，中文模板残留）
// ---------------------------------------------------------------------------
describe("L2：latteam 时区声明", () => {
  it("回落到 Unit3D 默认 +0000，不再是 +0800", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/latteam.ts");
    expect(siteMetadata.timezoneOffset).toBe("+0000");
  });
});

// ---------------------------------------------------------------------------
// L5：luminarr / midnightscene / onlyencodes / milkie 的 category 未命中映射表时不再 undefined
// ---------------------------------------------------------------------------
describe("L5：分类 id 未命中映射表时的兜底（回归：category 变 undefined）", () => {
  const cases = [
    { name: "luminarr", id: "luminarr", known: [1, "Movies"], unknown: [99, 99] },
    { name: "midnightscene", id: "midnightscene", known: [3, "Music"], unknown: [99, 99] },
    { name: "onlyencodes", id: "onlyencodes", known: [1, "Movie"], unknown: [99, 99] },
  ] as const;

  for (const { name, id, known, unknown } of cases) {
    it(`${name}：已知 id 走映射表、未知 id 回落到原始 id`, async () => {
      const meta = (await import(`@ptd/site/definitions/${id}.ts`)) as any;
      const filter = (meta.siteMetadata.search.selectors.category as any).filters[0];
      expect(filter(known[0] as number)).toBe(known[1]);
      expect(filter(unknown[0] as number)).toBe(unknown[1]);
      expect(filter(unknown[0] as number)).not.toBeUndefined();
    });
  }

  it("milkie：未知分类 id 同样不再 undefined", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/milkie.ts");
    const filter = (siteMetadata.search!.selectors!.category as any).filters[0];
    expect(filter(2)).toBe("TV");
    expect(filter(99)).toBe("99");
  });
});

// ---------------------------------------------------------------------------
// L6：mypt 的等级门槛单调（ratio 5.05 → 4.55 倒挂）
// ---------------------------------------------------------------------------
describe("L6：mypt 等级门槛单调性", () => {
  it("Ultimate User 的 ratio 回到 NexusPHP 标准阶梯的 4.05", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/mypt.ts");
    const ultimate = siteMetadata.levelRequirements!.find((level) => level.id === 9)!;
    expect(ultimate.ratio).toBe(4.05);
  });

  it("user 组的 ratio / downloaded 门槛随 id 单调不减", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/mypt.ts");
    const { parseSizeString } = await import("@ptd/site/utils/filesize.ts");

    const userLevels = siteMetadata
      .levelRequirements!.filter((level) => (level.groupType ?? "user") === "user")
      .sort((a, b) => Number(a.id) - Number(b.id));

    const ratios = userLevels.map((level) => {
      const ratio = level.ratio;
      return Array.isArray(ratio) ? Number(ratio[0]) : Number(ratio ?? 0);
    });
    const downloaded = userLevels.map((level) => (level.downloaded ? parseSizeString(String(level.downloaded)) : 0));

    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i], `id ${userLevels[i].id} 的 ratio 不应低于上一级`).toBeGreaterThanOrEqual(ratios[i - 1]);
      expect(downloaded[i], `id ${userLevels[i].id} 的 downloaded 不应低于上一级`).toBeGreaterThanOrEqual(
        downloaded[i - 1],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// L7：ncore 删除假等级 VAGY
// ---------------------------------------------------------------------------
describe("L7：ncore 的 VAGY 假等级", () => {
  it("等级表里不再有 VAGY，最高 user 等级为 Legend(4)", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/ncore.ts");
    const { getMaxUserLevelId } = await import("@ptd/site/utils/level.ts");
    const levels = siteMetadata.levelRequirements!;

    expect(levels.map((level) => level.name)).not.toContain("VAGY");
    expect(getMaxUserLevelId(levels)).toBe(4);

    const ids = levels.map((level) => Number(level.id));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// L8：lemonhdnet 的 Elite User privilege 不再是 name 的复制
// ---------------------------------------------------------------------------
describe("L8：lemonhdnet Elite User privilege 占位", () => {
  it("不再把等级名当权限文案（字段缺省、UI 隐藏权限行）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/lemonhdnet.ts");
    const elite = siteMetadata.levelRequirements!.find((level) => level.id === 2)!;
    expect(elite.name).toBe("Elite User");
    expect(elite.privilege).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L9：元数据占位 / 分类名笔误
// ---------------------------------------------------------------------------
describe("L9：元数据占位与分类名笔误", () => {
  it("opencd 的 collaborator 不含 '*'", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/opencd.ts");
    expect(siteMetadata.collaborator).toEqual(["cnsunyour"]);
  });

  it("momentpt 不再声明占位 collaborator", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/momentpt.ts");
    expect(siteMetadata.collaborator).toBeUndefined();
  });

  it("pandapt 为 4320p/8K", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/pandapt.ts");
    const standard = (siteMetadata.category as any[]).find((cat) => cat.key === "standard")!;
    const names = standard.options.map((option: any) => option.name);
    expect(names).toContain("4320p/8K");
    expect(names).not.toContain("4320k/8K");
  });

  it("novahd 为 Others/其他", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/novahd.ts");
    const cat = (siteMetadata.category as any[]).find((group) => group.key === "cat")!;
    const names = cat.options.map((option: any) => option.name);
    expect(names).toContain("Others/其他");
    expect(names).not.toContain("Othes/其他");
  });
});

// ---------------------------------------------------------------------------
// L10：nebulance 的 params 增量合并（保留 Gazelle 的 searchsubmit=1），keywordPath 有上游依据
// ---------------------------------------------------------------------------
describe("L10：nebulance 搜索参数", () => {
  it("params 同时保留父层 searchsubmit=1 与站点自己的排序/tag 参数", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/nebulance.ts");
    expect(siteMetadata.search!.requestConfig!.params).toMatchObject({
      searchsubmit: 1,
      order_by: "time",
      order_way: "desc",
      tags_type: 1,
    });
  });

  it("keywordPath 保持 params.searchtext（与上游 PT-Plugin-Plus 的 searchtext=$key$ 一致）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/nebulance.ts");
    expect(siteMetadata.search!.keywordPath).toBe("params.searchtext");
  });
});

// ---------------------------------------------------------------------------
// L12：nebulance top10 overlay 单行异常不再吞掉整页
// ---------------------------------------------------------------------------
describe("L12：nebulance top10 overlay 解析的容错", () => {
  async function getTop10TitleElementProcess() {
    const { siteMetadata } = await import("@ptd/site/definitions/nebulance.ts");
    const entry = (siteMetadata.list as any[]).find((item) => item.selectors?.title?.selector === "> td > script")!;
    return entry.selectors.title.elementProcess as (el: Element) => string;
  }

  it("overlay 脚本不含 JSON 字符串时返回空标题而不是抛异常", async () => {
    const elementProcess = await getTop10TitleElementProcess();
    const script = makeDoc("<script>var overlay = 1;</script>").querySelector("script")!;
    expect(() => elementProcess(script)).not.toThrow();
    expect(elementProcess(script)).toBe("");
  });

  it("JSON.parse 失败时返回空标题", async () => {
    const elementProcess = await getTop10TitleElementProcess();
    const script = makeDoc('<script>"\\uZZZZ"</script>').querySelector("script")!;
    expect(() => elementProcess(script)).not.toThrow();
    expect(elementProcess(script)).toBe("");
  });

  it("overlay 里没有 td:last 时返回空标题", async () => {
    const elementProcess = await getTop10TitleElementProcess();
    const html = "<div>no cells</div>";
    const script = makeDoc(`<script>${JSON.stringify(html)}</script>`).querySelector("script")!;
    expect(elementProcess(script)).toBe("");
  });

  it("正常 overlay 仍能取到 td:last 的标题", async () => {
    const elementProcess = await getTop10TitleElementProcess();
    const html = "<table><tr><td>a</td><td>Some.Show.S01E01.1080p</td></tr></table>";
    const script = makeDoc(`<script>${JSON.stringify(html)}</script>`).querySelector("script")!;
    expect(elementProcess(script)).toBe("Some.Show.S01E01.1080p");
  });
});
