import { uniq } from "es-toolkit";
import { isEmpty } from "es-toolkit/compat";
import {
  getDefinedSiteMetadata,
  getFavicon,
  getFaviconMetadata,
  getSite as createSiteInstance,
  NO_IMAGE,
  type ISiteUserConfig,
  type TSiteID,
  checkSiteMetadataAllow,
} from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import type { IMetadataPiniaStorageSchema } from "@/shared/types.ts";

import { logger } from "./logger.ts";
import { assertSenderMatchesSite, isTrustedExtensionContext } from "./sender.ts";
import { getCachedSiteInstance, getSiteInstanceCacheKey, setCachedSiteInstance } from "./siteInstanceCache.ts";
import { ptdIndexDb } from "../adapter/indexdb.ts";

export async function getSiteUserConfig(siteId: TSiteID, flush = false) {
  // 只取当前站点的用户配置，避免整份 metadata 跨上下文往返（见 docs/performance-audit.md P0-2）
  const storedSiteUserConfig =
    ((await sendMessage("getExtStoragePath", {
      key: "metadata",
      path: ["sites", siteId],
      defaultValue: {},
    })) as ISiteUserConfig) ?? {};

  const siteMetaData = await getDefinedSiteMetadata(siteId);

  if (flush || isEmpty(storedSiteUserConfig)) {
    const isDeadSite = siteMetaData.isDead ?? false;
    storedSiteUserConfig.isOffline ??= isDeadSite;
    storedSiteUserConfig.sortIndex ??= 100;
    storedSiteUserConfig.allowSearch ??= !isDeadSite && checkSiteMetadataAllow(siteMetaData, "search");
    storedSiteUserConfig.allowQueryUserInfo ??= !isDeadSite && checkSiteMetadataAllow(siteMetaData, "userInfo");
    storedSiteUserConfig.timeout ??= 30e3;

    const inputSetting = {} as Record<string, string>;
    if (siteMetaData.userInputSettingMeta) {
      for (const userInputMeta of siteMetaData.userInputSettingMeta) {
        inputSetting[userInputMeta.name] = "";
      }
    }
    storedSiteUserConfig.inputSetting ??= inputSetting;

    storedSiteUserConfig.groups ??= siteMetaData.tags ?? [];
    storedSiteUserConfig.downloadInterval ??= siteMetaData?.download?.interval ?? 0;
    storedSiteUserConfig.uploadSpeedLimit ??= 0;
    storedSiteUserConfig.allowContentScript ??= true;
    storedSiteUserConfig.downloadLinkAppendix ??= "";
    storedSiteUserConfig.merge ??= {};
  }

  logger({ msg: `getSiteUserConfig for ${siteId}` });
  return storedSiteUserConfig;
}

/**
 * `getSiteUserConfig` 对 content script 开放，处理方必须校验「请求的 siteId ↔ 发送方页面」绑定
 * （A2/B1-3）：否则任意被注入内容脚本的页面都能读其它已配置站点的用户配置。
 * 扩展页（options 等）保持全权，不额外校验。
 */
onMessage("getSiteUserConfig", async ({ data: { siteId, flush }, sender }) => {
  // P1-1（并行审查）：用「非扩展页」而不是 `isContentScriptSender` 做条件 —— 后者要求 sender.id
  // 匹配本扩展，来自其它扩展的发送方会被判 false 而跳过绑定（fail-open）。
  if (!isTrustedExtensionContext(sender)) {
    const siteInstance = await getSiteInstance(siteId);
    assertSenderMatchesSite(siteInstance, sender);
  }
  return await getSiteUserConfig(siteId, flush);
});

onMessage("getSiteList", async () => {
  // 只取需要的两个子表，避免整份 metadata（含 lastUserInfo）跨上下文往返
  const sites =
    ((await sendMessage("getExtStoragePath", {
      key: "metadata",
      path: ["sites"],
      defaultValue: {},
    })) as IMetadataPiniaStorageSchema["sites"]) ?? {};
  const nameMap =
    ((await sendMessage("getExtStoragePath", {
      key: "metadata",
      path: ["siteNameMap"],
      defaultValue: {},
    })) as IMetadataPiniaStorageSchema["siteNameMap"]) ?? {};
  return Promise.all(
    Object.entries(sites).map(async ([id, config]) => {
      const siteMetaData = await getDefinedSiteMetadata(id as TSiteID);
      const isDead = siteMetaData.isDead ?? false;
      return {
        id,
        name: nameMap[id] ?? config.merge?.name ?? id,
        url: config.url ?? "",
        offline: (isDead || config.isOffline) ?? false,
      };
    }),
  );
});

