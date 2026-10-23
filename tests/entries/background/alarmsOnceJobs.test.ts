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
  // N2 修复后消息层 fail-closed：只有能证明是扩展页（sender.id + 扩展 URL）的发送方才可信。
  // 这里模拟 offscreen 文档的通常 sender 形状，否则 reDownloadTorrent 会被消息层拒绝。
  const sender = {
    id: "test-extension-id",
    url: "chrome-extension://test/offscreen.html",
  };
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
      const result = listener({ id: nextMessageId++, type, data, timestamp: Date.now() }, sender, settleOne);
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

/**
 * 当前已排程的重新下载 alarm 名（BACKGROUNDSHARED-2）。
 * 名字不再是可以写死的 `reDownloadTorrent-<downloadId>`，而是带 `~<fireAt>~<随机后缀>` 的唯一名，
 * 因此必须从 mock 的 alarm 表里反查。
 */
function reDownloadAlarmNames(): string[] {
  return [...createdAlarms.keys()].filter((name) => name.startsWith("reDownloadTorrent-"));
}

function onlyReDownloadAlarmName(): string {
  const names = reDownloadAlarmNames();
  expect(names, "应当只有一个待执行的重新下载 alarm").toHaveLength(1);
  return names[0]!;
}

function downloadHistoryStatus() {
  return messagesOfType("setDownloadHistoryStatus").map((message) => message.data);
}

/** 种入一条「SW 在首次执行期间被回收、租期已过」的 running 记录（attempt=1 表示首次执行） */
function seedExpiredRunningJob(name: string, downloadId: number, attempt: number) {
  const at = Date.now() - 6 * 60_000;
  backing.set(PENDING_JOB_KEY, {
    [name]: {
      kind: "running",
      job: { kind: "reDownloadTorrent", downloadId, downloadOption: { ...downloadOption, downloadId }, fireAt: at },
      owner: "lost-worker",
      at,
      fireAt: at,
      attempt,
    },
  });
}

