<script setup lang="ts">
import { ArrowLeftOutlined, ExportOutlined, HistoryOutlined, SaveOutlined } from "@ant-design/icons-vue";
import { saveAs } from "file-saver";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { useElementSize } from "@vueuse/core";
import { computed, onMounted, ref, shallowRef, provide, useTemplateRef, type ComputedRef } from "vue";
import dayjs from "dayjs";
import { eachDayOfInterval } from "date-fns";
import { flatten, mapValues, pick, uniq } from "es-toolkit";
import VChart, { THEME_KEY } from "vue-echarts";
import { use as useEcharts, type ComposeOption } from "echarts/core";
import { BarChart, LineChart, type LineSeriesOption, type BarSeriesOption } from "echarts/charts";
import { CanvasRenderer } from "echarts/renderers";
import {
  TitleComponent,
  type TitleComponentOption,
  TooltipComponent,
  type TooltipComponentOption,
  LegendComponent,
  type LegendComponentOption,
  GridComponent,
  type GridComponentOption,
} from "echarts/components";

import { NO_IMAGE } from "@ptd/site";

import { formatSize, formatDate } from "@/options/utils.ts";
import { IStoredUserInfo } from "@/shared/types.ts";

import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import SiteName from "@/options/components/SiteName.vue";
import NavButton from "@/options/components/NavButton.vue";
import CheckSwitchButton from "@/options/components/CheckSwitchButton.vue";
import PageSkeleton from "@/options/components/PageSkeleton.vue";
import NoDataPlaceholder from "@/options/components/NoDataPlaceholder.vue";

import { type IUserDataStatistic, loadFullData, setSubDate, sumUserInfoFieldByDate, toNumber } from "./utils.ts";
import { allAddedSiteMetadata, loadAllAddedSiteMetadata } from "../utils/siteMetadata.ts";

type EChartsLineChartOption = ComposeOption<
  TitleComponentOption | TooltipComponentOption | LegendComponentOption | GridComponentOption | LineSeriesOption
>;

type EChartsBarChartOption = ComposeOption<
  TitleComponentOption | TooltipComponentOption | LegendComponentOption | GridComponentOption | BarSeriesOption
>;

useEcharts([TitleComponent, TooltipComponent, LegendComponent, GridComponent, LineChart, BarChart, CanvasRenderer]);

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();
const chartContainerRef = useTemplateRef<HTMLDivElement>("chartContainer");
const { width: containerWidth } = useElementSize(chartContainerRef);
const perChartHeight = computed(() => 400);

const rawDataRef = shallowRef<IUserDataStatistic>({ siteDateRange: {}, dailyUserInfo: {}, incrementalData: {} });

/** 首次加载用户信息历史数据期间为 true（图表区显示骨架屏） */
const isLoading = ref<boolean>(true);

const allDateRanges = computed(() => Object.keys(rawDataRef.value.dailyUserInfo));
const allSites = computed<string[]>(() => Object.keys(rawDataRef.value.siteDateRange));

const selectedDateRanges = shallowRef<string[]>([]);
const selectedDateRangeRawData = computed<IUserDataStatistic["dailyUserInfo"]>(() =>
  pick(rawDataRef.value.dailyUserInfo, selectedDateRanges.value),
);

const availableSites = computed(() =>
  uniq(flatten(Object.values(mapValues(selectedDateRangeRawData.value, (x) => Object.keys(x))))),
);

const selectedSites = ref<string[]>([]);
const selectedDataComputed = computed<IUserDataStatistic["dailyUserInfo"]>(() =>
  mapValues(selectedDateRangeRawData.value, (x) => pick(x, selectedSites.value)),
);

function getTotalDataByField(field: keyof IStoredUserInfo) {
  // V-12：与逐站序列共用 toNumber（见 utils.ts），避免数字字符串被合计丢弃、NaN 污染整个日桶
  return sumUserInfoFieldByDate(selectedDataComputed.value, selectedDateRanges.value, selectedSites.value, field);
}

