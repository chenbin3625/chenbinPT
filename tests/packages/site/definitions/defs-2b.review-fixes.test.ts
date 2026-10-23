/**
 * defs-2b 包（DEFS2-8 / DEFS2-10 / DEFS2-11 / DEFS2-12 / DEFS2-13）修复的行为回归。
 * 只做选择器 / 过滤器 / 等级门槛层面的断言，不发网络请求。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

const makeDoc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");

describe("lztr 社区统计走 levelExtendInfo ajax（DEFS2-8）", () => {
  it("seeding/uploads/snatches 被放进指向 user_ajax 端点的 process 步骤", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/lztr.ts");
    const process = siteMetadata.userInfo!.process!;
    const ajaxStep = process.find((p: any) => p.requestConfig?.params?.action === "user_ajax");

    expect(ajaxStep).toBeTruthy();
    expect(ajaxStep!.requestConfig!.url).toBe("/user.php");
    expect(ajaxStep!.requestConfig!.params).toMatchObject({ type: "community" });
    expect(ajaxStep!.assertion).toMatchObject({ id: "params.id" });
    for (const field of ["seeding", "uploads", "snatches"]) {
      expect((ajaxStep!.selectors as any)[field]).toBeTruthy();
    }
  });

  it("不再把这三条选择器挂到全局 selectors（snatches 原本是死配置）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/lztr.ts");
    expect(siteMetadata.userInfo!.selectors!.snatches).toBeUndefined();

    // I5：原先这里只做「JSON 里不含某个字符串」的黑名单，无法证明 uploads 指向 Community 区块。
    // Gazelle 的 uploads 必须是 genStatBoxSelector(Community, "Uploaded") 的形状：
    const uploadsSelector = ([] as string[]).concat(siteMetadata.userInfo!.selectors!.uploads!.selector as any);
    expect(uploadsSelector.length).toBeGreaterThan(0);
    expect(uploadsSelector.every((selector) => selector.includes("'Community'"))).toBe(true);
    // 不能落在 Stats / Statistics 区块（那里是上传流量，不是发布数）
    expect(uploadsSelector.some((selector) => /'(Stats|Statistics)'/.test(selector))).toBe(false);
  });

  it("同一份 user.php 里 Stats 的 Uploaded 与 Community 的 Uploaded 不会串（真实 getFieldData）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/lztr.ts");
    const { default: Gazelle } = await import("@ptd/site/schemas/Gazelle.ts");
    const { selectElements } = await import("@ptd/site/utils/selector.ts");

    // Gazelle user.php 的两块统计：Stats 的 Uploaded 是流量（GB），Community 的 Uploaded 是发布数
    const doc = makeDoc(
      "<div>Stats</div><ul class='stats'><li>Uploaded: 1.23 GB</li><li>Downloaded: 4.56 GB</li></ul>" +
        "<div>Community</div><ul class='stats'><li>Uploaded: 345</li><li>Snatched: 6</li></ul>",
    );
    const uploadsQuery = siteMetadata.userInfo!.selectors!.uploads as any;

    // 选择器是 string[]（Gazelle 的 Community/Stats 两个候选），selectElements 只接受单个字符串
    expect(selectElements(String(uploadsQuery.selector[0]), doc).length).toBeGreaterThan(0);

    const site: any = new Gazelle(siteMetadata as any);
    // 命中 Community 的 345，而不是 Stats 的 "1.23 GB"（旧选择器 `li:contains('Uploaded:')` 会取第一个 li）
    expect(site.getFieldData(doc, uploadsQuery)).toBe(345);
  });

  it("ajax 片段里的 li 能被选择器命中并用 parseNumber 取出计数", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/lztr.ts");
    const { selectElements } = await import("@ptd/site/utils/selector.ts");
    const { definedFilters } = await import("@ptd/site/utils/filter.ts");

    const step = siteMetadata.userInfo!.process!.find((p: any) => p.requestConfig?.params?.action === "user_ajax")!;
    // PTPP levelExtendInfo 端点返回的社区统计片段
    const doc = makeDoc("<ul><li>Seeding: 12</li><li>Uploaded: 345</li><li>Snatched: 6</li></ul>");

    for (const [field, expected] of [
      ["seeding", 12],
      ["uploads", 345],
      ["snatches", 6],
    ] as const) {
      const query = (step.selectors as any)[field];
      const element = selectElements(query.selector, doc)[0] as HTMLElement;
      expect(element?.textContent).toBeTruthy();
      expect(definedFilters.parseNumber(element.textContent)).toBe(expected);
    }
  });
});

describe("orpheus Power TM 的 500 群组门槛（DEFS2-10）", () => {
  it("改为引擎已求值的 groups 键，并真正参与回落判级", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/orpheus.ts");
    const { levelRequirementUnMet } = await import("@ptd/site/utils/level.ts");

    const level6 = siteMetadata.levelRequirements!.find((l) => l.id === 6)!;
    expect(level6.groups).toBe(500);
    expect((level6 as any).uniqueGroups).toBeUndefined();

    const below = levelRequirementUnMet({ groups: 0 } as any, level6);
    expect(below.groups).toBe(500);

    const met = levelRequirementUnMet({ groups: 500 } as any, level6);
    expect(met.groups).toBeUndefined();
  });
});

describe("iptorrents Power User 门槛（DEFS2-11）", () => {
  it("删除官网未列出的 downloaded:5GB，低下载量用户不再被压回 User", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/iptorrents.ts");
    const { levelRequirementUnMet } = await import("@ptd/site/utils/level.ts");

    const level2 = siteMetadata.levelRequirements!.find((l) => l.id === 2)!;
    expect(level2.downloaded).toBeUndefined();

    const unmet = levelRequirementUnMet(
      {
        uploaded: 60 * 1024 ** 3,
        downloaded: 1024 ** 3,
        ratio: 1.2,
        joinTime: Date.now() - 40 * 24 * 3600 * 1000,
      } as any,
      level2,
    );
    expect(unmet.downloaded).toBeUndefined();
  });
});

describe("nordicbytes 做种/下载计数取不到时不再静默记 0（DEFS2-12）", () => {
  it("文本带 (n) 时正常取数，只有体积时返回 undefined", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/nordicbytes.ts");
    const step = siteMetadata.userInfo!.process![0];
    const seedingFilter = ((step.selectors as any).seeding.filters as any[])[0];
    const leechingFilter = ((step.selectors as any).leeching.filters as any[])[0];

    expect(seedingFilter("1.23 GB (5)")).toBe(5);
    expect(seedingFilter("1.23 GB")).toBeUndefined();
    expect(leechingFilter("4.00 GB (0)")).toBe(0);
    expect(leechingFilter("4.00 GB")).toBeUndefined();
  });
});

describe("hdtorrents 的 BiT 单位（DEFS2-13 复核：有意归零，不是数值修复）", () => {
  /**
   * H-L1 复核结论（2026-10-23）：`removeInvalidDataUnit` 剥掉 `BiT` 之后交给 `parseSize` 的
   * 是**无单位**的 `"1.50"`，`parseSize` 对这种串返回 0 —— 与修复前（恒等实现里 `parseSize("1.50 BiT")`
   * 恰好只截到 `"1.50B"` → 1.5）相比，用户可见结果从「错误的 1.5 字节」变成 0，**两种都不是正确值**。
   * 也就是说 DEFS2-13 只让中间值变得干净，并没有把非零 BiT 还原成正确的量。
   *
   * 站点语义：HDT 只在上传/下载量为 0 时渲染 `0.00 BiT`，所以现实里命中的都是 0，
   * 这条修复的实际收益是「中间值可读」。若站点某天渲染出非零 BiT，这里会静默记 0（数据丢失），
   * 正确做法是把该值保留为 `undefined` 并记 warn —— 那属于 `src/packages/site/definitions/hdtorrents.ts`
   * 的改动（DEF 分片），本文件只把现状与风险固定下来，见 fix report 的「延期/跟进」。
   */
  const loadChain = async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdtorrents.ts");
    const { definedFilters } = await import("@ptd/site/utils/filter.ts");
    const userStep = siteMetadata.userInfo!.process!.find((p: any) => p.selectors?.uploaded)!;
    const filters = (userStep.selectors as any).uploaded.filters as any[];

    const runChain = (raw: string) =>
      filters.reduce((q, f) => (typeof f === "function" ? f(q) : (definedFilters as any)[f.name](q, f.args)), raw);

    return { filters, runChain, definedFilters, siteMetadata, userStep };
  };

  it("「0.00 BiT」（站点只在计数为 0 时显示）解析为 0，而不是 NaN/文本", async () => {
    const { runChain } = await loadChain();
    expect(runChain("0.00 BiT")).toBe(0);
  });

  it("非零「1.50 BiT」同样归零 —— 这是**有意归零**，不是「修复为非零值」", async () => {
    const { runChain, definedFilters } = await loadChain();
    // 归零的机制：先剥掉单位，再让 parseSize 拿无单位串；两种写法的用户可见结果都是 0
    expect(runChain("1.50 BiT")).toBe(0);
    expect(definedFilters.parseSize("1.50")).toBe(0);
    // 反面：若不剥单位，parseSize 会把 "1.50 BiT" 截成 "1.50B" 并当成 1.5 字节 —— 这正是修复前的错误数值
    expect(definedFilters.parseSize("1.50 BiT")).toBe(1.5);
  });

  it("正常单位（1.5 GB / 2.00 GB）不受影响，且不会被误剥单位", async () => {
    const { runChain, definedFilters } = await loadChain();
    expect(runChain("1.5 GB")).toBe(definedFilters.parseSize("1.5 GB"));
    expect(runChain("1.5 GB")).toBeGreaterThan(0);
    expect(definedFilters.parseSize("2.00 GB")).toBe(2 * 1024 ** 3);
  });

  it("单位剥离步骤本身（唯一会随实现回退变红的断言）", async () => {
    const { filters } = await loadChain();
    // 该过滤器是 `removeInvalidDataUnit`：把 BiT 后缀连同前面的空白一起剥掉。
    // 把实现改回恒等函数时这里会重新得到 "2.00 BiT" —— 这是 DEFS2-13 唯一可观测的中间值差异。
    expect(filters[1]("2.00 BiT")).toBe("2.00");
    expect(filters[1]("2.00 GB")).toBe("2.00 GB");
  });

  it("seedingSize 复用同一组过滤器（含 BiT 归零）", async () => {
    const { siteMetadata, definedFilters } = await loadChain();
    const filters = (siteMetadata.userInfo!.process!.find((p: any) => p.selectors?.seedingSize)! as any).selectors
      .seedingSize.filters as any[];
    const run = (raw: string) =>
      filters.reduce((q, f) => (typeof f === "function" ? f(q) : (definedFilters as any)[f.name](q, f.args)), raw);

    expect(run("0.00 BiT")).toBe(0);
    expect(run("2.00 GB")).toBe(2 * 1024 ** 3);
  });
});

