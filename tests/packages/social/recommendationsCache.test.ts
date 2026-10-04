/**
 * `getSocialRecommendations` 来源级缓存的行为验证。
 *
 * 原缺陷：`canCacheRecommendationItems` 放宽为「只要有 items 就缓存整份结果」，
 * 任一来源失败/为空时，整份残缺结果仍被写入 ~6h 的长 TTL；
 * TTL 内普通刷新直接返回残缺列表，`hasFailedSources` 为 true 却不会补抓失败来源（只有 flush 能绕过）。
 *
 * 修复后：只有"非空成功"的来源写缓存，失败/为空的来源下次普通刷新一定重新请求；
 * 成功来源仍按 TTL 复用。`hasFailedSources` 的对外语义不变。
 *
 * 所有推荐来源都是 douban（kind 为 douban*），因此不会触达 `./index.ts` 的动态导入，
 * 这里只需 mock axios。
 */
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canCacheRecommendationItems, getSocialRecommendations } from "@ptd/social/recommendations.ts";

const FAILED_URL =
  "https://m.douban.com/rexxar/api/v2/subject_collection/tv_domestic/items?items_only=1&start=0&count=10";
const EMPTY_URL =
  "https://m.douban.com/rexxar/api/v2/subject_collection/tv_variety_show/items?items_only=1&start=0&count=10";

let requestedUrls: string[] = [];
let failingUrls: Set<string>;
let emptyUrls: Set<string>;

function successResponseFor(url: string) {
  if (url.includes("subject_collection")) {
    return { data: { subject_collection_items: [{ id: url, title: `SC ${url}` }] } };
  }

  return { data: { subjects: [{ id: url, title: `SS ${url}` }] } };
}

beforeEach(() => {
  requestedUrls = [];
  failingUrls = new Set();
  emptyUrls = new Set();

  vi.spyOn(axios, "get").mockImplementation(((url: string) => {
    requestedUrls.push(url);

    if (failingUrls.has(url)) {
      return Promise.reject(new Error(`mock failure for ${url}`));
    }

    if (emptyUrls.has(url)) {
      return Promise.resolve({ data: { subject_collection_items: [] } });
    }

    return Promise.resolve(successResponseFor(url));
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("canCacheRecommendationItems", () => {
  it("只把非空结果视为可缓存", () => {
    expect(canCacheRecommendationItems([])).toBe(false);
    expect(canCacheRecommendationItems([{ category: "movie" }])).toBe(true);
  });
});

describe("getSocialRecommendations 来源级缓存", () => {
  it("部分失败时不缓存残缺结果，下一次普通刷新只补抓失败来源", async () => {
    failingUrls = new Set([FAILED_URL]);

    const first = await getSocialRecommendations({ flush: true });
    expect(first.hasFailedSources).toBe(true);
    expect(first.items.length).toBeGreaterThan(0);

    requestedUrls = [];
    const second = await getSocialRecommendations();

    expect(second.hasFailedSources).toBe(true); // 对外语义不变
    expect(second.items).toEqual(first.items); // 成功来源仍复用，列表不残缺变化
    expect(requestedUrls).toEqual([FAILED_URL]); // 只重抓失败来源
  });

  it("成功但为空的来源同样不缓存，下次刷新会重抓", async () => {
    emptyUrls = new Set([EMPTY_URL]);

    const first = await getSocialRecommendations({ flush: true });
    expect(first.hasFailedSources).toBe(true);
    expect(first.items.length).toBeGreaterThan(0);

    requestedUrls = [];
    const second = await getSocialRecommendations();

    expect(second.hasFailedSources).toBe(true);
    expect(requestedUrls).toEqual([EMPTY_URL]);
  });

  it("全部成功时命中来源级缓存，普通刷新不再发请求", async () => {
    const first = await getSocialRecommendations({ flush: true });
    expect(first.hasFailedSources).toBe(false);
    expect(first.items.length).toBeGreaterThan(0);

    requestedUrls = [];
    const second = await getSocialRecommendations();

    expect(second.hasFailedSources).toBe(false);
    expect(second.items).toEqual(first.items);
    expect(requestedUrls).toEqual([]);
  });

  it("flush 会忽略来源级缓存、重新抓取全部来源", async () => {
    await getSocialRecommendations({ flush: true });
    const allSourceUrls = [...requestedUrls];

    requestedUrls = [];
    await getSocialRecommendations({ flush: true });

    expect(new Set(requestedUrls)).toEqual(new Set(allSourceUrls));
    expect(requestedUrls.length).toBe(allSourceUrls.length);
  });
});
