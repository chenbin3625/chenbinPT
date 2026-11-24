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
import { syncCustomSites } from "@ptd/site/customSiteRegistry.ts";

import { onMessage, sendMessage } from "@/messages.ts";
import type { ICustomSiteDefinition, IMetadataPiniaStorageSchema } from "@/shared/types.ts";

import { logger } from "./logger.ts";
import { assertSenderMatchesSite, isTrustedExtensionContext } from "./sender.ts";
import {
  clearSiteInstanceCache,
  getCachedSiteInstance,
  getSiteInstanceCacheKey,
  setCachedSiteInstance,
} from "./siteInstanceCache.ts";
import { ptdIndexDb } from "../adapter/indexdb.ts";

let lastCustomSitesSignature = "{}";

/**
 * 在访问站点前同步 storage 中的 customSites 定义到 @ptd/site 运行时注册表。
 * 当自定义站点定义发生变化时自动失效对应的站点实例缓存。
 */
export async function ensureCustomSitesSynced(siteId?: TSiteID): Promise<void> {
  try {
    const customSites =
      ((await sendMessage("getExtStoragePath", {
        key: "metadata",
        path: ["customSites"],
        defaultValue: {},
      })) as Record<TSiteID, ICustomSiteDefinition>) ?? {};

    const signature = JSON.stringify(customSites);
    if (signature !== lastCustomSitesSignature) {
      lastCustomSitesSignature = signature;
      syncCustomSites(customSites);
      if (siteId) {
        clearSiteInstanceCache(siteId);
      } else {
        for (const id of Object.keys(customSites)) {
          clearSiteInstanceCache(id);
        }
      }
    }
  } catch {
    // 单元测试或 storage 不可用时静默跳过自定义站点同步
  }
}

export async function getSiteUserConfig(siteId: TSiteID, flush = false) {
  await ensureCustomSitesSynced(siteId);
  // 只取当前站点的用户配置，避免整份 metadata 跨上下文往返（见 docs/performance-audit.md P0-2）
  const stored =
    ((await sendMessage("getExtStoragePath", {
      key: "metadata",
      path: ["sites", siteId],
      defaultValue: {},
    })) as ISiteUserConfig) ?? {};
  // 下面的 `??=` 会原地写默认值。Firefox 的消息通道可能复用 background 读缓存中的同一对象，
  // 直接改它会让默认值只存在于缓存、不被持久化（其它读取方也会看到被污染的对象）。
  const storedSiteUserConfig: ISiteUserConfig = { ...stored };

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
  await ensureCustomSitesSynced();
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
      try {
        const siteMetaData = await getDefinedSiteMetadata(id as TSiteID);
        const isDead = siteMetaData.isDead ?? false;
        return {
          id,
          name: nameMap[id] ?? config?.merge?.name ?? id,
          url: config?.url ?? "",
          offline: (isDead || config?.isOffline) ?? false,
        };
      } catch (e) {
        // 单站点定义缺失/恢复数据损坏不应让整个 getSiteList 失败（否则内容脚本/搜索入口
        // 会完全拿不到站点列表）。返回最小占位并标记 offline，让调用方跳过即可。
        logger({
          msg: `Failed to read site metadata for ${id} in getSiteList`,
          level: "warn",
          data: { error: e instanceof Error ? e.message : String(e) },
        });
        return { id, name: nameMap[id] ?? id, url: config?.url ?? "", offline: true };
      }
    }),
  );
});

export type TCreateSiteInstanceResult<TYPE extends "private" | "public"> = Awaited<
  ReturnType<typeof createSiteInstance<TYPE>>
>;

/** 同一 cacheKey 的建实例过程去重：首次并发会重复 cloneDeep/动态 import，后完成者还会覆盖缓存。 */
const siteInstanceInFlight = new Map<string, Promise<unknown>>();