describe("D2-N7：本文件判据依赖的 filter.parseSize / parseNumber 行为", () => {
  /**
   * DEFS2-13、ncore、hdroute 等修复的判据都建立在 `filter.parseSize` / `parseNumber` 的语义上，
   * 但这两个内置过滤器此前没有任何行为单测（审查 D2-N7）。`tests/packages/site/utils/**` 属其它
   * 修复者范围，这里先按「本文件用到的形状」覆盖，避免判据本身漂移。
   */
  it("parseSize：带单位、带前缀文本、带千分位、无单位、坏值的语义", async () => {
    const { definedFilters } = await import("@ptd/site/utils/filter.ts");

    expect(definedFilters.parseSize("1.5 GB")).toBe(1.5 * 1024 ** 3);
    expect(definedFilters.parseSize("2 TiB")).toBe(2 * 1024 ** 4);
    // 站点常见形态：前缀文本 + 体积
    expect(definedFilters.parseSize("[Free] 1.5 GB")).toBe(1.5 * 1024 ** 3);
    expect(definedFilters.parseSize("1,024 MB")).toBe(1024 * 1024 ** 2);
    // 纯数字按字节处理；无单位的小数（如剥掉 BiT 之后的 "1.50"）不是合法体积 → 0
    expect(definedFilters.parseSize("1024")).toBe(1024);
    expect(definedFilters.parseSize("1.50")).toBe(0);
    // 数值入参原样返回（调用方已经解析过）
    expect(definedFilters.parseSize(2048)).toBe(2048);
    expect(definedFilters.parseSize("")).toBe(0);
    expect(definedFilters.parseSize("N/A")).toBe(0);
  });

  it("parseNumber：整数、千分位、欧式小数、带括号/前缀、坏值", async () => {
    const { definedFilters } = await import("@ptd/site/utils/filter.ts");

    expect(definedFilters.parseNumber("12")).toBe(12);
    expect(definedFilters.parseNumber("1,024")).toBe(1024);
    expect(definedFilters.parseNumber("-5")).toBe(-5);
    expect(definedFilters.parseNumber(7)).toBe(7);
    // 站点常见形态：把计数混在文本里
    expect(definedFilters.parseNumber("Seeding: 12")).toBe(12);
    expect(definedFilters.parseNumber("4.00 GB (0)")).toBe(4);
    expect(definedFilters.parseNumber("")).toBe(0);
    expect(definedFilters.parseNumber("N/A")).toBe(0);
  });
});

