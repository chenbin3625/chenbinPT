// 所有PT站点的基类
import { selectElements } from "../utils/selector";
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { intersection, pascalCase, pick, toMerged, uniq } from "es-toolkit";
import { get, has, set } from "es-toolkit/compat";

import BittorrentSite, { isDocumentNode } from "./AbstractBittorrentSite";
import { classifySiteError, guessUserLevelId, logMessage, siteErrorLogData } from "../utils";
import {
  EResultParseStatus,
  type IElementQuery,
  type IUserInfo,
  type ITorrent,
  type TLevelId,
  type TPatterns,
  type TSchemaMetadata,
} from "../types";

/** 本引擎一定会提供的键；列出来之后消费方读它们不必再写非空断言 */
type TMetadataKeys = "version" | "search" | "userInfo";

export const SchemaMetadata: TSchemaMetadata<TMetadataKeys> = {
  version: -1,
  search: {},
  userInfo: {},
};

/**
 * 默认「未登录」URL 判据（E13）。
 *
 * 旧实现用 `/doLogin|login|verify|checkpoint|returnto/gi` 直接 `test(responseURL)`：
 * 搜索关键词（`?search=Checkpoint`）、Unit3D/Avistaz 用户名（`/users/verify`）都会命中，
 * 导致正常页面被误判为「需要登录」。改为：
 * - 只匹配 **pathname 的登录端点**（`/login.php`、`/takelogin.php`、`/doLogin`、`/verify`、`/checkpoint` 等）；
 * - `returnto` 只认**查询参数名**（`?returnto=...`），不认 value / 普通关键词；
 * - **查询串端点**（E13 补漏）：Discuz 未登录跳转是 `member.php?mod=logging&action=login`
 *   （pathname 为 `member.php`，不等于 `/login`），phpBB 是 `ucp.php?mode=login`，
 *   vBulletin/部分 NexusPHP fork 是 `?do=login` / `?page=login`。只看 pathname 会漏判
 *   （实际受影响站点：skyeynow/Discuz 引擎回落 AbstractPrivateSite）。这里只认
 *   「查询参数名为 `action`/`do`/`page`/`mode` 且值为 `login`」的精确形态，
 *   搜索词/用户名位于其它参数（`?search=Checkpoint`、`?username=login`）时不会命中；
 * - `/users/xxx`、`/profile/xxx` 这类「最后一段是用户名」的路径跳过端点匹配（用户名可以叫 verify/login）。
 */
const defaultNoLoginPathPattern =
  /(?:^|\/)(?:doLogin|takelogin|login|verify|checkpoint|twofactor|two-step|two_step)(?:\.php)?\/?$/i;