const formatDict = {
  int: (value: number) => value.toFixed(0),
  number: (value: number) => value.toFixed(2),
  size: (value: number) => formatSize(value),
} as const;

function createTotalInfoTooltipFormatter(type: (keyof typeof formatDict)[]) {
  return function (params: any) {
    let result = "<div>" + params[0].name + "</div>";
    params.forEach(function (param: any) {
      const formatFunction = formatDict[type[param.seriesIndex] ?? "number"];

      result +=
        `<div style='color: ${param.color}'>` +
        param.marker +
        param.seriesName +
        ": " +
        formatFunction(param.value) +
        "</div>";
    });
    return result;
  };
}

const totalSiteBaseInfoChartOptions = computed(() => {
  const uploaded = getTotalDataByField("uploaded");
  const downloaded = getTotalDataByField("downloaded");
  const bonus = getTotalDataByField("bonus");
  const seedingBonus = getTotalDataByField("seedingBonus");

  return {
    title: {
      text: `[${configStore.userName}] ${t("UserDataStatistic.chart.totalSiteBase")}`,
      subtext: `${t("UserDataStatistic.chart.uploadLabel")}: ${formatSize(uploaded.at(-1)!)}, ${t("UserDataStatistic.chart.downloadLabel")}: ${formatSize(downloaded.at(-1)!)}, ${t("levelRequirement.bonus")}: ${(bonus.at(-1) ?? 0).toFixed(2)}, ${t("levelRequirement.seedingBonus")}: ${(seedingBonus.at(-1) ?? 0).toFixed(2)}`,
      left: "center", // 设置标题居中
    },
    tooltip: {
      trigger: "axis",
      formatter: createTotalInfoTooltipFormatter(["size", "size", "number", "number"]),
    },
    legend: {
      data: [
        t("UserDataStatistic.chart.uploadLabel"),
        t("UserDataStatistic.chart.downloadLabel"),
        t("levelRequirement.bonus"),
        t("levelRequirement.seedingBonus"),
      ],
      bottom: 10,
      orient: "horizontal",
    },
    grid: { left: "3%", right: "4%", bottom: "10%", containLabel: true },
    xAxis: { type: "category", boundaryGap: false, data: selectedDateRanges.value }, // 时间轴
    yAxis: [
      {
        type: "value",
        name: t("UserDataStatistic.chart.dataLabel"),
        position: "left",
        axisLabel: { formatter: formatSize },
      },
      {
        type: "value",
        name: t("levelRequirement.bonus"),
        position: "right",
        axisLabel: { formatter: (value) => value.toFixed(0) },
      },
    ],
    series: [
      { name: t("UserDataStatistic.chart.uploadLabel"), type: "line", smooth: true, data: uploaded, yAxisIndex: 0 },
      { name: t("UserDataStatistic.chart.downloadLabel"), type: "line", smooth: true, data: downloaded, yAxisIndex: 0 },
      { name: t("levelRequirement.bonus"), type: "line", smooth: true, data: bonus, yAxisIndex: 1 },
      { name: t("levelRequirement.seedingBonus"), type: "line", smooth: true, data: seedingBonus, yAxisIndex: 1 },
    ],
  } as EChartsLineChartOption;
});

