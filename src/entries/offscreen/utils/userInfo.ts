import PQueue from "p-queue";
import { format } from "date-fns";
import { isEmpty } from "es-toolkit/compat";
import type { IUserInfo } from "@ptd/site";
import { EResultParseStatus } from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import type { TUserInfoStorageSchema } from "@/shared/types.ts";

import { logger } from "./logger.ts";
import { getSiteInstance } from "./site.ts";

const flushQueue = new PQueue({ concurrency: 1 }); // 默认设置为 1，配置会在入队前尽快同步
const setSiteLastUserInfoQueue = new PQueue({ concurrency: 1 }); // 专门用于 setSiteLastUserInfo 的队列

type TGetSiteUserInfoPayload = string | { siteId: string; queueConcurrency?: number };

/**
 * 性能说明（见 docs/performance-audit.md P0-2 / P0-3）：
 * 用户信息刷新是「按站点串行遍历」的高频路径。早期实现每个站点都会
 *   1) 整份读取 config（队列并发参数）
 *   2) 整份读取 metadata（只为了 lastUserInfo[siteId]）
 *   3) 整份读取 + 整份写回 metadata（只改 lastUserInfo[siteId]）
 *   4) 整份读取 + 整份写回 userInfo（只改 userInfo[siteId][date]）
 * 单站点约 5 次全量对象的跨上下文往返；N 个站点即 O(N × 全量体积)。
 * 现改为：
 *   - 队列并发参数走 getExtStoragePath（只取一个数字）；
 *   - lastUserInfo / userInfo 的读取走 getExtStoragePath；
 *   - 写入走 patchExtStoragePath（在 SW 内读改写，数据不跨上下文往返，且串行化避免丢失更新）。
 */
async function getQueueConcurrency(): Promise<number> {
  const queueConcurrency = await sendMessage("getExtStoragePath", {
    key: "config",
    path: "userInfo.queueConcurrency",
  });
  return typeof queueConcurrency === "number" && queueConcurrency > 0 ? queueConcurrency : 1;
}

/**
 * 队列并发度的**唯一来源**（OS-4 修复）。
 *
 * 旧实现在 `flushQueue.on("active")` 里每个任务启动时都读一遍 config 并覆盖 concurrency，
 * 与调用方显式传入的 `queueConcurrency` 互相打架（调用方的值在首个任务开始后即失效），
 * 且每处理一个站点就多一次 SW 往返。
 *
 * 现在：
 *   - 调用方显式传入（options 每次刷新都会带当前配置值）→ 直接采用，并记为最近一次的配置值；
 *   - 未显式传入（background 自动刷新）→ 首次读一次 config 并记住；之后沿用缓存值，
 *     直到某次调用方显式传入新值（config 只可能被 options 修改，而 options 总会显式传入）。
 */
let memoizedQueueConcurrency: number | null = null;
/** 首次从 config 读取并发度的 in-flight promise：并发的首批调用共享同一次 SW 往返 */
let configConcurrencyInFlight: Promise<number> | null = null;

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ("config" in changes || "userInfo.queueConcurrency" in changes)) {
      memoizedQueueConcurrency = null;
    }
  });
}

