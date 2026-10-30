/**
 * 站点定义轻量索引的字段契约测试（移植自上游 8c6022c98c / #1611 的 `checkMetadataIndexContract()`）。
 *
 * 上游把这条契约放在 `vite/checkSiteDefinition.ts`（构建前静态校验）里；fork 没有那个脚本，
 * 按 fork 的既有惯例（`tests/packages/site/utils/`）改成 vitest 行为断言。
 *
 * 索引的**值**不可能漂移 —— 每次构建都从站点定义现算（见 `vite/plugin/generateSiteIndex.ts`），
 * 没有需要提交的生成产物。唯一会漂的是这层「字段契约」：
 *
 *   · `INDEXED_METADATA_FIELDS` 里有、`pickSiteMetadataIndexEntry()` 没写
 *     → 消费方（`metadataStore.getSiteMergedMetadata`）以为能从索引取到，实际拿到 `undefined`，
 *       而且**不会回落**到完整定义（静默错值，最难查）；
 *   · 抽取函数写了、名单里没有 → 字段白白进索引却没人能查（索引体积白涨）；
 *   · `searchEntries` 少收了一个入口 → 「设置 → 站点 → 搜索入口」里少一项，且不报错。
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { ISiteMetadata } from "@ptd/site/types/site";
import {
  INDEXED_METADATA_FIELDS,
  isIndexedMetadataField,
  pickSiteMetadataIndexEntry,
} from "@ptd/site/utils/metadataIndex";

/**
 * 索引条目里除「可查询的固定属性」之外的键：都是从固定属性派生出来的标志 / 摘要。
 * 注意 `id` **不在这里** —— 它是索引的 key，条目本身不再存一份。
 */
const DERIVED_ENTRY_KEYS = ["hasUserInputSettingMeta", "hasSearch", "hasUserInfo", "searchEntries"];

/**
 * 每个固定属性都给一个真值，保证抽取函数里的 `if` 全部命中。
 * 取值只需真值性正确，所以不追求与 ISiteMetadata 的结构完全对齐，用 as 收口。
 */
const metadataWithEveryField = {
  id: "check-site-metadata-index",
  name: "Check",
  type: "private",
  schema: "NexusPHP",
  isDead: true,
  urls: ["https://example.com/"],
  legacyUrls: ["https://legacy.example.com/"],
  trackerUrls: ["https://tracker.example.com/announce"],
  aka: ["别名"],
  tags: ["综合"],
  version: 1,
  description: "检查用",
  userInputSettingMeta: [{ name: "cookie", label: "Cookie", hint: "", required: true }],
  search: { requestConfig: {} },
  userInfo: { selectors: {} },
  searchEntry: { default: { name: "默认" } },
} as unknown as ISiteMetadata;

/** 全量站点定义（`@ptd/site/index.ts` 的 `import.meta.glob` 由 Vite 展开） */
let getDefinedSiteMetadata: (siteId: string) => Promise<ISiteMetadata>;
let definitionList: string[];

beforeAll(async () => {
  // 站点定义链会读构建期常量（如 hdsky.ts 的 `__BROWSER__`）。单测环境没有 Vite define，
  // 必须在**动态 import 站点定义之前**补上，否则 ReferenceError。
  (globalThis as any).__BROWSER__ ??= "chrome";
  (globalThis as any).__RESOURCE_SITE_ICONS__ ??= [];
  (globalThis as any).__EXT_VERSION__ ??= "0.0.0-test";
  (globalThis as any).__GIT_VERSION__ ??= { short: "test", long: "test", date: 0, count: 0, branch: "test" };
  (globalThis as any).__BUILD_TIME__ ??= "0";

  ({ getDefinedSiteMetadata, definitionList } = await import("@ptd/site/index.ts"));
});

