import { format } from "date-fns";
import { defineJobScheduler } from "@webext-core/job-scheduler";
import { EResultParseStatus, type TSiteID } from "@ptd/site/types/base.ts";

import { onMessage, sendMessage } from "@/messages.ts";
import { IDownloadTorrentOption, type ITorrentDownloadMetadata } from "@/shared/types.ts";

import { getExtStoragePathCached, logBackgroundError, patchExtStoragePathLocal } from "./base.ts";
import { setupOffscreenDocument } from "./offscreen.ts";

export enum EJobType {
  FlushUserInfo = "flushUserInfo",
  ReDownloadTorrent = "reDownloadTorrent",
  AutoBackup = "autoBackup",
}

const jobs = defineJobScheduler();

const USER_INFO_LOCK_KEY = "userInfoAutoFlushLock";
/**
 * 锁的 TTL：从**上一次心跳**（`at`）起算，而不是从本轮开始起算。
 *
 * 见 L-3：单轮串行刷新所有站点可能远超 30 分钟（每站点默认 30s 超时 × N 个站点），
 * 若只用一个固定的「开始时间」TTL，另一轮定时任务会在本轮仍在跑时判定锁已超时并**并发**启动第二轮。
 * 因此 `autoFlushUserInfo` 每处理完一个站点都会调用 `renewLock` 刷新 `at`；
 * 这里的 TTL 只需大于「单个站点的最长耗时」（SW 侧等待另有 USER_INFO_SITE_WAIT_TIMEOUT 兜底）。
 */
const USER_INFO_LOCK_TTL = 30 * 60 * 1000; // 30 分钟：超过则视为上一次执行已随 SW 回收而中断

/**
 * SW 侧等待 offscreen 返回单站点用户信息的兜底超时（见 B-12）。
 *
 * `cancelUserInfoQueue` 已保证被取消的任务一定 settle，但这条 await 还面临其它永久悬挂的可能
 * （offscreen 在任务执行中途被回收、消息通道静默断开等）。没有兜底就意味着 `finally` 里的
 * `releaseLock` 永远不会执行，锁会被占到 TTL 过期为止，期间每一轮定时任务都只能 "already running, skip"。
 * 取 5 分钟：远大于正常单站点耗时（站点自身的请求超时默认 30s），只作为最后一道保险。
 */
const USER_INFO_SITE_WAIT_TIMEOUT = 5 * 60 * 1000;

/** 记录锁的重启/归还情况，供诊断并发重复刷新 */
type TLockRecord = { at?: number; owner?: string };

/**
 * logger 消息自身失败时的兜底：只写 SW 控制台。
 * 刻意不走 logBackgroundError —— 那会再次调用 logger，形成递归。
 */
const onLoggerSendFailed = (e: unknown) => console.warn("[PTD] failed to send logger message:", e);

/**
 * 任务互斥锁（见 docs/performance-audit.md P1-6）。
 *
 * 两个 interval job 都是 10 分钟一次，而单次用户信息刷新（串行遍历所有站点）
 * 可能超过 10 分钟；若上一次还没结束就再次触发，会产生重复的网络刷新。
 * 这里用 chrome.storage.session 记录"执行中"标记（可跨 SW 回收保留），
 * 并带 TTL 兜底，避免异常退出后永久锁死。
 *
 * 修复 P1（fail-open + TOCTOU 误删锁）：
 * - 锁值带 `owner`（本次执行的随机 id）。旧实现 releaseLock 无条件 remove(key)：
 *   当本轮超过 TTL 被判定为"已中断"、另一轮重新加锁后，先结束的那一轮会把**别人的锁**删掉，
 *   于是后续调度又能加锁，导致并发重复刷新。现在只有 owner 匹配才删除。
 * - 读不到 session（环境不支持 / 读取异常）时不再静默 `return true`，而是记录一次日志。
 *   注意：chrome.storage 没有 CAS 原语，"读-判-写"之间仍存在极小竞态窗口，
 *   但 owner 校验消除了最坏后果（误删他人锁）；极端情况下最坏退化为一次重复执行。
 *
 * @returns 成功持有锁时返回本次执行的 owner；未持有（他人持有中）返回 null
 */
async function acquireLock(key: string): Promise<string | null> {
  const owner = crypto.randomUUID(); // 本次执行的唯一所有权标识

  try {
    const session = chrome.storage?.session;
    if (!session) {
      // 环境不支持 session storage（如部分 Firefox 版本）时退化为不互斥，但显式记录，不再静默 fail-open
      logBackgroundError(`chrome.storage.session unavailable, lock "${key}" degraded to no-mutex mode`);
      return owner;
    }

    const stored = await session.get(key);
    const lock = stored?.[key] as TLockRecord | undefined;
    const now = Date.now();
    if (lock?.at && now - lock.at < USER_INFO_LOCK_TTL) {
      return null; // 已被其他执行持有且未超时
    }

    const nextLock: TLockRecord = { at: now, owner };
    await session.set({ [key]: nextLock });
    return owner;
  } catch (e) {
    logBackgroundError(`acquireLock("${key}") failed, degraded to no-mutex mode`, e);
    return owner;
  }
}

