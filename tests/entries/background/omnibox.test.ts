/**
 * omnibox 输入解析回归测试（N4）。
 *
 * 缺陷：建议项 content 形如 `<方案名> → <搜索词>`，`onInputEntered` 用
 * `[solutionName, key] = text.split(" → ")` 解构。搜索词本身可能包含 `" → "`
 * （例如从别处复制带箭头的标题），split 多于两段时后面的内容被静默丢弃。
 *
 * 修复：按**第一处**分隔符切分（`splitOmniboxInput`）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(),
  getExtStoragePathCached: vi.fn(),
  openOptionsPage: vi.fn(),
  onInputChangedListeners: [] as Array<(text: string, suggest: (results: any[]) => void) => void>,
  onInputEnteredListeners: [] as Array<(text: string) => void>,
}));

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));

vi.mock("@/background/utils/base.ts", () => ({
  getExtStoragePathCached: mocks.getExtStoragePathCached,
  openOptionsPage: mocks.openOptionsPage,
}));

vi.stubGlobal("chrome", {
  omnibox: {
    onInputChanged: {
      addListener: vi.fn((fn: (text: string, suggest: (results: any[]) => void) => void) =>
        mocks.onInputChangedListeners.push(fn),
      ),
    },
    onInputEntered: {
      addListener: vi.fn((fn: (text: string) => void) => mocks.onInputEnteredListeners.push(fn)),
    },
  },
  i18n: { getMessage: vi.fn((key: string, args?: string[]) => `${key}:${(args ?? []).join("|")}`) },
});

// 默认没有用户自定义搜索方案（getSearchSolution 会回落 default）
mocks.getExtStoragePathCached.mockImplementation(async (key: string, path: unknown) => {
  if (key === "metadata" && Array.isArray(path) && path[0] === "solutions") {
    return { default: { id: "default", name: "默认方案", enabled: true, sort: 1 } };
  }
  if (key === "metadata" && Array.isArray(path) && path[0] === "defaultSolutionId") {
    return "default";
  }
  return undefined;
});

const { splitOmniboxInput } = await import("@/background/utils/omnibox.ts");

async function flushAsync() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("splitOmniboxInput（N4）", () => {
  it("没有分隔符时整段都是搜索词", () => {
    expect(splitOmniboxInput("hello world")).toEqual({ key: "hello world" });
  });

  it("只按第一处分隔符切分：搜索词里包含分隔符时不能被截断", () => {
    expect(splitOmniboxInput("默认方案 → foo → bar")).toEqual({
      solutionName: "默认方案",
      key: "foo → bar",
    });
  });

  it("搜索词为空时保留空串（不丢方案名）", () => {
    expect(splitOmniboxInput("默认方案 → ")).toEqual({ solutionName: "默认方案", key: "" });
  });
});

describe("omnibox onInputEntered 使用完整搜索词", () => {
  beforeEach(() => {
    mocks.openOptionsPage.mockReset();
  });

  it("含多个分隔符时，打开的搜索页 query.search 必须是完整搜索词", async () => {
    expect(mocks.onInputEnteredListeners.length).toBeGreaterThan(0);

    mocks.onInputEnteredListeners[0]!("默认方案 → foo → bar");
    await flushAsync();

    expect(mocks.openOptionsPage).toHaveBeenCalledWith({
      path: "/search-entity",
      query: { search: "foo → bar", plan: "default", flush: 1 },
    });
  });

  it("不含分隔符时按默认方案搜索整段输入", async () => {
    mocks.onInputEnteredListeners[0]!("hello world");
    await flushAsync();

    expect(mocks.openOptionsPage).toHaveBeenCalledWith({
      path: "/search-entity",
      query: { search: "hello world", plan: "default", flush: 1 },
    });
  });
});
