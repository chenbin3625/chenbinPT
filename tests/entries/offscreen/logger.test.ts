/**
 * logger 行为测试（见 docs/performance-audit.md P1-2）。
 *
 * 修复前：`useSessionStorage`（VueUse `useStorage` 默认 `deep: true` watch）
 * 让**每条日志**都把整个日志数组 `JSON.stringify` 后写进 sessionStorage。
 * 日志数组上限 500 条且经常携带大对象（站点配置、下载请求配置…），
 * 实测 500 次 push 累计序列化约 80MB，且写盘是同步的。
 *
 * 修复后：内存环形缓冲 + 500ms 节流落盘（满 50 条立即落盘，配额不足时裁剪一半重试）。
 * 这个文件用假计时器把上述行为钉住，防止后续被改回"每次 push 全量落盘"。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("__BROWSER__", "chrome");
vi.stubGlobal("chrome", {
  storage: {
    local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), onChanged: { addListener: () => {} } },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  runtime: {
    id: "test",
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    sendMessage: () => Promise.resolve(undefined),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
});

const STORAGE_KEY = "logger";

async function loadLoggerModule() {
  vi.resetModules();
  sessionStorage.clear();
  return await import("@/offscreen/utils/logger.ts");
}

describe("logger：环形缓冲 + 节流落盘（P1-2）", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useRealTimers();
  });

  it("写入是节流的：窗口内不落盘，窗口结束只落盘一次且内容完整", async () => {
    vi.useFakeTimers();
    try {
      const { logger, getLoggerItems } = await loadLoggerModule();
      const setItemSpy = vi.spyOn(sessionStorage, "setItem");
      setItemSpy.mockClear();

      for (let i = 0; i < 20; i++) {
        logger({ msg: `log-${i}` });
      }

      expect(getLoggerItems()).toHaveLength(20);
      expect(setItemSpy).not.toHaveBeenCalled(); // 修复前这里会有 20 次全量序列化

      vi.advanceTimersByTime(500);

      expect(setItemSpy).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string);
      expect(saved).toHaveLength(20);
      expect(saved[0].msg).toBe("log-0");
      expect(saved[0].id).toBeTruthy();
      expect(saved[0].time).toBeTypeOf("number");
    } finally {
      vi.useRealTimers();
    }
  });

  it("缓冲上限 500 条：超出后丢弃最旧的（保留最新日志）", async () => {
    vi.useFakeTimers();
    try {
      const { logger, getLoggerItems } = await loadLoggerModule();
      for (let i = 0; i < 520; i++) {
        logger({ msg: `log-${i}` });
      }
      vi.advanceTimersByTime(500);

      const items = getLoggerItems();
      expect(items).toHaveLength(500);
      expect(items[0]!.msg).toBe("log-20");
      expect(items[499]!.msg).toBe("log-519");
    } finally {
      vi.useRealTimers();
    }
  });

  it("达到阈值（50 条）立即落盘，不必等满 500ms", async () => {
    vi.useFakeTimers();
    try {
      const { logger } = await loadLoggerModule();
      const setItemSpy = vi.spyOn(sessionStorage, "setItem");
      setItemSpy.mockClear();

      for (let i = 0; i < 50; i++) {
        logger({ msg: `log-${i}` });
      }

      expect(setItemSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("配额不足时裁剪一半并重试，优先保留最新日志", async () => {
    vi.useFakeTimers();
    try {
      const { logger, getLoggerItems } = await loadLoggerModule();
      const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
      let attempts = 0;
      vi.spyOn(sessionStorage, "setItem").mockImplementation((key: string, value: string) => {
        attempts += 1;
        if (attempts === 1) {
          throw new DOMException("QuotaExceededError", "QuotaExceededError");
        }
        originalSetItem(key, value);
      });

      for (let i = 0; i < 10; i++) {
        logger({ msg: `log-${i}` });
      }
      vi.advanceTimersByTime(500);

      expect(attempts).toBeGreaterThanOrEqual(2);
      const items = getLoggerItems();
      expect(items.length).toBeLessThan(10); // 丢掉了最旧的一半
      expect(items[items.length - 1]!.msg).toBe("log-9");
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("从 sessionStorage 恢复历史日志（最多 500 条）", async () => {
    // 先加载模块（loadLoggerModule 会 clear sessionStorage），再种入历史数据：
    // loadOnce() 是懒执行（首次 logger()/getLoggerItems() 时才读），因此这里仍然有效
    const { getLoggerItems } = await loadLoggerModule();
    const seed = Array.from({ length: 520 }, (_, i) => ({ msg: `old-${i}` }));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(seed));

    const items = getLoggerItems();
    expect(items).toHaveLength(500);
    expect(items[0]!.msg).toBe("old-20");
  });

  it("clearLogger 清空内存与存储", async () => {
    const { logger, getLoggerItems } = await loadLoggerModule();
    logger({ msg: "x" });
    const { clearLoggerItems } = await import("@/offscreen/utils/logger.ts");
    clearLoggerItems();

    expect(getLoggerItems()).toHaveLength(0);
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string)).toEqual([]);
  });
});