const defaultNoLoginReturntoPattern = /[?&]returnto=/i;
const defaultNoLoginQueryPattern = /[?&](?:action|do|page|mode)=login(?:&|#|$)/i;
const userProfilePathPattern = /^\/(?:users?|profile|member|members)(?:\/|$)/i;

/**
 * 默认「未登录」HTTP 状态码（E14）：只保留明确的鉴权失败码。
 *
 * 502/504 是 PT 站最常见的网关故障码，旧实现把它们也当成「需要登录」→ 上层拿到
 * `needLogin, retryable:false`，用户看到「登录失效」且不会自动重试；现在交给 ServerError（可重试）。
 * 确有站点用 502 表示未登录的，在定义的 `noLoginAssert.httpStatusCodes` 里单独声明。
 */
const defaultNoLoginHttpStatusCodes = [
  401, // Unauthorized
  403, // Forbidden
];

/** 未在 metadata.userInfo.criticalFields 中覆写时的默认关键字段（真实站点可用定义级逃生口排除） */
const defaultUserInfoCriticalFields = ["uploaded", "downloaded"] as const;

export default class PrivateSite extends BittorrentSite {
  protected checkUserInfoSelectorMatches(
    doc: Element | object,
    selectors: Record<string, IElementQuery | undefined>,
    fields: string[],
    criticalFields?: readonly string[],
  ): { declared: number; matched: number; matchedFields: Set<string> } {
    // P2（第二轮审查）：关键字段硬失败需要 metadata 级逃生口。默认语义不变（uploaded/downloaded），
    // 真实站点在部分账号/页面变体确实缺某个字段时，可在定义里覆写 `userInfo.criticalFields`。
    const effectiveCriticalFields =
      criticalFields ?? this.metadata.userInfo?.criticalFields ?? defaultUserInfoCriticalFields;
    let declared = 0;
    let matched = 0;
    const matchedFields = new Set<string>();
    const missingCritical: string[] = [];
    for (const field of fields) {
      const query = selectors[field];
      if (!query?.selector) continue;
      declared++;
      if (this.hasFieldMatch(doc, query)) {
        matched++;
        matchedFields.add(field);
      } else if (effectiveCriticalFields.includes(field)) {
        missingCritical.push(field);
      }
    }
    if (missingCritical.length) {
      throw new Error(
        `${matched === 0 ? "用户信息页未命中任何字段；" : ""}用户信息关键字段 ${missingCritical.join(", ")} 未命中，页面或接口可能已改版`,
      );
    }
    // P2-D：把命中集合回传给调用方，避免写入循环在零命中字段上再次调用 hasFieldMatch
    // （即同一 query 的第 3 次 getFieldData 求值）。
    return { declared, matched, matchedFields };
  }

  get allowQueryUserInfo(): boolean {
    return this.isOnline && !!this.metadata.userInfo && !(this.userConfig.allowQueryUserInfo === false);
  }

  protected get noLoginCheckHttpStatusCodes(): number[] | false {
    return this.metadata.noLoginAssert?.httpStatusCodes ?? defaultNoLoginHttpStatusCodes;
  }

  protected get noLoginCheckUrlPatterns(): TPatterns | false {
    return this.metadata.noLoginAssert?.urlPatterns ?? [defaultNoLoginPathPattern];
  }

  protected get noLoginCheckRefreshHeaderPattern(): TPatterns | false {
    return this.metadata.noLoginAssert?.refreshHeaderPattern ?? this.noLoginCheckUrlPatterns;
  }

  /** 是否使用内置默认 URL 判据（自定义 urlPatterns 保持旧的全 URL 正则语义以兼容定义） */
  private get usesDefaultNoLoginUrlPatterns(): boolean {
    return !this.metadata.noLoginAssert?.urlPatterns;
  }

  /** 是否使用内置默认 Refresh 判据 */
  private get usesDefaultNoLoginRefreshPattern(): boolean {
    return !this.metadata.noLoginAssert?.refreshHeaderPattern && this.usesDefaultNoLoginUrlPatterns;
  }

  /**
   * 判断一个「位置」（responseURL / refresh 重定向地址）是否像登录页。
   * 默认判据只看 pathname、`returnto` 与查询串登录端点（见文件头部说明），
   * 自定义 patterns 仍按旧语义对整串匹配。
   */
  private matchesNoLoginLocation(location: string, patterns: TPatterns, defaultSemantics: boolean): boolean {
    if (defaultSemantics) {
      let parsed: URL;
      try {
        parsed = new URL(location, this.url);
      } catch {
        return false;
      }
      // returnto 与「查询参数=login」都只检查 search，不受搜索关键词/用户名影响
      if (defaultNoLoginReturntoPattern.test(parsed.search) || defaultNoLoginQueryPattern.test(parsed.search)) {
        return true;
      }
      return !userProfilePathPattern.test(parsed.pathname) && defaultNoLoginPathPattern.test(parsed.pathname);
    }

    for (const pattern of patterns) {
      try {
        if (new RegExp(pattern).test(location)) {
          return true;
        }
      } catch {
        // 定义里的非法正则不应让登录检查整块崩掉（退化为不命中该条）
      }
    }
    return false;
  }

  protected override loggedCheck(res: AxiosResponse): boolean {
    const request = res.request as XMLHttpRequest;
    try {
      // 检查状态码：如果状态码在 noLoginCheckStatusCodes 中，则直接返回 false
      if (this.noLoginCheckHttpStatusCodes && this.noLoginCheckHttpStatusCodes.includes(res.status)) {
        return false;
      }

      const urlPatterns = this.noLoginCheckUrlPatterns;
      if (urlPatterns) {
        // E13：默认判据只匹配 pathname 上的登录端点，不再对完整 responseURL 做裸子串匹配
        if (this.matchesNoLoginLocation(request.responseURL, urlPatterns, this.usesDefaultNoLoginUrlPatterns)) {
          return false;
        }
      }

      // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Refresh
      if (res.headers.refresh && this.noLoginCheckRefreshHeaderPattern) {
        // 处理带URL的情况（支持逗号/分号分隔，忽略大小写和多余空格）
        const urlPattern = /[,;]\s*url\s*=\s*([^,\s;]+)/i;
        const urlMatch = res.headers.refresh.match(urlPattern);

        if (urlMatch) {
          const redirectUrl = urlMatch[1].trim();
          if (
            this.matchesNoLoginLocation(
              redirectUrl,
              this.noLoginCheckRefreshHeaderPattern,
              this.usesDefaultNoLoginRefreshPattern,
            )
          ) {
            return false;
          }
        }
      }

      const noLoginAssertMatchSelectors = this.metadata.noLoginAssert?.matchSelectors ?? [];
      if (noLoginAssertMatchSelectors.length > 0) {
        const matchFn = isDocumentNode(res.data) ? (d: any, m: string) => selectElements(m, d).length > 0 : has;
        for (const matchSelector of noLoginAssertMatchSelectors) {
          if (matchFn(res.data, matchSelector)) {
            return false;
          }
        }
      }

      if (this.metadata.noLoginAssert?.checkResponseContent === true) {
        const responseText =
          request.responseType === "document" ? request.responseXML?.documentElement.outerHTML : request.responseText;
        if (typeof responseText === "undefined") {
          return false; // 检查最终的Text，如果什么都没有也可能说明需要登陆
        } else if (responseText.length < 800 && /login|auth_form|not authorized/.test(responseText)) {
          return false; // 对Text进行检查，断言 “过短，且中间出现login等字段“ 说明可能需要登陆
        }
      }
    } catch (e) {
      console.debug(e);
      return false;
    }

    return true;
  }

  /**
   * 获得当前站点最新的用户信息方法入口
   * 这里 lastUserInfo 以及 保存/更新 UserInfo 均由调用的上层完成
   */
  public async getUserInfoResult(lastUserInfo: Partial<IUserInfo> = {}): Promise<IUserInfo> {
    let flushUserInfo: IUserInfo = {
      status: EResultParseStatus.unknownError,
      updateAt: +new Date(),
      site: this.metadata.id,
    };

    if (!this.allowQueryUserInfo || !this.metadata.userInfo?.process) {
      flushUserInfo.status = EResultParseStatus.passParse;
      return flushUserInfo;
    }

    // 如果有 lastUserInfo 则合并
    if (this.metadata.userInfo.pickLast) {
      flushUserInfo = toMerged(flushUserInfo, pick(lastUserInfo, this.metadata.userInfo.pickLast));
    }

    // H-6：本轮「声明了 selector 的字段」里真正在页面上命中的个数。站点改版 / 软错误页（HTTP 200）时
    // 所有 selector 都会零命中，getFieldData 回落到默认值（"" / 0），若照常标 success，
    // 真实的上传量/下载量/等级会被一次刷新静默替换成 0 并写进历史。
    // 只统计 selector 字段：NexusPHP 等由 parseUserInfoForXxx 动态填充的字段不在此列。
    let declaredSelectorFields = 0;
    let matchedSelectorFields = 0;

    try {
      for (const thisUserInfoProcess of this.metadata.userInfo.process) {
        // 该步骤能够获取的字段
        const processFields = uniq([
          ...(thisUserInfoProcess.fields ?? []),
          ...Object.keys(thisUserInfoProcess.selectors ?? {}),
        ]) as string[];
        // 检查相关元素是否均已有
        const existField = intersection(processFields, Object.keys(flushUserInfo));
        if (existField.length === processFields.length) {
          continue; // 如果全部数据都有则直接跳过本轮
        }

        // 更新请求字段，如果字段缺失则跳出循环
        let requestConfig: AxiosRequestConfig = toMerged(
          { url: "/", params: {}, data: {}, responseType: "document" },
          thisUserInfoProcess.requestConfig,
        );
        if (thisUserInfoProcess.assertion) {
          for (const [requiredField, pathKey] of Object.entries(thisUserInfoProcess.assertion)) {
            if (flushUserInfo[requiredField] != null) {
              if (has(requestConfig, pathKey as string)) {
                let oldData = get(requestConfig, pathKey as string);
                if (oldData && typeof oldData === "string") {
                  oldData = oldData.replace(`$${requiredField}$`, flushUserInfo[requiredField]);
                  set(requestConfig, pathKey as string, oldData);
                }
              } else {
                set(requestConfig, pathKey as string, flushUserInfo[requiredField]);
              }
            } else {
              // noinspection ExceptionCaughtLocallyJS
              throw new Error(`断言字段 ${requiredField} 缺失`);
            }
          }
        }

        // 如果有 requestConfigTransformer，则会在最后一步对请求配置进行处理
        if (typeof thisUserInfoProcess.requestConfigTransformer === "function") {
          requestConfig = thisUserInfoProcess.requestConfigTransformer(requestConfig, flushUserInfo as IUserInfo, this);
        }

        const requestDelay = thisUserInfoProcess.requestDelay ?? this.metadata.userInfo?.requestDelay ?? 0;
        await this.sleepAction(requestDelay);

        const { data: dataDocument } = await this.request<any>(requestConfig);
        const selectorFields = processFields.filter((key) => {
          const dynamicParseFuncKey = `parseUserInfoFor${pascalCase(key)}` as keyof this;
          return !(dynamicParseFuncKey in this && typeof this[dynamicParseFuncKey] === "function");
        });
        const selectors = Object.fromEntries(
          selectorFields.map((key) => [
            key,
            thisUserInfoProcess.selectors?.[key] ?? this.metadata.userInfo?.selectors?.[key],
          ]),
        );
        const matches = this.checkUserInfoSelectorMatches(dataDocument, selectors, selectorFields);
        declaredSelectorFields += matches.declared;
        matchedSelectorFields += matches.matched;

        for (const key of processFields) {
          const dynamicParseFuncKey = `parseUserInfoFor${pascalCase(key)}` as keyof this;
          if (dynamicParseFuncKey in this && typeof this[dynamicParseFuncKey] === "function") {
            flushUserInfo = await this[dynamicParseFuncKey](flushUserInfo, dataDocument, requestConfig);
          } else {
            // 优先使用本步骤定义的选择器，如果没有则使用 userInfo 全局的选择器
            const elementQuery = thisUserInfoProcess.selectors?.[key] ?? this.metadata.userInfo?.selectors?.[key];
            if (elementQuery) {
              // 传入字段名让 getFieldData 能区分文本字段（name 等不做数字强转，E18），
              // 并只在该字段真正命中时写入（D1-6：零命中回落出来的 "" 不能覆盖已有/期望的数字值）。
              const value = this.getFieldData(
                dataDocument,
                elementQuery as IElementQuery,
                key as keyof Omit<ITorrent, "site">,
              );
              // P2-D：复用 checkUserInfoSelectorMatches 已经算出的命中结果，不再对同一 query 做第 3 次求值。
              if (value === "" && !matches.matchedFields.has(key)) {
                continue;
              }
              flushUserInfo[key] = value;
            } else {
              // noinspection ExceptionCaughtLocallyJS
              // throw new Error(`字段 ${key} 未设置 selector 或 ${String(dynamicParseFuncKey)} 方法`);
            }
          }
        }
      }

      // 如果前面没有获取到用户等级的id，则尝试通过定义的 levelRequirements 来获取
      if (this.metadata.levelRequirements && flushUserInfo.levelName && typeof flushUserInfo.levelId === "undefined") {
        flushUserInfo.levelId = this.guessUserLevelId(flushUserInfo as IUserInfo);
      }

      if (declaredSelectorFields > 0 && matchedSelectorFields === 0) {
        // noinspection ExceptionCaughtLocallyJS
        throw new Error(
          `用户信息页未命中任何字段（${declaredSelectorFields} 个 selector 全部落空），页面可能已改版或不是用户信息页`,
        );
      }

      // 成功时清掉可能从 lastUserInfo 继承来的旧 statusMsg，避免 UI 展示过期错误
      flushUserInfo.statusMsg = undefined;
      flushUserInfo.status = EResultParseStatus.success;
    } catch (error) {
      // P1-3：区分「网络/超时/服务端错误（可重试）」与「真正的解析失败（重试无用）」，
      // 并把 error.message 透传到 statusMsg；P1-2：生产环境同样记录日志。
      const { status, statusMsg, retryable } = classifySiteError(error);
      flushUserInfo.status = status;
      flushUserInfo.statusMsg = statusMsg;

      logMessage(
        `[Site] ${this.name} getUserInfoResult failed (status=${EResultParseStatus[status]}, retryable=${retryable})`,
        {
          site: this.metadata.id,
          status,
          retryable,
          error: siteErrorLogData(error),
        },
        retryable ? "warn" : "error",
      );
    }

    return flushUserInfo;
  }

  // 允许子类覆盖
  protected guessUserLevelId(userInfo: IUserInfo): TLevelId {
    return guessUserLevelId(userInfo, this.metadata.levelRequirements ?? []);
  }
}
