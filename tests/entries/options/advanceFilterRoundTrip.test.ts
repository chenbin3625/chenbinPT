/**
 * 高级筛选：字典 ↔ 查询串的往返（B-14 / B-15 / B-16；代码审查报告已移出仓库树，可在提交 3b066d59 中查阅）。
 *
 * 这三条缺陷都出在「自研转义 / 格式化 / 正则缓存」与 search-query-parser@1.6.0 的交互上，
 * 因此这里用与生产同一个库版本做往返断言：
 * - B-14：`My Sites` 这类含保留字符的值会被库在 parse 时改写（`My\u0020Sites` → `Myu0020Sites`），
 *   unEscapeQueryValue 再也匹配不上 → 表格零行命中而复选框仍勾选；
 * - B-15：`parse("0")`/`build("0")` 因字符串 "0" 是真值而返回 "1" → 筛选语义反转；
 * - B-16：带 g 标志的正则实例被 regexCache 复用，`lastIndex` 残留 → 「隔一个值命中一次」。
 *
 * 配置刻意与 `views/Settings/SetSite/Index.vue` 一致（分组名是 B-14 的用户可见路径，
 * `userConfig.isOffline` 是 B-15 的用户可见路径）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

// @ptd/site → adapter.ts → messages.ts 会读取 vite 的构建期常量 __BROWSER__（单测环境下不存在）
vi.hoisted(() => {
  (globalThis as any).__BROWSER__ = "chrome";
});

import { useTableCustomFilter } from "@/options/directives/useAdvanceFilter.ts";

function createSiteFilter() {
  return useTableCustomFilter<Record<string, any>>({
    parseOptions: {
      keywords: ["id", "userConfig.isOffline", "userConfig.groups"],
    },
    titleFields: ["userConfig.merge.name", "userConfig.url"],
    format: {
      "userConfig.isOffline": "boolean",
    },
  });
}

type TFilter = ReturnType<typeof createSiteFilter>;

/** 与表格实际使用一致：把查询串写进 v-model，并等 refDebounced 的窗口过去 */
async function applyFilterText(filter: TFilter, text: string) {
  filter.tableWaitFilterRef.value = text;
  await nextTick();
  vi.advanceTimersByTime(1000);
  await nextTick();
}

/** 与 views 里的调用方式一致：query 参数传当前的 debounced 筛选词 */
function runFilter(filter: TFilter, raw: Record<string, any>) {
  return filter.tableFilterFn(undefined, filter.tableFilterRef.value, { raw });
}

