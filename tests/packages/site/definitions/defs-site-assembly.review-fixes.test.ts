/**
 * H-L5：时区默认值必须来自真实装配路径（`src/packages/site/index.ts`），不要在测试里手写。
 *
 * 问题：`site/index.ts:60` 会在运行期给未声明 `timezoneOffset` 的站点补默认值
 * （NexusPHP → `+0800`，其它 → `+0000`）。原测试用
 * `{ ...siteMetadata, timezoneOffset: "+0800" }` 人工复刻这段逻辑，
 * 于是「运行期默认值改了」或「某个定义自己声明了别的偏移」都不会被发现——
 * 站点时间会整体偏 8 小时，而测试仍然全绿。
 *
 * 本文件直接对装配结果断言：
 * - 未声明偏移的 NexusPHP 站点 → `+0800`；未声明偏移的非 NexusPHP 站点 → `+0000`；
 * - 定义自己声明的偏移不会被默认值覆盖；
 * - `getSite()` 造出来的实例真的带着装配后的偏移（端到端，而不是只查元数据）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

describe("站点元数据装配：timezoneOffset 默认值（H-L5）", () => {
  /**
   * 动态挑出「定义文件本身没有声明 timezoneOffset」的站点（默认值只能来自 index.ts）。
   * 不写死列表：定义层正在按站点补齐显式声明，写死会在每次补齐后变成「测试自己在断言手写值」。
   */
  const pickSitesWithoutDeclaredOffset = async () => {
    const definitions = import.meta.glob("../../../../src/packages/site/definitions/*.ts");
    const nexusPhp: string[] = [];
    const other: string[] = [];

    for (const load of Object.values(definitions)) {
      const mod = (await load()) as any;
      const metadata = mod?.siteMetadata;
      if (!metadata?.id || metadata.timezoneOffset !== undefined) continue;
      if (metadata.schema === "NexusPHP") {
        if (nexusPhp.length < 3) nexusPhp.push(metadata.id);
      } else if (other.length < 3) {
        other.push(metadata.id);
      }
      if (nexusPhp.length >= 3 && other.length >= 3) break;
    }

    return { nexusPhp, other };
  };

  /** 定义自己声明了非默认偏移的站点 */
  const declaredOffsets: Array<[string, string]> = [
    ["retrotoon", "+1200"],
    ["brokenstones", "-0100"],
    ["exttorrents", "+0800"],
    ["hdspace", "+0000"],
  ];

  it("未声明 timezoneOffset 的站点按 schema/type 得到运行期默认值", async () => {
    const { getDefinedSiteMetadata } = await import("@ptd/site/index.ts");
    const { nexusPhp, other } = await pickSitesWithoutDeclaredOffset();

    expect(
      nexusPhp.length + other.length,
      "已经没有未声明 timezoneOffset 的站点：默认注入逻辑无人使用，本用例可以删除",
    ).toBeGreaterThan(0);

    for (const siteId of nexusPhp) {
      // 前提：定义里确实没有声明，否则这条用例就退化成「测试自己写死了期望值」
      const definition = await import(`@ptd/site/definitions/${siteId}.ts`);
      expect(
        (definition.siteMetadata as any).timezoneOffset,
        `${siteId} 现在自己声明了 timezoneOffset`,
      ).toBeUndefined();

      const assembled = await getDefinedSiteMetadata(siteId);
      expect(assembled.timezoneOffset, `${siteId}（NexusPHP）的运行期默认时区`).toBe("+0800");
    }

    for (const siteId of other) {
      const definition = await import(`@ptd/site/definitions/${siteId}.ts`);
      expect(
        (definition.siteMetadata as any).timezoneOffset,
        `${siteId} 现在自己声明了 timezoneOffset`,
      ).toBeUndefined();

      const assembled = await getDefinedSiteMetadata(siteId);
      expect(assembled.timezoneOffset, `${siteId}（非 NexusPHP）的运行期默认时区`).toBe("+0000");
    }
  });

  it("定义自己声明的 timezoneOffset 不会被默认值覆盖", async () => {
    const { getDefinedSiteMetadata } = await import("@ptd/site/index.ts");

    for (const [siteId, expected] of declaredOffsets) {
      const assembled = await getDefinedSiteMetadata(siteId);
      expect(assembled.timezoneOffset, `${siteId} 声明的时区`).toBe(expected);
    }
  });

  it("装配后的 timezoneOffset 一律是 ±HHmm（坏值会让 parseTime 静默回落宿主时区）", async () => {
    const { getDefinedSiteMetadata } = await import("@ptd/site/index.ts");

    // 采样覆盖三种来源：默认注入（NexusPHP / 其它）、定义自声明、schema 自带
    const sample = ["hdcity", "tokyotosho", "retrotoon", "brokenstones", "exttorrents", "yuscene", "passthepopcorn"];
    for (const siteId of sample) {
      const assembled = await getDefinedSiteMetadata(siteId);
      expect(String(assembled.timezoneOffset), siteId).toMatch(/^[+-]\d{4}$/);
    }
  });

  it("getSite() 造出的实例带着装配后的偏移（端到端）", async () => {
    const { getSite } = await import("@ptd/site/index.ts");
    const { default: NexusPHP } = await import("@ptd/site/schemas/NexusPHP.ts");

    const site = await getSite("hdcity");
    expect(site).toBeInstanceOf(NexusPHP);
    expect((site as any).metadata.timezoneOffset).toBe("+0800");
  });
});
