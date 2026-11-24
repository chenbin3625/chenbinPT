import { ref, computed, reactive } from "vue";
import { type ISiteUserConfig, type IUserInfo, EResultParseStatus, TSiteID } from "@ptd/site";
import { sendMessage } from "@/messages.ts";
import { i18n } from "@/options/plugins/i18n.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";

import { differenceInDays } from "date-fns";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";

import { fixUserInfo } from "./format.ts";
import { isSiteOffline, loadAllAddedSiteMetadata } from "./siteMetadata.ts";

/** 最近一次刷新失败的信息：保留上一次成功的数据，同时把失败状态挂到行上。 */
export interface IFlushFailure {
  status: EResultParseStatus;
  statusMsg?: string;
  /** 失败发生的时刻（毫秒时间戳） */
  at: number;
}

export interface IUserInfoItem extends IUserInfo {
  siteUserConfig: ISiteUserConfig;
  siteName: string;
  /** 最近一次刷新失败（成功刷新后会被清空）；失败时行内仍保留上一次成功的数据 */
  lastFlushFailure?: IFlushFailure;
}

/** 视为「刷新失败」的解析状态：这些状态下不应该丢弃上一次成功的数据。 */
export const FLUSH_FAILURE_STATUSES: ReadonlySet<EResultParseStatus> = new Set([
  EResultParseStatus.unknownError,
  EResultParseStatus.parseError,
  EResultParseStatus.CFBlocked,
  EResultParseStatus.needLogin,
  EResultParseStatus.noResults,
  EResultParseStatus.noUserInput,
]);

export function isFlushFailureStatus(status: unknown): status is EResultParseStatus {
  return typeof status === "number" && FLUSH_FAILURE_STATUSES.has(status as EResultParseStatus);
}

/**
 * 行是否需要展示「更新异常」。
 *
 * - `lastFlushFailure`：本次会话内刷新失败，但已经保留了上一次成功的数据（status 仍为 success）；
 * - 旧数据（历史存储）里本身就是失败状态（没有可保留的成功快照）。
 */
export function isFlushFailed(item: Pick<IUserInfoItem, "status"> & { lastFlushFailure?: IFlushFailure }): boolean {
  return Boolean(item.lastFlushFailure) || isFlushFailureStatus(item.status);
}

/** 把 `statusMsg` 中形如 `i18n.xxx` 的键翻译成当前语言。 */
export function formatFlushStatusMsg(statusMsg?: string): string | undefined {
  if (!statusMsg) return undefined;
  return statusMsg.startsWith("i18n.") ? i18n.t(statusMsg.slice(5)) : statusMsg;
}

const metadataStore = useMetadataStore();

export const perSiteLastUserData = ref<Record<TSiteID, IUserInfoItem>>({});
export const tableData = computed(() => Object.values(perSiteLastUserData.value));

/** 表格首次加载 / 重新加载期间为 true，供页面显示表格 loading 占位 */
export const isTableDataLoading = ref<boolean>(false);

async function buildPerSiteData(siteId: TSiteID, siteUserInfoData: IUserInfo): Promise<IUserInfoItem> {
  const currentDate = new Date();

  // 再单独加载一遍该站点的配置信息，以免缺失
  const allAddedSiteMetadata = await loadAllAddedSiteMetadata([siteId]);
  const siteMeta = allAddedSiteMetadata[siteId];

  return {
    ...fixUserInfo(siteUserInfoData),
    site: siteId,
    siteUserConfig: metadataStore.sites[siteId],
    siteName: siteMeta.combinedSiteName,
    // 对 isDead 或者 isOffline 的站点不允许选择（ https://github.com/chenbin3625/chenbinPT/pull/140 ）
    selectable: !(siteMeta.isDead || isSiteOffline(siteId)),

    // 预先计算 多少天未访问站点，以防止在 template 中反复计算
    lastAccessDuration:
      typeof siteUserInfoData.lastAccessAt === "number"
        ? differenceInDays(currentDate, siteUserInfoData.lastAccessAt)
        : 0,
  };
}

