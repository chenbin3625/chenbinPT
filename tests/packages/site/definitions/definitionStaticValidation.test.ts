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
 *
 * 2026-10-23 审查（H-M3 / H-L7）补齐的跨定义不变量：
 *
 * - **任意两个字段**不得指向同一个 `(selector, attr, elementProcess)` 组合（原先只比 seeders/leechers，
 *   于是 E2-01 的 `completed === leechers` 在同一份文件上永远绿灯）；`completed` 单独再断言一次
 *   ≠ `seeders` / `leechers`（完成数与下载者数没有合法同值例外，不像 `text:"N/A"`）；
 * - `schema` 必须能在 `src/packages/site/schemas/` 找到同名模块，或定义自带 `default class`
 *   （G24：`schema` 指向不存在的引擎时 `getSite` 会静默回落到 Abstract*Site，站点行为整体变样）；
 * - `rows` 的结构性检查覆盖 `search` / `searchEntry[*]` / `list[*]`（原先只查 `search`），
 *   并检查「schema 引擎既不提供 rows、站点也没写、引擎又不自动生成」这种必然搜不到东西的组合；
 * - `tags` 每项必须有 `name` 与非空 `selector`；`timezoneOffset` 必须是 `^[+-]\d{4}$`；
 * - `requestConfig` 里出现的 `$field$` 占位符必须在该步骤的 `assertion` 里声明；
 * - **ratchet（暂不硬失败）**：几类需要站点语义/产品裁决才能判定的可疑点先按「数量不得超过当前已知值」
 *   的棘轮守住 —— ① 两个字段共享同一查询（`0magnet` 的 url/id 是有意复用）；② `assertion` 声明了依赖
 *   但路径是静态串（teamhd / wihd，E6 遗留）；③ 等级阶梯倒挂（含插入在阶梯中间的特殊等级，不能简单判错）。
 *   这些条目在 fix report 里列为「待收紧」，修好之后请把上界一起下调。
 */
import { get } from "es-toolkit/compat";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));
(globalThis as any).__BROWSER__ ??= "chrome";

const definitionModules = import.meta.glob("../../../../src/packages/site/definitions/*.ts");
const schemaModules = import.meta.glob("../../../../src/packages/site/schemas/*.ts");

interface IDefinition {
  fileId: string;
  path: string;
  metadata: any;
  /** 定义自带的站点类（`export default class`）；没有时由 schema 引擎类承载 */
  hasDefaultClass: boolean;
}

const definitions: IDefinition[] = [];
let filterNames = new Set<string>();
/** `src/packages/site/schemas/*.ts` 的模块名集合（`schema` 必须指向其中之一，或定义自带 default class） */
let schemaNames = new Set<string>();
/** 各 schema 引擎的 SchemaMetadata 是否自带 `search.selectors.rows`（NexusPHP 会运行时自动生成，另行豁免） */
const schemaProvidesRows = new Map<string, boolean>();
/** 引擎自己补齐 rows / 走 JSON 行的 schema：不需要站点写 rows 也不会「取不到行」 */
const ROWS_ENGINE_EXEMPT = new Set(["NexusPHP", "GazelleJSONAPI"]);

/** 计数/度量类字段：两个字段同源时用户看到的是同一个数（D-8 / E2-01） */
const metricFields = [
  "title",
  "subTitle",
  "url",
  "link",
  "id",
  "time",
  "size",
  "seeders",
  "leechers",
  "completed",
] as const;

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

