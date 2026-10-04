import { describe, expect, it } from "vitest";

import { toAntdColumns } from "@/options/views/Overview/utils/antdTable.ts";
import type { DataTableHeader } from "@/options/types/dataTable.ts";

describe("antd table sorting adapter", () => {
  it("provides a local sorter that compares column values", () => {
    const [column] = toAntdColumns([{ title: "Uploaded", key: "uploaded" } satisfies DataTableHeader]);

    const rows = [{ uploaded: 3 }, { uploaded: 1 }, { uploaded: 2 }];

    expect(typeof column!.sorter?.compare).toBe("function");
    expect(rows.toSorted(column!.sorter.compare).map((row) => row.uploaded)).toEqual([1, 2, 3]);
  });

  it("uses nested keys when comparing column values", () => {
    const [column] = toAntdColumns([{ title: "Site order", key: "siteUserConfig.sortIndex" }]);

    const rows = [
      { siteUserConfig: { sortIndex: 30 } },
      { siteUserConfig: { sortIndex: 10 } },
      { siteUserConfig: { sortIndex: 20 } },
    ];

    expect(rows.toSorted(column!.sorter.compare).map((row) => row.siteUserConfig.sortIndex)).toEqual([10, 20, 30]);
  });

  it("preserves minimum width declarations for responsive tables", () => {
    const [column] = toAntdColumns([{ title: "Download at", key: "downloadAt", minWidth: "10rem" }]);

    expect(column).toMatchObject({ minWidth: "10rem" });
  });

  it("uses value as the column key when key is omitted", () => {
    const columns = toAntdColumns([{ title: "Name", value: "name" }], { visibleKeys: ["name"] });

    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({ dataIndex: "name", key: "name" });
  });
});