function isValidQueueConcurrency(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function setQueueConcurrency(queueConcurrency: number) {
  const next = Math.floor(queueConcurrency);
  if (!isValidQueueConcurrency(next)) {
    return;
  }
  memoizedQueueConcurrency = next;
  if (flushQueue.concurrency !== next) {
    flushQueue.concurrency = next;
    logger({
      msg: `The concurrency of the user information refresh queue has been updated to ${flushQueue.concurrency}`,
    });
  }
}

async function applyQueueConcurrency(queueConcurrency?: number) {
  if (isValidQueueConcurrency(queueConcurrency)) {
    setQueueConcurrency(queueConcurrency);
    return;
  }

  if (memoizedQueueConcurrency === null) {
    try {
      configConcurrencyInFlight ??= getQueueConcurrency().finally(() => {
        configConcurrencyInFlight = null;
      });
      setQueueConcurrency(await configConcurrencyInFlight);
    } catch (e) {
      // 读取配置失败（SW 回收/通道断开）时保持当前并发，不让整批刷新失败。
      logger({ msg: "Failed to read user info queue concurrency, keep current value", level: "warn", data: `${e}` });
    }
    return;
  }

  if (flushQueue.concurrency !== memoizedQueueConcurrency) {
    flushQueue.concurrency = memoizedQueueConcurrency;
  }
}

function normalizeGetSiteUserInfoPayload(payload: TGetSiteUserInfoPayload) {
  if (typeof payload === "string") {
    return { siteId: payload, queueConcurrency: undefined };
  }

  return payload;
}

/**
 * 队列取消的控制句柄（见 B-12）。
 *
 * 早期实现用 `flushQueue.clear()` 取消：p-queue@9 的 `clear()` 只是把内部队列换成一个新队列，
 * **不会 settle** 被丢弃任务的 promise（其源码注释只承诺 `empty`/`idle` 事件）。
 * 于是 `await flushQueue.add(...)` 永久悬挂，SW 侧 `await sendMessage("getSiteUserInfoResult", …)`
 * 也永久悬挂，`try/finally` 到不了 `releaseLock`，`userInfoAutoFlushLock` 会被占到 TTL 过期为止。
 *
 * 现在改为：每次入队都带上当前批次的 AbortSignal，取消时 abort 该信号。
 * p-queue 对「排队中」与「执行中」的任务都会以 `signal.reason` reject，
 * 从而保证**每一个 `add()` 的 promise 都有归宿**（以 AbortError settle）。
 * 取消后立即换一个新的 controller：之后新入队的任务不应继承已 abort 的信号。
 */
let flushAbortController = new AbortController();

/** 构造 AbortError：优先用 DOMException（name 即 AbortError），环境不支持时用同名 Error 兜底 */
function createAbortError(message: string): Error {
  if (typeof DOMException === "function") {
    return new DOMException(message, "AbortError");
  }
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * 取消当前批次：所有已入队/执行中的 `getSiteUserInfoResult` 都会以 AbortError reject。
 *
 * 注意：正在执行的站点抓取无法被真正中断（网络请求没有可用的 signal），
 * 它仍可能在稍后完成并写入 `lastUserInfo`；这里保证的是**调用方一定拿到结果**（成功或失败），
 * 不会再有悬挂的 await 把锁占死。
 */
export function cancelUserInfoQueue(): void {
  const cancelled = flushAbortController;
  flushAbortController = new AbortController();
  cancelled.abort(createAbortError("User info refresh queue was cancelled"));
}

onMessage("cancelUserInfoQueue", () => {
  cancelUserInfoQueue();
});

export async function getSiteUserInfoResult(payload: TGetSiteUserInfoPayload) {
  const signal = flushAbortController.signal;
  if (signal.aborted) {
    throw signal.reason;
  }
  const { siteId, queueConcurrency } = normalizeGetSiteUserInfoPayload(payload);
  await applyQueueConcurrency(queueConcurrency);
  if (signal.aborted) {
    throw signal.reason;
  }

  return (await flushQueue.add(
    async () => {
      logger({ msg: `getSiteUserInfoResult for ${siteId}` });

      // 获取站点实例和配置信息
      const site = await getSiteInstance<"private">(siteId);

      // 尝试延长cookies
      try {
        await sendMessage("checkAndExtendCookies", site.url);
      } catch (error) {
        // 静默处理错误，不影响用户信息获取流程
        logger({ msg: `Failed to extend cookies for site ${siteId}`, level: "debug" });
      }

      // 获取历史信息（只取当前站点，避免整份 metadata / config 跨上下文传输）
      let lastUserInfo =
        ((await sendMessage("getExtStoragePath", {
          key: "metadata",
          path: ["lastUserInfo", siteId],
          defaultValue: {},
        })) as IUserInfo) ?? {};
      const alwaysPickLastUserInfo = await sendMessage("getExtStoragePath", {
        key: "config",
        path: "userInfo.alwaysPickLastUserInfo",
        defaultValue: true,
      });
      if (!(alwaysPickLastUserInfo ?? true) || lastUserInfo.status !== EResultParseStatus.success) {
        lastUserInfo = {} as IUserInfo;
      }

      let userInfo = lastUserInfo;
      if (site.allowQueryUserInfo) {
        // 调用站点实例获取用户信息
        userInfo = await site.getUserInfoResult(userInfo);
      } else if (site.metadata.type === "private" && !site.isOnline && isEmpty(lastUserInfo)) {
        // 如果 private 站点不允许查询用户信息（），则尝试从 userInfo 中获取最近一次的用户信息（回退），以避免 metadata.lastUserInfo 为 undefined 的情况
        const userInfoSite =
          ((await sendMessage("getExtStoragePath", {
            key: "userInfo",
            path: [siteId],
            defaultValue: {},
          })) as TUserInfoStorageSchema[string]) ?? {};

        let maxDate = null;
        for (const date in userInfoSite) {
          if (
            userInfoSite[date].status === EResultParseStatus.success && // 如果是 PTPP 导入，可能存在 status 为 unknownError 的情况
            (!maxDate || new Date(date) > new Date(maxDate))
          ) {
            maxDate = date;
          }
        }

        if (maxDate) {
          userInfo = userInfoSite[maxDate];
        }
      }

      await setSiteLastUserInfo(userInfo);
      return userInfo!;
    },
    { signal },
  ))!;
}

onMessage("getSiteUserInfoResult", async ({ data }) => await getSiteUserInfoResult(data));

export async function setSiteLastUserInfo(userData: IUserInfo) {
  return setSiteLastUserInfoQueue.add(async () => {
    const site = userData.site;

    // B1-12：只有解析成功的载荷才会走到写库，但 `updateAt` 可能来自恢复的历史数据/异常载荷
    // （非 number）。`date-fns.format` 对非法值会抛 `RangeError: Invalid time value`，
    // 使该站点之后每次刷新都在这里失败。统一兜底为当前时间，保证写入形状与后续刷新都正常。
    if (!Number.isFinite(userData.updateAt as number)) {
      logger({
        msg: `Invalid updateAt for site ${site}, fallback to current time`,
        level: "warn",
        data: { site, updateAt: userData.updateAt },
      });
      userData = { ...userData, updateAt: Date.now() };
    }

    // 日志只保留摘要，避免把完整用户信息（含做种列表）写入日志缓冲
    logger({
      msg: `setSiteLastUserInfo for ${site}`,
      data: { site, status: userData.status, updateAt: userData.updateAt },
    });

    // OFFSCREEN-2：只有解析成功的载荷才能覆盖 metadata.lastUserInfo。
    // 失败载荷只有 status/updateAt/site（加上引擎 pickLast 保留的少量字段，NexusPHP 只有 id），
    // 无条件整份覆盖会把上一次成功快照的 uploaded/downloaded/ratio/levelName/seedingSize 抹掉，
    // 而 updateAt 又被刷新为当前时间 —— MyData 主表会显示空值且看不出是失败。
    // 失败状态仍由 getSiteUserInfoResult 的返回值交给调用方（options 侧 flushSiteLastUserInfo 会提示），
    // 这里只记日志，不落库。
    if (userData.status !== EResultParseStatus.success) {
      logger({
        msg: `Skip updating metadata.lastUserInfo for ${site}: status is ${EResultParseStatus[userData.status]}`,
        level: "warn",
        data: { site, status: userData.status, statusMsg: userData.statusMsg },
      });
      return;
    }

    // 存储用户信息到 metadata 中（ pinia/webExtPersistence 会自动同步该部分信息 ）
    await sendMessage("patchExtStoragePath", {
      key: "metadata",
      path: ["lastUserInfo", site],
      value: userData,
    });

    // 存储用户信息到 userInfo 中（仅当获取成功时）
    if (userData.status === EResultParseStatus.success) {
      const dateTime = format(userData.updateAt, "yyyy-MM-dd");
      await sendMessage("patchExtStoragePath", {
        key: "userInfo",
        path: [site, dateTime],
        value: userData,
      });
    }
  });
}

onMessage("setSiteLastUserInfo", async ({ data: userData }) => await setSiteLastUserInfo(userData));

onMessage("getSiteUserInfo", async ({ data: siteId }) => {
  return (
    ((await sendMessage("getExtStoragePath", {
      key: "userInfo",
      path: [siteId],
      defaultValue: {},
    })) as TUserInfoStorageSchema[string]) ?? {}
  );
});

onMessage("removeSiteUserInfo", async ({ data: { siteId, date } }) => {
  for (const day of date) {
    await sendMessage("patchExtStoragePath", {
      key: "userInfo",
      path: [siteId, day],
      remove: true,
    });
  }
});
