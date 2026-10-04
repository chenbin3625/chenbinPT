/**
 * TMDb 附属页面（external_ids 等）文档缓存的行为验证。
 *
 * 原缺陷：`fetchTmdbDocument` 缓存任何 resolve 的 Document，只有 Promise reject 才删缓存。
 * 未登录时 `/edit?active_nav_item=external_ids` 会以 HTTP 200 返回登录页（不抛错），
 * `#imdb_id`/`#tvdb_id` 取不到值，这份"空文档"被缓存 10 分钟，期间即使登录了也一直缺失。
 *
 * 修复后：关键元素不存在 / 被重定向到登录页时不写入缓存；正常目标页面照旧复用。
 */
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ISocialSitePageInformation } from "@ptd/social";
import { pageParserMatches } from "@ptd/social/entity/tmdb.ts";

const [, tmdbPageParser] = pageParserMatches[0];

function createDocument(html: string, url: string): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  Object.defineProperty(doc, "URL", { value: url, configurable: true });
  return doc;
}

function buildMovieUrl(tmdbMovieId: number): string {
  return `https://www.themoviedb.org/movie/${tmdbMovieId}-test-movie`;
}

function buildExternalIdsUrl(tmdbMovieId: number): string {
  return `https://www.themoviedb.org/movie/${tmdbMovieId}/edit?active_nav_item=external_ids`;
}

let externalIdsDocument: () => Document;

beforeEach(() => {
  vi.spyOn(axios, "get").mockImplementation(((url: string) => {
    if (url.includes("active_nav_item=external_ids")) {
      return Promise.resolve({ data: externalIdsDocument() });
    }

    return Promise.reject(new Error(`unexpected url ${url}`));
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function parseExternalIds(tmdbMovieId: number): Promise<NonNullable<ISocialSitePageInformation["external_ids"]>> {
  const mainDoc = createDocument(
    `<html><head><meta property="og:title" content="Test Movie"></head><body></body></html>`,
    buildMovieUrl(tmdbMovieId),
  );
  const parsed = (await tmdbPageParser(mainDoc)) as ISocialSitePageInformation;
  return parsed.external_ids ?? {};
}

describe("fetchTmdbDocument 缓存校验", () => {
  it("关键元素缺失的非目标页面不写入缓存，下次调用能拿到真实页面", async () => {
    const tmdbMovieId = 550;
    let axiosCalls = 0;

    // 第一次：HTTP 200 但既不是 external_ids 页面，也不含 #imdb_id/#tvdb_id
    externalIdsDocument = () =>
      createDocument(`<html><body><h1>Not the page we want</h1></body></html>`, "about:blank");
    expect(await parseExternalIds(tmdbMovieId)).toEqual({});
    axiosCalls = vi.mocked(axios.get).mock.calls.length;
    expect(axiosCalls).toBeGreaterThan(0);

    // 第二次：真实 external_ids 页面 → 若上一次被错误缓存，这里仍会是空对象
    externalIdsDocument = () =>
      createDocument(`<html><body><input id="imdb_id" value="tt0137523"></body></html>`, "about:blank");

    expect((await parseExternalIds(tmdbMovieId)).imdb).toBe("tt0137523");
    expect(vi.mocked(axios.get).mock.calls.length).toBeGreaterThan(axiosCalls);
  });

  it("重定向到登录页（带登录表单）时同样不写入缓存", async () => {
    const tmdbMovieId = 680;

    externalIdsDocument = () =>
      createDocument(
        `<html><body><form id="auth_login_form" action="/login" method="post"><input type="password"></form></body></html>`,
        "https://www.themoviedb.org/login",
      );
    expect(await parseExternalIds(tmdbMovieId)).toEqual({});

    externalIdsDocument = () =>
      createDocument(`<html><body><input id="imdb_id" value="tt0137523"></body></html>`, "about:blank");

    expect((await parseExternalIds(tmdbMovieId)).imdb).toBe("tt0137523");
  });

  it("正常目标页面仍按 URL 缓存复用（保留原有缓存收益）", async () => {
    const tmdbMovieId = 13;

    externalIdsDocument = () =>
      createDocument(`<html><body><input id="imdb_id" value="tt0137523"></body></html>`, "about:blank");

    expect((await parseExternalIds(tmdbMovieId)).imdb).toBe("tt0137523");
    const axiosCalls = vi.mocked(axios.get).mock.calls.length;
    expect(axiosCalls).toBe(1);

    externalIdsDocument = () => {
      throw new Error("cache miss: should have reused the cached document");
    };
    expect((await parseExternalIds(tmdbMovieId)).imdb).toBe("tt0137523");
    expect(vi.mocked(axios.get).mock.calls.length).toBe(axiosCalls);
  });
});
