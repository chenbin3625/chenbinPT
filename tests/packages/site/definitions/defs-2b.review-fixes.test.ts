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
    // Gazelle 默认的 uploads 选择器带 Community 区块限定，避免命中 Stats 的流量行
    expect(JSON.stringify(siteMetadata.userInfo!.selectors!.uploads)).not.toContain("li:contains('Uploaded:')");
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

describe("hdtorrents removeInvalidDataUnit 真正去掉 BiT（DEFS2-13）", () => {
  it("0.00 BiT / 1.5 BiT 去掉单位后被 parseSize 解析为 0，正常单位不受影响", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/hdtorrents.ts");
    const { parseSizeString } = await import("@ptd/site/utils/filesize.ts");
    const { definedFilters } = await import("@ptd/site/utils/filter.ts");

    const userStep = siteMetadata.userInfo!.process!.find((p: any) => p.selectors?.uploaded)!;
    const filters = (userStep.selectors as any).uploaded.filters as any[];

    const runChain = (raw: string) =>
      filters.reduce((q, f) => (typeof f === "function" ? f(q) : (definedFilters as any)[f.name](q, f.args)), raw);

    expect(runChain("0.00 BiT")).toBe(0);
    expect(runChain("1.50 BiT")).toBe(0);
    expect(runChain("1.5 GB")).toBe(parseSizeString("1.5 GB"));
    expect(parseSizeString("1.5 GB")).toBeGreaterThan(0);

    // seedingSize 复用同一组过滤器，同样生效
    const seedSizeFilters = (userStep.selectors as any).seedingSize.filters as any[];
    expect(seedSizeFilters[1]("2.00 BiT")).toBe("2.00");
    expect(seedSizeFilters[1]("2.00 GB")).toBe("2.00 GB");
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
