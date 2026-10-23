import { format } from "date-fns";
import { defineJobScheduler } from "@webext-core/job-scheduler";
import { EResultParseStatus, type TSiteID } from "@ptd/site/types/base.ts";

import { onMessage, sendMessage } from "@/messages.ts";
import { IDownloadTorrentOption, type ITorrentDownloadMetadata } from "@/shared/types.ts";

import { getExtStoragePathCached, logBackgroundError, patchExtStoragePathLocal } from "./base.ts";
import { showNotificationSafely } from "./contextMenus.ts";
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
 * - 触发时持久记录执行租期，完成后才写 consumed；SW 在执行前回收时可按租期恢复。
 *
 * 用 local 而不是 session：alarms 可能跨浏览器重启存活，而 session storage 会随浏览器退出清空，
 * 只有 local 才能保证"闹钟还在，参数就还在"。条目执行后删除 + 排程时顺带清理超期条目，
 * 不会无限增长。
 */
const PENDING_ONCE_JOB_KEY = "ptd_pending_once_jobs";
/** 超期条目兜底清理：浏览器被强杀导致 alarm 丢失时，避免存储里留下永久孤儿条目 */
const PENDING_ONCE_JOB_TTL = 24 * 60 * 60 * 1000;
const ONCE_JOB_LEASE_TTL = 5 * 60 * 1000;
const ONCE_JOB_HEARTBEAT = 60 * 1000;
/**
 * 一次性任务在 SW 回收后的**重放**上限（不含首次执行）。
 *
 * `attempt` 语义：1 = 首次执行；2 = 第 1 次重放；……；`attempt - 1` 即「已重放次数」。
 * 超过该次数仍未能完成的任务不再重放（重下任务标记 failed），避免一个必然失败/必然杀死 SW 的任务无限循环。
 */
const MAX_REPLAY_ATTEMPTS = 3;

type TPendingFlushUserInfoRetry = {
  kind: "flushUserInfoRetry";
  /** 下一次执行传给 autoFlushUserInfo 的 retryIndex */
  retryIndex: number;
  /** 计划执行时间，仅用于诊断与超期清理 */
  fireAt: number;
  /** N7：因「上一轮刷新仍持锁」而重排的次数（有上限，避免无限重排） */
  lockRescheduleCount?: number;
};

type TPendingReDownloadTorrent = {
  kind: "reDownloadTorrent";
  downloadId: number;
  /** 原始 reDownloadTorrent 消息体（结构保持不变，执行时原样透传给 downloadTorrent） */
  downloadOption: IDownloadTorrentOption;
  fireAt: number;
};

/**
 * H-11：已完成任务留下的墓碑。
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
type TRunningOnceJob = {
  kind: "running";
  job: TPendingOnceJob;
  owner: string;
  at: number;
  fireAt: number;
  attempt: number;
};
type TStoredOnceJob = TPendingOnceJob | TRunningOnceJob | TConsumedOnceJob;

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

/** 执行中的 payload 保留在存储中；SW 回收后租期过期即可恢复。 */
async function takePendingJob(
  alarmName: string,
  owner: string,
): Promise<{ job: TPendingOnceJob; attempt: number } | "consumed" | "running" | undefined> {
  return enqueuePendingJobWrite(async () => {
    const jobs = await loadPendingJobs();
    const job = jobs[alarmName];
    if (!job) {
      return undefined;
    }
    if (job.kind === "consumed") {
      return "consumed";
    }
    const now = Date.now();
    if (job.kind === "running" && now - job.at < ONCE_JOB_LEASE_TTL) {
      return "running";
    }
    const payload = job.kind === "running" ? job.job : job;
    const attempt = job.kind === "running" ? job.attempt + 1 : 1;
    jobs[alarmName] = { kind: "running", job: payload, owner, at: now, fireAt: now, attempt };
    await chrome.storage.local.set({ [PENDING_ONCE_JOB_KEY]: jobs });
    await chrome.alarms.create(alarmName, { when: now + ONCE_JOB_LEASE_TTL });
    return { job: payload, attempt };
  });
}

