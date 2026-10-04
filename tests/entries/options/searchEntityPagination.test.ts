import { describe, expect, it, vi } from "vitest";

import { toPagination } from "@/options/views/Overview/utils/antdTable.ts";

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
