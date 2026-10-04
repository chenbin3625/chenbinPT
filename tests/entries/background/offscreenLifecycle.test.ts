import { beforeEach, describe, expect, it, vi } from "vitest";

const { onMessageMock } = vi.hoisted(() => ({
  onMessageMock: vi.fn(),
}));

vi.mock("@/messages.ts", () => ({
  onMessage: onMessageMock,
}));

vi.stubGlobal("__BROWSER__", "chrome");

function createChromeMock() {
  const getContexts = vi.fn();
  const createDocument = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts,
    },
    offscreen: {
      Reason: { DOM_PARSER: "DOM_PARSER" },
      createDocument,
    },
  });
  return { getContexts, createDocument };
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("offscreen document 生命周期", () => {
  beforeEach(() => {
    vi.resetModules();
    onMessageMock.mockReset();
  });

  it("注册 ensureOffscreenDocument 消息，并在收到请求时等待文档创建完成", async () => {
    const { getContexts, createDocument } = createChromeMock();
    // 模块导入时的预热调用看到已有上下文；显式 ensure 时模拟文档不存在。
    getContexts.mockResolvedValueOnce([{}]).mockResolvedValueOnce([]);
    createDocument.mockResolvedValue(undefined);

    await import("@/background/utils/offscreen.ts");
    await flushMicrotasks();

    const registration = onMessageMock.mock.calls.find(([type]) => type === "ensureOffscreenDocument");
    expect(registration).toBeTruthy();
    await registration![1]({ data: undefined });

    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("首次创建失败后必须清空 creating，下一次 ensure 可以重新创建", async () => {
    const { getContexts, createDocument } = createChromeMock();
    getContexts.mockResolvedValueOnce([{}]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    createDocument.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce(undefined);

    const { setupOffscreenDocument } = await import("@/background/utils/offscreen.ts");
    await flushMicrotasks();

    await expect(setupOffscreenDocument()).rejects.toThrow("temporary failure");
    await expect(setupOffscreenDocument()).resolves.toBeUndefined();
    expect(createDocument).toHaveBeenCalledTimes(2);
  });
});