async function updatePerSiteData(siteId: TSiteID, siteUserInfoData: IUserInfo) {
  // 成功刷新后整行重建，lastFlushFailure 自然被清空
  perSiteLastUserData.value[siteId] = await buildPerSiteData(siteId, siteUserInfoData);
}

/** 刷新失败时不要用一份空数据覆盖整行：保留上一次成功的数据，只挂上失败标记。 */
function recordFlushFailure(siteId: TSiteID, status: EResultParseStatus, statusMsg?: string) {
  const previous = perSiteLastUserData.value[siteId];
  if (!previous) return;

  perSiteLastUserData.value[siteId] = {
    ...previous,
    // 上一次数据本身就是失败状态时，没有可保留的成功快照，直接更新状态
    ...(previous.status === EResultParseStatus.success ? {} : { status, statusMsg }),
    lastFlushFailure: { status, statusMsg, at: Date.now() },
  };
}

let tableLoadToken = 0;
export async function initTableData() {
  const configStore = useConfigStore();
  const loadToken = ++tableLoadToken;

  isTableDataLoading.value = true;

  try {
    // metadata store 与 config store 从 chrome.storage 的恢复均为异步：
    // 水合完成前 metadataStore.sites 为空、configStore.userInfo 的展示开关也为默认值，
    // 直接建表会渲染出「暂无数据」或误过滤已配置显示的站点，这里一并等待水合完成。
    await Promise.all([metadataStore.$onReady?.(), configStore.$onReady?.()]);

    // 预加载所有已配置的站点基本属性，同时预加载的变量在全局统一，这样可以加快 Timeline 和 Statistic 的加载速度
    const addedSiteMetaData = await loadAllAddedSiteMetadata(Object.keys(metadataStore.sites));

    const tasks: Promise<void>[] = [];
    const nextRows: Record<TSiteID, IUserInfoItem> = {};

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
        buildPerSiteData(siteId as TSiteID, siteUserInfoData)
          .then((row) => {
            // 重建表格（例如另一个站点刷新成功、metadata 同步后或页面重新打开）时保留最近一次失败标记：
            // 优先对比内存与持久化的 lastUserInfoFailures，只有 updateAt 前进到失败之后（又成功了一次）才清除。
            const inMemoryFailure = perSiteLastUserData.value[siteId]?.lastFlushFailure;
            const persistedFailure = metadataStore.lastUserInfoFailures?.[siteId];
            const latestFailure =
              inMemoryFailure && persistedFailure
                ? inMemoryFailure.at >= persistedFailure.at
                  ? inMemoryFailure
                  : persistedFailure
                : (inMemoryFailure ?? persistedFailure);
            const lastSuccessAt = siteUserInfoData.updateAt ?? 0;
            if (latestFailure && (lastSuccessAt === 0 || latestFailure.at >= lastSuccessAt)) {
              row.lastFlushFailure = latestFailure;
            }
            nextRows[siteId] = row;
          })
          .catch((e) => {
            console.error(`initTableData: updatePerSiteData failed for ${siteId}`, e);
          }),
      );
    }

    await Promise.allSettled(tasks);
    if (loadToken === tableLoadToken) perSiteLastUserData.value = nextRows;
  } finally {
    if (loadToken === tableLoadToken) isTableDataLoading.value = false;
  }
}

/**
 * 本页面实例里「确实有在途请求」的站点。
 *
 * `runtimeStore.userInfo.flushPlan[site]` 会被 500ms 节流写进 sessionStorage；刷新页面后任务已不存在，
 * 恢复出来的 `true` 没有任何 `.finally` 会把它复位（F17：MyData 一直显示「取消刷新」、行内刷新按钮
 * 长期 loading/disabled）。这里记录真正的在途请求，供 `reconcileFlushPlan()` 区分「恢复残留」与
 * 「同一页面内仍在刷新」。
 *
 * value 是本次请求的标记：取消后立刻重新刷新同一站点时，旧请求迟到落地的 `.finally` 不能把
 * 新请求的标记和 flushPlan 一起清掉（否则行内 loading 提前消失、后续失败还会被误判为「已取消」）。
 */
