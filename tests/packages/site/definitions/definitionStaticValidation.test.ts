/**
 * TESTS-9：跨站点定义的静态校验。
 *
 * 背景：341 个 `src/packages/site/definitions/*.ts` 里此前只有 8 个被任何用例读取，
 * 上一轮清单里的定义层缺陷（H-12、D-4/D-5/D-6/D-8/D-9/D-34 等）没有回归网 ——
 * 「参数名写错 / 选择器指向旧布局」这两类问题类型检查与构建都看不见，第四轮会再次全绿地复发。
 * 本文件对所有定义做**跨定义**的不变量校验（单站点行为回归仍由 definitionFixes.test.ts 等负责）：
 *
 * - 定义可被加载、`id` 与文件名一致且全局唯一；
 * - 具名 filter 必须来自 `@ptd/site/utils/filter.ts` 的 definedFilters（写错名字 = 静默不筛选）；
 * - 时间格式串不得包含 date-fns v4 已删除的 token（`YYYY`/`YY`/`DD`/`D`）；
 * - `category` 分组：key 唯一、首字母小写（D-34：大写 key 会让 PHP 侧键名不匹配）、
 *   `cross.key` 不含 `[]`（D-4：brackets 会自行补 `[]`，多写一层会发出 `category[][0]`）；
 * - `search.selectors.rows` 若定义则选择器非空；
 * - `seeders` 与 `leechers` 不能是同一个查询（D-8：复制粘贴后两个字段都取到种子数）；
 * - `urls` 非空。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

const definitionModules = import.meta.glob("../../../../src/packages/site/definitions/*.ts");

interface IDefinition {
  fileId: string;
  path: string;
  metadata: any;
}

const definitions: IDefinition[] = [];
let filterNames = new Set<string>();

/** 收集一个配置子树里所有「选择器查询」对象（含 filters / switchFilters / selector 的对象） */
function collectQueries(node: unknown, out: any[], seen = new Set<unknown>()): void {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectQueries(item, out, seen);
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.filters || record.switchFilters || record.selector !== undefined) out.push(record);
  for (const value of Object.values(record)) collectQueries(value, out, seen);
}

/** 取出一个查询里所有具名 filter（函数式 filter 直接跳过：它们不需要登记在 definedFilters） */
function namedFilters(query: any): Array<{ name: string; args?: unknown[] }> {
  const entries = [...(query.filters ?? []), ...Object.values(query.switchFilters ?? {}).flat()] as any[];
  return entries.filter(
    (filter): filter is { name: string; args?: unknown[] } =>
      !!filter && typeof filter === "object" && typeof filter.name === "string",
  );
}

/** 所有的 (定义, 查询) 对：search / searchEntry / detail / userInfo / list */
function allQueries(metadata: any): Array<{ id: string; query: any }> {
  const queries: any[] = [];
  for (const section of [
    metadata.search,
    (metadata as any).searchEntry,
    metadata.detail,
    metadata.userInfo,
    metadata.list,
  ]) {
    collectQueries(section, queries);
  }
  return queries.map((query) => ({ id: metadata.id, query }));
}

/** 结构签名：函数按引用区分（否则两个不同 elementProcess 会被 JSON 抹成同一个签名） */
function sameSignature(left: unknown, right: unknown): boolean {
  // 函数 id 必须在同一次比较内分配，否则不同函数会各自拿到 fn#0 而被误判为相同
  const fnIds = new Map<unknown, number>();
  const signature = (value: unknown) =>
    JSON.stringify(value, (_key, item) => {
      if (typeof item === "function") {
        if (!fnIds.has(item)) fnIds.set(item, fnIds.size);
        return `fn#${fnIds.get(item)}`;
      }
      return item;
    });
  return signature(left) === signature(right);
}

beforeAll(async () => {
  const { definedFilters } = await import("@ptd/site/utils/filter.ts");
  filterNames = new Set(Object.keys(definedFilters));

  for (const [path, loader] of Object.entries(definitionModules)) {
    const metadata = ((await loader()) as any)?.siteMetadata;
    definitions.push({ fileId: path.split("/").pop()!.replace(/\.ts$/, ""), path, metadata });
  }
});