async function releaseLock(key: string, owner: string): Promise<void> {
  try {
    const session = chrome.storage?.session;
    if (!session) {
      return;
    }

    const stored = await session.get(key);
    const lock = stored?.[key] as TLockRecord | undefined;
    if (lock?.owner === owner) {
      await session.remove(key);
    }
    // owner 不匹配：说明本轮的锁已超时被回收、且已被他人重新持有，绝不能删除
  } catch (e) {
    logBackgroundError(`releaseLock("${key}") failed`, e);
  }
}

/**
 * 续租（心跳）：把锁的 `at` 刷新为当前时间（见 L-3）。
 *
 * 只有仍持有锁（owner 匹配）时才续租，因此也顺带承担了「本轮是否已被他人接管」的探测：
 * 若本轮的锁已因超时被回收、并被另一轮重新加锁，这里会返回 false，调用方应提前结束本轮，
 * 否则两轮会同时向站点发起刷新。
 *
 * @returns 锁仍属于本次执行时返回 true
 */
async function renewLock(key: string, owner: string): Promise<boolean> {
  try {
    const session = chrome.storage?.session;
    if (!session) {
      return true; // 无 session storage 时本来就没有互斥语义
    }

    const stored = await session.get(key);
    const lock = stored?.[key] as TLockRecord | undefined;
    if (lock?.owner !== owner) {
      return false;
    }

    await session.set({ [key]: { at: Date.now(), owner } });
    return true;
  } catch (e) {
    // 续租失败不应中断本轮刷新（最坏后果是该轮被其它轮次误判为超时），但必须留痕
    logBackgroundError(`renewLock("${key}") failed`, e);
    return true;
  }
}

/**
 * 给一个 promise 加超时兜底（见 B-12）。
 *
 * 用 `then(onFulfilled, onRejected)` 而不是 `finally`：既清掉定时器，也避免为派生 promise
 * 引入新的 unhandled rejection 面。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 判断错误是否为「刷新队列被用户取消」造成的 AbortError（见 B-12） */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * 一次性任务参数的持久化（见 docs/performance-audit.md P1-6 / P1-22 的收尾修复）。
 *
 * 背景：`@webext-core/job-scheduler` 的 once job 只把 `execute` 闭包存在**当前 SW 的内存**里
 * （其实现为模块级 `const jobs = {}`），它注册的 `chrome.alarms.onAlarm` 在 `jobs[alarm.name]`
 * 查不到任务时静默 return。而 MV3 的 SW 空闲约 30s 就会被回收，于是两类一次性任务必然丢失：
 * - 用户信息刷新失败后的重试（`retryInterval` 分钟之后）；
 * - 站点下载间隔未到的重新下载（`date: Date.now() + leftInterval`，可达数分钟~数小时）。
 * 闹钟到点后没有可执行的函数，重新下载的下载历史会永远停在 pending。
 *
 * 已核对 `@webext-core/job-scheduler` 的类型与实现（dist/index.d.ts 的 `Job` 只有 `execute`
 * 函数成员，没有任何参数/storage 选项；dist/index.mjs 的 `jobs` 确实是模块内存），
 * 它**不提供**跨 SW 的持久化能力，因此这里自建最小可行的一层：
 * - 排程前把任务的**参数**（而不是闭包）写入 chrome.storage.local；
 * - 本模块顶层注册 chrome.alarms.onAlarm，闹钟唤醒 SW 并重新求值本模块时即可读到参数；
 * - 触发时先"取走"（读取并删除）存储条目再执行，保证重复触发不会重复执行、执行后必然清理。
 *
 * 用 local 而不是 session：alarms 可能跨浏览器重启存活，而 session storage 会随浏览器退出清空，
 * 只有 local 才能保证"闹钟还在，参数就还在"。条目执行后删除 + 排程时顺带清理超期条目，
 * 不会无限增长。
 */
const PENDING_ONCE_JOB_KEY = "ptd_pending_once_jobs";
/** 超期条目兜底清理：浏览器被强杀导致 alarm 丢失时，避免存储里留下永久孤儿条目 */
const PENDING_ONCE_JOB_TTL = 24 * 60 * 60 * 1000;

type TPendingFlushUserInfoRetry = {
  kind: "flushUserInfoRetry";
  /** 下一次执行传给 autoFlushUserInfo 的 retryIndex */
  retryIndex: number;
  /** 计划执行时间，仅用于诊断与超期清理 */
  fireAt: number;
};

