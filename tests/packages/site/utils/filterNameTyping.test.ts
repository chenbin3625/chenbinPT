/**
 * T-1：站点定义里的过滤器名必须受类型约束。
 *
 * `definedFilters` 原先标注为 `Record<string, …>`，`keyof typeof definedFilters` 退化成 `string`，
 * 于是 `{ name: "divide" }`（broadcasthenet）、`{ name: "parseValidTimeString" }`（haidan）都能通过 vue-tsc，
 * 运行时又被「未命中即跳过」静默吞掉。这里用类型断言钉住约束（vue-tsc 会检查 tests/**）。
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { definedFilters, filterNames, type TDefinedFilterName, type TQueryFilter } from "@ptd/site/utils/filter.ts";

describe("过滤器名的类型约束（T-1）", () => {
  it("TDefinedFilterName 是字面量联合而不是 string", () => {
    expectTypeOf<"parseSize">().toMatchTypeOf<TDefinedFilterName>();
    expectTypeOf<string>().not.toMatchTypeOf<TDefinedFilterName>();
  });

  it("不存在的过滤器名不是合法的 TQueryFilter", () => {
    // @ts-expect-error —— 若约束再次失效（例如又标注回 Record<string, …>），这一行会报 Unused '@ts-expect-error'
    const bad: TQueryFilter = { name: "divide" };
    expect(filterNames).not.toContain(bad && "divide");
  });

  it("运行时的过滤器表与类型一致", () => {
    expect(filterNames).toEqual(Object.keys(definedFilters));
    expect(filterNames).toContain("parseTime");
  });
});

describe("broadcasthenet bonusPerHour（M-12）", () => {
  it("站点给的「Per Day」按 24 小时换算成每小时（原来的 divide 过滤器不存在，被静默跳过）", async () => {
    const { siteMetadata } = await import("@ptd/site/definitions/broadcasthenet.ts");
    const filters = siteMetadata.userInfo!.selectors!.bonusPerHour!.filters!;
    let value: any = "Per Day: 48";
    for (const filter of filters) {
      value = typeof filter === "function" ? filter(value) : (definedFilters as any)[filter.name](value, filter.args);
    }
    expect(value).toBe(2);
  });
});