export async function getSiteInstance<TYPE extends "private" | "public">(
  siteId: TSiteID,
  options: { mergeUserConfig?: boolean } = {},
): Promise<TCreateSiteInstanceResult<TYPE>> {
  await ensureCustomSitesSynced(siteId);
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

  const inFlight = siteInstanceInFlight.get(cacheKey);
  if (inFlight) {
    return (await inFlight) as TCreateSiteInstanceResult<TYPE>;
  }

  logger({ msg: `getSiteInstance for ${siteId}`, data: { url: storedSiteUserConfig.url } });
  const pending = (async () => {
    const instance = await createSiteInstance<TYPE>(siteId, storedSiteUserConfig);
    return setCachedSiteInstance<TCreateSiteInstanceResult<TYPE>>(
      siteId,
      cacheKey,
      instance as TCreateSiteInstanceResult<TYPE>,
    );
  })();

  siteInstanceInFlight.set(cacheKey, pending);
  try {
    return (await pending) as TCreateSiteInstanceResult<TYPE>;
  } finally {
    if (siteInstanceInFlight.get(cacheKey) === pending) {
      siteInstanceInFlight.delete(cacheKey);
    }
  }
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
  // 历史版本可能把 NO_IMAGE 写进缓存；把它当作「无缓存」，否则该站点会永久显示空白且不再重试
  if (siteFavicon === NO_IMAGE) {
    siteFavicon = false;
  }
  if (flush || !siteFavicon) {
    try {
      const siteInstance = await getSiteInstance(siteId);
      const fetchedFavicon = await getFavicon({
        id: siteId,
        urls: uniq([siteInstance.url, ...(siteInstance.metadata.urls ?? [])].filter(Boolean)),
        // D2-N8：把 legacyUrls 一并交给 site 包，参与 favicon 可信 host/候选判定
        // （站点迁移域名后 favicon 链接常落在 legacy host 上，旧实现会把它判成不可信而失败）。
        legacyUrls: siteInstance.metadata.legacyUrls,
        favicon: siteInstance.metadata.favicon,
      });

      // getFavicon 抓取失败时返回的 NO_IMAGE 也是非空字符串，不能写入缓存：
      // 否则下次会直接命中这条「假图标」，站点永久空白且没有重试机会。
      if (fetchedFavicon !== NO_IMAGE) {
        await (await ptdIndexDb).put("favicon", fetchedFavicon, siteId);
      }
      siteFavicon = fetchedFavicon;
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

async function probeSingleUrlLatency(
  rawUrl: string,
  timeoutMs: number,
): Promise<{ url: string; ok: boolean; status?: number; latencyMs: number; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { url: rawUrl, ok: false, latencyMs: -1, error: "Unsupported protocol" };
    }
  } catch {
    return { url: rawUrl, ok: false, latencyMs: -1, error: "Invalid URL" };
  }

  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let resp = await fetch(parsed.href, {
      method: "HEAD",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    if (resp.status === 405 || resp.status === 501) {
      resp = await fetch(parsed.href, {
        method: "GET",
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal,
      });
    }
    const latencyMs = Math.max(1, Math.round(performance.now() - start));
    // 2xx / 3xx / 401 / 403 说明域名已连通且服务在响应（登录态或 CF 页仍代表网络可达）
    const ok = resp.status >= 200 && resp.status < 500;
    return { url: rawUrl, ok, status: resp.status, latencyMs };
  } catch (e) {
    const latencyMs = Math.max(1, Math.round(performance.now() - start));
    return {
      url: rawUrl,
      ok: false,
      latencyMs,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

onMessage("testSiteUrlsLatency", async ({ data }) => {
  const urls = Array.isArray(data?.urls)
    ? uniq(data.urls.filter((u): u is string => typeof u === "string" && !!u.trim()))
    : [];
  const timeoutMs =
    typeof data?.timeoutMs === "number" && Number.isFinite(data.timeoutMs)
      ? Math.min(Math.max(data.timeoutMs, 1000), 15_000)
      : 6000;
  return await Promise.all(urls.map((url) => probeSingleUrlLatency(url, timeoutMs)));
});
