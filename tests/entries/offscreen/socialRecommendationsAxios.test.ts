import { describe, expect, it, vi } from "vitest";

const { axiosCreateMock, isolatedAxios, setupReplaceUnsafeHeaderMock } = vi.hoisted(() => {
  const isolatedAxios = { get: vi.fn() };
  return {
    isolatedAxios,
    axiosCreateMock: vi.fn(() => isolatedAxios),
    setupReplaceUnsafeHeaderMock: vi.fn((instance) => instance),
  };
});

vi.mock("axios", () => ({
  default: {
    create: axiosCreateMock,
    get: vi.fn(),
  },
}));
vi.mock("~/extends/axios/replaceUnsafeHeader.ts", () => ({
  setupReplaceUnsafeHeader: setupReplaceUnsafeHeaderMock,
}));
vi.mock("@ptd/social", () => ({
  getSocialRecommendations: vi.fn(async () => ({ items: [], hasFailedSources: false })),
}));
vi.mock("@/messages.ts", () => ({
  onMessage: vi.fn(),
}));
vi.mock("@/offscreen/utils/logger.ts", () => ({
  logger: vi.fn(),
}));
vi.mock("@/offscreen/utils/socialInformation.ts", () => ({
  getSocialInformation: vi.fn(),
}));

describe("socialRecommendations axios 隔离", () => {
  it("海报请求必须使用独立 axios 实例，不能重复修改共享默认实例", async () => {
    await import("@/offscreen/utils/socialRecommendations.ts");

    expect(axiosCreateMock).toHaveBeenCalledTimes(1);
    expect(setupReplaceUnsafeHeaderMock).toHaveBeenCalledWith(isolatedAxios);
  });
});