type TPendingReDownloadTorrent = {
  kind: "reDownloadTorrent";
  downloadId: number;
  /** 原始 reDownloadTorrent 消息体（结构保持不变，执行时原样透传给 downloadTorrent） */
  downloadOption: IDownloadTorrentOption;
  fireAt: number;
};

/**
 * H-11：已被取走执行的任务留下的墓碑。
 *
 * 冷启动时 SW 往往正是被这个 alarm 唤醒的：onAlarm 触发时 `alarms.get` 已查不到它，而参数还没被取走，
 * 于是 rescheduleLostOnceJobAlarms 会把它当成「丢失的 alarm」重建一次。原 alarm 的处理随即取走并完成任务，
 * 约 1 秒后重建的同名 alarm 再触发，`!job` 分支便把**已经成功**的重新下载写成 failed。
 * 墓碑让「参数已被消费」与「参数从未存在」可区分：前者重复触发是 no-op。
 */
type TConsumedOnceJob = {
  kind: "consumed";
  /** 取走时刻，用于墓碑本身的超期清理 */
  fireAt: number;
};

type TPendingOnceJob = TPendingFlushUserInfoRetry | TPendingReDownloadTorrent;
type TStoredOnceJob = TPendingOnceJob | TConsumedOnceJob;

const RE_DOWNLOAD_ALARM_PREFIX = `${EJobType.ReDownloadTorrent}-`;
const FLUSH_USER_INFO_RETRY_ALARM_PREFIX = `${EJobType.FlushUserInfo}-Retry-`;

/**
 * BACKGROUNDSHARED-2：alarm 名不能只由 downloadId 派生。
 *
 * 关闭下载历史（config.download.saveDownloadHistory=false）时 offscreen 给出的投递 id 曾是恒定值 0，
 * 于是多个「未到站点下载间隔」的延迟下载排到同一个 `reDownloadTorrent-0`：
 * chrome.alarms 同名覆盖 + `addPendingJob` 同名覆盖会顶掉先投递者的 alarm 与 payload，
 * 先投递者永远不执行也不再重试（调用方只拿到 pending）。
 * 现在名字额外带上 fireAt 与随机后缀，任何重复的 downloadId 都不会互相覆盖；
 * downloadId 仍原样放在 payload 里（失败标记需要），旧式 `<prefix><downloadId>` 名字继续可解析。
 */
function reDownloadAlarmName(downloadId: number, fireAt: number): string {
  return `${RE_DOWNLOAD_ALARM_PREFIX}${downloadId}~${fireAt}~${crypto.randomUUID().slice(0, 8)}`;
}

function parseReDownloadAlarmName(alarmName: string): number | undefined {
  if (!alarmName.startsWith(RE_DOWNLOAD_ALARM_PREFIX)) {
    return undefined;
  }
  // 兼容两种名字：新版 `<prefix><downloadId>~<fireAt>~<rand>` 与旧版 `<prefix><downloadId>`
  const downloadId = Number(alarmName.slice(RE_DOWNLOAD_ALARM_PREFIX.length).split("~")[0]);
  return Number.isInteger(downloadId) ? downloadId : undefined;
}

/** 只有本模块自建排程的 alarm 才由本模块的 onAlarm 处理（interval job 与 nativeMessaging 的 alarm 一律跳过） */
function isPendingOnceJobAlarm(alarmName: string): boolean {
  return alarmName.startsWith(RE_DOWNLOAD_ALARM_PREFIX) || alarmName.startsWith(FLUSH_USER_INFO_RETRY_ALARM_PREFIX);
}

let pendingJobChain: Promise<unknown> = Promise.resolve();

/** 串行化 pending job 的读改写，避免同一 SW 内并发排程互相覆盖 */
function enqueuePendingJobWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = pendingJobChain.then(task, task);
  pendingJobChain = next.catch(() => undefined);
  return next;
}

async function loadPendingJobs(): Promise<Record<string, TStoredOnceJob>> {
  const stored = await chrome.storage.local.get(PENDING_ONCE_JOB_KEY);
  return (stored?.[PENDING_ONCE_JOB_KEY] as Record<string, TStoredOnceJob> | undefined) ?? {};
}

function pruneExpiredPendingJobs(jobs: Record<string, TStoredOnceJob>, now = Date.now()): void {
  for (const [alarmName, job] of Object.entries(jobs)) {
    if (now - (job?.fireAt ?? 0) > PENDING_ONCE_JOB_TTL) {
      delete jobs[alarmName];
    }
  }
}