describe("站点点定义的跨定义静态不变量（TESTS-9）", () => {
  it("扫描不是空跑：341 个定义全部可加载，且 definedFilters 有内容", () => {
    expect(Object.keys(definitionModules).length).toBeGreaterThan(300);
    expect(definitions).toHaveLength(Object.keys(definitionModules).length);
    expect(filterNames.size).toBeGreaterThan(10);
    const withoutMetadata = definitions.filter((item) => !item.metadata?.id).map((item) => item.path);
    expect(withoutMetadata, "定义必须导出 siteMetadata.id").toEqual([]);
  });

  it("id 与文件名一致、符合 [0-9a-z]+ 且全局唯一", () => {
    const problems: string[] = [];
    const seen = new Map<string, string>();

    for (const { fileId, metadata } of definitions) {
      if (metadata.id !== fileId) problems.push(`${fileId}: id=${metadata.id} 与文件名不一致`);
      if (!/^[0-9a-z]+$/.test(metadata.id)) problems.push(`${fileId}: id=${metadata.id} 含非法字符`);
      const previous = seen.get(metadata.id);
      if (previous) problems.push(`${fileId}: id=${metadata.id} 与 ${previous} 重复`);
      seen.set(metadata.id, fileId);
    }

    expect(problems, "站点 id 必须唯一且与文件名一致").toEqual([]);
  });

  it("具名 filter 必须属于 definedFilters，且不使用 date-fns v4 已删除的时间 token", () => {
    const unknownFilters: string[] = [];
    const badDateTokens: string[] = [];
    let namedFilterCount = 0;

    for (const { metadata } of definitions) {
      for (const { id, query } of allQueries(metadata)) {
        for (const filter of namedFilters(query)) {
          namedFilterCount++;
          if (!filterNames.has(filter.name)) unknownFilters.push(`${id}: ${filter.name}`);

          for (const arg of filter.args ?? []) {
            if (typeof arg !== "string") continue;
            // date-fns v4 删除了 YYYY / YY / DD / D（大写 token），留着会让 parse 抛错或解析成别的日期
            if (/(^|[^a-zA-Z])(YYYY|YY|DD|D)([^a-zA-Z]|$)/.test(arg)) {
              badDateTokens.push(`${id}: ${filter.name}("${arg}")`);
            }
          }
        }
      }
    }

    // 自证：遍历必须真的走到大量具名 filter，否则上面两条断言是空跑
    expect(namedFilterCount, "没有扫到具名 filter，说明 queries 遍历坏了").toBeGreaterThan(500);
    expect(unknownFilters, "filter 名写错时筛选会静默失效").toEqual([]);
    expect(badDateTokens, "时间格式串里出现 date-fns v4 已删除的 token").toEqual([]);
  });

  it("category 分组的 key 唯一且小写，cross.key 不含 []（H-12 / D-4 / D-34）", () => {
    const duplicateKeys: string[] = [];
    const upperCaseKeys: string[] = [];
    const bracketedCrossKeys: string[] = [];
    let categoryGroupCount = 0;

    for (const { metadata } of definitions) {
      const keys = new Set<string>();
      for (const group of (metadata.category ?? []) as any[]) {
        categoryGroupCount++;
        if (keys.has(group.key)) duplicateKeys.push(`${metadata.id}: ${group.key}`);
        keys.add(group.key);

        if (/^[A-Z]/.test(group.key)) upperCaseKeys.push(`${metadata.id}: ${group.key}`);

        if (typeof group.cross === "object" && group.cross?.key && /[[\]]/.test(group.cross.key)) {
          bracketedCrossKeys.push(`${metadata.id}: ${group.key} -> cross.key="${group.cross.key}"`);
        }
      }
    }

    expect(categoryGroupCount, "没有扫到 category 分组，说明定义结构变了").toBeGreaterThan(100);
    expect(duplicateKeys).toEqual([]);
    expect(upperCaseKeys, "分组 key 大写会被 PHP 侧按区分大小写拒收，整条筛选静默失效").toEqual([]);
    expect(bracketedCrossKeys, "brackets 模式会自行补 []，cross.key 里多写一层会发出嵌套数组").toEqual([]);
  });

  it("search.selectors.rows 若定义则非空；urls 必须非空", () => {
    const emptyRows: string[] = [];
    const missingUrls: string[] = [];

    for (const { metadata } of definitions) {
      const selector = metadata.search?.selectors?.rows?.selector;
      if (selector !== undefined) {
        const isEmpty =
          (typeof selector === "string" && selector.trim() === "") ||
          (Array.isArray(selector) &&
            (selector.length === 0 ||
              selector.some((item: unknown) => typeof item === "string" && item.trim() === "")));
        if (isEmpty) emptyRows.push(metadata.id);
      }

      if (!Array.isArray(metadata.urls) || metadata.urls.length === 0) missingUrls.push(metadata.id);
    }

    expect(emptyRows).toEqual([]);
    expect(missingUrls).toEqual([]);
  });

  it("seeders 与 leechers 不能是同一个查询（D-8：复制粘贴后两个字段取到同一个数）", () => {
    const identicalQueries: string[] = [];

    for (const { metadata } of definitions) {
      const selectors = metadata.search?.selectors;
      if (!selectors?.seeders || !selectors?.leechers) continue;
      // 源站明确不提供该字段时约定写 text: "N/A"，两者同为 N/A 是合法的
      if (selectors.seeders.text === "N/A" && selectors.leechers.text === "N/A") continue;

      if (sameSignature(selectors.seeders, selectors.leechers)) {
        identicalQueries.push(metadata.id);
      }
    }

    expect(identicalQueries, "seeders / leechers 指向同一查询时下载者数会等于做种数").toEqual([]);
  });
});