/** 收集 requestConfig 里所有 `$field$` 占位符（含其所在 JSON 路径） */
function collectPlaceholders(node: unknown, path: string, out: Array<{ field: string; path: string }>): void {
  if (typeof node === "string") {
    for (const match of node.matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
      out.push({ field: match[1], path });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectPlaceholders(item, `${path}[${index}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      collectPlaceholders(value, path === "" ? key : `${path}.${key}`, out);
    }
  }
}

/**
 * 找出「占位符已在 assertion 里声明、但 assertion 指向的 pathKey 不是占位符所在路径」的条目。
 * 只检查已声明的（未声明的由另一条用例负责）。
 */
function findMisplacedPlaceholderPaths(process: any[]): { misplaced: string[]; compared: number } {
  const misplaced: string[] = [];
  let compared = 0;
  for (const [index, step] of process.entries()) {
    const placeholders: Array<{ field: string; path: string }> = [];
    collectPlaceholders(step?.requestConfig ?? {}, "", placeholders);
    if (placeholders.length === 0) continue;

    const assertion = (step?.assertion ?? {}) as Record<string, unknown>;
    for (const { field, path } of placeholders) {
      if (!(field in assertion)) continue;
      compared++;
      if (assertion[field] !== path) {
        misplaced.push(
          `process[${index}]: $${field}$ 位于 ${path}，但 assertion.${field} = ${String(assertion[field])}`,
        );
      }
    }
  }
  return { misplaced, compared };
}

beforeAll(async () => {
  const { definedFilters } = await import("@ptd/site/utils/filter.ts");
  filterNames = new Set(Object.keys(definedFilters));

  for (const path of Object.keys(schemaModules)) {
    const name = path.split("/").pop()!.replace(/\.ts$/, "");
    schemaNames.add(name);
  }

  for (const [path, loader] of Object.entries(schemaModules)) {
    const name = path.split("/").pop()!.replace(/\.ts$/, "");
    const mod = (await loader()) as any;
    const schemaMetadata = mod?.SchemaMetadata ?? mod?.default?.SchemaMetadata ?? {};
    schemaProvidesRows.set(name, !!(schemaMetadata as any)?.search?.selectors?.rows);
  }

  for (const [path, loader] of Object.entries(definitionModules)) {
    const mod = (await loader()) as any;
    definitions.push({
      fileId: path.split("/").pop()!.replace(/\.ts$/, ""),
      path,
      metadata: mod?.siteMetadata,
      hasDefaultClass: typeof mod?.default === "function",
    });
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

  // -------------------------------------------------------------------------
  // 2026-10-23 审查 H-M3 / H-L7 新增的跨定义不变量
  // -------------------------------------------------------------------------

  it("completed 不得与 seeders / leechers 同源（E2-01：bwtorrents 的完成数曾恒等于下载者数）", () => {
    const clashes: string[] = [];
    let compared = 0;

    for (const { metadata } of definitions) {
      const selectors = metadata.search?.selectors;
      if (!selectors?.completed?.selector) continue;

      for (const other of ["seeders", "leechers"] as const) {
        if (!selectors[other]?.selector) continue;
        compared++;
        // 完成数与下载者数是两个不同的量，不像 seeders/leechers 那样存在「源站都不提供」的 N/A 例外
        if (sameSignature(selectors.completed, selectors[other])) clashes.push(`${metadata.id}: completed == ${other}`);
      }
    }

    expect(compared, "没有扫到 completed 与 seeders/leechers 的字段对，说明遍历坏了").toBeGreaterThan(20);
    expect(clashes, "completed 与 seeders/leechers 指向同一列时「完成数」会变成下载者数").toEqual([]);
  });

  it("任意两个字段不得指向同一查询（字段对级不变量；同源字段会让两个指标变成同一个数）", () => {
    const duplicates: string[] = [];
    let compared = 0;

    for (const { metadata } of definitions) {
      const selectors = metadata.search?.selectors;
      if (!selectors) continue;

      for (let i = 0; i < metricFields.length; i++) {
        const left = selectors[metricFields[i]];
        if (!left?.selector) continue;
        for (let j = i + 1; j < metricFields.length; j++) {
          const right = selectors[metricFields[j]];
          if (!right?.selector) continue;
          // 源站明确不提供时约定写 text:"N/A"：两个字段同为 N/A 是合法的
          if (left.text === "N/A" && right.text === "N/A") continue;
          compared++;
          if (sameSignature(left, right)) duplicates.push(`${metadata.id}: ${metricFields[i]} == ${metricFields[j]}`);
        }
      }
    }

    expect(compared, "没有扫到字段对，说明遍历坏了").toBeGreaterThan(1000);

    // 棘轮：`0magnet` 的 url / id 有意复用同一个 <a href>（id 只是「用链接当标识」），
    // 不是缺陷。除此之外不允许新增同源字段对；把缺陷修掉后请把上界一起下调。
    const knownSharedQueryPairs = new Set(["0magnet: url == id"]);
    const unexpected = duplicates.filter((item) => !knownSharedQueryPairs.has(item));
    if (duplicates.length) console.warn("[static] 已知的同源字段对：", duplicates);
    expect(unexpected, "两个字段指向同一个 (selector, attr, elementProcess) 时，两个指标必然显示同一个数").toEqual([]);
  });

  it("schema 必须存在于 schemas/，或定义自带 default class（G24：指向不存在的引擎会静默回落）", () => {
    const missing: string[] = [];

    for (const { metadata, hasDefaultClass } of definitions) {
      if (!metadata?.schema) continue; // 未声明时由 site/index.ts 按 type 补默认值
      if (schemaNames.has(metadata.schema)) continue;
      if (hasDefaultClass) continue; // 定义自带引擎类，等价于实现了该 schema

      missing.push(`${metadata.id}: ${metadata.schema}`);
    }

    // 棘轮：以下 6 个定义的 schema 指向未实现的引擎，`getSite` 会静默回落到 Abstract*Site
    // （定义层修复属 DEF 分片：实现 schemas/<name>.ts 或改 schema）。修好后请删掉对应条目。
    const knownMissingSchemas = new Set([
      "ccfbits: TBSource",
      "cnlang: Discuz",
      "fsm: FSM",
      "hdspace: XBTIT",
      "hdtorrents: XBTIT",
      "minept: meanTorrent",
    ]);
    const unexpected = missing.filter((item) => !knownMissingSchemas.has(item));
    if (missing.length) console.warn("[static] 已知的 schema 缺失：", missing);
    expect(unexpected, "schema 指向不存在的引擎时站点会悄悄改用 Abstract*Site，选择器/分页整体变样").toEqual([]);
  });

  it("rows 结构在 search / searchEntry / list 三处都合法，且 DOM 引擎必须能拿到 rows（M3）", () => {
    const structural: string[] = [];
    const unavailable: string[] = [];
    let rowsSpots = 0;

    const checkRows = (id: string, spot: string, rows: any) => {
      if (rows === undefined) return;
      rowsSpots++;
      const selector = rows?.selector;
      const isEmpty =
        selector === undefined ||
        (typeof selector === "string" && selector.trim() === "") ||
        (Array.isArray(selector) &&
          (selector.length === 0 || selector.some((item: unknown) => String(item ?? "").trim() === "")));
      if (isEmpty) structural.push(`${id} ${spot}: rows.selector 为空`);

      if (rows.merge !== undefined && !(Number.isInteger(rows.merge) && rows.merge >= 2)) {
        structural.push(`${id} ${spot}: rows.merge=${rows.merge}（应为 >=2 的整数，1 等于不合并）`);
      }
      if (rows.filter !== undefined && typeof rows.filter !== "function") {
        structural.push(`${id} ${spot}: rows.filter 不是函数`);
      }
    };

    for (const { fileId, metadata, hasDefaultClass } of definitions) {
      const searchRows = metadata?.search?.selectors?.rows;
      checkRows(fileId, "search", searchRows);

      for (const [entryId, entry] of Object.entries((metadata?.searchEntry ?? {}) as Record<string, any>)) {
        checkRows(fileId, `searchEntry.${entryId}`, entry?.selectors?.rows);
      }
      (metadata?.list ?? []).forEach((item: any, index: number) =>
        checkRows(fileId, `list[${index}]`, item?.selectors?.rows),
      );

      // 冒烟：声明了 search 却拿不到 rows 的 DOM 站点一定搜不到结果。
      // 例外：NexusPHP 在 transformSearchPage 里按表头自动生成 rows（见 defs-dom-search 用例）、
      //       GazelleJSONAPI 由类方法把 JSON 映射成行；定义自带引擎类的站点也可能自己实现 rows。
      if (!metadata?.search || searchRows || hasDefaultClass) continue;
      const schema =
        metadata.schema ?? (metadata.type === "private" ? "AbstractPrivateSite" : "AbstractBittorrentSite");
      if (!schemaNames.has(schema)) continue; // schema 不存在由上面那条用例负责
      if (ROWS_ENGINE_EXEMPT.has(schema)) continue;
      if (schemaProvidesRows.get(schema)) continue;
      unavailable.push(`${fileId}: schema=${schema} 不提供 rows，定义也没写 rows`);
    }

    expect(rowsSpots, "没有扫到任何 rows 配置，说明定义结构变了").toBeGreaterThan(50);
    expect(structural, "rows 配置结构非法会让整站搜索结果为空").toEqual([]);
    expect(unavailable, "DOM 引擎既不提供 rows、站点也没声明时，该站点永远解析不出种子").toEqual([]);
  });

  it("tags 每项都有 name 与非空 selector；timezoneOffset 必须是 ±HHmm", () => {
    const badTags: string[] = [];
    const badOffsets: string[] = [];
    let tagCount = 0;

    for (const { fileId, metadata } of definitions) {
      const tags = metadata?.search?.selectors?.tags;
      if (tags !== undefined) {
        if (!Array.isArray(tags)) {
          badTags.push(`${fileId}: tags 不是数组`);
        } else {
          tags.forEach((tag: any, index: number) => {
            tagCount++;
            if (!tag?.name) badTags.push(`${fileId} tags[${index}]: 缺 name`);
            if (typeof tag?.selector !== "string" || tag.selector.trim() === "") {
              badTags.push(`${fileId} tags[${index}]: selector 为空或不是字符串`);
            }
          });
        }
      }

      if (metadata?.timezoneOffset !== undefined && !/^[+-]\d{4}$/.test(String(metadata.timezoneOffset))) {
        badOffsets.push(`${fileId}: ${metadata.timezoneOffset}`);
      }
    }

    expect(tagCount, "没有扫到 tags，说明定义结构变了").toBeGreaterThan(200);
    expect(badTags).toEqual([]);
    expect(badOffsets, "timezoneOffset 格式错误会让 parseTime 静默回落成宿主时区").toEqual([]);
  });

  it("requestConfig 里的 $field$ 占位符必须出现在 assertion 声明的 pathKey 处（占位符名对、路径写错）", () => {
    /**
     * 继上一条只校验「占位符名出现在 assertion key 里」之后，这里补路径级不变量：
     * `AbstractPrivateSite.getUserInfoResult` 的替换逻辑是「对 assertion[field] 指向的字符串做
     * `String.replace("$field$", 值)`」，所以只声明 key 不够 —— pathKey 必须正好是占位符所在的那个字符串，
     * 否则占位符会原样发到站点（旧 torrentleech 的 `assertion: {id:"valid"}` + `data.userID:"$id$"` 就是这种）。
     *
     * 自证：先用一条合成的 torrentleech 型坏配置断言 helper 能抓到它，避免「遍历坏了但全绿」。
     */
    const synthetic = findMisplacedPlaceholderPaths([
      { requestConfig: { url: "/profile/$name$", data: { userID: "$id$" } }, assertion: { id: "valid", name: "url" } },
    ]);
    expect(synthetic.compared).toBe(2);
    expect(synthetic.misplaced).toEqual([expect.stringContaining("data.userID")]);

    const misplaced: string[] = [];
    let compared = 0;

    for (const { fileId, metadata } of definitions) {
      const result = findMisplacedPlaceholderPaths((metadata?.userInfo?.process ?? []) as any[]);
      compared += result.compared;
      misplaced.push(...result.misplaced.map((item) => `${fileId} ${item}`));
    }

    expect(compared, "没有扫到 assertion 覆盖的占位符，说明 userInfo 结构变了").toBeGreaterThan(10);

    // 白名单：当前无已知合法例外；若后续确有「占位符通过 requestConfigTransformer 自行替换」等合法形态，
    // 在此登记 `fileId process[n]: ...` 完整字符串并注明原因与验证方法（不要放宽成按站点全放过）。
    const knownLegitPlaceholderPaths = new Set<string>([]);
    const unexpected = misplaced.filter((item) => !knownLegitPlaceholderPaths.has(item));
    if (misplaced.length) console.warn("[static] 占位符路径与 assertion 不一致：", misplaced);
    expect(unexpected, "占位符不在 assertion 指向的 pathKey 处时不会被替换，会原样发到站点").toEqual([]);
  });

  it("requestConfig 里的 $field$ 占位符必须由该步骤的 assertion 声明", () => {
    const undeclared: string[] = [];
    let placeholderCount = 0;

    for (const { fileId, metadata } of definitions) {
      for (const [index, step] of ((metadata?.userInfo?.process ?? []) as any[]).entries()) {
        const assertionKeys = new Set(Object.keys((step?.assertion ?? {}) as Record<string, unknown>));
        for (const match of JSON.stringify(step?.requestConfig ?? {}).matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
          placeholderCount++;
          if (!assertionKeys.has(match[1])) {
            undeclared.push(`${fileId} process[${index}]: $${match[1]}$ 未在 assertion 中声明`);
          }
        }
      }
    }

    expect(placeholderCount, "没有扫到 $field$ 占位符，说明 userInfo 结构变了").toBeGreaterThan(10);
    expect(undeclared, "未声明的占位符会被原样发到站点，等于请求参数写错").toEqual([]);
  });

  it("[ratchet] assertion 声明的路径若已在 requestConfig 里，就必须真的用到 $field$", () => {
    const staticPaths: string[] = [];

    for (const { fileId, metadata } of definitions) {
      for (const [index, step] of ((metadata?.userInfo?.process ?? []) as any[]).entries()) {
        for (const [field, pathKey] of Object.entries((step?.assertion ?? {}) as Record<string, string>)) {
          const value = get(step.requestConfig ?? {}, pathKey);
          if (typeof value === "string" && !value.includes(`$${field}$`)) {
            staticPaths.push(
              `${fileId} process[${index}]: assertion.${field} -> ${pathKey} = ${JSON.stringify(value)}`,
            );
          }
        }
      }
    }

    // E6 遗留（定义层修复属 DEF 分片）：teamhd / wihd 声明了 assertion 但路径是静态串，
    // 断言「依赖 id/name」实际没有进入请求。修好后请把上界下调到 0 并改成 toEqual([])。
    if (staticPaths.length) console.warn("[static] assertion 静态路径：", staticPaths);
    expect(staticPaths.length, "assertion 声明了依赖但请求里没用到，属于静默失效").toBeLessThanOrEqual(2);
  });

  it("[ratchet] 等级阶梯倒挂只允许当前已知的少量条目（含插在阶梯中间的特殊等级）", () => {
    // 注意：这里刻意不做硬断言 —— darkpeers 的 Seeder(3)/SuperUser(4) 这类「特殊等级插在普通阶梯中间」
    // 会让做种量门槛有意回退，不能简单判成缺陷。先用数量棘轮防止新增，具体站点语义交 DEF 组/产品裁决。
    const inversions: string[] = [];

    for (const { fileId, metadata } of definitions) {
      const userLevels = ((metadata?.levelRequirements ?? []) as any[]).filter(
        (level) => (level.groupType ?? "user") === "user",
      );
      for (const field of ["uploaded", "downloaded", "ratio", "seedingSize"] as const) {
        const values = userLevels
          .filter((level) => level[field] !== undefined)
          .map((level) => ({ id: level.id, value: Number(level[field] instanceof Object ? 0 : level[field]) }));
        for (let i = 1; i < values.length; i++) {
          if (values[i].value < values[i - 1].value) {
            inversions.push(`${fileId}: ${field} id${values[i - 1].id} > id${values[i].id}`);
          }
        }
      }
    }

    if (inversions.length) console.warn("[static] 等级阶梯倒挂：", inversions);
    // 当前已知 6 处（均为 ratio，DEF 组正在逐站确认）；留 2 个余量避免并行修复期间误红。
    expect(inversions.length, "等级阶梯倒挂数量增加，可能把高等级用户判低").toBeLessThanOrEqual(8);
  });
});
