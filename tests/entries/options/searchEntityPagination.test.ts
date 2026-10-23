import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { toPagination } from "@/options/views/Overview/utils/antdTable.ts";

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("SearchEntity 大结果集分页", () => {
  it("历史上的 -1 配置也应限制为 25 行分页，避免一次渲染上千条结果", () => {
    const pagination = toPagination(-1, vi.fn(), { allowUnpaginated: false });

    expect(pagination).toMatchObject({
      pageSize: 25,
      pageSizeOptions: ["5", "10", "25", "50", "100"],
    });
  });

  it("其他表格仍保留 -1 表示不分页的兼容行为", () => {
    expect(toPagination(-1, vi.fn())).toBe(false);
  });
});

describe("F16：我的数据 / 搜索快照 也不能退化成「不分页」", () => {
  it("两张表都显式传 allowUnpaginated: false（历史 itemsPerPage = -1 时仍渲染分页器）", () => {
    const myData = readSource("src/entries/options/views/Overview/MyData/Index.vue");
    const snapshot = readSource("src/entries/options/views/Overview/SearchResultSnapshot/Index.vue");

    for (const [name, source] of [
      ["MyData", myData],
      ["SearchResultSnapshot", snapshot],
    ] as const) {
      expect(source, `${name} 的分页配置必须拒绝 -1`).toContain("{ allowUnpaginated: false }");
    }
  });

  it("toPagination(-1, ..., { allowUnpaginated: false }) 返回可用的分页器（与上面两张表同一口径）", () => {
    expect(toPagination(-1, vi.fn(), { allowUnpaginated: false })).toMatchObject({
      pageSize: 25,
      showSizeChanger: true,
    });
  });
});
