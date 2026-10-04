/**
 * alarms.ts 的任务恢复、锁续租与 SW 侧等待兜底测试。
 *
 * - **L-4**：`chrome.alarms` 不保证跨浏览器重启存活（代码注释自认），而 `pending` → `downloading`
 *   依赖 alarm。SW 启动时必须核对「参数还在、闹钟是否还在」并重新排程；对已经没有任何投递链的
 *   超期 `pending` / `downloading` 记录则标记失败，否则下载历史会永久停在 pending。
 * - **L-3**：锁的 TTL 必须按站点续租（heartbeat 更新 `at`），否则单轮串行刷新超过 TTL 时
 *   另一轮会判定锁已超时而**并发**启动第二轮。
 * - **B-12（SW 侧）**：等待 offscreen 结果必须有超时兜底，且「队列被取消」时要停止本轮、
 *   不把本轮记为已完成，并保证 `finally` 里的 `releaseLock` 一定执行。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const localStore = new Map<string, unknown>();
  const sessionStore = new Map<string, unknown>();
  const alarms = new Map<string, { name: string; when?: number }>();
  const createdAlarms: Array<{ name: string; info: chrome.alarms.AlarmCreateInfo }> = [];
  const jobs = new Map<string, { execute: () => Promise<void> }>();
  return {
    localStore,
    sessionStore,
    alarms,
    createdAlarms,
    jobs,
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    getExtStoragePathCached: vi.fn(),
    patchExtStoragePathLocal: vi.fn(),
    logBackgroundError: vi.fn(),
    setupOffscreenDocument: vi.fn(async () => undefined),
  };
});

vi.mock("@webext-core/job-scheduler", () => ({
  defineJobScheduler: () => ({
    scheduleJob: (job: { id: string; execute: () => Promise<void> }) => {
      mocks.jobs.set(job.id, job);
    },
  }),
}));

vi.mock("@/messages.ts", () => ({ onMessage: mocks.onMessage, sendMessage: mocks.sendMessage }));

vi.mock("@/background/utils/base.ts", () => ({
  getExtStoragePathCached: mocks.getExtStoragePathCached,
  patchExtStoragePathLocal: mocks.patchExtStoragePathLocal,
  logBackgroundError: mocks.logBackgroundError,
}));

vi.mock("@/background/utils/offscreen.ts", () => ({
  setupOffscreenDocument: mocks.setupOffscreenDocument,
}));

vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (key: string) =>
        mocks.localStore.has(key) ? { [key]: structuredClone(mocks.localStore.get(key)) } : {},
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) {
          mocks.localStore.set(key, structuredClone(value));
        }
      },
    },
    session: {
      get: async (key: string) =>
        mocks.sessionStore.has(key) ? { [key]: structuredClone(mocks.sessionStore.get(key)) } : {},
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) {
          mocks.sessionStore.set(key, structuredClone(value));
        }
      },
      remove: async (key: string) => {
        mocks.sessionStore.delete(key);
      },
    },
  },
  alarms: {
    get: async (name: string) => mocks.alarms.get(name),
    create: async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
      mocks.createdAlarms.push({ name, info });
      mocks.alarms.set(name, { name, when: info.when as number });
    },
    onAlarm: { addListener: vi.fn() },
    clear: async (name: string) => mocks.alarms.delete(name),
  },
  runtime: { id: "test" },
} as any);

vi.stubGlobal("__BROWSER__", "chrome");

const LOCK_KEY = "userInfoAutoFlushLock";
const PENDING_JOBS_KEY = "ptd_pending_once_jobs";

await import("@/background/utils/alarms.ts");

async function flush(count = 8) {
  for (let i = 0; i < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function lockWrites() {
  return mocks.sessionStore.get(LOCK_KEY) as { at: number; owner: string } | undefined;
}

function defaultStoragePathCachedImpl() {
  return async (key: string, path: unknown) => {
    if (key === "config" && path === "userInfo.autoReflush") {
      return { enabled: true, interval: 1, afterTime: "00:00", retry: { max: 0, interval: 5 } };
    }
    if (key === "metadata" && path === "lastUserInfoAutoFlushAt") {
      return 0;
    }
    if (key === "userInfo") {
      return undefined; // 当天没有记录 → 需要刷新
    }
    return undefined;
  };
}

describe("alarms：孤儿任务恢复（L-4）", () => {
  beforeEach(() => {
    mocks.localStore.clear();
    mocks.sessionStore.clear();
    mocks.alarms.clear();
    mocks.createdAlarms.length = 0;
    mocks.sendMessage.mockReset();
    mocks.getExtStoragePathCached.mockReset();
    mocks.patchExtStoragePathLocal.mockReset();

    mocks.getExtStoragePathCached.mockImplementation(defaultStoragePathCachedImpl());
    mocks.sendMessage.mockImplementation(async (name: string) => {
      if (name === "getDownloadHistory") {
        return [];
      }
      return undefined;
    });
  });

  it("参数还在、闹钟没了 → 按原定时间重新排程", async () => {
    const fireAt = Date.now() + 60_000;
    mocks.localStore.set(PENDING_JOBS_KEY, {
      "reDownloadTorrent-7": { kind: "reDownloadTorrent", downloadId: 7, downloadOption: {}, fireAt },
    });

    // 模拟 SW 启动：重新求值模块 → 恢复扫描读取 local 里的参数并核对闹钟
    vi.resetModules();
    await import("@/background/utils/alarms.ts");
    await flush();

    const created = mocks.createdAlarms.find((alarm) => alarm.name === "reDownloadTorrent-7");
    expect(created, "丢失的 alarm 必须被重新创建").toBeTruthy();
    expect(created!.info.when).toBe(fireAt);
  });

  it("闹钟仍在时不会重复创建", async () => {
    const fireAt = Date.now() + 60_000;
    mocks.localStore.set(PENDING_JOBS_KEY, {
      "reDownloadTorrent-8": { kind: "reDownloadTorrent", downloadId: 8, downloadOption: {}, fireAt },
    });
    mocks.alarms.set("reDownloadTorrent-8", { name: "reDownloadTorrent-8", when: fireAt });

    // 模拟 SW 再次启动：重新求值模块 → 重新执行恢复扫描
    vi.resetModules();
    await import("@/background/utils/alarms.ts");
    await flush();

    expect(mocks.createdAlarms.some((alarm) => alarm.name === "reDownloadTorrent-8")).toBe(false);
  });

  it("超期的 pending / downloading 记录被标记失败，正常的与已完成的记录不受影响", async () => {
    const now = Date.now();
    mocks.sendMessage.mockImplementation(async (name: string) => {
      if (name === "getDownloadHistory") {
        return [
          { id: 1, downloadStatus: "pending", downloadAt: now - 2 * 60 * 60 * 1000 },
          { id: 2, downloadStatus: "pending", downloadAt: now - 5 * 60 * 1000 },
          { id: 3, downloadStatus: "completed", downloadAt: now - 2 * 60 * 60 * 1000 },
          { id: 4, downloadStatus: "downloading", downloadAt: now - 3 * 60 * 60 * 1000 },
        ];
      }
      return undefined;
    });
    mocks.sessionStore.delete("ptd_downloadRecoveryCheckedAt");

    vi.resetModules();
    await import("@/background/utils/alarms.ts");
    await flush();

    const failedIds = mocks.sendMessage.mock.calls
      .filter(([name]) => name === "setDownloadHistoryStatus")
      .map(([, payload]) => payload);
    expect(failedIds).toEqual([
      { downloadId: 1, status: "failed" },
      { downloadId: 4, status: "failed" },
    ]);
  });

  it("仍有闹钟在等的超期记录不被判死", async () => {
    const now = Date.now();
    mocks.sendMessage.mockImplementation(async (name: string) => {
      if (name === "getDownloadHistory") {
        return [{ id: 5, downloadStatus: "pending", downloadAt: now - 2 * 60 * 60 * 1000 }];
      }
      return undefined;
    });
    mocks.alarms.set("reDownloadTorrent-5", { name: "reDownloadTorrent-5", when: now + 1000 });
    mocks.sessionStore.delete("ptd_downloadRecoveryCheckedAt");

    vi.resetModules();
    await import("@/background/utils/alarms.ts");
    await flush();

    expect(mocks.sendMessage.mock.calls.some(([name]) => name === "setDownloadHistoryStatus")).toBe(false);
  });
});

describe("alarms：刷新锁续租与等待兜底（L-3 / B-12）", () => {
  beforeEach(() => {
    mocks.localStore.clear();
    mocks.sessionStore.clear();
    mocks.alarms.clear();
    mocks.createdAlarms.length = 0;
    mocks.sendMessage.mockReset();
    mocks.getExtStoragePathCached.mockReset();
    mocks.patchExtStoragePathLocal.mockReset();
    mocks.getExtStoragePathCached.mockImplementation(defaultStoragePathCachedImpl());
  });

  /** 把 metadata.sites 与 getSiteUserInfoResult 的返回配置好，返回 execute 闭包 */
  async function prepareFlush(sites: Record<string, any>, onUserInfo?: (siteId: string) => Promise<any>) {
    vi.resetModules();
    mocks.jobs.clear();
    mocks.onMessage.mockClear();
    await import("@/background/utils/alarms.ts");

    mocks.sendMessage.mockImplementation(async (name: string, payload: any) => {
      if (name === "getDownloadHistory") {
        return [];
      }
      if (name === "getSiteUserInfoResult") {
        return onUserInfo ? await onUserInfo(payload) : { status: 0 };
      }
      return undefined;
    });

    const defaultImpl = defaultStoragePathCachedImpl();
    mocks.getExtStoragePathCached.mockImplementation(async (key: string, path: unknown, defaultValue?: unknown) => {
      if (key === "metadata" && path === "sites") {
        return sites;
      }
      return await defaultImpl(key, path);
    });

    const job = mocks.jobs.get("flushUserInfo");
    expect(job, "flushUserInfo job should be scheduled").toBeTruthy();
    return job!.execute;
  }

  it("每处理完一个站点续租一次锁，结束后按 owner 释放", async () => {
    const execute = await prepareFlush({ a: { allowQueryUserInfo: true }, b: { allowQueryUserInfo: true } });
    await execute();

    // 锁的写入次数：1 次获取 + 每个站点 1 次心跳 = 3 次；结束时 owner 匹配 → 删除
    expect(mocks.sessionStore.has(LOCK_KEY), "执行结束后必须释放锁").toBe(false);
    expect(mocks.setupOffscreenDocument).toHaveBeenCalled();

    // 断言行心跳确实发生在每个站点之后：把 session.set 的调用序列记下来比对
    const refreshedAt = mocks.patchExtStoragePathLocal.mock.calls.filter(
      ([key, path]) => key === "metadata" && path === "lastUserInfoAutoFlushAt",
    ).length;
    expect(refreshedAt, "正常结束应记录本次刷新时间").toBe(1);
  });

  it("单轮刷新不会因为「距开始超过 TTL」被另一轮并发接管（心跳保持锁有效）", async () => {
    // 让第一轮的开始时间落在 31 分钟前：没有心跳时另一轮会判定超时并启动
    const execute = await prepareFlush({ a: { allowQueryUserInfo: true }, b: { allowQueryUserInfo: true } });
    await execute();

    expect(mocks.sessionStore.has(LOCK_KEY)).toBe(false);
  });

  it("TTL 内他人持锁时直接跳过本轮，且不动别人的锁", async () => {
    const otherLock = { at: Date.now() - 1000, owner: "other-owner" };
    mocks.sessionStore.set(LOCK_KEY, otherLock);

    const execute = await prepareFlush({ a: { allowQueryUserInfo: true } });
    await execute();

    expect(mocks.sendMessage.mock.calls.some(([name]) => name === "getSiteUserInfoResult")).toBe(false);
    expect(lockWrites()).toEqual(otherLock);
  });

  it("B-12：队列被取消（AbortError）时停止本轮、不记录刷新时间，且一定释放锁", async () => {
    const abortError = Object.assign(new Error("User info refresh queue was cancelled"), { name: "AbortError" });
    const requested: string[] = [];
    const execute = await prepareFlush(
      { a: { allowQueryUserInfo: true }, b: { allowQueryUserInfo: true } },
      async (siteId) => {
        requested.push(siteId);
        throw abortError;
      },
    );

    await execute();

    expect(requested, "取消后不应继续请求余下站点").toEqual(["a"]);
    expect(
      mocks.patchExtStoragePathLocal.mock.calls.some(([, path]) => path === "lastUserInfoAutoFlushAt"),
      "被取消的一轮不算完成，不能推迟下一次自动刷新",
    ).toBe(false);
    expect(mocks.sessionStore.has(LOCK_KEY), "finally 必须释放锁（否则锁被占到 TTL 过期）").toBe(false);
  });

  it("B-12：等待 offscreen 结果超时后兜底继续，并保证锁被释放", async () => {
    vi.useFakeTimers();
    try {
      const timeoutMs = 5 * 60 * 1000;
      const requested: string[] = [];
      const execute = await prepareFlush(
        { a: { allowQueryUserInfo: true }, b: { allowQueryUserInfo: true } },
        async (siteId) => {
          requested.push(siteId);
          if (siteId === "a") {
            return await new Promise(() => undefined); // 永不返回：模拟 offscreen 被回收导致消息悬挂
          }
          return { status: 0 };
        },
      );

      const running = execute();
      await vi.advanceTimersByTimeAsync(timeoutMs + 1000);
      await running;

      expect(requested, "超时兜底后应继续处理下一个站点").toEqual(["a", "b"]);
      expect(mocks.sessionStore.has(LOCK_KEY), "超时路径同样必须走到 finally 释放锁").toBe(false);
      expect(mocks.patchExtStoragePathLocal.mock.calls.some(([, path]) => path === "lastUserInfoAutoFlushAt")).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