const inFlightFlush = new Map<TSiteID, symbol>();

/** 当前批次进度，供页面显示「刷新中 x / y」。 */
export const flushProgress = reactive({ total: 0, done: 0, failed: 0 });

interface IFlushBatch {
  total: number;
  done: number;
  succeeded: number;
  failed: TSiteID[];
  cancelled: number;
  /** 取消刷新时自增，旧批次的结果不再汇总/提示 */
  token: number;
}

let flushToken = 0;
let currentBatch: IFlushBatch | null = null;

function startBatchIfIdle(): IFlushBatch {
  if (inFlightFlush.size === 0 || currentBatch === null) {
    flushProgress.total = 0;
    flushProgress.done = 0;
    flushProgress.failed = 0;
    currentBatch = { total: 0, done: 0, succeeded: 0, failed: [], cancelled: 0, token: flushToken };
  }
  return currentBatch;
}

function showFlushBatchResult(batch: IFlushBatch) {
  const runtimeStore = useRuntimeStore();
  const failedCount = batch.failed.length;
  // 取消的请求不计入成功；passParse / 后台处理中这类中性结果按「已处理」计入
  const effectiveSuccess = Math.max(0, batch.total - failedCount - batch.cancelled);

  // 全部被取消（或被取消后又失败）时不打扰用户，取消提示已由 cancelFlushSiteLastUserInfo 给出
  if (effectiveSuccess === 0 && failedCount === 0) return;

  if (failedCount === 0) {
    // 单个站点成功保持安静（行内数据会直接更新），批量刷新才需要完成反馈
    if (effectiveSuccess > 1) {
      runtimeStore.showSnackbar(i18n.t("MyData.refresh.batchSuccess", { count: effectiveSuccess }), {
        color: "success",
      });
    }
    return;
  }

  const failedNames = batch.failed.map((site) => metadataStore.siteNameMap?.[site] ?? site);
  const showNames = failedNames.slice(0, 5).join(i18n.t("common.delimiter"));
  const moreCount = failedNames.length > 5 ? failedNames.length - 5 : 0;

  if (failedCount === 1) {
    const failure = perSiteLastUserData.value[batch.failed[0]]?.lastFlushFailure;
    const reason =
      formatFlushStatusMsg(failure?.statusMsg) ??
      (failure ? i18n.t(`resultParseStatus.${EResultParseStatus[failure.status]}`) : undefined);
    runtimeStore.showSnackbar(
      i18n.t("MyData.refresh.siteFailed", {
        site: showNames,
        reason: reason ? `：${reason}` : "",
      }),
      { color: "error" },
    );
    return;
  }

  runtimeStore.showSnackbar(
    i18n.t("MyData.refresh.batchPartial", {
      success: effectiveSuccess,
      failed: failedCount,
      sites: moreCount > 0 ? `${showNames} ${i18n.t("common.moreSites", { count: moreCount })}` : showNames,
    }),
    { color: "warning" },
  );
}

