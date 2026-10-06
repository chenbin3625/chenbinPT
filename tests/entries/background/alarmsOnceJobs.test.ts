/**
 * 一次性定时任务的持久化测试（见 docs/performance-audit.md P1-6 / P1-22 的收尾修复）。
 *
 * 修复前的缺陷：`@webext-core/job-scheduler` 的 once job 只把 `execute` 闭包放在**当前 SW 的内存**里，
 * MV3 空闲约 30s 回收 SW 后，闹钟到点也没有可执行函数 —— 重新下载会永远停在 pending、
 * 自动刷新重试会静默消失。
 *
 * 这里的测试用假 chrome 复现整条链路，并显式模拟"SW 回收后重新启动"：
 * `vi.resetModules()` + 重新 import 等价于 SW 重新求值（模块内存清空，storage 保留）；
 * 浏览器侧的 alarm 则保留在 mock 的 `createdAlarms` 里（与真实 alarms 跨 SW 存活一致）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EResultParseStatus } from "@ptd/site/types/base.ts";

type StorageChange = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type TNativeMessage = { id: number; type: string; data: any; timestamp: number };
type TMessageListener = (
  message: TNativeMessage,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => unknown;

const PENDING_JOB_KEY = "ptd_pending_once_jobs";

const backing = new Map<string, unknown>();
const sessionBacking = new Map<string, unknown>();
const changeListeners: Array<(changes: StorageChange, areaName: string) => void> = [];
const messageListeners: TMessageListener[] = [];
const alarmListeners: Array<(alarm: { name: string; scheduledTime: number }) => unknown> = [];
const createdAlarms = new Map<string, { name: string; scheduledTime: number }>();

/** 记录 SW 通过 sendMessage 发出去的消息（downloadTorrent / setDownloadHistoryStatus / logger …） */
let sentMessages: Array<{ type: string; data: any }> = [];
/** 允许单个用例定制 sendMessage 的响应（例如让 downloadTorrent 失败） */
let sendMessageHandler: ((message: TNativeMessage, sendResponse: (response: unknown) => void) => boolean) | null = null;
/** getSiteUserInfoResult 的返回值，默认失败以便触发重试 */
let siteUserInfoStatus: EResultParseStatus = EResultParseStatus.parseError;
let nextMessageId = 1;

function emitChanges(changes: StorageChange) {
  for (const listener of [...changeListeners]) {
    listener(changes, "local");
  }
}

function createStorageArea(store: Map<string, unknown>, areaName: "local" | "session") {
  return {
    get: (keys?: string | string[] | null) => {
      if (keys === null || keys === undefined) {
        return Promise.resolve(Object.fromEntries(store));
      }
      const result: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (store.has(key)) {
          result[key] = store.get(key);
        }
      }
      return Promise.resolve(result);
    },
    set: (items: Record<string, unknown>) => {
      const changes: StorageChange = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: store.get(key), newValue: value };
        store.set(key, value);
      }
      if (areaName === "local") {
        emitChanges(changes);
      }
      return Promise.resolve();
    },
    remove: (key: string) => {
      store.delete(key);
      if (areaName === "local") {
        emitChanges({ [key]: { oldValue: undefined, newValue: undefined } });
      }
      return Promise.resolve();
    },
    clear: () => {
      store.clear();
      return Promise.resolve();
    },
  };
}

const onChanged = {
  addListener: (fn: (changes: StorageChange, areaName: string) => void) => changeListeners.push(fn),
  removeListener: (fn: (changes: StorageChange, areaName: string) => void) => {
    const index = changeListeners.indexOf(fn);
    if (index >= 0) changeListeners.splice(index, 1);
  },
};

