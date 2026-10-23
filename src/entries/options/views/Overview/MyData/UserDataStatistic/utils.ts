import { subDays, format as formatDate, eachDayOfInterval } from "date-fns";
import { EResultParseStatus, TSiteID } from "@ptd/site";

import { sendMessage } from "@/messages.ts";
import { type IStoredUserInfo, TUserInfoStorageSchema } from "@/shared/types.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";

export interface IUserDataStatistic {
  siteDateRange: Record<TSiteID, [string, string]>;
  dailyUserInfo: Record<string, Record<TSiteID, IStoredUserInfo>>;
  // 新增：预计算的增量数据，提高渲染性能
  incrementalData: Record<TSiteID, Record<string, Record<keyof IStoredUserInfo, number>>>;
}

// 数值字段列表
const numericFields: (keyof IStoredUserInfo)[] = [
  "uploaded",
  "downloaded",
  "seeding",
  "seedingSize",
  "bonus",
  "seedingBonus",
];

// 新增：计算单日增量数据的函数
function calculateDailyIncremental(
  prevDateData: IStoredUserInfo | null,
  dateData: IStoredUserInfo,
  isFirstDataPoint: boolean,
): { incremental: Record<keyof IStoredUserInfo, number>; updatedPrevData: IStoredUserInfo } {
  const incremental: Record<keyof IStoredUserInfo, number> = {} as Record<keyof IStoredUserInfo, number>;

  // M-23：存储值可能是数字字符串（A-15 的 `0 + ""`、issue #48、旧版本历史）。累计图已用 toNumber 兼容，
  // 增量这里只认 typeof number 的话 6 张「增量」图恒为 0，与同一份数据画出的累计图自相矛盾。
  const asNumber = (value: unknown): number | undefined => {
    if (typeof value === "number") return Number.isNaN(value) ? undefined : value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  };

  for (const field of numericFields) {
    const currentValue = asNumber(dateData[field]);
    if (typeof currentValue === "undefined") continue;

    const prevValue = prevDateData ? asNumber(prevDateData[field]) : undefined;
    // 站点第一次有数据、前一个数据不存在或字段无效时，增量为 0；否则为「当前值 - 前一个有效值」
    incremental[field] = isFirstDataPoint || typeof prevValue === "undefined" ? 0 : currentValue - prevValue;
  }

  return { incremental, updatedPrevData: dateData };
}

