import { ref, computed } from "vue";
import { type ISiteUserConfig, type IUserInfo, TSiteID } from "@ptd/site";
import { sendMessage } from "@/messages.ts";
import { i18n } from "@/options/plugins/i18n.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

import { differenceInDays } from "date-fns";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";

import { fixUserInfo } from "./format.ts";
import { loadAllAddedSiteMetadata } from "./siteMetadata.ts";

export interface IUserInfoItem extends IUserInfo {
  siteUserConfig: ISiteUserConfig;
  siteName: string;
}

const metadataStore = useMetadataStore();

export const perSiteLastUserData = ref<Record<TSiteID, IUserInfoItem>>({});
export const tableData = computed(() => Object.values(perSiteLastUserData.value));

/** 表格首次加载 / 重新加载期间为 true，供页面显示表格 loading 占位 */
export const isTableDataLoading = ref<boolean>(false);

async function updatePerSiteData(siteId: TSiteID, siteUserInfoData: IUserInfo) {
  const currentDate = new Date();

  // 再单独加载一遍该站点的配置信息，以免缺失
  const allAddedSiteMetadata = await loadAllAddedSiteMetadata([siteId]);
  const siteMeta = allAddedSiteMetadata[siteId];

  perSiteLastUserData.value[siteId] = {
    ...fixUserInfo(siteUserInfoData),
    site: siteId,
    siteUserConfig: metadataStore.sites[siteId],
    siteName: siteMeta.combinedSiteName,
    // 对 isDead 或者 isOffline 的站点不允许选择（ https://github.com/chenbin3625/chenbinPT/pull/140 ）
    selectable: !(siteMeta.isDead || siteMeta.isOffline),

    // 预先计算 多少天未访问站点，以防止在 template 中反复计算
    lastAccessDuration:
      typeof siteUserInfoData.lastAccessAt === "number"
        ? differenceInDays(currentDate, siteUserInfoData.lastAccessAt)
        : 0,
  };
}

export async function initTableData() {
  const configStore = useConfigStore();

  isTableDataLoading.value = true;

  try {
    // metadata store 从 chrome.storage 的恢复是异步的：水合完成前 metadataStore.sites 还是空对象，
    // 直接建表会渲染出「暂无数据」，需要先等水合完成（页面上的 loading 也正好覆盖这段时间）。
    await metadataStore.$onReady();

    // 预加载所有已配置的站点基本属性，同时预加载的变量在全局统一，这样可以加快 Timeline 和 Statistic 的加载速度
    const addedSiteMetaData = await loadAllAddedSiteMetadata(Object.keys(metadataStore.sites));

    const tasks: Promise<void>[] = [];

    for (const [siteId, siteUserConfig] of Object.entries(metadataStore.sites)) {
      const siteMeta = addedSiteMetaData[siteId];

      // B-25 的配套守卫：站点元数据加载失败时（例如该站点 id 已不在构建产物里）这里会是 undefined，
      // 直接解引用会让整张表建不出来，跳过该站点即可（失败原因已由 loadAllAddedSiteMetadata 统一提示）。
      if (!siteMeta) {
        continue;
      }

      if (
        // 只显示私有站点的用户信息
        siteMeta.type === "public" ||
        // 根据配置决定是否显示已死亡站点的用户信息
        (!configStore.userInfo.showDeadSiteInOverview && siteMeta.isDead) ||
        // 根据配置决定是否显示设置了离线模式或不允许查询用户信息的站点
        (!siteMeta.isDead &&
          !configStore.userInfo.showPassedSiteInOverview &&
          (siteUserConfig.isOffline || siteUserConfig.allowQueryUserInfo === false))
      ) {
        continue;
      }

      const siteUserInfoData = metadataStore.lastUserInfo[siteId] ?? {};
      tasks.push(
        updatePerSiteData(siteId as TSiteID, siteUserInfoData).catch((e) => {
          console.error(`initTableData: updatePerSiteData failed for ${siteId}`, e);
        }),
      );
    }

    await Promise.allSettled(tasks);
  } finally {
    isTableDataLoading.value = false;
  }
}

export function flushSiteLastUserInfo(sites: TSiteID[]) {
  const runtimeStore = useRuntimeStore();
  const configStore = useConfigStore();

  for (const site of sites) {
    runtimeStore.userInfo.flushPlan[site] = true;

    sendMessage("getSiteUserInfoResult", {
      siteId: site,
      queueConcurrency: configStore.userInfo.queueConcurrency,
    })
      .then((userInfo) => updatePerSiteData(site, userInfo))
      .catch(() => {
        // 这里必须判断「是否仍在刷新队列中」：仍在刷新说明是真实失败，要提示；
        // 已被 cancelFlushSiteLastUserInfo / finally 置为 false 则说明是队列取消，静默处理。
        // 注意条件不能取反，否则真实失败会被静默吞掉（按钮点了没有任何反馈）。
        // 失败详情由下面的提示直接告知用户，不再往控制台重复打印（options 侧没有日志查看器，见审查报告 L-7）。
        if (runtimeStore.userInfo.flushPlan[site]) {
          runtimeStore.showSnakebar(i18n.t("MyData.index.flushSiteFailed", { site }), { color: "error" });
        }
      })
      .finally(() => {
        runtimeStore.userInfo.flushPlan[site] = false;
      });
  }
}

export async function cancelFlushSiteLastUserInfo() {
  const runtimeStore = useRuntimeStore();
  for (const runtimeStoreKey in runtimeStore.userInfo.flushPlan) {
    runtimeStore.userInfo.flushPlan[runtimeStoreKey] = false;
  }

  await sendMessage("cancelUserInfoQueue", undefined);

  runtimeStore.showSnakebar(i18n.t("MyData.index.flushQueueCancelled"), { color: "error" });
}

export async function loadSiteHistoryData(siteId: TSiteID): Promise<Array<IUserInfo & { date: string }>> {
  const retData: Array<IUserInfo & { date: string }> = [];

  const siteUserInfoData = (await sendMessage("getSiteUserInfo", siteId)) as Record<string, IUserInfo>;

  for (const [date, item] of Object.entries(siteUserInfoData)) {
    retData.push({ ...fixUserInfo(item), date });
  }

  return retData;
}