export type TCreateSiteInstanceResult<TYPE extends "private" | "public"> = Awaited<
  ReturnType<typeof createSiteInstance<TYPE>>
>;

export async function getSiteInstance<TYPE extends "private" | "public">(
  siteId: TSiteID,
  options: { mergeUserConfig?: boolean } = {},
): Promise<TCreateSiteInstanceResult<TYPE>> {
  const { mergeUserConfig = true } = options;
  let storedSiteUserConfig: ISiteUserConfig = {};
  if (mergeUserConfig) {
    storedSiteUserConfig = await getSiteUserConfig(siteId);
  }

  // OS-5：按 siteId + 用户配置缓存站点实例。配置（含 url/inputSetting 等）变化时 key 变化自然失效；
  // runtimeSettings 由实例自身写回，从 key 中排除（见 siteInstanceCache.ts）。
  const cacheKey = getSiteInstanceCacheKey(siteId, storedSiteUserConfig, mergeUserConfig);
  const cached = getCachedSiteInstance<TCreateSiteInstanceResult<TYPE>>(siteId, cacheKey);
  if (cached) {
    return cached;
  }

  logger({ msg: `getSiteInstance for ${siteId}`, data: { url: storedSiteUserConfig.url } });
  const instance = await createSiteInstance<TYPE>(siteId, storedSiteUserConfig);
  return setCachedSiteInstance<TCreateSiteInstanceResult<TYPE>>(
    siteId,
    cacheKey,
    instance as TCreateSiteInstanceResult<TYPE>,
  );
}

/**
 * 按站点串行执行一次「会修改实例内部解析状态」的操作（见 OS-5 / 审查报告 B1-2 的同类并发问题）。
 *
 * 站点实例被缓存复用后，`_searchRowFailures`、`_rowElementQueryCache` 这类字段是**每次解析**
 * 的可变状态：同一站点的两个并发搜索会互相重置计数。这里把搜索类操作按 siteId 串成链，
 * 既避免共享实例的状态互串，也顺带把同站点并发请求收敛成串行（对站点更友好）。
 *
 * 注意：只包裹本身不会再进入其它 `runSiteOperation` 的操作，避免重入死锁。
 */
const siteOperationChains = new Map<string, Promise<unknown>>();
export function runSiteOperation<T>(siteId: string, task: () => Promise<T>): Promise<T> {
  const previous = siteOperationChains.get(siteId) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.catch(() => undefined);
  siteOperationChains.set(siteId, tail);
  void tail.then(() => {
    if (siteOperationChains.get(siteId) === tail) siteOperationChains.delete(siteId);
  });
  return next;
}

export async function getSiteFavicon(site: TSiteID | getFaviconMetadata, flush: boolean = false): Promise<string> {
  const siteId = typeof site === "string" ? site : site.id;
  let siteFavicon = (await (await ptdIndexDb).get("favicon", siteId)) ?? false;
  if (flush || !siteFavicon) {
    try {
      const siteInstance = await getSiteInstance(siteId);
      siteFavicon = await getFavicon({
        id: siteId,
        urls: uniq([siteInstance.url, ...(siteInstance.metadata.urls ?? [])].filter(Boolean)),
        // D2-N8：把 legacyUrls 一并交给 site 包，参与 favicon 可信 host/候选判定
        // （站点迁移域名后 favicon 链接常落在 legacy host 上，旧实现会把它判成不可信而失败）。
        legacyUrls: siteInstance.metadata.legacyUrls,
        favicon: siteInstance.metadata.favicon,
      });

      await (await ptdIndexDb).put("favicon", siteFavicon, siteId);
    } catch (e) {
      // D2-N8：站点定义缺失/getSiteInstance 失败时不能把整条消息 reject（调用方 SiteFavicon
      // 组件是按「拿不到图标」降级展示的）。这里回落到 NO_IMAGE 且**不写缓存**，下次仍可重试。
      logger({
        msg: `getSiteFavicon for ${siteId} failed, fallback to NO_IMAGE`,
        level: "warn",
        data: e instanceof Error ? e.message : String(e),
      });
      siteFavicon = false;
    }
  }

  if (!siteFavicon) {
    siteFavicon = NO_IMAGE;
    logger({ msg: `getSiteFavicon for ${siteId} failed, use default NO_IMAGE.`, level: "warn" });
  }

  return siteFavicon;
}

onMessage("getSiteFavicon", async ({ data: { site, flush } }) => (await getSiteFavicon(site, flush))!);

export async function clearSiteFaviconCache() {
  logger({ msg: `clearSiteFaviconCache` });
  return await (await ptdIndexDb).clear("favicon");
}

onMessage("clearSiteFaviconCache", async () => await clearSiteFaviconCache());
