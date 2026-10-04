/**
 * 搜索方案页：内置默认方案渲染为表格行。
 *
 * Q-3 改造：原断言读 `SetSearchSolution/Index.vue` 源码文本，检查 `<a-table>` 子块里
 * 没有 `<template #title>`、有 `:data-source="tableRows"` / `:row-selection="rowSelection"`，
 * 并在整份源码里出现 `isBuiltInDefault`。这些都是"模板里写了这些字"。
 *
 * 现在真实挂载该视图，断言**渲染结果**：
 * - 内置默认方案（「全部」）确实作为一行出现在表格 tbody 里；
 * - 它没有被塞到表格标题区（`.ant-table-title` 不存在 / 不含它）；
 * - 表格带选择列，且内置行不可被选中（原来靠 `rowSelection.disabled` 表达的行为）。
 */
import { describe, expect, it, vi } from "vitest";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

const DEFAULT_ROW_NAME = "全部";

describe("搜索方案默认行布局", () => {
  it("内置默认方案是表格里的一行，而不是顶到表格标题区域", async () => {
    const pinia = prepareOptionsPinia();
    const { default: SetSearchSolution } = await import("@/options/views/Settings/SetSearchSolution/Index.vue");

    const view = mountOptionsView(SetSearchSolution, { pinia, router: true });
    await view.settle(120);

    const table = view.$(".ant-table");
    expect(table, "应渲染出表格").not.toBeNull();

    const bodyText = view.$(".ant-table-tbody")?.textContent ?? "";
    expect(bodyText, "内置默认方案应作为 tbody 的一行渲染").toContain(DEFAULT_ROW_NAME);

    // 标题区（a-table 的 #title 插槽）不应存在，更不应承载内置行
    expect(view.$(".ant-table-title"), "不应把内置行放到表格标题区").toBeNull();

    // 选择列存在（行选择能力保留），且内置行是禁用态
    expect(view.$(".ant-table-selection-column"), "表格应带选择列").not.toBeNull();
    const defaultRow = view.$$(".ant-table-tbody tr").find((row) => (row.textContent ?? "").includes(DEFAULT_ROW_NAME));
    expect(defaultRow, "应能定位到内置默认方案所在行").toBeDefined();
    const checkbox = defaultRow!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox, "内置行应有选择框（只是禁用）").not.toBeNull();
    expect(checkbox!.disabled, "内置默认方案不可被选中（不能删除/导出它）").toBe(true);

    view.unmount();
  });
});
