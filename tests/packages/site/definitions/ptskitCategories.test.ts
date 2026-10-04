/**
 * ptskit 分类参数的守卫（审查报告 B-20a 及其后续）。
 *
 * 背景（这是一个**真实发生过**的回归）：ptskit 原本有两个分类组共用 `key: "cat"`，
 * 于是勾选一组会清掉另一组。修复方式是让 key 唯一、并用 `cross.key` 还原真正要发的参数名——
 * 但当时用**批量替换**把 `cross: { mode: "append", key: "cat" }` 套到了**全部 6 个分类组**，
 * 导致「媒介/编码/分辨率/制作组」四组不再发 `medium1=1` 这类参数，而是塌成 `cat1=1`：
 * 四个筛选静默失效，并污染 cat 命名空间。
 *
 * 本文件用**真实的生成器**（`generateSiteSearchSolution`）+ **真实的站点定义**（ptskit 的 category）
 * 断言六组各自发出的参数名。它之所以必要：`grep -rln ptskit tests/` 在此之前为空，
 * 也就是说这类回归可以毫无阻挡地再次发生。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 生成器所在的模块会连带引入平台适配层（messages.ts 用到 __BROWSER__ 与 chrome API），
// 因此必须在 import 之前把全局桩准备好 —— vi.hoisted 的回调先于所有 import 执行。
vi.hoisted(() => {
  (globalThis as any).__BROWSER__ = "chrome";
  (globalThis as any).chrome ??= {
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    runtime: { id: "test", onMessage: { addListener: () => undefined, removeListener: () => undefined } },
  };
});

const mocks = vi.hoisted(() => ({
  category: undefined as unknown,
}));

vi.mock("@/options/stores/metadata.ts", () => ({
  useMetadataStore: () => ({
    getSiteMergedMetadata: async (_siteId: string, field: string, defaultValue: unknown) =>
      field === "category" ? mocks.category : defaultValue,
  }),
}));

import { siteMetadata as ptskitMetadata } from "@ptd/site/definitions/ptskit.ts";

import {
  generateSiteSearchSolution,
  radioDefault,
  type TSelectCategory,
} from "@/options/views/Settings/SetSearchSolution/utils.ts";

type Category = { key: string; cross?: { mode: string; key?: string } };

const categories = (ptskitMetadata.category ?? []) as Category[];

/** 取某个分类组的 key（并断言它确实存在，避免测试因为改名而静默变成空转） */
function categoryKey(name: string): string {
  const found = categories.find((c) => (c as unknown as { name?: string }).name === name);
  expect(found, `ptskit 应存在名为「${name}」的分类组`).toBeDefined();
  return found!.key;
}

async function paramsFor(selections: Record<string, unknown>): Promise<Record<string, unknown>> {
  const selectCategory = {} as TSelectCategory;
  for (const category of categories) {
    selectCategory[category.key] = radioDefault;
  }
  for (const [key, value] of Object.entries(selections)) {
    selectCategory[key] = value as never;
  }

  const solution = await generateSiteSearchSolution("ptskit", selectCategory);
  // 注意：`searchEntries` 是 Record<生成的id, entriesConfig>（不是数组），所以取第一个值
  const entry = Object.values(solution.searchEntries ?? {})[0] as
    { requestConfig?: { params?: Record<string, unknown> } } | undefined;
  return entry?.requestConfig?.params ?? {};
}

describe("ptskit：六个分类组各自发出的参数名（B-20a 反回归）", () => {
  beforeEach(() => {
    mocks.category = ptskitMetadata.category;
  });

  it("两个「分类」组发 cat{N}（它们原本共用 key: cat，正是 B-20a 的根因）", async () => {
    const normal = categoryKey("分类（综合）");
    const special = categoryKey("分类（十八禁）");

    expect(await paramsFor({ [normal]: [402] })).toEqual({ cat402: 1 });
    expect(await paramsFor({ [special]: [412] })).toEqual({ cat412: 1 });
  });

  it("媒介/编码/分辨率/制作组必须发各自的 {key}{value}，**不能**是 cat{N}", async () => {
    // 这四条是回归探针：把任意一组的 `cross.key` 设成 "cat" 都会让它们变红。
    expect(await paramsFor({ medium: [1] })).toEqual({ medium1: 1 });
    expect(await paramsFor({ codec: [1] })).toEqual({ codec1: 1 });
    expect(await paramsFor({ standard: [1] })).toEqual({ standard1: 1 });
    expect(await paramsFor({ team: [1] })).toEqual({ team1: 1 });
  });

  it("多选时逐项展开为 {key}{value}（append 语义）", async () => {
    expect(await paramsFor({ medium: [1, 9] })).toEqual({ medium1: 1, medium9: 1 });
    expect(await paramsFor({ codec: [1, 2] })).toEqual({ codec1: 1, codec2: 1 });
  });

  it("六组同时勾选时没有任何参数塌成 cat1..cat4（回归的典型症状）", async () => {
    const normal = categoryKey("分类（综合）");
    const special = categoryKey("分类（十八禁）");

    const params = await paramsFor({
      [normal]: [402],
      [special]: [412],
      medium: [1],
      codec: [2],
      standard: [3],
      team: [4],
    });

    expect(params).toEqual({ cat402: 1, cat412: 1, medium1: 1, codec2: 1, standard3: 1, team4: 1 });
    // 回归时这四组会分别变成 cat1/cat1/cat1/cat1（并覆盖上面的分类选择）
    for (const wrong of ["cat1", "cat2", "cat3", "cat4"]) {
      expect(params, `不应出现被错置的 ${wrong}`).not.toHaveProperty(wrong);
    }
  });
});
