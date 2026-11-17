/**
 * 社交信息评分按数值解析的回归测试（#1717）。
 *
 * 豆瓣（以及部分 TMDb）页面 JSON-LD 的 aggregateRating.ratingValue / ratingCount 是字符串（如 "7.5"），
 * 而 ISocialInformation 约定评分为数字。修复前内置解析器原样赋值，字符串经 IndexedDB 缓存流到热门推荐，
 * 在 `ratingScore.toFixed(1)` 处抛 TypeError，整条推荐因此渲染不出来。
 */
import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

// douban.ts 经 imdb.ts 引入 @ptd/site 的日志出口（依赖扩展消息通道），这里只需要空实现
vi.mock("@ptd/site/utils/adapter.ts", () => ({ logMessage: vi.fn() }));

import { fetchInformation as fetchDoubanInformation } from "@ptd/social/entity/douban.ts";
import { fetchInformation as fetchTmdbInformation } from "@ptd/social/entity/tmdb.ts";

function ldJsonDocument(title: string, ldJson: Record<string, unknown>): Document {
  return new DOMParser().parseFromString(
    `<html><head><title>${title}</title>` +
      `<script type="application/ld+json">${JSON.stringify(ldJson)}</script></head><body></body></html>`,
    "text/html",
  );
}

function mockPage(doc: Document) {
  vi.spyOn(axios, "get").mockResolvedValue({ data: doc } as any);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("豆瓣内置解析：JSON-LD 评分转为数字", () => {
  it("ratingValue / ratingCount 为字符串时输出数字", async () => {
    mockPage(
      ldJsonDocument("测试影片 (豆瓣)", {
        name: "测试影片",
        aggregateRating: { "@type": "AggregateRating", ratingValue: "7.5", ratingCount: "123456", bestRating: "10" },
      }),
    );

    const info = await fetchDoubanInformation("1234567");

    expect(info.ratingScore).toBe(7.5);
    expect(info.ratingCount).toBe(123456);
  });

  it("缺少 aggregateRating 时评分与人数为 0", async () => {
    mockPage(ldJsonDocument("测试影片 (豆瓣)", { name: "测试影片" }));

    const info = await fetchDoubanInformation("1234567");

    expect(info.ratingScore).toBe(0);
    expect(info.ratingCount).toBe(0);
  });
});

describe("TMDb 解析：JSON-LD 评分无论字符串还是数字都输出数字", () => {
  it.each([
    ["字符串", { ratingValue: "7.5", ratingCount: "2048" }],
    ["数字", { ratingValue: 7.5, ratingCount: 2048 }],
  ])("%s评分", async (_label, aggregateRating) => {
    mockPage(ldJsonDocument("Test Movie", { name: "Test Movie", aggregateRating }));

    const info = await fetchTmdbInformation("movie/550");

    expect(info.title).toBe("Test Movie");
    expect(info.ratingScore).toBe(7.5);
    expect(info.ratingCount).toBe(2048);
  });
});