const chromeMock = {
  storage: {
    local: { ...createStorageArea(backing, "local"), onChanged },
    session: createStorageArea(sessionBacking, "session"),
    onChanged,
  },
  alarms: {
    get: (name: string) => Promise.resolve(createdAlarms.get(name)),
    create: (name: string, info: { when?: number }) => {
      createdAlarms.set(name, { name, scheduledTime: info?.when ?? 0 });
      return Promise.resolve();
    },
    clear: (name: string) => {
      createdAlarms.delete(name);
      return Promise.resolve(true);
    },
    onAlarm: {
      addListener: (fn: (alarm: { name: string; scheduledTime: number }) => unknown) => alarmListeners.push(fn),
      removeListener: (fn: (alarm: { name: string; scheduledTime: number }) => unknown) => {
        const index = alarmListeners.indexOf(fn);
        if (index >= 0) alarmListeners.splice(index, 1);
      },
    },
  },
  runtime: {
    id: "test-extension-id",
    lastError: undefined as { message: string } | undefined,
    onMessage: {
      addListener: (fn: TMessageListener) => messageListeners.push(fn),
      removeListener: (fn: TMessageListener) => {
        const index = messageListeners.indexOf(fn);
        if (index >= 0) messageListeners.splice(index, 1);
      },
    },
    // 消息层要求回调收到 { res } / { err }（与 @webext-core/messaging 的约定一致）
    sendMessage: (message: TNativeMessage, sendResponse: (response: unknown) => void) => {
      sentMessages.push({ type: message.type, data: message.data });

      if (sendMessageHandler?.(message, sendResponse)) {
        return;
      }

      switch (message.type) {
        case "getSiteUserInfoResult":
          sendResponse({ res: { status: siteUserInfoStatus } });
          return;
        default:
          sendResponse({ res: undefined });
      }
    },
    getURL: (path: string) => `chrome-extension://test/${path}`,
    getContexts: () => Promise.resolve([]),
    ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
  },
  offscreen: {
    createDocument: () => Promise.resolve(),
    Reason: { DOM_PARSER: "DOM_PARSER" },
  },
};

vi.stubGlobal("chrome", chromeMock);
vi.stubGlobal("__BROWSER__", "chrome");

/** 模拟一次 SW 启动：模块内存（闭包、监听器）全部重建，storage / alarms 由"浏览器"保留 */
async function bootServiceWorker() {
  vi.resetModules();
  messageListeners.length = 0;
  alarmListeners.length = 0;
  changeListeners.length = 0;
  await import("@/background/utils/alarms.ts");
}