export async function loadFullData(): Promise<IUserDataStatistic> {
  // getExtStorage 对不存在的 key 返回 undefined（`extStorage.getItem`），全新安装 / 清空数据后即为该状态。
  const rawData = ((await sendMessage("getExtStorage", "userInfo")) as TUserInfoStorageSchema) ?? {};
  const metadataStore = useMetadataStore();
  const addedSiteIds = metadataStore.getAddedSiteIds;

  // 提前过滤已删除的站点数据，避免后续不必要的计算
  const filteredRawData: TUserInfoStorageSchema = Object.fromEntries(
    Object.entries(rawData).filter(([siteId]) => addedSiteIds.includes(siteId as TSiteID)),
  );

  // 提取所有日期并去重（只处理有效站点的数据）
  const allDatesSet = new Set<string>();
  for (const perSiteUserInfoHistory of Object.values(filteredRawData)) {
    for (const dateStr in perSiteUserInfoHistory) {
      allDatesSet.add(dateStr);
    }
  }
  const allDates = Array.from(allDatesSet);

  // 如果没有有效的站点数据，返回空结果
  if (allDates.length === 0) {
    console.debug("[PTD] No valid site data found after filtering");
    return {
      dailyUserInfo: {},
      siteDateRange: {},
      incrementalData: {},
    };
  }

  // 找出最小和最大日期，并生成最小到最大日期之间的所有日期
  const sortedDates = allDates.sort();
  const minDateStr = sortedDates[0];
  const maxDateStr = sortedDates[sortedDates.length - 1];
  const datesInRange = eachDayOfInterval({
    start: new Date(minDateStr + "T00:00:00"),
    end: new Date(maxDateStr + "T00:00:00"),
  }).map((x) => formatDate(x, "yyyy-MM-dd"));

  const siteDateRange: IUserDataStatistic["siteDateRange"] = {};
  const dailyUserInfo: IUserDataStatistic["dailyUserInfo"] = Object.fromEntries(datesInRange.map((x) => [x, {}]));
  const incrementalData: IUserDataStatistic["incrementalData"] = {};

  console.debug(
    `[PTD] Filtered out ${Object.keys(rawData).length - Object.keys(filteredRawData).length} deleted sites`,
  );
  console.debug("[PTD] Found UserDataStatistic used date ranges:", datesInRange);

  // 遍历过滤后的站点数据
  for (const [siteId, perSiteUserInfoHistory] of Object.entries(filteredRawData)) {
    const thisSiteDateRange = Object.keys(perSiteUserInfoHistory);
    const sortedSiteDates = thisSiteDateRange.sort();
    const thisSiteMinDateStr = sortedSiteDates[0];
    const thisSiteMaxDateStr = sortedSiteDates[sortedSiteDates.length - 1];
    const thisSiteDateRangeInInterval = eachDayOfInterval({
      start: new Date(thisSiteMinDateStr + "T00:00:00"),
      end: new Date(thisSiteMaxDateStr + "T00:00:00"),
    }).map((x) => formatDate(x, "yyyy-MM-dd"));
    siteDateRange[siteId] = [thisSiteDateRangeInInterval.at(0)!, thisSiteDateRangeInInterval.at(-1)!];

    // 初始化站点增量数据
    incrementalData[siteId] = {};

    let dateData: IStoredUserInfo | undefined;
    let prevDateData: IStoredUserInfo | null = null;
    let hasFoundFirstDataPoint = false;

    for (const dateStr of thisSiteDateRangeInInterval) {
      // 如果该日期有值，则覆盖，否则使用上一个有效日期的值
      if (perSiteUserInfoHistory[dateStr]) {
        const thisDateData = perSiteUserInfoHistory[dateStr];
        if (thisDateData.status === EResultParseStatus.success) {
          dateData = thisDateData;
        }
      }

      if (dateData) {
        dailyUserInfo[dateStr][siteId] = dateData;

        // 计算增量数据 - 判断是否是第一个有效数据点
        const isFirstDataPoint = !hasFoundFirstDataPoint;
        const { incremental, updatedPrevData } = calculateDailyIncremental(prevDateData, dateData, isFirstDataPoint);
        incrementalData[siteId][dateStr] = incremental;

        // 更新状态
        prevDateData = updatedPrevData;
        hasFoundFirstDataPoint = true;
      }
    }

    console.debug(`[PTD] UserDataStatistic for ${siteId} loaded, date range: ${thisSiteDateRangeInInterval}`);
  }

  console.debug("[PTD] Incremental data calculated during data loading");

  return { dailyUserInfo, siteDateRange, incrementalData };
}

export function setSubDate(days: number) {
  const today = new Date();
  const subDay = subDays(today, days - 1);
  return eachDayOfInterval({ start: subDay, end: today }).map((x) => formatDate(x, "yyyy-MM-dd"));
}

/**
 * V-12：合计（总计折线）与逐站序列（条形图）必须共用同一个数值归一化函数。
 *
 * 旧实现里两者不一致：合计用 `.filter(isNumber)`，而 es-toolkit/compat 的
 * `isNumber(NaN) === true`、`isNumber("123") === false` —— 于是数字字符串被合计丢弃（却在条形图里计入），
 * 而一个 `NaN` 能通过 filter 并污染整个日桶的合计。
 */
export function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

/**
 * V-12：按日期聚合「已勾选站点」某个字段的合计值，供统计页的总计折线使用。
 * 与逐站序列共用 `toNumber`，保证两者对同一份数据得出同样的数字。
 */
export function sumUserInfoFieldByDate(
  dailyUserInfo: IUserDataStatistic["dailyUserInfo"],
  dates: string[],
  selectedSites: string[],
  field: keyof IStoredUserInfo,
): number[] {
  return dates.map((date) => {
    const dayData = dailyUserInfo[date] ?? {};
    let total = 0;
    for (const site of selectedSites) {
      total += toNumber(dayData[site]?.[field]);
    }
    return total;
  });
}