/** 构造一行站点数据（titleFields 是 userConfig.merge.name / userConfig.url） */
function siteRow(name: string, extra: Record<string, any> = {}) {
  return { userConfig: { merge: { name }, ...extra } };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("B-14 转义往返：值不会被 search-query-parser 改写", () => {
  it.each(["My Sites", "hello world", "a,b", "a:b", "back\\slash", "100%", "it's", `/1080p/g`, "标签 组A,组B"])(
    "%j 经 stringify → parse 无损",
    (raw) => {
      const filter = createSiteFilter();

      filter.advanceFilterDictRef.value["userConfig.groups"] = { required: [raw], exclude: [] };
      const text = filter.stringifyFilterDictFn();
      filter.buildFilterDictFn(text);

      expect(filter.advanceFilterDictRef.value["userConfig.groups"]).toEqual({ required: [raw], exclude: [] });
    },
  );

  it("多值与排除筛选同样无损（逗号/空格不会把值拆错）", () => {
    const filter = createSiteFilter();

    filter.advanceFilterDictRef.value["userConfig.groups"] = {
      required: ["My Sites", "a,b"],
      exclude: ["x y"],
    };
    const text = filter.stringifyFilterDictFn();
    filter.buildFilterDictFn(text);

    expect(filter.advanceFilterDictRef.value["userConfig.groups"]).toEqual({
      required: ["My Sites", "a,b"],
      exclude: ["x y"],
    });
  });

  it("text 字段含空格时同样无损", () => {
    const filter = createSiteFilter();

    filter.advanceFilterDictRef.value.text = { required: ["hello world"], exclude: [] };
    const text = filter.stringifyFilterDictFn();
    filter.buildFilterDictFn(text);

    expect(filter.advanceFilterDictRef.value.text).toEqual({ required: ["hello world"], exclude: [] });
  });

  it("分组名为 `My Sites` 时筛选仍能命中对应行（修复前零行命中）", async () => {
    const filter = createSiteFilter();

    filter.advanceFilterDictRef.value["userConfig.groups"] = { required: ["My Sites"], exclude: [] };
    await applyFilterText(filter, filter.stringifyFilterDictFn());

    expect(runFilter(filter, siteRow("行1", { groups: ["My Sites"] }))).toBe(true);
    expect(runFilter(filter, siteRow("行2", { groups: ["Myu0020Sites"] }))).toBe(false);
    expect(runFilter(filter, siteRow("行3", { groups: ["Other"] }))).toBe(false);
  });

  it("分组名为 `a,b` 时按单个值筛选（不会被拆成两个必须同时满足的值）", async () => {
    const filter = createSiteFilter();

    filter.advanceFilterDictRef.value["userConfig.groups"] = { required: ["a,b"], exclude: [] };
    await applyFilterText(filter, filter.stringifyFilterDictFn());

    expect(runFilter(filter, siteRow("行1", { groups: ["a,b"] }))).toBe(true);
    expect(runFilter(filter, siteRow("行2", { groups: ["a"] }))).toBe(false);
  });

  it("text 筛选含空格时命中标题（修复前同样是零行命中）", async () => {
    const filter = createSiteFilter();
    await applyFilterText(filter, "hello%20world");

    expect(runFilter(filter, siteRow("hello world"))).toBe(true);
    expect(runFilter(filter, siteRow("hello there"))).toBe(false);
  });
});

describe("B-15 boolean 格式化", () => {
  it('parse/build 显式判断，字符串 "0" 不再被当成真值', () => {
    const filter = createSiteFilter();

    filter.buildFilterDictFn("userConfig.isOffline:0");
    expect(filter.advanceFilterDictRef.value["userConfig.isOffline"].required).toEqual(["0"]);

    filter.buildFilterDictFn("userConfig.isOffline:1");
    expect(filter.advanceFilterDictRef.value["userConfig.isOffline"].required).toEqual(["1"]);
  });

  it("boolean 值经 stringify → parse 往返不反转", () => {
    const filter = createSiteFilter();

    filter.advanceFilterDictRef.value["userConfig.isOffline"] = { required: ["0"], exclude: [] };
    const text = filter.stringifyFilterDictFn();
    expect(text).toContain("userConfig.isOffline:0");

    filter.buildFilterDictFn(text);
    expect(filter.advanceFilterDictRef.value["userConfig.isOffline"]).toEqual({ required: ["0"], exclude: [] });
  });

  it("`userConfig.isOffline:0` 筛选出 isOffline 为 false 的行", async () => {
    const filter = createSiteFilter();
    filter.advanceFilterDictRef.value["userConfig.isOffline"] = { required: ["0"], exclude: [] };
    await applyFilterText(filter, filter.stringifyFilterDictFn());

    expect(runFilter(filter, siteRow("关闭", { isOffline: false }))).toBe(true);
    expect(runFilter(filter, siteRow("开启", { isOffline: true }))).toBe(false);
  });

  it('`userConfig.isOffline:1` 筛选出 isOffline 为 true 的行（布尔行值与数字 1 都要归一化为 "1"）', async () => {
    const filter = createSiteFilter();
    filter.advanceFilterDictRef.value["userConfig.isOffline"] = { required: [1], exclude: [] };
    await applyFilterText(filter, filter.stringifyFilterDictFn());

    expect(filter.tableWaitFilterRef.value).toContain("userConfig.isOffline:1");
    expect(runFilter(filter, siteRow("开启", { isOffline: true }))).toBe(true);
    expect(runFilter(filter, siteRow("关闭", { isOffline: false }))).toBe(false);
  });
});

describe("B-16 正则字面量缓存", () => {
  it("带 g 标志的正则不残留 lastIndex：4 个值全部命中", async () => {
    const filter = createSiteFilter();
    await applyFilterText(filter, "/1080p/g");

    const titles = ["a1080pb", "c1080pd", "e1080pf", "g1080ph"];
    const matched = titles.map((title) => runFilter(filter, siteRow(title)));

    expect(matched).toEqual([true, true, true, true]);
  });

  it("keyword 值里的正则字面量同样稳定（tags 场景）", async () => {
    const filter = useTableCustomFilter<Record<string, any>>({
      parseOptions: { keywords: ["tags"] },
      titleFields: ["title"],
    });
    await applyFilterText(filter, "tags:/1080p/g");

    const tags = ["a1080pb", "c1080pd", "e1080pf", "g1080ph"];
    const matched = tags.map((tag) =>
      filter.tableFilterFn(undefined, filter.tableFilterRef.value, { raw: { title: "t", tags: [tag] } }),
    );

    expect(matched).toEqual([true, true, true, true]);
  });
});

describe("范围筛选的零值边界", () => {
  it("size:0-5GB 保留零下界，匹配范围内的种子", async () => {
    const filter = useTableCustomFilter<Record<string, any>>({
      parseOptions: { ranges: ["size"] },
      titleFields: ["title"],
      format: { size: "size" },
    });
    await applyFilterText(filter, "size:0-5GB");

    expect(runFilter(filter, { title: "small", size: 2 * 1024 ** 3 })).toBe(true);
    expect(runFilter(filter, { title: "large", size: 6 * 1024 ** 3 })).toBe(false);
  });

  it("零下界经快捷筛选的字典生成与解析后仍生效", async () => {
    const filter = useTableCustomFilter<Record<string, any>>({
      parseOptions: { ranges: ["updateAt"] },
      titleFields: ["site"],
      format: { updateAt: { parse: Number, build: String } },
    });
    const startOfToday = new Date(2026, 9, 5).getTime();
    filter.advanceFilterDictRef.value.updateAt = [0, startOfToday - 1];
    await applyFilterText(filter, filter.stringifyFilterDictFn());

    expect(runFilter(filter, { site: "old", updateAt: startOfToday - 1000 })).toBe(true);
    expect(runFilter(filter, { site: "today", updateAt: startOfToday + 1000 })).toBe(false);
    expect(runFilter(filter, { site: "never", updateAt: 0 })).toBe(true);
  });
});

describe("搜索结果预设范围", () => {
  it("阈值超过当前结果最大值时保持阈值，不错误地命中最大值", async () => {
    const filter = useTableCustomFilter({
      parseOptions: { ranges: ["seeders"] },
      titleFields: ["title"],
      initialItems: [{ title: "one", seeders: 3 }],
    });
    filter.advanceFilterDictRef.value.seeders = [10, Infinity];
    await applyFilterText(filter, filter.stringifyFilterDictFn());
    expect(runFilter(filter, { title: "one", seeders: 3 })).toBe(false);
    expect(runFilter(filter, { title: "two", seeders: 11 })).toBe(true);
  });
});
