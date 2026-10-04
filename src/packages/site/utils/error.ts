/**
 * 站点解析错误的统一分类工具
 *
 * 背景（性能/健壮性审计 P1-3「错误语义坍缩」）：
 * `getSearchResult()` / `getUserInfoResult()` 的 catch 分支早期无条件把 `status` 置为
 * `EResultParseStatus.parseError`，而 `request()` 抛出的其实是 `Network Error: ...`
 * （网络不可达 / 超时 / 5xx / 429），并且从不写入 `statusMsg`。
 * 结果是「网络抖动」与「站点页面结构变化导致的解析失败」在 UI 与日志中完全同构，
 * 既无法向用户解释原因，也无法判断是否值得重试。
 *
 * 这里提供两条能力：
 * 1. `NetworkError` / `ServerError` 两个 Error 子类，仅用于标记错误来源；
 *    它们的 message 仍保持既有格式 `Network Error: ...`，因此历史上依赖 message 前缀判断、
 *    或自行 `throw Error("Network Error: ...")` 的站点覆写（如 AvistazNetwork）依旧能被识别。
 * 2. `classifySiteError()` 把任意异常映射为 `{ status, statusMsg, retryable }`，
 *    只复用 `EResultParseStatus` 已有枚举值，不新增破坏性枚举（见 base.ts）。
 */

import {
  CFBlockedError,
  EResultParseStatus,
  NeedLoginError,
  NoTorrentsError,
  NoUserInputError,
} from "../types/base.ts";

/** 网络/传输层错误：没有拿到任何响应（断网、DNS 失败、超时、请求被取消等），通常可重试 */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/** 服务端错误：拿到了响应但状态码异常（429 限流、5xx 等），稍后重试可能成功 */
export class ServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerError";
  }
}

/** 兼容历史上直接 `throw Error("Network Error: ...")` 的实现（含站点定义的覆写） */
const legacyNetworkErrorMessagePattern = /^Network Error:/;

/**
 * 判断异常是否来源于网络/服务端（而非解析逻辑本身）
 */
export function isNetworkLikeError(e: unknown): boolean {
  if (e instanceof NetworkError || e instanceof ServerError) {
    return true;
  }
  return e instanceof Error && legacyNetworkErrorMessagePattern.test(e.message);
}

/**
 * 从任意异常中提取可直接展示的错误信息；没有有效信息时返回 undefined
 */
export function siteErrorMessage(e: unknown): string | undefined {
  let raw: unknown;

  if (e instanceof Error) {
    raw = e.message;
  } else if (typeof e === "string") {
    raw = e;
  } else if (e && typeof e === "object" && "message" in e) {
    raw = (e as { message?: unknown }).message;
  }

  const msg = typeof raw === "string" ? raw.trim() : "";
  return msg || undefined;
}

/** 把异常转换为适合写入 logger 的纯数据（避免把 Element/AxiosResponse 等对象塞进日志通道） */
export function siteErrorLogData(e: unknown): Record<string, any> {
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  return { message: String(e) };
}

export interface ISiteErrorClassification {
  /** 映射后的解析状态（只使用 EResultParseStatus 已有枚举值） */
  status: EResultParseStatus;
  /** 透传的错误信息，供 UI 与日志展示 */
  statusMsg?: string;
  /** 是否值得重试（网络类错误为 true，解析/配置类错误为 false） */
  retryable: boolean;
}

/**
 * 把站点在执行过程中捕获到的异常分类为可展示、可判断是否重试的结果。
 *
 * - 已知语义的异常（CF 拦截 / 需要登录 / 缺少用户输入 / 无结果）保持原有映射；
 * - 网络、超时、5xx/429 等服务端错误 → `unknownError`（可重试），不会再被误标为「解析错误」；
 * - 其余（选择器未定义、页面结构变化、DOM 解析抛错等）→ `parseError`（不可重试）。
 */
export function classifySiteError(e: unknown): ISiteErrorClassification {
  const statusMsg = siteErrorMessage(e);

  if (e instanceof CFBlockedError) {
    return { status: EResultParseStatus.CFBlocked, statusMsg, retryable: true };
  }
  if (e instanceof NeedLoginError) {
    // 需要用户先登录，重试本身无意义
    return { status: EResultParseStatus.needLogin, statusMsg, retryable: false };
  }
  if (e instanceof NoUserInputError) {
    // 必填用户配置缺失，重试本身无意义
    return { status: EResultParseStatus.noUserInput, statusMsg, retryable: false };
  }
  if (e instanceof NoTorrentsError) {
    return { status: EResultParseStatus.noResults, statusMsg, retryable: false };
  }

  if (isNetworkLikeError(e)) {
    return { status: EResultParseStatus.unknownError, statusMsg, retryable: true };
  }

  return { status: EResultParseStatus.parseError, statusMsg, retryable: false };
}