/** ECharts tooltip 字符串会按 HTML 插入（默认 `renderMode: 'html'`），任何拼进去的外部字符串都必须转义 */
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * F1（统计页 tooltip XSS）：站点名来自 `metadataStore.getSiteName()`，其 `merge.name` 是用户
 * 可编辑、也可从备份恢复的任意字符串。修复前它被原样拼进 tooltip 的文本节点与属性值
 * （`alt="${siteName}"`），一个 `"` 就能闭合属性，进而注入 `<img onerror=...>` 在扩展页执行。
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char]!);
}

export interface IPerSiteTooltipOptions {
  formatValue: (value: number) => string;
  /** 站点 id → 展示名（内部自行转义） */
  siteName: (siteId: string) => string;
  /** 站点 id → favicon 地址（内部自行转义） */
  siteFavicon: (siteId: string) => string;
  translate: (key: string, params?: Record<string, unknown>) => string;
  isHighlighted: (seriesIndex: number | undefined) => boolean;
  hideThreshold: number;
}

/**
 * 统计页「分站点」柱状图的 tooltip formatter。
 *
 * 从 `UserDataStatistic/Index.vue` 抽出为纯函数：一是让 XSS 修复可以被行为化测试覆盖，
 * 二是把所有拼接进 HTML 的字符串（日期、站点名、favicon、颜色、系列名）统一走 `escapeHtml`。
 */
export function buildPerSiteTooltipFormatter(options: IPerSiteTooltipOptions) {
  return function (params: any[]): string {
    let ret = "";
    const date = params?.[0]?.name ?? "No Date";
    ret += `<span style="font-weight: 600">${escapeHtml(date)}</span><br>`;

    const hasData = params.some((x) => Number(x.data));
    const totalCount = params.reduce((acc, cur) => acc + (Number(cur.data) || 0), 0);
    let thresholdSite = 0;

    if (hasData) {
      ret += '<table style="width: 100%;">';
      ret += `<tr style="border-bottom: 1pt solid black;; font-weight: 600"><td style="padding-right: 12px">${escapeHtml(
        options.translate("UserDataStatistic.chart.totalLabel"),
      )}</td><td style="text-align: right; padding-right: 12px">${options.formatValue(
        totalCount,
      )}</td><td style="text-align: right">100%</td></tr>`;

      // 复制后再排序：不原地改写 ECharts 传进来的数组
      const sortedParams = [...params].sort((a, b) => b.data - a.data);

      for (const data of sortedParams) {
        const dataValue = Number(data.data) || 0;
        if (dataValue === 0) continue;

        const site = data.seriesName;
        const siteName = escapeHtml(options.siteName(site));
        const siteFavicon = escapeHtml(options.siteFavicon(site));
        const precentValue = (dataValue / totalCount) * 100;
        const isHighlightSite = options.isHighlighted(data.seriesIndex);

        if (!isHighlightSite && Math.abs(precentValue) < options.hideThreshold) {
          thresholdSite++;
          continue;
        }

        ret += `<tr style='${isHighlightSite ? `color: ${escapeHtml(data.color)};` : ""}'>
<td style="padding-right: 12px"><div style="display: inline-flex; align-items: center"><img src="${siteFavicon}" style="width:16px; height: 16px; ; margin-right: 4px" alt="${siteName}">${siteName}</div></td>
<td style="text-align: right; padding-right: 12px">${options.formatValue(dataValue)}</td>
<td style="text-align: right">${precentValue.toFixed(2)}%</td>
</tr>`;
      }

      if (thresholdSite > 0) {
        ret += `<tr><td colspan="3" style="text-align: right">${options.translate(
          "UserDataStatistic.chart.hiddenSites",
          { count: thresholdSite },
        )}</td></tr>`;
      }

      ret += "</table>";
    } else {
      ret += options.translate("UserDataStatistic.chart.noData");
    }

    return ret;
  };
}