/** 让 getDownloadHistory 返回指定历史（用于重放策略用例） */
function mockDownloadHistory(records: Array<Record<string, unknown>> | Error) {
  sendMessageHandler = (message, respond) => {
    if (message.type !== "getDownloadHistory") return false;
    if (records instanceof Error) {
      respond({ err: records });
    } else {
      respond({ res: records });
    }
    return true;
  };
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

    const alarmName = onlyReDownloadAlarmName();
    // downloadId 仍编码在名字里（失败标记要能解析回来），但名字不再是 `<prefix><downloadId>`
    expect(alarmName.startsWith("reDownloadTorrent-42~")).toBe(true);
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
    const alarmName = onlyReDownloadAlarmName();

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

    await fireAlarm(alarmName);

    expect(downloadHistoryStatus()).toEqual([{ downloadId: 42, status: "failed" }]);
    expect(messagesOfType("logger").some((m) => String(m.data?.msg).includes("Re-download failed"))).toBe(true);
    // 失败任务同样被清理，不会反复重试
    expect(pendingJobs()).toEqual({});
  });

  it("alarm 触发但参数缺失：判定 failed，而不是静默丢失", async () => {
    await bootServiceWorker();

    // 旧式名字（升级前排下的 alarm）也必须能解析出 downloadId
    await fireAlarm("reDownloadTorrent-99");

    expect(downloadHistoryStatus()).toEqual([{ downloadId: 99, status: "failed" }]);
  });

  it("alarm 触发但参数缺失：新式名字（含负数投递 id）同样解析并判定 failed", async () => {
    await bootServiceWorker();

    // 关闭下载历史时 offscreen 会用负数序列 id（见 PLAN 跨包契约），名字里带唯一后缀
    await fireAlarm("reDownloadTorrent--3~1700000000000~deadbeef");

    expect(downloadHistoryStatus()).toEqual([{ downloadId: -3, status: "failed" }]);
  });

  it("leftInterval < 30s：不再 sleep 占住消息通道，统一按 alarms 排程", async () => {
    await bootServiceWorker();

    const startedAt = Date.now();
    await dispatchMessage("reDownloadTorrent", { ...downloadOption, leftInterval: 5000 });

    // 旧实现在这里 `await sleep(5000)`，消息处理要 5s 后才返回
    expect(Date.now() - startedAt).toBeLessThan(1000);
    const alarmName = onlyReDownloadAlarmName();
    expect(createdAlarms.has(alarmName)).toBe(true);
    expect(pendingJobs()[alarmName]).toMatchObject({ kind: "reDownloadTorrent", downloadId: 42 });
    expect(messagesOfType("downloadTorrent")).toHaveLength(0);
  });

  it("BACKGROUNDSHARED-2：关闭下载历史时 downloadId 恒为 0，多个延迟下载不得互相覆盖", async () => {
    await bootServiceWorker();

    // 两个「未到站点下载间隔」的任务都拿到同一条投递 id（历史关闭时 setDownloadHistory 返回 0）
    await dispatchMessage("reDownloadTorrent", { ...downloadOption, downloadId: 0, leftInterval: 60 * 1000 });
    await dispatchMessage("reDownloadTorrent", {
      ...downloadOption,
      downloadId: 0,
      torrent: { ...downloadOption.torrent, id: 2, title: "Second Torrent" },
      leftInterval: 90 * 1000,
    });

    // 旧实现两者都叫 `reDownloadTorrent-0`：chrome.alarms 同名覆盖 + payload 同名覆盖，先投递者永久丢失
    const names = reDownloadAlarmNames();
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(
      Object.values(pendingJobs()).filter((job: any) => job?.kind === "reDownloadTorrent"),
      "两条 payload 必须同时保留",
    ).toHaveLength(2);

    // SW 回收重启后，两个 alarm 都能各自执行一次（先投递者不再永不终态）
    await bootServiceWorker();
    await fireAlarm(names[0]!);
    await fireAlarm(names[1]!);

    expect(messagesOfType("downloadTorrent")).toHaveLength(2);
    expect(pendingJobs()).toEqual({});
  });

  it("BACKGROUNDSHARED-2：对账按任务名反查，新式 alarm 名仍能匹配到等待中的任务（不提前判死）", async () => {
    await bootServiceWorker();
    await dispatchMessage("reDownloadTorrent", { ...downloadOption, downloadId: 7, leftInterval: 60 * 60 * 1000 });
    const alarmName = onlyReDownloadAlarmName();

    // 下载历史里这条记录已超期未推进，但参数与 alarm 都还在：L-4 第 2 层不能提前判死
    sendMessageHandler = (message, sendResponse) => {
      if (message.type !== "getDownloadHistory") {
        return false;
      }
      sendResponse({
        res: [{ id: 7, downloadStatus: "pending", downloadAt: Date.now() - 24 * 60 * 60 * 1000 }],
      });
      return true;
    };

    // 让冷启动再跑一次恢复扫描（清掉 6h 节流检查点）
    sessionBacking.clear();
    await bootServiceWorker();
    await settle();

    expect(createdAlarms.has(alarmName)).toBe(true);
    expect(downloadHistoryStatus()).toEqual([]);
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
    const alarmName = onlyReDownloadAlarmName();
    await bootServiceWorker();

    await fireAlarm(alarmName);
    await fireAlarm(alarmName);

    expect(messagesOfType("downloadTorrent")).toHaveLength(1);
  });

  it("执行过程中的重复 alarm 不能再次投递，完成后才写 consumed", async () => {
    await bootServiceWorker();
    await dispatchMessage("reDownloadTorrent", { ...downloadOption, leftInterval: 60_000 });
    const name = onlyReDownloadAlarmName();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    sendMessageHandler = (message, respond) => {
      if (message.type !== "downloadTorrent") return false;
      void gate.then(() => respond({ res: { downloadStatus: "completed" } }));
      return true;
    };

    await fireAlarm(name);
    expect((backing.get(PENDING_JOB_KEY) as Record<string, any>)[name]).toMatchObject({ kind: "running" });
    await fireAlarm(name);
    expect(messagesOfType("downloadTorrent")).toHaveLength(1);
    finish();
    await vi.waitFor(() =>
      expect((backing.get(PENDING_JOB_KEY) as Record<string, any>)[name]).toMatchObject({ kind: "consumed" }),
    );
  });

  it("真实首次执行已投递后 SW 回收：重放按历史 completed 跳过，不再投递（只完成一次）", async () => {
    await bootServiceWorker();
    await dispatchMessage("reDownloadTorrent", { ...downloadOption, leftInterval: 60_000 });
    const name = onlyReDownloadAlarmName();

    // 首次执行**真实发生**：downloadTorrent 已发出，任务进入 running；响应永不返回 = 执行中 SW 被回收
    sendMessageHandler = (message) => message.type === "downloadTorrent"; // 捕获但不响应
    await fireAlarm(name);
    expect(messagesOfType("downloadTorrent"), "首次执行必须真实发生过一次").toHaveLength(1);
    expect((backing.get(PENDING_JOB_KEY) as Record<string, any>)[name]).toMatchObject({
      kind: "running",
      attempt: 1,
    });

    // 模拟下一次租期重放：租期已过 + 历史显示 completed（首次执行副作用已完成，只是墓碑没写成）
    const stored = (backing.get(PENDING_JOB_KEY) as Record<string, any>)[name];
    stored.at = Date.now() - 6 * 60_000;
    stored.fireAt = stored.at;
    createdAlarms.delete(name);
    mockDownloadHistory([{ id: 42, downloadStatus: "completed" }]);

    await bootServiceWorker();
    await fireAlarm(name);

    expect(messagesOfType("downloadTorrent"), "重放不得第二次投递").toHaveLength(1);
    expect((backing.get(PENDING_JOB_KEY) as Record<string, any>)[name]).toMatchObject({ kind: "consumed" });
    expect(downloadHistoryStatus()).toEqual([]); // 已完成的记录不得被判 failed
  });

  it("重放：历史 pending/downloading 视为已投递，不重放（也不误判 failed）", async () => {
    for (const status of ["pending", "downloading"]) {
      backing.clear();
      createdAlarms.clear();
      sentMessages = [];
      seedExpiredRunningJob("reDownloadTorrent-42~replay-status", 42, 1);
      mockDownloadHistory([{ id: 42, downloadStatus: status }]);
      await bootServiceWorker();
      await fireAlarm("reDownloadTorrent-42~replay-status");

      expect(messagesOfType("downloadTorrent"), `status=${status} 不得重放`).toHaveLength(0);
      expect((backing.get(PENDING_JOB_KEY) as Record<string, any>)["reDownloadTorrent-42~replay-status"]).toMatchObject(
        { kind: "consumed" },
      );
      expect(downloadHistoryStatus()).toEqual([]);
    }
  });

  it("重放：负数 downloadId（关闭下载历史时的 ephemeral id）不重放", async () => {
    seedExpiredRunningJob("reDownloadTorrent--3~replay-negative", -3, 1);
    await bootServiceWorker();
    await fireAlarm("reDownloadTorrent--3~replay-negative");

    expect(messagesOfType("downloadTorrent")).toHaveLength(0);
    expect((backing.get(PENDING_JOB_KEY) as Record<string, any>)["reDownloadTorrent--3~replay-negative"]).toMatchObject(
      {
        kind: "consumed",
      },
    );
  });

  it("重放：历史里没有该记录（首次执行未落记录）时才重放", async () => {
    seedExpiredRunningJob("reDownloadTorrent-42~replay-no-record", 42, 1);
    mockDownloadHistory([]);
    await bootServiceWorker();
    await fireAlarm("reDownloadTorrent-42~replay-no-record");

    expect(messagesOfType("downloadTorrent")).toHaveLength(1);
  });

  it("重放：预检读取下载历史失败时继续执行（不把未执行任务判 failed）", async () => {
    seedExpiredRunningJob("reDownloadTorrent-42~replay-precheck-error", 42, 1);
    mockDownloadHistory(new Error("Could not establish connection. Receiving end does not exist."));
    await bootServiceWorker();
    await fireAlarm("reDownloadTorrent-42~replay-precheck-error");

    expect(messagesOfType("downloadTorrent"), "判不了就继续执行").toHaveLength(1);
    expect(downloadHistoryStatus()).toEqual([]);
  });

  it("重放上限 MAX_REPLAY_ATTEMPTS=3：第 3 次重放仍执行，第 4 次判 failed 且不投递", async () => {
    // 已重放 3 次（attempt-1=3）仍允许最后一次重放
    seedExpiredRunningJob("reDownloadTorrent-42~replay-3", 42, 3);
    mockDownloadHistory([]);
    await bootServiceWorker();
    await fireAlarm("reDownloadTorrent-42~replay-3");
    expect(messagesOfType("downloadTorrent")).toHaveLength(1);

    backing.clear();
    createdAlarms.clear();
    sentMessages = [];
    // attempt-1=4 超过上限 → 判 failed，不再投递
    seedExpiredRunningJob("reDownloadTorrent-42~replay-4", 42, 4);
    await bootServiceWorker();
    await fireAlarm("reDownloadTorrent-42~replay-4");
    expect(messagesOfType("downloadTorrent")).toHaveLength(0);
    expect(downloadHistoryStatus()).toEqual([{ downloadId: 42, status: "failed" }]);
  });

  it("未过期 running 记录冷启动只补租期闹钟，不会提前重放", async () => {
    const name = "reDownloadTorrent-42~active";
    const at = Date.now();
    backing.set(PENDING_JOB_KEY, {
      [name]: {
        kind: "running",
        job: { kind: "reDownloadTorrent", downloadId: 42, downloadOption, fireAt: at },
        owner: "live-worker",
        at,
        fireAt: at,
        attempt: 1,
      },
    });
    await bootServiceWorker();
    await settle();
    expect(createdAlarms.get(name)!.scheduledTime).toBeGreaterThanOrEqual(at + 5 * 60_000);
    await fireAlarm(name);
    expect(messagesOfType("downloadTorrent")).toHaveLength(0);
  });

  it("H-11：冷启动扫描重建了刚触发的 alarm，重复触发不得把已成功的重新下载改判 failed", async () => {
    await bootServiceWorker();
    await dispatchMessage("reDownloadTorrent", { ...downloadOption, leftInterval: 60 * 1000 });
    const alarmName = onlyReDownloadAlarmName();

    // 真实浏览器：SW 被该 alarm 唤醒时 alarms.get 已查不到它（onAlarm 触发即视为已消费），参数仍在
    createdAlarms.delete(alarmName);
    await bootServiceWorker();
    await settle();
    // 冷启动的恢复扫描把它当成「丢失的 alarm」重建了一次
    expect(createdAlarms.has(alarmName)).toBe(true);

    await fireAlarm(alarmName); // 原 alarm：执行并成功
    await fireAlarm(alarmName); // 重建出的 alarm：约 1 秒后再次触发

    expect(messagesOfType("downloadTorrent")).toHaveLength(1);
    expect(downloadHistoryStatus()).toEqual([]);

    // 再次冷启动也不会把墓碑复活成待执行任务
    createdAlarms.clear();
    await bootServiceWorker();
    await settle();
    expect(createdAlarms.has(alarmName)).toBe(false);
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

describe("alarms：N7 锁占用时重试不得被静默消费", () => {
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

  it("重试 alarm 到点时上一轮仍持锁 → 重新排程（带次数上限），而不是写 consumed 墓碑", async () => {
    await bootServiceWorker();

    const retryAlarmName = "flushUserInfo-Retry-1-1700000000000";
    backing.set(PENDING_JOB_KEY, {
      [retryAlarmName]: { kind: "flushUserInfoRetry", retryIndex: 1, fireAt: Date.now() + 60_000 },
    });
    await chromeMock.storage.local.set({
      config: { userInfo: { autoReflush: { enabled: true, retry: { max: 5, interval: 5 } } } },
      metadata: { sites: {}, lastUserInfoAutoFlushAt: 0 },
    });
    // 另一轮正在刷新：锁在 TTL 内、owner 不是本次任务
    sessionBacking.set("userInfoAutoFlushLock", { at: Date.now(), owner: "another-round" });

    await bootServiceWorker();
    await fireAlarm(retryAlarmName);

    // 本次没有被当成「已完成」：旧 alarm 写墓碑（pendingJobs 会过滤 consumed），
    // 同时排出一条新的重试任务（lockRescheduleCount 递增）
    const retries = Object.entries(pendingJobs()).filter(
      ([, job]: [string, any]) => job?.kind === "flushUserInfoRetry",
    );
    expect(retries).toHaveLength(1);
    const [nextAlarmName, nextJob] = retries[0] as [string, any];
    expect(nextAlarmName).not.toBe(retryAlarmName);
    expect(nextJob).toMatchObject({ retryIndex: 1, lockRescheduleCount: 1 });

    // 不是「立刻」重试：按配置的 retry.interval（5 分钟）之后
    const scheduledTime = createdAlarms.get(nextAlarmName)!.scheduledTime;
    expect(scheduledTime).toBeGreaterThan(Date.now() + 4 * 60_000);

    // 本轮没有真正刷新用户信息，也没有误报失败
    expect(messagesOfType("getSiteUserInfoResult")).toHaveLength(0);
    expect(messagesOfType("setDownloadHistoryStatus")).toHaveLength(0);
    expect(messagesOfType("logger").some((message) => String(message.data?.msg).includes("rescheduled"))).toBe(true);
  });

  it("重试遇到锁时最多重排 3 次，之后放弃并记录错误（不会无限重排）", async () => {
    await bootServiceWorker();

    const retryAlarmName = "flushUserInfo-Retry-1-already-rescheduled";
    backing.set(PENDING_JOB_KEY, {
      [retryAlarmName]: {
        kind: "flushUserInfoRetry",
        retryIndex: 1,
        fireAt: Date.now() + 60_000,
        lockRescheduleCount: 3,
      },
    });
    await chromeMock.storage.local.set({
      config: { userInfo: { autoReflush: { enabled: true, retry: { max: 5, interval: 5 } } } },
      metadata: { sites: {}, lastUserInfoAutoFlushAt: 0 },
    });
    sessionBacking.set("userInfoAutoFlushLock", { at: Date.now(), owner: "another-round" });

    await bootServiceWorker();
    await fireAlarm(retryAlarmName);

    // 不再产生新的重试任务
    expect(Object.values(pendingJobs()).filter((job: any) => job?.kind === "flushUserInfoRetry")).toHaveLength(0);
    // 放弃必须可见（logBackgroundError 会同时写 console.warn 与 logger 通道）
    expect(messagesOfType("logger").some((message) => String(message.data?.msg).includes("gave up"))).toBe(true);
  });
});
