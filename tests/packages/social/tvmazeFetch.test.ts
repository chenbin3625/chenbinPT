/**
 * SERVERSSOCIAL-7：tvmaze.fetchInformation 解析出 realId 却仍用原始 id 拼 API URL，
 * 输入完整 URL（如 https://www.tvmaze.com/shows/1234/xxx）时会请求 /shows/https://…，
 * 404 后被 catch 静默吞掉、返回一个 title/poster/ratingScore 全空但 id 看似正常的对象。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosGet = vi.hoisted(() => vi.fn());

vi.mock("axios", () => ({ default: { get: axiosGet } }));

import { fetchInformation } from "@ptd/social/entity/tvmaze.ts";

const apiResponse = {
  data: {
    id: 1234,
    name: "Example Show",
    image: { medium: "https://img.example/medium.jpg", original: "https://img.example/original.jpg" },
    rating: { average: 8.5 },
  },
};

describe("SERVERSSOCIAL-7：tvmaze API 使用归一化后的 realId", () => {
  beforeEach(() => {
    axiosGet.mockReset().mockResolvedValue(apiResponse);
  });

  it.each([
    "1234",
    "https://www.tvmaze.com/shows/1234",
    "https://www.tvmaze.com/shows/1234/example-show",
    "http://tvmaze.com/shows/1234/",
  ])("输入 %s 时请求 /shows/1234", async (input) => {
    const result = await fetchInformation(input);

    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(axiosGet.mock.calls[0][0]).toBe("https://api.tvmaze.com/shows/1234");
    expect(result.id).toBe("1234");
    expect(result.title).toBe("Example Show");
    expect(result.poster).toBe("https://img.example/medium.jpg");
    expect(result.ratingScore).toBe(8.5);
  });
});
