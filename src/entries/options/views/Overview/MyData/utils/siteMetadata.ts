import { shallowReactive } from "vue";

import { definitionList, ISiteMetadata, NO_IMAGE, TSiteID } from "@ptd/site";

import { sendMessage } from "@/messages.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { getCachedSiteMetadata } from "./siteMetadataCache.ts";

export interface IExtendSiteMetadata extends Pick<ISiteMetadata, "id" | "type"> {
  siteName: string; // 解析后的站点名称（当前用户使用的）
  combinedSiteName: string; // 所有该站点的名称，使用 "|$|" 分隔
  hasUserInfo: boolean; // 是否有用户配置
  isDead: boolean; // 是否为失效站点
  isOffline: boolean; // 是否为离线站点
  faviconSrc: string;
  faviconElement: HTMLImageElement; // 站点的图片
}

export type TOptionSiteMetadatas = Record<TSiteID, IExtendSiteMetadata>;

export const allAddedSiteMetadata = shallowReactive<TOptionSiteMetadatas>({});

/** 已经提示过加载失败的站点：同一次会话里最多提示一次，避免每次刷新/每个页面都重复弹提示 */
const reportedFailedSiteIds = new Set<string>();

export async function loadAllAddedSiteMetadata(sites?: string[]): Promise<TOptionSiteMetadatas> {
  const loadSites = sites ?? definitionList;
  const metadataStore = useMetadataStore();
  const failedSiteIds: string[] = [];

  await Promise.allSettled(
    // B-25：这里**不能**写成 `new Promise(async (resolve) => { … })`。
    // `new Promise` 会忽略 executor 的返回值，而 async executor 内部一旦抛错（例如站点 id 已不在构建产物里，
    // `getCachedSiteMetadata` reject），返回的 rejected promise 无人观察、`resolve()` 永不执行 —— 外层 promise
    // **永不 settle**。`Promise.allSettled` 只能防「reject」，防不了「永不 settle」，于是调用方永久挂起。
    // 改为 map(async …) + 逐站 try/catch，保证每个映射出的 promise 必然 settle。
    loadSites.map(async (siteId) => {
      if (allAddedSiteMetadata[siteId]) return;

      try {
        // P2-16/P1-21：站点定义走模块级 memo，避免每个站点重复动态 import + cloneDeep
        const siteMetadata = await getCachedSiteMetadata(siteId);
        const siteFaviconUrl = await sendMessage("getSiteFavicon", { site: siteId });

        const siteName = await metadataStore.getSiteName(siteId);

        // 加载站点图标
        const siteFavicon = new Image();
        siteFavicon.src = siteFaviconUrl;
        siteFavicon.decode().catch(() => {
          // 回退到默认图失败时同样不能放任：未处理的 rejection 会污染控制台（原为一条 no-floating-promises 基线）
          siteFavicon.src = NO_IMAGE;
          siteFavicon.decode().catch(() => undefined);
        });

        (allAddedSiteMetadata as TOptionSiteMetadatas)[siteId] = {
          id: siteId,
          type: siteMetadata.type,
          siteName,
          combinedSiteName: Array.from(
            new Set([siteName, siteMetadata.name, ...(siteMetadata.aka ?? [])].filter(Boolean)),
          ).join("|$|"),
          hasUserInfo: Object.hasOwn(siteMetadata, "userInfo"),
          isDead: siteMetadata.isDead ?? false,
          isOffline: metadataStore.sites[siteId]?.isOffline ?? false,
          faviconSrc: siteFaviconUrl,
          faviconElement: siteFavicon,
        };
      } catch {
        // 单个站点失败不影响其它站点：放弃该站点（不写缓存，下次调用可重试）并收集起来统一提示用户。
        // 不写日志：options 侧没有可用的日志查看器（见审查报告 L-7），而该站点会静默从
        // MyData / 时间线 / 统计里消失，必须让用户知道。
        failedSiteIds.push(siteId);
      }
    }),
  );

  const newFailedSiteIds = failedSiteIds.filter((siteId) => !reportedFailedSiteIds.has(siteId));
  if (newFailedSiteIds.length > 0) {
    newFailedSiteIds.forEach((siteId) => reportedFailedSiteIds.add(siteId));
    const showSites = newFailedSiteIds.slice(0, 5).join("、");
    const moreText = newFailedSiteIds.length > 5 ? ` 等 ${newFailedSiteIds.length} 个站点` : "";
    useRuntimeStore().showSnakebar(`加载站点元数据失败：${showSites}${moreText}，已跳过这些站点`, { color: "error" });
  }

  return allAddedSiteMetadata;
}
