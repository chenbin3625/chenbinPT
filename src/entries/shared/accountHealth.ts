import { EResultParseStatus, type TSiteID } from "@ptd/site/types/base.ts";
import type { IUserInfo } from "@ptd/site/types/userinfo.ts";
import type { IAlertConfig } from "./types/storages/config.ts";

export type TAccountHealthAlertKind =
  "unreadMessage" | "hnrWarning" | "needLogin" | "lowRatio" | "levelUp" | "inactivity";

export interface IAccountHealthAlert {
  key: string;
  kind: TAccountHealthAlertKind;
  siteId: TSiteID;
  siteName: string;
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  remainingDays?: number;
}

export interface ISiteInactivityInfo {
  lastAccessAt: number;
  inactiveDays: number;
  maxInactiveDays: number;
  remainingDays: number;
  status: "ok" | "warning" | "danger";
}

export interface IAccountHealthFailureRecord {
  status: EResultParseStatus;
  statusMsg?: string;
  at: number;
}

export interface IAccountHealthSummary {
  unreadMessageCount: number;
  abnormalSiteCount: number;
  inactiveWarningCount: number;
}

const ABNORMAL_ACCOUNT_STATUSES: ReadonlySet<EResultParseStatus> = new Set([
  EResultParseStatus.needLogin,
  EResultParseStatus.parseError,
  EResultParseStatus.CFBlocked,
  EResultParseStatus.unknownError,
  EResultParseStatus.noUserInput,
]);

/**
 * 汇总已添加站点的未读站内信、异常账号数及不活跃保号预警数（供工具栏弹窗等消费）。
 * 异常状态优先读取独立的 `lastUserInfoFailures`（失败时不覆盖上一次成功快照），
 * 只要失败时间不早于上一次成功快照的 `updateAt` 即视为当前异常。
 */
export function summarizeAccountHealth(params: {
  siteIds: ReadonlyArray<TSiteID>;
  lastUserInfo?: Record<string, Partial<IUserInfo> | undefined>;
  lastUserInfoFailures?: Record<string, IAccountHealthFailureRecord | undefined>;
  siteInactivityDays?: Record<string, number | undefined>;
  defaultInactivityDays: number;
  warnBeforeDays: number;
  now?: number;
}): IAccountHealthSummary {
  const {
    siteIds,
    lastUserInfo = {},
    lastUserInfoFailures = {},
    siteInactivityDays = {},
    defaultInactivityDays,
    warnBeforeDays,
    now = Date.now(),
  } = params;

  let unreadMessageCount = 0;
  let abnormalSiteCount = 0;
  let inactiveWarningCount = 0;

  for (const siteId of siteIds) {
    const info = lastUserInfo[siteId];
    const failure = lastUserInfoFailures[siteId];
    const hasActiveFailure =
      Boolean(failure) &&
      (!info || typeof info.updateAt !== "number" || !Number.isFinite(info.updateAt) || failure!.at >= info.updateAt);
    const effectiveStatus = hasActiveFailure ? failure!.status : info?.status;

    if (typeof effectiveStatus === "number" && ABNORMAL_ACCOUNT_STATUSES.has(effectiveStatus)) {
      abnormalSiteCount += 1;
    }

    if (!info) continue;

    if (typeof info.messageCount === "number" && info.messageCount > 0) {
      unreadMessageCount += info.messageCount;
    }

    const inact = computeSiteInactivityInfo(
      info,
      siteInactivityDays[siteId] ?? defaultInactivityDays,
      warnBeforeDays,
      now,
    );
    if (inact && (inact.status === "warning" || inact.status === "danger")) {
      inactiveWarningCount += 1;
    }
  }

  return { unreadMessageCount, abnormalSiteCount, inactiveWarningCount };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function normalizeTimestampMs(ts: unknown): number | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    return null;
  }
  // 兼容秒级时间戳与毫秒级时间戳
  return ts < 1e11 ? ts * 1000 : ts;
}

/**
 * 计算站点账号距离不活跃/保号阈值的剩余天数。
 * 仅在站点上报了有效 lastAccessAt 且配置了 maxInactiveDays > 0 时返回结果。
 */
export function computeSiteInactivityInfo(
  userInfo: Partial<IUserInfo> | undefined,
  maxInactiveDays: number,
  warningDays: number = 7,
  now: number = Date.now(),
): ISiteInactivityInfo | null {
  if (!Number.isFinite(maxInactiveDays) || maxInactiveDays <= 0) {
    return null;
  }
  const lastAccessAt = normalizeTimestampMs(userInfo?.lastAccessAt);
  if (lastAccessAt === null) {
    return null;
  }

  const inactiveDays = Math.max(0, Math.floor((now - lastAccessAt) / MS_PER_DAY));
  const remainingDays = maxInactiveDays - inactiveDays;
  const safeWarningDays = Number.isFinite(warningDays) && warningDays > 0 ? warningDays : 7;

  let status: ISiteInactivityInfo["status"] = "ok";
  if (remainingDays <= Math.min(3, safeWarningDays)) {
    status = "danger";
  } else if (remainingDays <= safeWarningDays) {
    status = "warning";
  }

  return {
    lastAccessAt,
    inactiveDays,
    maxInactiveDays,
    remainingDays,
    status,
  };
}

export interface IEvaluateAccountHealthParams {
  siteId: TSiteID;
  siteName: string;
  previous?: Partial<IUserInfo>;
  current: Partial<IUserInfo>;
  alertsConfig: IAlertConfig;
  siteMaxInactiveDays?: number;
  now?: number;
}

/**
 * 对比单站刷新前后的 IUserInfo 快照，产出需要主动通知的健康事件列表。
 * 纯函数实现，便于单元测试与后台/前端复用。
 */