/** 把 SW 内部 await 链推完（所有 mock 都立即 resolve，只需足够的宏任务/微任务轮次） */
async function settle() {
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 像浏览器那样派发一次 alarm 给当前 SW 里所有监听器 */
async function fireAlarm(name: string) {
  const pending: Promise<unknown>[] = [];
  for (const listener of [...alarmListeners]) {
    const result = listener({ name, scheduledTime: Date.now() });
    if (result instanceof Promise) {
      pending.push(result);
    }
  }
  await Promise.all(pending);
  await settle();
}

/** 派发一条消息给 SW（等价于 offscreen / options 侧 sendMessage） */
async function dispatchMessage(type: string, data: unknown): Promise<void> {
  await new Promise<void>((resolve) => {
    let waiting = messageListeners.length;
    if (waiting === 0) {
      resolve();
      return;
    }
    const settleOne = () => {
      waiting -= 1;
      if (waiting <= 0) {
        resolve();
      }
    };
    for (const listener of [...messageListeners]) {
      const result = listener({ id: nextMessageId++, type, data, timestamp: Date.now() }, {}, settleOne);
      if (!result) {
        settleOne();
      }
    }
  });
  await settle();
}

/** 尚未执行的任务（不含已执行任务留下的 consumed 墓碑，见 alarms.ts 的 H-11） */
function pendingJobs(): Record<string, any> {
  const stored = (backing.get(PENDING_JOB_KEY) as Record<string, any>) ?? {};
  return Object.fromEntries(Object.entries(stored).filter(([, job]) => job?.kind !== "consumed"));
}

function messagesOfType(type: string) {
  return sentMessages.filter((message) => message.type === type);
}

function downloadHistoryStatus() {
  return messagesOfType("setDownloadHistoryStatus").map((message) => message.data);
}

const downloadOption = {
  downloadId: 42,
  torrent: { site: "mteam", id: 1, title: "Test Torrent", link: "https://example.com/1.torrent" },
  downloaderId: "local",
};

describe("alarms：一次性任务参数持久化（SW 回收后不丢）", () => {
  beforeEach(() => {
    backing.clear();
    sessionBacking.clear();
    changeListeners.length = 0;
    messageListeners.length = 0;
    alarmListeners.length = 0;
    createdAlarms.clear();
    sentMessages = [];
    sendMessageHandler = null;
    siteUserInfoStatus = EResultParseStatus.parseError;
    nextMessageId = 1;
  });

  it("重新下载：SW 重启后用持久化参数重建并执行，执行后清理存储", async () => {
    await bootServiceWorker();

    const leftInterval = 5 * 60 * 1000;
    await dispatchMessage("reDownloadTorrent", { ...downloadOption, leftInterval });

    const alarmName = "reDownloadTorrent-42";
    // 已按真实剩余间隔排程（不是固定 +30s），且参数已落盘
    expect(createdAlarms.has(alarmName)).toBe(true);
    // 容差说明：scheduledTime 是消息处理时按 `Date.now() + leftInterval` 算出来的，与这里的 Date.now()
    // 之间隔着一次消息往返；原来的 ±50ms 在并行跑整套用例（60+ 文件）时会偶发失败——那是测试太紧，不是缺陷。
    // 仍然断言「按真实剩余间隔排程」而非固定值（例如曾经的 +30s）。
    const scheduledTime = createdAlarms.get(alarmName)!.scheduledTime;
    expect(scheduledTime).toBeGreaterThanOrEqual(Date.now() + leftInterval - 2000);
    expect(scheduledTime).toBeLessThanOrEqual(Date.now() + leftInterval + 2000);
    expect(pendingJobs()[alarmName]).toMatchObject({ kind: "reDownloadTorrent", downloadId: 42 });
    expect(pendingJobs()[alarmName].downloadOption).toEqual({ ...downloadOption, leftInterval });
    // 消息处理没有被 sleep 占住：此刻还没有发生真正的重新下载
    expect(messagesOfType("downloadTorrent")).toHaveLength(0);

    // SW 被回收后重新启动（模块内存清空，alarm 与 storage 保留）
    await bootServiceWorker();
    expect(createdAlarms.has(alarmName)).toBe(true);

    await fireAlarm(alarmName);

    // 由存储里的参数重建出的任务被执行：downloadTorrent 收到与投递时完全一致的 payload
    const downloadCalls = messagesOfType("downloadTorrent");
    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0].data).toEqual({ ...downloadOption, leftInterval });
    // 执行后清理存储
    expect(pendingJobs()[alarmName]).toBeUndefined();
    expect(pendingJobs()).toEqual({});
    // 成功路径不应误标 failed
    expect(downloadHistoryStatus()).toEqual([]);
  });

  it("重新下载失败：把 downloadHistory 标记为 failed（不再静默停在 pending）", async () => {
    await bootServiceWorker();
    await dispatchMessage("reDownloadTorrent", { ...downloadOption, leftInterval: 2 * 60 * 1000 });

    // 模拟 SW 回收重启 + 下载器不可达
    await bootServiceWorker();
    sendMessageHandler = (message, sendResponse) => {
      if (message.type !== "downloadTorrent") {
        return false;
      }
      chromeMock.runtime.lastError = { message: "downloader unreachable" };
      sendResponse(undefined);
      chromeMock.runtime.lastError = undefined;
      return true;
    };

    await fireAlarm("reDownloadTorrent-42");

    expect(downloadHistoryStatus()).toEqual([{ downloadId: 42, status: "failed" }]);
    expect(messagesOfType("logger").some((m) => String(m.data?.msg).includes("Re-download failed"))).toBe(true);
    // 失败任务同样被清理，不会反复重试
    expect(pendingJobs()).toEqual({});
  });

  it("alarm 触发但参数缺失：判定 failed，而不是静默丢失", async () => {
    await bootServiceWorker();

    await fireAlarm("reDownloadTorrent-99");

    expect(downloadHistoryStatus()).toEqual([{ downloadId: 99, status: "failed" }]);
  });

  it("leftInterval < 30s：不再 sleep 占住消息通道，统一按 alarms 排程", async () => {
    await bootServiceWorker();

    const startedAt = Date.now();
    await dispatchMessage("reDownloadTorrent", { ...downloadOption, leftInterval: 5000 });

    // 旧实现在这里 `await sleep(5000)`，消息处理要 5s 后才返回
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(createdAlarms.has("reDownloadTorrent-42")).toBe(true);
    expect(pendingJobs()["reDownloadTorrent-42"]).toMatchObject({ kind: "reDownloadTorrent", downloadId: 42 });
    expect(messagesOfType("downloadTorrent")).toHaveLength(0);
  });

  it("用户信息刷新重试：SW 重启后按持久化的 retryIndex 重建并执行，执行后清理", async () => {
    await bootServiceWorker();
    await chromeMock.storage.local.set({
      config: {
        userInfo: {
          autoReflush: { enabled: true, interval: 1, afterTime: "00:00", retry: { max: 2, interval: 5 } },
        },
      },
      metadata: { sites: { siteA: { allowQueryUserInfo: true } }, lastUserInfoAutoFlushAt: 0 },
      // 直接种入"排程侧已落盘"的重试条目。
      // 注：Lead 已修掉此前导致「逐站点刷新循环整体被跳过」的隐患 —— getExtStoragePathCached 的
      // defaultValue 形参默认值是 null（JS 默认参数在实参为 undefined 时同样生效），而此处曾用
      // `typeof todayUserInfo === "undefined"` 判断，该判断恒为假。现在循环会真正调用
      // getSiteUserInfoResult；本用例的 mock 默认返回失败，因此重试会继续链式排程。
      [PENDING_JOB_KEY]: {
        "flushUserInfo-Retry-0-1700000000000": {
          kind: "flushUserInfoRetry",
          retryIndex: 1,
          fireAt: Date.now() + 60_000,
        },
      },
    });

    const retryAlarmName = "flushUserInfo-Retry-0-1700000000000";
    expect(pendingJobs()[retryAlarmName]).toMatchObject({ kind: "flushUserInfoRetry", retryIndex: 1 });

    // SW 回收重启后，闹钟到点：用持久化的 retryIndex 重建 autoFlushUserInfo(retryIndex + 1)
    await bootServiceWorker();
    await fireAlarm(retryAlarmName);

    // 重试闭包被重建且真的执行了：`(Retry #N)` 只有 retryIndex > 0 才会打印
    expect(messagesOfType("logger").some((m) => String(m.data?.msg).includes("(Retry #1)"))).toBe(true);
    expect(messagesOfType("logger").some((m) => String(m.data?.msg).includes("Auto-refreshing user information"))).toBe(
      true,
    );
    // 逐站点刷新循环现在真的执行了：修复前该判断恒为假，这里永远是 0 次
    expect(messagesOfType("getSiteUserInfoResult").length).toBeGreaterThan(0);
    // 原条目已被"先取走再执行"消费
    expect(pendingJobs()[retryAlarmName]).toBeUndefined();
    // mock 默认让 getSiteUserInfoResult 失败：retryIndex=1 < retry.max=2，因此链式排下一次重试
    const chainedRetries = Object.values(pendingJobs()).filter((job: any) => job.kind === "flushUserInfoRetry");
    expect(chainedRetries).toHaveLength(1);
    expect(chainedRetries[0]).toMatchObject({ retryIndex: 2 });
  });

  it("站点配置缺少 allowQueryUserInfo 时仍按默认允许刷新", async () => {
    await chromeMock.storage.local.set({
      config: { userInfo: { autoReflush: { enabled: true, retry: { max: 0 } } } },
      metadata: { sites: { siteA: { url: "https://site.example" } }, lastUserInfoAutoFlushAt: 0 },
      [PENDING_JOB_KEY]: {
        "flushUserInfo-Retry-partial": {
          kind: "flushUserInfoRetry",
          retryIndex: 1,
          fireAt: Date.now(),
        },
      },
    });
    await bootServiceWorker();

    await fireAlarm("flushUserInfo-Retry-partial");

    expect(messagesOfType("getSiteUserInfoResult").map((message) => message.data)).toContain("siteA");
  });

  it("同一个 alarm 触发两次也只执行一次（先取走再执行）", async () => {
    await bootServiceWorker();
    await dispatchMessage("reDownloadTorrent", { ...downloadOption, leftInterval: 60 * 1000 });
    await bootServiceWorker();

    await fireAlarm("reDownloadTorrent-42");
    await fireAlarm("reDownloadTorrent-42");

    expect(messagesOfType("downloadTorrent")).toHaveLength(1);
  });

  it("H-11：冷启动扫描重建了刚触发的 alarm，重复触发不得把已成功的重新下载改判 failed", async () => {
    await bootServiceWorker();
    await dispatchMessage("reDownloadTorrent", { ...downloadOption, leftInterval: 60 * 1000 });

    // 真实浏览器：SW 被该 alarm 唤醒时 alarms.get 已查不到它（onAlarm 触发即视为已消费），参数仍在
    createdAlarms.delete("reDownloadTorrent-42");
    await bootServiceWorker();
    await settle();
    // 冷启动的恢复扫描把它当成「丢失的 alarm」重建了一次
    expect(createdAlarms.has("reDownloadTorrent-42")).toBe(true);

    await fireAlarm("reDownloadTorrent-42"); // 原 alarm：执行并成功
    await fireAlarm("reDownloadTorrent-42"); // 重建出的 alarm：约 1 秒后再次触发

    expect(messagesOfType("downloadTorrent")).toHaveLength(1);
    expect(downloadHistoryStatus()).toEqual([]);

    // 再次冷启动也不会把墓碑复活成待执行任务
    createdAlarms.clear();
    await bootServiceWorker();
    await settle();
    expect(createdAlarms.has("reDownloadTorrent-42")).toBe(false);
  });

  it("不处理与自身无关的 alarm（interval job / nativeMessaging）", async () => {
    await bootServiceWorker();

    // interval job 仍由 job-scheduler 正常注册（本模块只接管两类一次性 alarm）
    expect(createdAlarms.has("flushUserInfo")).toBe(true);
    expect(createdAlarms.has("autoBackup")).toBe(true);

    await fireAlarm("nativeBridgeReconnect");

    expect(downloadHistoryStatus()).toEqual([]);
    expect(pendingJobs()).toEqual({});
  });
});