export function flushSiteLastUserInfo(sites: TSiteID[]) {
  const runtimeStore = useRuntimeStore();
  const configStore = useConfigStore();

  // 去重：重复点击「刷新」不应该给同一个站点排队两次
  const targets = [...new Set(sites)].filter((site) => !inFlightFlush.has(site));
  if (targets.length === 0) return;

  const batch = startBatchIfIdle();
  batch.total += targets.length;
  flushProgress.total = batch.total;

  for (const site of targets) {
    const requestMarker = Symbol(site);
    runtimeStore.userInfo.flushPlan[site] = true;
    inFlightFlush.set(site, requestMarker);

    sendMessage("getSiteUserInfoResult", {
      siteId: site,
      queueConcurrency: configStore.userInfo.queueConcurrency,
    })
      .then(async (userInfo) => {
        // 已被取消：不再改动数据，也不计入批次结果
        if (batch.token !== flushToken) return;

        if (userInfo?.status === EResultParseStatus.success) {
          await updatePerSiteData(site, userInfo);
          batch.succeeded += 1;
        } else if (
          userInfo?.status === EResultParseStatus.passParse ||
          userInfo?.status === EResultParseStatus.waiting ||
          userInfo?.status === EResultParseStatus.working ||
          typeof userInfo?.status !== "number"
        ) {
          // 无需解析 / 后台尚未完成：保留现有数据，不算失败也不算成功
        } else {
          recordFlushFailure(site, userInfo.status, userInfo.statusMsg);
          batch.failed.push(site);
        }
      })
      .catch((e) => {
        if (batch.token !== flushToken) return;

        // 这里必须判断「是否仍在刷新队列中」：仍在刷新说明是真实失败，要提示；
        // 已被 cancelFlushSiteLastUserInfo / finally 置为 false 则说明是队列取消，静默处理。
        if (!runtimeStore.userInfo.flushPlan[site]) {
          batch.cancelled += 1;
          return;
        }

        // 请求直接抛错（网络/超时等）：同样保留上一次成功的数据
        recordFlushFailure(site, EResultParseStatus.unknownError, (e as Error)?.message);
        batch.failed.push(site);
      })
      .finally(() => {
        // 只清理自己这次请求：取消后立刻重新刷新同一站点时，旧请求不能动新请求的状态
        if (inFlightFlush.get(site) === requestMarker) {
          inFlightFlush.delete(site);
          if (runtimeStore.userInfo.flushPlan[site]) runtimeStore.userInfo.flushPlan[site] = false;
        }

        if (batch.token !== flushToken) return;

        batch.done += 1;
        flushProgress.done = batch.done;
        flushProgress.failed = batch.failed.length;

        if (inFlightFlush.size === 0 && currentBatch === batch) {
          currentBatch = null;
          showFlushBatchResult(batch);
        }
      });
  }
}

/**
 * F17：页面加载时把「从 sessionStorage 恢复出来、但没有在途请求」的 flushPlan 复位。
 *
 * 必须在 MyData 页面挂载时调用；同一 SPA 内离开再回来时，`inFlightFlush` 里仍有真实任务，
 * 不会被误清。
 */
export function reconcileFlushPlan(): boolean {
  const runtimeStore = useRuntimeStore();
  let changed = false;

  for (const site of Object.keys(runtimeStore.userInfo.flushPlan)) {
    if (runtimeStore.userInfo.flushPlan[site] && !inFlightFlush.has(site as TSiteID)) {
      runtimeStore.userInfo.flushPlan[site] = false;
      changed = true;
    }
  }

  return changed;
}

export async function cancelFlushSiteLastUserInfo() {
  const runtimeStore = useRuntimeStore();
  const { done, total } = flushProgress;

  // 作废旧批次：之后到达的请求结果只会被忽略，不会再给出「失败」提示
  flushToken += 1;
  currentBatch = null;
  inFlightFlush.clear();
  for (const runtimeStoreKey in runtimeStore.userInfo.flushPlan) {
    runtimeStore.userInfo.flushPlan[runtimeStoreKey] = false;
  }

  flushProgress.total = 0;
  flushProgress.done = 0;
  flushProgress.failed = 0;

  await sendMessage("cancelUserInfoQueue", undefined);

  runtimeStore.showSnackbar(i18n.t("MyData.index.flushQueueCancelled", { done, total }), { color: "info" });
}

export async function loadSiteHistoryData(siteId: TSiteID): Promise<Array<IUserInfo & { date: string }>> {
  const retData: Array<IUserInfo & { date: string }> = [];

  const siteUserInfoData = (await sendMessage("getSiteUserInfo", siteId)) as Record<string, IUserInfo>;

  for (const [date, item] of Object.entries(siteUserInfoData)) {
    retData.push({ ...fixUserInfo(item), date });
  }

  return retData;
}
