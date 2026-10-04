/**
 * siteIndex 自愈测试（见 docs/performance-audit.md P2-17）。
 *
 * 回归点：`ensureSiteIndex` 只要 `siteHostMap` 是 object 就 return，`{}` 也会被当成有效索引，
 * 于是过期的/为空的索引永远不会重建；而读取方（content script 只检查 `!siteHostMap`）也不会
 * 回落到 metadata，页面识别不到站点。空对象必须视为无效。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/background/utils/base.ts", () => ({
  getExtStorageCached: vi.fn(),
  getExtStoragePathCached: vi.fn(),
  patchExtStoragePathLocal: vi.fn(),
}));

type AnyMock = ReturnType<typeof vi.fn>;

const base = await import("@/background/utils/base.ts");
const { ensureSiteIndex, isUsableSiteIndexMap } = await import("@/background/utils/siteIndex.ts");

const getPathMock = base.getExtStoragePathCached as unknown as AnyMock;
const getStorageMock = base.getExtStorageCached as unknown as AnyMock;
const patchMock = base.patchExtStoragePathLocal as unknown as AnyMock;

async function flushAsync() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("isUsableSiteIndexMap", () => {
  it("空对象 / 缺失 / 数组 / 非对象都视为不可用", () => {
    expect(isUsableSiteIndexMap(undefined)).toBe(false);
    expect(isUsableSiteIndexMap(null)).toBe(false);
    expect(isUsableSiteIndexMap({})).toBe(false);
    expect(isUsableSiteIndexMap([])).toBe(false);
    expect(isUsableSiteIndexMap("mteam")).toBe(false);
    expect(isUsableSiteIndexMap({ "mteam.example": "mteam" })).toBe(true);
  });
});

describe("ensureSiteIndex", () => {
  beforeEach(async () => {
    // 模块导入时会自动跑一次 ensureSiteIndex，先让它结算再重置 mock
    await flushAsync();
    vi.resetAllMocks();
  });

  it("索引是空对象时视为无效：从 metadata 重建（并先把空表清成 null 让读取方回落）", async () => {
    getPathMock.mockImplementation(async (key: string) => (key === "siteIndex" ? {} : undefined));
    getStorageMock.mockResolvedValue({
      siteHostMap: { "mteam.example": "mteam" },
      siteNameMap: { mteam: "M-Team" },
    });

    await ensureSiteIndex();

    expect(patchMock.mock.calls).toEqual([
      ["siteIndex", "siteHostMap", null],
      ["siteIndex", "siteNameMap", null],
      ["siteIndex", "siteHostMap", { "mteam.example": "mteam" }],
      ["siteIndex", "siteNameMap", { mteam: "M-Team" }],
    ]);
  });

  it("索引已有内容时直接返回：不读 metadata、不写回", async () => {
    getPathMock.mockImplementation(async (key: string) => (key === "siteIndex" ? { a: "b" } : undefined));

    await ensureSiteIndex();

    expect(getStorageMock).not.toHaveBeenCalled();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("索引为空且 metadata 里也没有站点时不写回（等 options 首次重建）", async () => {
    getPathMock.mockResolvedValue({});
    getStorageMock.mockResolvedValue({});

    await ensureSiteIndex();

    expect(patchMock).not.toHaveBeenCalled();
  });

  it("host 映射为空但 name 映射有内容：只把无效的 host 表重建", async () => {
    getPathMock.mockImplementation(async (key: string, path: string) => {
      if (key !== "siteIndex") return undefined;
      return path === "siteHostMap" ? {} : { mteam: "M-Team" };
    });
    getStorageMock.mockResolvedValue({
      siteHostMap: { "mteam.example": "mteam" },
      siteNameMap: { mteam: "M-Team" },
    });

    await ensureSiteIndex();

    expect(patchMock.mock.calls).toEqual([
      ["siteIndex", "siteHostMap", null],
      ["siteIndex", "siteHostMap", { "mteam.example": "mteam" }],
      ["siteIndex", "siteNameMap", { mteam: "M-Team" }],
    ]);
  });
});