async function addPendingJob(alarmName: string, job: TPendingOnceJob): Promise<void> {
  await enqueuePendingJobWrite(async () => {
    const jobs = await loadPendingJobs();
    pruneExpiredPendingJobs(jobs);
    jobs[alarmName] = job;
    await chrome.storage.local.set({ [PENDING_ONCE_JOB_KEY]: jobs });
  });
}

async function removePendingJob(alarmName: string): Promise<void> {
  await enqueuePendingJobWrite(async () => {
    const jobs = await loadPendingJobs();
    if (!Object.hasOwn(jobs, alarmName)) {
      return;
    }
    delete jobs[alarmName];
    await chrome.storage.local.set({ [PENDING_ONCE_JOB_KEY]: jobs });
  });
}

/** 取出并删除：先清理存储再执行，保证任务不会因执行失败/重复触发而重复运行 */
async function takePendingJob(alarmName: string): Promise<TPendingOnceJob | "consumed" | undefined> {
  return enqueuePendingJobWrite(async () => {
    const jobs = await loadPendingJobs();
    const job = jobs[alarmName];
    if (!job) {
      return undefined;
    }
    if (job.kind === "consumed") {
      return "consumed";
    }
    // 留墓碑而不是直接删除（见 TConsumedOnceJob）；墓碑按 PENDING_ONCE_JOB_TTL 在下次排程时清理，
    // 同名任务重新排程（addPendingJob）会直接覆盖它。
    jobs[alarmName] = { kind: "consumed", fireAt: Date.now() };
    await chrome.storage.local.set({ [PENDING_ONCE_JOB_KEY]: jobs });
    return job;
  });
}

/**
 * 先持久化参数、再创建 alarm。顺序不能反：若先建 alarm 而参数落盘失败，
 * 闹钟触发时只会得到"参数丢失"，任务被误判为失败。
 */
async function schedulePendingOnceJob(alarmName: string, fireAt: number, job: TPendingOnceJob): Promise<void> {
  await addPendingJob(alarmName, job);
  try {
    await chrome.alarms.create(alarmName, { when: fireAt });
  } catch (e) {
    await removePendingJob(alarmName).catch(() => undefined);
    throw e;
  }
}

