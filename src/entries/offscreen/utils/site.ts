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

onMessage("getSiteUserConfig", async ({ data: { siteId, flush } }) => await getSiteUserConfig(siteId, flush));

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

export async function getSiteInstance<TYPE extends "private" | "public">(
  siteId: TSiteID,
  options: { mergeUserConfig?: boolean } = {},
) {
  const { mergeUserConfig = true } = options;
  let storedSiteUserConfig: ISiteUserConfig = {};
  if (mergeUserConfig) {
    storedSiteUserConfig = await getSiteUserConfig(siteId);
  }

  logger({ msg: `getSiteInstance for ${siteId}`, data: { url: storedSiteUserConfig.url } });
  return await createSiteInstance<TYPE>(siteId, storedSiteUserConfig);
}

export async function getSiteFavicon(site: TSiteID | getFaviconMetadata, flush: boolean = false): Promise<string> {
  const siteId = typeof site === "string" ? site : site.id;
  let siteFavicon = (await (await ptdIndexDb).get("favicon", siteId)) ?? false;
  if (flush || !siteFavicon) {
    const siteInstance = await getSiteInstance(siteId);
    if (siteInstance) {
      siteFavicon = await getFavicon({
        id: siteId,
        urls: uniq([siteInstance.url, ...siteInstance.metadata.urls].filter(Boolean)),
        favicon: siteInstance.metadata.favicon,
      });

      await (await ptdIndexDb).put("favicon", siteFavicon, siteId);
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