export function evaluateAccountHealthDiff(params: IEvaluateAccountHealthParams): IAccountHealthAlert[] {
  const { siteId, siteName, previous, current, alertsConfig, siteMaxInactiveDays, now = Date.now() } = params;
  if (!alertsConfig.enabled) {
    return [];
  }

  const alerts: IAccountHealthAlert[] = [];

  if (alertsConfig.notifyNeedLogin && current.status === EResultParseStatus.needLogin) {
    alerts.push({
      key: `${siteId}:needLogin`,
      kind: "needLogin",
      siteId,
      siteName,
      severity: "error",
      title: `${siteName} Cookie 失效`,
      message: `${siteName} 需要重新登录以恢复数据同步`,
    });
    return alerts;
  }

  if (current.status !== EResultParseStatus.success) {
    return alerts;
  }

  // 1. 新未读站内信
  if (alertsConfig.notifyUnreadMessage) {
    const prevMsg = typeof previous?.messageCount === "number" && previous.messageCount > 0 ? previous.messageCount : 0;
    const curMsg = typeof current.messageCount === "number" && current.messageCount > 0 ? current.messageCount : 0;
    if (curMsg > prevMsg) {
      alerts.push({
        key: `${siteId}:unreadMessage:${curMsg}`,
        kind: "unreadMessage",
        siteId,
        siteName,
        severity: "info",
        title: `${siteName} 有新站内信`,
        message: `${siteName} 当前有 ${curMsg} 条未读消息（+${curMsg - prevMsg}）`,
      });
    }
  }

  // 2. 新增 H&R 未达标 / 预警
  if (alertsConfig.notifyHnRWarning) {
    const prevUnsatisfied =
      typeof previous?.hnrUnsatisfied === "number" && previous.hnrUnsatisfied > 0 ? previous.hnrUnsatisfied : 0;
    const curUnsatisfied =
      typeof current.hnrUnsatisfied === "number" && current.hnrUnsatisfied > 0 ? current.hnrUnsatisfied : 0;
    const prevPreWarn =
      typeof previous?.hnrPreWarning === "number" && previous.hnrPreWarning > 0 ? previous.hnrPreWarning : 0;
    const curPreWarn =
      typeof current.hnrPreWarning === "number" && current.hnrPreWarning > 0 ? current.hnrPreWarning : 0;

    if (curUnsatisfied > prevUnsatisfied || curPreWarn > prevPreWarn) {
      alerts.push({
        key: `${siteId}:hnr:${curUnsatisfied}:${curPreWarn}`,
        kind: "hnrWarning",
        siteId,
        siteName,
        severity: "error",
        title: `${siteName} H&R 预警`,
        message: `${siteName} 检测到新增 H&R（未达标: ${curUnsatisfied}, 预警: ${curPreWarn}）`,
      });
    }
  }

  // 3. 分享率低于阈值（ratio < 0 表示无限大，需排除）
  if (
    alertsConfig.notifyLowRatio &&
    Number.isFinite(alertsConfig.lowRatioThreshold) &&
    alertsConfig.lowRatioThreshold > 0
  ) {
    const ratio = current.ratio;
    const downloaded = typeof current.downloaded === "number" ? current.downloaded : 0;
    if (
      typeof ratio === "number" &&
      Number.isFinite(ratio) &&
      ratio >= 0 &&
      downloaded > 0 &&
      ratio < alertsConfig.lowRatioThreshold
    ) {
      alerts.push({
        key: `${siteId}:lowRatio:${Math.floor(ratio * 100)}`,
        kind: "lowRatio",
        siteId,
        siteName,
        severity: "warning",
        title: `${siteName} 分享率过低`,
        message: `${siteName} 当前分享率 ${ratio.toFixed(2)}，低于警戒线 ${alertsConfig.lowRatioThreshold}`,
      });
    }
  }

  // 4. 等级变化 / 升级
  if (
    alertsConfig.notifyLevelUp &&
    previous?.levelName &&
    current.levelName &&
    previous.levelName !== current.levelName
  ) {
    alerts.push({
      key: `${siteId}:levelUp:${current.levelName}`,
      kind: "levelUp",
      siteId,
      siteName,
      severity: "info",
      title: `${siteName} 等级变动`,
      message: `${siteName} 等级由 ${previous.levelName} 变更为 ${current.levelName}`,
    });
  }

  // 5. 保号不活跃倒计时预警
  if (alertsConfig.notifyInactivity) {
    const maxDays =
      typeof siteMaxInactiveDays === "number" && Number.isFinite(siteMaxInactiveDays) && siteMaxInactiveDays > 0
        ? siteMaxInactiveDays
        : alertsConfig.defaultSiteMaxInactiveDays;
    const inactivity = computeSiteInactivityInfo(current, maxDays, alertsConfig.inactivityWarningDays, now);
    if (inactivity && inactivity.remainingDays <= alertsConfig.inactivityWarningDays) {
      alerts.push({
        key: `${siteId}:inactivity:${inactivity.remainingDays}`,
        kind: "inactivity",
        siteId,
        siteName,
        severity: inactivity.status === "danger" ? "error" : "warning",
        title: `${siteName} 保号提醒`,
        message:
          inactivity.remainingDays <= 0
            ? `${siteName} 已 ${inactivity.inactiveDays} 天未登录，已达到保号阈值（${inactivity.maxInactiveDays} 天）`
            : `${siteName} 已 ${inactivity.inactiveDays} 天未登录，距保号阈值仅剩 ${inactivity.remainingDays} 天`,
        remainingDays: inactivity.remainingDays,
      });
    }
  }

  return alerts;
}