describe("INDEXED_METADATA_FIELDS ↔ pickSiteMetadataIndexEntry() 契约", () => {
  it("抽取函数实际写出的键 = 固定属性名单 + 派生键（一个不多、一个不少）", () => {
    const written = new Set(Object.keys(pickSiteMetadataIndexEntry(metadataWithEveryField)));
    const expected = new Set<string>([...INDEXED_METADATA_FIELDS, ...DERIVED_ENTRY_KEYS]);

    const missing = [...expected].filter((key) => !written.has(key));
    expect(
      missing,
      `INDEXED_METADATA_FIELDS 列了但 pickSiteMetadataIndexEntry() 没写出：${missing.join(", ")}。\n` +
        "消费方会以为能从索引取到这些字段，实际拿到 undefined，且不会回落到完整站点定义。",
    ).toEqual([]);

    const unexpected = [...written].filter((key) => !expected.has(key));
    expect(
      unexpected,
      `pickSiteMetadataIndexEntry() 写出了但既不在 INDEXED_METADATA_FIELDS 也不在派生键里：${unexpected.join(", ")}。\n` +
        "该字段进了索引却没人能查；若它是新加的固定属性，请一并加进 INDEXED_METADATA_FIELDS。",
    ).toEqual([]);
  });

  it("isIndexedMetadataField() 与名单一致（未收录字段必须返回 false，否则消费方不会回落完整定义）", () => {
    for (const field of INDEXED_METADATA_FIELDS) {
      expect(isIndexedMetadataField(field), `${field} 应命中索引`).toBe(true);
    }
    // 这些是「明确不进索引」的大对象 / 站点独有配置：命中就会让消费方不再回落完整定义
    for (const field of [
      "id",
      "category",
      "search",
      "userInfo",
      "searchEntry",
      "levelRequirements",
      "list",
      "favicon",
    ]) {
      expect(isIndexedMetadataField(field), `${field} 不应命中索引`).toBe(false);
    }
  });

  it("只写「有值」的字段：空 metadata 只得到 name / type / urls", () => {
    const entry = pickSiteMetadataIndexEntry({
      id: "minimal",
      name: "Minimal",
      type: "public",
      urls: ["https://minimal.example/"],
    } as unknown as ISiteMetadata);

    expect(Object.keys(entry).sort()).toEqual(["name", "type", "urls"]);
  });

  it("searchEntries 只保留 name / enabled 两个标量（入口自己的搜索参数含函数，进不了索引）", () => {
    const entry = pickSiteMetadataIndexEntry({
      ...metadataWithEveryField,
      searchEntry: {
        normal: { name: "普通搜索", enabled: false, requestConfig: { url: "/torrents.php" } },
        unnamed: { requestConfig: { url: "/x" } },
      } as ISiteMetadata["searchEntry"],
    });

    expect(entry.searchEntries).toEqual({ normal: { name: "普通搜索", enabled: false }, unnamed: { name: "unnamed" } });
  });
});

describe("索引结果与完整站点定义一致（抽样）", () => {
  it("索引里的 searchEntries 键集 = 完整定义 searchEntry 键集", async () => {
    const { siteMetadataIndex } = await import("@ptd/site/metadataIndex");

    // 索引里声明了 searchEntries 的站点（当前 20 个）。只对这些站点加载完整定义，
    // 避免为了这一条断言把 409 个 chunk 全部拉起来。
    const siteIdsWithSearchEntries = definitionList.filter((siteId) => !!siteMetadataIndex[siteId]?.searchEntries);
    expect(siteIdsWithSearchEntries.length).toBeGreaterThan(0);

    for (const siteId of siteIdsWithSearchEntries) {
      const fullMetadata = await getDefinedSiteMetadata(siteId);
      expect(fullMetadata.searchEntry, `${siteId} 完整定义应有 searchEntry`).toBeTruthy();

      const indexEntries = siteMetadataIndex[siteId]!.searchEntries!;
      expect(Object.keys(indexEntries).sort(), `${siteId} 的搜索入口 key 集合不一致`).toEqual(
        Object.keys(fullMetadata.searchEntry!).sort(),
      );

      for (const [key, entry] of Object.entries(fullMetadata.searchEntry!)) {
        expect(indexEntries[key]!.name, `${siteId}.${key} 的 name 不一致`).toBe(entry?.name ?? key);
        if (typeof entry?.enabled === "boolean") {
          expect(indexEntries[key]!.enabled, `${siteId}.${key} 的 enabled 不一致`).toBe(entry.enabled);
        } else {
          expect(indexEntries[key]!.enabled).toBeUndefined();
        }
      }
    }
  });

  it("索引里的固定属性 = 完整定义按同一函数抽取的结果（抽样，同时兜住「缓存过期」）", async () => {
    const { siteMetadataIndex } = await import("@ptd/site/metadataIndex");

    // 均匀抽样 + 全部 searchEntries 站点：前者覆盖各种站点类型，后者覆盖派生键
    const step = Math.max(1, Math.floor(definitionList.length / 12));
    const sampledSiteIds = [
      ...definitionList.filter((_, index) => index % step === 0),
      ...definitionList.filter((siteId) => !!siteMetadataIndex[siteId]?.searchEntries),
    ].slice(0, 40);

    for (const siteId of sampledSiteIds) {
      const fullMetadata = await getDefinedSiteMetadata(siteId);
      expect(siteMetadataIndex[siteId], `${siteId} 应在索引里`).toEqual(pickSiteMetadataIndexEntry(fullMetadata));
    }
  });

  it("索引覆盖 definitionList 里的每个站点（漏收录 = 消费方静默回落完整定义，等于没优化）", async () => {
    const { siteMetadataIndex } = await import("@ptd/site/metadataIndex");

    const missing = definitionList.filter((siteId) => !siteMetadataIndex[siteId]);
    expect(missing, `这些站点没有进索引：${missing.join(", ")}`).toEqual([]);
  });
});