function autoFlushUserInfo(retryIndex: number = 0) {
  return async () => {
    // 先判断是否启用，再决定是否拉起 offscreen（见 docs/performance-audit.md P1-6）
    const autoReflush = (await getExtStoragePathCached("config", "userInfo.autoReflush", {})) as {
      enabled?: boolean;
      interval?: number;
      afterTime?: string;
      retry?: { max?: number; interval?: number };
    };
    const { enabled = false, interval = 1, afterTime = "00:00", retry } = autoReflush;

    // 如果未启用自动刷新，则直接返回
    if (!enabled) {
      return;
    }

    const { max: retryMax = 0, interval: retryInterval = 5 } = retry ?? {};

    const curDate = new Date();
    const curDateFormat = format(curDate, "yyyy-MM-dd");

    // 如果不是重试，则要检查是否满足刷新条件
    if (retryIndex === 0) {
      // 检查当前时间是否在允许的刷新时间之后
      const [afterHour, afterMinute] = afterTime.split(":").map((v) => parseInt(v));
      if (curDate.getHours() < afterHour || (curDate.getHours() === afterHour && curDate.getMinutes() < afterMinute)) {
        sendMessage("logger", {
          msg: `Auto-refreshing user information paused since current time is before the allowed refresh time.`,
        }).catch(onLoggerSendFailed);
        return;
      }

      const lastFlushAt = (await getExtStoragePathCached("metadata", "lastUserInfoAutoFlushAt", 0)) as number;
      const lastFlushDateFormat = format(lastFlushAt, "yyyy-MM-dd");

      // 如果不是同一天，则不检查距离上次刷新时间是否超过了设定的间隔，这样能保证至少每天刷新一次（即启动浏览器后第一次检查）
      if (curDateFormat === lastFlushDateFormat) {
        const nextFlushTime = lastFlushAt + interval * 60 * 60 * 1000; // interval in hours
        // 确保距离上次刷新时间已经超过了设定的间隔
        if (curDate.getTime() < nextFlushTime) {
          sendMessage("logger", {
            msg: `Auto-refreshing user information paused since refresh interval not reached.`,
          }).catch(onLoggerSendFailed);
          return;
        }
      }
    }

    // 互斥：避免上一次刷新尚未结束时的重复执行（锁带 owner，仅本人可释放，避免误删他人的锁）
    const lockOwner = await acquireLock(USER_INFO_LOCK_KEY);
    if (!lockOwner) {
      sendMessage("logger", {
        msg: `Auto-refreshing user information is already running, skip this round.`,
      }).catch(onLoggerSendFailed);
      return;
    }

    try {
      await setupOffscreenDocument();

      sendMessage("logger", {
        msg: `Auto-refreshing user information at ${curDateFormat}${retryIndex > 0 ? `(Retry #${retryIndex})` : ""}`,
      }).catch(onLoggerSendFailed);

      let processedSiteCount = 0;
      const failFlushSites: TSiteID[] = [];
      /** 本轮是否因用户取消而提前结束（见 B-12） */
      let cancelled = false;
      /** 本轮是否因锁被他人接管而提前结束（见 L-3） */
      let lockLost = false;

      /**
       * 由于是后台任务，所以我们不使用 promise 来并行处理，以确保 flushQueue 中永远只有一个任务在运行，
       * 防止用户设置的并发数过大而被浏览器block
       */
      // 只取 sites 子表，且走 SW 内缓存（不产生跨上下文消息、不重复反序列化）
      const sites = (await getExtStoragePathCached("metadata", "sites", {})) as Record<
        string,
        { isOffline?: boolean; allowQueryUserInfo?: boolean }
      >;

      for (const [siteId, siteConfig] of Object.entries(sites)) {
        if (!siteConfig.isOffline && siteConfig.allowQueryUserInfo !== false) {
          try {
            // 检查当天的记录是否存在（直接读本地缓存，省掉一次 offscreen 往返与整份 userInfo 传输）
            // 注意：这里必须用 `== null` 而不是 `typeof === "undefined"`。`getExtStoragePathCached` 的
            // `defaultValue` 形参默认值是 null，而 JS 默认参数在实参为 undefined 时同样生效，
            // 于是这里传 `undefined as unknown` 想表达「没有默认值」时，实际拿到的是 null；
            // 用 typeof 判 undefined 会恒为假，导致逐站点刷新循环整体不执行（autoReflush 刷新 0 个站点）。
            const todayUserInfo = await getExtStoragePathCached(
              "userInfo",
              [siteId, curDateFormat],
              undefined as unknown,
            );
            if (todayUserInfo == null) {
              // 等待 offscreen 结果必须带超时兜底（B-12）：任务被取消时 offscreen 会以 AbortError reject，
              // 其它情况（offscreen 被回收、消息通道断开）下超时也能保证 finally 里的 releaseLock 一定执行。
              const userInfoResult = await withTimeout(
                sendMessage("getSiteUserInfoResult", siteId),
                USER_INFO_SITE_WAIT_TIMEOUT,
                `Timed out after ${USER_INFO_SITE_WAIT_TIMEOUT}ms waiting for user info of site ${siteId}`,
              );
              if (userInfoResult.status !== EResultParseStatus.success) {
                failFlushSites.push(siteId);
              }
              processedSiteCount += 1;
            }
          } catch (e) {
            if (isAbortError(e)) {
              // 用户在选项页点了「取消刷新」：停止本轮余下站点，否则会出现「取消了还在继续刷」
              cancelled = true;
              break;
            }
            failFlushSites.push(siteId);
          }

          // 心跳续租（L-3）：完成一个站点就刷新一次锁的 `at`，让 TTL 从「本轮开始」变成「距上次心跳」
          if (!(await renewLock(USER_INFO_LOCK_KEY, lockOwner))) {
            lockLost = true;
            break;
          }
        }
      }

      if (cancelled || lockLost) {
        sendMessage("logger", {
          msg: cancelled
            ? `Auto-refreshing user information was cancelled by user, ${processedSiteCount} sites processed, ${failFlushSites.length} failed.`
            : `Auto-refreshing user information aborted because the lock was taken over by another round, ${processedSiteCount} sites processed, ${failFlushSites.length} failed.`,
        }).catch(onLoggerSendFailed);
      } else {
        sendMessage("logger", {
          msg: `Auto-refreshing user information finished, ${processedSiteCount} sites processed, ${failFlushSites.length} failed.`,
          data: { failFlushSites },
        }).catch(onLoggerSendFailed);
      }

      // 本轮被取消/接管时不算「完成」：不更新刷新时间（否则下一次自动刷新会被向后推迟一个 interval），
      // 也不为失败站点排重试（用户取消后不该自动再拉起来）。
      if (cancelled || lockLost) {
        return;
      }

      // 将刷新时间存入 metadata
      await patchExtStoragePathLocal("metadata", "lastUserInfoAutoFlushAt", new Date().getTime()); // 刷新时间应该是实际完成时间

      // 如果本次有失败的刷新操作，则设置重试（id 带时间戳，避免多次重试互相覆盖）
      if (failFlushSites.length > 0 && retryIndex < retryMax) {
        sendMessage("logger", {
          msg: `Retrying auto-refresh for ${failFlushSites.length} failed sites in ${retryInterval} minutes (Retry #${retryIndex + 1})`,
        }).catch(onLoggerSendFailed);
        // 走持久化排程（见上方 PENDING_ONCE_JOB_KEY 的说明）：只把 retryIndex 落盘，
        // SW 被回收后由 onAlarm 重建 `autoFlushUserInfo(retryIndex + 1)` 的闭包。
        const fireAt = +curDate + retryInterval * 60 * 1000; // retryInterval in minutes
        const alarmName = `${EJobType.FlushUserInfo}-Retry-${retryIndex}-${Date.now()}`;
        try {
          await schedulePendingOnceJob(alarmName, fireAt, {
            kind: "flushUserInfoRetry",
            retryIndex: retryIndex + 1,
            fireAt,
          });
        } catch (e) {
          logBackgroundError(`Failed to schedule auto-refresh retry #${retryIndex + 1}`, e);
        }
      }
    } finally {
      await releaseLock(USER_INFO_LOCK_KEY, lockOwner);
    }
  };
}

// noinspection JSIgnoredPromiseFromCall
jobs.scheduleJob({
  id: EJobType.FlushUserInfo,
  type: "interval",
  duration: 1000 * 60 * 10, // check every 10 minutes
  immediate: true,
  execute: autoFlushUserInfo(),
});

/**
 * 自动备份：检查所有已启用且设置了备份间隔的备份服务器，在满足条件时触发备份
 */
function autoBackup() {
  return async () => {
    // 先判断是否有需要备份的服务器，再决定是否拉起 offscreen（见 docs/performance-audit.md P1-6）
    const backupServers = (await getExtStoragePathCached("metadata", "backupServers", {})) as Record<
      string,
      { enabled?: boolean; backupInterval?: number; lastBackupAt?: number; name?: string; backupFields?: string[] }
    >;

    const now = Date.now();
    const pendingServers = Object.entries(backupServers ?? {}).filter(([, serverConfig]) => {
      if (!serverConfig.enabled || !serverConfig.backupInterval || serverConfig.backupInterval <= 0) {
        return false;
      }
      return now - (serverConfig.lastBackupAt ?? 0) >= serverConfig.backupInterval * 60 * 60 * 1000;
    });

    if (pendingServers.length === 0) {
      return;
    }

    const lockOwner = await acquireLock("autoBackupLock");
    if (!lockOwner) {
      sendMessage("logger", { msg: `Auto-backup is already running, skip this round.` }).catch(onLoggerSendFailed);
      return;
    }

    try {
      await setupOffscreenDocument();

      for (const [serverId, serverConfig] of pendingServers) {
        sendMessage("logger", {
          msg: `Auto-backup triggered for [${serverConfig.name}] (interval: ${serverConfig.backupInterval}h)`,
        }).catch(onLoggerSendFailed);

        try {
          const backupFields = (serverConfig.backupFields ?? []) as any[];
          const ok = await sendMessage("exportBackupData", {
            backupServerId: serverId,
            backupFields,
          });

          if (!ok) {
            sendMessage("logger", {
              msg: `Auto-backup failed for [${serverConfig.name}] (returned false)`,
            }).catch(onLoggerSendFailed);
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          sendMessage("logger", {
            msg: `Auto-backup failed for [${serverConfig.name}]: ${errMsg}`,
          }).catch(onLoggerSendFailed);
        }
      }
    } finally {
      await releaseLock("autoBackupLock", lockOwner);
    }
  };
}

// noinspection JSIgnoredPromiseFromCall
jobs.scheduleJob({
  id: EJobType.AutoBackup,
  type: "interval",
  duration: 1000 * 60 * 10, // check every 10 minutes
  immediate: true,
  execute: autoBackup(),
});

function doReDownloadTorrent(downloadOption: IDownloadTorrentOption) {
  return async () => {
    await setupOffscreenDocument();
    // 按照相同的方式重新下载种子到下载器
    await sendMessage("downloadTorrent", downloadOption);
  };
}

/** 重下失败（或参数丢失）时统一在这里落状态 + 记日志，保持原有"失败必须标记 failed"的语义 */
async function markReDownloadAsFailed(downloadId: number, error?: unknown): Promise<void> {
  logBackgroundError(`Re-download failed for downloadId=${downloadId}`, error);
  try {
    await sendMessage("setDownloadHistoryStatus", { downloadId, status: "failed" });
  } catch (e) {
    logBackgroundError(`Failed to mark downloadId=${downloadId} as failed`, e);
  }
}

async function executePendingOnceJob(job: TPendingOnceJob): Promise<void> {
  switch (job.kind) {
    case "flushUserInfoRetry":
      await autoFlushUserInfo(job.retryIndex)();
      return;
    case "reDownloadTorrent":
      await doReDownloadTorrent(job.downloadOption)();
      return;
  }
}

async function runPendingOnceJob(alarmName: string): Promise<void> {
  const job = await takePendingJob(alarmName);

  if (job === "consumed") {
    return; // 同一任务的重复触发（冷启动扫描重建过 alarm），已执行过，不再判失败
  }

  if (!job) {
    // 参数丢失（升级前由 job-scheduler 建的旧 alarm、或 local storage 被清理）：
    // 重新下载只能判定为失败，否则下载历史会永远停在 pending（正是本次要修的静默丢失）。
    const downloadId = parseReDownloadAlarmName(alarmName);
    if (downloadId !== undefined) {
      await markReDownloadAsFailed(downloadId, new Error("Missing persisted payload for re-download alarm"));
    }
    return;
  }

  try {
    await executePendingOnceJob(job);
  } catch (e) {
    if (job.kind === "reDownloadTorrent") {
      await markReDownloadAsFailed(job.downloadId, e);
    } else {
      // 自动刷新重试：单站点失败已在 autoFlushUserInfo 内部逐站点收集，这里只记录整体异常
      logBackgroundError(`Failed to run pending job "${alarmName}"`, e);
    }
  }
}

/**
 * SW 顶层注册（MV3 要求事件监听在顶层同步注册才能唤醒 SW）：
 * 闹钟唤醒被回收的 SW 后，本模块重新求值，即可从存储里的参数重建任务并执行。
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!isPendingOnceJobAlarm(alarm.name)) {
    return; // interval job 由 job-scheduler 自己的监听器处理，其它的 alarm 与本模块无关
  }
  runPendingOnceJob(alarm.name).catch((e) => logBackgroundError(`Failed to run pending job "${alarm.name}"`, e));
});

onMessage("reDownloadTorrent", async ({ data }) => {
  // 短间隔同样统一走 alarms 排程（见上方 PENDING_ONCE_JOB_KEY 的说明）：
  // 原实现在 leftInterval < 30s 时 `await sleep(leftInterval)` 占着本次消息处理，
  // 既阻塞消息通道、又会在等待期间随 SW 回收一起消失。现在消息立即返回，
  // 到点后由 alarms 唤醒 SW 并从持久化参数重建任务（按实际剩余间隔，见 docs/performance-audit.md P1-22）。
  const fireAt = Date.now() + data.leftInterval;
  try {
    await schedulePendingOnceJob(reDownloadAlarmName(data.downloadId, fireAt), fireAt, {
      kind: "reDownloadTorrent",
      downloadId: data.downloadId,
      downloadOption: data,
      fireAt,
    });
  } catch (e) {
    await markReDownloadAsFailed(data.downloadId, e);
  }
});

/**
 * 孤儿任务恢复（见 L-4）。
 *
 * 两层保护，缺一不可：
 *
 * 1. **闹钟丢失**：`chrome.alarms` 不保证跨浏览器重启存活（本文件上方注释已自认这一点），
 *    而任务的参数仍留在 `PENDING_ONCE_JOB_KEY` 里。若闹钟没了，参数就永远没人消费，
 *    下载历史会永久停在 `pending`。SW 启动时逐条核对「参数还在 → 闹钟是否还在」，缺失则按原定时间重新排程。
 * 2. **记录遗留**：即使参数与闹钟都丢了（例如 local storage 被清理、或记录是在旧版本里产生的），
 *    下载历史里仍会留下超期的 `pending`/`downloading`。这里扫描这类记录并标记为 `failed`，
 *    让用户在「下载历史」里看到明确结果，而不是无限期的 pending。
 */
const DOWNLOAD_RECOVERY_SESSION_KEY = "ptd_downloadRecoveryCheckedAt";
/** 历史记录对账的最小间隔：避免每次 SW 唤醒都拉起 offscreen 读一遍下载历史 */
const DOWNLOAD_RECOVERY_INTERVAL = 6 * 60 * 60 * 1000;
/** pending/downloading 超过该时长仍未推进，即判定为「投递链已丢失」（正常投递在秒级完成） */
const STALE_DOWNLOAD_STATUS_TTL = 60 * 60 * 1000;

/** alarm 是否仍存在（查询失败时保守地视为「存在」，避免把正常排程误判为丢失而重复创建） */
async function hasAlarm(alarmName: string): Promise<boolean> {
  try {
    return !!(await chrome.alarms.get(alarmName));
  } catch (e) {
    logBackgroundError(`Failed to query alarm "${alarmName}"`, e);
    return true;
  }
}

/** 把「参数还在、闹钟没了」的一次性任务重新排上（见 L-4 第 1 层） */
async function rescheduleLostOnceJobAlarms(): Promise<void> {
  const jobs = await loadPendingJobs();
  const now = Date.now();

  for (const [alarmName, job] of Object.entries(jobs)) {
    if (job?.kind === "consumed") {
      continue; // 墓碑：任务已执行，不能复活
    }
    const fireAt = job?.fireAt ?? 0;
    if (now - fireAt > PENDING_ONCE_JOB_TTL) {
      continue; // 超期条目由 pruneExpiredPendingJobs 统一清理，不再复活
    }

    try {
      if (await hasAlarm(alarmName)) {
        continue;
      }

      await chrome.alarms.create(alarmName, { when: Math.max(fireAt, now) });
      sendMessage("logger", {
        msg: `Re-created the lost alarm "${alarmName}" from its persisted payload.`,
      }).catch(onLoggerSendFailed);
    } catch (e) {
      logBackgroundError(`Failed to re-create the lost alarm "${alarmName}"`, e);
    }
  }
}

/**
 * BACKGROUNDSHARED-2：对账「这个 downloadId 还有没有在等的 alarm」。
 *
 * alarm 名现在带唯一后缀，不能再靠 `reDownloadAlarmName(downloadId)` 拼出来查，
 * 否则对不上时会把仍在等待的任务提前判死（或反过来，让残留任务永远停在 pending）；
 * 因此反查所有待执行任务，并保留旧式 `<prefix><downloadId>` 名字以兼容升级前排下的 alarm。
 */
async function hasWaitingReDownloadAlarm(downloadId: number): Promise<boolean> {
  const jobs = await loadPendingJobs();
  const alarmNames = new Set<string>([`${RE_DOWNLOAD_ALARM_PREFIX}${downloadId}`]);
  for (const [alarmName, job] of Object.entries(jobs)) {
    if (job?.kind === "reDownloadTorrent" && job.downloadId === downloadId) {
      alarmNames.add(alarmName);
    }
  }

  for (const alarmName of alarmNames) {
    if (await hasAlarm(alarmName)) {
      return true;
    }
  }
  return false;
}

/** 把「投递链已丢失」的超期下载记录标记为失败（见 L-4 第 2 层） */
async function failStaleDownloadRecords(): Promise<void> {
  // 无参消息也要显式传 `undefined`：包装后的 sendMessage 签名是 (type, data)，
  // 与仓库内其它无参调用保持一致（见 options/views/Overview/DownloadHistory/utils.ts）。
  const history = (await sendMessage("getDownloadHistory", undefined)) as ITorrentDownloadMetadata[] | undefined;
  if (!Array.isArray(history)) {
    return;
  }

  const now = Date.now();
  const staleRecords = history.filter((record) => {
    if (typeof record?.id !== "number") {
      return false;
    }
    if (record.downloadStatus !== "pending" && record.downloadStatus !== "downloading") {
      return false;
    }
    return now - (record.downloadAt ?? 0) > STALE_DOWNLOAD_STATUS_TTL;
  });

  for (const record of staleRecords) {
    const downloadId = record.id!;
    // 还有闹钟在等（可能刚被 rescheduleLostOnceJobAlarms 重新排上）的任务交给 alarm 处理，不能提前判死
    if (await hasWaitingReDownloadAlarm(downloadId)) {
      continue;
    }
    await markReDownloadAsFailed(
      downloadId,
      new Error(`Download stuck in "${record.downloadStatus}" for more than ${STALE_DOWNLOAD_STATUS_TTL}ms`),
    );
  }
}

async function recoverOrphanDownloadJobs(): Promise<void> {
  // 第 1 层只读 chrome.storage.local，代价极低，每次 SW 启动都做
  await rescheduleLostOnceJobAlarms();

  // 第 2 层需要拉起 offscreen 读下载历史（IndexedDB 在 offscreen 侧），因此按会话节流
  const now = Date.now();
  let lastCheckedAt = 0;
  try {
    const stored = await chrome.storage?.session?.get(DOWNLOAD_RECOVERY_SESSION_KEY);
    lastCheckedAt = (stored?.[DOWNLOAD_RECOVERY_SESSION_KEY] as number) ?? 0;
  } catch (e) {
    logBackgroundError("Failed to read download recovery checkpoint, will run the scan anyway", e);
  }
  if (now - lastCheckedAt < DOWNLOAD_RECOVERY_INTERVAL) {
    return;
  }

  // 先记检查点再干活：失败时不在同一个窗口内反复拉起 offscreen
  try {
    await chrome.storage?.session?.set({ [DOWNLOAD_RECOVERY_SESSION_KEY]: now });
  } catch (e) {
    logBackgroundError("Failed to write download recovery checkpoint", e);
  }

  await failStaleDownloadRecords();
}

// noinspection JSIgnoredPromiseFromCall
recoverOrphanDownloadJobs().catch((e) => logBackgroundError("Failed to recover orphan download jobs", e));