describe("L-1/L-2：等级阶梯不能倒挂", () => {
  it("itzmx 的普通用户下载量门槛随等级递增", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/itzmx.ts");
    const { parseSizeString } = await import("@ptd/site/utils/filesize.ts");

    const downloadedRequirements = siteMetadata
      .levelRequirements!.filter((level) => (level.groupType ?? "user") === "user" && level.downloaded)
      .map((level) => ({
        id: level.id,
        name: level.name,
        downloaded: parseSizeString(String(level.downloaded)),
      }));

    for (let i = 1; i < downloadedRequirements.length; i++) {
      expect(downloadedRequirements[i].downloaded, downloadedRequirements[i].name).toBeGreaterThanOrEqual(
        downloadedRequirements[i - 1].downloaded,
      );
    }
  });

  it("railgunpt 的普通用户注册时长门槛随等级递增", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/railgunpt.ts");

    const weeks = siteMetadata
      .levelRequirements!.filter((level) => (level.groupType ?? "user") === "user" && level.interval)
      .map((level) => ({
        id: level.id,
        name: level.name,
        weeks: Number(String(level.interval).match(/^P(\d+)W$/)?.[1] ?? 0),
      }));

    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i].weeks, weeks[i].name).toBeGreaterThanOrEqual(weeks[i - 1].weeks);
    }
  });
});