const totalSiteSeedingInfoChartOptions = computed(() => {
  const seeding = getTotalDataByField("seeding");
  const seedingSize = getTotalDataByField("seedingSize");

  return {
    title: {
      text: `[${configStore.userName}] ${t("UserDataStatistic.chart.totalSiteSeeding")}`,
      subtext: `${t("UserDataStatistic.chart.seedingSizeLabel")}: ${formatSize(seedingSize.at(-1)!)}, ${t("common.count")}: ${(seeding.at(-1) ?? 0).toFixed(2)}`,
      left: "center", // 设置标题居中
    },
    tooltip: {
      trigger: "axis",
      formatter: createTotalInfoTooltipFormatter(["size", "int"]),
    },
    legend: {
      data: [t("UserDataStatistic.chart.seedingSizeLabel"), t("UserDataStatistic.chart.seedingLabel")],
      bottom: 10,
      orient: "horizontal",
    },
    grid: { left: "3%", right: "4%", bottom: "10%", outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    xAxis: { type: "category", boundaryGap: false, data: selectedDateRanges.value }, // 时间轴
    yAxis: [
      {
        type: "value",
        name: t("UserDataStatistic.chart.seedingSizeLabel"),
        position: "left",
        axisLabel: { formatter: formatSize },
      },
      {
        type: "value",
        name: t("UserDataStatistic.chart.seedingLabel"),
        position: "right",
        axisLabel: { formatter: (value) => value.toFixed(0) },
      },
    ],
    series: [
      {
        name: t("UserDataStatistic.chart.seedingSizeLabel"),
        type: "line",
        smooth: true,
        data: seedingSize,
        yAxisIndex: 0,
      },
      { name: t("UserDataStatistic.chart.seedingLabel"), type: "line", smooth: true, data: seeding, yAxisIndex: 1 },
    ],
  } as EChartsLineChartOption;
});

// Echart 不支持在 tooltip 中直接获取鼠标悬停的系列索引，所以我们需要通过 mousemove 事件手动记录
const lastHoveredSeriesIndex = ref<number>(-1);

function updateLastHoveredSeriesIndex(data: any) {
  lastHoveredSeriesIndex.value = data?.seriesIndex ?? -1; // 获取鼠标悬停的系列索引
}

const createPerSiteChartOptionsFn = (
  field: keyof IStoredUserInfo,
  format: keyof typeof formatDict,
  incr: boolean = false,
) =>
  computed(() => {
    const series = selectedSites.value.map((site) => {
      let data;
      if (incr) {
        // 使用预计算的增量数据，大幅提升性能
        data = selectedDateRanges.value.map((date) => {
          // V-12：与合计共用同一个 toNumber（数字字符串计入、NaN 归零）
          return toNumber(rawDataRef.value.incrementalData[site]?.[date]?.[field]);
        });
      } else {
        data = selectedDateRanges.value.map((date) => {
          // V-12：与合计共用同一个 toNumber（数字字符串计入、NaN 归零）
          return toNumber(selectedDataComputed.value[date]?.[site]?.[field]);
        });
      }

      return {
        name: site,
        type: "bar",
        emphasis: {
          focus: "series",
        },
        stack: "site",
        data,
      };
    });

    const seriesTotal = series.map((x) => ({ name: x.name, value: x.data.reduce((a, b) => a + b, 0) }));

    return {
      title: {
        text: `[${configStore.userName}] ${t("UserDataStatistic.chart.perSiteK" + field + (incr ? "Incr" : ""))}`,
        left: "center",
      },
      tooltip: {
        trigger: "axis",
        axisPointer: {
          type: "shadow",
        },
        formatter: (params: any[]) => {
          let ret = "";
          const date = params?.[0]?.name ?? "No Date"; // 从params 中拿到日期
          ret += `<span style="font-weight: 600">${date}</span><br>`;

          const hasData = params.some((x) => Number(x.data));
          const totalCount = params.reduce((acc, cur) => acc + (Number(cur.data) || 0), 0); // 算出总和
          let thresholdSite = 0; // 低于阈值的站点数量

          if (hasData) {
            ret += '<table style="width: 100%;">';
            ret += `<tr style="border-bottom: 1pt solid black;; font-weight: 600"><td style="padding-right: 12px">${t("UserDataStatistic.chart.totalLabel")}</td><td style="text-align: right; padding-right: 12px">${formatDict[format](totalCount)}</td><td style="text-align: right">100%</td></tr>`;

            const sortedParams = params.sort((a, b) => b.data - a.data);

            for (const data of sortedParams) {
              const dataValue = Number(data.data) || 0;

              if (dataValue === 0) continue; // 跳过无数据的站点
              const site = data.seriesName;
              const siteName = allAddedSiteMetadata[site]?.siteName ?? site;
              const siteFavicon = allAddedSiteMetadata[site]?.faviconSrc ?? NO_IMAGE;
              const precentValue = (dataValue / totalCount) * 100;
              const isHighlightSite = lastHoveredSeriesIndex.value === data.seriesIndex; // 是否高亮此行

              // 跳过低于阈值且没有高亮的站点
              if (
                !isHighlightSite &&
                Math.abs(precentValue) < (configStore.userStatisticControl.hidePerSitePrecentThreshold ?? 0)
              ) {
                thresholdSite++;
                continue;
              }

              ret += `<tr style='${isHighlightSite ? `color: ${data.color};` : ""}'>
<td style="padding-right: 12px"><div style="display: inline-flex; align-items: center"><img src="${siteFavicon}" style="width:16px; height: 16px; ; margin-right: 4px" alt="${siteName}">${siteName}</div></td>
<td style="text-align: right; padding-right: 12px">${formatDict[format](data.value)}</td>
<td style="text-align: right">${precentValue.toFixed(2)}%</td>
</tr>`;
            }

            if (thresholdSite > 0) {
              ret += `<tr><td colspan="3" style="text-align: right">${t("UserDataStatistic.chart.hiddenSites", { count: thresholdSite })}</td></tr>`;
            }

            ret += "</table>";
          } else {
            ret += `${t("UserDataStatistic.chart.noData")}`;
          }

          return ret;
        },
      },
      legend: {
        data: seriesTotal.sort((a, b) => b.value - a.value).map((x) => x.name),
        bottom: 10,
        orient: "horizontal",
        type: "scroll",
        // V-13：元数据只为「有历史记录」的站点加载（见 onMounted 的 loadAllAddedSiteMetadata 参数），
        // 而 selectedSites 可以含任意 id（路由 query / 持久化配置）——这里必须用可选链，否则抛 TypeError 导致图表空白
        formatter: (site) => allAddedSiteMetadata[site]?.siteName ?? site,
      },
      grid: { left: "3%", right: "4%", bottom: "10%", outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
      xAxis: { type: "category", boundaryGap: true, data: selectedDateRanges.value }, // 所有柱状图都使用 boundaryGap: true
      yAxis: [
        { type: "value", name: t("UserDataStatistic.chart.dataLabel"), axisLabel: { formatter: formatDict[format] } },
      ],
      series,
    } as EChartsBarChartOption;
  });

const perSiteChartField: [keyof IStoredUserInfo, keyof typeof formatDict][] = [
  ["uploaded", "size"],
  ["downloaded", "size"],
  ["seeding", "int"],
  ["seedingSize", "size"],
  ["bonus", "number"],
  ["seedingBonus", "number"],
] as const;

// P1-19：这里一次性构造稳定的 computed 映射，模板只读取。
// 之前在模板里调用 createPerSiteChartOptionsFn(...).value 会在每次渲染时新建 computed
// （最多 12 个），旧 computed 会永久留在依赖集合里，且每次都产生全新的 echarts option 触发重绘。
const perSiteChartOptionsMap = new Map<string, ComputedRef<EChartsBarChartOption>>();
for (const [field, format] of perSiteChartField) {
  const fieldKey = String(field);
  perSiteChartOptionsMap.set(fieldKey, createPerSiteChartOptionsFn(field, format, false));
  perSiteChartOptionsMap.set(`${fieldKey}Incr`, createPerSiteChartOptionsFn(field, format, true));
}

function perSiteChartOption(key: string): EChartsBarChartOption | undefined {
  return perSiteChartOptionsMap.get(key)?.value;
}

// echarts 主题
const echartsTheme = computed(() => (configStore.uiTheme === "dark" ? "dark" : null));
provide(THEME_KEY, echartsTheme);

onMounted(async () => {
  try {
    // metadata store 从 chrome.storage 的恢复是异步的，而 loadFullData 会按 getAddedSiteIds 过滤用户信息：
    // 若在水合完成前就读取，过滤结果为空，页面会错误地显示「无数据」。这里先等水合完成。
    await metadataStore.$onReady();

    rawDataRef.value = await loadFullData();

    // 加载所有站点的元数据
    await loadAllAddedSiteMetadata(Object.keys(rawDataRef.value.siteDateRange));

    // 从路由中加载默认参数
    const { days = -1, sites = [] } = route.query ?? {};

    // query 里的值都是字符串：单站点时 sites 会退化成字符串、days 也是字符串，这里统一归一化
    const routeDays = typeof days === "string" ? Number(days) : (days as number);
    const dateRange =
      typeof routeDays === "number" && Number.isFinite(routeDays) && routeDays > 0
        ? routeDays
        : configStore.userStatisticControl.dateRange;

    // noinspection SuspiciousTypeOfGuard
    if (typeof dateRange === "number") {
      selectedDateRanges.value = setSubDate(dateRange);
    } else {
      // 我们不保存上一次自定义时间段的范围，所以如果上一次是自定义时间段，则默认显示所有数据
      if (dateRange === "custom") {
        configStore.userStatisticControl.dateRange = "all";
      }

      selectedDateRanges.value = allDateRanges.value;
    }

    const routeSites = Array.isArray(sites) ? (sites as string[]) : typeof sites === "string" && sites ? [sites] : [];

    // 勾选站点，优先使用 route 参数，其次是上次保存的配置，最后是全部站点
    if (routeSites.length > 0) {
      selectedSites.value = routeSites;
    } else if ((configStore.userStatisticControl.selectedSites ?? []).length > 0) {
      selectedSites.value = configStore.userStatisticControl.selectedSites;
    } else {
      selectedSites.value = allSites.value;
    }

    if (configStore.userName === "") {
      configStore.userName = configStore.getUserNames.perfName;
    }
  } finally {
    isLoading.value = false;
  }
});

async function exportStatisticImg() {
  const createdAt = formatDate(new Date());
  const mainCanvas = document.createElement("canvas");
  const chartsCanvas = document.querySelectorAll("#chartContainer canvas");

  mainCanvas.width = containerWidth.value;
  mainCanvas.height = (perChartHeight.value + 10) * chartsCanvas.length + 10;

  const ctx = mainCanvas.getContext("2d") as CanvasRenderingContext2D;

  // 填充白色背景
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, mainCanvas.width, mainCanvas.height);

  // 将 echart 图表渲染到 canvas 上
  let yIndex = 0;
  for (const chartCanvas of chartsCanvas) {
    ctx.drawImage(chartCanvas as HTMLCanvasElement, 0, yIndex, chartCanvas.clientWidth, chartCanvas.clientHeight);
    yIndex += perChartHeight.value + 10;
  }

  // 在 canvas 上添加右对齐文字
  ctx.font = "12px Arial";
  ctx.fillStyle = "#b5b5b5";
  ctx.textAlign = "right"; // 设置文字右对齐

  const textX = containerWidth.value - 10; // 距离右侧边缘 10px
  const textY = yIndex;
  ctx.fillText("Created By chenbinPT (" + __EXT_VERSION__ + ") at " + createdAt, textX, textY);

  // 导出图片
  mainCanvas.toBlob((blob) => {
    saveAs(
      blob!,
      t("UserDataStatistic.chart.exportFilename", { name: configStore.userName, date: createdAt }) + ".png",
    );
  });
}

function saveControl() {
  configStore.userStatisticControl.selectedSites = selectedSites.value;
  configStore.$save();
  useRuntimeStore().showSnakebar(t("common.saveSuccess"), { color: "success" });
}
</script>

<template>
  <a-card>
    <a-row :gutter="8" style="justify-content: flex-start; padding: 8px">
      <a-col ref="chartContainer" id="chartContainer" style="max-width: 800px" flex="1 1 0">
        <!-- 数据加载中：先撑起与图表同高的骨架，避免内容区空白 / 高度跳动 -->
        <PageSkeleton v-if="isLoading" variant="chart" />

        <!-- 没有任何站点用户数据（未添加站点或未刷新过用户信息） -->
        <NoDataPlaceholder v-else-if="allSites.length === 0" :description="t('UserDataStatistic.chart.noData')" />

        <template v-else>
          <!-- 总上传、总下载、总积分 -->
          <v-chart
            v-if="configStore.userStatisticControl.showChart.totalSiteBase"
            :option="totalSiteBaseInfoChartOptions"
            :style="{ height: `${perChartHeight}px` }"
            autoresize
            class="chart"
            group="totalSiteBase"
          />
          <!-- 总保种体积、总保种数量 -->
          <v-chart
            v-if="configStore.userStatisticControl.showChart.totalSiteSeeding"
            :option="totalSiteSeedingInfoChartOptions"
            :style="{ height: `${perChartHeight}px` }"
            autoresize
            class="chart"
            group="totalSiteSeeding"
          />
          <!-- 分站点上传、下载、做种、做种量、积分、时魔值数据 -->
          <template v-for="[field] in perSiteChartField" :key="field">
            <v-chart
              v-if="
                // @ts-expect-error 原因：模板字符串拼出的键（perSiteK…）在类型上是 string，showChart 没有字符串索引签名
                configStore.userStatisticControl.showChart[`perSiteK${field}`]
              "
              :group="`perSiteK${field}`"
              :option="perSiteChartOption(String(field))"
              :style="{ height: `${perChartHeight}px` }"
              autoresize
              class="chart"
              @mousemove="updateLastHoveredSeriesIndex"
            />
            <v-chart
              v-if="
                // @ts-expect-error 原因：模板字符串拼出的键（perSiteK…）在类型上是 string，showChart 没有字符串索引签名
                configStore.userStatisticControl.showChart[`perSiteK${field}Incr`]
              "
              :group="`perSiteK${field}Incr`"
              :option="perSiteChartOption(`${field}Incr`)"
              :style="{ height: `${perChartHeight}px` }"
              autoresize
              class="chart"
              @mousemove="updateLastHoveredSeriesIndex"
            />
          </template>
        </template>
      </a-col>
      <a-col flex="1 1 0">
        <a-row :gutter="8" style="flex-wrap: nowrap; margin-bottom: 4px">
          <a-col flex="1 1 0" style="display: flex">
            <NavButton color="grey" :icon="ArrowLeftOutlined" :text="t('common.back')" @click="() => router.back()" />
            <div style="flex: 1 1 auto"></div>
            <NavButton
              color="info"
              :icon="ExportOutlined"
              :text="t('common.exportImage')"
              @click="exportStatisticImg"
            />
            <NavButton color="green" :icon="SaveOutlined" :text="t('common.saveSettings')" @click="saveControl" />
          </a-col>
        </a-row>

        <div class="ptd-section-heading" style="margin-top: 0">
          {{ t("UserDataStatistic.chart.chartStyleSettings") }}
        </div>

        <a-row :gutter="8">
          <a-col flex="1 1 0" style="align-self: center">
            <a-typography-text>{{ t("common.username") }}</a-typography-text>
          </a-col>
          <a-col :span="24" :sm="20">
            <a-flex align="center" :gap="4">
              <a-auto-complete
                v-model:value="configStore.userName"
                :options="Object.keys(configStore.getUserNames.names).map((name) => ({ value: name, label: name }))"
                :placeholder="t('common.username')"
                style="flex: 1 1 0"
              />
              <HistoryOutlined
                style="cursor: pointer"
                @click="() => (configStore.userName = configStore.getUserNames.perfName)"
              />
            </a-flex>
          </a-col>
        </a-row>

        <a-row :gutter="8">
          <a-col flex="1 1 0" style="align-self: center">
            <a-typography-text>{{ t("UserDataStatistic.chart.displayChart") }}</a-typography-text>
          </a-col>
          <a-col :span="24" :sm="20">
            <a-row :gutter="0">
              <a-col
                v-for="(item, index) in configStore.userStatisticControl.showChart"
                :key="index"
                :span="12"
                style="padding: 0"
              >
                <a-checkbox v-model:checked="configStore.userStatisticControl.showChart[index]">{{
                  t("UserDataStatistic.chart." + index)
                }}</a-checkbox>
              </a-col>
            </a-row>
          </a-col>
        </a-row>

        <a-row :gutter="8">
          <a-col flex="1 1 0" style="align-self: center">
            <a-typography-text>{{ t("UserDataStatistic.chart.dateRange") }}</a-typography-text>
          </a-col>
          <a-col :span="24" :sm="20">
            <a-flex :gap="4" style="overflow-x: auto">
              <a-button
                v-for="day in [7, 30, 60, 90, 180]"
                :key="day"
                @click="
                  () => {
                    selectedDateRanges = setSubDate(day);
                    configStore.userStatisticControl.dateRange = day;
                  }
                "
              >
                {{ t("UserDataStatistic.dateRange.day", [day]) }}
              </a-button>
              <a-button>
                {{ t("UserDataStatistic.dateRange.custom") }}
                <a-popover placement="bottom" trigger="click">
                  <template #content>
                    <a-range-picker
                      :value="[dayjs(selectedDateRanges[0]), dayjs(selectedDateRanges.at(-1))]"
                      :disabled-date="
                        (date: any) =>
                          date.isBefore(dayjs(allDateRanges.at(0)), 'day') ||
                          date.isAfter(dayjs(allDateRanges.at(-1)), 'day')
                      "
                      @change="
                        (values: any) => {
                          // 清空日期时 antd 会传 null，不判空会抛 TypeError
                          if (!values) return;
                          const [start, end] = values.map((v: any) => v.toDate());
                          selectedDateRanges = eachDayOfInterval({ start, end }).map((x) =>
                            formatDate(x, 'yyyy-MM-dd'),
                          ) as string[];
                          configStore.userStatisticControl.dateRange = 'custom';
                        }
                      "
                    />
                  </template>
                </a-popover>
              </a-button>
              <a-button
                @click="
                  () => {
                    selectedDateRanges = allDateRanges;
                    configStore.userStatisticControl.dateRange = 'all';
                  }
                "
              >
                {{ t("UserDataStatistic.dateRange.all") }}
              </a-button>
            </a-flex>
          </a-col>
        </a-row>

        <a-row :gutter="8">
          <a-col flex="1 1 0" style="align-self: center">
            <a-typography-text>{{ t("UserDataStatistic.chart.chartSettings") }}</a-typography-text>
          </a-col>
          <a-col :span="24" :sm="20">
            <a-form-item :label="t('UserDataStatistic.chart.hideLowPercentLabel')"
              ><a-input-number
                v-model:value="configStore.userStatisticControl.hidePerSitePrecentThreshold"
                :max="100"
                :min="0"
                :precision="2"
                :step="1"
                controlVariant="default"
                suffix="%"
              ></a-input-number
            ></a-form-item>
          </a-col>
        </a-row>

        <div class="ptd-section-heading user-statistic-site-settings-heading" style="margin-top: 16px">
          <span>{{ t("UserDataStatistic.chart.displaySiteSettings") }}</span>
          <span class="user-statistic-site-settings-toggle">
            <CheckSwitchButton v-model="selectedSites" :all="allSites" color="grey" />
          </span>
        </div>

        <a-row :gutter="0" style="margin: 8px 0">
          <a-col v-for="siteId in allSites" :key="siteId" :span="12" :sm="6" style="padding: 0">
            <a-checkbox
              :checked="selectedSites.includes(siteId)"
              :disabled="!availableSites.includes(siteId)"
              :indeterminate="!availableSites.includes(siteId)"
              @update:checked="
                (checked: boolean) => {
                  selectedSites = checked
                    ? Array.from(new Set([...selectedSites, siteId]))
                    : selectedSites.filter((x) => x !== siteId);
                }
              "
            >
              <span class="user-statistic-site-option">
                <SiteFavicon :site-id="siteId" :size="16" />
                <SiteName :site-id="siteId" tag="span" />
              </span>
            </a-checkbox>
          </a-col>
        </a-row>
      </a-col>
    </a-row>
  </a-card>
</template>

<style scoped>
.user-statistic-site-settings-heading {
  display: flex;
  align-items: center;
  gap: 8px;
}

.user-statistic-site-settings-toggle {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  margin-left: auto;
}

.user-statistic-site-option {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  vertical-align: middle;
}
</style>