async function updateRunningJob(alarmName: string, owner: string, complete = false): Promise<boolean> {
  return enqueuePendingJobWrite(async () => {
    const jobs = await loadPendingJobs();
    const running = jobs[alarmName];
    if (running?.kind !== "running" || running.owner !== owner) return false;
    jobs[alarmName] = complete ? { kind: "consumed", fireAt: Date.now() } : { ...running, at: Date.now() };
    await chrome.storage.local.set({ [PENDING_ONCE_JOB_KEY]: jobs });
    if (complete) {
      await chrome.alarms.clear(alarmName);
    } else {
      await chrome.alarms.create(alarmName, { when: Date.now() + ONCE_JOB_LEASE_TTL });
    }
    return true;
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

/** N7：`autoFlushUserInfo` 的结构化返回值；目前只关心「本轮是否因他人持锁被跳过」。 */
interface IAutoFlushResult {
  lockBusy?: boolean;
}

/**
 * 一次自动刷新（interval job 与持久化重试 job 共用）。
 *
 * 返回值：重试任务消费方需要知道「本轮是否因锁被占用而什么都没做」，以便重新排程而不是把它当成完成。
 */
function autoFlushUserInfo(retryIndex: number = 0): () => Promise<IAutoFlushResult | undefined> {
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
      // N7：显式返回「因他人持锁跳过」。interval job 忽略返回值（10 分钟后再试）；
      // 一次性重试任务的消费方必须据此**重新排程**，否则这次重试会被消费墓碑静默吃掉。
      return { lockBusy: true };
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
        // N7：fireAt 必须用「本轮结束时间」而不是本轮开始时间（curDate）：
        // 一轮串行刷新 100 个站点、或遇到多次 30s 超时，很容易超过 retryInterval（默认 5 分钟），
        // 用开始时间算出的 fireAt 已在过去 → 重试 alarm 立刻触发，撞上本轮自己的锁 → 该次重试被消费掉。
        const fireAt = Date.now() + retryInterval * 60 * 1000; // retryInterval in minutes
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

    // 显式 return（noImplicitReturns）：本函数既有 `return { lockBusy: true }` 的值返回，
    // 也有只 `return` 的提前退出，末尾必须写明返回 undefined 才不会触发 TS7030。
    return undefined;
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
 * H-2：自动备份失败的用户可见通知。
 *
 * 自动备份每 10 分钟检查一次，失败时旧实现只写 logger 通道（options 没有日志查看器时用户完全无感）。
 * 这里用 contextMenus 的 `showNotificationSafely` 发一次系统通知；同一服务器在去重窗口内只提示一次，
 * 避免失败持续时每 10 分钟刷屏。失败原因与服务器名走 logger 同一份文本。
 *
 * i18n：新增 key `notificationAutoBackupFailure`（参数 $1=服务器名、$2=失败原因）；
 * locales 尚未补齐时回落到英文模板，保证通知仍然可读（key 由 Lead 统一补 src/locales）。
 */
const AUTO_BACKUP_NOTIFY_DEDUPE_MS = 30 * 60 * 1000;
const autoBackupFailureNotifyAt = new Map<string, number>();

function notifyAutoBackupFailure(serverId: string, serverName: string, reason: string): void {
  const now = Date.now();
  if (now - (autoBackupFailureNotifyAt.get(serverId) ?? 0) < AUTO_BACKUP_NOTIFY_DEDUPE_MS) {
    return;
  }
  autoBackupFailureNotifyAt.set(serverId, now);

  const localized = chrome.i18n?.getMessage?.("notificationAutoBackupFailure", [serverName, reason]);
  showNotificationSafely({
    type: "basic",
    iconUrl: chrome.runtime.getURL?.("icons/logo/128.png") ?? "",
    title: chrome.i18n?.getMessage?.("extName") || "PT Depiler",
    message: localized || `Auto backup failed for [${serverName}]: ${reason}`,
  });
}

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

    let lockLost = false;
    let heartbeat: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      heartbeat = heartbeat.then(async () => {
        if (!(await renewLock("autoBackupLock", lockOwner))) lockLost = true;
      });
    }, ONCE_JOB_HEARTBEAT);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      await setupOffscreenDocument();

      for (const [serverId, serverConfig] of pendingServers) {
        if (lockLost || !(await renewLock("autoBackupLock", lockOwner))) {
          sendMessage("logger", {
            msg: `Auto-backup lock lost, skipping remaining servers.`,
            level: "warn",
          }).catch(onLoggerSendFailed);
          break;
        }
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
            const reason = "exportBackupData returned false";
            sendMessage("logger", {
              msg: `Auto-backup failed for [${serverConfig.name}] (returned false)`,
            }).catch(onLoggerSendFailed);
            notifyAutoBackupFailure(serverId, serverConfig.name ?? serverId, reason);
          } else {
            // 成功一次即清空去重记录：之后再失败应重新提示
            autoBackupFailureNotifyAt.delete(serverId);
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          sendMessage("logger", {
            msg: `Auto-backup failed for [${serverConfig.name}]: ${errMsg}`,
          }).catch(onLoggerSendFailed);
          notifyAutoBackupFailure(serverId, serverConfig.name ?? serverId, errMsg);
        }
      }
    } finally {
      clearInterval(timer);
      await heartbeat;
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

/** N7：重试因锁被占用而重排时，两次重排之间的最小间隔（取自配置，回落到 5 分钟）。 */
async function getAutoFlushRetryIntervalMs(): Promise<number> {
  try {
    const autoReflush = (await getExtStoragePathCached("config", "userInfo.autoReflush", {})) as {
      retry?: { interval?: number };
    };
    const minutes = autoReflush?.retry?.interval;
    return (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60 * 1000;
  } catch {
    return 5 * 60 * 1000;
  }
}

/** N7：锁被占用时最多重排几次，超过后放弃并记录（避免极端情况下无限重排）。 */
const MAX_LOCK_RESCHEDULE = 3;

/**
 * N7：一次性重试任务到点时，若上一轮刷新仍持锁（`autoFlushUserInfo` 返回 `{ lockBusy: true }`），
 * 不能把这次任务写成 consumed 墓碑（旧实现会，导致重试被静默吞掉）。这里改为重新排一次：
 * - **先**用新的 alarm 名（带时间戳）把下一次排成功，`lockRescheduleCount` 累加并有上限；
 * - 排程成功后**再**消费旧 alarm（写墓碑），避免「先写墓碑、排程失败/SW 被回收」这一两步之间丢任务；
 * - 排程失败时保留旧 alarm 的 running 状态，由调用方 `finally` 统一消费（保持"本次重试失败"语义）。
 *
 * @returns 是否已经成功重排（false 表示排程失败/达到上限，调用方应正常消费本次任务）
 */
async function rescheduleLockBusyRetry(
  alarmName: string,
  owner: string,
  job: TPendingFlushUserInfoRetry,
): Promise<boolean> {
  const rescheduleCount = (job.lockRescheduleCount ?? 0) + 1;

  if (rescheduleCount > MAX_LOCK_RESCHEDULE) {
    // 放弃重排：这里没有"新排程"可保护，直接消费当前任务（调用方 finally 也会兜底消费）
    await updateRunningJob(alarmName, owner, true);
    logBackgroundError(
      `Auto-refresh retry #${job.retryIndex} gave up after ${MAX_LOCK_RESCHEDULE} lock-busy reschedules.`,
    );
    return false;
  }

  let delay: number;
  try {
    delay = await getAutoFlushRetryIntervalMs();
    const fireAt = Date.now() + delay;
    const nextAlarmName = `${FLUSH_USER_INFO_RETRY_ALARM_PREFIX}${job.retryIndex}-${Date.now()}`;
    await schedulePendingOnceJob(nextAlarmName, fireAt, {
      ...job,
      fireAt,
      lockRescheduleCount: rescheduleCount,
    });
  } catch (e) {
    // 排程失败：保留旧 alarm 的 running（finally 会消费），不能先写墓碑导致这一步永久丢失
    logBackgroundError(`Failed to reschedule lock-busy auto-refresh retry #${job.retryIndex}`, e);
    return false;
  }

  // 新 alarm 已成功落盘，再消费旧任务；即使这里 SW 被回收，最坏也只是多一次重试（at-least-once），不会丢任务
  try {
    await updateRunningJob(alarmName, owner, true);
  } catch (e) {
    // 新任务已排上；旧 running 记录消费失败会由租期重放兜底（最坏多一次重试），不能因此让本次重排失败
    logBackgroundError(`Failed to consume old auto-refresh retry #${job.retryIndex} after reschedule`, e);
  }
  sendMessage("logger", {
    msg: `Auto-refresh retry #${job.retryIndex} rescheduled in ${Math.round(delay / 60_000)} minutes because another refresh round is still running.`,
  }).catch(onLoggerSendFailed);
  return true;
}

async function executePendingOnceJob(job: TPendingOnceJob): Promise<IAutoFlushResult | void> {
  switch (job.kind) {
    case "flushUserInfoRetry":
      return await autoFlushUserInfo(job.retryIndex)();
    case "reDownloadTorrent":
      await doReDownloadTorrent(job.downloadOption)();
      return;
  }
}

/**
 * G1：SW 回收后的「重放」是否应该真的再执行一次重下任务。
 *
 * 租期重放是 at-least-once 语义：首次执行期间 SW 被回收时，上一次可能已经产生副作用
 * （把种子推给了下载器 / 已开始本地下载），盲目重放会重复投递。这里按下载历史的状态保守判定：
 * - `downloadId` 为负数/缺失：关闭下载历史时用的是 ephemeral id，没有可对账记录 → 不重放；
 * - `completed` / `failed`：已是终态 → 不重放；
 * - `pending` / `downloading`：首次执行可能已投递或仍在 offscreen 队列/执行中 → 视为已投递，不重放；
 * - 历史里没有该 id：首次执行尚未落任何记录 → 重放（唯一允许重放的分支）；
 * - 读取历史失败：无法判定 → 继续执行（宁可贵 at-least-once 也不静默丢任务；见项 1）。
 */
async function shouldReplayReDownloadJob(job: TPendingReDownloadTorrent): Promise<"execute" | "skip"> {
  if (!(job.downloadId > 0)) {
    logBackgroundError(
      `Skip replaying re-download job #${job.downloadId}: no persistent download history id to reconcile`,
    );
    return "skip";
  }

  let history: ITorrentDownloadMetadata[] | undefined;
  try {
    history = (await sendMessage("getDownloadHistory", undefined)) as ITorrentDownloadMetadata[] | undefined;
  } catch (err) {
    logBackgroundError("Failed to check download history before replaying re-download job, continue once", err);
    return "execute";
  }

  const record = Array.isArray(history) ? history.find((item) => item.id === job.downloadId) : undefined;
  if (!record) {
    return "execute"; // 首次执行还没写入历史：视为未执行
  }

  // completed/failed 终态、pending/downloading 可能已投递 —— 一律不重放
  logBackgroundError(
    `Skip replaying re-download job #${job.downloadId}: download history status is "${record.downloadStatus}"`,
  );
  return "skip";
}

async function runPendingOnceJob(alarmName: string): Promise<void> {
  const owner = crypto.randomUUID();
  const taken = await takePendingJob(alarmName, owner);

  if (taken === "consumed" || taken === "running") {
    return; // 已完成或仍在租期内的重复 alarm，不再执行或判失败
  }

  if (!taken) {
    // 参数丢失（升级前由 job-scheduler 建的旧 alarm、或 local storage 被清理）：
    // 重新下载只能判定为失败，否则下载历史会永远停在 pending（正是本次要修的静默丢失）。
    const downloadId = parseReDownloadAlarmName(alarmName);
    if (downloadId !== undefined) {
      await markReDownloadAsFailed(downloadId, new Error("Missing persisted payload for re-download alarm"));
    }
    return;
  }

  const { job, attempt } = taken;
  let leaseLost = false;
  /** N7：本次是否已改排为「锁被占用后的重试」——此时不能再写 consumed 墓碑掩盖这次消费。 */
  let rescheduled = false;
  let heartbeat: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      if (!(await updateRunningJob(alarmName, owner))) leaseLost = true;
    });
  }, ONCE_JOB_HEARTBEAT);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    // G1：重放次数上限（`attempt - 1` = 已重放次数；首次执行 attempt=1，不会命中）。
    const replayCount = attempt - 1;
    if (replayCount > MAX_REPLAY_ATTEMPTS) {
      const err = new Error(`Exceeded max replay attempts (${MAX_REPLAY_ATTEMPTS}) for job "${alarmName}"`);
      if (job.kind === "reDownloadTorrent") {
        await markReDownloadAsFailed(job.downloadId, err);
      } else {
        logBackgroundError(`Aborting pending job "${alarmName}"`, err);
      }
      return;
    }
    // G1：重放前先按下载历史确认「首次执行没有产生副作用」，避免重复投递。
    if (attempt > 1 && job.kind === "reDownloadTorrent") {
      if ((await shouldReplayReDownloadJob(job)) === "skip") {
        return;
      }
    }
    if (leaseLost) return;
    const result = await executePendingOnceJob(job);
    if (job.kind === "flushUserInfoRetry" && result?.lockBusy) {
      rescheduled = await rescheduleLockBusyRetry(alarmName, owner, job);
      return;
    }
  } catch (e) {
    if (job.kind === "reDownloadTorrent") {
      await markReDownloadAsFailed(job.downloadId, e);
    } else {
      // 自动刷新重试：单站点失败已在 autoFlushUserInfo 内部逐站点收集，这里只记录整体异常
      logBackgroundError(`Failed to run pending job "${alarmName}"`, e);
    }
  } finally {
    clearInterval(timer);
    await heartbeat;
    if (!rescheduled) {
      await updateRunningJob(alarmName, owner, true);
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
    throw e;
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
    if (job.kind !== "running" && now - fireAt > PENDING_ONCE_JOB_TTL) {
      continue; // 超期条目由 pruneExpiredPendingJobs 统一清理，不再复活
    }

    try {
      if (await hasAlarm(alarmName)) {
        continue;
      }

      const when = job.kind === "running" ? Math.max(now, job.at + ONCE_JOB_LEASE_TTL) : Math.max(fireAt, now);
      await chrome.alarms.create(alarmName, { when });
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
    const payload = job?.kind === "running" ? job.job : job;
    if (payload?.kind === "reDownloadTorrent" && payload.downloadId === downloadId) {
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

/** 浏览器下载仍在进行时，不能按历史记录的创建时间判定投递链失联。 */
async function hasLiveBrowserDownload(downloadId: number): Promise<boolean> {
  try {
    const stored = await chrome.storage?.session?.get("ptd_downloadTracking");
    const tracking = stored?.ptd_downloadTracking as Record<string, { downloadId?: number }> | undefined;
    for (const [chromeId, record] of Object.entries(tracking ?? {})) {
      if (record?.downloadId !== downloadId) continue;
      const [item] = (await chrome.downloads.search({ id: Number(chromeId) })) ?? [];
      // 终态由 base.ts 的追踪交接处理；查询失败也应保守地避免误判。
      if (item?.state === "in_progress" || item?.state === "complete" || item?.state === "interrupted") return true;
    }
  } catch (e) {
    logBackgroundError(`Failed to reconcile browser download for downloadId=${downloadId}`, e);
    return true;
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
    if ((await hasWaitingReDownloadAlarm(downloadId)) || (await hasLiveBrowserDownload(downloadId))) {
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
